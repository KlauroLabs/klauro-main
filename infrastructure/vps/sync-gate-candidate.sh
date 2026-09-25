#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_DIR"

CANDIDATE_REF="HEAD"
if [ "${1:-}" = "--commit" ]; then
  CANDIDATE_REF="${2:-}"
  [ -n "$CANDIDATE_REF" ] || { echo "ERROR: --commit requires a Git commit." >&2; exit 2; }
elif [ -n "${1:-}" ]; then
  echo "usage: sync-gate-candidate.sh [--commit <commit>]" >&2
  exit 2
fi

if [ "$CANDIDATE_REF" = "HEAD" ] && [ -n "$(git status --porcelain -uall)" ]; then
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

CANDIDATE_SHA="$(git rev-parse "${CANDIDATE_REF}^{commit}")"
CANDIDATE_SHORT_SHA="$(git rev-parse --short=12 "$CANDIDATE_SHA")"
CANDIDATE_TIME="$(git show -s --format=%cI "$CANDIDATE_SHA")"
CANDIDATE_BRANCH="$(git for-each-ref --format='%(refname:short)' --points-at "$CANDIDATE_SHA" refs/heads/ | head -1)"
if [ -z "$CANDIDATE_BRANCH" ] && [ "$CANDIDATE_REF" = "HEAD" ]; then
  echo "ERROR: refusing to sync a detached candidate." >&2
  exit 1
fi
CANDIDATE_SOURCE="${CANDIDATE_BRANCH:-commit $CANDIDATE_SHORT_SHA}"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/klauro-gate-candidate.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
git archive --format=tar "$CANDIDATE_SHA" | tar -x -C "$STAGE"

export SSHPASS="$VPS_PASSWORD"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=25 -o ControlMaster=auto -o ControlPath=/tmp/klauro-cm-%C -o ControlPersist=120"
DEST="$VPS_USER@$VPS_HOST"
EXCLUDES=(
  --exclude node_modules
  --exclude dist
  --exclude dist-hosted
  --exclude dist-sea
  --exclude .pack
  --exclude .customer-package
  --exclude .claude
  --exclude .proof-corpus
  --exclude .proof-output
  --exclude '.klauro-*'
)

$SSH "$DEST" "mkdir -p /opt/klauro/devgate"
rsync -az --delete-delay "${EXCLUDES[@]}" -e "$SSH" "$STAGE/" "$DEST:/opt/klauro/devgate/"
$SSH "$DEST" '
  set -e
  mkdir -p /opt/klauro/.gate-tools
  lock_sha="$(sha256sum /opt/klauro/devgate/package-lock.json | cut -d " " -f 1)"
  dependency_stamp=/opt/klauro/.gate-tools/devgate-package-lock.sha256
  if [ "$(cat "$dependency_stamp" 2>/dev/null || true)" != "$lock_sha" ]; then
    if docker image inspect klauro-gate >/dev/null 2>&1; then
      dependency_image=klauro-gate
    else
      dependency_image=klauro/api:alpha
    fi
    docker run --rm -v /opt/klauro/devgate:/gate -w /gate "$dependency_image" \
      npm ci --include=dev --legacy-peer-deps
    printf "%s" "$lock_sha" > "$dependency_stamp"
  fi
'
$SSH "$DEST" "mkdir -p /opt/klauro/devgate/.proof-output && chmod a+rwx /opt/klauro/devgate/.proof-output"
$SSH "$DEST" "cat > /opt/klauro/devgate/apps/mcp-server/.klauro-build-stamp.json" <<STAMP
{"git_sha":"$CANDIDATE_SHA","build_time":"$CANDIDATE_TIME"}
STAMP

echo "Synced gate candidate $CANDIDATE_SHORT_SHA from $CANDIDATE_SOURCE."
