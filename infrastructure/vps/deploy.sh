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

if [ -n "$WITH_RELEASE" ]; then
  echo "==> Cutting release ($WITH_RELEASE) before selecting the deployment commit"
  bash "$APP_DIR/apps/mcp-server/scripts/release.sh" "$WITH_RELEASE"
fi

DIRTY_DEPLOY=0
SNAPSHOT_SHA=""
DIRTY="$(git -C "$APP_DIR" status --porcelain -uall 2>/dev/null || true)"
if [ "$ALLOW_DIRTY" != "1" ] && [ -n "$DIRTY" ]; then
  echo "ERROR: refusing to deploy from a dirty working tree." >&2
  echo "$DIRTY" | sed 's/^/       /' >&2
  echo "       Commit the candidate or use --allow-dirty to create a traceable snapshot." >&2
  exit 1
fi

if [ "$ALLOW_DIRTY" = "1" ]; then
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
if [ "$DIRTY_DEPLOY" = "1" ]; then
  REACHABLE_BRANCH="deploy-snapshot/$(git -C "$APP_DIR" rev-parse --short=12 "$DEPLOY_SHA_FULL")-$(date -u +%Y%m%dT%H%M%SZ)"
  git -C "$APP_DIR" branch "$REACHABLE_BRANCH" "$DEPLOY_SHA_FULL"
fi
while IFS= read -r branch; do
  [ -n "$REACHABLE_BRANCH" ] && break
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
  --exclude .claude
  --exclude .proof-output
  --exclude '.klauro-*'
  --exclude .customer-package
  --exclude .gstack
  --exclude .remote-edit
  --exclude .agents
)

if ! git -C "$APP_DIR" show "$DEPLOY_SHA_FULL:infrastructure/vps/docker-compose.yml" | grep -q '/opt/klauro/downloads'; then
  echo "ERROR: docker-compose.yml is missing the /opt/klauro/downloads mount." >&2
  echo "       Deploying it would break the install/update distribution channel. Aborting." >&2
  exit 1
fi

echo "==> Compose memory lint against the VPS host"
HOST_MEM_MIB="$($SSH "$DEST" "awk '/MemTotal/{print int(\$2/1024)}' /proc/meminfo" 2>/dev/null || echo 0)"
if ! git -C "$APP_DIR" show "$DEPLOY_SHA_FULL:infrastructure/vps/docker-compose.yml" | HOST_MEM_MIB="$HOST_MEM_MIB" node -e '
  const text = require("fs").readFileSync(0, "utf8");
  const hostMib = Number(process.env.HOST_MEM_MIB) || 0;
  const reserveMib = 972;
  const services = {};
  let current = null;
  let section = null;
  for (const line of text.split("\n")) {
    const top = line.match(/^([a-z][a-z0-9_-]*):/);
    if (top) { section = top[1]; current = null; continue; }
    if (section !== "services") continue;
    const service = line.match(/^  ([a-z][a-z0-9-]*):\s*$/);
    if (service) { current = service[1]; services[current] = { limit: 0, heaps: [] }; continue; }
    if (!current) continue;
    const limit = line.match(/^\s+mem_limit:\s*(\d+)m\s*$/);
    if (limit) services[current].limit = Number(limit[1]);
    const heap = line.match(/--max-old-space-size=(\d+)/) || line.match(/KLAURO_ANALYSIS_HEAP_MB:\s*"?(\d+)"?/);
    if (heap) services[current].heaps.push(Number(heap[1]));
  }
  const failures = [];
  let sum = 0;
  for (const [name, spec] of Object.entries(services)) {
    if (!spec.limit) failures.push(`${name}: no mem_limit`);
    sum += spec.limit;
    const headroom = Math.max(256, Math.floor(spec.limit / 4));
    for (const heap of spec.heaps) if (heap > spec.limit - headroom) failures.push(`${name}: heap ${heap} MiB leaves under ${headroom} MiB of its ${spec.limit} MiB limit`);
  }
  if (hostMib && sum + reserveMib > hostMib) failures.push(`limits ${sum} MiB + reserve ${reserveMib} MiB exceed host ${hostMib} MiB`);
  console.log(`    compose limits: ${sum} MiB across ${Object.keys(services).length} services; host ${hostMib || "unknown"} MiB; reserve ${reserveMib} MiB`);
  if (failures.length) { for (const f of failures) console.error("    !! " + f); process.exit(1); }
'; then
  echo "ERROR: docker-compose.yml memory budget does not fit the host. Aborting." >&2
  exit 1
fi

echo "==> Staging exact deployment candidate on the VPS"
bash "$APP_DIR/infrastructure/vps/sync-gate-candidate.sh" --commit "$DEPLOY_SHA_FULL"

echo "==> Checking spec/source purity on the VPS"
$SSH "$DEST" "cd /opt/klauro/devgate && GATE_TIMEOUT_S=900 bash infrastructure/vps/gate.sh --allow-source-mismatch apps/mcp-server 'npx tsx src/spec-purity-gate-cli.ts ../..'"

echo "==> Checking file-size ratchet on the VPS"
$SSH "$DEST" "cd /opt/klauro/devgate && GATE_TIMEOUT_S=900 bash infrastructure/vps/gate.sh --allow-source-mismatch apps/mcp-server 'npx tsx src/file-size-ratchet-gate-cli.ts ../..'"

if [ "$SKIP_APP_BUILD" = "0" ]; then
  printf -v KLAURO_URL_SHELL '%q' "$KLAURO_URL"
  echo "==> Building app on the VPS with VITE_KLAURO_API_URL=$KLAURO_URL"
  $SSH "$DEST" "cd /opt/klauro/devgate && GATE_TIMEOUT_S=1800 bash infrastructure/vps/gate.sh --allow-source-mismatch --run-as-root . 'VITE_KLAURO_API_URL=$KLAURO_URL_SHELL npm run app:build'"
  $SSH "$DEST" "mkdir -p /opt/klauro/app-dist && rsync -a --delete /opt/klauro/devgate/apps/app/dist/ /opt/klauro/app-dist/"
else
  echo "==> --skip-app-build: reusing existing VPS app-dist"
  $SSH "$DEST" "test -d /opt/klauro/app-dist" || { echo "ERROR: /opt/klauro/app-dist not found on the VPS." >&2; exit 1; }
fi

DEPLOY_SHA="$DEPLOY_SHA_FULL"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/klauro-deploy-stage.XXXXXX")"
chmod 755 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
echo "==> Exporting $(git -C "$APP_DIR" rev-parse --short=12 "$DEPLOY_SHA") to a staging dir (not the live tree)"
git -C "$APP_DIR" archive --format=tar "$DEPLOY_SHA" | tar -x -C "$STAGE"
STAGED_FILES="$(find "$STAGE" -type f | wc -l | tr -d ' ')"
echo "    staged $STAGED_FILES file(s) from the commit"

echo "==> Syncing source (excluding heavy/generated dirs)"
rsync -az --delete-delay "${SOURCE_SYNC_EXCLUDES[@]}" -e "$SSH" "$STAGE/" "$DEST:/opt/klauro/source/"
echo "==> Syncing remote gate source to the identical deployment snapshot"
rsync -az --delete-delay "${SOURCE_SYNC_EXCLUDES[@]}" -e "$SSH" "$STAGE/" "$DEST:/opt/klauro/devgate/"
echo "==> Syncing Caddyfile + docker-compose.yml"
rsync -az -e "$SSH" infrastructure/vps/Caddyfile "$DEST:/opt/klauro/Caddyfile"
rsync -az -e "$SSH" infrastructure/vps/docker-compose.yml "$DEST:/opt/klauro/docker-compose.yml"

GIT_SHA="$(git -C "$APP_DIR" rev-parse --short=12 "$DEPLOY_SHA")"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$DIRTY_DEPLOY" = "1" ]; then
  BASE_GIT_SHA="$(git -C "$APP_DIR" rev-parse --short=12 HEAD)"
  echo "==> Stamping build identity (DIRTY: snapshot $GIT_SHA on top of $BASE_GIT_SHA @ $BUILD_TIME)"
  $SSH "$DEST" "cat > /opt/klauro/source/apps/mcp-server/.klauro-build-stamp.json" <<STAMP
{"git_sha": "$GIT_SHA", "build_time": "$BUILD_TIME", "dirty": true, "base_git_sha": "$BASE_GIT_SHA"}
STAMP
else
  echo "==> Stamping build identity ($GIT_SHA @ $BUILD_TIME)"
  $SSH "$DEST" "cat > /opt/klauro/source/apps/mcp-server/.klauro-build-stamp.json" <<STAMP
{"git_sha": "$GIT_SHA", "build_time": "$BUILD_TIME"}
STAMP
fi
$SSH "$DEST" "cp /opt/klauro/source/apps/mcp-server/.klauro-build-stamp.json /opt/klauro/devgate/apps/mcp-server/.klauro-build-stamp.json"

echo "==> Rebuilding + restarting containers on $VPS_HOST"
$SSH "$DEST" "install -d -m 700 /opt/klauro/data /opt/klauro/redis-data && chmod -R go-rwx /opt/klauro/data /opt/klauro/redis-data"
$SSH "$DEST" "cd /opt/klauro && KLAURO_GIT_SHA='$GIT_SHA' KLAURO_BUILD_TIME='$BUILD_TIME' docker compose up -d --build --remove-orphans"
$SSH "$DEST" "docker image rm klauro-gate >/dev/null 2>&1 || true"

echo "==> Waiting for analysis-worker container health"
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  WSTATUS="$($SSH "$DEST" 'docker inspect -f "{{.State.Health.Status}}" klauro-analysis-worker-1 2>/dev/null' || echo "")"
  if [ "$WSTATUS" = "healthy" ]; then break; fi
  echo "    (analysis-worker health: ${WSTATUS:-unknown}, retry $i/12)"; sleep 5
done
[ "$WSTATUS" = "healthy" ] || echo "    !! analysis-worker never reported healthy; api will not become healthy either." >&2

echo "==> Waiting for api container health, then restarting caddy (defect #24 guard)"
API_HEALTHY=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  STATUS="$($SSH "$DEST" 'docker inspect -f "{{.State.Health.Status}}" klauro-api-1 2>/dev/null' || echo "")"
  if [ "$STATUS" = "healthy" ]; then API_HEALTHY=1; break; fi
  echo "    (api health: ${STATUS:-unknown}, retry $i/12)"; sleep 5
done
if [ "$API_HEALTHY" = "1" ]; then
  $SSH "$DEST" 'cd /opt/klauro && docker compose restart caddy'
  CADDY_UP=0
  for i in 1 2 3 4 5 6; do
    RUNNING="$($SSH "$DEST" 'docker inspect -f "{{.State.Running}}" klauro-caddy-1 2>/dev/null' || echo "")"
    if [ "$RUNNING" = "true" ]; then CADDY_UP=1; break; fi
    echo "    (caddy running: ${RUNNING:-unknown}, retry $i/6)"; sleep 5
  done
  if [ "$CADDY_UP" = "0" ]; then
    echo "    !! caddy did not come back from the restart — bringing it up" >&2
    $SSH "$DEST" 'cd /opt/klauro && docker compose up -d caddy'
    RUNNING="$($SSH "$DEST" 'docker inspect -f "{{.State.Running}}" klauro-caddy-1 2>/dev/null' || echo "")"
    if [ "$RUNNING" != "true" ]; then
      echo "ERROR: caddy is not running, so every surface is unreachable however healthy the api is." >&2
      exit 1
    fi
    echo "    caddy is up again."
  fi
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
DIST_SHA="$(curl -fsS -m 10 "$KLAURO_URL/dist/latest.json" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0)).git_sha" 2>/dev/null || echo unknown)"
TARBALL_CODE="$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 -m 10 "$KLAURO_URL/dist/klauro-latest.tgz" 2>/dev/null || echo 000)"
LOCAL_VER="$(node -p "require('$APP_DIR/apps/mcp-server/package.json').version")"
LIVE_SHA="$(printf '%s' "$HEALTH" | node -p "JSON.parse(require('fs').readFileSync(0)).build?.git_sha || 'unknown'" 2>/dev/null || echo unknown)"
echo "    health git sha: $LIVE_SHA ; expected: $GIT_SHA"
echo "    dist latest.json: $DIST_VER+$DIST_SHA ; tarball HTTP: $TARBALL_CODE ; local package.json: $LOCAL_VER"

if [ "$LIVE_SHA" != "$GIT_SHA" ]; then
  echo "    !! Live source mismatch: health reports $LIVE_SHA, expected $GIT_SHA." >&2
  exit 1
fi
if [ "$TARBALL_CODE" != "200" ] && [ "$TARBALL_CODE" != "206" ]; then
  echo "    !! Distribution channel broken: tarball HTTP $TARBALL_CODE (want 200/206)." >&2
  echo "    !! Common cause: api container missing the /opt/klauro/downloads mount." >&2
  exit 1
fi
DIST_SHA_SHORT="${DIST_SHA:0:12}"
if [ -n "$WITH_RELEASE" ] && { [ "$DIST_VER" != "$LOCAL_VER" ] || [ "$DIST_SHA_SHORT" != "$GIT_SHA" ]; }; then
  echo "    !! Released $LOCAL_VER+$GIT_SHA but hosted /dist reports $DIST_VER+$DIST_SHA — upload/mount mismatch." >&2
  exit 1
fi
if [ -z "$WITH_RELEASE" ] && { [ "$DIST_VER" != "$LOCAL_VER" ] || [ "$DIST_SHA_SHORT" != "$GIT_SHA" ]; }; then
  echo "    !! Client-channel skew: deploying server $LOCAL_VER+$GIT_SHA but /dist publishes CLI $DIST_VER+$DIST_SHA." >&2
  echo "    !! Installed clients keep the OLD client contract; if this deploy tightens one (e.g. the" >&2
  echo "    !! analysis protocol version), every installed CLI is rejected with nothing to upgrade to." >&2
  echo "    !! Fix: cut a release first (apps/mcp-server/scripts/release.sh), then deploy," >&2
  echo "    !! or re-run with DEPLOY_ALLOW_CLIENT_SKEW=1 if you have verified the contract is unchanged." >&2
  [ "${DEPLOY_ALLOW_CLIENT_SKEW:-0}" = "1" ] || exit 1
  echo "    (DEPLOY_ALLOW_CLIENT_SKEW=1 — continuing with a known client/server version skew)"
fi

echo "==> Smoke: running one real analysis through the isolated worker service"
rsync -az -e "$SSH" "$APP_DIR/infrastructure/vps/analysis-smoke.mjs" "$DEST:/opt/klauro/analysis-smoke.mjs"
IMAGE_IDS="$($SSH "$DEST" 'docker inspect -f "{{.Image}}" klauro-api-1 klauro-analysis-worker-1 2>/dev/null | sort -u | wc -l' || echo 0)"
if [ "$IMAGE_IDS" != "1" ]; then
  echo "    !! api and analysis-worker run different images (source identity mismatch); the worker was not recreated." >&2
  exit 1
fi
RESTARTS_BEFORE="$($SSH "$DEST" 'docker inspect -f "{{.Name}}={{.RestartCount}}" klauro-api-1 klauro-analysis-worker-1 2>/dev/null | tr "\n" " "' || echo "")"
echo "    restart counts before: $RESTARTS_BEFORE"
if ! $SSH "$DEST" '
  set -e
  docker exec klauro-api-1 sh -c "test -S \"\$KLAURO_ANALYSIS_WORKER_SOCKET\"" || { echo "api container cannot see the analysis-worker socket" >&2; exit 1; }
  docker cp /opt/klauro/analysis-smoke.mjs klauro-api-1:/tmp/analysis-smoke.mjs >/dev/null
  docker exec -e KLAURO_AI_INTERPRETATION=false -w /app/apps/mcp-server klauro-api-1 \
    npx tsx /tmp/analysis-smoke.mjs
'; then
  echo "    !! ANALYSIS SMOKE FAILED — the deployed analyzer cannot complete an analysis." >&2
  echo "    !! /health is green but the product is BROKEN. Do not leave this deployed." >&2
  echo "    !! Most likely a torn/partial sync (deploy ships the working tree), the worker" >&2
  echo "    !! service socket not shared, or a real runtime bug. Check 'docker logs klauro-api-1'" >&2
  echo "    !! and 'docker logs klauro-analysis-worker-1'." >&2
  exit 1
fi
RESTARTS_AFTER="$($SSH "$DEST" 'docker inspect -f "{{.Name}}={{.RestartCount}}" klauro-api-1 klauro-analysis-worker-1 2>/dev/null | tr "\n" " "' || echo "")"
echo "    restart counts after:  $RESTARTS_AFTER"
if [ "$RESTARTS_BEFORE" != "$RESTARTS_AFTER" ]; then
  echo "    !! A container restarted during the smoke analysis (memory exhaustion or crash)." >&2
  echo "    !! The 2026-09-06 OOM class: an analysis must complete or refuse, never restart a service." >&2
  exit 1
fi

echo "==> Applying Docker artifact retention"
$SSH "$DEST" '
  set -e
  docker image prune -f >/dev/null
  docker builder prune -af --keep-storage 20GB >/dev/null
'

echo "==> Deploy verified. $KLAURO_URL is live (dist $DIST_VER)."
