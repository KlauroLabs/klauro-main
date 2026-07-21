import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';

/**
 * Deploy-freshness build id: the current commit's short SHA when available
 * (a real deploy — infrastructure/vps/deploy.sh ships a git checkout), else
 * a build-time timestamp (local dev, or a checkout with no .git). Baked in
 * TWO places so a running tab can detect a newer deploy without a hard
 * reload: (1) `define` below makes it a JS constant every bundled chunk can
 * read; (2) buildIdHtmlPlugin stamps the SAME value onto a <meta> tag in
 * index.html, which useDeployFreshness.ts re-fetches (cache-busted) on
 * window focus + an interval and compares against (1). A mismatch means the
 * server's index.html now points at a newer build than the one this tab is
 * running — see src/hooks/useDeployFreshness.ts.
 */
function resolveBuildId(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return `local-${Date.now()}`;
  }
}

function buildIdHtmlPlugin(buildId: string): Plugin {
  return {
    name: 'klauro-build-id-html',
    transformIndexHtml(html) {
      return html.replace('</head>', `    <meta name="klauro-build-id" content="${buildId}" />\n  </head>`);
    },
  };
}

const buildId = resolveBuildId();

export default defineConfig({
  plugins: [react(), buildIdHtmlPlugin(buildId)],
  define: {
    __KLAURO_BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    port: 5174,
  },
});
