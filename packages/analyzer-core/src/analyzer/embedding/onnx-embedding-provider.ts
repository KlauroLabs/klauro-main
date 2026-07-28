import { EmbeddingProvider, EmbeddingProviderOptions } from './types';

/**
 * Real LOCAL sentence-embedding provider backed by an in-process ONNX model
 * (all-MiniLM-L6-v2, 384-dim) via @huggingface/transformers — the same
 * dependency the repo already vendors for local text generation. Unlike the
 * hash provider (klauro-local-hash-v1), this produces genuine semantic vectors,
 * so a concept query ("cache reuse decision") matches a function named
 * `fullRebuildReason` by MEANING rather than name overlap.
 *
 * COST POSTURE (docs/product model): purely local + lazy. No hosted API, no
 * GPU. The ONNX runtime executes on CPU inside this process; the model weights
 * (~90MB) download once to the HuggingFace hub cache under ~/.cache (or
 * TRANSFORMERS_CACHE) and are reused thereafter. The pipeline is loaded lazily
 * on the first embed() call and memoised as a module singleton so a warm
 * process pays the load cost (~150ms warm, one-time download cold) only once.
 *
 * Availability: if the transformers module or the model weights cannot be
 * loaded (offline first run, disk full, incompatible platform), embed() throws
 * so callers can report an honestly degraded semantic index.
 */

export const ONNX_EMBEDDING_MODEL = 'onnx-all-MiniLM-L6-v2';
export const ONNX_EMBEDDING_DIMENSIONS = 384;
// The HuggingFace repo id the ONNX weights are pulled from.
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
      // Dynamic import (a) keeps @huggingface/transformers off the hot path for
      // explicitly configured hash embeddings and (b) lets model availability
      // runtime — a missing install surfaces as a catchable rejection here.
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
      // Reset so a later call can retry (e.g. network came back) rather than
      // caching a permanent failure for the life of the process.
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
    // The ONNX MiniLM output is fixed at 384 dims; honour the configured value
    // only when it matches so a mis-set config surfaces loudly rather than
    // silently truncating/padding vectors.
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

/**
 * Probe whether the ONNX embedding model can be loaded in this environment.
 * Loads (and memoises) the pipeline; returns false on any failure so callers
 * can report unavailable semantic embeddings. Cheap on warm calls.
 */
export async function isOnnxEmbeddingAvailable(): Promise<boolean> {
  try {
    await loadPipeline();
    return true;
  } catch {
    return false;
  }
}

/** Test-only: drop the memoised pipeline so a fresh load can be exercised. */
export function __resetOnnxPipelineForTests(): void {
  pipelinePromise = null;
}
