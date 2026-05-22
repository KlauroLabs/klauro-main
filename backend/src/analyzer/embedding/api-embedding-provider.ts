import { EmbeddingProvider, EmbeddingProviderOptions } from './types';

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;

export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'api' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch: number;

  private readonly apiKey: string;
  private readonly maxConcurrency: number;

  constructor(options: EmbeddingProviderOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.maxBatch = Math.min(options.maxBatch, 128);
    this.maxConcurrency = Math.max(1, options.maxConcurrency);

    const apiKeyEnv = options.apiKeyEnv;
    if (!apiKeyEnv) {
      throw new Error('ApiEmbeddingProvider requires options.apiKeyEnv to name the API key environment variable');
    }
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Embedding API key environment variable "${apiKeyEnv}" is not set`);
    }
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const batches: Array<{ start: number; texts: string[] }> = [];
    for (let start = 0; start < texts.length; start += this.maxBatch) {
      batches.push({ start, texts: texts.slice(start, start + this.maxBatch) });
    }

    const results = new Array<Float32Array>(texts.length);
    let nextBatch = 0;

    const worker = async (): Promise<void> => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++];
        const vectors = await this.embedBatch(batch.texts);
        for (let i = 0; i < vectors.length; i++) {
          results[batch.start + i] = vectors[i];
        }
      }
    };

    const workerCount = Math.min(this.maxConcurrency, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
  }

  private async embedBatch(input: string[]): Promise<Float32Array[]> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(VOYAGE_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input, model: this.model, input_type: 'document' }),
        });
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS) {
          break;
        }
        await delay(backoffMs(attempt));
        continue;
      }

      if (response.ok) {
        const payload = (await response.json()) as VoyageEmbeddingResponse;
        return decodeVoyageResponse(payload, input.length);
      }

      const retryable = response.status === 429 || response.status >= 500;
      const body = await response.text().catch(() => '');
      lastError = new Error(`Voyage embeddings API returned ${response.status}: ${body}`);

      if (!retryable || attempt === MAX_ATTEMPTS) {
        break;
      }
      await delay(backoffMs(attempt));
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Voyage embeddings API request failed');
  }
}

function decodeVoyageResponse(payload: VoyageEmbeddingResponse, expected: number): Float32Array[] {
  if (!payload.data || payload.data.length !== expected) {
    throw new Error('Voyage embeddings API returned an unexpected number of vectors');
  }
  const vectors = new Array<Float32Array>(expected);
  for (const item of payload.data) {
    vectors[item.index] = Float32Array.from(item.embedding);
  }
  for (let i = 0; i < expected; i++) {
    if (!vectors[i]) {
      throw new Error('Voyage embeddings API response is missing a vector index');
    }
  }
  return vectors;
}

function backoffMs(attempt: number): number {
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return exponential + Math.floor(Math.random() * BASE_BACKOFF_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
