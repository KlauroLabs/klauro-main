#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

BUILD_SHA="${KLAURO_GIT_SHA:?KLAURO_GIT_SHA is required}"
VERSION="$(node -p "require('./package.json').version")"

rm -rf "$APP_DIR/dist" "$APP_DIR/dist-sea" "$APP_DIR/.customer-package" "$APP_DIR/.pack"
npm run build >/dev/null
npm run build:sea

test -f ./dist-sea/manifest.json || { echo "ERROR: dist-sea/manifest.json was not produced." >&2; exit 1; }
SEA_BIN_COUNT="$(node -p "require('./dist-sea/manifest.json').targets.length")"
[ "$SEA_BIN_COUNT" -gt 0 ] || { echo "ERROR: no natively verified SEA binary was produced." >&2; exit 1; }

mkdir -p ./.pack
npm pack ./.customer-package --pack-destination ./.pack >/dev/null
node scripts/write-release-manifest.mjs

test -f ./.pack/klauro-latest.tgz || { echo "ERROR: release tarball was not produced." >&2; exit 1; }
test -f ./.pack/latest.json || { echo "ERROR: release manifest was not produced." >&2; exit 1; }

MANIFEST_BIN_COUNT="$(node -p "Object.keys(require('./.pack/latest.json').binaries || {}).length")"
[ "$MANIFEST_BIN_COUNT" = "$SEA_BIN_COUNT" ] || { echo "ERROR: release manifest contains $MANIFEST_BIN_COUNT binaries, expected $SEA_BIN_COUNT." >&2; exit 1; }

INNER_VERSION="$(tar -xzOf ./.pack/klauro-latest.tgz package/package.json | node -p "JSON.parse(require('fs').readFileSync(0)).version")"
[ "$INNER_VERSION" = "$VERSION" ] || { echo "ERROR: tarball version $INNER_VERSION does not match release $VERSION." >&2; exit 1; }

IDENTITY_DIR="$(mktemp -d)"
trap 'rm -rf "$IDENTITY_DIR"' EXIT
tar -xzf ./.pack/klauro-latest.tgz -C "$IDENTITY_DIR" package/dist/cli.cjs
PACKED_IDENTITY="$(node "$IDENTITY_DIR/package/dist/cli.cjs" version)"
case "$PACKED_IDENTITY" in
  *-dirty*) echo "ERROR: packed CLI reports a dirty source identity: $PACKED_IDENTITY" >&2; exit 1 ;;
esac
case "$PACKED_IDENTITY" in
  *"$VERSION"*"$BUILD_SHA"*) ;;
  *) echo "ERROR: packed CLI identity '$PACKED_IDENTITY' does not contain $VERSION and $BUILD_SHA." >&2; exit 1 ;;
esac

echo "Built and verified $VERSION+$BUILD_SHA with $SEA_BIN_COUNT native binary artifact(s)."
