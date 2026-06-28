import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { DreamAnalyzer } from './dream-analyzer';

/** Write a throwaway Dream project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

async function routesOf(files: Record<string, string>) {
  const dir = await fixture(files);
  try {
    const analyzer = new DreamAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'analyzer should detect the dream project');
    const contribution = await analyzer.analyze({ projectPath: dir } as any);
    return (contribution.entry_points || []).map(ep => ({
      key: `${ep.trigger?.method} ${ep.trigger?.path}`,
      auth: ep.security?.authenticated,
      type: ep.type,
      handler: ep.metadata?.handler,
    }));
  } finally {
    await fs.remove(dir);
  }
}

function f1(predicted: string[], truth: string[]): number {
  const p = new Set(predicted);
  const t = new Set(truth);
  let tp = 0;
  for (const x of p) if (t.has(x)) tp++;
  const precision = p.size ? tp / p.size : 0;
  const recall = t.size ? tp / t.size : 0;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

test('dream: extracts method + path from Dream.router applications', async () => {
  const routes = await routesOf({
    'bin/main.ml': `let () =
  Dream.run
  @@ Dream.logger
  @@ Dream.router [
    Dream.get    "/"           home;
    Dream.post   "/users"      create_user;
    Dream.put    "/users/:id"  update_user;
    Dream.patch  "/users/:id"  patch_user;
    Dream.delete "/users/:id"  destroy_user;
  ]
`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.ok(keys.has('GET /'), `got ${JSON.stringify([...keys])}`);
  assert.ok(keys.has('POST /users'), 'POST literal');
  assert.ok(keys.has('PUT /users/:id'), 'PUT param route, :id kept verbatim');
  assert.ok(keys.has('PATCH /users/:id'), 'PATCH route');
  assert.ok(keys.has('DELETE /users/:id'), 'DELETE route');
});

test('dream: Dream.scope prefixes nested routes; Dream.run/logger/router excluded', async () => {
  const routes = await routesOf({
    'bin/main.ml': `let () =
  Dream.run
  @@ Dream.router [
    Dream.get "/" home;
    Dream.scope "/api" [ auth_middleware ] [
      Dream.get "/health" health;
      Dream.get "/users/:id" show_user;
    ];
  ]
`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.equal(routes.length, 3, `expected 3 routes, got ${JSON.stringify(routes)}`);
  assert.ok(keys.has('GET /'), 'root route');
  assert.ok(keys.has('GET /api/health'), 'scope prefix applied to nested route');
  assert.ok(keys.has('GET /api/users/:id'), 'scope prefix applied + :id kept');
});

test('dream: handler name is extracted from the handler arg', async () => {
  const routes = await routesOf({
    'bin/main.ml': `let () =
  Dream.router [
    Dream.get "/" home_handler;
  ]
`,
  });
  const root = routes.find(r => r.key === 'GET /');
  assert.ok(root, 'route present');
  assert.equal(root!.handler, 'home_handler', 'handler arg name extracted');
});

test('dream: auth is honestly false (cross-cutting scope middleware)', async () => {
  const routes = await routesOf({
    'bin/main.ml': `let () =
  Dream.router [
    Dream.scope "/api" [ Dream.origin_referrer_check; auth_middleware ] [
      Dream.get "/me" me_handler;
    ];
  ]
`,
  });
  const me = routes.find(r => r.key === 'GET /api/me');
  assert.ok(me, 'route present');
  assert.equal(me!.auth, false, 'Dream auth is cross-cutting scope middleware; not attributed per-route');
});

test('dream: bench fixture extracts all routes with F1=1.0 vs truth.json', async () => {
  const fixtureDir = path.resolve(
    __dirname, '../../../../../../apps/mcp-server/fixtures/framework-bench/dream-routes'
  );
  const truth = JSON.parse(
    await fs.readFile(path.join(fixtureDir, 'truth.json'), 'utf-8')
  ).true_routes as string[];

  const analyzer = new DreamAnalyzer();
  assert.equal(await analyzer.canAnalyze(fixtureDir), true, 'should detect fixture as dream');
  const contribution = await analyzer.analyze({ projectPath: fixtureDir } as any);
  const predicted = (contribution.entry_points || [])
    .filter(ep => ep.type === 'http')
    .map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`);

  const score = f1(predicted, truth);
  assert.equal(
    score, 1.0,
    `F1 must be 1.0.\n  predicted=${JSON.stringify(predicted.sort())}\n  truth=${JSON.stringify([...truth].sort())}`
  );

  // Exact string-set match (no extra, no missing).
  assert.deepEqual(
    [...new Set(predicted)].sort(),
    [...truth].sort(),
    'predicted route set must exactly equal truth'
  );

  // Auth honesty: every Dream route is auth:false.
  for (const ep of contribution.entry_points || []) {
    assert.equal(ep.security?.authenticated, false, `${ep.trigger?.method} ${ep.trigger?.path} must be auth:false`);
  }
});
