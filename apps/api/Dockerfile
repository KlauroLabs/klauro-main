FROM node:22-bookworm-slim AS runtime

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
