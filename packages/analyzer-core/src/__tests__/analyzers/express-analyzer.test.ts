jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { ExpressAnalyzer } from '../../analyzer/frameworks/web/express-analyzer';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import {
  deriveLocalPackageImportContext,
  LOCAL_PACKAGE_IMPORT_CONTEXT_PATH,
} from '../../analyzer/core/local-package-import-context';

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

describe('ExpressAnalyzer finite controller route generation', () => {
  let workspace: string;
  let project: string;
  let analyzer: ExpressAnalyzer;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-express-generated-routes-'));
    project = path.join(workspace, 'examples', 'mvc');
    analyzer = new ExpressAnalyzer();
    await fs.writeJson(path.join(workspace, 'package.json'), { name: 'express' });
    await fs.ensureDir(path.join(project, 'lib'));
    await fs.ensureDir(path.join(project, 'controllers', 'user'));
    await fs.ensureDir(path.join(project, 'controllers', 'user-pet'));
    await fs.writeFile(path.join(project, 'index.js'), [
      "var express = require('../..');",
      'var app = module.exports = express();',
      "require('./lib/boot')(app);",
      'app.listen(3000);',
    ].join('\n'));
    await fs.writeFile(path.join(project, 'lib', 'boot.js'), [
      "var express = require('../../..');",
      'module.exports = function(parent) {',
      '  var obj = {};',
      '  var name = obj.name || "user";',
      '  var app = express();',
      '  var handler;',
      '  var method;',
      '  var url;',
      '  for (var key in obj) {',
      '    switch (key) {',
      "      case 'show': method = 'get'; url = '/' + name + '/:' + name + '_id'; break;",
      "      case 'list': method = 'get'; url = '/' + name + 's'; break;",
      "      case 'update': method = 'put'; url = '/' + name + '/:' + name + '_id'; break;",
      "      case 'create': method = 'post'; url = '/' + name; break;",
      '      default: throw new Error(key);',
      '    }',
      '    handler = obj[key];',
      '    if (obj.before) app[method](url, obj.before, handler);',
      '    else app[method](url, handler);',
      '  }',
      '  parent.use(app);',
      '};',
    ].join('\n'));
    await fs.writeFile(path.join(project, 'controllers', 'user', 'index.js'), [
      'exports.before = function(req, res, next) { next(); };',
      'exports.list = function(req, res) { res.send([]); };',
      'exports.show = function(req, res) { res.send({}); };',
      'exports.update = function(req, res) { res.send({}); };',
    ].join('\n'));
    await fs.writeFile(path.join(project, 'controllers', 'user-pet', 'index.js'), [
      "exports.name = 'pet';",
      "exports.prefix = '/user/:user_id';",
      'exports.create = function(req, res) { res.send({}); };',
    ].join('\n'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('resolves a relative local framework package and materializes finite generated routes', async () => {
    expect(await analyzer.canAnalyze(project)).toBe(true);
    const contribution = await analyzer.analyze({ projectPath: project, files: [], config: {} } as any);
    const entries = contribution.entry_points || [];
    const routes = entries.map(entry => `${entry.trigger?.method} ${entry.trigger?.path}`).sort();

    expect(routes).toEqual([
      'GET /user/:user_id',
      'GET /users',
      'POST /user/:user_id/pet',
      'PUT /user/:user_id',
    ]);
    expect(entries.find(entry => entry.trigger?.path === '/users')?.handler?.file).toBe('controllers/user/index.js');
    expect(entries.find(entry => entry.trigger?.path === '/users')?.security?.authenticated).toBe(false);
    expect(entries.find(entry => entry.trigger?.path === '/users')?.security?.guards).toEqual([]);
  });

  it('selects the framework from transported local package identity', async () => {
    const sourcePaths = [
      'index.js',
      'lib/boot.js',
      'controllers/user/index.js',
      'controllers/user-pet/index.js',
    ];
    const context = await deriveLocalPackageImportContext(project, await Promise.all(sourcePaths.map(async sourcePath => ({
      path: sourcePath,
      content: await fs.readFile(path.join(project, sourcePath), 'utf8'),
    }))));
    const transported = path.join(workspace, 'transported');
    await fs.copy(project, transported);
    await fs.outputJson(path.join(transported, LOCAL_PACKAGE_IMPORT_CONTEXT_PATH), context);

    const orchestrator = new AnalyzerOrchestrator();
    orchestrator.registerAnalyzer({
      id: 'express',
      name: 'Express.js Analyzer',
      type: 'framework',
      version: '1.0.0',
      detectPatterns: { dependencies: ['express'], files: ['package.json'] },
      analyzer: new ExpressAnalyzer(),
    });

    const detected = await orchestrator.detectAnalyzers(transported);
    expect(detected.map(registration => registration.id)).toContain('express');
  });
});
