#!/usr/bin/env bash
#
# gate.sh — run a test/gate command inside the klauro-gate image against the
# devgate tree at /opt/klauro/devgate on THIS host (the VPS). This is the
# runner half of infrastructure/vps/gate.Dockerfile: it makes sure the image
# exists (building it from the current api image if it doesn't, or if asked
# to), then runs the given command as the non-root `gate` user with git
# available — the two things the bare api image can't give a test run.
#
# Usage:
#   infrastructure/vps/gate.sh <workspace> <cmd...>
#   infrastructure/vps/gate.sh --rebuild <workspace> <cmd...>   # force image rebuild first
#   infrastructure/vps/gate.sh --allow-source-mismatch <workspace> <cmd...>
#
# <workspace> is a path relative to /gate (the devgate tree root), e.g.
#   apps/mcp-server
#   packages/analyzer-core
#
# Examples:
#   infrastructure/vps/gate.sh apps/mcp-server \
#     "../../node_modules/.bin/tsx --test src/remote-analyzer-reanalyze-attempt.test.ts"
#   infrastructure/vps/gate.sh packages/analyzer-core \
#     "node_modules/.bin/jest -t 'permission-denied subdirectories'"
#
# NOTE: this script only RUNS gates against whatever is already at
# /opt/klauro/devgate. It does NOT sync the tree — syncing (rsync of the repo
# + `npm install --include=dev`) happens from the dev machine, not from here,
# and is deliberately out of scope for this script. A `gate.sh sync` mode was
# considered and rejected for that reason; re-sync manually, e.g.:
#   rsync -az --exclude node_modules --exclude .git ./ root@<host>:/opt/klauro/devgate/
#   ssh root@<host> 'cd /opt/klauro/devgate && npm install --include=dev'
#
# Rebuild note: klauro-gate is built FROM whatever api image is currently
# present (klauro/api:alpha). After every deploy that image is recreated, so
# re-run with --rebuild (or delete the klauro-gate image) to pick up the new
# base rather than silently gating against a stale one.
set -euo pipefail

DEVGATE_DIR="/opt/klauro/devgate"
BASE_IMAGE="klauro/api:alpha"
GATE_IMAGE="klauro-gate"
GATE_LABEL="klauro-gate=1"
DOCKERFILE_DIR="$(cd "$(dirname "$0")" && pwd)"

# Stale-container reaping: killed/wedged gate invocations (Ctrl-C'd runs,
# timed-out CI jobs, agent sessions that got killed before the `docker run`
# returned) leave klauro-gate containers behind. --rm only cleans up a
# container that exits normally; it does nothing for a container that's still
# RUNNING when its parent process dies, or one whose --rm cleanup itself got
# interrupted. Left unchecked these accumulate and starve the host (14 seen in
# the wild) until someone notices and kills them by hand.
#
# Filter by the explicit label below (set on every `docker run` at the bottom
# of this script), never by name-guessing or image ancestry alone — a label is
# exact and survives image rebuilds.
GATE_MAX_AGE_MIN="${GATE_MAX_AGE_MIN:-30}"
GATE_TIMEOUT_S="${GATE_TIMEOUT_S:-3600}"
NATIVE_PARSER_CACHE="/opt/klauro/.gate-tools/klauro-parse"

reap_stale_containers() {
  local max_age_min="$1"
  local now age_min cid started timeout_s timeout_age_min effective_max_age_min

  # Exited (or otherwise dead) klauro-gate containers: always safe to remove,
  # regardless of age.
  local exited
  exited="$(docker ps -a --filter "label=$GATE_LABEL" --filter "status=exited" -q)"
  if [ -n "$exited" ]; then
    echo "==> reaping $(echo "$exited" | wc -l | tr -d ' ') exited klauro-gate container(s)" >&2
    echo "$exited" | xargs -r docker rm >/dev/null 2>&1 || true
  fi

  # Running klauro-gate containers older than the threshold: these are the
  # wedged/orphaned ones. Kill + remove.
  # (VPS is Linux/GNU coreutils, so `date -d` is available directly — no
  # BSD-date fallback needed here.)
  now="$(date +%s)"
  docker ps --filter "label=$GATE_LABEL" --filter "status=running" -q | while read -r cid; do
    [ -z "$cid" ] && continue
    started="$(docker inspect -f '{{.State.StartedAt}}' "$cid" 2>/dev/null || true)"
    [ -z "$started" ] && continue
    local started_epoch
    started_epoch="$(date -u -d "$started" +%s 2>/dev/null || echo "$now")"
    age_min=$(( (now - started_epoch) / 60 ))
    timeout_s="$(docker inspect -f '{{ index .Config.Labels "klauro-gate-timeout-s" }}' "$cid" 2>/dev/null || true)"
    effective_max_age_min="$max_age_min"
    if [[ "$timeout_s" =~ ^[0-9]+$ ]]; then
      timeout_age_min=$(( (timeout_s + 59) / 60 + 2 ))
      if [ "$timeout_age_min" -gt "$effective_max_age_min" ]; then
        effective_max_age_min="$timeout_age_min"
      fi
    fi
    if [ "$age_min" -ge "$effective_max_age_min" ]; then
      echo "==> reaping stale running klauro-gate container $cid (age ${age_min}m >= ${effective_max_age_min}m)" >&2
      docker kill "$cid" >/dev/null 2>&1 || true
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  done
}

reap_stale_containers "$GATE_MAX_AGE_MIN"

REBUILD=0
ALLOW_SOURCE_MISMATCH=0
while [[ "${1:-}" == --* ]]; do
  case "${1:-}" in
    --rebuild) REBUILD=1 ;;
    --allow-source-mismatch) ALLOW_SOURCE_MISMATCH=1 ;;
    *) echo "unknown flag: ${1:-}" >&2; exit 2 ;;
  esac
  shift
done

WORKSPACE="${1:-}"
shift || true
CMD="$*"

if [ -z "$WORKSPACE" ] || [ -z "$CMD" ]; then
  echo "usage: gate.sh [--rebuild] [--allow-source-mismatch] <workspace> <cmd...>" >&2
  exit 2
fi

source_fingerprint() {
  local root="$1"
  (
    cd "$root"
    {
      find apps packages infrastructure docs -type f \
        ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/build/*' \
        ! -path '*/target/*' ! -path '*/coverage/*' ! -path '*/.cache/*' \
        ! -path '*/.tmp/*' ! -path '*/.pack/*' ! -path '*/.customer-package/*' \
        ! -name '.klauro-build-stamp.json' -print0 2>/dev/null
      for file in package.json package-lock.json tsconfig.json; do
        if [ -f "$file" ]; then printf '%s\0' "$file"; fi
      done
    } | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
  )
}

if [ "$ALLOW_SOURCE_MISMATCH" != "1" ] && [ -d /opt/klauro/source ]; then
  DEVGATE_FINGERPRINT="$(source_fingerprint "$DEVGATE_DIR")"
  DEPLOYED_FINGERPRINT="$(source_fingerprint /opt/klauro/source)"
  if [ "$DEVGATE_FINGERPRINT" != "$DEPLOYED_FINGERPRINT" ]; then
    echo "ERROR: devgate source does not match the deployed source tree." >&2
    echo "       Refusing a silently stale or ahead-of-production gate." >&2
    echo "       Re-run the deploy sync, or use --allow-source-mismatch explicitly for a pre-deploy candidate gate." >&2
    echo "       devgate=$DEVGATE_FINGERPRINT deployed=$DEPLOYED_FINGERPRINT" >&2
    exit 3
  fi
fi

if [ "$REBUILD" = "1" ] || ! docker image inspect "$GATE_IMAGE" >/dev/null 2>&1; then
  echo "==> building $GATE_IMAGE from $BASE_IMAGE" >&2
  docker build \
    --build-arg BASE_IMAGE="$BASE_IMAGE" \
    -f "$DOCKERFILE_DIR/gate.Dockerfile" \
    -t "$GATE_IMAGE" \
    "$DOCKERFILE_DIR"
fi

GATE_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$GATE_IMAGE")"
NATIVE_PARSER_STAMP="${NATIVE_PARSER_CACHE}.image-id"
if [ ! -x "$NATIVE_PARSER_CACHE" ] || [ "$(cat "$NATIVE_PARSER_STAMP" 2>/dev/null || true)" != "$GATE_IMAGE_ID" ]; then
  mkdir -p "$(dirname "$NATIVE_PARSER_CACHE")"
  PARSER_CONTAINER="$(docker create "$GATE_IMAGE")"
  trap 'docker rm -f "$PARSER_CONTAINER" >/dev/null 2>&1 || true' EXIT
  docker cp "$PARSER_CONTAINER:/app/packages/analyzer-core/native/klauro-parse/target/release/klauro-parse" "$NATIVE_PARSER_CACHE"
  docker rm "$PARSER_CONTAINER" >/dev/null
  trap - EXIT
  chmod 755 "$NATIVE_PARSER_CACHE"
  printf '%s' "$GATE_IMAGE_ID" > "$NATIVE_PARSER_STAMP"
fi
mkdir -p "$DEVGATE_DIR/packages/analyzer-core/native/klauro-parse/target/release"

# KLAURO_STORAGE_PATH=/data/storage and KLAURO_REMOTE_ANALYZER_DATA=/data are
# baked into the api image (apps/api/Dockerfile ENV) for PRODUCTION, where
# /data is a real bind-mounted, writable volume. The gate container has no
# such mount and runs as non-root `gate`, so any code path that falls back to
# these baked defaults (rather than an override a given test sets itself)
# hits `EACCES: permission denied, mkdir '/data'` — a third env artifact,
# alongside missing-git and root, discovered while proving this image.
# Point both at a writable per-run tmp path instead.

# Fourth env artifact: tool caches under the bind-mounted tree. rsync/npm on
# the host leave node_modules/.cache (jest haste maps) and vite's config
# bundle temp dir owned by whatever uid synced them; the non-root `gate` user
# then hits EACCES on the first jest/vite run of a fresh sync. Pre-open the
# cache dirs for the target workspace before every run — idempotent, scoped
# to caches only (never the source tree).
for cache_dir in \
  "$DEVGATE_DIR/$WORKSPACE/node_modules/.cache" \
  "$DEVGATE_DIR/node_modules/.cache" \
  "$DEVGATE_DIR/apps/mcp-server/dist" \
  "$DEVGATE_DIR/apps/mcp-server/.customer-package" \
  "$DEVGATE_DIR/apps/mcp-server/.pack"; do
  mkdir -p "$cache_dir" 2>/dev/null || true
  chmod -R a+rwX "$cache_dir" 2>/dev/null || true
done
chmod a+rwX "$DEVGATE_DIR/apps/mcp-server" 2>/dev/null || true
mkdir -p "$DEVGATE_DIR/packages/analyzer-core/dist"
chmod -R a+rwX "$DEVGATE_DIR/packages/analyzer-core/dist" 2>/dev/null || true
chmod a+rwX "$DEVGATE_DIR/packages/analyzer-core" 2>/dev/null || true

# Hard timeout on the run itself: a wedged gate command (hung test, deadlock)
# should not be able to sit forever waiting for someone to notice — that's
# exactly how the 14-container pileup happened. `timeout` sends SIGTERM to
# `docker run`; `--init` on the container makes an init process PID 1 inside
# the container so that signal actually reaches the gated command instead of
# being swallowed by a shell that never forwards signals to its children.
#
# We don't rely solely on signal propagation for cleanup, though: if `docker
# run` itself is killed (e.g. timeout's --kill-after fires) before it can
# process --rm, the container would be orphaned — the exact failure mode this
# fix exists to close. So we capture the container id via --cidfile and
# explicitly kill+rm it after timeout, belt-and-suspenders with --rm.
#
# Distinct exit code (124, timeout's own convention) + explicit message so a
# timed-out gate is never confused with a real test failure.
CIDFILE="$(mktemp -u)"
rm -f "$CIDFILE"

DOCKER_ENV_ARGS=()
for variable in \
  KLAURO_ENTERPRISE_HOSTED_PROOF \
  KLAURO_ENTERPRISE_PROOF_URL \
  KLAURO_ENTERPRISE_PROOF_SECRET \
  KLAURO_ENTERPRISE_PROOF_EMAIL \
  KLAURO_ENTERPRISE_APP_COLD_BUDGET_MS \
  KLAURO_ENTERPRISE_INFRA_COLD_BUDGET_MS \
  KLAURO_ENTERPRISE_UNCHANGED_WARM_BUDGET_MS \
  KLAURO_ENTERPRISE_ONE_FILE_INCREMENTAL_BUDGET_MS \
  KLAURO_ENTERPRISE_DEPENDENCY_INVALIDATION_BUDGET_MS \
  KLAURO_ENTERPRISE_WORKSPACE_ANALYSIS_BUDGET_MS \
  KLAURO_ENTERPRISE_POST_INCREMENTAL_WORKSPACE_BUDGET_MS; do
  if [ -n "${!variable:-}" ]; then
    DOCKER_ENV_ARGS+=(-e "$variable")
  fi
done

RUN_STARTED_AT="$(date +%s)"
set +e
timeout --signal=TERM --kill-after=10s "${GATE_TIMEOUT_S}s" \
  docker run --rm --init \
  --cidfile "$CIDFILE" \
  --label "$GATE_LABEL" \
  --label "klauro-gate-timeout-s=$GATE_TIMEOUT_S" \
  --user gate \
  -e NODE_ENV=development \
  -e KLAURO_STORAGE_PATH=/tmp/klauro-gate-storage \
  -e KLAURO_REMOTE_ANALYZER_DATA=/tmp/klauro-gate-data \
  -e KLAURO_BENCH_CAS_CACHE_DIR=/tmp/klauro-gate-bench-cas \
  "${DOCKER_ENV_ARGS[@]}" \
  -v "$DEVGATE_DIR:/gate" \
  -v "$NATIVE_PARSER_CACHE:/gate/packages/analyzer-core/native/klauro-parse/target/release/klauro-parse:ro" \
  -w "/gate/$WORKSPACE" \
  "$GATE_IMAGE" \
  sh -c "$CMD"
STATUS=$?
set -e
RUN_ELAPSED_S=$(( $(date +%s) - RUN_STARTED_AT ))

if [ "$STATUS" -eq 124 ] || [ "$STATUS" -eq 137 ]; then
  if [ -s "$CIDFILE" ]; then
    docker kill "$(cat "$CIDFILE")" >/dev/null 2>&1 || true
    docker rm -f "$(cat "$CIDFILE")" >/dev/null 2>&1 || true
  fi
  rm -f "$CIDFILE"
  echo "==> gate.sh: command exceeded GATE_TIMEOUT_S=${GATE_TIMEOUT_S}s after ${RUN_ELAPSED_S}s, killed and removed" >&2
  exit 124
fi

rm -f "$CIDFILE"
echo "==> gate.sh: command finished status=$STATUS elapsed=${RUN_ELAPSED_S}s" >&2
exit "$STATUS"
