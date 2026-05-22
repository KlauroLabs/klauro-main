import { Migration } from '@mikro-orm/migrations';

const PARTITION_COUNT = 8;

export class Migration20260520000000AddNodeEmbeddings extends Migration {
  async up(): Promise<void> {
    this.addSql('CREATE EXTENSION IF NOT EXISTS vector;');

    this.addSql(`
      CREATE TABLE node_embeddings (
        id                 BIGSERIAL,
        analysis_id        TEXT NOT NULL,
        node_id            TEXT NOT NULL,
        embedding          vector(1024) NOT NULL,
        embedding_doc_hash TEXT NOT NULL,
        model              TEXT NOT NULL,
        document_version   TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (analysis_id, node_id)
      ) PARTITION BY HASH (analysis_id);
    `);

    for (let partition = 0; partition < PARTITION_COUNT; partition += 1) {
      this.addSql(`
        CREATE TABLE node_embeddings_p${partition}
          PARTITION OF node_embeddings
          FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${partition});
      `);
      this.addSql(`
        CREATE INDEX idx_node_embeddings_p${partition}_hnsw
          ON node_embeddings_p${partition}
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
      `);
    }

    this.addSql(`
      CREATE TABLE embedding_index_meta (
        analysis_id      TEXT PRIMARY KEY,
        cas_version      TEXT NOT NULL,
        cas_content_hash TEXT NOT NULL,
        model            TEXT NOT NULL,
        dimensions       INTEGER NOT NULL,
        document_version TEXT NOT NULL,
        generated_at     TIMESTAMPTZ NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS embedding_index_meta CASCADE;');
    this.addSql('DROP TABLE IF EXISTS node_embeddings CASCADE;');
  }
}
