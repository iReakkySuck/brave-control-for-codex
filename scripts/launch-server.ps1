$ErrorActionPreference = "Stop"

$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$nodeCommand = $null

if ($env:BRAVE_CONTROL_NODE -and (Test-Path -LiteralPath $env:BRAVE_CONTROL_NODE)) {
  $nodeCommand = $env:BRAVE_CONTROL_NODE
} elseif (Test-Path -LiteralPath $bundledNode) {
  $nodeCommand = $bundledNode
} else {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { $nodeCommand = $node.Source }
}

if (-not $nodeCommand) { throw "Node.js was not found. Install Node.js 20 or use a Codex runtime that includes Node." }
$server = Join-Path $PSScriptRoot "server.mjs"
& $nodeCommand $server
exit $LASTEXITCODE
