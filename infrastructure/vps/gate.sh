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
DOCKERFILE_DIR="$(cd "$(dirname "$0")" && pwd)"

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

exec docker run --rm \
  --user gate \
  -e NODE_ENV=development \
  -e KLAURO_STORAGE_PATH=/tmp/klauro-gate-storage \
  -e KLAURO_REMOTE_ANALYZER_DATA=/tmp/klauro-gate-data \
  -v "$DEVGATE_DIR:/gate" \
  -w "/gate/$WORKSPACE" \
  "$GATE_IMAGE" \
  sh -c "$CMD"
