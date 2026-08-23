param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "dist")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$releaseVersion = "0.3.5-beta.2"
$pluginRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

$zipPath = Join-Path $resolvedOutput "brave-control-$releaseVersion.zip"
$hashPath = "$zipPath.sha256"
if ((Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath $hashPath)) {
  throw "Release output already exists. Move or delete the existing release files before rebuilding: $zipPath"
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stagingRoot = Join-Path $tempBase ("brave-control-release-" + [Guid]::NewGuid().ToString("N"))
$stagingFull = [IO.Path]::GetFullPath($stagingRoot)
if (-not $stagingFull.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The staging directory did not resolve inside the operating-system temporary directory."
}

$packageRoot = Join-Path $stagingFull "brave-control"
$publicEntries = @(
  ".codex-plugin",
  ".gitignore",
  ".mcp.json",
  "assets",
  "build-release.ps1",
  "config.example.json",
  "extension",
  "install.ps1",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "scripts",
  "skills",
  "TESTER-GUIDE.md",
  "tests"
)

try {
  New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
  foreach ($entry in $publicEntries) {
    $sourcePath = Join-Path $pluginRoot $entry
    if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Release input is missing: $entry" }
    Copy-Item -LiteralPath $sourcePath -Destination $packageRoot -Recurse -Force
  }

  # Keep only artwork referenced by the current manifests. Development icon
  # drafts may remain in the source tree, but never belong in public packages.
  $allowedExtensionIcons = @(
    "chatgpt-final-large-16.png",
    "chatgpt-final-large-32.png",
    "chatgpt-final-large-48.png",
    "chatgpt-final-large-128.png"
  )
  $stagedIconDirectory = Join-Path $packageRoot "extension\icons"
  foreach ($iconFile in Get-ChildItem -LiteralPath $stagedIconDirectory -File) {
    if ($iconFile.Name -notin $allowedExtensionIcons) {
      Remove-Item -LiteralPath $iconFile.FullName -Force
    }
  }
  $allowedPluginAssets = @("icon.png", "logo.png", "README.md")
  $stagedAssetDirectory = Join-Path $packageRoot "assets"
  foreach ($assetFile in Get-ChildItem -LiteralPath $stagedAssetDirectory -File) {
    if ($assetFile.Name -notin $allowedPluginAssets) {
      Remove-Item -LiteralPath $assetFile.FullName -Force
    }
  }

  foreach ($forbidden in @("config.json", "extension\pairing.json")) {
    if (Test-Path -LiteralPath (Join-Path $packageRoot $forbidden)) {
      throw "Private pairing state reached the release stage: $forbidden"
    }
  }

  $textExtensions = @(".html", ".js", ".json", ".md", ".mjs", ".ps1", ".txt", ".yaml", ".yml")
  $machineMarkers = @($env:COMPUTERNAME, $env:USERPROFILE) |
    Where-Object { $_ -and $_.Length -ge 4 } |
    Select-Object -Unique

  foreach ($file in Get-ChildItem -LiteralPath $packageRoot -Recurse -File) {
    if ($file.Extension -notin $textExtensions -and $file.Name -notin @("LICENSE", ".gitignore")) { continue }
    $content = [IO.File]::ReadAllText($file.FullName)
    if ($content -match '(?i)[A-Z]:[\\/]Users[\\/]') {
      throw "Absolute user-profile path detected in release file: $($file.FullName)"
    }
    if ($content -match '(?i)\bDESKTOP-[A-Z0-9-]+\b') {
      throw "Computer name detected in release file: $($file.FullName)"
    }
    if ($content -match '(?i)\b[a-f0-9]{64}\b') {
      throw "Token-like 256-bit hexadecimal value detected in release file: $($file.FullName)"
    }
    foreach ($marker in $machineMarkers) {
      if ($content.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "Local machine marker detected in release file: $($file.FullName)"
      }
    }
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory(
    $stagingFull,
    $zipPath,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace('/', '\') })
    foreach ($forbidden in @("brave-control\config.json", "brave-control\extension\pairing.json")) {
      if ($entryNames -contains $forbidden) { throw "Forbidden file found in release archive: $forbidden" }
    }
    if ($entryNames -notcontains "brave-control\.codex-plugin\plugin.json") {
      throw "The release archive is missing the Codex plugin manifest."
    }
    if ($entryNames -notcontains "brave-control\extension\manifest.json") {
      throw "The release archive is missing the Brave extension manifest."
    }
  } finally {
    $archive.Dispose()
  }

  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($hashPath, "$hash  $(Split-Path $zipPath -Leaf)`r`n", [Text.UTF8Encoding]::new($false))
  Write-Host "Created safe beta package: $zipPath"
  Write-Host "SHA-256: $hash"
} finally {
  if (Test-Path -LiteralPath $stagingFull) {
    $verifiedStage = [IO.Path]::GetFullPath($stagingFull)
    if (-not $verifiedStage.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or $verifiedStage -eq $tempBase) {
      throw "Refusing to clean an unsafe staging path: $verifiedStage"
    }
    Remove-Item -LiteralPath $verifiedStage -Recurse -Force
  }
}
