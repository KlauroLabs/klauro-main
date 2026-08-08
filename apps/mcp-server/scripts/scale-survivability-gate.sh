#!/usr/bin/env bash
#
# PERIODIC scale-survivability gate — the live runner. Not part of deploy
# smoke (infrastructure/vps/analysis-smoke.mjs stays tiny on purpose). See
# apps/mcp-server/src/scale-survivability-gate.ts for the full rationale, the
# budgets, and the "red means someone acts" ownership/failure-surface note.
#
# WHAT THIS DOES:
#   1. Blackbox-triggers a real hosted analysis of a real, ordinary-size,
#      mixed-language repository via the `klauro` CLI (a genuine customer
#      path) — never by importing the analyzer engine.
#   2. While it runs, samples the production container's memory via the VPS
#      SSH credentials (VPS_HOST/VPS_USER/VPS_PASSWORD in the repo-root
#      .env, same as deploy.sh) — this is the one place this gate looks past
#      the customer-facing API, because peak RSS isn't something that API
#      exposes and this is the whole point of the gate.
#   3. Evaluates the observation against DEFAULT_SCALE_GATE_BUDGETS (or an
#      override) via the pure, unit-tested evaluateScaleGateObservation().
#   4. On any failure: appends a FAILING row to
#      docs/mcp/SCALE-SURVIVABILITY-LOG.md and exits non-zero. A scheduled
#      caller (see infrastructure/vps/klauro-scale-gate.timer) turns that
#      exit code into an OnFailure= alert.
#
# USAGE:
#   apps/mcp-server/scripts/scale-survivability-gate.sh [path]
#   [path] defaults to the repo root (this repo IS the "several thousand
#   files, mixed languages" ordinary-size case the gate targets — it is the
#   same repo the 3,856-file RangeError incident and the Aug 2026 peak-RSS
#   probes both used).
#
# REQUIRES: a valid `klauro` CLI session (`klauro auth-status`). This gate
# does NOT run `klauro login` itself and never will — an expired/invalid
# session must fail loudly here (exit non-zero, logged) rather than silently
# skip the gate. If this is failing on auth, that IS the finding: refresh
# the gate's own service session out-of-band before assuming the pipeline
# regressed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET_PATH="${1:-$REPO_ROOT}"
LOG_PATH="$REPO_ROOT/docs/mcp/SCALE-SURVIVABILITY-LOG.md"
MAX_WALL_MS="${KLAURO_SCALE_GATE_MAX_WALL_MS:-600000}"
MAX_PEAK_RSS_MB="${KLAURO_SCALE_GATE_MAX_PEAK_RSS_MB:-4500}"
MIN_NODES="${KLAURO_SCALE_GATE_MIN_NODES:-1000}"

cd "$REPO_ROOT"

if ! klauro auth-status >/dev/null 2>&1; then
  echo "[scale-gate] FAIL: klauro CLI is not authenticated. This gate refuses to run" \
       "\`klauro login\` itself (production-survivability cardinal constraint) —" \
       "refresh the gate's session out-of-band and retry." >&2
  exit 2
fi

STARTED_MS=$(($(date +%s%3N)))
EXIT_CODE=0
OUTPUT_FILE="$(mktemp)"
if [ -f "$REPO_ROOT/.env" ]; then set -a; source "$REPO_ROOT/.env"; set +a; fi

# Kick off the memory sampler in the background (best-effort — a sampler
# failure degrades to peakRssMb=null, which evaluateScaleGateObservation()
# treats as "not sampled", never as a false pass).
SAMPLE_FILE="$(mktemp)"
SAMPLER_PID=""
if [ -n "${VPS_HOST:-}" ] && [ -n "${VPS_PASSWORD:-}" ] && command -v sshpass >/dev/null 2>&1; then
  (
    while true; do
      sshpass -p "$VPS_PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
        "${VPS_USER:-root}@$VPS_HOST" \
        "docker exec klauro-api-1 sh -c \"awk '/VmRSS/{print \\\$2}' /proc/1/status\" 2>/dev/null" \
        >> "$SAMPLE_FILE" 2>/dev/null || true
      sleep 5
    done
  ) &
  SAMPLER_PID=$!
fi

set +e
timeout "$((MAX_WALL_MS / 1000 + 30))" klauro analyze "$TARGET_PATH" > "$OUTPUT_FILE" 2>&1
EXIT_CODE=$?
set -e

[ -n "$SAMPLER_PID" ] && kill "$SAMPLER_PID" 2>/dev/null || true

ENDED_MS=$(($(date +%s%3N)))
WALL_MS=$((ENDED_MS - STARTED_MS))
TIMED_OUT="false"
[ "$EXIT_CODE" -eq 124 ] && TIMED_OUT="true"

PEAK_RSS_KB=$(sort -n "$SAMPLE_FILE" 2>/dev/null | tail -1 || echo "")
PEAK_RSS_MB="null"
[ -n "$PEAK_RSS_KB" ] && PEAK_RSS_MB=$((PEAK_RSS_KB / 1024))

NODES=$(grep -oE '"nodes"\s*:\s*[0-9]+' "$OUTPUT_FILE" | head -1 | grep -oE '[0-9]+' || echo "")
EDGES=$(grep -oE '"edges"\s*:\s*[0-9]+' "$OUTPUT_FILE" | head -1 | grep -oE '[0-9]+' || echo "")
[ -z "$NODES" ] && NODES="null"
[ -z "$EDGES" ] && EDGES="null"

echo "[scale-gate] target=$TARGET_PATH exit=$EXIT_CODE timedOut=$TIMED_OUT wallMs=$WALL_MS" \
     "peakRssMb=$PEAK_RSS_MB nodes=$NODES edges=$EDGES"

STDERR_TAIL=$(tail -c 500 "$OUTPUT_FILE" | node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync(0,'utf8')))")
OBSERVATION_JSON=$(cat <<JSON
{"observation":{"repoLabel":"$TARGET_PATH","sourceFiles":0,"exitCode":$EXIT_CODE,"timedOut":$TIMED_OUT,"wallMs":$WALL_MS,"peakRssMb":$PEAK_RSS_MB,"nodes":$NODES,"edges":$EDGES,"stderrTail":$STDERR_TAIL},"budgets":{"maxWallMs":$MAX_WALL_MS,"maxPeakRssMb":$MAX_PEAK_RSS_MB,"minNodes":$MIN_NODES}}
JSON
)

set +e
FINDING_JSON=$(cd "$REPO_ROOT/apps/mcp-server" && npx tsx src/scale-gate-eval-cli.ts "$OBSERVATION_JSON")
GATE_EXIT=$?
set -e

echo "$FINDING_JSON"
STATUS=$(echo "$FINDING_JSON" | grep -oE '"status":"[a-z]+"' | head -1 | cut -d'"' -f4)
REASONS=$(echo "$FINDING_JSON" | grep -oE '"reasons":\[[^]]*\]' | head -1)
mkdir -p "$(dirname "$LOG_PATH")"
printf '| %s | %s | %s | %sms | %sMB | %s nodes |\n' \
  "$(date -u +%FT%TZ)" "$STATUS" "$REASONS" "$WALL_MS" "$PEAK_RSS_MB" "$NODES" >> "$LOG_PATH"

if [ "$GATE_EXIT" -ne 0 ]; then
  echo "[scale-gate] FAILED — see $LOG_PATH"
  exit 1
fi

echo "[scale-gate] PASSED"
