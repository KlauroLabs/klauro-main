import { LocalEmbeddingProvider } from '../../analyzer/embedding/local-embedding-provider';

function referenceEmbedding(text: string, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  const hash = (value: string): number => {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  };
  const add = (token: string, weight: number): void => {
    const index = hash(token) % dimensions;
    const sign = hash(`sign:${token}`) % 2 === 0 ? 1 : -1;
    vector[index] += weight * sign;
  };
  const tokens = text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9_:/.-]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1)
    .slice(0, 2048);
  for (const token of tokens) {
    add(token, 1);
    if (token.includes(':')) {
      const [scope, value] = token.split(':', 2);
      if (scope && value) {
        add(scope, 0.7);
        add(value, 0.9);
      }
    }
  }
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm !== 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  }
  return vector;
}

describe('LocalEmbeddingProvider', () => {
  it('caches token features without changing any vector value', async () => {
    const dimensions = 384;
    const provider = new LocalEmbeddingProvider({
      model: 'klauro-local-hash-v1',
      dimensions,
      maxBatch: 64,
      maxConcurrency: 1,
    });
    const text = 'function:analyze analyze analysis_id graph:call graph:call route/controller';
    const [first, second] = await provider.embed([text, text]);
    const expected = referenceEmbedding(text, dimensions);

    expect(Array.from(first)).toEqual(Array.from(expected));
    expect(Array.from(second)).toEqual(Array.from(expected));
  });

  it('refuses to report hash vectors under another model name', () => {
    expect(() => new LocalEmbeddingProvider({
      model: 'onnx-all-MiniLM-L6-v2',
      dimensions: 384,
      maxBatch: 64,
      maxConcurrency: 1,
    })).toThrow('cannot report model');
  });
});
