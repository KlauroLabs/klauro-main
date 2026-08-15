import { EmbeddingProvider, EmbeddingProviderOptions } from './types';





















export const ONNX_EMBEDDING_MODEL = 'onnx-all-MiniLM-L6-v2';
export const ONNX_EMBEDDING_DIMENSIONS = 384;

const HF_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

interface FeatureExtractionPipeline {
  (
    texts: string | string[],
    options: { pooling: 'mean'; normalize: boolean },
  ): Promise<{ dims: number[]; tolist(): number[][] }>;
}

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function loadPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {



      const moduleName = '@huggingface/transformers';
      const transformers = (await import(moduleName)) as {
        pipeline: (
          task: string,
          model: string,
          options?: Record<string, unknown>,
        ) => Promise<FeatureExtractionPipeline>;
      };
      return transformers.pipeline('feature-extraction', HF_MODEL_ID, { dtype: 'fp32' });
    })().catch(error => {


      pipelinePromise = null;
      throw error;
    });
  }
  return pipelinePromise;
}

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch: number;

  constructor(options: EmbeddingProviderOptions) {
    if (options.model && options.model !== ONNX_EMBEDDING_MODEL) {
      throw new Error(
        `OnnxEmbeddingProvider produces ${ONNX_EMBEDDING_MODEL} vectors and cannot report model "${options.model}"`,
      );
    }
    this.model = ONNX_EMBEDDING_MODEL;



    if (options.dimensions !== ONNX_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `OnnxEmbeddingProvider requires dimensions=${ONNX_EMBEDDING_DIMENSIONS} (all-MiniLM-L6-v2), got ${options.dimensions}`,
      );
    }
    this.dimensions = ONNX_EMBEDDING_DIMENSIONS;
    this.maxBatch = Math.max(1, options.maxBatch);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }
    const extractor = await loadPipeline();
    const results: Float32Array[] = new Array(texts.length);
    for (let offset = 0; offset < texts.length; offset += this.maxBatch) {
      const batch = texts.slice(offset, offset + this.maxBatch);
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      const rows = output.tolist();
      for (let i = 0; i < rows.length; i++) {
        results[offset + i] = Float32Array.from(rows[i]);
      }
    }
    return results;
  }
}






export async function isOnnxEmbeddingAvailable(): Promise<boolean> {
  try {
    await loadPipeline();
    return true;
  } catch {
    return false;
  }
}


export function __resetOnnxPipelineForTests(): void {
  pipelinePromise = null;
}
