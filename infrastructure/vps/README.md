# Klauro VPS Deployment

This deployment keeps the product surfaces separate:

- `app.klauro.com`: Caddy serves the built React app from `/opt/klauro/app-dist`.
- `mcp.klauro.com`: Caddy proxies API/analyzer requests to the `api` container.
- `/opt/klauro/data`: persistent account, analysis, revision, and audit data.

## One-stop deploy (preferred)

```bash
npm run deploy                 # build app -> sync -> rebuild containers -> verify live
npm run deploy -- --with-release   # cut the version (bump/pack/upload tarball/tag) THEN deploy
```

`infrastructure/vps/deploy.sh` scripts the full runbook below with fail-loud
verification (`/health`, `/dist` version, tarball HTTP) and a guard that refuses to
ship a `docker-compose.yml` missing the `/opt/klauro/downloads` mount (which would
silently break the install/update channel). Creds come from the repo-root `.env`
(`VPS_HOST`/`VPS_USER`/`VPS_PASSWORD`); requires `sshpass` + `rsync`. Flags:
`--with-release[=patch|minor|major|x.y.z]`, `--skip-app-build`, `--no-verify`,
and `--allow-dirty`. A normal deploy refuses a dirty tree. `--allow-dirty`
creates and retains an exact snapshot commit, then deploys and stamps that
snapshot rather than mixing a working-tree build with committed source.
Override the API base with `KLAURO_URL=` (default `https://mcp.klauro.com`).

## What it does under the hood (manual equivalent)

```bash
# VITE_KLAURO_API_URL must be set at build time — Vite inlines it into the
# bundle. Without it, the built app falls back to window.location.origin
# (app.klauro.com), which serves static files only and has no /api/* routes,
# so every login/register call 405s. See apps/app/.env.example.
VITE_KLAURO_API_URL=https://mcp.klauro.com npm run app:build
rsync -az --delete apps/app/dist/ root@74.208.212.208:/opt/klauro/app-dist/
rsync -az --exclude node_modules --exclude dist --exclude .git ./ root@74.208.212.208:/opt/klauro/source/
rsync -az infrastructure/vps/Caddyfile root@74.208.212.208:/opt/klauro/Caddyfile
rsync -az infrastructure/vps/docker-compose.yml root@74.208.212.208:/opt/klauro/docker-compose.yml
ssh root@74.208.212.208 'cd /opt/klauro && docker compose up -d --build --remove-orphans'
# then, once the recreated api container reports healthy:
ssh root@74.208.212.208 'cd /opt/klauro && docker compose restart caddy'
```

## Known failure: stale Caddy upstream after deploy (defect #24)

**Signature:** shortly after a deploy, `mcp.klauro.com` requests start timing
out (Cloudflare 524) while the api container is completely healthy internally
(`docker exec klauro-api-1 curl -fsS localhost:8787/health` succeeds, `docker
compose logs api` shows no errors). This can last up to ~30 minutes if left
alone. `docker restart klauro-caddy-1` fixes it instantly.

**Root cause:** every deploy runs `docker compose up -d --build`, which
recreates the `api` container with a *new* IP on the internal bridge network.
Caddy's `reverse_proxy` had resolved the `api` hostname to the *old* IP and
kept using it — Docker doesn't reassign the old IP to anything, so requests to
it just hang (no RST), which is what produces a 524 instead of a fast 502.
Caddy itself is never restarted by a deploy (its image/config didn't change),
so nothing forces it to re-resolve.

**Protections now in place:**
1. `Caddyfile` — `mcp.klauro.com` uses a **dynamic `a` upstream**
   (`reverse_proxy { dynamic a { name api; port 8787; resolvers 127.0.0.11;
   refresh 5s } }`) instead of a static `reverse_proxy api:8787`. Caddy
   re-resolves `api` against Docker's embedded DNS (127.0.0.11) every 5s
   instead of caching one address for the process lifetime, so a recreated
   container is picked up automatically within seconds.
2. `docker-compose.yml` — the `api` service has a real `healthcheck`
   (hits its own `/health`), and `caddy` depends on `api` with
   `condition: service_healthy`. This only governs *initial* startup
   ordering (compose won't re-trigger it on an api-only recreate), so it's a
   correctness fix for cold starts, not the recreate case by itself.
3. `deploy.sh` — after `docker compose up -d --build`, the script polls
   `klauro-api-1`'s health status and then runs `docker compose restart
   caddy` once api is healthy. This is deliberate, cheap insurance layered on
   top of (1): even if dynamic resolution has an edge case, every deploy now
   forces Caddy to start fresh connections against the current api IP.

**Manual recovery** (if you ever see the 524 signature outside of a deploy,
e.g. the api container OOM-restarted on its own):
```bash
ssh root@74.208.212.208 'docker restart klauro-caddy-1'
```
Confirm first that api is actually healthy internally before restarting
caddy — restarting caddy while api is genuinely down just changes the error
mode, it doesn't fix anything.

## Devgate (test-in-prod gates)

`/opt/klauro/devgate` on the VPS is a full repo tree (rsynced, `npm install
--include=dev` already run) used to run the real test suites against
production-identical infra — per the run-in-production-only rule, gates run
on the VPS, never on a contributor's Mac.

Running the bare `klauro/api:alpha` image directly against that tree pollutes
results with two environment artifacts that have nothing to do with the code
under test: it has no `git` (anything shelling out to git fails with
`spawnSync git ENOENT`), and it runs as root (permission-bit assertions, e.g.
"permission-denied subdirectories", can never trip since root bypasses every
check). `gate.Dockerfile` builds a small `klauro-gate` image on top of the
current api image that fixes both — adds `git` + `procps`, and renames the
base image's existing uid-1000 `node` user to `gate` so tests run as a real
non-root user with git configured.

**Sync a committed candidate** from the development machine. The sync exports
the exact Git commit into an isolated staging directory, updates devgate, and
stamps the candidate identity used by packaged-product checks. It refuses dirty
or detached working trees so a gate can never describe candidate source as the
currently deployed revision:
```bash
infrastructure/vps/sync-gate-candidate.sh
ssh root@74.208.212.208 'cd /opt/klauro/devgate && npm install --include=dev'
```

`gate.sh --allow-source-mismatch` reads only the candidate stamp. It fails
closed when the candidate has no exact Git SHA and build time; it never falls
back to the deployed build stamp.

**Run a gate** via `gate.sh <workspace> <cmd...>` (builds/rebuilds
`klauro-gate` automatically if missing):
```bash
ssh root@74.208.212.208 'cd /opt/klauro/devgate && \
  infrastructure/vps/gate.sh apps/mcp-server \
  "../../node_modules/.bin/tsx --test src/some.test.ts"'

ssh root@74.208.212.208 'cd /opt/klauro/devgate && \
  infrastructure/vps/gate.sh packages/analyzer-core \
  "node_modules/.bin/jest -t \"some test name\""'
```

**Rebuild after every deploy.** `klauro-gate` is built FROM whatever
`klauro/api:alpha` currently is; a deploy recreates that image, so re-run with
`infrastructure/vps/gate.sh --rebuild <workspace> <cmd...>` (or `docker rmi
klauro-gate`) afterward — otherwise gates silently run against a stale base.

**Known residual artifact:** `KLAURO_STORAGE_PATH=/data/storage` and
`KLAURO_REMOTE_ANALYZER_DATA=/data` are baked into the api image for
production (a real writable bind mount there). The gate container has neither,
so `gate.sh` overrides both to a writable `/tmp/klauro-gate-*` path per run —
without that override, any code path that falls back to the baked default
instead of a test's own override throws `EACCES: permission denied, mkdir
'/data'`.

**Playground ownership:** the very first `npm install --include=dev` on
`/opt/klauro/devgate` ran as root, so some `node_modules/` (and their
`node_modules/.cache`) subtrees are root-owned and not writable by the
non-root `gate` user — jest in particular needs to create its own
`node_modules/.cache/jest` dir. `chown 1000:1000` the affected `node_modules/`
dir once, or re-run the install as a non-root user, rather than repeating this
per gate invocation.

## Spec-purity gate

`deploy.sh` refuses to deploy if benchmark/client corpus names show up in the
product's specs/doctrine docs (`docs/SPEC*.md`, `docs/was/`, `docs/cas/`,
`docs/ARCHITECTURE.md`, `docs/UNDERSTANDING-MODEL.md`,
`docs/COVERAGE-INTELLIGENCE.md`) or in shipped product source
(`packages/analyzer-core/src`, `apps/mcp-server/src`, `*.ts`), skipping
`test`/`tests`/`fixture`/`fixtures`/`__tests__`/`gauntlet`/`bench`/`benchmark`/
`corpus` paths where corpus-specific detail belongs.

Klauro's specs and product source are meant to be product-agnostic — they
describe the analyzer, not any one client's codebase — but comments and doc
prose keep leaking the names of whatever repo was being debugged at the time
straight into permanent product artifacts. This gate runs alongside the
dirty-tree guard, before any VPS interaction, and prints every offending line
with file:line context when it fires.

As of 2026-07-29 (open item #71) the forbidden-name set is no longer a
hand-maintained literal list — it is DERIVED FROM EVIDENCE: real analyzed
project/workspace names known to the account, names already narrated in this
repo's own `test`/`fixture`/`gauntlet`/`bench`/`corpus` paths, and a
fail-closed shape/context heuristic that flags a name never seen before when
it appears in a customer/benchmark-naming sentence (`"the customer repo
<x>"`, `"benchmarked against <x>"`). A hand-typed list only ever caught a name
someone remembered to add; this catches a brand-new one the first time it
shows up. The full policy, its precision tradeoffs, and its tests live in
`apps/mcp-server/src/spec-purity-gate.ts` (invoked via
`apps/mcp-server/src/spec-purity-gate-cli.ts`) — `deploy.sh` just calls it.

As of 2026-07-17 the gate correctly fires against the current tree (a purge
of existing violations is in progress); that is expected until the purge
lands, not a bug in the gate. The evidence-derived gate above additionally
surfaces several real violations the old static list never covered (e.g.
customer/corpus names leaking into `orchestrator.ts` and
`docs/COVERAGE-INTELLIGENCE.md`) — those are real, pre-existing doctrine
violations for a follow-up cleanup, not new breakage from this change.
