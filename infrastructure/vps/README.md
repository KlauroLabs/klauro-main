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
```
