/**
 * Embeddings/RAG retrieval backend — semantic-retrieval proxy.
 *
 * The repo's own `semanticSearch` (src/semantic-search.ts) requires a
 * precomputed CAS + embedding store for the target repo, which we do NOT have
 * for an arbitrary repoPath handed to the gauntlet. So this backend implements
 * a self-contained, offline embedding proxy that needs no external API:
 *   - chunk each source file into ~60-line windows
 *   - build a TF-IDF vector per chunk over the chunk corpus
 *   - embed the query as a TF-IDF vector in the same space
 *   - rank chunks by cosine similarity, then dedupe to top-k distinct files
 *
 * This models how embeddings/RAG retrieval surfaces semantically-near code,
 * deterministically and reproducibly. The result note records which mode ran.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import type { RetrievalBackend, RetrievalRequest, RetrievalResult, RetrievalCandidate } from './types';
import { tokenize, walkSourceFiles } from './lexical';

function CONTAINS_NUL(text: string): boolean {
  return text.indexOf("\u0000") !== -1;
}

const CHUNK_LINES = 60;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CHUNKS = 20_000;

interface Chunk {
  file: string;
  startLine: number;
  tf: Map<string, number>;
}

function chunkFile(content: string): Array<{ startLine: number; tokens: string[] }> {
  const lines = content.split('\n');
  const out: Array<{ startLine: number; tokens: string[] }> = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES).join('\n');
    const tokens = tokenize(slice);
    if (tokens.length === 0) continue;
    out.push({ startLine: i + 1, tokens });
  }
  return out;
}

export const embeddingsBackend: RetrievalBackend = {
  id: 'embeddings-rag',
  async retrieve(req: RetrievalRequest): Promise<RetrievalResult> {
    const start = Date.now();
    const k = req.k > 0 ? req.k : 12;
    const MODE = 'tfidf-chunk-cosine (offline embedding proxy)';
    try {
      const queryTokens = tokenize(req.query);
      if (queryTokens.length === 0) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: `${MODE}: empty query` };
      }

      const files = await walkSourceFiles(req.repoPath);
      if (files.length === 0) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: `${MODE}: no source files` };
      }

      const chunks: Chunk[] = [];
      const df = new Map<string, number>(); // chunk-document frequency per term
      for (const full of files) {
        if (chunks.length >= MAX_CHUNKS) break;
        let content: string;
        try {
          const st = await fs.stat(full);
          if (st.size > MAX_FILE_BYTES) continue;
          content = await fs.readFile(full, 'utf8');
        } catch {
          continue;
        }
        if (CONTAINS_NUL(content)) continue; // skip binary
        const rel = path.relative(req.repoPath, full);
        for (const c of chunkFile(content)) {
          if (chunks.length >= MAX_CHUNKS) break;
          const tf = new Map<string, number>();
          for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
          for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
          chunks.push({ file: rel, startLine: c.startLine, tf });
        }
      }

      if (chunks.length === 0) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: `${MODE}: no indexable chunks` };
      }

      const N = chunks.length;
      const idf = (term: string): number => Math.log(1 + N / (1 + (df.get(term) || 0)));

      // Query vector (TF-IDF) and its norm.
      const qtf = new Map<string, number>();
      for (const t of queryTokens) qtf.set(t, (qtf.get(t) || 0) + 1);
      const qvec = new Map<string, number>();
      let qNorm = 0;
      for (const [term, f] of qtf) {
        const w = f * idf(term);
        if (w === 0) continue;
        qvec.set(term, w);
        qNorm += w * w;
      }
      qNorm = Math.sqrt(qNorm);
      if (qNorm === 0) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: `${MODE}: query terms absent from corpus` };
      }

      // Best chunk per file by cosine similarity to the query.
      const bestByFile = new Map<string, { score: number; startLine: number }>();
      for (const c of chunks) {
        // Only need to iterate query terms; non-query dims don't affect the dot product.
        let dot = 0;
        let cNorm = 0;
        for (const [term, f] of c.tf) {
          const w = f * idf(term);
          cNorm += w * w;
          const qv = qvec.get(term);
          if (qv) dot += w * qv;
        }
        if (dot <= 0) continue;
        cNorm = Math.sqrt(cNorm);
        const cosine = dot / (qNorm * cNorm);
        const prev = bestByFile.get(c.file);
        if (!prev || cosine > prev.score) bestByFile.set(c.file, { score: cosine, startLine: c.startLine });
      }

      if (bestByFile.size === 0) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: `${MODE}: no chunk overlapped query` };
      }

      const scored: RetrievalCandidate[] = [];
      for (const [file, best] of bestByFile) {
        scored.push({ file, score: best.score, hint: `chunk@L${best.startLine}` });
      }
      scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

      return {
        backend: this.id,
        candidates: scored.slice(0, k),
        index_ms: Date.now() - start,
        note: `${MODE}: ${chunks.length} chunks over ${bestByFile.size} files`,
      };
    } catch (err) {
      return {
        backend: this.id,
        candidates: [],
        index_ms: Date.now() - start,
        note: `${MODE}: degraded: ${(err as Error)?.message ?? String(err)}`,
      };
    }
  },
};
