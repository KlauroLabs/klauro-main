import { EmbeddingProvider, EmbeddingProviderOptions } from './types';

const LOCAL_MODEL = 'klauro-local-hash-v1';

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch: number;

  constructor(options: EmbeddingProviderOptions) {
    this.model = options.model || LOCAL_MODEL;
    this.dimensions = options.dimensions;
    this.maxBatch = Math.max(1, options.maxBatch);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    return texts.map(text => this.embedText(text));
  }

  private embedText(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const tokens = this.tokenize(text);

    for (const token of tokens) {
      this.addFeature(vector, token, 1);
      if (token.includes(':')) {
        const [scope, value] = token.split(':', 2);
        if (scope && value) {
          this.addFeature(vector, scope, 0.7);
          this.addFeature(vector, value, 0.9);
        }
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

  private addFeature(vector: Float32Array, token: string, weight: number): void {
    const index = this.hash(token) % this.dimensions;
    const sign = this.hash(`sign:${token}`) % 2 === 0 ? 1 : -1;
    vector[index] += weight * sign;
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
