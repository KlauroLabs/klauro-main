import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { KemalAnalyzer } from './kemal-analyzer';

/** Write a throwaway Kemal project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kemal-test-'));
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
    const analyzer = new KemalAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'analyzer should detect the kemal project');
    const contribution = await analyzer.analyze({ projectPath: dir } as any);
    return (contribution.entry_points || []).map(ep => ({
      key: `${ep.trigger?.method} ${ep.trigger?.path}`,
      auth: ep.security?.authenticated,
      type: ep.type,
      ws: ep.metadata?.websocket,
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

test('kemal: extracts method + path from top-level route macros', async () => {
  const routes = await routesOf({
    'src/app.cr': `require "kemal"

get "/" do
  "home"
end

post "/users" do |env|
  env.params.json
end

put "/users/:id" do |env|
  "updated"
end

patch "/users/:id" do |env|
  "patched"
end

delete "/users/:id" do |env|
  "deleted"
end

Kemal.run
`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.ok(keys.has('GET /'), `got ${JSON.stringify([...keys])}`);
  assert.ok(keys.has('POST /users'), 'POST literal');
  assert.ok(keys.has('PUT /users/:id'), 'PUT param route, :id kept verbatim');
  assert.ok(keys.has('PATCH /users/:id'), 'PATCH route');
  assert.ok(keys.has('DELETE /users/:id'), 'DELETE route');
});

test('kemal: ws macro maps to a GET route; before_all/Kemal.run excluded', async () => {
  const routes = await routesOf({
    'src/app.cr': `require "kemal"

before_all do |env|
  env.response.content_type = "application/json"
end

ws "/socket" do |socket|
  socket.send "hi"
end

Kemal.run
`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));
  assert.equal(routes.length, 1, `only the ws route should be emitted, got ${JSON.stringify(routes)}`);
  const socket = byKey.get('GET /socket');
  assert.ok(socket, 'ws route mapped to GET');
  assert.equal(socket!.ws, true, 'ws route flagged websocket in metadata');
});

test('kemal: auth is honestly false (cross-cutting before_all/middleware)', async () => {
  const routes = await routesOf({
    'src/app.cr': `require "kemal"

before_all do |env|
  authenticate!(env)
end

get "/me" do |env|
  "me"
end

Kemal.run
`,
  });
  const me = routes.find(r => r.key === 'GET /me');
  assert.ok(me, 'route present');
  assert.equal(me!.auth, false, 'Kemal auth is cross-cutting; not attributed per-route');
});

test('kemal: bench fixture extracts all routes with F1=1.0 vs truth.json', async () => {
  const fixtureDir = path.resolve(
    __dirname, '../../../../../../apps/mcp-server/fixtures/framework-bench/kemal-routes'
  );
  const truth = JSON.parse(
    await fs.readFile(path.join(fixtureDir, 'truth.json'), 'utf-8')
  ).true_routes as string[];

  const analyzer = new KemalAnalyzer();
  assert.equal(await analyzer.canAnalyze(fixtureDir), true, 'should detect fixture as kemal');
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

  // Auth honesty: every Kemal route is auth:false.
  for (const ep of contribution.entry_points || []) {
    assert.equal(ep.security?.authenticated, false, `${ep.trigger?.method} ${ep.trigger?.path} must be auth:false`);
  }
});
