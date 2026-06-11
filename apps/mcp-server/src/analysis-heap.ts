import * as os from 'os';

export const DEFAULT_ANALYSIS_HEAP_MB = 8192;
export const MINIMUM_ANALYSIS_HEAP_MB = 256;
export const DEFAULT_HEAP_TOTAL_RAM_FRACTION = 0.5;

export interface AnalysisHeapResolution {
  heapMb: number;
  source: 'env' | 'default' | 'default-capped';
  envValue?: string;
  envInvalid?: boolean;
  totalRamMb: number;
}

export function resolveAnalysisHeapMb(
  env: NodeJS.ProcessEnv = process.env,
  totalMemBytes: number = os.totalmem(),
): AnalysisHeapResolution {
  const totalRamMb = Math.floor(totalMemBytes / (1024 * 1024));
  const raw = env.KLAURO_ANALYSIS_HEAP_MB;

  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= MINIMUM_ANALYSIS_HEAP_MB) {
      return { heapMb: Math.floor(parsed), source: 'env', envValue: raw, totalRamMb };
    }
    return {
      heapMb: defaultHeapMb(totalRamMb),
      source: 'default',
      envValue: raw,
      envInvalid: true,
      totalRamMb,
    };
  }

  const cap = Math.floor(totalRamMb * DEFAULT_HEAP_TOTAL_RAM_FRACTION);
  if (DEFAULT_ANALYSIS_HEAP_MB > cap) {
    return { heapMb: Math.max(MINIMUM_ANALYSIS_HEAP_MB, cap), source: 'default-capped', totalRamMb };
  }
  return { heapMb: DEFAULT_ANALYSIS_HEAP_MB, source: 'default', totalRamMb };
}

function defaultHeapMb(totalRamMb: number): number {
  const cap = Math.floor(totalRamMb * DEFAULT_HEAP_TOTAL_RAM_FRACTION);
  return Math.max(MINIMUM_ANALYSIS_HEAP_MB, Math.min(DEFAULT_ANALYSIS_HEAP_MB, cap));
}

export function describeAnalysisHeap(resolution: AnalysisHeapResolution): string {
  const ramGb = (resolution.totalRamMb / 1024).toFixed(0);
  if (resolution.source === 'env') {
    return `Analysis worker heap: ${resolution.heapMb} MB (from KLAURO_ANALYSIS_HEAP_MB; machine RAM ${ramGb} GB).`;
  }
  if (resolution.envInvalid) {
    return `Analysis worker heap: ${resolution.heapMb} MB (default; ignored invalid KLAURO_ANALYSIS_HEAP_MB=${resolution.envValue}, minimum ${MINIMUM_ANALYSIS_HEAP_MB}).`;
  }
  if (resolution.source === 'default-capped') {
    return `Analysis worker heap: ${resolution.heapMb} MB (default ${DEFAULT_ANALYSIS_HEAP_MB} MB capped to ${Math.round(DEFAULT_HEAP_TOTAL_RAM_FRACTION * 100)}% of ${ramGb} GB RAM). Set KLAURO_ANALYSIS_HEAP_MB to override.`;
  }
  return `Analysis worker heap: ${resolution.heapMb} MB (default; machine RAM ${ramGb} GB). Set KLAURO_ANALYSIS_HEAP_MB to override.`;
}
