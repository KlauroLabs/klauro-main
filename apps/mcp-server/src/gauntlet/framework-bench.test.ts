import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as path from 'path';
import { runRouteFactsBench } from './framework-bench';
import { analyzeForBench } from './product-analysis';
import { getRouteTable } from '../query';

const ROOT = path.resolve(__dirname, '../../fixtures/framework-bench');

const fixtures = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'truth.json')))
  : [];

for (const fixture of fixtures) {
  test(`framework-bench [${fixture}]: Klauro answers route facts the competition cannot`, async () => {
    const r = await runRouteFactsBench(path.join(ROOT, fixture));
    const klauro = r.detail.find(d => d.arm === 'klauro')!;

    // Klauro emits the structured route table.
    assert.equal(klauro.f1, 1, `[${fixture}] Klauro must return the exact route set, got ${JSON.stringify(klauro.routes)}`);
    assert.equal(klauro.can_answer, true);

    // Every Camp-A/Camp-B competitor is out of category here — no route abstraction.
    const competitors = r.detail.filter(d => d.arm !== 'klauro');
    assert.ok(competitors.length > 0, 'must compare against real competitors');
    for (const c of competitors) {
      assert.equal(c.f1, 0, `[${fixture}] ${c.arm} cannot produce structured routes`);
      assert.equal(c.can_answer, false);
    }

    // Out-of-category win: quality dominates and tokens win (competitors must read
    // the source to even try; Klauro returns the compact table).
    assert.equal(r.verdict.klauro_wins, true, r.verdict.violation?.summary || 'Klauro must win route facts');
    assert.equal(r.verdict.quality_won, true, 'quality is an outright win, not a ceiling tie');
  });
}

test('framework-bench: the express-routes fixture exists', () => {
  assert.ok(fixtures.includes('express-routes'), 'express-routes fixture must exist');
});

test('framework-bench: the vapor-routes fixture exists', () => {
  assert.ok(fixtures.includes('vapor-routes'), 'vapor-routes fixture must exist');
});

// Out-category for Swift/Vapor: which endpoints sit behind an authenticator group.
// Vapor applies auth with `.grouped(<authenticator>)` on a routes builder, so auth
// is a composition fact the route analyzer must resolve from group bindings.
test('framework-bench: Klauro resolves Vapor grouped-authenticator endpoints', async () => {
  const dir = path.join(ROOT, 'vapor-routes');
  const cas: any = await analyzeForBench(dir);
  const routes: any[] = (getRouteTable(cas, { limit: 50 }) as any).routes;
  const byKey = new Map(routes.map(r => [`${r.method} ${r.path}`, r]));

  assert.equal(byKey.get('GET /health')?.auth, false, 'top-level GET must be auth:false');
  assert.equal(byKey.get('GET /users')?.auth, false, 'path-prefix group route must be auth:false');
  assert.equal(byKey.get('GET /me')?.auth, true, 'authenticator-group route must be auth:true');
  assert.equal(byKey.get('DELETE /users/:id')?.auth, true, 'authenticator-group route must be auth:true');
  assert.equal(byKey.get('GET /me')?.handler, 'me', 'handler must be the real function name');
});

// Out-category goes deeper than "list routes": Klauro knows WHICH endpoints are
// auth-guarded. This gates the balanced-args route parser (positional middleware
// like `requireAuth` must be captured, not swallowed by the arrow handler).
test('framework-bench: Klauro links positional auth middleware to the right endpoints', async () => {
  const dir = path.join(ROOT, 'express-routes');
  const cas: any = await analyzeForBench(dir);
  const routes: any[] = (getRouteTable(cas, { limit: 50 }) as any).routes;
  const byKey = new Map(routes.map(r => [`${r.method} ${r.path}`, r]));

  assert.equal(byKey.get('GET /users')?.auth, false, 'unguarded GET must be auth:false');
  assert.equal(byKey.get('POST /users')?.auth, true, 'requireAuth-guarded POST must be auth:true');
  assert.equal(byKey.get('DELETE /users/:id')?.auth, true, 'requireAuth-guarded DELETE must be auth:true');
  // The handler must be the real function, not a captured arrow-param fragment.
  assert.ok(!/^res$/.test(byKey.get('GET /users')?.handler ?? ''), 'handler must not be a captured "res" fragment');
});
