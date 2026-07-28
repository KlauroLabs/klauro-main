import { createEmbeddingProvider } from '../../analyzer/embedding/embedding-provider-factory';
import { LocalEmbeddingProvider, LOCAL_HASH_EMBEDDING_MODEL } from '../../analyzer/embedding/local-embedding-provider';
import { OnnxEmbeddingProvider, ONNX_EMBEDDING_MODEL } from '../../analyzer/embedding/onnx-embedding-provider';

const options = (model: string) => ({
  model,
  dimensions: 384,
  maxBatch: 64,
  maxConcurrency: 1,
});

describe('createEmbeddingProvider', () => {
  it('constructs the real ONNX provider for the ONNX model', () => {
    const provider = createEmbeddingProvider('local', options(ONNX_EMBEDDING_MODEL));

    expect(provider).toBeInstanceOf(OnnxEmbeddingProvider);
    expect(provider.model).toBe(ONNX_EMBEDDING_MODEL);
  });

  it('labels the hash provider with only its actual model', () => {
    const provider = createEmbeddingProvider('local', options(LOCAL_HASH_EMBEDDING_MODEL));

    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider.model).toBe(LOCAL_HASH_EMBEDDING_MODEL);
  });

  it('rejects unsupported local model names instead of relabeling hash vectors', () => {
    expect(() => createEmbeddingProvider('local', options('custom-semantic-model')))
      .toThrow('Unsupported local embedding model');
  });
});
