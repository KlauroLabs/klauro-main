import type { Pool } from 'pg';
import type { VectorStore } from './types';
import { FileVectorStore } from './file-vector-store';
import { PgVectorStore } from './pg-vector-store';

export type VectorStoreSetting = 'file' | 'pgvector';

export interface VectorStoreFactoryOptions {
  store: VectorStoreSetting;
  fileBaseDir: string;
  pgPool?: Pool;
  expectedDimensions?: number;
}

export function createVectorStore(options: VectorStoreFactoryOptions): VectorStore {
  if (options.store === 'pgvector') {
    if (!options.pgPool) {
      throw new Error('createVectorStore: pgvector store requires a pgPool connection');
    }
    if (options.expectedDimensions === undefined) {
      throw new Error('createVectorStore: pgvector store requires expectedDimensions');
    }
    return new PgVectorStore(options.pgPool, options.expectedDimensions);
  }
  return new FileVectorStore(options.fileBaseDir);
}
