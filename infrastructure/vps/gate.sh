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
GATE_TIMEOUT_S="${GATE_TIMEOUT_S:-1800}"

reap_stale_containers() {
  local max_age_min="$1"
  local now age_min cid started

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
    if [ "$age_min" -ge "$max_age_min" ]; then
      echo "==> reaping stale running klauro-gate container $cid (age ${age_min}m >= ${max_age_min}m)" >&2
      docker kill "$cid" >/dev/null 2>&1 || true
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  done
}

reap_stale_containers "$GATE_MAX_AGE_MIN"

REBUILD=0
if [ "${1:-}" = "--rebuild" ]; then
  REBUILD=1
  shift
fi

WORKSPACE="${1:-}"
shift || true
CMD="$*"

if [ -z "$WORKSPACE" ] || [ -z "$CMD" ]; then
  echo "usage: gate.sh [--rebuild] <workspace> <cmd...>" >&2
  exit 2
fi

if [ "$REBUILD" = "1" ] || ! docker image inspect "$GATE_IMAGE" >/dev/null 2>&1; then
  echo "==> building $GATE_IMAGE from $BASE_IMAGE" >&2
  docker build \
    --build-arg BASE_IMAGE="$BASE_IMAGE" \
    -f "$DOCKERFILE_DIR/gate.Dockerfile" \
    -t "$GATE_IMAGE" \
    "$DOCKERFILE_DIR"
fi

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
for cache_dir in "$DEVGATE_DIR/$WORKSPACE/node_modules/.cache" "$DEVGATE_DIR/node_modules/.cache"; do
  mkdir -p "$cache_dir" 2>/dev/null || true
  chmod -R a+rwX "$cache_dir" 2>/dev/null || true
done

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

set +e
timeout --signal=TERM --kill-after=10s "${GATE_TIMEOUT_S}s" \
  docker run --rm --init \
  --cidfile "$CIDFILE" \
  --label "$GATE_LABEL" \
  --user gate \
  -e NODE_ENV=development \
  -e KLAURO_STORAGE_PATH=/tmp/klauro-gate-storage \
  -e KLAURO_REMOTE_ANALYZER_DATA=/tmp/klauro-gate-data \
  -v "$DEVGATE_DIR:/gate" \
  -w "/gate/$WORKSPACE" \
  "$GATE_IMAGE" \
  sh -c "$CMD"
STATUS=$?
set -e

if [ "$STATUS" -eq 124 ] || [ "$STATUS" -eq 137 ]; then
  if [ -s "$CIDFILE" ]; then
    docker kill "$(cat "$CIDFILE")" >/dev/null 2>&1 || true
    docker rm -f "$(cat "$CIDFILE")" >/dev/null 2>&1 || true
  fi
  rm -f "$CIDFILE"
  echo "==> gate.sh: command exceeded GATE_TIMEOUT_S=${GATE_TIMEOUT_S}s, killed and removed" >&2
  exit 124
fi

rm -f "$CIDFILE"
exit "$STATUS"
