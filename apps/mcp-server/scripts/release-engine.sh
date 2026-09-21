#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CRATE="$REPO_ROOT/packages/analyzer-core/native/klauro-engine"
PLATFORM="${1:-}"
TARGET="${2:-}"

case "$PLATFORM" in
  darwin-arm64) TARGET="${TARGET:-aarch64-apple-darwin}" ;;
  darwin-x64)   TARGET="${TARGET:-x86_64-apple-darwin}" ;;
  linux-x64)    TARGET="${TARGET:-x86_64-unknown-linux-gnu}" ;;
  win32-x64)    TARGET="${TARGET:-x86_64-pc-windows-gnu}" ;;
  *) echo "usage: release-engine.sh <darwin-arm64|darwin-x64|linux-x64|win32-x64> [rust-target]" >&2; exit 2 ;;
esac

VERSION="$(node -p "require('$REPO_ROOT/apps/mcp-server/package.json').version")"
echo "==> Releasing klauro-engine $VERSION for $PLATFORM ($TARGET)"

cd "$CRATE"
echo "==> Test gate (this host)"
cargo test --release

echo "==> Build"
cargo build --release --locked --target "$TARGET"
BINARY="$CRATE/target/$TARGET/release/klauro-engine"
[ "$PLATFORM" = "win32-x64" ] && BINARY="$BINARY.exe"
[ -f "$BINARY" ] || { echo "ERROR: $BINARY was not produced." >&2; exit 1; }

echo "==> Proving the built artifact runs"
if "$BINARY" "$CRATE/tests/fixtures/alias" > /dev/null 2>&1; then
  echo "    $PLATFORM artifact ran here and produced an index."
elif [ "${RELEASE_ENGINE_ALLOW_UNVERIFIED:-0}" = "1" ]; then
  echo "    !! $PLATFORM was cross-built and CANNOT be run on this host." >&2
  echo "    !! Publishing an artifact whose runtime behaviour is unverified," >&2
  echo "    !! because RELEASE_ENGINE_ALLOW_UNVERIFIED=1 was set." >&2
else
  echo "ERROR: the $PLATFORM artifact could not be run on this host, so nothing proves it works." >&2
  echo "       Build it on a $PLATFORM machine, or set RELEASE_ENGINE_ALLOW_UNVERIFIED=1" >&2
  echo "       to publish it knowing it is unverified." >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ARTIFACT="$STAGE/klauro-engine.zst"
zstd -19 -q -o "$ARTIFACT" "$BINARY"

digest() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || sha256sum "$1" | awk '{print $1}'; }
size() { wc -c < "$1" | tr -d ' '; }
ARTIFACT_SHA="$(digest "$ARTIFACT")"

cat > "$STAGE/artifact.json" <<JSON
{
  "version": "$VERSION",
  "platform": "$PLATFORM",
  "path": "engine/$VERSION/$PLATFORM/klauro-engine.zst",
  "encoding": "zstd",
  "size": $(size "$ARTIFACT"),
  "sha256": "$ARTIFACT_SHA",
  "decompressedSize": $(size "$BINARY"),
  "decompressedSha256": "$(digest "$BINARY")",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "==> Artifact"
cat "$STAGE/artifact.json"

if [ "${RELEASE_ENGINE_SKIP_UPLOAD:-0}" = "1" ]; then
  KEEP="$REPO_ROOT/apps/mcp-server/.pack/engine-$VERSION-$PLATFORM"
  mkdir -p "$KEEP"
  cp "$ARTIFACT" "$STAGE/artifact.json" "$KEEP/"
  echo "==> RELEASE_ENGINE_SKIP_UPLOAD=1 — artifact kept in $KEEP"
  exit 0
fi

set -a; . "$REPO_ROOT/.env"; set +a
: "${VPS_HOST:?}" "${VPS_USER:?}" "${VPS_PASSWORD:?}"
export SSHPASS="$VPS_PASSWORD"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=25"
DEST="$VPS_USER@$VPS_HOST"
REMOTE="/opt/klauro/downloads/engine/$VERSION/$PLATFORM"

PUBLISHED="$($SSH "$DEST" "cat '$REMOTE/artifact.json' 2>/dev/null" || true)"
if [ -n "$PUBLISHED" ]; then
  WAS="$(printf '%s' "$PUBLISHED" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).sha256" 2>/dev/null || true)"
  if [ "$WAS" = "$ARTIFACT_SHA" ]; then
    echo "==> $VERSION/$PLATFORM is already published with these exact bytes — nothing to do."
    exit 0
  fi
  echo "ERROR: klauro-engine $VERSION is already published for $PLATFORM with different bytes." >&2
  echo "       published sha256: ${WAS:-unreadable}" >&2
  echo "       this build's     : $ARTIFACT_SHA" >&2
  echo "       A published version is immutable — whoever downloaded $VERSION verified the old" >&2
  echo "       digest, and replacing it breaks them. Bump the version and release that instead." >&2
  exit 1
fi

echo "==> Publishing to $DEST:$REMOTE"
$SSH "$DEST" "mkdir -p '$REMOTE'"
rsync -az -e "$SSH" "$ARTIFACT" "$DEST:$REMOTE/klauro-engine.zst"
rsync -az -e "$SSH" "$STAGE/artifact.json" "$DEST:$REMOTE/artifact.json"

echo "==> Rebuilding the manifest from published artifacts (written last, never partial)"
$SSH "$DEST" "python3 - <<'PY'
import json, pathlib
root = pathlib.Path('/opt/klauro/downloads/engine')
artifacts = [json.loads(p.read_text()) for p in sorted(root.glob('*/*/artifact.json'))]
tmp = root / 'manifest.json.tmp'
tmp.write_text(json.dumps({'artifacts': artifacts}, indent=2))
tmp.replace(root / 'manifest.json')
print(f'manifest: {len(artifacts)} artifact(s)')
PY"

echo "==> Done. klauro-engine $VERSION published for $PLATFORM."
