FROM rust:1.88-bookworm AS native-parser-builder

WORKDIR /build/klauro-parse

COPY packages/analyzer-core/native/klauro-parse/Cargo.toml packages/analyzer-core/native/klauro-parse/Cargo.lock ./
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs && cargo build --release && rm -rf src
COPY packages/analyzer-core/native/klauro-parse/src ./src
RUN touch src/main.rs && cargo build --release

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ zstd \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/mcp-server/package.json ./apps/mcp-server/package.json
COPY packages/analyzer-core/package.json ./packages/analyzer-core/package.json

# The two workspaces declare a `postinstall` that verifies the native tree-sitter
# addon actually loaded — a guard added because `npm ci` silently skips a
# dependency's own build scripts under npm's install-scripts allowlist, leaving an
# install that parses NOTHING while reporting success (zero nodes, errors: 0).
#
# Those scripts must be present BEFORE `npm ci` runs, or npm fails with
# MODULE_NOT_FOUND on its own lifecycle hook and the image build dies — which is
# exactly what happened the first time. Copied here, alongside the manifests,
# rather than with the source below, because the whole point of this COPY block is
# that it changes rarely and keeps the expensive install layer cached.
#
# Keep the guard firing in the image build: this image runs the analyzer, so an
# image whose parser is broken should fail loudly at build time, not serve empty
# analyses in production.
COPY packages/analyzer-core/scripts/verify-native-parser.cjs ./packages/analyzer-core/scripts/verify-native-parser.cjs
COPY apps/mcp-server/scripts/verify-native-parser.cjs ./apps/mcp-server/scripts/verify-native-parser.cjs

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
COPY --from=native-parser-builder /build/klauro-parse/target/release/klauro-parse /app/packages/analyzer-core/native/klauro-parse/target/release/klauro-parse
# @klauro/telemetry SDK is imported by relative path (self-telemetry.ts, env-gated);
# zero runtime deps, run from source via tsx — just needs to be present in the image.
COPY packages/klauro-sdk-js ./packages/klauro-sdk-js

# Worker threads execute analyzer-core's compiled CommonJS worker. Running the
# source .ts worker through tsx made production depend on ESM extension
# resolution inside every worker and silently fell back to sequential parsing.
RUN npm run build --workspace @klauro/analyzer-core

# Keep release-varying stamp arguments below dependency installation and the
# analyzer build so a new git SHA cannot invalidate apt/npm cache layers.
ARG KLAURO_GIT_SHA=""
ARG KLAURO_BUILD_TIME=""

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
