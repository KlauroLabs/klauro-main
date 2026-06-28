import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GoRouterAnalyzer } from './gorouter-analyzer';

/** The real bench fixture directory for this framework. */
const FIXTURE_DIR = path.resolve(
  __dirname,
  '../../../../../../apps/mcp-server/fixtures/framework-bench/gorouter-routes'
);

/** Write a throwaway GoRouter project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gorouter-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

async function routesOfDir(dir: string) {
  const analyzer = new GoRouterAnalyzer();
  const contribution = await analyzer.analyze({ projectPath: dir } as any);
  return (contribution.entry_points || []).map(ep => ({
    key: `${ep.trigger?.method} ${ep.trigger?.path}`,
    auth: ep.security?.authenticated,
    handler: ep.metadata?.handler as string,
    type: ep.type,
  }));
}

async function routesOf(files: Record<string, string>) {
  const dir = await fixture(files);
  try {
    const analyzer = new GoRouterAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'analyzer should detect the GoRouter project');
    return await routesOfDir(dir);
  } finally {
    await fs.remove(dir);
  }
}

function f1(predicted: string[], truth: string[]): number {
  const pset = new Set(predicted);
  const tset = new Set(truth);
  let tp = 0;
  for (const p of pset) if (tset.has(p)) tp++;
  const fp = pset.size - tp;
  const fn = tset.size - tp;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

test('gorouter: standalone analyze() of the real bench fixture hits F1 = 1.0', async () => {
  const truth = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, 'truth.json'), 'utf-8'));
  const trueRoutes: string[] = truth.true_routes;

  const routes = await routesOfDir(FIXTURE_DIR);
  const predicted = routes.map(r => r.key).sort();

  const score = f1(predicted, trueRoutes);
  assert.equal(
    score,
    1.0,
    `F1 must be 1.0.\n  predicted: ${JSON.stringify(predicted)}\n  truth:     ${JSON.stringify([...trueRoutes].sort())}`
  );

  // Exact string match both directions.
  assert.deepEqual(predicted, [...trueRoutes].sort(), 'route strings must match truth.json exactly');
});

test('gorouter: resolves nested route prefixes (child appended to parent param path)', async () => {
  const routes = await routesOf({
    'pubspec.yaml': 'name: x\ndependencies:\n  go_router: ^14.0.0\n',
    'lib/router.dart': `import 'package:go_router/go_router.dart';
final r = GoRouter(routes: [
  GoRoute(path: '/users/:id', builder: (c,s)=>UserScreen(), routes: [
    GoRoute(path: 'edit', builder: (c,s)=>EditScreen()),
    GoRoute(path: 'posts/:pid', builder: (c,s)=>PostScreen()),
  ]),
]);`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.ok(keys.has('GET /users/:id'), `parent route, got ${JSON.stringify([...keys])}`);
  assert.ok(keys.has('GET /users/:id/edit'), 'relative child appended to parent');
  assert.ok(keys.has('GET /users/:id/posts/:pid'), 'multi-segment relative child');
});

test('gorouter: ShellRoute passes children through without contributing a path', async () => {
  const routes = await routesOf({
    'pubspec.yaml': 'name: x\ndependencies:\n  go_router: ^14.0.0\n',
    'lib/router.dart': `import 'package:go_router/go_router.dart';
final r = GoRouter(routes: [
  ShellRoute(builder: (c,s,child)=>Shell(child:child), routes: [
    GoRoute(path: '/a', builder: (c,s)=>A()),
    GoRoute(path: '/b', builder: (c,s)=>B()),
  ]),
]);`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.ok(keys.has('GET /a'), `shell child a, got ${JSON.stringify([...keys])}`);
  assert.ok(keys.has('GET /b'), 'shell child b');
  assert.ok(!keys.has('GET /'), 'ShellRoute itself contributes no path');
});

test('gorouter: top-level auth redirect marks protected routes, login stays public', async () => {
  const routes = await routesOf({
    'pubspec.yaml': 'name: x\ndependencies:\n  go_router: ^14.0.0\n',
    'lib/router.dart': `import 'package:go_router/go_router.dart';
final r = GoRouter(
  redirect: (c, s) {
    if (!isLoggedIn) return '/login';
    return null;
  },
  routes: [
    GoRoute(path: '/login', builder: (c,s)=>LoginScreen()),
    GoRoute(path: '/home', builder: (c,s)=>HomeScreen()),
  ],
);`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));
  assert.equal(byKey.get('GET /login')!.auth, false, 'login route stays public');
  assert.equal(byKey.get('GET /home')!.auth, true, 'protected route is authenticated');
});

test('gorouter: with no auth redirect every route is auth:false (honest default)', async () => {
  const routes = await routesOf({
    'pubspec.yaml': 'name: x\ndependencies:\n  go_router: ^14.0.0\n',
    'lib/router.dart': `import 'package:go_router/go_router.dart';
final r = GoRouter(routes: [
  GoRoute(path: '/', builder: (c,s)=>HomeScreen()),
  GoRoute(path: '/about', builder: (c,s)=>AboutScreen()),
]);`,
  });
  assert.ok(routes.length === 2);
  for (const r of routes) assert.equal(r.auth, false, `${r.key} should be unauthenticated`);
});
