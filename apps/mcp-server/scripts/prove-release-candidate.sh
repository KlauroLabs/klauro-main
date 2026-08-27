#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

: "${KLAURO_RELEASE_VERSION:?KLAURO_RELEASE_VERSION is required}"
: "${KLAURO_RELEASE_SHA:?KLAURO_RELEASE_SHA is required}"
: "${KLAURO_GIT_SHA:?KLAURO_GIT_SHA is required}"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
[ "$PACKAGE_VERSION" = "$KLAURO_RELEASE_VERSION" ] || { echo "ERROR: package version $PACKAGE_VERSION does not match release $KLAURO_RELEASE_VERSION." >&2; exit 1; }
[ "$KLAURO_GIT_SHA" = "$KLAURO_RELEASE_SHA" ] || { echo "ERROR: gate source $KLAURO_GIT_SHA does not match release commit $KLAURO_RELEASE_SHA." >&2; exit 1; }
case "$KLAURO_RELEASE_SHA" in
  *[!0-9a-fA-F]*|'') echo "ERROR: release commit must be a hexadecimal Git SHA." >&2; exit 1 ;;
esac
[ "${#KLAURO_RELEASE_SHA}" -eq 40 ] || { echo "ERROR: release commit must be the full 40-character Git SHA." >&2; exit 1; }
npx tsx src/spec-purity-gate-cli.ts ../..
bash scripts/build-release-artifacts.sh
node scripts/release-proof-receipt.mjs write
node scripts/release-proof-receipt.mjs verify
