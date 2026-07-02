import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { fuseTelemetry, ingestAndPersist, loadPersistedRuntimeFacts, type TelemetrySpan } from './telemetry-fusion';

// Minimal fixture CAS: one HTTP entry point (route handler node), one exit
// point (outbound DB call), and an unrelated node the decoy span must not
// force-fit to. Mirrors the shape gauntlet/telemetry-overlay-bench.ts exercises
// through correlateRuntimeEvent, just constructed directly instead of through
// the engine (this test is a pure unit test of fuseTelemetry, not a bench).
function buildFixtureCas(): CASOutput {
  return {
    cas_version: '1.7.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'fixture-analysis',
    system: { name: 'fixture-system', root_path: '/fixture', type: 'service' } as any,
    nodes: [
      {
        id: 'node:getUsers',
        name: 'getUsers',
        type: 'function',
        source: { file: 'src/routes/users.ts', line: 10, end_line: 20 },
      } as any,
      {
        id: 'node:writeAuditLog',
        name: 'writeAuditLog',
        type: 'function',
        source: { file: 'src/db/audit.ts', line: 5, end_line: 15 },
      } as any,
      {
        id: 'node:unrelatedHelper',
        name: 'unrelatedHelper',
        type: 'function',
        source: { file: 'src/util/helper.ts', line: 1, end_line: 5 },
      } as any,
    ],
    edges: [],
    entry_points: [
      {
        id: 'entry:getUsers',
        source_node: 'node:getUsers',
        type: 'http',
        name: 'GET /api/users',
        trigger: { method: 'GET', path: '/api/users' },
        handler: { node_id: 'node:getUsers', method_name: 'getUsers', file: 'src/routes/users.ts', line: 10 },
      } as any,
    ],
    exit_points: [
      {
        id: 'exit:auditDb',
        source_node: 'node:writeAuditLog',
        type: 'database',
        name: 'audit-db-write',
        target: { endpoint: '/internal/audit-log' },
        operation: { method: 'POST' },
      } as any,
    ],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('fuseTelemetry: correlates a slow HTTP span to its entry-point node as a "slow" fact', () => {
  const cas = buildFixtureCas();
  const spans: TelemetrySpan[] = [
    { service: 'api', endpoint: '/api/users', method: 'GET', duration_ms: 1500, count: 40 },
  ];
  const result = fuseTelemetry(cas, spans);
  assert.equal(result.facts.length, 1);
  assert.equal(result.unmatched.length, 0);
  const fact = result.facts[0];
  assert.equal(fact.node_id, 'node:getUsers');
  assert.equal(fact.kind, 'slow');
  assert.equal(fact.metric, 1500);
});

test('fuseTelemetry: correlates a hot HTTP span (high count, low latency) as a "hot" fact', () => {
  const cas = buildFixtureCas();
  const spans: TelemetrySpan[] = [
    { service: 'api', endpoint: '/api/users', method: 'GET', duration_ms: 50, count: 500 },
  ];
  const result = fuseTelemetry(cas, spans);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].node_id, 'node:getUsers');
  assert.equal(result.facts[0].kind, 'hot');
  assert.equal(result.facts[0].metric, 500);
});

test('fuseTelemetry: correlates an error span on an exit point to its owning node as an "error" fact', () => {
  const cas = buildFixtureCas();
  const spans: TelemetrySpan[] = [
    { service: 'api', endpoint: '/internal/audit-log', method: 'POST', error: true, count: 3 },
  ];
  const result = fuseTelemetry(cas, spans);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].node_id, 'node:writeAuditLog');
  assert.equal(result.facts[0].kind, 'error');
});

test('fuseTelemetry: rejects a decoy span with no matching CAS entry/exit point as unmatched, never force-fit', () => {
  const cas = buildFixtureCas();
  const spans: TelemetrySpan[] = [
    { service: 'api', endpoint: '/api/users', method: 'GET', duration_ms: 20, count: 5 },
    { service: 'ghost-service', endpoint: '/no/such/route', method: 'GET', duration_ms: 5000, count: 999 },
  ];
  const result = fuseTelemetry(cas, spans);
  assert.equal(result.facts.length, 1, 'only the real route should produce a fact');
  assert.equal(result.facts[0].node_id, 'node:getUsers');
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].endpoint, '/no/such/route');
});

test('fuseTelemetry: a low-signal span (no error, fast, low count) is neither hot/slow/error-flagged incorrectly nor dropped', () => {
  const cas = buildFixtureCas();
  // Matched but "unused" by deriveFact convention still classifies as hot with metric 0/low count;
  // this asserts the fact is still produced (matched), not silently dropped, and kind stays 'hot'
  // (the only non-error/slow bucket in this module's 3-kind RuntimeFact contract).
  const spans: TelemetrySpan[] = [
    { service: 'api', endpoint: '/api/users', method: 'GET', duration_ms: 10, count: 2 },
  ];
  const result = fuseTelemetry(cas, spans);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].kind, 'hot');
  assert.equal(result.facts[0].metric, 2);
});

test('ingestAndPersist: persists facts to a sibling file under dataDir and merges on repeated ingests', async () => {
  const cas = buildFixtureCas();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-fusion-test-'));
  try {
    const workspace = '/fixture/workspace';
    const first = await ingestAndPersist(dataDir, workspace, cas, [
      { service: 'api', endpoint: '/api/users', method: 'GET', duration_ms: 1200, count: 10 },
    ]);
    assert.equal(first.facts.length, 1);
    assert.equal(first.total_facts, 1);
    assert.ok(await fs.pathExists(first.persisted_path));

    const second = await ingestAndPersist(dataDir, workspace, cas, [
      { service: 'api', endpoint: '/internal/audit-log', method: 'POST', error: true, count: 1 },
    ]);
    assert.equal(second.total_facts, 2, 'second ingest should merge with, not replace, the first');

    const loaded = await loadPersistedRuntimeFacts(dataDir, workspace);
    assert.ok(loaded);
    assert.equal(loaded!.facts.length, 2);
    assert.equal(loaded!.workspace, workspace);
  } finally {
    await fs.remove(dataDir);
  }
});
