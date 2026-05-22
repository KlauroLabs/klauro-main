import { EmbeddingProvider, EmbeddingProviderOptions } from './types';

const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch: number;

  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(options: EmbeddingProviderOptions) {
    this.model = options.model || LOCAL_MODEL;
    this.dimensions = options.dimensions;
    this.maxBatch = Math.max(1, options.maxBatch);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const extractor = await this.getPipeline();
    const results = new Array<Float32Array>(texts.length);

    for (let start = 0; start < texts.length; start += this.maxBatch) {
      const batch = texts.slice(start, start + this.maxBatch);
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      const flat = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
      const vectorLength = flat.length / batch.length;
      for (let i = 0; i < batch.length; i++) {
        results[start + i] = flat.slice(i * vectorLength, (i + 1) * vectorLength);
      }
    }

    return results;
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = loadPipeline(this.model);
    }
    return this.pipelinePromise;
  }
}

async function loadPipeline(model: string): Promise<FeatureExtractionPipeline> {
  const moduleName = '@huggingface/transformers';
  const transformers = (await import(moduleName)) as {
    pipeline: (task: string, model: string) => Promise<FeatureExtractionPipeline>;
  };
  return transformers.pipeline('feature-extraction', model);
}
