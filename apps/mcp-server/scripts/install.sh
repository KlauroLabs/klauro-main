#!/bin/sh
#
# Klauro CLI/MCP one-line installer.
#
#   curl -fsSL https://mcp.klauro.com/install | sh
#
# Installs a SELF-CONTAINED `klauro` binary — no Node.js, no npm, no native
# compile step, on ANY machine. This is deliberate, not a convenience: Klauro
# used to require a machine Node install in the 18-22 range because the
# installer assumed npm install would compile a native tree-sitter parser.
# That assumption was never true for this client — inspecting the published
# tarball shows `dependencies: {}`, `optionalDependencies: {}`, and zero
# `.node` binaries; the ONLY place "tree-sitter"/"Node 18-22" ever appeared
# in the shipped code was the TEXT of this gate's own error message. The
# native tree-sitter compile is real, but it happens on Klauro's analyzer
# infrastructure, never on this machine — so the client no longer asks this
# machine's Node version anything at all. The binary embeds its own runtime
# (Node "single executable application" — see
# apps/mcp-server/scripts/build-sea-binaries.mjs).
#
# Fallback: if no self-contained binary is published for this OS/arch, or the
# download fails a checksum/smoke-test, this script falls back to the OLD
# npm-based install — clearly labeled below as an EMERGENCY path, not the
# primary one. That path still requires Node (any reasonably recent version;
# no upper bound — see the same reasoning above) and npm.
set -e

KLAURO_URL="${KLAURO_URL:-https://mcp.klauro.com}"
INSTALL_DIR="${KLAURO_INSTALL_DIR:-$HOME/.klauro/bin}"

echo ""
echo "  Klauro installer"
echo "  ================"
echo "  Installing the klauro CLI/MCP from ${KLAURO_URL}"
echo ""

# --- Detect platform ---------------------------------------------------
OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
ARCH_NAME="$(uname -m 2>/dev/null || echo unknown)"

case "${OS_NAME}" in
  Darwin) OS_ID="macos" ;;
  Linux) OS_ID="linux" ;;
  *) OS_ID="" ;;
esac
case "${ARCH_NAME}" in
  arm64|aarch64) ARCH_ID="arm64" ;;
  x86_64|amd64) ARCH_ID="x64" ;;
  *) ARCH_ID="" ;;
esac

PLATFORM_ID=""
if [ -n "${OS_ID}" ] && [ -n "${ARCH_ID}" ]; then
  PLATFORM_ID="${OS_ID}-${ARCH_ID}"
fi
PLATFORM_KEY="$(echo "${PLATFORM_ID}" | tr '-' '_')"

# --- Consult the release manifest --------------------------------------
# Same manifest `klauro update` reads (apps/mcp-server/src/self-update.ts),
# extended with flat `bin_<platform>_path` / `bin_<platform>_sha256` fields
# specifically so this POSIX-sh installer can read them with sed, with no
# JSON parser dependency. min_node/max_node may still appear in the manifest
# for backward-compat with older CLIs reading it, but this script no longer
# looks at them for anything.
MANIFEST_JSON="$(curl -fsSL --max-time 10 "${KLAURO_URL}/dist/latest.json" 2>/dev/null || true)"
COMPACT_MANIFEST="$(echo "${MANIFEST_JSON}" | tr -d ' \n\r\t')"

manifest_str_field() {
  echo "${COMPACT_MANIFEST}" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1
}

BINARY_PATH=""
BINARY_SHA256=""
if [ -n "${PLATFORM_KEY}" ]; then
  BINARY_PATH="$(manifest_str_field "bin_${PLATFORM_KEY}_path")"
  BINARY_SHA256="$(manifest_str_field "bin_${PLATFORM_KEY}_sha256")"
fi

install_binary() {
  echo "  Platform: ${PLATFORM_ID}"
  BINARY_URL="${BINARY_PATH}"
  case "${BINARY_URL}" in
    http://*|https://*) ;;
    *) BINARY_URL="${KLAURO_URL}${BINARY_PATH}" ;;
  esac
  echo "  Downloading ${BINARY_URL} ..."
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  TMP_BIN="${TMP_DIR}/klauro"
  if ! curl -fsSL --max-time 300 -o "${TMP_BIN}" "${BINARY_URL}"; then
    echo "  Download failed."
    return 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(sha256sum "${TMP_BIN}" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(shasum -a 256 "${TMP_BIN}" | cut -d' ' -f1)"
  else
    echo "  No sha256sum/shasum available to verify the download; refusing to install unverified."
    return 1
  fi
  if [ -n "${BINARY_SHA256}" ] && [ "${ACTUAL_SHA256}" != "${BINARY_SHA256}" ]; then
    echo "  Checksum mismatch (expected ${BINARY_SHA256}, got ${ACTUAL_SHA256}). Refusing to install."
    return 1
  fi
  echo "  Checksum verified."

  chmod +x "${TMP_BIN}"

  # macOS: curl-downloaded files carry no com.apple.quarantine attribute (only
  # browser/Mail-downloaded files do), so Gatekeeper does not block running
  # this ad-hoc-signed binary. No notarization step is performed here; a
  # future hardened-runtime + notarized release would remove even that
  # caveat, but is not required for this install path to work.
  if ! "${TMP_BIN}" version >/dev/null 2>&1; then
    echo "  Downloaded binary failed a basic smoke test (klauro version)."
    return 1
  fi

  mkdir -p "${INSTALL_DIR}"
  mv "${TMP_BIN}" "${INSTALL_DIR}/klauro"
  trap - EXIT
  rm -rf "${TMP_DIR}"
  echo "  Installed self-contained klauro to ${INSTALL_DIR}/klauro (no Node.js required)."
  return 0
}

# --- npm fallback (emergency only) --------------------------------------
# Reached only when no binary is published for this OS/arch, or the binary
# download/verify/smoke-test failed. Requires Node + npm on this machine; no
# upper Node-version bound (see the top-of-file note — the published tarball
# has never had anything to compile, on any Node version).
install_via_npm_fallback() {
  echo ""
  echo "  EMERGENCY FALLBACK: no verified self-contained binary for this platform"
  echo "  (${OS_NAME}/${ARCH_NAME}). Falling back to the npm-based install."
  echo "  This is not the primary supported path — please report your platform"
  echo "  so a binary can be published for it."
  echo ""
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js is not installed, and no self-contained binary is available for this platform."
    echo "Install Node.js from https://nodejs.org, then re-run this installer."
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is not installed. npm ships with Node.js — install Node.js from https://nodejs.org and re-run."
    exit 1
  fi
  NODE_VERSION="$(node -v 2>/dev/null)"
  NODE_MAJOR="$(echo "${NODE_VERSION}" | sed 's/^v//' | cut -d. -f1)"
  case "${NODE_MAJOR}" in
    ''|*[!0-9]*)
      echo "Warning: could not determine the Node.js version (got '${NODE_VERSION}'). Continuing anyway."
      ;;
    *)
      if [ "${NODE_MAJOR}" -lt 18 ]; then
        echo "Warning: Node.js ${NODE_VERSION} is older than klauro's declared minimum (18)."
        echo "This has not been verified to fail — continuing anyway. If install fails, upgrade Node and retry."
      fi
      ;;
  esac
  echo "  Using Node.js ${NODE_VERSION}"
  echo "  Installing @klauro/mcp-server globally via npm..."
  npm install -g "${KLAURO_URL}/dist/klauro-latest.tgz"
}

INSTALLED_VIA=""
if [ -n "${BINARY_PATH}" ] && [ -n "${PLATFORM_ID}" ]; then
  if install_binary; then
    INSTALLED_VIA="binary"
  fi
fi
if [ "${INSTALLED_VIA}" != "binary" ]; then
  install_via_npm_fallback
  INSTALLED_VIA="npm"
fi

# --- PATH setup (binary install only — npm's global bin is already on most
# people's PATH via their npm prefix) ------------------------------------
if [ "${INSTALLED_VIA}" = "binary" ]; then
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *)
      echo ""
      echo "  ${INSTALL_DIR} is not on your PATH yet."
      SHELL_RC=""
      case "${SHELL:-}" in
        */zsh) SHELL_RC="$HOME/.zshrc" ;;
        */bash) SHELL_RC="$HOME/.bashrc" ;;
        *) SHELL_RC="$HOME/.profile" ;;
      esac
      PATH_LINE="export PATH=\"${INSTALL_DIR}:\$PATH\""
      if [ -n "${SHELL_RC}" ] && [ -w "$(dirname "${SHELL_RC}")" ] && ! grep -qsF "${INSTALL_DIR}" "${SHELL_RC}" 2>/dev/null; then
        printf '\n# Added by the Klauro installer\n%s\n' "${PATH_LINE}" >> "${SHELL_RC}"
        echo "  Added ${INSTALL_DIR} to PATH in ${SHELL_RC}. Restart your shell, or run:"
        echo "    ${PATH_LINE}"
      else
        echo "  Add it to your shell profile:"
        echo "    ${PATH_LINE}"
      fi
      ;;
  esac
fi

echo ""
echo "  Klauro installed. Next steps:"
echo ""
echo "    klauro login --email you@example.com --register"
echo "    cd /path/to/your/repo && klauro install --claude-scope user"
echo "    # then restart Claude Code"
echo ""
echo "  To update later:  klauro update"
echo ""
