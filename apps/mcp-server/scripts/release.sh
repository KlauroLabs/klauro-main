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

# Clean-tree gate. build-bundle.mjs bakes `git status --porcelain` into the
# CLI's own version string, so a release cut from a dirty tree ships a binary
# that self-reports "<version>+<sha>-dirty" — exactly what the 2026-07-27 audit
# found installed as 1.0.127 ("1.0.127+2235c82c0370-dirty"). A -dirty release is
# unreproducible: nobody can tell what code a customer is running. The bump
# commit below is not enough on its own, because it only commits package.json /
# lockfiles and leaves every other working-tree edit in the build.
# This mirrors the deploy.sh dirty-tree guard (2026-07-16 incident).
if [ "${RELEASE_ALLOW_DIRTY:-0}" != "1" ]; then
  DIRTY="$(cd "$REPO_ROOT" && git status --porcelain -uall)"
  if [ -n "$DIRTY" ]; then
    echo "ERROR: refusing to release from a dirty tree — the built CLI would self-report a '-dirty' version." >&2
    echo "       Commit or stash these first (or set RELEASE_ALLOW_DIRTY=1 to override, knowingly):" >&2
    echo "$DIRTY" | sed 's/^/         /' >&2
    exit 1
  fi
  echo "==> Clean-tree gate OK (HEAD $(cd "$REPO_ROOT" && git rev-parse --short=12 HEAD))"
fi

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
  // Keep the lockfile version in lockstep so the tree stays clean after a release.
  const lock = "./package-lock.json";
  if (fs.existsSync(lock)) {
    const l = JSON.parse(fs.readFileSync(lock, "utf8"));
    l.version = next;
    if (l.packages && l.packages[""]) l.packages[""].version = next;
    fs.writeFileSync(lock, JSON.stringify(l, null, 2) + "\n");
  }
  // Also keep the monorepo ROOT lockfile in lockstep. `docker compose up --build`
  // runs `npm ci` at the repo root, and npm ci fails hard if the root lockfile''s
  // recorded apps/mcp-server version (or any @klauro/mcp-server dep ref pinned to
  // an exact version) drifts from package.json. This bit us in a real deploy.
  const rootLock = process.argv[2];
  if (rootLock && fs.existsSync(rootLock)) {
    const rl = JSON.parse(fs.readFileSync(rootLock, "utf8"));
    let n = 0;
    if (rl.packages && rl.packages["apps/mcp-server"]) {
      rl.packages["apps/mcp-server"].version = next;
      n++;
    }
    for (const k of Object.keys(rl.packages || {})) {
      const pk = rl.packages[k];
      for (const dt of ["dependencies", "devDependencies"]) {
        const ref = pk && pk[dt] && pk[dt]["@klauro/mcp-server"];
        // Only rewrite exact-version pins; leave "*"/range specs alone.
        if (ref && /^\d+\.\d+\.\d+/.test(ref)) {
          pk[dt]["@klauro/mcp-server"] = next;
          n++;
        }
      }
    }
    if (n > 0) fs.writeFileSync(rootLock, JSON.stringify(rl, null, 2) + "\n");
  }
  process.stdout.write(next);
' "$BUMP" "$REPO_ROOT/package-lock.json")"
echo "    new version: $VERSION"

# Commit the version bump BEFORE building. build-bundle.mjs derives the
# hosted -dirty suffix from `git status --porcelain`; if we pack while the
# bump is still uncommitted, every real release ships marked -dirty even
# though it's built from an intentional, tagged commit. Commit first so the
# tree is clean at build time, then pack/tag against that clean commit.
echo "==> Committing version bump v$VERSION"
cd "$REPO_ROOT"
git add apps/mcp-server/package.json apps/mcp-server/package-lock.json package-lock.json
git commit -q -m "Release v$VERSION" || echo "    (nothing to commit — version already staged/committed)"
cd "$APP_DIR"

echo "==> Packing tarball (build + npm pack + latest.json)"
npm run pack:tarball >/dev/null
test -f ./.pack/klauro-latest.tgz || { echo "ERROR: tarball not produced"; exit 1; }
test -f ./.pack/latest.json       || { echo "ERROR: latest.json not produced"; exit 1; }

# Freshness gate: the tarball's INNER package.json version must equal the
# release version. This caught real poisoning — the old picker copied the
# PREVIOUS klauro-latest.tgz onto itself (alphabetical readdir .find), so
# every release since July 1 shipped the 1.0.0 bits while latest.json claimed
# the new version, silently downgrading every `klauro update` user.
INNER_VER="$(tar -xzOf ./.pack/klauro-latest.tgz package/package.json | node -p "JSON.parse(require('fs').readFileSync(0)).version" 2>/dev/null || echo unknown)"
if [ "$INNER_VER" != "$VERSION" ]; then
  echo "ERROR: tarball is STALE — inner package version $INNER_VER != release $VERSION. Refusing to upload." >&2
  exit 1
fi
echo "    tarball freshness OK (inner package version $INNER_VER)"

# Build-identity gate: run the PACKED cli and make it tell us who it is. The
# version string is what a customer sees in `klauro version`, what the MCP
# staleness check compares, and what support reads off a bug report — it must
# carry the real HEAD sha and no '-dirty' suffix. Checking the artifact (rather
# than trusting the clean-tree gate above) also catches a stale dist/ that
# npm pack picked up without a rebuild.
IDENT_TMP="$(mktemp -d)"
tar -xzf ./.pack/klauro-latest.tgz -C "$IDENT_TMP" package/dist/cli.cjs
PACKED_IDENT="$(node "$IDENT_TMP/package/dist/cli.cjs" version 2>/dev/null || echo unknown)"
rm -rf "$IDENT_TMP"
HEAD_SHA="$(cd "$REPO_ROOT" && git rev-parse --short=12 HEAD)"
echo "    packed CLI identity: $PACKED_IDENT (HEAD $HEAD_SHA)"
case "$PACKED_IDENT" in
  *-dirty*)
    echo "ERROR: packed CLI self-reports a '-dirty' build ($PACKED_IDENT). Refusing to publish an unreproducible release." >&2
    exit 1;;
esac
case "$PACKED_IDENT" in
  *"$VERSION"*"$HEAD_SHA"*) : ;;
  *)
    echo "ERROR: packed CLI identity '$PACKED_IDENT' does not carry version $VERSION + HEAD sha $HEAD_SHA." >&2
    echo "       The tarball was built from different bits than HEAD. Refusing to publish." >&2
    exit 1;;
esac
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
    echo "==> Verifying the LIVE distribution channel (not just the upload)"
    # A green /health does NOT mean the distribution channel works: the api serves
    # /dist/* from a mounted downloads dir, and a missing mount silently yields
    # tarball-404 + version:null. So verify what clients actually hit, and FAIL LOUD.
    HOSTED="$(curl -fsS "https://mcp.klauro.com/dist/latest.json" | node -p "JSON.parse(require('fs').readFileSync(0)).version" 2>/dev/null || echo unknown)"
    TARBALL_CODE="$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "https://mcp.klauro.com/dist/klauro-latest.tgz" 2>/dev/null || echo 000)"
    echo "    hosted latest.json version: $HOSTED ; tarball HTTP: $TARBALL_CODE"
    # shellcheck source=verify-distribution-channel.sh
    . "$(cd "$(dirname "$0")" && pwd)/verify-distribution-channel.sh"
    if verify_distribution_channel "$HOSTED" "$VERSION" "$TARBALL_CODE"; then
      echo "    OK — clients will see $VERSION + download the tarball on 'klauro update'"
    else
      echo "    !! DISTRIBUTION CHANNEL BROKEN: version=$HOSTED (want $VERSION), tarball=$TARBALL_CODE (want 200)." >&2
      echo "    !! Common cause: the api container is missing the '/opt/klauro/downloads' volume mount" >&2
      echo "    !! (the deploy rsyncs docker-compose.yml — ensure it keeps the downloads mount)." >&2
      echo "    !! Tarball uploaded fine, but clients can't fetch it. FIX before announcing the release." >&2
      exit 1
    fi
  fi
fi

echo "==> Tagging v$VERSION"
cd "$REPO_ROOT"
git tag -a "v$VERSION" -m "klauro v$VERSION" 2>/dev/null && echo "    tagged v$VERSION" || echo "    tag v$VERSION already exists"

echo "==> Done. v$VERSION released."
