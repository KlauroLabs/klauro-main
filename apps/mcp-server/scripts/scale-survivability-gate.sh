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
#      path) — never by importing the analyzer engine. `klauro analyze`
#      itself only ACCEPTS the upload and returns immediately (progressive
#      availability — see docs/context/ANALYZER-ORCHESTRATION.md); this
#      script then POLLS the same customer-facing analysis-status endpoint
#      (GET /api/projects/{id}/analysis-status, same shape the
#      resolve_agent_analysis MCP tool and the installed CLI both read) to
#      observe real completion — the customer-visible signal, not an
#      internal one.
#   2. While it polls, ALSO samples the production container's memory via
#      the VPS SSH credentials (VPS_HOST/VPS_USER/VPS_PASSWORD in the
#      repo-root .env, same as deploy.sh) — the one place this gate looks
#      past the customer-facing API, because peak RSS isn't something that
#      API exposes and this is the whole point of that assertion.
#   3. task #118 (latency PREDICTABILITY): the same status poll also records
#      when the L4 (last deterministic) layer's `completed_at` lands, so the
#      gate can assert deterministic-layer readiness on its OWN tight budget
#      (maxDeterministicReadyMs) — independent of the overall AI-inclusive
#      wall-clock budget. See scale-survivability-gate.ts's module doc for
#      why maxWallMs alone cannot catch a queueing regression here.
#   4. Evaluates the observation against DEFAULT_SCALE_GATE_BUDGETS (or an
#      override) via the pure, unit-tested evaluateScaleGateObservation().
#   5. On any failure: appends a FAILING row to
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
# task #118: independent, much tighter budget on deterministic-layer (L0-L4)
# readiness — see scale-survivability-gate.ts's DEFAULT_SCALE_GATE_BUDGETS doc.
MAX_DETERMINISTIC_READY_MS="${KLAURO_SCALE_GATE_MAX_DETERMINISTIC_READY_MS:-90000}"

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
klauro analyze "$TARGET_PATH" --json > "$OUTPUT_FILE" 2>&1
ACCEPT_EXIT=$?
set -e

if [ "$ACCEPT_EXIT" -ne 0 ]; then
  # Upload/accept itself failed — no analysis_id to poll. This IS a
  # process-failed observation; fall through to evaluation with no counts,
  # no deterministic-readiness sample, exactly as the old synchronous-CLI
  # path did on a non-zero exit.
  EXIT_CODE=$ACCEPT_EXIT
  TIMED_OUT="false"
  ENDED_MS=$(($(date +%s%3N)))
  WALL_MS=$((ENDED_MS - STARTED_MS))
  PEAK_RSS_MB="null"
  DETERMINISTIC_READY_MS="null"
  NODES="null"
  EDGES="null"
else
  ANALYSIS_ID=$(grep -oE '"analysis_id"\s*:\s*"[^"]+"' "$OUTPUT_FILE" | head -1 | grep -oE '"[^":]+"$' | tr -d '"')
  SERVER_URL=$(grep -oE '"serverUrl"\s*:\s*"[^"]+"' "$TARGET_PATH/.klaurorc" 2>/dev/null | head -1 | grep -oE '"[^":]+"$' | tr -d '"')
  SERVER_URL="${SERVER_URL:-https://mcp.klauro.com}"
  TOKEN=$(node -e "
    try {
      const auth = require('$HOME/.klauro/auth.json');
      const account = auth.accounts && auth.accounts['$SERVER_URL'];
      process.stdout.write(account && account.token ? account.token : '');
    } catch { /* no auth.json — token stays empty, poll will 401 and degrade to timeout */ }
  ")

  if [ -z "$ANALYSIS_ID" ] || [ -z "$TOKEN" ]; then
    echo "[scale-gate] WARN: could not resolve analysis_id or auth token; treating as timed-out (no completion signal reachable)" >&2
    EXIT_CODE=0
    TIMED_OUT="true"
    ENDED_MS=$(($(date +%s%3N)))
    WALL_MS=$((ENDED_MS - STARTED_MS))
    PEAK_RSS_MB="null"
    DETERMINISTIC_READY_MS="null"
    NODES="null"
    EDGES="null"
  else
    # Poll the SAME customer-facing analysis-status endpoint the installed
    # CLI/MCP client reads (resolve_agent_analysis) until L5 (or the whole
    # analysis) reaches a terminal state, or MAX_WALL_MS elapses.
    DEADLINE_MS=$((STARTED_MS + MAX_WALL_MS))
    DETERMINISTIC_READY_MS="null"
    STATUS="populating"
    STATUS_JSON=""
    while [ "$(date +%s%3N)" -lt "$DEADLINE_MS" ]; do
      STATUS_JSON=$(curl -s --max-time 10 -H "authorization: Bearer $TOKEN" \
        "$SERVER_URL/api/projects/$ANALYSIS_ID/analysis-status" || echo "")
      STATUS=$(echo "$STATUS_JSON" | node -e "
        let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
          try { process.stdout.write(JSON.parse(d).status || ''); } catch { process.stdout.write(''); }
        });
      ")
      if [ "$DETERMINISTIC_READY_MS" = "null" ]; then
        L4_MS=$(echo "$STATUS_JSON" | node -e "
          let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
            try {
              const j = JSON.parse(d);
              const l4 = (j.summary && j.summary.layers_ready && j.summary.layers_ready.layers || [])
                .find(l => l.layer === 'L4' && l.status === 'ready' && l.completed_at);
              process.stdout.write(l4 ? String(Date.parse(l4.completed_at)) : '');
            } catch { process.stdout.write(''); }
          });
        ")
        if [ -n "$L4_MS" ]; then
          DETERMINISTIC_READY_MS=$((L4_MS - STARTED_MS))
        fi
      fi
      if [ "$STATUS" = "ready" ] || [ "$STATUS" = "error" ]; then
        break
      fi
      sleep 5
    done

    ENDED_MS=$(($(date +%s%3N)))
    WALL_MS=$((ENDED_MS - STARTED_MS))
    if [ "$STATUS" = "ready" ]; then
      EXIT_CODE=0
      TIMED_OUT="false"
    elif [ "$STATUS" = "error" ]; then
      EXIT_CODE=1
      TIMED_OUT="false"
    else
      EXIT_CODE=0
      TIMED_OUT="true"
    fi

    NODES=$(echo "$STATUS_JSON" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try { const n=JSON.parse(d).summary?.node_count; process.stdout.write(typeof n==='number'?String(n):''); } catch { process.stdout.write(''); }
      });
    ")
    EDGES=$(echo "$STATUS_JSON" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try { const n=JSON.parse(d).summary?.edge_count; process.stdout.write(typeof n==='number'?String(n):''); } catch { process.stdout.write(''); }
      });
    ")
    [ -z "$NODES" ] && NODES="null"
    [ -z "$EDGES" ] && EDGES="null"
    PEAK_RSS_MB="null" # filled in below, after the sampler is stopped
  fi
fi

[ -n "$SAMPLER_PID" ] && kill "$SAMPLER_PID" 2>/dev/null || true

PEAK_RSS_KB=$(sort -n "$SAMPLE_FILE" 2>/dev/null | tail -1 || echo "")
[ -n "$PEAK_RSS_KB" ] && PEAK_RSS_MB=$((PEAK_RSS_KB / 1024))

echo "[scale-gate] target=$TARGET_PATH exit=$EXIT_CODE timedOut=$TIMED_OUT wallMs=$WALL_MS" \
     "deterministicReadyMs=$DETERMINISTIC_READY_MS peakRssMb=$PEAK_RSS_MB nodes=$NODES edges=$EDGES"

STDERR_TAIL=$(tail -c 500 "$OUTPUT_FILE" | node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync(0,'utf8')))")
OBSERVATION_JSON=$(cat <<JSON
{"observation":{"repoLabel":"$TARGET_PATH","sourceFiles":0,"exitCode":$EXIT_CODE,"timedOut":$TIMED_OUT,"wallMs":$WALL_MS,"deterministicReadyMs":$DETERMINISTIC_READY_MS,"peakRssMb":$PEAK_RSS_MB,"nodes":$NODES,"edges":$EDGES,"stderrTail":$STDERR_TAIL},"budgets":{"maxWallMs":$MAX_WALL_MS,"maxPeakRssMb":$MAX_PEAK_RSS_MB,"minNodes":$MIN_NODES,"maxDeterministicReadyMs":${MAX_DETERMINISTIC_READY_MS}}}
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
printf '| %s | %s | %s | %sms | deterministicReady=%sms | %sMB | %s nodes |\n' \
  "$(date -u +%FT%TZ)" "$STATUS" "$REASONS" "$WALL_MS" "$DETERMINISTIC_READY_MS" "$PEAK_RSS_MB" "$NODES" >> "$LOG_PATH"

if [ "$GATE_EXIT" -ne 0 ]; then
  echo "[scale-gate] FAILED — see $LOG_PATH"
  exit 1
fi

echo "[scale-gate] PASSED"
