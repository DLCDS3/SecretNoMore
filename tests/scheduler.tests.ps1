$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('secret-lair-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'secret-lair.ps1') -Destination $testRoot
@{
    productUrl = 'https://secretlair.wizards.com/us/product/1252788/secret-lair-x-marvel-true-believers-in-love-foil-edition'
    expectedProductId = '1252788'; expectedVariant = 'Foil'; quantityPerAccount = 1
    maxTotalPerAccount = 75; accountIds = @('account01'); checkoutMode = 'review'
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $testRoot 'purchase.json')
$entrypoint = Join-Path $testRoot 'secret-lair.ps1'
$schedulePath = Join-Path $testRoot 'schedule.json'
@(@{ id = 'account01'; email = 'test@example.com'; enabled = $true }) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $testRoot 'accounts.json')
function Save-TestSchedule([string]$LocalTime, [bool]$Enabled = $true) {
    @{ enabled = $Enabled; startLocal = $LocalTime; timeZoneId = 'Eastern Standard Time'; maxLatenessSeconds = 30 } |
        ConvertTo-Json | Set-Content -LiteralPath $schedulePath
}
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}
function Assert-Rejected([string]$LocalTime, [string]$Expected) {
    Save-TestSchedule $LocalTime
    $rejected = $false
    try { & $entrypoint -Action Schedule -DryRun | Out-Null }
    catch { $rejected = $_.Exception.Message -like "*$Expected*" }
    Assert $rejected "Reject $LocalTime ($Expected)"
}
# Prevent browser launch while exercising the real dispatch and manifest code.
$dispatches = New-Object 'System.Collections.Generic.List[object]'
function Start-Process {
    [CmdletBinding()]param([string]$FilePath, [string[]]$ArgumentList)
    $dispatches.Add(@{ file = $FilePath; arguments = $ArgumentList; time = [DateTimeOffset]::UtcNow })
}
function Test-Path {
    [CmdletBinding()]param([string]$LiteralPath)
    if ($LiteralPath -match '\\(msedge|chrome)\.exe$') { return $true }
    Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
}
try {
    Save-TestSchedule '2026-10-05T12:00:00' $false
    $output = & $entrypoint -Action Schedule -DryRun
    Assert (($output -join '\n') -like '*2026-10-05 16:00:00*') 'October noon resolves to 16:00 UTC'
    Assert ($dispatches.Count -eq 0) 'Dry run launches nothing'
    Save-TestSchedule '2026-12-05T12:00:00'
    $output = & $entrypoint -Action Schedule -DryRun
    Assert (($output -join '\n') -like '*2026-12-05 17:00:00*') 'Winter noon resolves to 17:00 UTC'
    Assert-Rejected '2026-03-08T02:30:00' 'daylight-saving'
    Assert-Rejected '2026-11-01T01:30:00' 'daylight-saving'
    Save-TestSchedule '2026-01-01T12:00:00'
    $rejected = $false
    try { & $entrypoint -Action Schedule | Out-Null } catch { $rejected = $_.Exception.Message -like '*already passed*' }
    Assert $rejected 'Past start is rejected'
    Assert ($dispatches.Count -eq 0) 'Past start launches nothing'
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')
    $target = [TimeZoneInfo]::ConvertTime([DateTimeOffset]::UtcNow.AddSeconds(3), $zone)
    Save-TestSchedule ($target.ToString('yyyy-MM-ddTHH:mm:ss'))
    & $entrypoint -Action Schedule | Out-Null
    Assert ($dispatches.Count -eq 1) 'One browser dispatch per enabled account'
    $manifest = Get-Content -LiteralPath (Join-Path $testRoot '.local/last-run.json') -Raw | ConvertFrom-Json
    Assert ($manifest.accounts[0].status -eq 'awaiting-manual-action') 'Records manual checkpoint without pretending queue detection'
    Assert ($dispatches[0].time -ge [DateTimeOffset]::Parse($manifest.scheduledAt)) 'Dispatch does not precede target'
    & $entrypoint -Action ConfirmQueue -Id account01 | Out-Null
    $manifest = Get-Content -LiteralPath (Join-Path $testRoot '.local/last-run.json') -Raw | ConvertFrom-Json
    Assert ($manifest.accounts[0].status -eq 'manual-confirmed') 'Manual confirmation persists'
    Assert ($dispatches.Count -eq 1) 'Confirmation triggers no browser action'
    $dispatches.Clear()
    $tenAccounts = @(1..10 | ForEach-Object { @{ id = ('account{0:00}' -f $_); email = "test$_@example.com"; enabled = $true } })
    $tenAccounts | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $testRoot 'accounts.json')
    $purchasePath = Join-Path $testRoot 'purchase.json'
    $purchase = Get-Content -LiteralPath $purchasePath -Raw | ConvertFrom-Json
    $purchase.accountIds = @($tenAccounts | ForEach-Object { $_.id })
    $purchase | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $purchasePath
    & $entrypoint -Action Launch | Out-Null
    Assert ($dispatches.Count -eq 10) 'Ten enabled accounts dispatch ten windows'
    $profiles = @($dispatches | ForEach-Object { $_.arguments[0] } | Select-Object -Unique)
    Assert ($profiles.Count -eq 10) 'Each dispatch has a distinct persistent browser profile'
    Write-Output 'PASS: DST conversion, invalid times, dry run, past start, timed dispatch, manual confirmation, and ten isolated profiles.'
} finally {
    # Delete only this test-created directory, verified beneath the OS temp directory.
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -match '^secret-lair-test-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
