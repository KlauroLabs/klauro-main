import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { CASNode, CASOutput, CASEmbeddingIndex } from '../../types/cas.types';
import type { EmbeddingProvider, VectorStore, NodeEmbeddingRecord, VectorStoreMeta } from './types';
import { composeEmbeddingDocument, EMBEDDING_DOCUMENT_VERSION } from './embedding-document';
import { createYieldBudget } from '../core/event-loop-yield';
import { getActiveSourceCorpus } from '../core/source-corpus';

const DEFAULT_STORE_BATCH_SIZE = 4096;

interface EmbeddingSourceFile {
  content: string;
  lineStarts: readonly number[];
}

export interface EmbeddingPhaseConfig {
  provider: EmbeddingProvider;
  store: VectorStore;
  maxDocumentChars: number;
  phaseBudgetMs: number;
  storeBatchSize?: number;
}

export class EmbeddingPhase {
  constructor(private readonly config: EmbeddingPhaseConfig) {}

  async run(output: CASOutput, projectPath: string): Promise<void> {
    const { provider, store } = this.config;
    const analysisId = output.analysis_id;

    try {
      const nodeById = new Map<string, CASNode>();
      const liveIds = new Set<string>();
      const contentHashBasis: string[] = [];
      for (const node of output.nodes) {
        nodeById.set(node.id, node);
        liveIds.add(node.id);
        contentHashBasis.push(`${node.id}:${node.implementation?.body_hash ?? ''}`);
      }
      const storedMeta = await store.getMeta(analysisId);
      let storedHashes = await store.listHashes(analysisId);
      const canReuseStoredVectors = storedMeta?.model === provider.model &&
        storedMeta.dimensions === provider.dimensions &&
        storedMeta.documentVersion === EMBEDDING_DOCUMENT_VERSION;
      if (!canReuseStoredVectors && storedHashes.size > 0) {
        await store.deleteAnalysis(analysisId);
        storedHashes = new Map();
      }
      const orphans = [...storedHashes.keys()].filter(id => !liveIds.has(id));
      if (orphans.length > 0) {
        await store.deleteNodes(analysisId, orphans);
      }

      let embedded = 0;
      let failed = 0;
      let degraded = false;
      let degradedReason: string | undefined;
      const batchSize = Math.max(1, provider.maxBatch);
      const storeBatchSize = Math.max(1, this.config.storeBatchSize ?? DEFAULT_STORE_BATCH_SIZE);
      const recordsToUpsert: NodeEmbeddingRecord[] = [];
      const pending: ReturnType<typeof composeEmbeddingDocument>[] = [];
      const sourceFiles = new Map<string, EmbeddingSourceFile | null>();
      const sourceCorpus = getActiveSourceCorpus();
      const maybeYieldDocs = createYieldBudget();
      const flushRecords = async (all = false): Promise<void> => {
        while (recordsToUpsert.length >= storeBatchSize || (all && recordsToUpsert.length > 0)) {
          const records = recordsToUpsert.splice(0, storeBatchSize);
          await store.upsert(analysisId, records);
        }
      };
      const flush = async (): Promise<void> => {
        if (pending.length === 0) return;
        const batch = pending.splice(0, pending.length);
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
          return;
        }
        await flushRecords();
      };

      for (const node of output.nodes) {
        const sourceText = node.source?.raw ?? await this.readSourceSnippet(
          node,
          projectPath,
          sourceFiles,
          sourceCorpus,
        );
        const document = composeEmbeddingDocument(node, node.parent ? nodeById.get(node.parent) : undefined, {
          maxDocumentChars: this.config.maxDocumentChars,
          sourceText,
        });
        if (canReuseStoredVectors && storedHashes.get(document.nodeId) === document.docHash) {
          embedded += 1;
        } else {
          pending.push(document);
          if (pending.length >= batchSize) await flush();
        }
        await maybeYieldDocs();
      }
      await flush();
      await flushRecords(true);

      const generatedAt = new Date().toISOString();
      const meta: VectorStoreMeta = {
        casVersion: output.cas_version,
        analysisId,
        casContentHash: this.contentHash(contentHashBasis),
        model: provider.model,
        dimensions: provider.dimensions,
        documentVersion: EMBEDDING_DOCUMENT_VERSION,
        generatedAt,
      };
      if (canReuseStoredVectors || failed === 0) {
        await store.putMeta(analysisId, meta);
      }

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

  private async readSourceSnippet(
    node: CASNode,
    projectPath: string,
    sourceFiles: Map<string, EmbeddingSourceFile | null>,
    sourceCorpus = getActiveSourceCorpus(),
  ): Promise<string | undefined> {
    const file = node.source?.file;
    const startLine = node.source?.line;
    if (!file || !startLine) return undefined;

    const absolute = path.isAbsolute(file) ? file : path.join(projectPath, file);
    let sourceFile = sourceFiles.get(absolute);
    if (sourceFile === undefined) {
      const corpusEntry = sourceCorpus?.get(absolute);
      if (corpusEntry) {
        sourceFile = {
          content: corpusEntry.content,
          lineStarts: corpusEntry.lineStarts,
        };
      } else {
        try {
          const content = await fs.readFile(absolute, 'utf8');
          sourceFile = { content, lineStarts: this.lineStarts(content) };
        } catch {
          sourceFile = null;
        }
      }
      sourceFiles.set(absolute, sourceFile);
    }
    if (!sourceFile) return undefined;

    const endLine = node.source?.end_line ?? startLine;
    const startOffset = sourceFile.lineStarts[startLine - 1];
    if (startOffset === undefined) return undefined;
    const endOffset = endLine < sourceFile.lineStarts.length
      ? sourceFile.lineStarts[endLine] - 1
      : sourceFile.content.length;
    const snippet = sourceFile.content.slice(startOffset, endOffset);
    return snippet ? snippet.slice(0, this.config.maxDocumentChars) : undefined;
  }

  private lineStarts(content: string): number[] {
    const starts = [0];
    for (let index = 0; index < content.length; index++) {
      if (content.charCodeAt(index) === 10) starts.push(index + 1);
    }
    return starts;
  }

  private contentHash(basis: string[]): string {
    const canonical = basis.sort().join('|');
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }
}
