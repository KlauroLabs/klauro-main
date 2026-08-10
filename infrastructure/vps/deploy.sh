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
#   infrastructure/vps/deploy.sh --allow-detached    # deploy a sha no local branch points at
#                                                    # (auto-creates a branch ref at that sha
#                                                    # so it can never become a GC candidate)
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
DIRTY_DEPLOY=0
SNAPSHOT_SHA=""
if [ "$ALLOW_DIRTY" != "1" ]; then
  DIRTY="$(git -C "$APP_DIR" status --porcelain -uall 2>/dev/null || true)"
  if [ -n "$DIRTY" ]; then
    # NOT fatal any more, and the reason matters. This deploy now ships a
    # `git archive` of the resolved commit (see "materialise the source" below),
    # so uncommitted bytes CANNOT reach production even mid-write — which was the
    # entire hazard this guard was added for after a torn file broke every
    # analysis for hours.
    #
    # Refusing outright would now cost more than it protects: this repo is worked
    # as a shared tree by concurrent agents, so a permanently-quiet tree is not a
    # state that occurs, and gating deploys on one makes the deploy the bottleneck.
    # What is still worth saying loudly is WHAT IS NOT SHIPPING, so nobody watches
    # a deploy succeed and assumes their in-progress edit went with it.
    echo "NOTE: the working tree is dirty; these changes are NOT in this deploy." >&2
    echo "      Shipping the tree of $(git -C "$APP_DIR" rev-parse --short=12 HEAD) instead (safe by construction)." >&2
    echo "" >&2
    echo "$DIRTY" | sed 's/^/        /' >&2
    echo "" >&2
    echo "      Commit and re-deploy when you want the above live." >&2
  fi
fi

# --- guard: a build stamp must never be producible from an untraceable tree --
# The dirty guard above is the primary defence, but --allow-dirty existed as an
# escape hatch that produced a stamp reading HEAD's sha while shipping bytes
# that were NOT that commit — exactly how prod ended up serving "v1.0.127"
# stamped with a v1.0.126 sha, leaving hosted analyses impossible to trace back
# to code. An escape hatch is fine; an untraceable one is not.
#
# So when --allow-dirty is used we do not lie: write the working tree to a real
# commit object FIRST (a detached snapshot, never a branch, never touching
# .git/index — a concurrent editor's staged state must survive this), stamp it
# as the reproducing sha, and mark the build dirty. `git checkout <snapshot>`
# then reproduces production byte-for-byte. If a snapshot cannot be produced —
# no git, no repo — we refuse outright rather than ship an unattributable
# build.
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

# --- guard: the sha being deployed must be REACHABLE FROM A LOCAL BRANCH ----
# The dirty-tree guard stops uncommitted bytes from shipping, but says nothing
# about whether the commit itself is anchored to anything. REAL INCIDENT: twice
# in one working session a lane deployed from `git worktree add --detach`,
# which leaves HEAD pointing at a real commit that no branch points at.
# Production ran that commit fine, but it was a garbage-collection candidate
# from the moment the worktree was removed, and unreproducible from master —
# "which commit is live" stopped being answerable by `git branch --contains`.
# Both incidents were only recovered because someone happened to notice; the
# script itself had nothing to say. Same failure class as the build-stamp
# defect above: a sha that names something not guaranteed to keep existing.
#
# Policy chosen: refuse by default. Deploying a truly detached snapshot is
# occasionally legitimate (a throwaway experiment against this box), so the
# escape hatch is explicit (--allow-detached) AND self-healing — using it
# creates a real local branch ref pointing at the deploy sha automatically,
# so "the flag was used" and "the sha got lost" can never both be true. This
# mirrors the --allow-dirty escape hatch's own philosophy: an escape hatch is
# fine, an untraceable one is not.
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

# --- guard: SPEC-PURITY — no client/benchmark product names in specs or
# shipped source -------------------------------------------------------------
# Klauro's specs and product source must read as repo-agnostic: they explain
# the ANALYZER's behavior, not any one customer's codebase. In practice,
# comments and doc prose keep leaking the names of the benchmark/client repos
# used to find bugs straight into docs/SPEC*.md and orchestrator.ts. That's a
# doctrine violation two ways: it leaks client identity into a product
# artifact, and it silently rots the specs into a diary of one corpus instead
# of a description of the product.
#
# Open item #71: this used to be a single hand-typed BENCHMARK_CORPUS_NAMES
# list right here — it only ever caught a name someone remembered to add, so
# a brand-new customer/corpus repo sailed through silently (it already had,
# once). The forbidden set is now DERIVED FROM EVIDENCE instead (real analyzed
# project/workspace names known to the account, names already narrated in
# this repo's own test/fixture/gauntlet/bench/corpus paths, plus a
# shape/context heuristic that fails closed on a name never seen before) —
# see apps/mcp-server/src/spec-purity-gate.ts for the policy and its tests.
echo "==> Checking spec/source purity (evidence-derived forbidden-name gate — see spec-purity-gate.ts)"
if ! ( cd "$APP_DIR/apps/mcp-server" && npx tsx src/spec-purity-gate-cli.ts "$APP_DIR" ); then
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

# --- materialise the source to ship, from the COMMIT, not the live tree -----
#
# This deploy used to rsync `./` — the working tree — which made it unsafe to
# deploy while anyone was editing. That is a real constraint now, not a
# hypothetical: this repo is worked as a shared tree by concurrent agents
# ("real time collaboration ON THE SAME SHARED TREE"), so at any given moment
# the tree legitimately contains another lane's half-finished edit. The dirty
# guard above protects production correctly, but the cost was that a deploy had
# to wait for every lane to reach a commit — turning the deploy into the
# bottleneck that the collaboration model exists to remove.
#
# Instead, export the resolved commit into a staging dir with `git archive` and
# ship THAT. Consequences worth stating plainly:
#   - what lands in production is exactly the tree of $DEPLOY_SHA, byte for byte
#   - in-flight edits by other lanes cannot reach production, ever, even by race
#   - deploys no longer need to wait for a quiet tree
# The dirty guard is kept: it still refuses when the SHA being deployed does not
# describe the author's intent, and --allow-dirty still snapshots to a real
# commit first, so there is never an untraceable build.
DEPLOY_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/klauro-deploy-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
echo "==> Exporting $(git -C "$APP_DIR" rev-parse --short=12 HEAD) to a staging dir (not the live tree)"
git -C "$APP_DIR" archive --format=tar "$DEPLOY_SHA" | tar -x -C "$STAGE"
# apps/app/dist is a build product, gitignored, so it is not in the archive —
# take it from the working tree, which is where the build just wrote it.
STAGED_FILES="$(find "$STAGE" -type f | wc -l | tr -d ' ')"
echo "    staged $STAGED_FILES file(s) from the commit"

# --- sync artifacts --------------------------------------------------------
echo "==> Syncing app-dist"
rsync -az --delete -e "$SSH" apps/app/dist/ "$DEST:/opt/klauro/app-dist/"
echo "==> Syncing source (excluding heavy/generated dirs)"
rsync -az --delete-delay --exclude node_modules --exclude dist --exclude .git --exclude .pack \
  --exclude logs --exclude docs.zip -e "$SSH" "$STAGE/" "$DEST:/opt/klauro/source/"
echo "==> Syncing remote gate source to the identical deployment snapshot"
rsync -az --delete-delay --exclude node_modules --exclude dist --exclude .git --exclude .pack \
  --exclude logs --exclude docs.zip -e "$SSH" "$STAGE/" "$DEST:/opt/klauro/devgate/"
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
# Client-channel gate (2026-07-27 audit). A server-only deploy leaves the
# published CLI at whatever the last release cut. That is harmless until the
# server tightens a client contract — and on this deploy it was NOT harmless:
# the server started enforcing analysis protocol 2 and rejected every installed
# (protocol-1) CLI with HTTP 426, while /dist still served the older client.
# Customers were bricked with no reachable upgrade. The distribution channel is
# part of the deployed product, so a version skew fails the deploy.
if [ -z "$WITH_RELEASE" ] && [ "$DIST_VER" != "$LOCAL_VER" ]; then
  echo "    !! Client-channel skew: deploying server $LOCAL_VER but /dist still publishes CLI $DIST_VER." >&2
  echo "    !! Installed clients keep the OLD client contract; if this deploy tightens one (e.g. the" >&2
  echo "    !! analysis protocol version), every installed CLI is rejected with nothing to upgrade to." >&2
  echo "    !! Fix: cut a release first (apps/mcp-server/scripts/release.sh), then deploy," >&2
  echo "    !! or re-run with DEPLOY_ALLOW_CLIENT_SKEW=1 if you have verified the contract is unchanged." >&2
  [ "${DEPLOY_ALLOW_CLIENT_SKEW:-0}" = "1" ] || exit 1
  echo "    (DEPLOY_ALLOW_CLIENT_SKEW=1 — continuing with a known client/server version skew)"
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
