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

# --- Require a supported Node range ----------------------------------------
# Klauro's native tree-sitter dependency (tree-sitter 0.25.x, no shipped
# prebuilds, binding.gyp pins -std=c++17) fails to compile against Node 23+
# headers (v8config.h: "C++20 or later required" — verified against the
# 22/23/24/25/26 header sets). Gate BEFORE npm install so the failure is a
# plain sentence, not a node-gyp stack trace. The hosted release manifest
# (/dist/latest.json: min_node/max_node) overrides these baked-in defaults,
# so a future WASM/prebuild release widens the range without a new installer.
NODE_MIN_DEFAULT=18
NODE_MAX_DEFAULT=22

MANIFEST_JSON="$(curl -fsSL --max-time 10 "${KLAURO_URL}/dist/latest.json" 2>/dev/null || true)"
# Minimal JSON field extraction (no jq dependency): "min_node": 18
manifest_int_field() {
  echo "${MANIFEST_JSON}" | tr -d ' \n\r\t' | sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" | head -n1
}
NODE_MIN="$(manifest_int_field min_node)"
NODE_MAX="$(manifest_int_field max_node)"

# Treat the hosted range as one atomic, bounded contract. A partially written,
# stale, or malformed manifest must never loosen the local safety gate. The
# hosted client bundle has no native analyzer dependencies, so a valid newer
# release may widen the ceiling (currently through Node 24) without replacing
# this installer; contradictory values fall back to its baked-in range.
case "${NODE_MIN}:${NODE_MAX}" in
  *[!0-9:]*|:|*:|*:*:*)
    NODE_MIN="${NODE_MIN_DEFAULT}"
    NODE_MAX="${NODE_MAX_DEFAULT}"
    ;;
  *)
    if [ "${NODE_MIN}" -lt 1 ] || [ "${NODE_MAX}" -lt "${NODE_MIN}" ] || [ "${NODE_MAX}" -gt 99 ]; then
      NODE_MIN="${NODE_MIN_DEFAULT}"
      NODE_MAX="${NODE_MAX_DEFAULT}"
    fi
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed."
  echo "Klauro requires Node.js ${NODE_MIN}-${NODE_MAX}. Install it from https://nodejs.org"
  exit 1
fi

NODE_VERSION="$(node -v 2>/dev/null)"
# Strip leading "v" and take the major version component.
NODE_MAJOR="$(echo "${NODE_VERSION}" | sed 's/^v//' | cut -d. -f1)"

case "${NODE_MAJOR}" in
  ''|*[!0-9]*)
    echo "Error: could not determine the Node.js version (got '${NODE_VERSION}')."
    echo "Klauro requires Node.js ${NODE_MIN}-${NODE_MAX}. See https://nodejs.org"
    exit 1
    ;;
esac

if [ "${NODE_MAJOR}" -lt "${NODE_MIN}" ]; then
  echo "Error: Node.js ${NODE_VERSION} is too old."
  echo "Klauro currently supports Node ${NODE_MIN}-${NODE_MAX}; you have ${NODE_MAJOR}."
  echo "Upgrade at https://nodejs.org, or install a supported version with:"
  echo "  nvm install ${NODE_MAX} && nvm use ${NODE_MAX}     # https://github.com/nvm-sh/nvm"
  echo "  volta install node@${NODE_MAX}                # https://volta.sh"
  exit 1
fi

if [ "${NODE_MAJOR}" -gt "${NODE_MAX}" ] && [ "${KLAURO_SKIP_NODE_CHECK:-0}" != "1" ]; then
  echo "Error: Node.js ${NODE_VERSION} is not supported yet."
  echo "Klauro currently supports Node ${NODE_MIN}-${NODE_MAX}; you have ${NODE_MAJOR}."
  echo "(Klauro's native tree-sitter parser does not compile on Node $((NODE_MAX + 1))+ yet.)"
  echo "Install a supported version and re-run this installer:"
  echo "  nvm install ${NODE_MAX} && nvm use ${NODE_MAX}     # https://github.com/nvm-sh/nvm"
  echo "  volta install node@${NODE_MAX}                # https://volta.sh"
  echo "Set KLAURO_SKIP_NODE_CHECK=1 to bypass this check at your own risk."
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
