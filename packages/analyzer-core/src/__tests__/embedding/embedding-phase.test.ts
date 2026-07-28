jest.unmock('fs-extra');
jest.unmock('fs');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { EmbeddingPhase } from '../../analyzer/embedding/embedding-phase';
import { FileVectorStore } from '../../analyzer/embedding/file-vector-store';
import type { EmbeddingProvider, NodeEmbeddingRecord } from '../../analyzer/embedding/types';
import { AnalyzerSourceCorpus, withSourceCorpus } from '../../analyzer/core/source-corpus';
import type { CASNode, CASOutput } from '../../types/cas.types';

const DIMENSIONS = 8;

class FakeProvider implements EmbeddingProvider {
  readonly id = 'api' as const;
  readonly dimensions = DIMENSIONS;
  readonly maxBatch = 16;
  embedCalls = 0;
  embeddedTexts: string[] = [];

  constructor(readonly model = 'fake-model') {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls += 1;
    this.embeddedTexts.push(...texts);
    return texts.map(text => {
      const vector = new Float32Array(DIMENSIONS);
      for (let i = 0; i < text.length; i += 1) {
        vector[i % DIMENSIONS] += text.charCodeAt(i) / 255;
      }
      return vector;
    });
  }
}

class SlowThrowingProvider implements EmbeddingProvider {
  readonly id = 'api' as const;
  readonly dimensions = DIMENSIONS;
  readonly maxBatch = 16;

  constructor(readonly model = 'fake-model') {}

  async embed(): Promise<Float32Array[]> {
    await new Promise(resolve => setTimeout(resolve, 5));
    throw new Error('provider unavailable');
  }
}

class RecordingFileVectorStore extends FileVectorStore {
  readonly upsertBatchSizes: number[] = [];

  override async upsert(analysisId: string, records: NodeEmbeddingRecord[]): Promise<void> {
    this.upsertBatchSizes.push(records.length);
    await super.upsert(analysisId, records);
  }
}

function makeNode(id: string, bodyHash: string): CASNode {
  return {
    id,
    name: id,
    type: 'function',
    qualified_name: `mod.${id}`,
    implementation: { body_hash: bodyHash },
    source: { raw: `function ${id}() { return ${bodyHash}; }` },
  } as CASNode;
}

function makeOutput(nodes: CASNode[]): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: '2026-01-01T00:00:00.000Z',
    analysis_id: 'phase-test',
    system: {
      id: 'phase-test',
      name: 'phase-test',
      type: 'application',
      root_path: '/tmp/phase-test',
    },
    nodes,
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 1 },
  } as unknown as CASOutput;
}

describe('EmbeddingPhase', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-phase-'));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  it('embeds all nodes on the first run', async () => {
    const provider = new FakeProvider();
    const store = new FileVectorStore(dir);
    const phase = new EmbeddingPhase({ provider, store, maxDocumentChars: 4000, phaseBudgetMs: 60000 });

    const output = makeOutput([makeNode('a', 'h1'), makeNode('b', 'h2'), makeNode('c', 'h3')]);
    const nodesBefore = structuredClone(output.nodes);
    await phase.run(output, dir);

    expect(output.embedding_index).toBeDefined();
    expect(output.embedding_index!.node_count).toBe(3);
    expect(output.embedding_index!.coverage.embedded).toBe(3);
    expect(output.embedding_index!.coverage.failed).toBe(0);
    expect(output.embedding_index!.degraded).toBeUndefined();
    expect(provider.embeddedTexts.length).toBe(3);
    expect(output.nodes).toEqual(nodesBefore);

    const hashes = await store.listHashes('phase-test');
    expect(hashes.size).toBe(3);
  });

  it('re-embeds nothing on a second run with no changes', async () => {
    const provider = new FakeProvider();
    const store = new FileVectorStore(dir);
    const config = { provider, store, maxDocumentChars: 4000, phaseBudgetMs: 60000 };

    const nodes = [makeNode('a', 'h1'), makeNode('b', 'h2')];
    await new EmbeddingPhase(config).run(makeOutput(nodes), dir);
    const callsAfterFirst = provider.embedCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const secondOutput = makeOutput([makeNode('a', 'h1'), makeNode('b', 'h2')]);
    await new EmbeddingPhase(config).run(secondOutput, dir);

    expect(provider.embedCalls).toBe(callsAfterFirst);
    expect(secondOutput.embedding_index!.coverage.embedded).toBe(2);
  });

  it('re-embeds when stored vector provenance does not match the provider', async () => {
    const store = new FileVectorStore(dir);
    const nodes = [makeNode('a', 'h1'), makeNode('b', 'h2')];
    await new EmbeddingPhase({
      provider: new FakeProvider('old-model'),
      store,
      maxDocumentChars: 4000,
      phaseBudgetMs: 60000,
    }).run(makeOutput(nodes), dir);

    const provider = new FakeProvider('new-model');
    await new EmbeddingPhase({
      provider,
      store,
      maxDocumentChars: 4000,
      phaseBudgetMs: 60000,
    }).run(makeOutput(nodes), dir);

    expect(provider.embeddedTexts).toHaveLength(2);
    expect((await store.getMeta('phase-test'))!.model).toBe('new-model');
  });

  it('re-embeds indexes from the pre-provenance document version', async () => {
    const provider = new FakeProvider();
    const store = new FileVectorStore(dir);
    const config = { provider, store, maxDocumentChars: 4000, phaseBudgetMs: 60000 };
    const nodes = [makeNode('a', 'h1')];
    await new EmbeddingPhase(config).run(makeOutput(nodes), dir);
    const meta = (await store.getMeta('phase-test'))!;
    await store.putMeta('phase-test', { ...meta, documentVersion: '1.0' });
    provider.embeddedTexts = [];
    provider.embedCalls = 0;

    await new EmbeddingPhase(config).run(makeOutput(nodes), dir);

    expect(provider.embeddedTexts).toHaveLength(1);
  });

  it('re-embeds only nodes whose body_hash changed', async () => {
    const provider = new FakeProvider();
    const store = new FileVectorStore(dir);
    const config = { provider, store, maxDocumentChars: 4000, phaseBudgetMs: 60000 };

    await new EmbeddingPhase(config).run(
      makeOutput([makeNode('a', 'h1'), makeNode('b', 'h2'), makeNode('c', 'h3')]),
      dir,
    );
    provider.embeddedTexts = [];
    provider.embedCalls = 0;

    const secondOutput = makeOutput([
      makeNode('a', 'h1'),
      makeNode('b', 'CHANGED'),
      makeNode('c', 'h3'),
    ]);
    await new EmbeddingPhase(config).run(secondOutput, dir);

    expect(provider.embedCalls).toBe(1);
    expect(provider.embeddedTexts.length).toBe(1);
    expect(provider.embeddedTexts[0]).toContain('CHANGED');
    expect(secondOutput.embedding_index!.coverage.embedded).toBe(3);
  });

  it('deletes the stored vector of a node removed from output (orphan reconciliation)', async () => {
    const provider = new FakeProvider();
    const store = new FileVectorStore(dir);
    const config = { provider, store, maxDocumentChars: 4000, phaseBudgetMs: 60000 };

    await new EmbeddingPhase(config).run(
      makeOutput([makeNode('a', 'h1'), makeNode('b', 'h2'), makeNode('c', 'h3')]),
      dir,
    );
    expect((await store.listHashes('phase-test')).size).toBe(3);

    await new EmbeddingPhase(config).run(
      makeOutput([makeNode('a', 'h1'), makeNode('c', 'h3')]),
      dir,
    );

    const hashes = await store.listHashes('phase-test');
    expect([...hashes.keys()].sort()).toEqual(['a', 'c']);
    expect(hashes.has('b')).toBe(false);
  });

  it('treats the phase budget as an SLO and still completes every embedding', async () => {
    const provider = new FakeProvider();
    const store = new FileVectorStore(dir);
    const phase = new EmbeddingPhase({ provider, store, maxDocumentChars: 4000, phaseBudgetMs: -1 });

    const output = makeOutput([makeNode('a', 'h1'), makeNode('b', 'h2')]);
    await phase.run(output, dir);

    expect(output.embedding_index).toBeDefined();
    expect(output.embedding_index!.degraded).toBeUndefined();
    expect(output.embedding_index!.coverage.embedded).toBe(2);
    expect(provider.embedCalls).toBeGreaterThan(0);
  });

  it('uses the captured source corpus without rereading or mutating the CAS node', async () => {
    const provider = new FakeProvider();
    const store = new FileVectorStore(dir);
    const phase = new EmbeddingPhase({ provider, store, maxDocumentChars: 4000, phaseBudgetMs: 60000 });
    const sourcePath = path.join(dir, 'source.ts');
    const content = 'export function source() {\r\n  return 42;\r\n}\r\n';
    await fs.writeFile(sourcePath, content);
    const corpus = new AnalyzerSourceCorpus();
    corpus.capture(sourcePath, content);
    await fs.remove(sourcePath);
    const node = makeNode('source', 'h1');
    node.source = { file: sourcePath, line: 1, end_line: 2 };
    const output = makeOutput([node]);

    await withSourceCorpus(corpus, () => phase.run(output, dir));

    expect(provider.embeddedTexts[0]).toContain('export function source() {\r\n  return 42;\r');
    expect(output.nodes[0].source?.raw).toBeUndefined();
    expect(corpus.stats().entryHits).toBe(1);
  });

  it('bounds vector-store upserts without changing embedding coverage', async () => {
    const provider = new FakeProvider();
    const store = new RecordingFileVectorStore(dir);
    const phase = new EmbeddingPhase({
      provider,
      store,
      maxDocumentChars: 4000,
      phaseBudgetMs: 60000,
      storeBatchSize: 5,
    });
    const output = makeOutput(
      Array.from({ length: 12 }, (_, index) => makeNode(`node-${index}`, `hash-${index}`)),
    );

    await phase.run(output, dir);

    expect(store.upsertBatchSizes).toEqual([5, 5, 2]);
    expect(output.embedding_index!.coverage).toEqual({ embedded: 12, skipped: 0, failed: 0 });
    expect((await store.listHashes('phase-test')).size).toBe(12);
  });

  it('is non-fatal when the provider throws and still sets a degraded index', async () => {
    const provider = new SlowThrowingProvider();
    const store = new FileVectorStore(dir);
    const phase = new EmbeddingPhase({ provider, store, maxDocumentChars: 4000, phaseBudgetMs: 60000 });

    const output = makeOutput([makeNode('a', 'h1'), makeNode('b', 'h2')]);
    await expect(phase.run(output, dir)).resolves.toBeUndefined();

    expect(output.embedding_index).toBeDefined();
    expect(output.embedding_index!.degraded).toBe(true);
    expect(output.embedding_index!.coverage.failed).toBe(2);
    expect(output.embedding_index!.degraded_reason).toContain('provider unavailable');
  });

  it('does not retain vectors from incompatible provenance when replacement fails', async () => {
    const store = new FileVectorStore(dir);
    const nodes = [makeNode('a', 'h1'), makeNode('b', 'h2')];
    await new EmbeddingPhase({
      provider: new FakeProvider('old-model'),
      store,
      maxDocumentChars: 4000,
      phaseBudgetMs: 60000,
    }).run(makeOutput(nodes), dir);

    const output = makeOutput(nodes);
    await new EmbeddingPhase({
      provider: new SlowThrowingProvider('new-model'),
      store,
      maxDocumentChars: 4000,
      phaseBudgetMs: 60000,
    }).run(output, dir);

    expect(output.embedding_index!.degraded).toBe(true);
    expect((await store.listHashes('phase-test')).size).toBe(0);
    expect(await store.getMeta('phase-test')).toBeNull();
  });
});
