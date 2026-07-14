/**
 * Small LRU cache for serialized HTTP response bodies whose payload is a pure
 * function of a stored analysis (CAS) — e.g. GET /api/projects/{id}/conceptual
 * and /semantic-coverage in remote-analyzer-service.ts.
 *
 * Why this exists (TASK: server read-paths starve during whale re-analysis):
 * on a whale CAS (2,705 files / 45k nodes) each /conceptual request re-loads +
 * re-parses the whole stored CAS and recomputes getFlowConcepts +
 * getArchitecturalConflicts + getParadigmConformance + getPerspectives —
 * several seconds of synchronous CPU per request, exactly while the in-process
 * analyzer is already saturating the event loop. The payload only changes when
 * the stored analysis (or the element-description store joined onto it)
 * changes, so we cache the SERIALIZED body keyed on a version fingerprint of
 * those files and serve hits without touching the CAS at all.
 *
 * Honesty invariant: the cached entry is the exact string JSON.stringify
 * produced for the fresh compute, and hits are written verbatim — a cached
 * response is byte-identical to a fresh one for the same stored analysis.
 * Invalidation is by KEY, not by TTL: any rewrite of the analysis file (every
 * saveAnalysis, including each layer stamp of a reanalyze) or of the
 * description store changes the fingerprint, so stale entries simply stop
 * being addressable and age out of the LRU.
 */

export interface ResponseCacheKeyParts {
  /** Which endpoint's projection this is (e.g. 'conceptual', 'semantic-coverage'). */
  endpoint: string;
  projectId: string;
  analysisId: string;
  /** Version fingerprint of the stored inputs (analysis file + description store). */
  version: string;
  /** Optional request params that change the projection. */
  params?: Record<string, string | undefined>;
}

export function responseCacheKey(parts: ResponseCacheKeyParts): string {
  const params = parts.params
    ? Object.keys(parts.params)
        .sort()
        .map(k => `${k}=${parts.params![k] ?? ''}`)
        .join('&')
    : '';
  return [parts.endpoint, parts.projectId, parts.analysisId, parts.version, params].join('|');
}

export class ResponseCache {
  private readonly maxEntries: number;
  /** Map preserves insertion order; we re-insert on hit → oldest = first key. */
  private readonly entries = new Map<string, string>();
  private hitCount = 0;
  private missCount = 0;

  constructor(maxEntries = 8) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`ResponseCache maxEntries must be a positive integer, got ${maxEntries}`);
    }
    this.maxEntries = maxEntries;
  }

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      this.missCount += 1;
      return undefined;
    }
    // LRU touch: move to the most-recently-used end.
    this.entries.delete(key);
    this.entries.set(key, value);
    this.hitCount += 1;
    return value;
  }

  set(key: string, serialized: string): void {
    // Re-set refreshes recency and value.
    this.entries.delete(key);
    this.entries.set(key, serialized);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Observability for /health-adjacent debugging; never used for behavior. */
  get stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hitCount, misses: this.missCount, size: this.entries.size };
  }
}
