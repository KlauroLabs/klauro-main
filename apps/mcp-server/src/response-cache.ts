























export interface ResponseCacheKeyParts {

  endpoint: string;
  projectId: string;
  analysisId: string;

  version: string;

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

    this.entries.delete(key);
    this.entries.set(key, value);
    this.hitCount += 1;
    return value;
  }

  set(key: string, serialized: string): void {

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


  get stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hitCount, misses: this.missCount, size: this.entries.size };
  }
}
