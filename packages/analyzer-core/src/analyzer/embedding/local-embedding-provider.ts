import { EmbeddingProvider, EmbeddingProviderOptions } from './types';
import { createYieldBudget } from '../core/event-loop-yield';

export const LOCAL_HASH_EMBEDDING_MODEL = 'klauro-local-hash-v1';
const MAX_CACHED_TOKEN_FEATURES = 250_000;

interface TokenFeature {
  index: number;
  sign: 1 | -1;
  weight: number;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch: number;
  private readonly tokenFeatureCache = new Map<string, readonly TokenFeature[]>();

  constructor(options: EmbeddingProviderOptions) {
    if (options.model && options.model !== LOCAL_HASH_EMBEDDING_MODEL) {
      throw new Error(
        `LocalEmbeddingProvider produces ${LOCAL_HASH_EMBEDDING_MODEL} vectors and cannot report model "${options.model}"`,
      );
    }
    this.model = LOCAL_HASH_EMBEDDING_MODEL;
    this.dimensions = options.dimensions;
    this.maxBatch = Math.max(1, options.maxBatch);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }




    const maybeYield = createYieldBudget();
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      vectors.push(this.embedText(text));
      await maybeYield();
    }
    return vectors;
  }

  private embedText(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const tokens = this.tokenize(text);

    for (const token of tokens) {
      for (const feature of this.featuresForToken(token)) {
        vector[feature.index] += feature.weight * feature.sign;
      }
    }

    this.normalize(vector);
    return vector;
  }

  private tokenize(text: string): string[] {
    const normalized = text
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[^a-z0-9_:/.-]+/g, ' ');
    return normalized
      .split(/\s+/)
      .filter(token => token.length > 1)
      .slice(0, 2048);
  }

  private featuresForToken(token: string): readonly TokenFeature[] {
    const cached = this.tokenFeatureCache.get(token);
    if (cached) return cached;

    const features: TokenFeature[] = [this.feature(token, 1)];
    if (token.includes(':')) {
      const [scope, value] = token.split(':', 2);
      if (scope && value) {
        features.push(this.feature(scope, 0.7), this.feature(value, 0.9));
      }
    }
    if (this.tokenFeatureCache.size < MAX_CACHED_TOKEN_FEATURES) {
      this.tokenFeatureCache.set(token, features);
    }
    return features;
  }

  private feature(token: string, weight: number): TokenFeature {
    const index = this.hash(token) % this.dimensions;
    const sign: 1 | -1 = this.hash(`sign:${token}`) % 2 === 0 ? 1 : -1;
    return { index, sign, weight };
  }

  private hash(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private normalize(vector: Float32Array): void {
    let sum = 0;
    for (const value of vector) sum += value * value;
    const norm = Math.sqrt(sum);
    if (norm === 0) return;
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  }
}
