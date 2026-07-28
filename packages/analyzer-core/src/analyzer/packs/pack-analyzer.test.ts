import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PackAnalyzer } from './pack-analyzer';

/**
 * End-to-end proof: a declared pack (YAML + tree-sitter query) produces real
 * CAS entry_points on a real fixture, matching ground truth exactly, and a
 * pack whose applies_when gate does not match contributes nothing (never
 * fabricated). Also proves a broken tree-sitter query degrades to a
 * rule-scoped error, not a crash, and the good packs alongside it still run.
 *
 * Uses node:test (like hono-analyzer.test.ts) rather than jest — the jest
 * suite's global setup.ts mocks fs/fs-extra/glob wholesale, which is wrong
 * for a real-fixture-on-disk end-to-end proof.
 */
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('PackAnalyzer emits real http entry_points from the built-in koa-routes pack on a Koa fixture', async () => {
  const dir = makeTempDir('klauro-pack-koa-');
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { koa: '^2.14.0', '@koa/router': '^12.0.0' } }, null, 2),
    );
    fs.writeFileSync(
      path.join(dir, 'routes.ts'),
      [
        "import Koa from 'koa';",
        "import Router from '@koa/router';",
        'const router = new Router();',
        "router.get('/users/:id', getUserHandler);",
        "router.post('/users', createUserHandler);",
        'function getUserHandler() {}',
        'function createUserHandler() {}',
        '',
      ].join('\n'),
    );

    const analyzer = new PackAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);

    const contribution = await analyzer.analyze({ projectPath: dir });
    const routes = (contribution.entry_points || []).map(e => ({
      method: e.trigger?.method,
      path: e.trigger?.path,
      handler: e.handler?.method_name,
    }));

    assert.equal(routes.length, 2);
    assert.ok(routes.some(r => r.method === 'get' && r.path === '/users/:id' && r.handler === 'getUserHandler'));
    assert.ok(routes.some(r => r.method === 'post' && r.path === '/users' && r.handler === 'createUserHandler'));
    assert.ok(analyzer.lastDiagnostics.packsApplied.includes('koa-routes'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PackAnalyzer emits real http entry_points from the built-in hapi-routes pack (community, un-coded framework)', async () => {
  const dir = makeTempDir('klauro-pack-hapi-');
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { '@hapi/hapi': '^21.3.0' } }, null, 2),
    );
    fs.writeFileSync(
      path.join(dir, 'server.ts'),
      [
        "import Hapi from '@hapi/hapi';",
        "const server = Hapi.server({ port: 3000 });",
        "server.route({ method: 'GET', path: '/items/{id}', handler: getItemHandler });",
        "server.route({ method: 'POST', path: '/items', handler: createItemHandler });",
        'function getItemHandler() {}',
        'function createItemHandler() {}',
        '',
      ].join('\n'),
    );

    const analyzer = new PackAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir });
    const routes = (contribution.entry_points || []).map(e => ({
      method: e.trigger?.method,
      path: e.trigger?.path,
      handler: e.handler?.method_name,
    }));

    assert.equal(routes.length, 2);
    assert.ok(routes.some(r => r.method === 'GET' && r.path === '/items/{id}' && r.handler === 'getItemHandler'));
    assert.ok(routes.some(r => r.method === 'POST' && r.path === '/items' && r.handler === 'createItemHandler'));
    assert.ok(analyzer.lastDiagnostics.packsApplied.includes('hapi-routes'));
    // Cross-gating: the Koa pack must NOT fire on a Hapi-only repo.
    assert.ok(!analyzer.lastDiagnostics.packsApplied.includes('koa-routes'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PackAnalyzer never fabricates facts when applies_when finds no evidence', async () => {
  const dir = makeTempDir('klauro-pack-none-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: {} }));
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export function noop() {}\n');

    const analyzer = new PackAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir });

    assert.equal((contribution.entry_points || []).length, 0);
    assert.equal(analyzer.lastDiagnostics.packsApplied.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PackAnalyzer degrades a bad tree-sitter query to a rule-scoped error, not a crash, and other packs keep working', async () => {
  const dir = makeTempDir('klauro-pack-badquery-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { koa: '^2.14.0' } }));
    fs.writeFileSync(path.join(dir, 'routes.ts'), "router.get('/users/:id', getUserHandler);\nfunction getUserHandler() {}\n");

    const packDir = path.join(dir, 'klauro-packs');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(
      path.join(packDir, 'broken.pack.yaml'),
      [
        'pack: broken-pack',
        'language: typescript',
        'applies_when: {}',
        'rules:',
        '  - name: broken-rule',
        '    query: "(this is not a valid s-expression !!!"',
        '    emit:',
        '      - fact: entry_point',
        '        kind: http',
        '        path: "@nonexistent"',
        '',
      ].join('\n'),
    );

    const analyzer = new PackAnalyzer();
    analyzer.localPackGlobs = ['klauro-packs/*.pack.yaml'];

    const contribution = await analyzer.analyze({ projectPath: dir }); // must not throw
    assert.ok(analyzer.lastDiagnostics.ruleErrors.some(e => e.pack === 'broken-pack' && e.rule === 'broken-rule'));
    // The good koa-routes pack still ran and produced its real fact.
    assert.ok(contribution.entry_points?.some(e => e.handler?.method_name === 'getUserHandler'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PackAnalyzer reports a clear, field-specific error for a schema-invalid pack file without crashing', async () => {
  const dir = makeTempDir('klauro-pack-badschema-');
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: {} }));
    const packDir = path.join(dir, 'klauro-packs');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'invalid.pack.yaml'), 'pack: invalid-pack\n');

    const analyzer = new PackAnalyzer();
    analyzer.localPackGlobs = ['klauro-packs/*.pack.yaml'];

    const contribution = await analyzer.analyze({ projectPath: dir }); // must not throw
    assert.ok(analyzer.lastDiagnostics.loadErrors.some(e => e.errors.some(msg => msg.includes('language'))));
    assert.equal((contribution.entry_points || []).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
