$ErrorActionPreference = "Stop"

$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$nodeCommand = $null
if (Test-Path -LiteralPath $bundledNode) {
  $nodeCommand = $bundledNode
} else {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { $nodeCommand = $node.Source }
}
if (-not $nodeCommand) { throw "Node.js was not found. Use a current Codex desktop installation or install Node.js 20 or later." }

$pluginRoot = Split-Path $PSScriptRoot -Parent
$scriptFiles = Get-ChildItem -LiteralPath $pluginRoot -Recurse -File | Where-Object { $_.Extension -in @(".js", ".mjs") }
foreach ($file in $scriptFiles) {
  & $nodeCommand --check $file.FullName
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $($file.Name)" }
}

$jsonFiles = Get-ChildItem -LiteralPath $pluginRoot -Recurse -File -Filter "*.json"
foreach ($file in $jsonFiles) {
  Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json | Out-Null
}

foreach ($test in @("release-policy-test.mjs", "cross-site-session-test.mjs", "security-test.mjs", "performance-test.mjs")) {
  & $nodeCommand (Join-Path $PSScriptRoot $test)
  if ($LASTEXITCODE -ne 0) { throw "Test failed: $test" }
}

Write-Host "PASS JavaScript syntax ($($scriptFiles.Count) files)"
Write-Host "PASS JSON syntax ($($jsonFiles.Count) files)"
Write-Host "All Brave Control beta checks passed."
