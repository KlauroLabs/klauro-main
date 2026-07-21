jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { ExpressAnalyzer } from '../../analyzer/frameworks/web/express-analyzer';

/**
 * Regression test for a real blackbox gap found while validating Express
 * route -> handler resolution end-to-end against a real repo
 * (~/dev/soon/fortress-dashboard-api). That app imports Express as
 * `import * as express from 'express';` (a common TypeScript namespace-import
 * form, e.g. with esModuleInterop off or an older tsconfig) instead of the
 * default-import form `import express from 'express';`.
 *
 * `ExpressAnalyzer.canAnalyze`'s import-detection regex only matched the
 * default-import form (`/^\s*import\s+express\b.*\bfrom\s+['"]express['"]/m`),
 * so it silently returned false for this real app — 0 entry_points, 0
 * route_table rows, despite 3 real `app.get(...)` routes in the source. Fix:
 * the regex now also matches `import * as X from 'express'` and
 * `import { Router } from 'express'` forms.
 */
describe('ExpressAnalyzer.canAnalyze import-form detection', () => {
  let root: string;
  let analyzer: ExpressAnalyzer;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-express-import-forms-'));
    analyzer = new ExpressAnalyzer();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (relative: string, content: string) => {
    const full = path.join(root, relative);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  };

  const writePackageJson = async () => {
    await write('package.json', JSON.stringify({
      name: 'express-import-form-app',
      dependencies: { express: '^4.18.2' },
    }));
  };

  it('detects a default-import Express app (baseline)', async () => {
    await writePackageJson();
    await write('src/server.ts', [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (req, res) => res.json({ ok: true }));",
    ].join('\n'));

    expect(await analyzer.canAnalyze(root)).toBe(true);
  });

  it('detects a namespace-import Express app (import * as express) — the real-world gap', async () => {
    await writePackageJson();
    await write('src/server.ts', [
      "import * as express from 'express';",
      'const app = express();',
      "app.get('/health', (req, res) => res.json({ ok: true }));",
    ].join('\n'));

    expect(await analyzer.canAnalyze(root)).toBe(true);
  });

  it('detects a destructured-import Express app (import { Router })', async () => {
    await writePackageJson();
    await write('src/router.ts', [
      "import { Router } from 'express';",
      'const router = Router();',
      "router.get('/health', (req, res) => res.json({ ok: true }));",
    ].join('\n'));

    expect(await analyzer.canAnalyze(root)).toBe(true);
  });

  it('still detects a CJS require() Express app', async () => {
    await writePackageJson();
    await write('src/server.js', [
      "const express = require('express');",
      'const app = express();',
      "app.get('/health', (req, res) => res.json({ ok: true }));",
    ].join('\n'));

    expect(await analyzer.canAnalyze(root)).toBe(true);
  });

  it('resolves top-level app.get() routes to their real handler function node end-to-end (namespace import)', async () => {
    await writePackageJson();
    await write('src/server.ts', [
      "import * as express from 'express';",
      'const app = express();',
      '',
      "app.get('/transactions', async (req, res, next) => {",
      "  return await processRequest('transactions', req, res, next);",
      '});',
      '',
      'app.listen(3000);',
      '',
      'async function processRequest(endpoint, req, res, next) {',
      '  return res.json({ endpoint });',
      '}',
    ].join('\n'));

    expect(await analyzer.canAnalyze(root)).toBe(true);

    const context = {
      projectPath: root,
      files: [],
      config: {},
    } as any;
    const contribution = await analyzer.analyze(context);

    const httpEntries = (contribution.entry_points || []).filter(ep => ep.type === 'http');
    expect(httpEntries.length).toBeGreaterThan(0);

    const routeEntry = httpEntries.find(ep => ep.trigger?.method === 'GET' && ep.trigger?.path === '/transactions');
    expect(routeEntry).toBeDefined();
    expect(routeEntry?.handler?.node_id).toBeDefined();
  });
});

/**
 * Regression: `router.get(\`/oauth/${provider}/callback\`, ...)` (a
 * backtick-delimited template-literal route path) used to leak the raw,
 * unresolved `${provider}` expression verbatim into the route's
 * name/trigger.path (`GET /oauth/${provider}/callback`) — the same
 * "hash/expression-shaped tokens leak into labels" class already fixed
 * elsewhere for id-shaped basenames. The route path must render as an honest
 * Express-style param pattern instead (`GET /oauth/:provider/callback`).
 */
describe('ExpressAnalyzer template-literal route path normalization', () => {
  let root: string;
  let analyzer: ExpressAnalyzer;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-express-template-route-'));
    analyzer = new ExpressAnalyzer();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('renders a template-literal route path as an honest :param pattern, not the raw expression', async () => {
    await fs.writeJson(path.join(root, 'package.json'), {
      name: 'oauth-app',
      dependencies: { express: '^4.18.2' },
    });
    await fs.ensureDir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'server.ts'), [
      "import express from 'express';",
      'const app = express();',
      '',
      'app.get(`/oauth/${provider}/callback`, (req, res) => {',
      '  return res.json({ ok: true });',
      '});',
    ].join('\n'));

    expect(await analyzer.canAnalyze(root)).toBe(true);
    const contribution = await analyzer.analyze({ projectPath: root, files: [], config: {} } as any);

    const httpEntries = (contribution.entry_points || []).filter(ep => ep.type === 'http');
    const routeEntry = httpEntries.find(ep => ep.trigger?.method === 'GET');
    expect(routeEntry).toBeDefined();
    expect(routeEntry?.trigger?.path).toBe('/oauth/:provider/callback');
    expect(routeEntry?.name).toBe('GET /oauth/:provider/callback');
    expect(routeEntry?.trigger?.path).not.toContain('${');
    expect(routeEntry?.name).not.toContain('${');
  });
});
