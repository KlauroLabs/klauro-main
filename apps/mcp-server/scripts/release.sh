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

# --- Step tracking + failure report ------------------------------------
# 2026-08-09 incident: the upload step (sshpass scp) failed on transient SSH
# rate-limiting, `set -euo pipefail` aborted the script immediately, and the
# release was left half-applied — version bumped and committed, tarball
# packed, artifacts NOT uploaded, tag NOT created — with no summary of what
# had actually happened. This tracker makes that state visible instead of a
# bare shell backtrace, on both success and failure.
COMPLETED_STEPS=()
mark_step() { COMPLETED_STEPS+=("$1"); }
report_on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "" >&2
    echo "==> RELEASE ABORTED (exit $code)" >&2
    if [ "${#COMPLETED_STEPS[@]}" -gt 0 ]; then
      echo "    Completed: ${COMPLETED_STEPS[*]}" >&2
    else
      echo "    Completed: (nothing)" >&2
    fi
    echo "    Re-run this script with the SAME bump argument — it detects an" >&2
    echo "    already-bumped, not-yet-tagged HEAD and resumes from there" >&2
    echo "    instead of bumping the version again." >&2
  fi
}
trap report_on_exit EXIT

# Retry a command with exponential backoff. The VPS's password-SSH endpoint
# rate-limits under load (the 2026-08-09 incident: a single scp refusal
# aborted the whole release via `set -e`, before the git tag). A transient
# auth/network refusal must not sink an otherwise-complete release — retry a
# bounded number of times before giving up for real.
retry_with_backoff() {
  local desc="$1"; shift
  local max_attempts=5
  local delay=5
  local attempt=1
  until "$@"; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "    !! $desc failed after $max_attempts attempts — giving up." >&2
      return 1
    fi
    echo "    !! $desc failed (attempt $attempt/$max_attempts) — retrying in ${delay}s..." >&2
    sleep "$delay"
    delay=$(( delay * 2 ))
    attempt=$(( attempt + 1 ))
  done
  return 0
}

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
mark_step "clean-tree-gate"

# --- Idempotent resume ---------------------------------------------------
# If HEAD is already an uncommitted-nothing-left "Release vX.Y.Z" commit for
# the version currently sitting in package.json, AND that version has no git
# tag yet, this is a re-run after a previous attempt died between the commit
# and the tag (upload failure, network blip, ctrl-c). Re-bumping here would
# silently mint vX.Y.Z+1 on top of an already-real, already-committed
# vX.Y.Z that never got tagged or published — the exact "scary to re-run"
# state the 2026-08-09 incident left behind. Detect it and resume instead.
CURRENT_PKG_VERSION="$(node -p "require('$APP_DIR/package.json').version")"
LAST_COMMIT_MSG="$(git -C "$REPO_ROOT" log -1 --pretty=%s 2>/dev/null || echo "")"
if [ "$LAST_COMMIT_MSG" = "Release v$CURRENT_PKG_VERSION" ] \
   && ! git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/v$CURRENT_PKG_VERSION" >/dev/null; then
  VERSION="$CURRENT_PKG_VERSION"
  echo "==> Resuming an unfinished release: HEAD is already 'Release v$VERSION' with no v$VERSION tag."
  echo "    Skipping the version bump — reusing v$VERSION. (To start a NEW release instead, bump/tag this one manually first.)"
  mark_step "version-bump(resumed v$VERSION)"
else

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
mark_step "version-bump(v$VERSION)"
fi

echo "==> Building self-contained SEA binaries (Node-free install path)"
# build:sea needs dist-sea/klauro-sea-entry.cjs, which `npm run build` writes.
# Run build once here so build:sea has an entry bundle; pack:tarball rebuilds
# it again below (same commit, deterministic) without touching dist-sea/*.blob
# or dist-sea/manifest.json, which write-release-manifest.mjs reads afterward.
npm run build >/dev/null
npm run build:sea
test -f ./dist-sea/manifest.json || { echo "ERROR: dist-sea/manifest.json not produced — SEA binaries did not build."; exit 1; }
SEA_BIN_COUNT="$(node -p "require('./dist-sea/manifest.json').targets.length")"
echo "    built $SEA_BIN_COUNT platform binaries"
mark_step "build-sea"

echo "==> Packing tarball (build + npm pack + latest.json)"
npm run pack:tarball >/dev/null
test -f ./.pack/klauro-latest.tgz || { echo "ERROR: tarball not produced"; exit 1; }
test -f ./.pack/latest.json       || { echo "ERROR: latest.json not produced"; exit 1; }
mark_step "pack-tarball"

# The binaries must have made it into latest.json (write-release-manifest.mjs
# folds dist-sea/manifest.json in as a nested `binaries` map + flat
# bin_<platform>_path/_sha256 fields — see that script's header comment for
# why both shapes exist). Fail loud here rather than silently uploading a
# tarball-only manifest that leaves install.sh's binary path unreachable.
MANIFEST_BIN_COUNT="$(node -p "Object.keys(require('./.pack/latest.json').binaries || {}).length")"
if [ "$MANIFEST_BIN_COUNT" != "$SEA_BIN_COUNT" ]; then
  echo "ERROR: latest.json carries $MANIFEST_BIN_COUNT binary entries, expected $SEA_BIN_COUNT. Refusing to upload a manifest that strands the binary install path." >&2
  exit 1
fi
echo "    latest.json carries $MANIFEST_BIN_COUNT platform binaries"

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
mark_step "pack-verified(freshness+identity)"

if [ "${RELEASE_SKIP_UPLOAD:-0}" = "1" ]; then
  echo "==> RELEASE_SKIP_UPLOAD=1 — skipping VPS upload"
else
  # Load VPS creds from the repo-root .env (never committed).
  if [ -f "$REPO_ROOT/.env" ]; then set -a; . "$REPO_ROOT/.env"; set +a; fi
  if [ -z "${VPS_HOST:-}" ] || [ -z "${VPS_USER:-}" ] || [ -z "${VPS_PASSWORD:-}" ]; then
    echo "    VPS creds missing (VPS_HOST/VPS_USER/VPS_PASSWORD) — skipping upload."
    echo "    Upload manually: scp .pack/klauro-latest.tgz .pack/latest.json <user>@<host>:/opt/klauro/downloads/"
  else
    # Each platform binary plus its detached .sha256 (install.sh verifies the
    # download against the sha256 latest.json advertises, but a .sha256 file
    # alongside the binary lets a human/CI verify independently of the manifest).
    SEA_BIN_FILES="$(node -p "require('./dist-sea/manifest.json').targets.map(t => './dist-sea/' + t.file).join(' ')")"
    SEA_SHA_FILES="$(node -p "require('./dist-sea/manifest.json').targets.map(t => './dist-sea/' + t.file + '.sha256').join(' ')")"
    echo "==> Uploading tarball + latest.json + $SEA_BIN_COUNT SEA binaries to $VPS_HOST:/opt/klauro/downloads/"
    # ControlMaster multiplexing, mirroring deploy.sh (which has never hit the
    # 2026-08-09 upload failure precisely because of this). The VPS has NO
    # fail2ban and NO explicit sshd limits — verified — so the refusals were
    # sshd's DEFAULT `MaxStartups 10:30:100`: past 10 concurrent UNAUTHENTICATED
    # connections, new ones are dropped with rising probability, which sshpass
    # surfaces as "Permission denied, please try again". A fleet of parallel
    # agent lanes each opening its own connection exceeds 10 easily. Reusing one
    # authenticated connection for every step removes the cause rather than
    # raising a server-side DoS guard. retry_with_backoff below still covers
    # genuinely transient network faults.
    SSHOPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=20 -o ControlMaster=auto -o ControlPath=/tmp/klauro-rel-%C -o ControlPersist=180"
    # shellcheck disable=SC2086  # SEA_BIN_FILES/SEA_SHA_FILES are intentionally
    # word-split: each is a space-separated list of relative paths with no
    # spaces of its own (filenames are generated, not user input).
    upload_scp() {
      sshpass -p "$VPS_PASSWORD" scp $SSHOPTS \
        ./.pack/klauro-latest.tgz ./.pack/latest.json \
        $SEA_BIN_FILES $SEA_SHA_FILES \
        "$VPS_USER@$VPS_HOST:/opt/klauro/downloads/"
    }
    if ! retry_with_backoff "VPS upload (scp)" upload_scp; then
      echo "ERROR: upload failed after retries. Artifacts are NOT live; the release is NOT tagged." >&2
      echo "       Re-run this script once the transient issue clears — it will resume from here," >&2
      echo "       not re-bump the version (see the idempotent-resume check above)." >&2
      exit 1
    fi
    mark_step "upload(scp)"
    upload_versioned_copy() {
      sshpass -p "$VPS_PASSWORD" ssh $SSHOPTS "$VPS_USER@$VPS_HOST" \
        "cp /opt/klauro/downloads/klauro-latest.tgz /opt/klauro/downloads/klauro-${VERSION}.tgz"
    }
    if ! retry_with_backoff "VPS versioned-copy (ssh)" upload_versioned_copy; then
      echo "ERROR: versioned-copy failed after retries. The latest tarball IS uploaded, but the" >&2
      echo "       archival klauro-${VERSION}.tgz copy is not. Re-run this script to retry just this." >&2
      exit 1
    fi
    mark_step "upload(versioned-copy)"
    echo "==> Verifying the LIVE distribution channel (not just the upload)"
    # A green /health does NOT mean the distribution channel works: the api serves
    # /dist/* from a mounted downloads dir, and a missing mount silently yields
    # tarball-404 + version:null. So verify what clients actually hit, and FAIL LOUD.
    # This whole check is retried too — the upload succeeding does not mean a
    # transient read-side blip (CDN/edge cache, brief container restart) can't
    # produce one false-negative fetch, and a genuinely successful upload should
    # not be reported as a broken distribution channel over that kind of flake.
    check_live_distribution() {
      HOSTED="$(curl -fsS "https://mcp.klauro.com/dist/latest.json" | node -p "JSON.parse(require('fs').readFileSync(0)).version" 2>/dev/null || echo unknown)"
      TARBALL_CODE="$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "https://mcp.klauro.com/dist/klauro-latest.tgz" 2>/dev/null || echo 000)"
      # shellcheck source=verify-distribution-channel.sh
      . "$(cd "$(dirname "$0")" && pwd)/verify-distribution-channel.sh"
      verify_distribution_channel "$HOSTED" "$VERSION" "$TARBALL_CODE"
    }
    if retry_with_backoff "live distribution channel check" check_live_distribution; then
      echo "    hosted latest.json version: $HOSTED ; tarball HTTP: $TARBALL_CODE"
      echo "    OK — clients will see $VERSION + download the tarball on 'klauro update'"
    else
      echo "    hosted latest.json version: $HOSTED ; tarball HTTP: $TARBALL_CODE"
      echo "    !! DISTRIBUTION CHANNEL BROKEN: version=$HOSTED (want $VERSION), tarball=$TARBALL_CODE (want 200)." >&2
      echo "    !! Common cause: the api container is missing the '/opt/klauro/downloads' volume mount" >&2
      echo "    !! (the deploy rsyncs docker-compose.yml — ensure it keeps the downloads mount)." >&2
      echo "    !! Tarball uploaded fine, but clients can't fetch it. FIX before announcing the release." >&2
      exit 1
    fi
    mark_step "verify-live-manifest"

    # Same check, per platform binary — this is the path install.sh actually
    # uses (the tarball is the npm-fallback path only). 200 and 206 both mean
    # "reachable" (see verify-distribution-channel.sh's header on why -r 0-0
    # legitimately gets 206 from a range-honoring server).
    echo "==> Verifying each SEA binary is reachable"
    BIN_CHECK_FAILED=0
    for bin_file in $(node -p "require('./dist-sea/manifest.json').targets.map(t => t.file).join(' ')"); do
      BIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "https://mcp.klauro.com/dist/${bin_file}" 2>/dev/null || echo 000)"
      echo "    ${bin_file}: HTTP ${BIN_CODE}"
      case "$BIN_CODE" in
        200|206) ;;
        *) BIN_CHECK_FAILED=1 ;;
      esac
    done
    if [ "$BIN_CHECK_FAILED" = "1" ]; then
      echo "    !! One or more SEA binaries are NOT reachable at /dist/. install.sh's primary" >&2
      echo "    !! path will fail and fall back to the npm/Node path for that platform." >&2
      exit 1
    fi
    echo "    OK — all $SEA_BIN_COUNT platform binaries reachable"
    mark_step "verify-live-binaries"
  fi
fi

echo "==> Tagging v$VERSION"
cd "$REPO_ROOT"
git tag -a "v$VERSION" -m "klauro v$VERSION" 2>/dev/null && echo "    tagged v$VERSION" || echo "    tag v$VERSION already exists"
mark_step "tag(v$VERSION)"

echo "==> Done. v$VERSION released."
