import * as fs from 'node:fs';
import * as os from 'node:os';

const MIB = 1024 * 1024;
const WORKER_NATIVE_MINIMUM_BYTES = 256 * MIB;
const WORKER_NATIVE_HEAP_FRACTION = 0.25;
const PARENT_GROWTH_RESERVE_BYTES = 256 * MIB;

export interface ContainerMemory {
  limit: number;
  usage: number | null;
  reclaimableFileBytes?: number;
}

export interface AnalysisMemoryCapacity {
  limitBytes: number;
  availableBytes: number | null;
  source: 'cgroup' | 'host';
}

function readMemoryBytes(file: string, read: (file: string) => string): number | null {
  try {
    const value = read(file).trim();
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function readContainerUsage(
  limit: number,
  usagePath: string,
  statPath: string,
  version: 1 | 2,
  read: (file: string) => string,
): ContainerMemory {
  const before = readMemoryBytes(usagePath, read);
  if (before === null) return { limit, usage: null };
  let stats: Map<string, number>;
  const keys = version === 2
    ? ['file', 'inactive_file', 'file_dirty', 'file_writeback', 'shmem', 'anon']
    : ['total_cache', 'total_inactive_file', 'total_dirty', 'total_writeback', 'total_shmem', 'total_rss'];
  try {
    stats = new Map();
    for (const line of read(statPath).trim().split('\n')) {
      const match = /^([a-z_]+)\s+(\d+)$/.exec(line);
      if (!match) return { limit, usage: before };
      if (!keys.includes(match[1])) continue;
      if (stats.has(match[1])) return { limit, usage: before };
      const value = Number(match[2]);
      if (!Number.isSafeInteger(value)) return { limit, usage: before };
      stats.set(match[1], value);
    }
  } catch {
    return { limit, usage: before };
  }
  const values = keys.map(key => stats.get(key));
  if (values.some(value => value === undefined)) return { limit, usage: before };
  const [file, inactive, dirty, writeback, shared, anonymous] = values as number[];
  const after = readMemoryBytes(usagePath, read);
  if (after === null) return { limit, usage: null };
  const usage = Math.max(before, after);
  const reclaimableFileBytes = Math.max(0, Math.min(
    Math.min(file, inactive) - dirty - writeback - shared,
    usage - anonymous,
  ));
  return { limit, usage, ...(reclaimableFileBytes > 0 ? { reclaimableFileBytes } : {}) };
}

export function readContainerMemory(
  read: (file: string) => string = file => fs.readFileSync(file, 'utf8'),
): ContainerMemory | null {
  const v2Limit = readMemoryBytes('/sys/fs/cgroup/memory.max', read);
  if (v2Limit !== null && v2Limit > 0) {
    return readContainerUsage(v2Limit, '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.stat', 2, read);
  }
  const v1Limit = readMemoryBytes('/sys/fs/cgroup/memory/memory.limit_in_bytes', read);
  if (v1Limit !== null && v1Limit > 0 && v1Limit < 1024 ** 4) {
    return readContainerUsage(v1Limit, '/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.stat', 1, read);
  }
  return null;
}

export function readAnalysisMemoryCapacity(
  container: ContainerMemory | null = readContainerMemory(),
  totalBytes: number = os.totalmem(),
  freeBytes: number = os.freemem(),
): AnalysisMemoryCapacity {
  if (container) {
    const cache = container.reclaimableFileBytes ?? 0;
    const reclaimable = Number.isSafeInteger(cache) && cache >= 0 && container.usage !== null && cache <= container.usage
      ? cache
      : 0;
    return {
      limitBytes: Math.min(totalBytes, container.limit),
      availableBytes: container.usage === null ? null : Math.max(0, Math.min(freeBytes, container.limit - container.usage + reclaimable)),
      source: 'cgroup',
    };
  }
  return { limitBytes: totalBytes, availableBytes: freeBytes, source: 'host' };
}

export function analysisWorkerMemoryRequiredBytes(heapMb: number, residentBytes = 0): number {
  const heapBytes = heapMb * MIB;
  const workerBytes = heapBytes + Math.max(WORKER_NATIVE_MINIMUM_BYTES, Math.ceil(heapBytes * WORKER_NATIVE_HEAP_FRACTION));
  return Math.max(0, workerBytes - residentBytes) + PARENT_GROWTH_RESERVE_BYTES;
}

function workerResidentBytes(pid?: number): number {
  if (!pid) return 0;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssKb = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1];
    return rssKb ? Number(rssKb) * 1024 : 0;
  } catch {
    return 0;
  }
}

export class AnalysisMemoryCapacityError extends Error {
  readonly code = 'analysis_memory_capacity_exhausted';

  constructor(readonly capacity: AnalysisMemoryCapacity, readonly requiredBytes: number, readonly heapMb: number) {
    const available = capacity.availableBytes === null ? 'unknown' : `${Math.floor(capacity.availableBytes / MIB)} MiB`;
    super(`Analysis was not started: ${available} available within the ${Math.floor(capacity.limitBytes / MIB)} MiB ${capacity.source} budget; ${Math.ceil(requiredBytes / MIB)} MiB required for the ${heapMb} MiB worker heap, native overhead and API growth reserve. Free capacity or isolate the analysis worker before retrying. No source or analysis scope was reduced.`);
    this.name = 'AnalysisMemoryCapacityError';
  }
}

export function assertAnalysisWorkerMemoryAvailable(
  heapMb: number,
  workerPid?: number,
  capacity: AnalysisMemoryCapacity = readAnalysisMemoryCapacity(),
): void {
  const requiredBytes = analysisWorkerMemoryRequiredBytes(heapMb, workerResidentBytes(workerPid));
  if (capacity.availableBytes === null || capacity.availableBytes < requiredBytes) {
    throw new AnalysisMemoryCapacityError(capacity, requiredBytes, heapMb);
  }
}
