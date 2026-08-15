

type PerfLike = { now(): number };

const perf: PerfLike | undefined =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? (performance as PerfLike)
    : typeof globalThis !== 'undefined' &&
        (globalThis as { performance?: PerfLike }).performance &&
        typeof (globalThis as { performance?: PerfLike }).performance!.now === 'function'
      ? (globalThis as { performance?: PerfLike }).performance!
      : undefined;

export function nowMs(): number {
  return perf ? perf.now() : Date.now();
}

export function elapsedMs(startedAt: number): number {
  const delta = nowMs() - startedAt;
  return Math.round(Math.max(0, delta) * 1000) / 1000;
}
