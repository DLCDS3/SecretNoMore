$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('secret-lair-auto-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'secret-lair.ps1') -Destination $testRoot
foreach ($name in @('purchase', 'automation', 'schedule')) {
    Copy-Item -LiteralPath (Join-Path $source "$name.example.json") -Destination (Join-Path $testRoot "$name.json")
}
$fixturePurchasePath = Join-Path $testRoot 'purchase.json'
$fixturePurchase = Get-Content -LiteralPath $fixturePurchasePath -Raw | ConvertFrom-Json
$fixturePurchase.accountIds = @('account01')
$fixturePurchase | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $fixturePurchasePath
Copy-Item -LiteralPath (Join-Path $source 'automation') -Destination $testRoot -Recurse
New-Item -ItemType Directory -Path (Join-Path $testRoot '.local') | Out-Null
@(@{ id = 'account01'; email = 'fixture@example.com'; enabled = $true }) | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot 'accounts.json')
# Synthetic credentials only. Confirm Unicode survives the private stdin pipe.
$fakePassword = 'synthetic-fixture-' + [char]0x03A9
@{ 'password:account01' = (ConvertTo-SecureString $fakePassword -AsPlainText -Force | ConvertFrom-SecureString) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot '.local/vault.json')
@'
import fs from 'node:fs';
import path from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
console.log('Synthetic worker: stdout visible.');
console.error('Synthetic worker: stderr visible.');
const valid = payload.accounts[0].password === 'synthetic-fixture-\u03a9';
fs.writeFileSync(path.join(payload.root, '.local', 'pipe-check.json'), JSON.stringify({
  valid, action: payload.action, scheduledAt: payload.scheduledAt, args: process.argv.slice(2), accountId: payload.accounts[0].id
}));
process.exitCode = valid ? 0 : 1;
'@ | Set-Content -LiteralPath (Join-Path $testRoot 'automation-runner.mjs')
function Test-Path {
    [CmdletBinding()]param([string]$LiteralPath)
    if ($LiteralPath -match '\\(msedge|chrome)\.exe$') { return $true }
    Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
}
try {
    & (Join-Path $testRoot 'secret-lair.ps1') -Action Launch -Auto | Out-Null
    $check = Get-Content -LiteralPath (Join-Path $testRoot '.local/pipe-check.json') -Raw | ConvertFrom-Json
    if (-not $check.valid -or $check.args.Count -ne 0 -or $check.accountId -ne 'account01' -or $check.action -ne 'Launch') { throw 'Private credential pipe check failed.' }
    $schedule = Get-Content -LiteralPath (Join-Path $testRoot 'schedule.json') -Raw | ConvertFrom-Json
    $schedule.enabled = $true
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')
    $schedule.startLocal = [TimeZoneInfo]::ConvertTime([DateTimeOffset]::UtcNow.AddMinutes(2), $zone).ToString('yyyy-MM-ddTHH:mm:ss')
    $schedule | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot 'schedule.json')
    & (Join-Path $testRoot 'secret-lair.ps1') -Action Schedule -Auto | Out-Null
    $check = Get-Content -LiteralPath (Join-Path $testRoot '.local/pipe-check.json') -Raw | ConvertFrom-Json
    if ($check.action -ne 'Schedule' -or -not $check.scheduledAt -or -not $check.valid) { throw 'Scheduled target was not forwarded to the automation runner.' }
    Write-Output 'PASS: DPAPI decryption, Unicode passwords through private stdin, empty secret command arguments, and scheduled target forwarding.'
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -match '^secret-lair-auto-test-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
