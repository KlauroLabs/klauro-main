# Klauro Marketing Site

Static Klauro marketing site intended for Cloudflare Pages.

The current visual/content reference is the temporary Framer preview:

https://warm-department-193496.framer.app/

## Local

```bash
npm --prefix apps/marketing-site run build
npm --prefix apps/marketing-site run check
npm --prefix apps/marketing-site run dev
```

## Cloudflare Pages

Recommended settings:

- Framework preset: `None`
- Root directory: `apps/marketing-site`
- Build command: `npm run build`
- Build output directory: `dist`

If Cloudflare is configured from the monorepo root instead:

- Build command: `npm --prefix apps/marketing-site run build`
- Build output directory: `apps/marketing-site/dist`

For a direct Wrangler deploy from this folder:

```bash
npm run build
npx wrangler pages deploy dist
```

The contact form posts to FormSubmit for `mike.shattuck@klauro.com`. The first live submission may require confirming that email address with FormSubmit.
