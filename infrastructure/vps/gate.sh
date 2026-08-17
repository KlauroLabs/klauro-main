#!/usr/bin/env bash
set -euo pipefail

DEVGATE_DIR="/opt/klauro/devgate"
BASE_IMAGE="klauro/api:alpha"
GATE_IMAGE="klauro-gate"
GATE_LABEL="klauro-gate=1"
DOCKERFILE_DIR="$(cd "$(dirname "$0")" && pwd)"

GATE_MAX_AGE_MIN="${GATE_MAX_AGE_MIN:-30}"
GATE_TIMEOUT_S="${GATE_TIMEOUT_S:-3600}"
NATIVE_PARSER_CACHE="/opt/klauro/.gate-tools/klauro-parse"
BENCH_CAS_CACHE="/opt/klauro/.gate-tools/bench-cas"

reap_stale_containers() {
  local max_age_min="$1"
  local now age_min cid started timeout_s timeout_age_min effective_max_age_min

  local exited
  exited="$(docker ps -a --filter "label=$GATE_LABEL" --filter "status=exited" -q)"
  if [ -n "$exited" ]; then
    echo "==> reaping $(echo "$exited" | wc -l | tr -d ' ') exited klauro-gate container(s)" >&2
    echo "$exited" | xargs -r docker rm >/dev/null 2>&1 || true
  fi

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
        ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/dist-*/*' ! -path '*/build/*' \
        ! -path '*/target/*' ! -path '*/coverage/*' ! -path '*/.cache/*' \
        ! -path '*/.tmp/*' ! -path '*/.pack/*' ! -path '*/.customer-package/*' \
        ! -path '*/.klauro-*' \
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

DEPLOYED_BUILD_STAMP="/opt/klauro/source/apps/mcp-server/.klauro-build-stamp.json"
if [ -z "${KLAURO_GIT_SHA:-}" ] && [ -f "$DEPLOYED_BUILD_STAMP" ]; then
  KLAURO_GIT_SHA="$(sed -n 's/.*"git_sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DEPLOYED_BUILD_STAMP")"
fi
if [ -z "${KLAURO_BUILD_TIME:-}" ] && [ -f "$DEPLOYED_BUILD_STAMP" ]; then
  KLAURO_BUILD_TIME="$(sed -n 's/.*"build_time"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DEPLOYED_BUILD_STAMP")"
fi
export KLAURO_GIT_SHA KLAURO_BUILD_TIME

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
mkdir -p "$BENCH_CAS_CACHE"
chmod -R a+rwX "$BENCH_CAS_CACHE" 2>/dev/null || true


for cache_dir in \
  "$DEVGATE_DIR/$WORKSPACE/node_modules/.cache" \
  "$DEVGATE_DIR/node_modules/.cache" \
  "$DEVGATE_DIR/apps/mcp-server/dist" \
  "$DEVGATE_DIR/apps/mcp-server/dist-hosted" \
  "$DEVGATE_DIR/apps/mcp-server/dist-sea" \
  "$DEVGATE_DIR/apps/mcp-server/.customer-package" \
  "$DEVGATE_DIR/apps/mcp-server/.pack"; do
  mkdir -p "$cache_dir" 2>/dev/null || true
  chmod -R a+rwX "$cache_dir" 2>/dev/null || true
done
chmod a+rwX "$DEVGATE_DIR/apps/mcp-server" 2>/dev/null || true
find "$DEVGATE_DIR/$WORKSPACE" -maxdepth 1 -type d -name '.klauro-*' -exec chmod -R a+rwX {} + 2>/dev/null || true
mkdir -p "$DEVGATE_DIR/packages/analyzer-core/dist"
chmod -R a+rwX "$DEVGATE_DIR/packages/analyzer-core/dist" 2>/dev/null || true
chmod a+rwX "$DEVGATE_DIR/packages/analyzer-core" 2>/dev/null || true
chmod a+rX "$DEVGATE_DIR" 2>/dev/null || true

CIDFILE="$(mktemp -u)"
rm -f "$CIDFILE"

DOCKER_ENV_ARGS=()
for variable in \
  KLAURO_GIT_SHA \
  KLAURO_BUILD_TIME \
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

DOCKER_MOUNT_ARGS=()
if [ -n "${KLAURO_GATE_INPUT_DIR:-}" ]; then
  if [ ! -d "$KLAURO_GATE_INPUT_DIR" ]; then
    echo "ERROR: KLAURO_GATE_INPUT_DIR is not a directory: $KLAURO_GATE_INPUT_DIR" >&2
    exit 2
  fi
  GATE_INPUT_DIR="$(realpath "$KLAURO_GATE_INPUT_DIR")"
  DOCKER_MOUNT_ARGS+=(-v "$GATE_INPUT_DIR:/gate-input:ro")
fi

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
  -v "$BENCH_CAS_CACHE:/tmp/klauro-gate-bench-cas" \
  "${DOCKER_MOUNT_ARGS[@]}" \
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
