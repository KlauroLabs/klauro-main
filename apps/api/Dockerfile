FROM node:22-bookworm-slim AS runtime

# Deploy-path-independent build stamp: infrastructure/vps/docker-compose.yml
# wires these through to `docker compose build` from the invoking shell's own
# git checkout (real .git is always available THERE — a fresh dev worktree,
# deploy.sh's $APP_DIR, or any ad hoc build path — even though .git itself is
# excluded from this image's build context, see .dockerignore). Both default
# to empty so a build that doesn't pass them (or an older invocation) degrades
# to the "unknown"-stamped-but-honest state below rather than failing.
ARG KLAURO_GIT_SHA=""
ARG KLAURO_BUILD_TIME=""

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/mcp-server/package.json ./apps/mcp-server/package.json
COPY packages/analyzer-core/package.json ./packages/analyzer-core/package.json

RUN npm ci \
  --workspace @klauro/api \
  --workspace @klauro/mcp-server \
  --workspace @klauro/analyzer-core \
  --include-workspace-root=false \
  --legacy-peer-deps \
  && npm cache clean --force

COPY apps/api ./apps/api
COPY apps/mcp-server ./apps/mcp-server
COPY packages/analyzer-core ./packages/analyzer-core
# @klauro/telemetry SDK is imported by relative path (self-telemetry.ts, env-gated);
# zero runtime deps, run from source via tsx — just needs to be present in the image.
COPY packages/klauro-sdk-js ./packages/klauro-sdk-js

# If deploy.sh (or any other path) already wrote a real stamp onto the host
# tree before this build ran, .dockerignore's negation lets it survive the
# COPY above — keep it untouched, it's the most trustworthy source (the
# HOST's own guaranteed-clean checkout). Otherwise write one now, from the
# ARGs above, so the image is never unstamped regardless of which deploy path
# produced it.
RUN set -eu; \
  STAMP=apps/mcp-server/.klauro-build-stamp.json; \
  if [ -s "$STAMP" ]; then \
    echo "==> build stamp already present on host tree, keeping it: $(cat "$STAMP")"; \
  else \
    SHA="${KLAURO_GIT_SHA:-unknown}"; \
    TIME="${KLAURO_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"; \
    printf '{"git_sha": "%s", "build_time": "%s"}' "$SHA" "$TIME" > "$STAMP"; \
    echo "==> image-build-time stamp written: $SHA @ $TIME"; \
  fi

WORKDIR /app/apps/api

ENV NODE_ENV=production
ENV KLAURO_REMOTE_ANALYZER_DATA=/data
ENV KLAURO_STORAGE_PATH=/data/storage
ENV KLAURO_ANALYZER_PORT=8787
ENV KLAURO_ANALYZER_RATE_LIMIT_PER_MINUTE=120
ENV NODE_OPTIONS=--max-old-space-size=6144

EXPOSE 8787

# Exec-form tsx DIRECTLY — `npm run` wraps the process so PID 1 signals
# (SIGTERM from docker stop / recreate) don't reach the node process, which
# both defeats the graceful-shutdown handler in src/index.ts and makes npm
# report a non-zero exit when its child dies by signal (defect #24 companion).
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
