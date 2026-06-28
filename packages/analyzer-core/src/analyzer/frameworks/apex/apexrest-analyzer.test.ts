import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { ApexRestAnalyzer } from './apexrest-analyzer';

/** Write a throwaway Apex (sfdx) project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apexrest-test-'));
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
    const analyzer = new ApexRestAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'analyzer should detect the Apex REST project');
    const contribution = await analyzer.analyze({ projectPath: dir } as any);
    return (contribution.entry_points || []).map(ep => ({
      key: `${ep.trigger?.method} ${ep.trigger?.path}`,
      auth: ep.security?.authenticated,
      handler: ep.metadata?.handler as string,
      type: ep.type,
    }));
  } finally {
    await fs.remove(dir);
  }
}

function f1(predicted: string[], truth: string[]): number {
  const t = new Set(truth);
  const p = new Set(predicted);
  let tp = 0;
  for (const x of p) if (t.has(x)) tp++;
  const fp = p.size - tp;
  const fn = t.size - tp;
  if (tp === 0) return 0;
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  return (2 * precision * recall) / (precision + recall);
}

test('apex-rest: extracts verb-annotated methods on a @RestResource class (urlMapping base path)', async () => {
  const routes = await routesOf({
    'force-app/main/default/classes/UserResource.cls': `@RestResource(urlMapping='/users/*')
global with sharing class UserResource {
    @HttpGet    global static User doGet() { return null; }
    @HttpPost   global static void doPost(String name) {}
    @HttpDelete global static void doDelete() {}
}`,
  });
  const byKey = new Map(routes.map(r => [r.key, r]));

  assert.ok(byKey.has('GET /users'), `expected GET /users, got ${JSON.stringify([...byKey.keys()])}`);
  assert.equal(byKey.get('GET /users')!.handler, 'doGet');
  assert.equal(byKey.get('GET /users')!.type, 'http');
  assert.equal(byKey.get('POST /users')!.handler, 'doPost');
  assert.equal(byKey.get('DELETE /users')!.handler, 'doDelete');
  // Apex platform auth is implicit/out-of-band -> honest false (no in-source guard).
  assert.equal(byKey.get('GET /users')!.auth, false);
});

test('apex-rest: strips trailing /* and keeps multi-segment urlMapping', async () => {
  const routes = await routesOf({
    'force-app/main/default/classes/Api.cls': `@RestResource(urlMapping='/api/v1/orders/*')
global class Api {
    @HttpPut global static void doPut() {}
}`,
  });
  const keys = routes.map(r => r.key);
  assert.deepEqual(keys, ['PUT /api/v1/orders']);
});

test('apex-rest: does not emit routes for classes without @RestResource', async () => {
  const dir = await fixture({
    'force-app/main/default/classes/Plain.cls': `global class Plain {
    @HttpGet global static void doGet() {}
}`,
  });
  try {
    const analyzer = new ApexRestAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), false);
    const contribution = await analyzer.analyze({ projectPath: dir } as any);
    assert.equal((contribution.entry_points || []).length, 0);
  } finally {
    await fs.remove(dir);
  }
});

test('apex-rest: F1 = 1.0 against the bench fixture truth.json', async () => {
  const fixtureDir = path.resolve(
    __dirname,
    '../../../../../../apps/mcp-server/fixtures/framework-bench/apexrest-routes'
  );
  const truth = JSON.parse(
    await fs.readFile(path.join(fixtureDir, 'truth.json'), 'utf-8')
  ).true_routes as string[];

  const analyzer = new ApexRestAnalyzer();
  assert.equal(await analyzer.canAnalyze(fixtureDir), true);
  const contribution = await analyzer.analyze({ projectPath: fixtureDir } as any);
  const predicted = (contribution.entry_points || []).map(
    ep => `${ep.trigger?.method} ${ep.trigger?.path}`
  );

  const score = f1(predicted, truth);
  assert.equal(
    score,
    1.0,
    `F1 must be 1.0. predicted=${JSON.stringify(predicted.sort())} truth=${JSON.stringify([...truth].sort())}`
  );
});
