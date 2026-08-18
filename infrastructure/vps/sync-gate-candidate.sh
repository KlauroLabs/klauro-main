#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_DIR"

if [ -n "$(git status --porcelain -uall)" ]; then
  echo "ERROR: refusing to sync an uncommitted candidate." >&2
  exit 1
fi

if [ -f "$APP_DIR/.env" ]; then
  set -a
  . "$APP_DIR/.env"
  set +a
fi
if [ -z "${VPS_HOST:-}" ] || [ -z "${VPS_USER:-}" ] || [ -z "${VPS_PASSWORD:-}" ]; then
  echo "ERROR: VPS_HOST, VPS_USER, and VPS_PASSWORD are required." >&2
  exit 1
fi
command -v sshpass >/dev/null || { echo "ERROR: sshpass is required." >&2; exit 1; }
command -v rsync >/dev/null || { echo "ERROR: rsync is required." >&2; exit 1; }

CANDIDATE_SHA="$(git rev-parse HEAD)"
CANDIDATE_SHORT_SHA="$(git rev-parse --short=12 "$CANDIDATE_SHA")"
CANDIDATE_TIME="$(git show -s --format=%cI "$CANDIDATE_SHA")"
CANDIDATE_BRANCH="$(git branch --show-current)"
if [ -z "$CANDIDATE_BRANCH" ]; then
  echo "ERROR: refusing to sync a detached candidate." >&2
  exit 1
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/klauro-gate-candidate.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
git archive --format=tar "$CANDIDATE_SHA" | tar -x -C "$STAGE"

export SSHPASS="$VPS_PASSWORD"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=25"
DEST="$VPS_USER@$VPS_HOST"
EXCLUDES=(
  --exclude node_modules
  --exclude dist
  --exclude dist-hosted
  --exclude dist-sea
  --exclude .pack
  --exclude .customer-package
  --exclude .claude
  --exclude .proof-output
  --exclude '.klauro-*'
)

$SSH "$DEST" "mkdir -p /opt/klauro/devgate"
rsync -az --delete-delay "${EXCLUDES[@]}" -e "$SSH" "$STAGE/" "$DEST:/opt/klauro/devgate/"
$SSH "$DEST" "mkdir -p /opt/klauro/devgate/.proof-output && chmod a+rwx /opt/klauro/devgate/.proof-output"
$SSH "$DEST" "cat > /opt/klauro/devgate/apps/mcp-server/.klauro-build-stamp.json" <<STAMP
{"git_sha":"$CANDIDATE_SHORT_SHA","build_time":"$CANDIDATE_TIME"}
STAMP

echo "Synced gate candidate $CANDIDATE_SHORT_SHA from $CANDIDATE_BRANCH."
