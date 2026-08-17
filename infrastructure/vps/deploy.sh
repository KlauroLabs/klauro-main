#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_DIR"

KLAURO_URL="${KLAURO_URL:-https://mcp.klauro.com}"
WITH_RELEASE=""
SKIP_APP_BUILD=0
DO_VERIFY=1
ALLOW_DIRTY=0
ALLOW_DETACHED=0

for arg in "$@"; do
  case "$arg" in
    --with-release)        WITH_RELEASE="patch" ;;
    --with-release=*)      WITH_RELEASE="${arg#*=}" ;;
    --skip-app-build)      SKIP_APP_BUILD=1 ;;
    --no-verify)           DO_VERIFY=0 ;;
    --allow-dirty)         ALLOW_DIRTY=1 ;;
    --allow-detached)      ALLOW_DETACHED=1 ;;
    -h|--help)
      sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)"; exit 2 ;;
  esac
done

DIRTY_DEPLOY=0
SNAPSHOT_SHA=""
if [ "$ALLOW_DIRTY" != "1" ]; then
  DIRTY="$(git -C "$APP_DIR" status --porcelain -uall 2>/dev/null || true)"
  if [ -n "$DIRTY" ]; then
    echo "NOTE: the working tree is dirty; these changes are NOT in this deploy." >&2
    echo "      Shipping the tree of $(git -C "$APP_DIR" rev-parse --short=12 HEAD) instead (safe by construction)." >&2
    echo "" >&2
    echo "$DIRTY" | sed 's/^/        /' >&2
    echo "" >&2
    echo "      Commit and re-deploy when you want the above live." >&2
  fi
fi

if [ "$ALLOW_DIRTY" = "1" ]; then
  DIRTY="$(git -C "$APP_DIR" status --porcelain -uall 2>/dev/null || true)"
  if [ -n "$DIRTY" ]; then
    DIRTY_DEPLOY=1
    if ! git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1; then
      echo "ERROR: --allow-dirty needs a git repo to snapshot the tree into; refusing an untraceable build." >&2
      exit 1
    fi
    SNAPSHOT_INDEX="$(mktemp -t klauro-deploy-snapshot-index)"
    if ! SNAPSHOT_SHA="$(
      cd "$APP_DIR" &&
      GIT_INDEX_FILE="$SNAPSHOT_INDEX" git read-tree HEAD &&
      GIT_INDEX_FILE="$SNAPSHOT_INDEX" git add -A &&
      SNAPSHOT_TREE="$(GIT_INDEX_FILE="$SNAPSHOT_INDEX" git write-tree)" &&
      git commit-tree "$SNAPSHOT_TREE" -p HEAD \
        -m "deploy snapshot: uncommitted tree shipped by deploy.sh --allow-dirty at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    )"; then
      rm -f "$SNAPSHOT_INDEX"
      echo "ERROR: could not snapshot the dirty tree into a commit; refusing an untraceable build." >&2
      exit 1
    fi
    rm -f "$SNAPSHOT_INDEX"
    SNAPSHOT_SHA="$(git -C "$APP_DIR" rev-parse --short=12 "$SNAPSHOT_SHA")"
    echo "==> DIRTY deploy: working tree snapshotted as $SNAPSHOT_SHA (reproduce with: git checkout $SNAPSHOT_SHA)" >&2
  fi
fi

DEPLOY_SHA_FULL="$(git -C "$APP_DIR" rev-parse HEAD)"
if [ "$DIRTY_DEPLOY" = "1" ]; then
  DEPLOY_SHA_FULL="$(git -C "$APP_DIR" rev-parse "$SNAPSHOT_SHA")"
fi

REACHABLE_BRANCH=""
while IFS= read -r branch; do
  [ -z "$branch" ] && continue
  if git -C "$APP_DIR" merge-base --is-ancestor "$DEPLOY_SHA_FULL" "$branch" 2>/dev/null; then
    REACHABLE_BRANCH="$branch"
    break
  fi
done < <(git -C "$APP_DIR" for-each-ref --format='%(refname:short)' refs/heads/)

if [ -z "$REACHABLE_BRANCH" ]; then
  if [ "$ALLOW_DETACHED" != "1" ]; then
    echo "ERROR: refusing to deploy $DEPLOY_SHA_FULL — it is not reachable from any local" >&2
    echo "       branch, so it would decouple production from master with no ref keeping it" >&2
    echo "       alive (a git-gc candidate the moment this worktree/checkout goes away)." >&2
    echo "" >&2
    echo "       This is usually a detached \`git worktree add --detach\` checkout, or a" >&2
    echo "       commit made without checking out a branch first." >&2
    echo "" >&2
    echo "       Fix: check out or fast-forward a real branch onto this commit, then re-run." >&2
    echo "       To deploy a deliberate detached snapshot anyway: --allow-detached (this" >&2
    echo "       automatically creates a local branch ref at the deploy sha so it can never" >&2
    echo "       become an orphaned, unreproducible commit)." >&2
    exit 1
  fi
  SNAPSHOT_BRANCH="deploy-snapshot/$(git -C "$APP_DIR" rev-parse --short=12 "$DEPLOY_SHA_FULL")-$(date -u +%Y%m%dT%H%M%SZ)"
  git -C "$APP_DIR" branch "$SNAPSHOT_BRANCH" "$DEPLOY_SHA_FULL"
  echo "==> --allow-detached: $DEPLOY_SHA_FULL was reachable from no branch — created local branch '$SNAPSHOT_BRANCH' at it so it cannot be lost." >&2
  REACHABLE_BRANCH="$SNAPSHOT_BRANCH"
fi
echo "==> Deploy sha $DEPLOY_SHA_FULL is reachable from branch '$REACHABLE_BRANCH'." >&2

echo "==> Checking spec/source purity (evidence-derived forbidden-name gate — see spec-purity-gate.ts)"
if ! ( cd "$APP_DIR/apps/mcp-server" && npx tsx src/spec-purity-gate-cli.ts "$APP_DIR" ); then
  exit 1
fi

echo "==> Checking file-size ratchet (no tracked file may grow — see file-size-ratchet-gate.ts)"
if ! ( cd "$APP_DIR/apps/mcp-server" && npx tsx src/file-size-ratchet-gate-cli.ts "$APP_DIR" ); then
  exit 1
fi

if [ -f "$APP_DIR/.env" ]; then set -a; . "$APP_DIR/.env"; set +a; fi
if [ -z "${VPS_HOST:-}" ] || [ -z "${VPS_USER:-}" ] || [ -z "${VPS_PASSWORD:-}" ]; then
  echo "ERROR: VPS_HOST/VPS_USER/VPS_PASSWORD missing (repo-root .env). Cannot deploy." >&2
  exit 1
fi
command -v sshpass >/dev/null || { echo "ERROR: sshpass not installed." >&2; exit 1; }
CM_OPTS="-o ControlMaster=auto -o ControlPath=/tmp/klauro-cm-%C -o ControlPersist=120"
export SSHPASS="$VPS_PASSWORD"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=25 $CM_OPTS"
DEST="$VPS_USER@$VPS_HOST"
SOURCE_SYNC_EXCLUDES=(
  --exclude node_modules
  --exclude dist
  --exclude .git
  --exclude .pack
  --exclude logs
  --exclude docs.zip
  --exclude .claude/worktrees
  --exclude '.klauro-*'
  --exclude .customer-package
)

if [ -n "$WITH_RELEASE" ]; then
  echo "==> Cutting release ($WITH_RELEASE) before deploy"
  bash "$APP_DIR/apps/mcp-server/scripts/release.sh" "$WITH_RELEASE"
fi

if ! grep -q '/opt/klauro/downloads' "$APP_DIR/infrastructure/vps/docker-compose.yml"; then
  echo "ERROR: docker-compose.yml is missing the /opt/klauro/downloads mount." >&2
  echo "       Deploying it would break the install/update distribution channel. Aborting." >&2
  exit 1
fi

if [ "$SKIP_APP_BUILD" = "0" ]; then
  echo "==> Building app with VITE_KLAURO_API_URL=$KLAURO_URL"
  VITE_KLAURO_API_URL="$KLAURO_URL" npm run app:build
else
  echo "==> --skip-app-build: reusing existing apps/app/dist"
  test -d "$APP_DIR/apps/app/dist" || { echo "ERROR: apps/app/dist not found." >&2; exit 1; }
fi

DEPLOY_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/klauro-deploy-stage.XXXXXX")"
chmod 755 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
echo "==> Exporting $(git -C "$APP_DIR" rev-parse --short=12 HEAD) to a staging dir (not the live tree)"
git -C "$APP_DIR" archive --format=tar "$DEPLOY_SHA" | tar -x -C "$STAGE"
STAGED_FILES="$(find "$STAGE" -type f | wc -l | tr -d ' ')"
echo "    staged $STAGED_FILES file(s) from the commit"

echo "==> Syncing app-dist"
rsync -az --delete -e "$SSH" apps/app/dist/ "$DEST:/opt/klauro/app-dist/"
echo "==> Syncing source (excluding heavy/generated dirs)"
rsync -az --delete-delay "${SOURCE_SYNC_EXCLUDES[@]}" -e "$SSH" "$STAGE/" "$DEST:/opt/klauro/source/"
echo "==> Syncing remote gate source to the identical deployment snapshot"
rsync -az --delete-delay "${SOURCE_SYNC_EXCLUDES[@]}" -e "$SSH" "$STAGE/" "$DEST:/opt/klauro/devgate/"
echo "==> Syncing Caddyfile + docker-compose.yml"
rsync -az -e "$SSH" infrastructure/vps/Caddyfile "$DEST:/opt/klauro/Caddyfile"
rsync -az -e "$SSH" infrastructure/vps/docker-compose.yml "$DEST:/opt/klauro/docker-compose.yml"

GIT_SHA="$(git -C "$APP_DIR" rev-parse --short=12 HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$DIRTY_DEPLOY" = "1" ]; then
  echo "==> Stamping build identity (DIRTY: snapshot $SNAPSHOT_SHA on top of $GIT_SHA @ $BUILD_TIME)"
  $SSH "$DEST" "cat > /opt/klauro/source/apps/mcp-server/.klauro-build-stamp.json" <<STAMP
{"git_sha": "$GIT_SHA", "build_time": "$BUILD_TIME", "dirty": true, "snapshot_sha": "$SNAPSHOT_SHA"}
STAMP
else
  echo "==> Stamping build identity ($GIT_SHA @ $BUILD_TIME)"
  $SSH "$DEST" "cat > /opt/klauro/source/apps/mcp-server/.klauro-build-stamp.json" <<STAMP
{"git_sha": "$GIT_SHA", "build_time": "$BUILD_TIME"}
STAMP
fi

echo "==> Rebuilding + restarting containers on $VPS_HOST"
$SSH "$DEST" "cd /opt/klauro && KLAURO_GIT_SHA='$GIT_SHA' KLAURO_BUILD_TIME='$BUILD_TIME' docker compose up -d --build --remove-orphans"
$SSH "$DEST" "docker image rm klauro-gate >/dev/null 2>&1 || true"

echo "==> Waiting for api container health, then restarting caddy (defect #24 guard)"
API_HEALTHY=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  STATUS="$($SSH "$DEST" 'docker inspect -f "{{.State.Health.Status}}" klauro-api-1 2>/dev/null' || echo "")"
  if [ "$STATUS" = "healthy" ]; then API_HEALTHY=1; break; fi
  echo "    (api health: ${STATUS:-unknown}, retry $i/12)"; sleep 5
done
if [ "$API_HEALTHY" = "1" ]; then
  $SSH "$DEST" 'cd /opt/klauro && docker compose restart caddy'
else
  echo "    !! api never reported healthy — restarting caddy anyway is pointless, skipping." >&2
  echo "    !! Check 'docker compose logs api' on the VPS; the smoke/verify steps below will fail loud." >&2
fi

if [ "$DO_VERIFY" = "0" ]; then
  echo "==> --no-verify: skipping post-deploy checks. Done."
  exit 0
fi

echo "==> Verifying live surfaces at $KLAURO_URL"
HEALTH=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  HEALTH="$(curl -fsS -m 10 "$KLAURO_URL/health" 2>/dev/null || echo "")"
  [ -n "$HEALTH" ] && break
  echo "    (api not ready, retry $i/10)"; sleep 5
done
if [ -z "$HEALTH" ]; then
  echo "    !! /health never came up. Deploy may have failed — check 'docker compose logs api' on the VPS." >&2
  exit 1
fi
echo "    health: $HEALTH"

DIST_VER="$(curl -fsS -m 10 "$KLAURO_URL/dist/latest.json" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0)).version" 2>/dev/null || echo unknown)"
TARBALL_CODE="$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 -m 10 "$KLAURO_URL/dist/klauro-latest.tgz" 2>/dev/null || echo 000)"
LOCAL_VER="$(node -p "require('$APP_DIR/apps/mcp-server/package.json').version")"
echo "    dist latest.json: $DIST_VER ; tarball HTTP: $TARBALL_CODE ; local package.json: $LOCAL_VER"

if [ "$TARBALL_CODE" != "200" ] && [ "$TARBALL_CODE" != "206" ]; then
  echo "    !! Distribution channel broken: tarball HTTP $TARBALL_CODE (want 200/206)." >&2
  echo "    !! Common cause: api container missing the /opt/klauro/downloads mount." >&2
  exit 1
fi
if [ -n "$WITH_RELEASE" ] && [ "$DIST_VER" != "$LOCAL_VER" ]; then
  echo "    !! Released $LOCAL_VER but hosted /dist reports $DIST_VER — upload/mount mismatch." >&2
  exit 1
fi
if [ -z "$WITH_RELEASE" ] && [ "$DIST_VER" != "$LOCAL_VER" ]; then
  echo "    !! Client-channel skew: deploying server $LOCAL_VER but /dist still publishes CLI $DIST_VER." >&2
  echo "    !! Installed clients keep the OLD client contract; if this deploy tightens one (e.g. the" >&2
  echo "    !! analysis protocol version), every installed CLI is rejected with nothing to upgrade to." >&2
  echo "    !! Fix: cut a release first (apps/mcp-server/scripts/release.sh), then deploy," >&2
  echo "    !! or re-run with DEPLOY_ALLOW_CLIENT_SKEW=1 if you have verified the contract is unchanged." >&2
  [ "${DEPLOY_ALLOW_CLIENT_SKEW:-0}" = "1" ] || exit 1
  echo "    (DEPLOY_ALLOW_CLIENT_SKEW=1 — continuing with a known client/server version skew)"
fi

echo "==> Smoke: running one real analysis inside the api container"
rsync -az -e "$SSH" "$APP_DIR/infrastructure/vps/analysis-smoke.mjs" "$DEST:/opt/klauro/analysis-smoke.mjs"
if ! $SSH "$DEST" '
  set -e
  docker cp /opt/klauro/analysis-smoke.mjs klauro-api-1:/tmp/analysis-smoke.mjs >/dev/null
  docker exec -e KLAURO_AI_INTERPRETATION=false -w /app/apps/mcp-server klauro-api-1 \
    npx tsx /tmp/analysis-smoke.mjs
'; then
  echo "    !! ANALYSIS SMOKE FAILED — the deployed analyzer cannot complete an analysis." >&2
  echo "    !! /health is green but the product is BROKEN. Do not leave this deployed." >&2
  echo "    !! Most likely a torn/partial sync (deploy ships the working tree) or a real" >&2
  echo "    !! runtime bug in the analysis path. Check 'docker logs klauro-api-1'." >&2
  exit 1
fi

echo "==> Applying Docker artifact retention"
$SSH "$DEST" '
  set -e
  docker image prune -f >/dev/null
  docker builder prune -af --keep-storage 20GB >/dev/null
'

echo "==> Deploy verified. $KLAURO_URL is live (dist $DIST_VER)."
