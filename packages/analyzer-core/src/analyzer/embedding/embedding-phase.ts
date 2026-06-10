import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { CASNode, CASOutput, CASEmbeddingIndex } from '../../types/cas.types';
import type { EmbeddingProvider, VectorStore, NodeEmbeddingRecord, VectorStoreMeta } from './types';
import { composeEmbeddingDocument, EMBEDDING_DOCUMENT_VERSION } from './embedding-document';

export interface EmbeddingPhaseConfig {
  provider: EmbeddingProvider;
  store: VectorStore;
  maxDocumentChars: number;
  phaseBudgetMs: number;
}

export class EmbeddingPhase {
  constructor(private readonly config: EmbeddingPhaseConfig) {}

  async run(output: CASOutput, projectPath: string): Promise<void> {
    const { provider, store } = this.config;
    const analysisId = output.analysis_id;
    const startedAt = Date.now();

    try {
      await this.captureSource(output.nodes, projectPath);

      const nodeById = new Map(output.nodes.map(node => [node.id, node]));
      const documents = output.nodes.map(node =>
        composeEmbeddingDocument(node, node.parent ? nodeById.get(node.parent) : undefined, {
          maxDocumentChars: this.config.maxDocumentChars,
        }),
      );

      const storedHashes = await store.listHashes(analysisId);
      const liveIds = new Set(output.nodes.map(node => node.id));
      const orphans = [...storedHashes.keys()].filter(id => !liveIds.has(id));
      if (orphans.length > 0) {
        await store.deleteNodes(analysisId, orphans);
      }

      const stale: typeof documents = [];
      let embedded = 0;
      for (const document of documents) {
        if (storedHashes.get(document.nodeId) === document.docHash) {
          embedded += 1;
        } else {
          stale.push(document);
        }
      }

      let failed = 0;
      let degraded = false;
      let degradedReason: string | undefined;
      const batchSize = Math.max(1, provider.maxBatch);
      const recordsToUpsert: NodeEmbeddingRecord[] = [];

      for (let offset = 0; offset < stale.length; offset += batchSize) {
        if (Date.now() - startedAt > this.config.phaseBudgetMs) {
          degraded = true;
          degradedReason = `Embedding budget of ${this.config.phaseBudgetMs}ms exhausted; ${stale.length - offset} nodes deferred to a later run`;
          break;
        }
        const batch = stale.slice(offset, offset + batchSize);
        try {
          const vectors = await provider.embed(batch.map(document => document.text));
          const createdAt = new Date().toISOString();
          const records: NodeEmbeddingRecord[] = batch.map((document, index) => ({
            nodeId: document.nodeId,
            analysisId,
            vector: vectors[index],
            embeddingDocHash: document.docHash,
            model: provider.model,
            documentVersion: EMBEDDING_DOCUMENT_VERSION,
            createdAt,
          }));
          recordsToUpsert.push(...records);
          embedded += records.length;
        } catch (error) {
          failed += batch.length;
          degraded = true;
          degradedReason = error instanceof Error ? error.message : String(error);
        }
      }

      if (recordsToUpsert.length > 0) {
        await store.upsert(analysisId, recordsToUpsert);
      }

      const generatedAt = new Date().toISOString();
      const meta: VectorStoreMeta = {
        casVersion: output.cas_version,
        analysisId,
        casContentHash: this.contentHash(output.nodes),
        model: provider.model,
        dimensions: provider.dimensions,
        documentVersion: EMBEDDING_DOCUMENT_VERSION,
        generatedAt,
      };
      await store.putMeta(analysisId, meta);

      const index: CASEmbeddingIndex = {
        model: provider.model,
        provider: provider.id,
        dimensions: provider.dimensions,
        document_version: EMBEDDING_DOCUMENT_VERSION,
        store: store.kind,
        generated_at: generatedAt,
        node_count: output.nodes.length,
        coverage: {
          embedded,
          skipped: Math.max(0, output.nodes.length - embedded - failed),
          failed,
        },
      };
      if (degraded) {
        index.degraded = true;
        index.degraded_reason = degradedReason;
      }
      output.embedding_index = index;
    } catch (error) {
      output.embedding_index = {
        model: provider.model,
        provider: provider.id,
        dimensions: provider.dimensions,
        document_version: EMBEDDING_DOCUMENT_VERSION,
        store: store.kind,
        generated_at: new Date().toISOString(),
        node_count: output.nodes.length,
        coverage: { embedded: 0, skipped: output.nodes.length, failed: 0 },
        degraded: true,
        degraded_reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async captureSource(nodes: CASNode[], projectPath: string): Promise<void> {
    const fileLines = new Map<string, string[] | null>();

    for (const node of nodes) {
      if (node.source?.raw) continue;
      const file = node.source?.file;
      const startLine = node.source?.line;
      if (!file || !startLine) continue;

      let lines = fileLines.get(file);
      if (lines === undefined) {
        const absolute = path.isAbsolute(file) ? file : path.join(projectPath, file);
        try {
          lines = (await fs.readFile(absolute, 'utf8')).split('\n');
        } catch {
          lines = null;
        }
        fileLines.set(file, lines);
      }
      if (!lines) continue;

      const endLine = node.source?.end_line ?? startLine;
      const snippet = lines.slice(startLine - 1, endLine).join('\n');
      if (snippet) {
        node.source = {
          ...node.source,
          raw: snippet.slice(0, this.config.maxDocumentChars),
        };
      }
    }
  }

  private contentHash(nodes: CASNode[]): string {
    const basis = nodes
      .map(node => `${node.id}:${node.implementation?.body_hash ?? ''}`)
      .sort()
      .join('|');
    return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
  }
}
