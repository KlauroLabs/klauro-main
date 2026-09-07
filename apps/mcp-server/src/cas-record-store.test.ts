import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { saveAnalysis, loadCompactAnalysisGraph, loadAnalysisSectionManifest } from './storage';
import { acquirePinnedAnalysis, loadScopedGraphSection } from './hosted-query-scoped-graph';
import { CAS_RECORD_STORE_MAX_BLOCK_RECORDS, CAS_RECORD_STORE_TARGET_BLOCK_BYTES, CasRecordStoreCapacityError, edgeRecordKey, openCasRecordStore } from './cas-record-store';

function fixture(count: number, payloadBytes = 0): CASOutput {
  const filler = payloadBytes > 0 ? 'x'.repeat(payloadBytes) : undefined;
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n-${index}`, name: `fn${index}`, type: 'function', level: 1,
    source: { file: `src/f${index % 7}.ts`, line: index + 1 },
    metadata: { attributes: { exported: index % 3 === 0, note: 'ünïcödé "quoted" \\ back', ...(filler ? { filler } : {}) } },
  }));
  const edges = Array.from({ length: count - 1 }, (_, index) => ({ id: `e-${index}`, source: `n-${index}`, target: `n-${index + 1}`, type: 'calls' }));
  edges.push({ id: 'e-same', source: 'n-0', target: 'n-1', type: 'calls', metadata: { weight: 1 } } as any);
  edges.push({ id: 'e-same', source: 'n-0', target: 'n-1', type: 'calls', metadata: { weight: 2 } } as any);
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

test('record store round-trips every record across count-split blocks and preserves same-key duplicate edges', async () => {
  await withStorage(async project => {
    const count = CAS_RECORD_STORE_MAX_BLOCK_RECORDS * 2 + 37;
    const original = fixture(count);
    await saveAnalysis(project, original, 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    assert.ok(manifest.record_store);
    assert.equal(manifest.record_store!.nodes.count, count);
    assert.equal(manifest.record_store!.nodes.blocks, 3);
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const store = await openCasRecordStore(pinned.segmented.directory, manifest.record_store!, { nodeCount: graph.nodeCount, edgeCount: graph.edgeCount });
      const byId = new Map(original.nodes.map(node => [node.id, node]));
      const all = await store.nodes.read(Array.from({ length: graph.nodeCount }, (_, dense) => dense));
      assert.equal(all.length, count);
      for (const node of all) assert.deepEqual(node, byId.get(node.id));
      const sameKey = original.edges.filter(edge => edge.id === 'e-same');
      assert.equal(sameKey.length, 2);
      assert.equal(edgeRecordKey(sameKey[0]), edgeRecordKey(sameKey[1]));
      const stored = (await store.edges.read(Array.from({ length: graph.edgeCount }, (_, ordinal) => ordinal))).filter(edge => edge.id === 'e-same');
      assert.deepEqual(stored.map(edge => (edge as any).metadata.weight).sort(), [1, 2], 'both same-key edges are stored distinctly');
      await assert.rejects(store.nodes.read([count]), /out of range/);
    } finally {
      await pinned.release();
    }
  });
});

test('blocks split by bytes before the count limit and reads stay bounded by the byte budget', async () => {
  await withStorage(async project => {
    const payload = Math.floor(CAS_RECORD_STORE_TARGET_BLOCK_BYTES / 3);
    const original = fixture(20, payload);
    await saveAnalysis(project, original, 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    assert.ok(manifest.record_store!.nodes.blocks >= 7, `byte-triggered split produced ${manifest.record_store!.nodes.blocks} blocks`);
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const small = await openCasRecordStore(pinned.segmented.directory, manifest.record_store!, { nodeCount: graph.nodeCount, edgeCount: graph.edgeCount }, { maxDecodedBytes: payload * 3, cacheBytes: payload * 3 });
      const dense = (id: string) => graph.nodeById(id)!.denseId;
      const one = await small.nodes.read([dense('n-3')]);
      assert.equal(one[0].id, 'n-3');
      await assert.rejects(small.nodes.read([dense('n-0'), dense('n-5'), dense('n-10'), dense('n-15')]), (error: unknown) => error instanceof CasRecordStoreCapacityError);
      assert.ok(small.cacheBytes() <= payload * 3, 'cache never exceeds its budget');
      const tiny = await openCasRecordStore(pinned.segmented.directory, manifest.record_store!, { nodeCount: graph.nodeCount, edgeCount: graph.edgeCount }, { maxRecords: 2 });
      await assert.rejects(tiny.nodes.read([0, 1, 2]), /exceeds 2/);
    } finally {
      await pinned.release();
    }
  });
});

test('malformed offsets, truncated block data and corrupt blocks are explicit errors, never an empty graph', async () => {
  await withStorage(async project => {
    await saveAnalysis(project, fixture(300), 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      const expected = { nodeCount: graph.nodeCount, edgeCount: graph.edgeCount };
      const directory = pinned.segmented.directory;
      const blocksFile = path.join(directory, manifest.record_store!.nodes.columns.blocks.file);
      const intact = fs.readFileSync(blocksFile);
      fs.writeFileSync(blocksFile, intact.subarray(0, intact.byteLength - 10));
      await assert.rejects(openCasRecordStore(directory, manifest.record_store!, expected), /blocks file size/);
      const corrupt = Buffer.from(intact);
      corrupt[Math.floor(corrupt.byteLength / 2)] ^= 0xff;
      fs.writeFileSync(blocksFile, corrupt);
      const store = await openCasRecordStore(directory, manifest.record_store!, expected);
      await assert.rejects(store.nodes.read([Math.floor(graph.nodeCount / 2)]), /checksum mismatch/);
      fs.writeFileSync(blocksFile, intact);
      const offsetsFile = path.join(directory, manifest.record_store!.nodes.columns.recordOffsets.file);
      const offsets = fs.readFileSync(offsetsFile);
      const broken = Buffer.from(offsets);
      broken.writeUInt32LE(0, 8);
      const descriptor = JSON.parse(JSON.stringify(manifest.record_store));
      descriptor.nodes.columns.recordOffsets.sha256 = require('node:crypto').createHash('sha256').update(broken).digest('hex');
      fs.writeFileSync(offsetsFile, broken);
      await assert.rejects(openCasRecordStore(directory, descriptor, expected), /monotone/);
      fs.writeFileSync(offsetsFile, offsets);
      await assert.rejects(openCasRecordStore(directory, manifest.record_store!, { nodeCount: graph.nodeCount + 1, edgeCount: graph.edgeCount }), /do not match the compact graph/);
    } finally {
      await pinned.release();
    }
  });
});

test('scoped loads use the record store, stay bound to the pinned generation, and stream when a generation lacks one', async () => {
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
      assert.deepEqual(fast.edges.map(edge => edge.id).sort(), ['e-0', 'e-10', 'e-11', 'e-same', 'e-same']);
      const replacement = fixture(300);
      replacement.analysis_timestamp = '2026-09-07T00:00:01.000Z';
      replacement.nodes = replacement.nodes.map(node => ({ ...node, name: `renamed${node.name}` }));
      await saveAnalysis(project, replacement, 'main', { canonicalSegmented: true });
      const again = (await loadScopedGraphSection(pinned, keep, graph))!;
      assert.ok(again.nodes.every(node => !node.name.startsWith('renamed')), 'pinned generation still serves its own records');
      delete (pinned.segmented.manifest as { record_store?: unknown }).record_store;
      const slow = (await loadScopedGraphSection(pinned, keep, graph))!;
      assert.equal(slow.source, 'stream');
      assert.deepEqual(slow.nodes.map(node => node.id).sort(), fast.nodes.map(node => node.id).sort());
      assert.deepEqual(slow.edges.map(edge => edge.id).sort(), fast.edges.map(edge => edge.id).sort());
    } finally {
      await pinned.release();
    }
  });
});

test('a record too large to store skips the record store but keeps the canonical generation publishable and streamable', async () => {
  await withStorage(async project => {
    const original = fixture(50);
    (original.nodes[7] as any).metadata.attributes.huge = 'h'.repeat(17 * 1024 * 1024);
    await saveAnalysis(project, original, 'main', { canonicalSegmented: true });
    const manifest = (await loadAnalysisSectionManifest(project))!;
    assert.equal(manifest.record_store, undefined, 'record store is skipped, not partially published');
    const graph = (await loadCompactAnalysisGraph(project))!;
    const pinned = (await acquirePinnedAnalysis(project))!;
    try {
      for (const file of fs.readdirSync(pinned.segmented.directory)) assert.ok(!file.startsWith('records.'), `no stray record file ${file}`);
      const section = (await loadScopedGraphSection(pinned, new Set(['n-7', 'n-8']), graph))!;
      assert.equal(section.source, 'stream');
      assert.equal(section.nodes.length, 2);
    } finally {
      await pinned.release();
    }
  });
});
