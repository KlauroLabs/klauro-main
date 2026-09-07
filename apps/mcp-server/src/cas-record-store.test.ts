import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { saveAnalysis, loadCompactAnalysisGraph, loadAnalysisSectionManifest } from './storage';
import { acquirePinnedAnalysis, loadScopedGraphSection } from './hosted-query-scoped-graph';
import { CAS_RECORD_STORE_BLOCK_RECORDS, openCasRecordStore } from './cas-record-store';

function fixture(count: number): CASOutput {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n-${index}`, name: `fn${index}`, type: 'function', level: 1,
    source: { file: `src/f${index % 7}.ts`, line: index + 1 }, metadata: { attributes: { exported: index % 3 === 0, note: 'ünïcödé "quoted" \\ back' } },
  }));
  const edges = Array.from({ length: count - 1 }, (_, index) => ({ id: `e-${index}`, source: `n-${index}`, target: `n-${index + 1}`, type: 'calls' }));
  edges.push({ id: 'e-dup', source: 'n-0', target: 'n-1', type: 'calls' });
  return {
    cas_version: '1.11.0', analysis_id: 'record-store', analysis_timestamp: '2026-09-07T00:00:00.000Z',
    system: { name: 'record-store', type: 'service' },
    nodes, edges, method_calls: [], analysis_facts: [], analyzer_contributions: [], progressive_levels: [],
    layers_ready: {
      complete: true, generated_at: '2026-09-07T00:00:00.000Z',
      layers: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].map(layer => ({ layer, name: layer, status: 'ready', fields: [] })),
    },
  } as unknown as CASOutput;
}

async function withStorage<T>(fn: (project: string) => Promise<T>): Promise<T> {
  const previous = process.env.KLAURO_STORAGE_PATH;
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-record-store-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-record-store-project-'));
  process.env.KLAURO_STORAGE_PATH = storagePath;
  try {
    return await fn(project);
  } finally {
    if (previous === undefined) delete process.env.KLAURO_STORAGE_PATH; else process.env.KLAURO_STORAGE_PATH = previous;
    fs.rmSync(storagePath, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

test('canonical segmented storage publishes a checksummed record store bound to the compact graph', async () => {
  await withStorage(async project => {
    const count = CAS_RECORD_STORE_BLOCK_RECORDS * 2 + 37;
    const original = fixture(count);
    await saveAnalysis(project, original, 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    assert.ok(manifest.record_store, 'manifest carries the record store');
    assert.equal(manifest.record_store!.nodes.count, count);
    assert.equal(manifest.record_store!.edges.count, count);
    assert.equal(manifest.record_store!.nodes.blocks, 3);
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const store = await openCasRecordStore(pinned.segmented.directory, manifest.record_store!, { nodeCount: graph.nodeCount, edgeCount: graph.edgeCount });
      const byId = new Map(original.nodes.map(node => [node.id, node]));
      for (const id of ['n-0', 'n-255', 'n-256', `n-${count - 1}`]) {
        const dense = graph.nodeById(id)!.denseId;
        assert.deepEqual(store.nodes.read([dense])[0], byId.get(id));
      }
      const edgeView = graph.edgeAt(5);
      const edge = store.edges.read([5])[0];
      assert.equal(edge.id, edgeView.id);
      assert.equal(edge.source, edgeView.sourceId);
      assert.equal(edge.target, edgeView.targetId);
      assert.throws(() => store.nodes.read([count]), /out of range/);
      await assert.rejects(
        openCasRecordStore(pinned.segmented.directory, manifest.record_store!, { nodeCount: graph.nodeCount + 1, edgeCount: graph.edgeCount }),
        /do not match the compact graph/,
      );
      const corrupted = path.join(pinned.segmented.directory, manifest.record_store!.nodes.columns.blocks.file);
      const bytes = fs.readFileSync(corrupted);
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      fs.writeFileSync(corrupted, bytes);
      await assert.rejects(
        openCasRecordStore(pinned.segmented.directory, manifest.record_store!, { nodeCount: graph.nodeCount, edgeCount: graph.edgeCount }),
        /checksum mismatch/,
      );
    } finally {
      await pinned.release();
    }
  });
});

test('scoped loads use the record store when present and stream when a generation lacks it', async () => {
  await withStorage(async project => {
    const original = fixture(300);
    await saveAnalysis(project, original, 'main', { canonicalSegmented: true });
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const keep = new Set(['n-10', 'n-11', 'n-12', 'n-0', 'n-1']);
      const fast = (await loadScopedGraphSection(pinned, keep, graph))!;
      assert.equal(fast.source, 'record-store');
      assert.deepEqual(fast.nodes.map(node => node.id).sort(), [...keep].sort());
      assert.deepEqual(fast.edges.map(edge => edge.id).sort(), ['e-0', 'e-10', 'e-11', 'e-dup']);
      assert.deepEqual(fast.scanned, { nodes: 300, edges: 300 });
      delete (pinned.segmented.manifest as { record_store?: unknown }).record_store;
      const slow = (await loadScopedGraphSection(pinned, keep, graph))!;
      assert.equal(slow.source, 'stream');
      assert.deepEqual(slow.nodes.map(node => node.id).sort(), fast.nodes.map(node => node.id).sort());
      assert.deepEqual(slow.edges.map(edge => edge.id).sort(), fast.edges.map(edge => edge.id).sort());
      assert.deepEqual(slow.nodes.find(node => node.id === 'n-11'), fast.nodes.find(node => node.id === 'n-11'));
    } finally {
      await pinned.release();
    }
  });
});
