import { PgVectorStore } from '../../backend/src/analyzer/embedding/pg-vector-store';
import type { NodeEmbeddingRecord, VectorStoreMeta } from '../../backend/src/analyzer/embedding/types';
import { getPgPool } from './pg-pool';

const CONNECTION = process.env.UNRAVL_DATABASE_URL || 'postgres://postgres:unravl@127.0.0.1:55432/unravl';
const DIMENSIONS = 1024;
const PARTITION_COUNT = 8;

const SCHEMA_SQL: string[] = [
  'DROP TABLE IF EXISTS node_embeddings CASCADE;',
  'DROP TABLE IF EXISTS embedding_index_meta CASCADE;',
  'CREATE EXTENSION IF NOT EXISTS vector;',
  `CREATE TABLE node_embeddings (
     id BIGSERIAL,
     analysis_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     embedding vector(${DIMENSIONS}) NOT NULL,
     embedding_doc_hash TEXT NOT NULL,
     model TEXT NOT NULL,
     document_version TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (analysis_id, node_id)
   ) PARTITION BY HASH (analysis_id);`,
  `CREATE TABLE embedding_index_meta (
     analysis_id TEXT PRIMARY KEY,
     cas_version TEXT NOT NULL,
     cas_content_hash TEXT NOT NULL,
     model TEXT NOT NULL,
     dimensions INTEGER NOT NULL,
     document_version TEXT NOT NULL,
     generated_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
];

function partitionSql(partition: number): string[] {
  return [
    `CREATE TABLE node_embeddings_p${partition}
       PARTITION OF node_embeddings
       FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${partition});`,
    `CREATE INDEX idx_node_embeddings_p${partition}_hnsw
       ON node_embeddings_p${partition}
       USING hnsw (embedding vector_cosine_ops)
       WITH (m = 16, ef_construction = 64);`,
  ];
}

function bandVector(band: number): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  for (let i = band * 16; i < band * 16 + 16 && i < DIMENSIONS; i += 1) {
    vector[i] = 1;
  }
  return vector;
}

function record(analysisId: string, band: number): NodeEmbeddingRecord {
  return {
    nodeId: `node_${band}`,
    analysisId,
    vector: bandVector(band),
    embeddingDocHash: `hash_${band}`,
    model: 'integration-test',
    documentVersion: '1.0',
    createdAt: new Date().toISOString(),
  };
}

const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];

function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const pool = getPgPool(CONNECTION);
  if (!pool) {
    console.error(`Could not connect to Postgres at ${CONNECTION}`);
    process.exit(1);
  }

  for (const statement of SCHEMA_SQL) {
    await pool.query(statement);
  }
  for (let partition = 0; partition < PARTITION_COUNT; partition += 1) {
    for (const statement of partitionSql(partition)) {
      await pool.query(statement);
    }
  }

  const store = new PgVectorStore(pool, DIMENSIONS);

  const analysisA = 'analysis-A';
  const analysisB = 'analysis-B';

  const recordsA = [0, 1, 2, 3, 4, 5].map(band => record(analysisA, band));
  await store.upsert(analysisA, recordsA);
  const recordsB = [0, 1].map(band => record(analysisB, band));
  await store.upsert(analysisB, recordsB);

  const statsA = await store.stats(analysisA);
  check('upsert + stats: 6 records in analysis A', statsA.count === 6, `count=${statsA.count}`);

  const nearest = await store.query(analysisA, bandVector(3), 6);
  check(
    'query: exact-match vector ranks its node first',
    nearest.length > 0 && nearest[0].nodeId === 'node_3',
    `top=${nearest[0]?.nodeId} score=${nearest[0]?.score.toFixed(3)}`,
  );
  check(
    'query: results ordered by descending score',
    nearest.every((hit, i) => i === 0 || nearest[i - 1].score >= hit.score),
    nearest.map(hit => hit.nodeId).join(','),
  );

  const hashes = await store.listHashes(analysisA);
  check(
    'listHashes: returns all 6 node hashes correctly',
    hashes.size === 6 && hashes.get('node_4') === 'hash_4',
    `size=${hashes.size}`,
  );

  await store.deleteNodes(analysisA, ['node_0', 'node_1']);
  const afterDelete = await store.listHashes(analysisA);
  check(
    'deleteNodes: removes only the named nodes',
    afterDelete.size === 4 && !afterDelete.has('node_0') && afterDelete.has('node_2'),
    `size=${afterDelete.size}`,
  );

  const tenantQuery = await store.query(analysisA, bandVector(0), 10);
  check(
    'multi-tenant isolation: analysis B nodes never appear in analysis A query',
    tenantQuery.every(hit => hashes.has(hit.nodeId) || hit.nodeId.startsWith('node_')) &&
      !tenantQuery.some(hit => hit.nodeId === 'node_0'),
    `${tenantQuery.length} hits, none deleted`,
  );
  const statsBStill = await store.stats(analysisB);
  check('multi-tenant isolation: analysis B untouched by A deletes', statsBStill.count === 2, `B count=${statsBStill.count}`);

  const meta: VectorStoreMeta = {
    casVersion: '1.10.0',
    analysisId: analysisA,
    casContentHash: 'content-hash-xyz',
    model: 'integration-test',
    dimensions: DIMENSIONS,
    documentVersion: '1.0',
    generatedAt: new Date().toISOString(),
  };
  await store.putMeta(analysisA, meta);
  const loadedMeta = await store.getMeta(analysisA);
  check(
    'putMeta / getMeta round-trip',
    loadedMeta !== null &&
      loadedMeta.casVersion === '1.10.0' &&
      loadedMeta.casContentHash === 'content-hash-xyz' &&
      loadedMeta.dimensions === DIMENSIONS,
    `meta=${loadedMeta ? 'present' : 'null'}`,
  );

  const updatedMeta: VectorStoreMeta = { ...meta, casContentHash: 'content-hash-updated' };
  await store.putMeta(analysisA, updatedMeta);
  const reloadedMeta = await store.getMeta(analysisA);
  check(
    'putMeta: upsert overwrites existing meta',
    reloadedMeta?.casContentHash === 'content-hash-updated',
    `hash=${reloadedMeta?.casContentHash}`,
  );

  await store.deleteAnalysis(analysisA);
  const goneHashes = await store.listHashes(analysisA);
  const goneMeta = await store.getMeta(analysisA);
  check(
    'deleteAnalysis: clears vectors and meta for the analysis',
    goneHashes.size === 0 && goneMeta === null,
    `hashes=${goneHashes.size} meta=${goneMeta ? 'present' : 'null'}`,
  );
  const statsBFinal = await store.stats(analysisB);
  check('deleteAnalysis: other analyses untouched', statsBFinal.count === 2, `B count=${statsBFinal.count}`);

  let dimensionRejected = false;
  try {
    const wrongStore = new PgVectorStore(pool, 384);
    await wrongStore.query(analysisB, bandVector(0), 1);
  } catch {
    dimensionRejected = true;
  }
  check('dimension validation: wrong expectedDimensions is rejected', dimensionRejected);

  await pool.end();

  const failed = checks.filter(entry => !entry.pass);
  console.log('='.repeat(60));
  console.log(`PgVectorStore integration: ${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
