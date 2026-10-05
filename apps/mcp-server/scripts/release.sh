#!/usr/bin/env bash
set -euo pipefail

BUMP="${1:-patch}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
cd "$APP_DIR"

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
  const lock = "./package-lock.json";
  if (fs.existsSync(lock)) {
    const l = JSON.parse(fs.readFileSync(lock, "utf8"));
    l.version = next;
    if (l.packages && l.packages[""]) l.packages[""].version = next;
    fs.writeFileSync(lock, JSON.stringify(l, null, 2) + "\n");
  }
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

echo "==> Committing version bump v$VERSION"
cd "$REPO_ROOT"
git add apps/mcp-server/package.json apps/mcp-server/package-lock.json package-lock.json
git commit -q -m "Release v$VERSION" || echo "    (nothing to commit — version already staged/committed)"
cd "$APP_DIR"
mark_step "version-bump(v$VERSION)"
fi

if [ -f "$REPO_ROOT/.env" ]; then set -a; . "$REPO_ROOT/.env"; set +a; fi
if [ -z "${VPS_HOST:-}" ] || [ -z "${VPS_USER:-}" ] || [ -z "${VPS_PASSWORD:-}" ]; then
  echo "ERROR: VPS_HOST, VPS_USER, and VPS_PASSWORD are required for source-exact remote release builds." >&2
  exit 1
fi
command -v sshpass >/dev/null || { echo "ERROR: sshpass is required." >&2; exit 1; }

RELEASE_SHA_FULL="$(git -C "$REPO_ROOT" rev-parse HEAD)"
RELEASE_SHA="$(git -C "$REPO_ROOT" rev-parse --short=12 "$RELEASE_SHA_FULL")"
echo "==> Staging release $VERSION+$RELEASE_SHA on the VPS"
bash "$REPO_ROOT/infrastructure/vps/sync-gate-candidate.sh" --commit "$RELEASE_SHA_FULL"

export SSHPASS="$VPS_PASSWORD"
SSHOPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=20 -o ControlMaster=auto -o ControlPath=/tmp/klauro-cm-%C -o ControlPersist=900"
SSH="sshpass -e ssh $SSHOPTS"
DEST="$VPS_USER@$VPS_HOST"

echo "==> Building and verifying release artifacts on the VPS"
$SSH "$DEST" "cd /opt/klauro/devgate && KLAURO_GIT_SHA=$RELEASE_SHA_FULL GATE_TIMEOUT_S=3600 bash infrastructure/vps/gate.sh --allow-source-mismatch --run-as-root apps/mcp-server 'KLAURO_RELEASE_VERSION=$VERSION KLAURO_RELEASE_SHA=$RELEASE_SHA_FULL bash scripts/prove-release-candidate.sh'"
mark_step "remote-build-and-verification"

if [ "${RELEASE_SKIP_UPLOAD:-0}" = "1" ]; then
  echo "==> RELEASE_SKIP_UPLOAD=1 — verified artifacts remain in /opt/klauro/devgate/apps/mcp-server"
else
  echo "==> Publishing verified artifacts from the VPS candidate"
  $SSH "$DEST" "mkdir -p /opt/klauro/downloads && docker run --rm -e KLAURO_RELEASE_VERSION=$VERSION -e KLAURO_RELEASE_SHA=$RELEASE_SHA_FULL -v /opt/klauro/devgate:/gate -v /opt/klauro/downloads:/downloads -w /gate/apps/mcp-server klauro-gate node scripts/publish-release-artifacts.mjs /downloads"
  mark_step "publish"

  check_live_distribution() {
    LIVE_MANIFEST="$(curl -fsS "https://mcp.klauro.com/dist/latest.json")"
    HOSTED="$(printf '%s' "$LIVE_MANIFEST" | node -p "JSON.parse(require('fs').readFileSync(0)).version")"
    HOSTED_SHA="$(printf '%s' "$LIVE_MANIFEST" | node -p "JSON.parse(require('fs').readFileSync(0)).git_sha")"
    HOSTED_TARBALL_SHA="$(printf '%s' "$LIVE_MANIFEST" | node -p "JSON.parse(require('fs').readFileSync(0)).tarball_sha256")"
    TARBALL_CODE="$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "https://mcp.klauro.com/dist/klauro-latest.tgz" 2>/dev/null || echo 000)"
    ACTUAL_TARBALL_SHA="$(curl -fsS "https://mcp.klauro.com/dist/klauro-latest.tgz" | node -e "const c=require('crypto'),b=[];process.stdin.on('data',x=>b.push(x)).on('end',()=>process.stdout.write(c.createHash('sha256').update(Buffer.concat(b)).digest('hex')))" )"
    . "$APP_DIR/scripts/verify-distribution-channel.sh"
    verify_distribution_channel "$HOSTED" "$VERSION" "$TARBALL_CODE"
    [ "$HOSTED_SHA" = "$RELEASE_SHA_FULL" ]
    [ "$HOSTED_TARBALL_SHA" = "$ACTUAL_TARBALL_SHA" ]
  }
  retry_with_backoff "live distribution channel check" check_live_distribution || {
    echo "ERROR: live distribution identity or tarball digest does not match $VERSION+$RELEASE_SHA_FULL." >&2
    exit 1
  }

  BIN_FILES="$($SSH "$DEST" "docker run --rm -v /opt/klauro/devgate:/gate -w /gate/apps/mcp-server klauro-gate node -p \"require('./dist-sea/manifest.json').targets.map(target => target.file).join(' ')\"")"
  for bin_file in $BIN_FILES; do
    BIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 "https://mcp.klauro.com/dist/${bin_file}" 2>/dev/null || echo 000)"
    case "$BIN_CODE" in
      200|206) ;;
      *) echo "ERROR: published native binary $bin_file returned HTTP $BIN_CODE." >&2; exit 1 ;;
    esac
  done
  mark_step "verify-live-artifacts"
fi

$SSH "$DEST" "docker run --rm -e KLAURO_RELEASE_VERSION=$VERSION -e KLAURO_RELEASE_SHA=$RELEASE_SHA_FULL -v /opt/klauro/devgate:/gate -w /gate/apps/mcp-server klauro-gate node scripts/release-proof-receipt.mjs verify"

echo "==> Tagging v$VERSION"
cd "$REPO_ROOT"
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  TAG_SHA="$(git rev-list -n 1 "v$VERSION")"
  [ "$TAG_SHA" = "$RELEASE_SHA_FULL" ] || { echo "ERROR: existing v$VERSION tag points to $TAG_SHA, not $RELEASE_SHA_FULL." >&2; exit 1; }
  echo "    tag v$VERSION already exists at the verified release commit"
else
  git tag -a "v$VERSION" -m "klauro v$VERSION"
  echo "    tagged v$VERSION"
fi
mark_step "tag(v$VERSION)"

echo "==> Rebuilding the local entry point bundle"
if (cd "$APP_DIR" && node scripts/build-bundle.mjs >/dev/null); then
  mark_step "local-bundle(v$VERSION)"
else
  echo "    WARNING: local bundle rebuild failed; run \`npm run build\` in apps/mcp-server before using dist/index.cjs." >&2
fi

echo "==> Done. v$VERSION released."
