#
# Klauro CLI/MCP one-line installer for Windows (PowerShell).
#
#   irm https://mcp.klauro.com/install.ps1 | iex
#
# Installs the `klauro` command globally from the Klauro analyzer server.
#
$ErrorActionPreference = 'Stop'

if (-not $env:KLAURO_URL) { $KlauroUrl = 'https://mcp.klauro.com' } else { $KlauroUrl = $env:KLAURO_URL }

Write-Host ''
Write-Host '  Klauro installer'
Write-Host '  ================'
Write-Host "  Installing the klauro CLI/MCP from $KlauroUrl"
Write-Host ''

# --- Require Node >= 18 ---------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Error: Node.js is not installed.'
  Write-Host 'Klauro requires Node.js 18 or newer. Install it from https://nodejs.org'
  exit 1
}

$nodeVersion = (& node -v).Trim()
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)') {
  $nodeMajor = [int]$Matches[1]
} else {
  Write-Host "Error: could not determine the Node.js version (got '$nodeVersion')."
  Write-Host 'Klauro requires Node.js 18 or newer. See https://nodejs.org'
  exit 1
}

if ($nodeMajor -lt 18) {
  Write-Host "Error: Node.js $nodeVersion is too old."
  Write-Host 'Klauro requires Node.js 18 or newer. Upgrade at https://nodejs.org'
  exit 1
}

# --- Require npm ----------------------------------------------------------
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
  Write-Host 'Error: npm is not installed.'
  Write-Host 'npm ships with Node.js. Install Node.js 18+ from https://nodejs.org'
  exit 1
}

Write-Host "  Using Node.js $nodeVersion"
Write-Host ''
Write-Host '  Installing @klauro/mcp-server globally...'
Write-Host '  (this may take a minute -- native tree-sitter deps compile on install)'
Write-Host ''

& npm install -g "$KlauroUrl/dist/klauro-latest.tgz"
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'Error: npm install failed. See the output above.'
  exit $LASTEXITCODE
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
