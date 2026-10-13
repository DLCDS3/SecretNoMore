$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('secret-lair-init-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'secret-lair.ps1') -Destination $testRoot
$names = @('accounts', 'purchase', 'schedule', 'automation')
foreach ($name in $names) {
    Copy-Item -LiteralPath (Join-Path $source "$name.example.json") -Destination $testRoot
}
try {
    $scriptFile = Join-Path $testRoot 'secret-lair.ps1'
    & $scriptFile -Action Initialize | Out-Null
    foreach ($name in $names) {
        $created = Get-Content -LiteralPath (Join-Path $testRoot "$name.json") -Raw
        $example = Get-Content -LiteralPath (Join-Path $testRoot "$name.example.json") -Raw
        if ($created -ne $example) { throw "Initialization did not copy $name correctly." }
        Set-Content -LiteralPath (Join-Path $testRoot "$name.json") -Value "preserve-$name" -NoNewline
    }
    & $scriptFile -Action Initialize | Out-Null
    foreach ($name in $names) {
        if ((Get-Content -LiteralPath (Join-Path $testRoot "$name.json") -Raw) -ne "preserve-$name") { throw "Existing $name was overwritten." }
    }
    Write-Output 'PASS: Initializes all public examples and preserves every existing local configuration file.'
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -match '^secret-lair-init-test-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
