import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { ReititAnalyzer } from './reitit-analyzer';

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reitit-analyzer-'));

  await fs.writeFile(
    path.join(root, 'deps.edn'),
    `{:deps {org.clojure/clojure {:mvn/version "1.11.1"}
        metosin/reitit {:mvn/version "0.7.0"}
        ring/ring-core {:mvn/version "1.10.0"}}
 :paths ["src"]}
`
  );

  await fs.ensureDir(path.join(root, 'src'));
  await fs.writeFile(
    path.join(root, 'src', 'app.clj'),
    `(ns app.core
  (:require [reitit.ring :as ring]))

(defn list-users [request] {:status 200 :body "users"})
(defn create-user [request] {:status 201 :body "created"})
(defn health [request] {:status 200 :body "ok"})
(defn list-items [request] {:status 200 :body "items"})

(def routes
  ["/api"
   ["/users"
    {:get  {:handler list-users}
     :post {:handler create-user
            :middleware [wrap-auth]}}]
   ["/health"
    {:get {:handler health}}]
   ["/v2"
    ["/items"
     {:get {:handler list-items}}]]])

(defn ring-only-handler [request]
  {:status 200 :body "ring-only"})

(def app (ring/ring-handler (ring/router routes)))
`
  );

  return root;
}

test('ReititAnalyzer canAnalyze detects reitit deps.edn dependency', async () => {
  const root = await makeFixture();
  try {
    const analyzer = new ReititAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), true);
  } finally {
    await fs.remove(root);
  }
});

test('ReititAnalyzer canAnalyze is false for an unrelated clojure project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reitit-analyzer-none-'));
  try {
    await fs.writeFile(path.join(root, 'deps.edn'), `{:deps {org.clojure/clojure {:mvn/version "1.11.1"}} :paths ["src"]}\n`);
    await fs.ensureDir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'core.clj'), `(ns app.core)\n(defn -main [] (println "hi"))\n`);
    const analyzer = new ReititAnalyzer();
    assert.strictEqual(await analyzer.canAnalyze(root), false);
  } finally {
    await fs.remove(root);
  }
});

test('ReititAnalyzer extracts nested route-data routes, per-route middleware, and a bare Ring handler', async () => {
  const root = await makeFixture();
  try {
    const analyzer = new ReititAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root } as any);

    const httpEntries = contribution.entry_points.filter(ep => ep.type === 'http');
    const routePaths = httpEntries
      .filter(ep => ep.metadata?.framework === 'reitit')
      .map(ep => `${ep.trigger?.method} ${ep.trigger?.path}`)
      .sort();
    assert.deepEqual(routePaths, ['GET /api/health', 'GET /api/users', 'GET /api/v2/items', 'POST /api/users']);

    const createUser = httpEntries.find(ep => ep.trigger?.method === 'POST' && ep.trigger?.path === '/api/users');
    assert.ok(createUser);
    assert.strictEqual(createUser!.security?.authenticated, true);
    assert.deepEqual(createUser!.security?.guards, ['wrap-auth']);
    assert.strictEqual(createUser!.handler?.method_name, 'create-user');

    const listUsers = httpEntries.find(ep => ep.trigger?.method === 'GET' && ep.trigger?.path === '/api/users');
    assert.ok(listUsers);
    assert.strictEqual(listUsers!.security?.authenticated, false);

    const ringOnly = httpEntries.find(ep => ep.metadata?.framework === 'ring');
    assert.ok(ringOnly, 'a bare Ring 1-arity handler not used as a Reitit :handler target should still be surfaced');
    assert.strictEqual(ringOnly!.handler?.method_name, 'ring-only-handler');
  } finally {
    await fs.remove(root);
  }
});
