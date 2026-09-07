import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getAnalysisFileFingerprint, saveAnalysis } from './storage';
import { runHostedProjectQueryWorker } from './hosted-project-query-process';
import { withHostedBackgroundPermit } from './hosted-background-queue';

function fixture(callers: number): CASOutput {
  const nodes: any[] = [{ id: 'node-0', name: 'targetFn', type: 'function', level: 1, source: { file: 'src/target.ts', line: 1 }, description: 'the target' }];
  const edges: any[] = [];
  for (let index = 0; index < callers; index += 1) {
    nodes.push({ id: `caller-${index}`, name: `caller${index}`, type: 'function', level: 1, source: { file: `src/c${index % 50}.ts`, line: index + 1 } });
    edges.push({ id: `e-${index}`, source: `caller-${index}`, target: 'node-0', type: 'calls' });
  }
  nodes.push({ id: 'ext', name: 'httpClient', type: 'function', level: 1, source: { file: 'src/ext.ts', line: 1 } });
  edges.push({ id: 'e-ext', source: 'node-0', target: 'ext', type: 'external_call', category: 'external' });
  return {
    cas_version: '1.11.0', analysis_id: 'dispatch', analysis_timestamp: '2026-09-07T00:00:00.000Z',
    system: { name: 'dispatch', type: 'service' },
    nodes, edges, method_calls: [], analysis_facts: [], analyzer_contributions: [], progressive_levels: [],
    test_suites: [{ id: 'suite-1', name: 'target.test', file_path: 'src/target.test.ts', tests: [{ name: 'covers target', targets: ['node-0'] }], coverage: { nodes_tested: ['node-0'] } }],
    layers_ready: { complete: true, generated_at: '2026-09-07T00:00:00.000Z', layers: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].map(layer => ({ layer, name: layer, status: 'ready', fields: [] })) },
  } as unknown as CASOutput;
}

async function withWorker<T>(callers: number, fn: (projects: { withStore: string; withoutStore: string }) => Promise<T>): Promise<T> {
  const previous = { storage: process.env.KLAURO_STORAGE_PATH, canonical: process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE, entry: process.env.KLAURO_HOSTED_QUERY_WORKER_ENTRY, heap: process.env.KLAURO_HOSTED_QUERY_HEAP_MB, store: process.env.KLAURO_CAS_RECORD_STORE };
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-dispatch-storage-'));
  const withStore = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-dispatch-project-'));
  const withoutStore = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-dispatch-nostore-'));
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE = '1';
  process.env.KLAURO_HOSTED_QUERY_WORKER_ENTRY = path.join(__dirname, 'hosted-project-query-worker.ts');
  process.env.KLAURO_HOSTED_QUERY_HEAP_MB = '512';
  try {
    delete process.env.KLAURO_CAS_RECORD_STORE;
    await saveAnalysis(withStore, fixture(callers), 'main', { canonicalSegmented: true });
    process.env.KLAURO_CAS_RECORD_STORE = '0';
    await saveAnalysis(withoutStore, fixture(callers), 'main', { canonicalSegmented: true });
    delete process.env.KLAURO_CAS_RECORD_STORE;
    assert.ok(await getAnalysisFileFingerprint(withStore) && await getAnalysisFileFingerprint(withoutStore), 'both saved analyses resolve in-process before dispatch');
    return await fn({ withStore, withoutStore });
  } finally {
    await withHostedBackgroundPermit(async () => undefined, { releaseForegroundMemory: true });
    for (const [key, value] of [['KLAURO_STORAGE_PATH', previous.storage], ['KLAURO_CANONICAL_SEGMENTED_STORAGE', previous.canonical], ['KLAURO_HOSTED_QUERY_WORKER_ENTRY', previous.entry], ['KLAURO_HOSTED_QUERY_HEAP_MB', previous.heap], ['KLAURO_CAS_RECORD_STORE', previous.store]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(storage, { recursive: true, force: true });
    fs.rmSync(withStore, { recursive: true, force: true });
    fs.rmSync(withoutStore, { recursive: true, force: true });
  }
}

test('worker dispatch answers scoped risk from the record store, then from the stream when the store is unsupported, identically', async () => {
  await withWorker(30, async ({ withStore, withoutStore }) => {
    const request = { tool: 'assess_change_risk', args: { node_id: 'node-0' }, projectId: 'p', analysisId: 'a' };
    const store = (await runHostedProjectQueryWorker({ ...request, workspace: withStore })).result as any;
    assert.equal(store.scoped_context?.source, 'record-store');
    assert.equal(store.scoped_context?.truncated, false);
    assert.equal(store.risk?.node_id, 'node-0');
    assert.ok(JSON.stringify(store.risk).includes('external'), 'the external edge reached the score');
    const stream = (await runHostedProjectQueryWorker({ ...request, workspace: withoutStore })).result as any;
    assert.equal(stream.scoped_context?.source, 'stream');
    const strip = (value: any) => JSON.parse(JSON.stringify({ ...value, scoped_context: undefined }));
    assert.deepEqual(strip(stream), strip(store), 'stream and record-store answers are identical');
    const tests = (await runHostedProjectQueryWorker({ ...request, tool: 'find_tests', workspace: withoutStore })).result as any;
    assert.equal(tests.scoped_context?.source, 'stream');
    assert.equal(tests.total_suites, 1);
    const testsStore = (await runHostedProjectQueryWorker({ ...request, tool: 'find_tests', workspace: withStore })).result as any;
    assert.equal(testsStore.scoped_context?.source, 'record-store');
    assert.deepEqual(strip(testsStore), strip(tests));
  });
});

test('worker dispatch refuses an exact tool whose scope cannot be completed, on both loader paths', async () => {
  await withWorker(4100, async ({ withStore, withoutStore }) => {
    const request = { tool: 'assess_change_risk', args: { node_id: 'node-0' }, projectId: 'p', analysisId: 'a' };
    const fromStore = (await runHostedProjectQueryWorker({ ...request, workspace: withStore })).result as any;
    assert.equal(fromStore.incomplete, true);
    assert.equal(fromStore.risk, null);
    assert.match(fromStore.reason, /direct callers exceed/);
    const fromStream = (await runHostedProjectQueryWorker({ ...request, workspace: withoutStore })).result as any;
    assert.equal(fromStream.incomplete, true);
    assert.equal(fromStream.risk, null);
    assert.match(fromStream.reason, /direct callers exceed/);
  });
});
