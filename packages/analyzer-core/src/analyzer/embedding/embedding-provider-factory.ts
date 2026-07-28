import { ApiEmbeddingProvider } from './api-embedding-provider';
import { LocalEmbeddingProvider, LOCAL_HASH_EMBEDDING_MODEL } from './local-embedding-provider';
import { OnnxEmbeddingProvider, ONNX_EMBEDDING_MODEL } from './onnx-embedding-provider';
import { EmbeddingProvider, EmbeddingProviderOptions } from './types';

export function createEmbeddingProvider(
  providerId: 'api' | 'local',
  options: EmbeddingProviderOptions,
): EmbeddingProvider {
  switch (providerId) {
    case 'api':
      return new ApiEmbeddingProvider(options);
    case 'local': {
      if (!options.model || options.model === LOCAL_HASH_EMBEDDING_MODEL) {
        return new LocalEmbeddingProvider(options);
      }
      if (options.model === ONNX_EMBEDDING_MODEL) {
        return new OnnxEmbeddingProvider(options);
      }
      throw new Error(`Unsupported local embedding model: ${options.model}`);
    }
    default: {
      const unreachable: never = providerId;
      throw new Error(`Unknown embedding provider: ${String(unreachable)}`);
    }
  }
}
