$ErrorActionPreference = 'Stop'

if (-not $env:KLAURO_URL) { $KlauroUrl = 'https://mcp.klauro.com' } else { $KlauroUrl = $env:KLAURO_URL }
$InstallDir = if ($env:KLAURO_INSTALL_DIR) { $env:KLAURO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Klauro\bin' }
$MinNode = 20
$TarballSha256 = $null

Write-Host ''
Write-Host '  Klauro installer'
Write-Host '  ================'
Write-Host "  Installing the klauro CLI/MCP from $KlauroUrl"
Write-Host ''

function Install-NpmFallback {
  Write-Host ''
  Write-Host '  EMERGENCY FALLBACK: no verified self-contained binary is available.'
  Write-Host '  Falling back to the npm-based install. This is not the primary supported path.'
  Write-Host ''
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host 'Error: Node.js is not installed, and no self-contained binary is available.'
    Write-Host 'Install Node.js from https://nodejs.org, then re-run this installer.'
    exit 1
  }
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) {
    Write-Host 'Error: npm is not installed. npm ships with Node.js — install it from https://nodejs.org and re-run.'
    exit 1
  }
  $nodeVersion = (& node -v).Trim()
  if ($nodeVersion -match '^v(\d+)') {
    $nodeMajor = [int]$Matches[1]
    if ($nodeMajor -lt $MinNode) {
      Write-Host "Error: Node.js $nodeVersion is older than this Klauro release's minimum ($MinNode)."
      Write-Host 'Upgrade Node.js, then re-run this installer.'
      exit 1
    }
  }
  Write-Host "  Using Node.js $nodeVersion"
  if (-not $TarballSha256 -or $TarballSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    Write-Host 'Error: the release manifest has no valid npm tarball SHA-256 digest. Refusing an unverified install.'
    exit 1
  }
  $tmpTarball = New-TemporaryFile
  try {
    Invoke-WebRequest -Uri "$KlauroUrl/dist/klauro-latest.tgz" -OutFile $tmpTarball.FullName -TimeoutSec 300
    $actualTarballHash = (Get-FileHash -Path $tmpTarball.FullName -Algorithm SHA256).Hash.ToLower()
    if ($actualTarballHash -ne $TarballSha256.ToLower()) {
      Write-Host 'Error: npm tarball checksum mismatch. Existing installation was left unchanged.'
      exit 1
    }
    Write-Host '  Installing @klauro/mcp-server globally via npm...'
    & npm install -g $tmpTarball.FullName
    if ($LASTEXITCODE -ne 0) {
      Write-Host ''
      Write-Host 'Error: npm install failed. No unverified package was installed.'
      exit $LASTEXITCODE
    }
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmpTarball.FullName
  }
}

$installedVia = $null
try {
  $manifestJson = Invoke-RestMethod -Uri "$KlauroUrl/dist/latest.json" -TimeoutSec 10 -ErrorAction Stop
  if ($manifestJson.min_node -as [int]) { $MinNode = [int]$manifestJson.min_node }
  $TarballSha256 = $manifestJson.tarball_sha256
  $binaryPath = $manifestJson.'bin_win_x64_path'
  $binarySha256 = $manifestJson.'bin_win_x64_sha256'
} catch {
  $binaryPath = $null
  $binarySha256 = $null
  $TarballSha256 = $null
}

if ($binaryPath) {
  try {
    $binaryUrl = if ($binaryPath -match '^https?://') { $binaryPath } else { "$KlauroUrl$binaryPath" }
    Write-Host "  Platform: win-x64"
    Write-Host "  Downloading $binaryUrl ..."
    $tmpFile = New-TemporaryFile
    Invoke-WebRequest -Uri $binaryUrl -OutFile $tmpFile.FullName -TimeoutSec 300

    if ($binarySha256) {
      $actualHash = (Get-FileHash -Path $tmpFile.FullName -Algorithm SHA256).Hash.ToLower()
      if ($actualHash -ne $binarySha256.ToLower()) {
        throw "Checksum mismatch: expected $binarySha256, got $actualHash"
      }
      Write-Host '  Checksum verified.'
    }

    $smoke = & $tmpFile.FullName version 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Downloaded binary failed a basic smoke test (klauro version): $smoke"
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $finalPath = Join-Path $InstallDir 'klauro.exe'
    Move-Item -Path $tmpFile.FullName -Destination $finalPath -Force
    Write-Host "  Installed self-contained klauro to $finalPath (no Node.js required)."
    $installedVia = 'binary'

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$InstallDir*") {
      [Environment]::SetEnvironmentVariable('Path', "$InstallDir;$userPath", 'User')
      Write-Host "  Added $InstallDir to your user PATH. Restart your terminal to pick it up."
    }
  } catch {
    Write-Host "  Binary install failed: $_"
    $installedVia = $null
  }
}

if ($installedVia -ne 'binary') {
  Install-NpmFallback
  $installedVia = 'npm'
}

Write-Host ''
Write-Host '  Klauro installed. Next steps:'
Write-Host ''
Write-Host '    klauro login --email you@example.com --register'
Write-Host '    cd C:\path\to\your\repo ; klauro install --claude-scope user'
Write-Host '    # then restart Claude Code'
Write-Host ''
Write-Host '  To update later:  klauro update'
Write-Host ''
