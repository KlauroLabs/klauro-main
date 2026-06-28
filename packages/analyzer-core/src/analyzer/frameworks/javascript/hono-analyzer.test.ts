import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HonoAnalyzer } from './hono-analyzer';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hono-analyzer-test-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'hono-fixture', dependencies: { hono: '^4.0.0' } }, null, 2)
  );
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'index.ts'),
    [
      `import { Hono } from 'hono';`,
      `import { logger } from 'hono/logger';`,
      `const app = new Hono();`,
      `const adminApp = new Hono();`,
      `app.use('*', logger());`,
      `app.get('/users', (c) => c.json([]));`,
      `app.post('/users', handler);`,
      `app.route('/admin', adminApp);`,
      ``,
    ].join('\n')
  );
  return dir;
}

test('HonoAnalyzer.canAnalyze returns true for a hono project', async () => {
  const dir = makeProject();
  try {
    const analyzer = new HonoAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HonoAnalyzer.analyze extracts routes, middleware, mounts, and entry points', async () => {
  const dir = makeProject();
  try {
    const analyzer = new HonoAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const routes = cas.nodes!.filter(n => n.type === 'route');
    const getUsers = routes.find(n => n.name === 'GET /users');
    const postUsers = routes.find(n => n.name === 'POST /users');
    assert.ok(getUsers, 'should have route GET /users');
    assert.ok(postUsers, 'should have route POST /users');

    // Both routes are entry points.
    const entryNames = (cas.entry_points || []).map(e => e.name);
    assert.ok(entryNames.includes('GET /users'), 'GET /users should be an entry point');
    assert.ok(entryNames.includes('POST /users'), 'POST /users should be an entry point');

    // Logger middleware.
    const middleware = cas.nodes!.filter(n => n.type === 'middleware');
    const loggerMw = middleware.find(n => n.name === 'logger');
    assert.ok(loggerMw, 'should have logger middleware');

    // /admin mount.
    const mounts = cas.nodes!.filter(n => n.type === 'route_mount');
    const adminMount = mounts.find(n => (n.metadata?.attributes?.prefix as string) === '/admin');
    assert.ok(adminMount, 'should have /admin mount');
    assert.equal(adminMount?.metadata?.attributes?.subApp, 'adminApp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
