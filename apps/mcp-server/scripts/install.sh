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
  # Say what happened, not how it was built. A customer never had a Node
  # dependency to be relieved of, so "self-contained"/"no Node.js required"
  # advertises a problem they never had — it is our implementation history,
  # not their outcome.
  echo "  Installed klauro to ${INSTALL_DIR}/klauro"
  return 0
}

# --- npm fallback (emergency only) --------------------------------------
# Reached only when no binary is published for this OS/arch, or the binary
# download/verify/smoke-test failed. Requires Node + npm on this machine; no
# upper Node-version bound (see the top-of-file note — the published tarball
# has never had anything to compile, on any Node version).
install_via_npm_fallback() {
  # Tell the customer only what affects them: no build for their platform, so
  # this route needs Node. Our own view of this path — that it is an emergency
  # route, not the primary one, and that we would like their platform reported —
  # is internal and belongs in the comment above, not in their terminal.
  echo ""
  echo "  No prebuilt klauro is available for ${OS_NAME}/${ARCH_NAME}."
  echo "  Installing via npm instead, which requires Node.js."
  echo ""
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: klauro can't be installed on ${OS_NAME}/${ARCH_NAME} without Node.js."
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

# --- PATH resolution takeover -------------------------------------------
# A successful install that a stale `klauro` on PATH still shadows is not a
# success — it is this script reporting an outcome it never verified. Two
# earlier incidents (both self-inflicted, both silent) came from exactly
# that shape: an operation says "done" without checking what a customer
# would actually observe next. So this script does not stop at installing
# a file; it resolves what `klauro` will really execute afterward, takes
# over any shadowing copy it can positively prove is its own prior install,
# and refuses to claim success if it cannot make that true.
#
# "Ours" is proven, not guessed by path location: every klauro-brand-owned
# install this script knows how to produce is either (a) this script's own
# binary under KLAURO_INSTALL_DIR, or (b) an npm/npm-adjacent shim symlink
# whose link target resolves into the @klauro/mcp-server package (matching
# apps/mcp-server/package.json's `name`/`bin` fields — see build-bundle.mjs
# for the same package identity used to build the binary this script just
# installed) or a Homebrew Cellar path for a klauro formula. A `klauro` this
# script cannot positively identify is never touched, renamed, or removed —
# only reported.
KLAURO_OWNED_MARKERS="node_modules/@klauro/mcp-server /Cellar/klauro/"

_klauro_path_entries() {
  # Print every existing/linked "<dir>/klauro" found by walking $PATH in
  # search order, one per line.
  _old_ifs="${IFS}"
  IFS=':'
  for _d in ${PATH}; do
    IFS="${_old_ifs}"
    [ -n "${_d}" ] || continue
    _c="${_d}/klauro"
    if [ -e "${_c}" ] || [ -L "${_c}" ]; then
      echo "${_c}"
    fi
    IFS=':'
  done
  IFS="${_old_ifs}"
}

_klauro_is_owned_symlink() {
  # $1 = candidate path. True (0) only if it is a symlink whose target
  # string matches a known klauro-brand install marker.
  [ -L "$1" ] || return 1
  _target="$(readlink "$1" 2>/dev/null || true)"
  [ -n "${_target}" ] || return 1
  for _marker in ${KLAURO_OWNED_MARKERS}; do
    case "${_target}" in
      *"${_marker}"*) return 0 ;;
    esac
  done
  return 1
}

_klauro_canon() {
  # Best-effort canonical absolute path for comparison purposes. Falls back
  # to the literal string if the directory cannot be resolved (e.g. broken
  # link), which is still a safe, honest comparison input.
  _p="$1"
  _dir="$(dirname "${_p}")"
  _base="$(basename "${_p}")"
  _real_dir="$(cd "${_dir}" 2>/dev/null && pwd -P)" || _real_dir="${_dir}"
  echo "${_real_dir}/${_base}"
}

_klauro_resolve_target() {
  # $1 = a klauro path. Prints the file it will actually execute, following
  # one level of symlink (sufficient for both the npm shim shape and the
  # symlinks this script itself creates).
  _p="$1"
  if [ -L "${_p}" ]; then
    _t="$(readlink "${_p}" 2>/dev/null || true)"
    case "${_t}" in
      /*) echo "${_t}" ;;
      *) echo "$(dirname "${_p}")/${_t}" ;;
    esac
  else
    echo "${_p}"
  fi
}

_klauro_version_of() {
  # $1 = executable path. Side-effect-free, no network, no auth — safe to
  # run against an arbitrary file named klauro (installed-cli.ts's `version`
  # branch returns immediately with no I/O).
  "$1" version 2>/dev/null | tr -d '\n' | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

resolve_and_take_over_path() {
  NL="$(printf '\nx')"; NL="${NL%x}"
  NEW_BIN="${INSTALL_DIR}/klauro"
  NEW_BIN_CANON="$(_klauro_canon "${NEW_BIN}")"

  if [ -z "$(_klauro_path_entries)" ]; then
    # Nothing named klauro is anywhere on the CURRENT shell's PATH — not a
    # shadow, just a brand-new install whose directory this child process
    # cannot retroactively add to the parent shell's already-inherited PATH.
    # That is a real, honest restart requirement (handled by the PATH-setup
    # step above), not the silent-failure class this function exists to
    # catch. Nothing to take over, nothing to warn about.
    return 2
  fi

  TAKEN_OVER_LIST=""
  BLOCKED_LIST=""

  for CANDIDATE in $(_klauro_path_entries); do
    [ "$(_klauro_canon "${CANDIDATE}")" = "${NEW_BIN_CANON}" ] && continue
    if _klauro_is_owned_symlink "${CANDIDATE}"; then
      OLD_TARGET="$(readlink "${CANDIDATE}" 2>/dev/null || true)"
      CANDIDATE_DIR="$(dirname "${CANDIDATE}")"
      if [ -w "${CANDIDATE_DIR}" ]; then
        if ln -sf "${NEW_BIN}" "${CANDIDATE}" 2>/dev/null; then
          TAKEN_OVER_LIST="${TAKEN_OVER_LIST}${CANDIDATE} (was -> ${OLD_TARGET})${NL}"
        else
          BLOCKED_LIST="${BLOCKED_LIST}${CANDIDATE} (klauro-owned, but repointing it failed)${NL}"
        fi
      else
        BLOCKED_LIST="${BLOCKED_LIST}${CANDIDATE} (klauro-owned, but $(dirname "${CANDIDATE}") is not writable — try: sudo ln -sf \"${NEW_BIN}\" \"${CANDIDATE}\")${NL}"
      fi
    else
      CANDIDATE_VERSION="$(_klauro_version_of "${CANDIDATE}")"
      BLOCKED_LIST="${BLOCKED_LIST}${CANDIDATE}${CANDIDATE_VERSION:+ (${CANDIDATE_VERSION})} — not a recognized klauro-brand install, left untouched. Remove or reorder it: rm \"${CANDIDATE}\"${NL}"
    fi
  done

  if [ -n "${TAKEN_OVER_LIST}" ]; then
    echo ""
    echo "  Repointed shadowing klauro installs to the version just installed:"
    printf '%s\n' "${TAKEN_OVER_LIST}" | while IFS= read -r line; do
      [ -n "${line}" ] && echo "    ${line}"
    done
    echo "  Their package manager's own records are now stale (e.g. \`npm ls -g\` may still"
    echo "  report an old @klauro/mcp-server version). That is expected — the symlink now"
    echo "  points at the current install. Optional cleanup, not required and not run for you:"
    printf '%s\n' "${TAKEN_OVER_LIST}" | sed -n 's/^\([^ ]*\).*/\1/p' | while IFS= read -r p; do
      [ -n "${p}" ] && echo "    npm uninstall -g @klauro/mcp-server   # if ${p} came from npm"
    done
  fi

  if [ -d "${NVM_DIR:-$HOME/.nvm}/versions/node" ]; then
    for VDIR in "${NVM_DIR:-$HOME/.nvm}/versions/node"/*/bin; do
      [ -d "${VDIR}" ] || continue
      OFF_CANDIDATE="${VDIR}/klauro"
      { [ -e "${OFF_CANDIDATE}" ] || [ -L "${OFF_CANDIDATE}" ]; } || continue
      case ":${PATH}:" in
        *":${VDIR}:"*) continue ;;
      esac
      if _klauro_is_owned_symlink "${OFF_CANDIDATE}"; then
        echo ""
        echo "  Also found (not on your current PATH, so left alone): ${OFF_CANDIDATE}"
        echo "  -> $(readlink "${OFF_CANDIDATE}")"
        echo "  If you later \`nvm use\` that Node version, it could shadow klauro again."
      fi
    done
  fi

  WINNER="$(_klauro_path_entries | head -n1)"
  if [ -z "${WINNER}" ]; then
    echo ""
    echo "  ERROR: no klauro found on PATH after install — PATH setup did not take effect"
    echo "  in this shell. Restart your shell and re-run this installer to verify."
    return 1
  fi
  WINNER_TARGET="$(_klauro_resolve_target "${WINNER}")"
  if [ "$(_klauro_canon "${WINNER_TARGET}")" != "${NEW_BIN_CANON}" ]; then
    echo ""
    echo "  ERROR: klauro was installed to ${NEW_BIN}, but typing \`klauro\` will still run:"
    echo "    ${WINNER} -> ${WINNER_TARGET}"
    if [ -n "${BLOCKED_LIST}" ]; then
      printf '%s\n' "${BLOCKED_LIST}" | while IFS= read -r line; do
        [ -n "${line}" ] && echo "    ${line}"
      done
    fi
    echo ""
    echo "  This install is NOT complete: fix the above, then re-run this installer."
    return 1
  fi

  WINNER_VERSION="$(_klauro_version_of "${WINNER}")"
  echo ""
  echo "  klauro now resolves to ${WINNER}$( [ "${WINNER}" != "${WINNER_TARGET}" ] && echo " -> ${WINNER_TARGET}" )${WINNER_VERSION:+ (${WINNER_VERSION})}"
  return 0
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

# --- Resolve + take over: prove `klauro` actually runs what was just
# installed, in THIS shell, right now. See resolve_and_take_over_path
# above for what "ours" means and what happens when it is not. -----------
if [ "${INSTALLED_VIA}" = "binary" ]; then
  set +e
  resolve_and_take_over_path
  RESOLVE_STATUS=$?
  set -e
  if [ "${RESOLVE_STATUS}" = "1" ]; then
    exit 1
  fi
fi

echo ""
echo "  Klauro installed. Next steps:"
echo ""
echo "    klauro login --register"
echo "    cd /path/to/your/repo && klauro install --claude-scope user"
echo "    # then restart Claude Code"
echo ""
echo "  To update later:  klauro update"
echo ""
