import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Http4sAnalyzer } from './http4s-analyzer';

/** Write a throwaway http4s project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'http4s-test-'));
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
    const analyzer = new Http4sAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'analyzer should detect the http4s project');
    const contribution = await analyzer.analyze({ projectPath: dir } as any);
    return (contribution.entry_points || []).map(ep => ({
      key: `${ep.trigger?.method} ${ep.trigger?.path}`,
      auth: ep.security?.authenticated,
      type: ep.type,
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

test('http4s: extracts method + path from HttpRoutes.of DSL', async () => {
  const routes = await routesOf({
    'src/main/scala/Routes.scala': `package x
import org.http4s._
import org.http4s.dsl.io._
object Routes {
  val r: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "users" => Ok("l")
    case GET -> Root / "users" / IntVar(id) => Ok("u")
    case POST -> Root / "login" => Ok("ok")
  }
}`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.ok(keys.has('GET /users'), `got ${JSON.stringify([...keys])}`);
  assert.ok(keys.has('GET /users/:id'), 'IntVar -> :id param');
  assert.ok(keys.has('POST /login'), 'POST literal');
});

test('http4s: marks AuthedRoutes block as authenticated', async () => {
  const routes = await routesOf({
    'src/main/scala/Auth.scala': `package x
import org.http4s._
import org.http4s.dsl.io._
object R {
  val pub: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "open" => Ok("o")
  }
  val sec: AuthedRoutes[User, IO] = AuthedRoutes.of[User, IO] {
    case GET -> Root / "me" as user => Ok("m")
    case DELETE -> Root / "users" / IntVar(id) as user => Ok("d")
  }
}`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));
  assert.equal(byKey.get('GET /open')!.auth, false, 'plain HttpRoutes is open');
  assert.equal(byKey.get('GET /me')!.auth, true, 'AuthedRoutes route is authenticated');
  assert.equal(byKey.get('DELETE /users/:id')!.auth, true, 'AuthedRoutes param route is authenticated');
});

test('http4s: bench fixture extracts all routes with F1=1.0 vs truth.json', async () => {
  const fixtureDir = path.resolve(
    __dirname, '../../../../../../apps/mcp-server/fixtures/framework-bench/http4s-routes'
  );
  const truth = JSON.parse(
    await fs.readFile(path.join(fixtureDir, 'truth.json'), 'utf-8')
  ).true_routes as string[];

  const analyzer = new Http4sAnalyzer();
  assert.equal(await analyzer.canAnalyze(fixtureDir), true, 'should detect fixture as http4s');
  const contribution = await analyzer.analyze({ projectPath: fixtureDir } as any);
  const predicted = (contribution.entry_points || [])
    .filter(ep => ep.type === 'http')
    .map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`);

  const score = f1(predicted, truth);
  assert.equal(
    score, 1.0,
    `F1 must be 1.0.\n  predicted=${JSON.stringify(predicted.sort())}\n  truth=${JSON.stringify([...truth].sort())}`
  );

  // Auth correctness on the fixture.
  const byKey = new Map(
    (contribution.entry_points || []).map(ep => [`${ep.trigger?.method} ${ep.trigger?.path}`, ep.security?.authenticated])
  );
  assert.equal(byKey.get('GET /me'), true, 'GET /me is authed');
  assert.equal(byKey.get('DELETE /users/:id'), true, 'DELETE /users/:id is authed');
  assert.equal(byKey.get('GET /health'), false, 'GET /health is open');
  assert.equal(byKey.get('GET /users'), false, 'GET /users is open');
});
