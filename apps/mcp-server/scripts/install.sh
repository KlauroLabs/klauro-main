#!/bin/sh
set -e

KLAURO_URL="${KLAURO_URL:-https://mcp.klauro.com}"
INSTALL_DIR="${KLAURO_INSTALL_DIR:-$HOME/.klauro/bin}"

echo ""
echo "  Klauro installer"
echo "  ================"
echo "  Installing the klauro CLI/MCP from ${KLAURO_URL}"
echo ""

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

MANIFEST_JSON="$(curl -fsSL --max-time 10 "${KLAURO_URL}/dist/latest.json" 2>/dev/null || true)"
COMPACT_MANIFEST="$(echo "${MANIFEST_JSON}" | tr -d ' \n\r\t')"

manifest_str_field() {
  echo "${COMPACT_MANIFEST}" | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n1
}

manifest_number_field() {
  echo "${COMPACT_MANIFEST}" | sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" | head -n1
}

MIN_NODE="$(manifest_number_field min_node)"
case "${MIN_NODE}" in
  ''|*[!0-9]*) MIN_NODE=20 ;;
esac

TARBALL_SHA256="$(manifest_str_field tarball_sha256)"
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

  if ! "${TMP_BIN}" version >/dev/null 2>&1; then
    echo "  Downloaded binary failed a basic smoke test (klauro version)."
    return 1
  fi

  mkdir -p "${INSTALL_DIR}"
  mv "${TMP_BIN}" "${INSTALL_DIR}/klauro"
  trap - EXIT
  rm -rf "${TMP_DIR}"
  echo "  Installed klauro to ${INSTALL_DIR}/klauro"
  return 0
}

install_via_npm_fallback() {
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
      if [ "${NODE_MAJOR}" -lt "${MIN_NODE}" ]; then
        echo "Error: Node.js ${NODE_VERSION} is older than this Klauro release's minimum (${MIN_NODE})."
        echo "Upgrade Node.js, then re-run this installer."
        exit 1
      fi
      ;;
  esac
  echo "  Using Node.js ${NODE_VERSION}"
  if [ "${#TARBALL_SHA256}" -ne 64 ]; then
    echo "Error: the release manifest has no valid npm tarball SHA-256 digest. Refusing an unverified install."
    return 1
  fi
  case "${TARBALL_SHA256}" in
    *[!0-9a-fA-F]*)
      echo "Error: the release manifest has no valid npm tarball SHA-256 digest. Refusing an unverified install."
      return 1
      ;;
  esac
  NPM_TMP_DIR="$(mktemp -d)"
  NPM_TARBALL="${NPM_TMP_DIR}/klauro.tgz"
  if ! curl -fsSL --max-time 300 -o "${NPM_TARBALL}" "${KLAURO_URL}/dist/klauro-latest.tgz"; then
    rm -rf "${NPM_TMP_DIR}"
    echo "Error: failed to download the npm fallback tarball."
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    NPM_ACTUAL_SHA256="$(sha256sum "${NPM_TARBALL}" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    NPM_ACTUAL_SHA256="$(shasum -a 256 "${NPM_TARBALL}" | cut -d' ' -f1)"
  else
    rm -rf "${NPM_TMP_DIR}"
    echo "Error: no SHA-256 utility is available. Refusing an unverified npm install."
    return 1
  fi
  if [ "$(printf '%s' "${NPM_ACTUAL_SHA256}" | tr 'A-F' 'a-f')" != "$(printf '%s' "${TARBALL_SHA256}" | tr 'A-F' 'a-f')" ]; then
    rm -rf "${NPM_TMP_DIR}"
    echo "Error: npm tarball checksum mismatch. Existing installation was left unchanged."
    return 1
  fi
  echo "  Installing @klauro/mcp-server globally via npm..."
  if npm install -g "${NPM_TARBALL}"; then
    rm -rf "${NPM_TMP_DIR}"
  else
    NPM_STATUS=$?
    rm -rf "${NPM_TMP_DIR}"
    echo "Error: npm install failed. Existing installation may still be active; no unverified package was installed."
    return "${NPM_STATUS}"
  fi
}

KLAURO_OWNED_MARKERS="node_modules/@klauro/mcp-server /Cellar/klauro/"

_klauro_path_entries() {
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
  _p="$1"
  _dir="$(dirname "${_p}")"
  _base="$(basename "${_p}")"
  _real_dir="$(cd "${_dir}" 2>/dev/null && pwd -P)" || _real_dir="${_dir}"
  echo "${_real_dir}/${_base}"
}

_klauro_resolve_target() {
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
  "$1" version 2>/dev/null | tr -d '\n' | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

resolve_and_take_over_path() {
  NL="$(printf '\nx')"; NL="${NL%x}"
  NEW_BIN="${INSTALL_DIR}/klauro"
  NEW_BIN_CANON="$(_klauro_canon "${NEW_BIN}")"

  if [ -z "$(_klauro_path_entries)" ]; then
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
