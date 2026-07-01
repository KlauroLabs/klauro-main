#!/usr/bin/env bash
#
# Klauro release: bump version -> pack tarball -> upload to the VPS downloads dir
# -> git tag. This is what makes `klauro update --check` actually nudge users:
# the hosted latest.json reports the new version and the update installs fresh bits.
#
# Usage:
#   scripts/release.sh [patch|minor|major|<explicit-version>]   (default: patch)
#   RELEASE_SKIP_UPLOAD=1 scripts/release.sh                     (pack only, no VPS)
#
# VPS creds come from the repo-root .env (VPS_HOST/VPS_USER/VPS_PASSWORD),
# which is gitignored. Requires sshpass + scp for the upload step.
#
set -euo pipefail

BUMP="${1:-patch}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"        # apps/mcp-server
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"          # proof-of-concept
cd "$APP_DIR"

echo "==> Bumping version ($BUMP)"
# Bump in-place with node (the package is private, so `npm version` would try the
# registry and 404). Accepts patch|minor|major or an explicit x.y.z string.
VERSION="$(node -e '
  const fs = require("fs");
  const p = "./package.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const bump = process.argv[1];
  let next;
  if (/^\d+\.\d+\.\d+/.test(bump)) {
    next = bump;
  } else {
    const [maj, min, pat] = j.version.split(".").map(Number);
    if (bump === "major") next = `${maj + 1}.0.0`;
    else if (bump === "minor") next = `${maj}.${min + 1}.0`;
    else next = `${maj}.${min}.${pat + 1}`;
  }
  j.version = next;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  process.stdout.write(next);
' "$BUMP")"
echo "    new version: $VERSION"

echo "==> Packing tarball (build + npm pack + latest.json)"
npm run pack:tarball >/dev/null
test -f ./.pack/klauro-latest.tgz || { echo "ERROR: tarball not produced"; exit 1; }
test -f ./.pack/latest.json       || { echo "ERROR: latest.json not produced"; exit 1; }
echo "    packed $(du -h ./.pack/klauro-latest.tgz | cut -f1) tarball, manifest version $(node -p "require('./.pack/latest.json').version")"

if [ "${RELEASE_SKIP_UPLOAD:-0}" = "1" ]; then
  echo "==> RELEASE_SKIP_UPLOAD=1 — skipping VPS upload"
else
  # Load VPS creds from the repo-root .env (never committed).
  if [ -f "$REPO_ROOT/.env" ]; then set -a; . "$REPO_ROOT/.env"; set +a; fi
  if [ -z "${VPS_HOST:-}" ] || [ -z "${VPS_USER:-}" ] || [ -z "${VPS_PASSWORD:-}" ]; then
    echo "    VPS creds missing (VPS_HOST/VPS_USER/VPS_PASSWORD) — skipping upload."
    echo "    Upload manually: scp .pack/klauro-latest.tgz .pack/latest.json <user>@<host>:/opt/klauro/downloads/"
  else
    echo "==> Uploading tarball + latest.json to $VPS_HOST:/opt/klauro/downloads/"
    SSHOPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=20"
    sshpass -p "$VPS_PASSWORD" scp $SSHOPTS \
      ./.pack/klauro-latest.tgz ./.pack/latest.json \
      "$VPS_USER@$VPS_HOST:/opt/klauro/downloads/"
    sshpass -p "$VPS_PASSWORD" ssh $SSHOPTS "$VPS_USER@$VPS_HOST" \
      "cp /opt/klauro/downloads/klauro-latest.tgz /opt/klauro/downloads/klauro-${VERSION}.tgz"
    echo "==> Verifying hosted manifest"
    HOSTED="$(curl -fsS "https://mcp.klauro.com/dist/latest.json" | node -p "JSON.parse(require('fs').readFileSync(0)).version" 2>/dev/null || echo unknown)"
    echo "    hosted latest.json version: $HOSTED"
    [ "$HOSTED" = "$VERSION" ] && echo "    OK — clients will see $VERSION on 'klauro update --check'"
  fi
fi

echo "==> Tagging v$VERSION"
cd "$REPO_ROOT"
git add apps/mcp-server/package.json
git commit -q -m "Release v$VERSION" || echo "    (nothing to commit — version already staged/committed)"
git tag -a "v$VERSION" -m "klauro v$VERSION" 2>/dev/null && echo "    tagged v$VERSION" || echo "    tag v$VERSION already exists"

echo "==> Done. v$VERSION released."
