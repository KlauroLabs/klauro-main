import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GenieAnalyzer } from './genie-analyzer';

/** Write a throwaway Genie project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-test-'));
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
    const analyzer = new GenieAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'analyzer should detect the Genie project');
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

test('genie: extracts method + path from route() DSL and @get macro', async () => {
  const routes = await routesOf({
    'src/routes.jl': `using Genie, Genie.Router
route("/") do
  "home"
end
route("/users", users_index)
route("/users/:id", show_user)
route("/users", create_user, method = POST)
route("/users/:id", delete_user, method = DELETE)
@get("/about", about)
`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.ok(keys.has('GET /'), `got ${JSON.stringify([...keys])}`);
  assert.ok(keys.has('GET /users'), 'default GET');
  assert.ok(keys.has('GET /users/:id'), 'keeps :id param');
  assert.ok(keys.has('POST /users'), 'method = POST keyword');
  assert.ok(keys.has('DELETE /users/:id'), 'method = DELETE keyword');
  assert.ok(keys.has('GET /about'), '@get macro form');
});

test('genie: every route is auth:false (middleware-level auth, honest)', async () => {
  const routes = await routesOf({
    'src/routes.jl': `using Genie
route("/secret", secret_handler)
`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));
  assert.equal(byKey.get('GET /secret')!.auth, false, 'no per-route guard -> auth:false');
});

test('genie: handler name resolves from positional arg and do-block', async () => {
  const routes = await routesOf({
    'src/routes.jl': `using Genie
route("/users", users_index)
route("/") do
  "home"
end
`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));
  assert.equal(byKey.get('GET /users')!.handler, 'users_index');
  assert.equal(byKey.get('GET /')!.handler, 'closure');
});

test('genie: bench fixture extracts all routes with F1=1.0 vs truth.json', async () => {
  const fixtureDir = path.resolve(
    __dirname, '../../../../../../apps/mcp-server/fixtures/framework-bench/genie-routes'
  );
  const truth = JSON.parse(
    await fs.readFile(path.join(fixtureDir, 'truth.json'), 'utf-8')
  ).true_routes as string[];

  const analyzer = new GenieAnalyzer();
  assert.equal(await analyzer.canAnalyze(fixtureDir), true, 'should detect fixture as Genie');
  const contribution = await analyzer.analyze({ projectPath: fixtureDir } as any);
  const predicted = (contribution.entry_points || [])
    .filter(ep => ep.type === 'http')
    .map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`);

  const score = f1(predicted, truth);
  assert.equal(
    score, 1.0,
    `F1 must be 1.0.\n  predicted=${JSON.stringify(predicted.sort())}\n  truth=${JSON.stringify([...truth].sort())}`
  );

  // All routes honest auth:false (Genie middleware-level auth).
  for (const ep of contribution.entry_points || []) {
    assert.equal(ep.security?.authenticated, false, `${ep.trigger?.method} ${ep.trigger?.path} should be auth:false`);
  }
});
