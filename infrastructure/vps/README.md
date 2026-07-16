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
`--with-release[=patch|minor|major|x.y.z]`, `--skip-app-build`, `--no-verify`.
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
