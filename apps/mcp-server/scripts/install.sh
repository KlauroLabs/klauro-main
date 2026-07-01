#!/bin/sh
#
# Klauro CLI/MCP one-line installer.
#
#   curl -fsSL https://mcp.klauro.com/install | sh
#
# Installs the `klauro` command globally from the Klauro analyzer server.
#
set -e

KLAURO_URL="${KLAURO_URL:-https://mcp.klauro.com}"

echo ""
echo "  Klauro installer"
echo "  ================"
echo "  Installing the klauro CLI/MCP from ${KLAURO_URL}"
echo ""

# --- Require Node >= 18 ---------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed."
  echo "Klauro requires Node.js 18 or newer. Install it from https://nodejs.org"
  exit 1
fi

NODE_VERSION="$(node -v 2>/dev/null)"
# Strip leading "v" and take the major version component.
NODE_MAJOR="$(echo "${NODE_VERSION}" | sed 's/^v//' | cut -d. -f1)"

case "${NODE_MAJOR}" in
  ''|*[!0-9]*)
    echo "Error: could not determine the Node.js version (got '${NODE_VERSION}')."
    echo "Klauro requires Node.js 18 or newer. See https://nodejs.org"
    exit 1
    ;;
esac

if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "Error: Node.js ${NODE_VERSION} is too old."
  echo "Klauro requires Node.js 18 or newer. Upgrade at https://nodejs.org"
  exit 1
fi

# --- Require npm ----------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not installed."
  echo "npm ships with Node.js. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

echo "  Using Node.js ${NODE_VERSION}"
echo ""
echo "  Installing @klauro/mcp-server globally..."
echo "  (this may take a minute -- native tree-sitter deps compile on install)"
echo ""

npm install -g "${KLAURO_URL}/dist/klauro-latest.tgz"

echo ""
echo "  Klauro installed. Next steps:"
echo ""
echo "    klauro login --email you@example.com --register"
echo "    cd /path/to/your/repo && klauro install --claude-scope user"
echo "    # then restart Claude Code"
echo ""
echo "  To update later:  klauro update"
echo ""
