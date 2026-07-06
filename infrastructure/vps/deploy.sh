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

for arg in "$@"; do
  case "$arg" in
    --with-release)        WITH_RELEASE="patch" ;;
    --with-release=*)      WITH_RELEASE="${arg#*=}" ;;
    --skip-app-build)      SKIP_APP_BUILD=1 ;;
    --no-verify)           DO_VERIFY=0 ;;
    -h|--help)
      sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)"; exit 2 ;;
  esac
done

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
SSH="sshpass -p $VPS_PASSWORD ssh -o StrictHostKeyChecking=no -o ConnectTimeout=25 $CM_OPTS"
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
rsync -az --exclude node_modules --exclude dist --exclude .git --exclude .pack \
  --exclude logs --exclude docs.zip -e "$SSH" ./ "$DEST:/opt/klauro/source/"
echo "==> Syncing Caddyfile + docker-compose.yml"
rsync -az -e "$SSH" infrastructure/vps/Caddyfile "$DEST:/opt/klauro/Caddyfile"
rsync -az -e "$SSH" infrastructure/vps/docker-compose.yml "$DEST:/opt/klauro/docker-compose.yml"

# --- rebuild + restart -----------------------------------------------------
echo "==> Rebuilding + restarting containers on $VPS_HOST"
$SSH "$DEST" 'cd /opt/klauro && docker compose up -d --build --remove-orphans'

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
echo "==> Deploy verified. $KLAURO_URL is live (dist $DIST_VER)."
