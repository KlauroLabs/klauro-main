#!/usr/bin/env bash
#
# Klauro one-stop deploy: build the app -> sync app-dist + source + config to the
# VPS -> rebuild & restart the containers -> verify the LIVE surfaces. This is the
# scripted form of infrastructure/vps/README.md's runbook, so a production deploy
# is one command with fail-loud verification instead of a hand-run checklist.
#
# Usage:
#   infrastructure/vps/deploy.sh                     # build + deploy current tree, verify
#   infrastructure/vps/deploy.sh --with-release[=patch|minor|major|x.y.z]
#                                                    # cut the release FIRST (bump/pack/
#                                                    # upload tarball/tag), then deploy
#   infrastructure/vps/deploy.sh --skip-app-build    # reuse an existing apps/app/dist
#   infrastructure/vps/deploy.sh --no-verify         # skip the post-deploy health checks
#
# VPS creds come from the repo-root .env (VPS_HOST/VPS_USER/VPS_PASSWORD), which is
# gitignored. Requires sshpass + rsync. KLAURO_URL overrides the API base
# (default https://mcp.klauro.com) — it is baked into the app bundle at build time.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"   # repo root (proof-of-concept)
cd "$APP_DIR"

KLAURO_URL="${KLAURO_URL:-https://mcp.klauro.com}"
WITH_RELEASE=""
SKIP_APP_BUILD=0
DO_VERIFY=1
ALLOW_DIRTY=0

for arg in "$@"; do
  case "$arg" in
    --with-release)        WITH_RELEASE="patch" ;;
    --with-release=*)      WITH_RELEASE="${arg#*=}" ;;
    --skip-app-build)      SKIP_APP_BUILD=1 ;;
    --no-verify)           DO_VERIFY=0 ;;
    --allow-dirty)         ALLOW_DIRTY=1 ;;
    -h|--help)
      sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)"; exit 2 ;;
  esac
done

# --- guard: never ship a DIRTY working tree --------------------------------
# This deploy rsyncs the WORKING TREE (the api container runs raw TS via tsx),
# so whatever is on disk right now IS production. Uncommitted work is therefore
# shipped verbatim — including a file another process is still HALF-WAY THROUGH
# WRITING.
#
# REAL INCIDENT (2026-07-16): a concurrent session was mid-edit in
# orchestrator.ts (adding deriveEntryPointContractAndCapability + its call
# sites). A deploy rsynced that half-written file, so production got the USE
# (`entry_points: entryPointsWithContractAndCapability`) with NO definition and
# no method => every hosted analyze/reanalyze died with
# "ReferenceError: entryPointsWithContractAndCapability is not defined".
# health/version checks passed the whole time, so the deploy reported success
# while 100% of analyses were broken. Both the local tree and HEAD were fine —
# only the deployed copy was torn.
#
# A committed tree is an atomic, reviewable snapshot; the working tree is not.
# Refuse by default. `--allow-dirty` is the deliberate escape hatch (local
# experiments against a throwaway box), never the norm.
if [ "$ALLOW_DIRTY" != "1" ]; then
  DIRTY="$(git -C "$APP_DIR" status --porcelain 2>/dev/null || true)"
  if [ -n "$DIRTY" ]; then
    echo "ERROR: refusing to deploy a DIRTY working tree — this deploy ships the tree verbatim," >&2
    echo "       so uncommitted (or half-written) files would go straight to production." >&2
    echo "       A concurrent editor mid-write once shipped a torn file and broke ALL analyses." >&2
    echo "" >&2
    echo "$DIRTY" | sed 's/^/         /' >&2
    echo "" >&2
    echo "       Commit (or stash) the above, then re-run. To override: --allow-dirty" >&2
    exit 1
  fi
fi

# --- guard: SPEC-PURITY — no client/benchmark product names in specs or
# shipped source -------------------------------------------------------------
# Klauro's specs and product source must read as repo-agnostic: they explain
# the ANALYZER's behavior, not any one customer's codebase. In practice,
# comments and doc prose keep leaking the names of the benchmark/client repos
# used to find bugs (zerac, soon-lens, truckspy, Hoggan, ...) straight into
# docs/SPEC*.md and orchestrator.ts. That's a doctrine violation two ways: it
# leaks client identity into a product artifact, and it silently rots the
# specs into a diary of one corpus instead of a description of the product.
#
# BENCHMARK_CORPUS_NAMES is the single list to extend when a new benchmark/
# client repo enters the corpus and starts showing up in commit messages —
# add its name (lowercase, `|`-separated, regex-escaped if needed) here and
# nowhere else. Keep entries specific enough to avoid false positives on
# common English words.
BENCHMARK_CORPUS_NAMES='zerac|soon-lens|truckspy|hoggan|washup|miniflux|petclinic'

echo "==> Checking spec/source purity (no benchmark-corpus names: $BENCHMARK_CORPUS_NAMES)"
SPEC_PURITY_HITS=""
# (a) doctrine/spec docs
SPEC_DOC_PATHS="docs/ARCHITECTURE.md docs/UNDERSTANDING-MODEL.md docs/COVERAGE-INTELLIGENCE.md"
for p in docs/SPEC*.md docs/was/ docs/cas/ $SPEC_DOC_PATHS; do
  [ -e "$p" ] || continue
  HIT="$(grep -rniE "$BENCHMARK_CORPUS_NAMES" "$p" 2>/dev/null || true)"
  [ -n "$HIT" ] && SPEC_PURITY_HITS="${SPEC_PURITY_HITS}${HIT}
"
done
# (b) shipped product source, excluding test/fixture/bench/corpus paths
SRC_HITS="$(grep -rniE "$BENCHMARK_CORPUS_NAMES" --include='*.ts' \
  packages/analyzer-core/src apps/mcp-server/src 2>/dev/null \
  | grep -viE '/(test|tests|fixture|fixtures|__tests__|gauntlet|bench|benchmark|corpus)/|(\.test|\.spec|-test|benchmark|-bench|gauntlet|-corpus|-eval|-fixture)[^/]*\.ts:|/(agent-scratch-dogfood-build|agent-adoption-measurement|agent-task-family-coverage)\.ts:' || true)"
[ -n "$SRC_HITS" ] && SPEC_PURITY_HITS="${SPEC_PURITY_HITS}${SRC_HITS}
"

if [ -n "$SPEC_PURITY_HITS" ]; then
  echo "ERROR: SPEC-PURITY gate failed — benchmark/client corpus names found in specs or" >&2
  echo "       product source (rule: spec/doctrine and product source must be" >&2
  echo "       product-agnostic — move corpus references to benchmark records or fixtures)." >&2
  echo "" >&2
  echo "$SPEC_PURITY_HITS" | sed '/^$/d; s/^/         /' >&2
  echo "" >&2
  echo "       Fix by rewording the offending comments/docs generically, or by moving the" >&2
  echo "       corpus-specific detail into a test/fixture/gauntlet/bench/corpus path (which" >&2
  echo "       this gate excludes). Refusing to deploy." >&2
  exit 1
fi

# --- creds -----------------------------------------------------------------
if [ -f "$APP_DIR/.env" ]; then set -a; . "$APP_DIR/.env"; set +a; fi
if [ -z "${VPS_HOST:-}" ] || [ -z "${VPS_USER:-}" ] || [ -z "${VPS_PASSWORD:-}" ]; then
  echo "ERROR: VPS_HOST/VPS_USER/VPS_PASSWORD missing (repo-root .env). Cannot deploy." >&2
  exit 1
fi
command -v sshpass >/dev/null || { echo "ERROR: sshpass not installed." >&2; exit 1; }
# ControlMaster multiplexing: every ssh/rsync/scp step reuses ONE authenticated
# connection. Without it a deploy makes ~6 separate auths, and repeated deploys
# in one session trip the VPS's connection-rate limit ("Permission denied"
# mid-deploy). The master persists briefly so back-to-back deploys reuse it too.
# NB: ControlPath must stay short (macOS TMPDIR overflows the Unix-socket path
# limit) — use /tmp directly + %C (hash of conn params) instead of %r@%h:%p.
CM_OPTS="-o ControlMaster=auto -o ControlPath=/tmp/klauro-cm-%C -o ControlPersist=120"
export SSHPASS="$VPS_PASSWORD"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=25 $CM_OPTS"
DEST="$VPS_USER@$VPS_HOST"

# --- optional: cut the release first --------------------------------------
if [ -n "$WITH_RELEASE" ]; then
  echo "==> Cutting release ($WITH_RELEASE) before deploy"
  bash "$APP_DIR/apps/mcp-server/scripts/release.sh" "$WITH_RELEASE"
fi

# --- guard: the compose we're about to ship MUST keep the downloads mount --
# Without it the api container serves /dist/klauro-latest.tgz + /dist/latest.json
# as 404/version:null and the whole install/update channel silently breaks.
if ! grep -q '/opt/klauro/downloads' "$APP_DIR/infrastructure/vps/docker-compose.yml"; then
  echo "ERROR: docker-compose.yml is missing the /opt/klauro/downloads mount." >&2
  echo "       Deploying it would break the install/update distribution channel. Aborting." >&2
  exit 1
fi

# --- build the app (Vite inlines VITE_KLAURO_API_URL at build time) --------
if [ "$SKIP_APP_BUILD" = "0" ]; then
  echo "==> Building app with VITE_KLAURO_API_URL=$KLAURO_URL"
  VITE_KLAURO_API_URL="$KLAURO_URL" npm run app:build
else
  echo "==> --skip-app-build: reusing existing apps/app/dist"
  test -d "$APP_DIR/apps/app/dist" || { echo "ERROR: apps/app/dist not found." >&2; exit 1; }
fi

# --- sync artifacts --------------------------------------------------------
echo "==> Syncing app-dist"
rsync -az --delete -e "$SSH" apps/app/dist/ "$DEST:/opt/klauro/app-dist/"
echo "==> Syncing source (excluding heavy/generated dirs)"
rsync -az --delete-delay --exclude node_modules --exclude dist --exclude .git --exclude .pack \
  --exclude logs --exclude docs.zip -e "$SSH" ./ "$DEST:/opt/klauro/source/"
echo "==> Syncing remote gate source to the identical deployment snapshot"
rsync -az --delete-delay --exclude node_modules --exclude dist --exclude .git --exclude .pack \
  --exclude logs --exclude docs.zip -e "$SSH" ./ "$DEST:/opt/klauro/devgate/"
echo "==> Syncing Caddyfile + docker-compose.yml"
rsync -az -e "$SSH" infrastructure/vps/Caddyfile "$DEST:/opt/klauro/Caddyfile"
rsync -az -e "$SSH" infrastructure/vps/docker-compose.yml "$DEST:/opt/klauro/docker-compose.yml"

# --- stamp the real build identity ------------------------------------------
# The api container runs raw TS via `tsx` (never the esbuild bundle that would
# embed __KLAURO_GIT_SHA__/__KLAURO_BUILD_TIME__ at build time), AND the
# source sync above excludes .git — so build-identity.ts's `git rev-parse`
# fallback always ran with no .git in reach on prod and silently reported
# "unknown", shipping e.g. "1.0.126-dev+unknown" on /health forever. The dirty-
# tree guard above already guarantees $APP_DIR's HEAD is exactly what was just
# synced, so write that real sha (+ build time) into a small stamp file
# BEFORE the container build below — getBuildIdentity() prefers this stamp
# over the (on-prod, always-failing) git invocation.
GIT_SHA="$(git -C "$APP_DIR" rev-parse --short=12 HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "==> Stamping build identity ($GIT_SHA @ $BUILD_TIME)"
$SSH "$DEST" "cat > /opt/klauro/source/apps/mcp-server/.klauro-build-stamp.json" <<STAMP
{"git_sha": "$GIT_SHA", "build_time": "$BUILD_TIME"}
STAMP
# .dockerignore previously dropped that file from every Docker build context
# (its own `.klauro*` exclusion patterns matched the stamp file too — fixed
# with a negation entry), so this SSH-written file alone never reached the
# image no matter which deploy path ran it. Belt-and-suspenders now that the
# leak is fixed: also pass the same sha/time as build args, which
# apps/api/Dockerfile stamps at IMAGE BUILD time if no file survived into the
# context — so a build invoked any other way (not through this script) still
# produces a real, non-"unknown" stamp as long as it exports these two vars.

# --- rebuild + restart -----------------------------------------------------
echo "==> Rebuilding + restarting containers on $VPS_HOST"
$SSH "$DEST" "cd /opt/klauro && KLAURO_GIT_SHA='$GIT_SHA' KLAURO_BUILD_TIME='$BUILD_TIME' docker compose up -d --build --remove-orphans"
$SSH "$DEST" "docker image rm klauro-gate >/dev/null 2>&1 || true"

# --- guard: force Caddy to re-resolve the (possibly recreated) api container -
# Defect #24 (observed twice on prod): `docker compose up -d --build` recreates
# the api container with a NEW IP on Docker's bridge network, but caddy is
# NOT restarted by compose (its own image/config didn't change), so it can
# keep talking to the OLD, now-unowned IP -> requests hang -> Cloudflare 524s
# for up to ~30 minutes even though the new api is perfectly healthy inside
# the network. The Caddyfile's `dynamic a` upstream (see infrastructure/vps/
# Caddyfile) should self-heal this within its refresh interval, but this
# restart is cheap, deterministic insurance layered on top: wait for api's
# own healthcheck to go healthy, THEN bounce caddy so it starts every
# connection fresh against the current IP. This is the automated form of the
# documented manual fix (`docker restart klauro-caddy-1`).
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

# --- verify the LIVE surfaces (fail loud) ----------------------------------
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

# --- smoke: actually RUN one analysis in the container (fail loud) ----------
# Everything above is a LIVENESS probe. On 2026-07-16 all of it passed green
# while 100% of hosted analyses were dying on a ReferenceError from a torn
# orchestrator.ts. Liveness != the product working. This runs a real (tiny,
# AI-off) analysis inside the api container and fails the deploy if the
# analyzer is broken — the check that would have caught that outage at deploy
# time instead of hours later.
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

# Repeated image rebuilds otherwise leave one dangling multi-gigabyte image and
# its BuildKit layers behind on every deploy. Keep the live image and useful
# recent cache, but bound inactive build artifacts on the small alpha VPS.
echo "==> Applying Docker artifact retention"
$SSH "$DEST" '
  set -e
  docker image prune -f >/dev/null
  docker builder prune -af --keep-storage 20GB >/dev/null
'

echo "==> Deploy verified. $KLAURO_URL is live (dist $DIST_VER)."
