import { availableParallelism, freemem } from 'node:os';

export const MAX_PARSE_WORKERS = 6;
export const MIN_FILES_FOR_WORKERS = 40;

export interface ParseWorkerPoolInputs {
  fileCount: number;
  configured?: string | number;
  cores?: number;
  workerHeapMb: number;
  memoryCeilingMb?: number;
}

function coreCeiling(cores: number): number {
  return Math.max(1, Math.min(MAX_PARSE_WORKERS, cores - 1));
}

function memoryCeiling(memoryCeilingMb: number, workerHeapMb: number): number {
  if (!Number.isFinite(memoryCeilingMb) || memoryCeilingMb <= 0) return MAX_PARSE_WORKERS;
  if (!Number.isFinite(workerHeapMb) || workerHeapMb <= 0) return MAX_PARSE_WORKERS;
  return Math.max(1, Math.floor((memoryCeilingMb / 2) / workerHeapMb));
}

export function availableMemoryMb(): number {
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  const available = typeof process.availableMemory === 'function' ? process.availableMemory() : 0;
  const bytes = constrained > 0
    ? Math.min(constrained, available > 0 ? available : constrained)
    : (available > 0 ? available : freemem());
  return Math.floor(bytes / (1024 * 1024));
}

export function parseWorkerCount(inputs: ParseWorkerPoolInputs): number {
  const cores = inputs.cores ?? availableParallelism();
  const memoryMb = inputs.memoryCeilingMb ?? availableMemoryMb();
  const configured = Number(inputs.configured ?? '');
  const requested = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : Math.min(coreCeiling(cores), memoryCeiling(memoryMb, inputs.workerHeapMb));
  return Math.max(1, Math.min(inputs.fileCount, requested));
}
