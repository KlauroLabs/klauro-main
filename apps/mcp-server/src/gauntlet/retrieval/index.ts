/**
 * Retrieval backends for the gauntlet's competitor arms.
 *
 * Each backend models a real retrieval strategy an agent could use to decide
 * which files to read first:
 *   - cursor-proxy   -> lexical BM25 index (Cursor-style)
 *   - ctags          -> symbol index via the system ctags binary
 *   - embeddings-rag -> offline TF-IDF chunk embedding + cosine (RAG proxy)
 */

import type { RetrievalBackend } from './types';
import { lexicalBackend } from './lexical';
import { ctagsBackend } from './ctags';
import { embeddingsBackend } from './embeddings';

export { lexicalBackend } from './lexical';
export { ctagsBackend } from './ctags';
export { embeddingsBackend } from './embeddings';
export type {
  RetrievalBackend,
  RetrievalRequest,
  RetrievalResult,
  RetrievalCandidate,
} from './types';
export { DEFAULT_K } from './types';

export const BACKENDS: RetrievalBackend[] = [lexicalBackend, ctagsBackend, embeddingsBackend];

export const BACKENDS_BY_ID: Record<string, RetrievalBackend> = Object.fromEntries(
  BACKENDS.map(b => [b.id, b]),
);
