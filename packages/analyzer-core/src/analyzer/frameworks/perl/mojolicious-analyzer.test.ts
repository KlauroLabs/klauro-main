import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { MojoliciousAnalyzer } from './mojolicious-analyzer';

/** Write a throwaway Mojolicious project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojo-test-'));
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
    const analyzer = new MojoliciousAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'analyzer should detect the mojolicious project');
    const contribution = await analyzer.analyze({ projectPath: dir } as any);
    return (contribution.entry_points || []).map(ep => ({
      key: `${ep.trigger?.method} ${ep.trigger?.path}`,
      auth: ep.security?.authenticated,
      type: ep.type,
      controller: ep.metadata?.controller,
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

test('mojolicious: extracts method + path from Lite verb helpers', async () => {
  const routes = await routesOf({
    'lib/MyApp.pm': `package MyApp;
use Mojolicious::Lite;

get '/' => sub { my $c = shift; $c->render(text => 'ok'); };
post '/users' => sub { my $c = shift; };
get '/users/:id' => sub { my $c = shift; };
del '/users/:id' => sub { my $c = shift; };
put '/users/:id' => sub { my $c = shift; };
any '/wild' => sub { my $c = shift; };

app->start;
1;
`,
  });
  const keys = routes.map(r => r.key).sort();
  assert.ok(keys.includes('GET /'), 'GET /');
  assert.ok(keys.includes('POST /users'), 'POST /users');
  assert.ok(keys.includes('GET /users/:id'), 'GET /users/:id (placeholder kept)');
  assert.ok(keys.includes('DELETE /users/:id'), 'del -> DELETE');
  assert.ok(keys.includes('PUT /users/:id'), 'PUT /users/:id');
  assert.ok(keys.includes('GET /wild'), 'any -> GET (documented)');
  // All Lite routes are honestly unauthenticated.
  assert.ok(routes.every(r => r.auth === false), 'Lite routes are auth:false');
  assert.ok(routes.every(r => r.type === 'http'), 'all entry points are http');
});

test('mojolicious: extracts method + path from full router form with controller', async () => {
  const routes = await routesOf({
    'lib/MyApp.pm': `package MyApp;
use Mojolicious;

sub startup {
  my $self = shift;
  my $r = $self->routes;
  $r->get('/api/items')->to('items#index');
  $r->post('/login')->to('auth#login');
}
1;
`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));
  assert.ok(byKey.has('GET /api/items'), 'GET /api/items');
  assert.ok(byKey.has('POST /login'), 'POST /login');
  assert.equal(byKey.get('GET /api/items')?.controller, 'items#index', 'controller from ->to(...)');
  assert.equal(byKey.get('POST /login')?.controller, 'auth#login', 'controller from ->to(...)');
});

test('mojolicious: under-bridge prefix + auth resolution (best-effort)', async () => {
  const routes = await routesOf({
    'lib/MyApp.pm': `package MyApp;
use Mojolicious;

sub startup {
  my $self = shift;
  my $r = $self->routes;
  my $admin = $r->under('/admin')->to('auth#check');
  $admin->get('/dashboard')->to('admin#dash');
}
1;
`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));
  assert.ok(byKey.has('GET /admin/dashboard'), 'under prefix prepended');
  assert.equal(byKey.get('GET /admin/dashboard')?.auth, true, 'under(auth#check) bridge -> auth:true');
});

test('mojolicious: F1 = 1.0 against the bench fixture truth.json (exact string match)', async () => {
  const fixtureDir = path.resolve(
    __dirname,
    '../../../../../../apps/mcp-server/fixtures/framework-bench/mojolicious-routes'
  );
  const truth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const analyzer = new MojoliciousAnalyzer();
  assert.equal(await analyzer.canAnalyze(fixtureDir), true, 'detects the bench fixture');
  const contribution = await analyzer.analyze({ projectPath: fixtureDir } as any);
  const nodeIds = new Set((contribution.nodes || []).map(node => node.id));
  assert.ok((contribution.entry_points || []).every(entryPoint => nodeIds.has(entryPoint.source_node)));
  const produced = (contribution.entry_points || []).map(
    ep => `${ep.trigger?.method} ${ep.trigger?.path}`
  );
  const score = f1(produced, truth.true_routes);
  assert.equal(
    score,
    1.0,
    `F1 must be 1.0. produced=${JSON.stringify([...new Set(produced)].sort())} truth=${JSON.stringify(truth.true_routes.sort())}`
  );
  // Exact set equality (no extras, no misses).
  assert.deepEqual([...new Set(produced)].sort(), [...truth.true_routes].sort());
});
