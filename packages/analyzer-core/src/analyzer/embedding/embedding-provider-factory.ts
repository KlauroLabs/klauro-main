import { ApiEmbeddingProvider } from './api-embedding-provider';
import { LocalEmbeddingProvider } from './local-embedding-provider';
import { EmbeddingProvider, EmbeddingProviderOptions } from './types';

export function createEmbeddingProvider(
  providerId: 'api' | 'local',
  options: EmbeddingProviderOptions,
): EmbeddingProvider {
  switch (providerId) {
    case 'api':
      return new ApiEmbeddingProvider(options);
    case 'local':
      return new LocalEmbeddingProvider(options);
    default: {
      const unreachable: never = providerId;
      throw new Error(`Unknown embedding provider: ${String(unreachable)}`);
    }
  }
}
