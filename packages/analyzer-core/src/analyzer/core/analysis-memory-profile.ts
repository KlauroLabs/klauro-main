export interface AnalysisMemorySample {
  phase: string;
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  array_buffers_mb: number;
  max_rss_mb: number;
}

const toMiB = (bytes: number): number => Math.round(bytes / 1024 / 1024);

export function captureAnalysisMemorySample(phase: string): AnalysisMemorySample {
  const memory = process.memoryUsage();
  return {
    phase,
    rss_mb: toMiB(memory.rss),
    heap_used_mb: toMiB(memory.heapUsed),
    heap_total_mb: toMiB(memory.heapTotal),
    external_mb: toMiB(memory.external),
    array_buffers_mb: toMiB(memory.arrayBuffers),
    max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
  };
}
