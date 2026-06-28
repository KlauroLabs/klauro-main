import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { CompojureAnalyzer } from './compojure-analyzer';

/** Write a throwaway Compojure project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compojure-test-'));
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
    const analyzer = new CompojureAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'analyzer should detect the compojure project');
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

test('compojure: extracts method + path from defroutes forms', async () => {
  const routes = await routesOf({
    'src/app.clj': `(ns x (:require [compojure.core :refer [defroutes GET POST DELETE]]))
(defroutes app-routes
  (GET "/" [] home)
  (GET "/users/:id" [id] (show id))
  (POST "/users" req (create req))
  (DELETE "/users/:id" [id] (destroy id)))`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.ok(keys.has('GET /'), `got ${JSON.stringify([...keys])}`);
  assert.ok(keys.has('GET /users/:id'), ':id path param kept');
  assert.ok(keys.has('POST /users'), 'POST literal');
  assert.ok(keys.has('DELETE /users/:id'), 'DELETE param route');
});

test('compojure: context prefixes nest onto child routes', async () => {
  const routes = await routesOf({
    'src/api.clj': `(ns x (:require [compojure.core :refer [defroutes context GET]]))
(defroutes api
  (context "/api" []
    (GET "/health" [] health)
    (context "/v2" []
      (GET "/items" [] items))))`,
  });
  const keys = new Set(routes.map(r => r.key));
  assert.ok(keys.has('GET /api/health'), `context prefix; got ${JSON.stringify([...keys])}`);
  assert.ok(keys.has('GET /api/v2/items'), 'nested context prefixes compose');
});

test('compojure: ANY is emitted as GET; auth is always false (Ring middleware)', async () => {
  const routes = await routesOf({
    'src/any.clj': `(ns x (:require [compojure.core :refer [defroutes ANY GET]]))
(defroutes app
  (ANY "/ping" [] ping)
  (GET "/secure" [] secret))`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));
  assert.ok(byKey.has('GET /ping'), 'ANY emitted as GET');
  assert.equal(byKey.get('GET /ping')!.auth, false, 'auth honest false');
  assert.equal(byKey.get('GET /secure')!.auth, false, 'compojure auth is middleware, not per-route');
});

test('compojure: bench fixture extracts all routes with F1=1.0 vs truth.json', async () => {
  const fixtureDir = path.resolve(
    __dirname, '../../../../../../apps/mcp-server/fixtures/framework-bench/compojure-routes'
  );
  const truth = JSON.parse(
    await fs.readFile(path.join(fixtureDir, 'truth.json'), 'utf-8')
  ).true_routes as string[];

  const analyzer = new CompojureAnalyzer();
  assert.equal(await analyzer.canAnalyze(fixtureDir), true, 'should detect fixture as compojure');
  const contribution = await analyzer.analyze({ projectPath: fixtureDir } as any);
  const predicted = (contribution.entry_points || [])
    .filter(ep => ep.type === 'http')
    .map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`);

  const score = f1(predicted, truth);
  assert.equal(
    score, 1.0,
    `F1 must be 1.0.\n  predicted=${JSON.stringify(predicted.sort())}\n  truth=${JSON.stringify([...truth].sort())}`
  );

  // Honest auth: every Compojure route is auth:false (Ring middleware, not per-route).
  for (const ep of contribution.entry_points || []) {
    assert.equal(ep.security?.authenticated, false, `${ep.trigger?.method} ${ep.trigger?.path} should be auth:false`);
  }
});
