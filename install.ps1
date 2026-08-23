$ErrorActionPreference = "Stop"

$pluginName = "brave-control"
$python = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$creatorRoot = Join-Path $env:USERPROFILE ".codex\skills\.system\plugin-creator"
$scaffold = Join-Path $creatorRoot "scripts\create_basic_plugin.py"
$readMarketplace = Join-Path $creatorRoot "scripts\read_marketplace_name.py"
$pluginParent = Join-Path $env:USERPROFILE "plugins"
$destination = Join-Path $pluginParent $pluginName

# A distributable package must never contain another computer's live pairing.
foreach ($relativePath in @("config.json", "extension\pairing.json")) {
  $candidate = Join-Path $PSScriptRoot $relativePath
  if (Test-Path -LiteralPath $candidate) {
    throw "Refusing to install a package containing private pairing state: $relativePath"
  }
}
foreach ($relativePath in @("config.example.json", "extension\pairing.example.json")) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $relativePath))) {
    throw "The installation package is incomplete: $relativePath is missing."
  }
}

if (-not (Test-Path -LiteralPath $python)) { throw "Codex's bundled Python runtime was not found: $python" }
if (-not (Test-Path -LiteralPath $scaffold)) { throw "The Codex plugin-creator scaffold was not found: $scaffold" }
if (Test-Path -LiteralPath $destination) {
  throw "The destination already exists: $destination`nRemove or rename it only if you intend to replace that plugin."
}

& $python $scaffold $pluginName --path $pluginParent --with-mcp --with-scripts --with-assets --with-marketplace
if ($LASTEXITCODE -ne 0) { throw "Plugin scaffolding failed." }

Get-ChildItem -LiteralPath $PSScriptRoot -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
}

# Generate a unique local pairing. Neither file belongs in source control.
$tokenBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
$token = -join ($tokenBytes | ForEach-Object { $_.ToString("x2") })
$revision = [Guid]::NewGuid().ToString("N")
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
try {
  $probe.Start()
  $port = ([Net.IPEndPoint]$probe.LocalEndpoint).Port
} finally {
  $probe.Stop()
}
$utf8NoBom = New-Object Text.UTF8Encoding($false)
$bridgeConfig = [ordered]@{ host = "127.0.0.1"; port = $port; token = $token } | ConvertTo-Json
$extensionPairing = [ordered]@{ port = $port; token = $token; revision = $revision } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $destination "config.json"), $bridgeConfig + [Environment]::NewLine, $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $destination "extension\pairing.json"), $extensionPairing + [Environment]::NewLine, $utf8NoBom)

$marketplaceName = (& $python $readMarketplace).Trim()
if ($LASTEXITCODE -ne 0 -or -not $marketplaceName) { throw "Could not read the personal marketplace name." }

$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($codex) {
  & $codex.Source plugin add "$pluginName@$marketplaceName"
  if ($LASTEXITCODE -ne 0) { throw "The plugin files were installed, but Codex could not add the plugin." }
  Write-Host "Brave Control beta was installed with a unique local pairing. Restart Codex and open a new task."
} else {
  Write-Host "The Brave Control beta files were installed with a unique local pairing and registered. Restart Codex, then install $pluginName@$marketplaceName from Settings > Plugins."
}

Write-Host "In Brave, open brave://extensions, enable Developer mode, choose Load unpacked, and select:"
Write-Host (Join-Path $destination "extension")
