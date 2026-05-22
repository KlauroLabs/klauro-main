import { createHash } from 'crypto';

const DEFAULT_CAPACITY = 512;

export class EmbeddingCache {
  private readonly capacity: number;
  private readonly entries = new Map<string, Float32Array>();

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  get(query: string, model: string): Float32Array | undefined {
    const key = cacheKey(query, model);
    const vector = this.entries.get(key);
    if (vector === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, vector);
    return vector;
  }

  set(query: string, model: string, vector: Float32Array): void {
    const key = cacheKey(query, model);
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, vector);
  }
}

function cacheKey(query: string, model: string): string {
  return createHash('sha256').update(`${query} ${model}`).digest('hex');
}
