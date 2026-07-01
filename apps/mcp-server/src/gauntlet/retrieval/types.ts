/**
 * Retrieval contract for competitor arms.
 *
 * Each non-Klauro, non-baseline arm models a real retrieval strategy: given a
 * repo and a task, rank the candidate files an agent should look at first. The
 * ranked list is injected into that arm's agent prompt (via the live engine's
 * withoutArmRetrievedFiles hook), so the arm competes on the quality of its
 * retrieval — exactly how ctags / embeddings / a Cursor-style index would help a
 * real agent. Klauro, by contrast, supplies a precomputed agent context.
 *
 * Backends are pure-ish (filesystem read only), deterministic, and bounded.
 */

export interface RetrievalRequest {
  /** Absolute path to the repository copy. */
  repoPath: string;
  /** The task text (label + expected outcome) to retrieve against. */
  query: string;
  /** Max candidates to return. */
  k: number;
}

export interface RetrievalCandidate {
  /** Repo-relative file path. */
  file: string;
  /** Backend score (higher = more relevant); for ranking/debug only. */
  score: number;
  /** Optional symbol/line the backend matched on. */
  hint?: string;
}

export interface RetrievalResult {
  backend: string;
  candidates: RetrievalCandidate[];
  /** ms spent building+querying the index (counts toward the arm's cost). */
  index_ms: number;
  /** Notes (e.g. degraded mode, binary missing). */
  note?: string;
}

export interface RetrievalBackend {
  /** Stable id, matches the arm id (ctags, embeddings-rag, cursor-proxy). */
  id: string;
  /** Build/query the index and return ranked candidates. Never throws; on
   *  failure returns an empty result with a note (the arm then degrades to
   *  unaided exploration, which is the honest competitor behavior). */
  retrieve(req: RetrievalRequest): Promise<RetrievalResult>;
}

/** Default candidate budget per arm. */
export const DEFAULT_K = 12;
