export interface EmbeddingProviderOptions {
  model: string;
  dimensions: number;
  maxBatch: number;
  maxConcurrency: number;
  apiKeyEnv?: string;
}

export interface EmbeddingProvider {
  readonly id: 'api' | 'local';
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingDocument {
  nodeId: string;
  text: string;
  docHash: string;
}

export interface NodeEmbeddingRecord {
  nodeId: string;
  analysisId: string;
  vector: Float32Array;
  embeddingDocHash: string;
  model: string;
  documentVersion: string;
  createdAt: string;
}

export interface VectorStoreMeta {
  casVersion: string;
  analysisId: string;
  casContentHash: string;
  model: string;
  dimensions: number;
  documentVersion: string;
  generatedAt: string;
}

export interface VectorQueryFilter {
  types?: string[];
  files?: string[];
}

export interface ScoredNodeId {
  nodeId: string;
  score: number;
}

export interface VectorStoreStats {
  count: number;
  model: string;
  dimensions: number;
}

export interface VectorStore {
  readonly kind: 'file' | 'pgvector';
  upsert(analysisId: string, records: NodeEmbeddingRecord[]): Promise<void>;
  deleteNodes(analysisId: string, nodeIds: string[]): Promise<void>;
  deleteAnalysis(analysisId: string): Promise<void>;
  query(
    analysisId: string,
    vector: Float32Array,
    topK: number,
    filter?: VectorQueryFilter,
  ): Promise<ScoredNodeId[]>;
  listHashes(analysisId: string): Promise<Map<string, string>>;
  getMeta(analysisId: string): Promise<VectorStoreMeta | null>;
  putMeta(analysisId: string, meta: VectorStoreMeta): Promise<void>;
  stats(analysisId: string): Promise<VectorStoreStats>;
}
