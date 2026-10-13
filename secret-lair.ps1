param(
    [ValidateSet('Initialize', 'Validate', 'SetPassword', 'SetPayment', 'RemovePassword', 'RemovePayment', 'Launch', 'Prepare', 'Schedule', 'ResumeCart', 'ConfirmQueue', 'ResetCartAttempt')]
    [string]$Action = 'Validate',
    [string]$Id,
    [ValidateSet('edge', 'chrome')][string]$Browser = 'edge',
    [switch]$DryRun,
    [switch]$Auto
)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'ResumeCart' -and -not $Auto) { throw 'ResumeCart requires -Auto.' }
$root = $PSScriptRoot
$local = Join-Path $root '.local'
$vaultPath = Join-Path $local 'vault.json'
if ($Action -eq 'Initialize') {
    foreach ($name in @('accounts', 'purchase', 'schedule', 'automation')) {
        $destination = Join-Path $root "$name.json"
        if (Test-Path -LiteralPath $destination) { Write-Output "Kept existing $name.json"; continue }
        $example = Join-Path $root "$name.example.json"
        if (-not (Test-Path -LiteralPath $example)) { throw "Missing $name.example.json" }
        Copy-Item -LiteralPath $example -Destination $destination -ErrorAction Stop
        Write-Output "Created $name.json from its public example."
    }
    exit
}

function Read-JsonFile([string]$Path) {
    $parsed = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    # Windows PowerShell 5.1 emits a JSON array as one pipeline object.
    # Enumerate explicitly so account lists behave the same in 5.1 and 7.
    foreach ($entry in $parsed) { $entry }
}
function Resolve-NodeRuntime {
    $installed = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installed) { return $installed.Source }
    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundled) {
        Write-Host 'Using the bundled Node.js runtime.'
        return $bundled
    }
    throw 'Node.js was not found on PATH or in the bundled runtime. Install Node.js, then reopen PowerShell.'
}
function Get-Vault {
    $map = @{}
    if (Test-Path -LiteralPath $vaultPath) {
        $stored = Read-JsonFile $vaultPath
        foreach ($property in $stored.PSObject.Properties) { $map[$property.Name] = $property.Value }
    }
    return $map
}
function Save-Vault($Vault) {
    New-Item -ItemType Directory -Path $local -Force | Out-Null
    # No key supplied: Windows DPAPI binds encryption to the current Windows user.
    $Vault | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $vaultPath -Encoding UTF8
}
function Check-Id([string]$Value) {
    if ($Value -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$') { throw 'Use a 1-64 character ID containing letters, numbers, underscores, or hyphens.' }
}
function Get-StartTime($Schedule) {
    if ($Schedule.timeZoneId -ne 'Eastern Standard Time') { throw 'Use the Windows time zone ID Eastern Standard Time (includes daylight saving time).' }
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById($Schedule.timeZoneId)
    # PowerShell 7 may deserialize ISO JSON strings into DateTime automatically.
    $localText = if ($Schedule.startLocal -is [DateTime]) { $Schedule.startLocal.ToString('yyyy-MM-ddTHH:mm:ss') } else { [string]$Schedule.startLocal }
    $date = [DateTime]::ParseExact($localText, 'yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
    $date = [DateTime]::SpecifyKind($date, [DateTimeKind]::Unspecified)
    if ($zone.IsInvalidTime($date) -or $zone.IsAmbiguousTime($date)) { throw 'Scheduled time falls in a daylight-saving gap or repeated hour. Choose an unambiguous time.' }
    if (($Schedule.maxLatenessSeconds -isnot [int] -and $Schedule.maxLatenessSeconds -isnot [long]) -or $Schedule.maxLatenessSeconds -lt 0 -or $Schedule.maxLatenessSeconds -gt 300) { throw 'maxLatenessSeconds must be an integer between 0 and 300.' }
    return [DateTimeOffset]::new($date, $zone.GetUtcOffset($date))
}

if ($Action -eq 'ConfirmQueue') {
    Check-Id $Id
    $runPath = Join-Path $local 'last-run.json'
    if (-not (Test-Path -LiteralPath $runPath)) { throw 'No launch record exists.' }
    $run = Read-JsonFile $runPath
    if ($run.action -eq 'Prepare') { throw 'Prepare records login setup only. Use Launch or Schedule before recording a queue confirmation.' }
    $entry = $run.accounts | Where-Object { $_.id -eq $Id }
    if (-not $entry) { throw "Account '$Id' is not in the last launch." }
    if ($entry.status -notin @('awaiting-manual-action', 'cart-attempted-manual', 'view-cart-attempted-manual', 'cart-login-completed-manual', 'cart-followup-needed-manual', 'cart-outcome-unknown-manual', 'manual-confirmed')) { throw "Account '$Id' has no cart or manual launch checkpoint to confirm." }
    $entry.status = 'manual-confirmed'
    $entry.confirmedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $run | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $runPath -Encoding UTF8
    Write-Output "Manual queue confirmation recorded for $Id. No browser action or checkout was triggered."
    exit
}

if ($Action -eq 'ResetCartAttempt') {
    Check-Id $Id
    $targetPurchase = Read-JsonFile (Join-Path $root 'purchase.json')
    $productId = [string]$targetPurchase.expectedProductId
    if ($productId -notmatch '^\d+$') { throw 'Invalid product ID.' }
    $marker = Join-Path $local "cart-attempts\$Id-$productId.json"
    if (Test-Path -LiteralPath (Join-Path $local 'automation.lock')) { throw 'Close the active automation run before resetting a cart attempt.' }
    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker }
    Write-Output "Cart attempt reset for $Id / $productId. Check its cart before running automation again."
    exit
}

if ($Action -in @('SetPassword', 'SetPayment', 'RemovePassword', 'RemovePayment')) {
    Check-Id $Id
    $vault = Get-Vault
    if ($Action -eq 'SetPassword') {
        $accounts = @(Read-JsonFile (Join-Path $root 'accounts.json'))
        if (-not ($accounts | Where-Object { $_.id -eq $Id })) { throw "Account '$Id' is missing from accounts.json." }
        $vault["password:$Id"] = Read-Host 'Account password' -AsSecureString | ConvertFrom-SecureString
    } elseif ($Action -eq 'SetPayment') {
        $cardholder = Read-Host 'Name on card'
        $number = Read-Host 'Card number (encrypted; input hidden)' -AsSecureString
        $expiry = Read-Host 'Expiration MM/YY'
        if ($expiry -notmatch '^(0[1-9]|1[0-2])/\d{2}$') { throw 'Expiration must be MM/YY.' }
        $billing = Read-Host 'Billing address (single line)'
        $vault["payment:$Id"] = @{
            cardholder = (ConvertTo-SecureString $cardholder -AsPlainText -Force | ConvertFrom-SecureString)
            number = ($number | ConvertFrom-SecureString)
            expiry = (ConvertTo-SecureString $expiry -AsPlainText -Force | ConvertFrom-SecureString)
            billing = (ConvertTo-SecureString $billing -AsPlainText -Force | ConvertFrom-SecureString)
        }
    } else {
        $kind = if ($Action -eq 'RemovePassword') { 'password' } else { 'payment' }
        $vault.Remove("${kind}:$Id")
    }
    Save-Vault $vault
    Write-Output 'Vault updated. CVV is never stored.'
    exit
}

$accounts = @(Read-JsonFile (Join-Path $root 'accounts.json'))
$purchase = Read-JsonFile (Join-Path $root 'purchase.json')
$seen = @{}
foreach ($account in $accounts) {
    Check-Id $account.id
    if ($seen.ContainsKey($account.id)) { throw "Duplicate account ID: $($account.id)" }
    $seen[$account.id] = $true
    if ($account.email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw "Invalid email for $($account.id)." }
}
$url = [uri]$purchase.productUrl
if ($url.Scheme -ne 'https' -or $url.Host -ne 'secretlair.wizards.com' -or $url.UserInfo -or $url.Port -ne 443) { throw 'Product URL must use https://secretlair.wizards.com.' }
if ($url.AbsolutePath -notmatch '^/us/(?:en/)?product/(\d+)/[^/]+/?$' -or $Matches[1] -ne [string]$purchase.expectedProductId) { throw 'URL product ID does not match expectedProductId.' }
if (($purchase.quantityPerAccount -isnot [int] -and $purchase.quantityPerAccount -isnot [long]) -or $purchase.quantityPerAccount -lt 1) { throw 'quantityPerAccount must be a positive integer.' }
if ($purchase.maxTotalPerAccount -isnot [valuetype] -or $purchase.maxTotalPerAccount -le 0) { throw 'maxTotalPerAccount must be positive.' }
if ($purchase.checkoutMode -ne 'review') { throw 'This version supports review mode only; checkout automation is not implemented.' }
if (@($purchase.accountIds | Select-Object -Unique).Count -ne @($purchase.accountIds).Count) { throw 'Duplicate purchase account IDs.' }
$selected = @()
foreach ($accountId in $purchase.accountIds) {
    $account = $accounts | Where-Object { $_.id -eq $accountId }
    if (-not $account) { throw "Unknown purchase account: $accountId" }
    if ($account.enabled) { $selected += $account }
}
Write-Output "Configuration valid. $($selected.Count) enabled account(s); product $($purchase.expectedProductId); $($purchase.expectedVariant)."
$schedule = Read-JsonFile (Join-Path $root 'schedule.json')
$start = Get-StartTime $schedule
Write-Output "Configured start: $($start.ToString('yyyy-MM-dd HH:mm:ss zzz')) (New York); UTC: $($start.UtcDateTime.ToString('yyyy-MM-dd HH:mm:ss'))."
if ($Auto) {
    $node = Resolve-NodeRuntime
    $automationPath = Join-Path $root 'automation.json'
    & $node (Join-Path $root 'automation\check.mjs') (Join-Path $root 'purchase.json') $automationPath
    if ($LASTEXITCODE -ne 0) { throw 'Automation configuration validation failed.' }
}
if ($Action -eq 'Validate') { exit }
if ($DryRun) {
    Write-Output "Dry run: $Action would use $Browser for $($selected.Count) account(s). No browser, vault, or run record was changed; no schedule was armed."
    exit
}
if (-not $selected.Count) { throw 'Enable at least one selected account in accounts.json.' }
$candidates = if ($Browser -eq 'edge') {
    @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe")
} else {
    @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
}
$executable = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $executable) { throw "$Browser installation not found." }
if ($Action -eq 'Schedule') {
    if ($schedule.enabled -ne $true) { throw 'Set enabled to true in schedule.json before arming the schedule.' }
    if ($start -le [DateTimeOffset]::UtcNow) { throw 'The scheduled time has already passed. Choose a future time.' }
}
if ($Auto) {
    $vault = Get-Vault
    $automation = Read-JsonFile $automationPath
    $automation | Add-Member -NotePropertyName maxLatenessSeconds -NotePropertyValue $schedule.maxLatenessSeconds -Force
    $credentials = @()
    foreach ($account in $selected) {
        if (-not $vault.ContainsKey("password:$($account.id)")) { throw "Save a password first: .\secret-lair.ps1 -Action SetPassword -Id $($account.id)" }
        $secure = $vault["password:$($account.id)"] | ConvertTo-SecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $credentials += @{
                id = $account.id; email = $account.email; loginLabel = $account.loginLabel
                password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            }
        } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
    }
    $payloadText = @{
        root = $root; browser = $Browser; accounts = $credentials; purchase = $purchase; config = $automation
        action = $Action; scheduledAt = if ($Action -eq 'Schedule') { $start.ToString('o') } else { $null }
    } | ConvertTo-Json -Depth 15 -Compress
    # Passwords travel only through a private child-process stdin pipe, never command arguments or files.
    $processInfo = New-Object Diagnostics.ProcessStartInfo
    $processInfo.FileName = $node
    $processInfo.Arguments = '"' + (Join-Path $root 'automation-runner.mjs') + '"'
    $processInfo.WorkingDirectory = $root
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardInput = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $processInfo
    try {
        $process.Start() | Out-Null
        # .NET Framework (Windows PowerShell 5.1) has no StandardInputEncoding property.
        # Write UTF-8 bytes directly so Unicode credentials survive on both runtimes.
        $payloadBytes = [Text.Encoding]::UTF8.GetBytes($payloadText)
        try {
            $process.StandardInput.BaseStream.Write($payloadBytes, 0, $payloadBytes.Length)
            $process.StandardInput.BaseStream.Flush()
        } finally {
            [Array]::Clear($payloadBytes, 0, $payloadBytes.Length)
            $payloadBytes = $null
        }
        $process.StandardInput.Close()
        $payloadText = $null; $credentials = $null
        # Read both streams concurrently: inherited output can disappear in Windows PowerShell.
        $outputRead = $process.StandardOutput.ReadLineAsync()
        $errorRead = $process.StandardError.ReadLineAsync()
        while ($null -ne $outputRead -or $null -ne $errorRead) {
            if ($null -ne $outputRead -and $outputRead.IsCompleted) {
                $line = $outputRead.GetAwaiter().GetResult()
                if ($null -eq $line) { $outputRead = $null }
                else { Write-Host $line; $outputRead = $process.StandardOutput.ReadLineAsync() }
            }
            if ($null -ne $errorRead -and $errorRead.IsCompleted) {
                $line = $errorRead.GetAwaiter().GetResult()
                if ($null -eq $line) { $errorRead = $null }
                else { Write-Host "Worker: $line" -ForegroundColor Red; $errorRead = $process.StandardError.ReadLineAsync() }
            }
            if ($null -ne $outputRead -or $null -ne $errorRead) { Start-Sleep -Milliseconds 50 }
        }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw 'Automation run stopped. Review the status output and .local/last-run.json.' }
    } finally { $payloadText = $null; $credentials = $null; $process.Dispose() }
    exit
}
$launches = @()
foreach ($account in $selected) {
    $profile = Join-Path $local "profiles\$Browser\$($account.id)"
    New-Item -ItemType Directory -Path $profile -Force | Out-Null
    $destination = if ($Action -eq 'Prepare') { 'https://secretlair.wizards.com/us' } else { $url.AbsoluteUri }
    $launches += [pscustomobject]@{
        id = $account.id
        email = $account.email
        arguments = @("--user-data-dir=`"$profile`"", '--new-window', "`"$destination`"")
    }
}
if ($Action -eq 'Schedule') {
    Write-Output 'Schedule armed. Keep this PowerShell process running and this machine awake. Ctrl+C cancels before launch.'
    $nextReport = [DateTimeOffset]::UtcNow
    while ([DateTimeOffset]::UtcNow -lt $start) {
        $remaining = ($start - [DateTimeOffset]::UtcNow).TotalMilliseconds
        if ([DateTimeOffset]::UtcNow -ge $nextReport) {
            Write-Output "Waiting: $([math]::Ceiling($remaining / 1000)) seconds until dispatch."
            $nextReport = [DateTimeOffset]::UtcNow.AddSeconds(30)
        }
        Start-Sleep -Milliseconds ([int][math]::Max(1, [math]::Min(1000, $remaining)))
    }
    if (([DateTimeOffset]::UtcNow - $start).TotalSeconds -gt $schedule.maxLatenessSeconds) {
        throw 'Missed the start beyond maxLatenessSeconds (possibly sleep or hibernation). No browsers were launched.'
    }
}
$run = [pscustomobject]@{
    runId = [Guid]::NewGuid().ToString()
    startedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    scheduledAt = if ($Action -eq 'Schedule') { $start.ToString('o') } else { $null }
    action = $Action
    productUrl = $url.AbsoluteUri
    accounts = @($launches | ForEach-Object {
        [pscustomobject]@{ id = $_.id; status = 'pending-launch'; dispatchAtUtc = $null; confirmedAtUtc = $null }
    })
}
$runPath = Join-Path $local 'last-run.json'
$run | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $runPath -Encoding UTF8
# Dispatch without inter-account sleeps. Browser startup and network responses still differ.
foreach ($launch in $launches) {
    $entry = $run.accounts | Where-Object { $_.id -eq $launch.id }
    try {
        Start-Process -FilePath $executable -ArgumentList $launch.arguments -ErrorAction Stop
        $entry.dispatchAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        $entry.status = if ($Action -eq 'Prepare') { 'manual-login-needed' } else { 'awaiting-manual-action' }
    } catch {
        $entry.status = 'launch-failed'
        Write-Warning "Browser launch failed for $($launch.id): $($_.Exception.Message)"
    }
}
$run | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $runPath -Encoding UTF8
Write-Output 'Browser launch requests finished. Login and Add to Cart are manual in this version. Browsers remain open; the script does not refresh, detect queue completion, or resume checkout.'
Write-Output 'Once you have checked a queue window, record its checkpoint with: .\secret-lair.ps1 -Action ConfirmQueue -Id account01'
