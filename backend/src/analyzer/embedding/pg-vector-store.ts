import type { Pool, PoolClient } from 'pg';
import type {
  VectorStore,
  NodeEmbeddingRecord,
  VectorStoreMeta,
  VectorQueryFilter,
  ScoredNodeId,
  VectorStoreStats,
} from './types';

const EF_SEARCH = 100;

function toVectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector).join(',')}]`;
}

export class PgVectorStore implements VectorStore {
  readonly kind = 'pgvector' as const;

  private readonly pool: Pool;
  private readonly expectedDimensions: number;
  private dimensionValidated = false;

  constructor(pool: Pool, expectedDimensions: number) {
    this.pool = pool;
    this.expectedDimensions = expectedDimensions;
  }

  private async validateDimensions(): Promise<void> {
    if (this.dimensionValidated) return;
    const result = await this.pool.query<{ dimensions: number | null }>(
      `SELECT a.atttypmod AS dimensions
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = 'node_embeddings'
         AND a.attname = 'embedding'
         AND a.attnum > 0
       LIMIT 1`,
    );
    if (result.rows.length === 0) {
      throw new Error(
        'PgVectorStore: node_embeddings.embedding column not found; run the embedding migration',
      );
    }
    const liveDimensions = result.rows[0].dimensions;
    if (liveDimensions !== this.expectedDimensions) {
      throw new Error(
        `PgVectorStore dimension mismatch: configured ${this.expectedDimensions}, live column ${liveDimensions}. Issue a migration before changing the model.`,
      );
    }
    this.dimensionValidated = true;
  }

  async upsert(analysisId: string, records: NodeEmbeddingRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.validateDimensions();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const record of records) {
        if (record.vector.length !== this.expectedDimensions) {
          throw new Error(
            `PgVectorStore upsert dimension mismatch: expected ${this.expectedDimensions}, got ${record.vector.length} for node ${record.nodeId}`,
          );
        }
        await client.query(
          `INSERT INTO node_embeddings
             (analysis_id, node_id, embedding, embedding_doc_hash, model, document_version, created_at)
           VALUES ($1, $2, $3::vector, $4, $5, $6, $7)
           ON CONFLICT (analysis_id, node_id)
           DO UPDATE SET
             embedding = EXCLUDED.embedding,
             embedding_doc_hash = EXCLUDED.embedding_doc_hash,
             model = EXCLUDED.model,
             document_version = EXCLUDED.document_version,
             created_at = EXCLUDED.created_at`,
          [
            analysisId,
            record.nodeId,
            toVectorLiteral(record.vector),
            record.embeddingDocHash,
            record.model,
            record.documentVersion,
            record.createdAt,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteNodes(analysisId: string, nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    await this.pool.query(
      'DELETE FROM node_embeddings WHERE analysis_id = $1 AND node_id = ANY($2::text[])',
      [analysisId, nodeIds],
    );
  }

  async deleteAnalysis(analysisId: string): Promise<void> {
    await this.pool.query('DELETE FROM node_embeddings WHERE analysis_id = $1', [analysisId]);
    await this.pool.query('DELETE FROM embedding_index_meta WHERE analysis_id = $1', [analysisId]);
  }

  async query(
    analysisId: string,
    vector: Float32Array,
    topK: number,
    filter?: VectorQueryFilter,
  ): Promise<ScoredNodeId[]> {
    if (topK <= 0) return [];
    await this.validateDimensions();
    if (vector.length !== this.expectedDimensions) {
      throw new Error(
        `PgVectorStore query dimension mismatch: expected ${this.expectedDimensions}, got ${vector.length}`,
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`);
      const result = await client.query<{ node_id: string; distance: string }>(
        `SELECT node_id, embedding <=> $2::vector AS distance
         FROM node_embeddings
         WHERE analysis_id = $1
         ORDER BY distance ASC
         LIMIT $3`,
        [analysisId, toVectorLiteral(vector), topK],
      );
      return result.rows.map((row) => ({
        nodeId: row.node_id,
        score: 1 - Number(row.distance),
      }));
    } finally {
      client.release();
    }
  }

  async listHashes(analysisId: string): Promise<Map<string, string>> {
    const result = await this.pool.query<{ node_id: string; embedding_doc_hash: string }>(
      'SELECT node_id, embedding_doc_hash FROM node_embeddings WHERE analysis_id = $1',
      [analysisId],
    );
    const hashes = new Map<string, string>();
    for (const row of result.rows) {
      hashes.set(row.node_id, row.embedding_doc_hash);
    }
    return hashes;
  }

  async getMeta(analysisId: string): Promise<VectorStoreMeta | null> {
    const result = await this.pool.query<{
      cas_version: string;
      analysis_id: string;
      cas_content_hash: string;
      model: string;
      dimensions: number;
      document_version: string;
      generated_at: Date;
    }>(
      `SELECT cas_version, analysis_id, cas_content_hash, model, dimensions, document_version, generated_at
       FROM embedding_index_meta
       WHERE analysis_id = $1`,
      [analysisId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      casVersion: row.cas_version,
      analysisId: row.analysis_id,
      casContentHash: row.cas_content_hash,
      model: row.model,
      dimensions: row.dimensions,
      documentVersion: row.document_version,
      generatedAt: new Date(row.generated_at).toISOString(),
    };
  }

  async putMeta(analysisId: string, meta: VectorStoreMeta): Promise<void> {
    await this.pool.query(
      `INSERT INTO embedding_index_meta
         (analysis_id, cas_version, cas_content_hash, model, dimensions, document_version, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (analysis_id)
       DO UPDATE SET
         cas_version = EXCLUDED.cas_version,
         cas_content_hash = EXCLUDED.cas_content_hash,
         model = EXCLUDED.model,
         dimensions = EXCLUDED.dimensions,
         document_version = EXCLUDED.document_version,
         generated_at = EXCLUDED.generated_at`,
      [
        analysisId,
        meta.casVersion,
        meta.casContentHash,
        meta.model,
        meta.dimensions,
        meta.documentVersion,
        meta.generatedAt,
      ],
    );
  }

  async stats(analysisId: string): Promise<VectorStoreStats> {
    const result = await this.pool.query<{ count: string; model: string | null }>(
      `SELECT COUNT(*)::text AS count, MAX(model) AS model
       FROM node_embeddings
       WHERE analysis_id = $1`,
      [analysisId],
    );
    const row = result.rows[0];
    return {
      count: Number(row.count),
      model: row.model ?? '',
      dimensions: this.expectedDimensions,
    };
  }
}

export type { PoolClient };
