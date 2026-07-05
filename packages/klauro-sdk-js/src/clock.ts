/**
 * High-resolution monotonic clock for request latency.
 *
 * `Date.now()` has millisecond granularity and can move backwards when the wall
 * clock is adjusted (NTP, DST), which corrupts duration measurements. Prefer a
 * monotonic high-res source so latency percentiles (p50/p95/p99) are accurate
 * even for sub-millisecond handlers. Falls back to `Date.now()` where no
 * high-res clock exists.
 */

type PerfLike = { now(): number };

const perf: PerfLike | undefined =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? (performance as PerfLike)
    : typeof globalThis !== 'undefined' &&
        (globalThis as { performance?: PerfLike }).performance &&
        typeof (globalThis as { performance?: PerfLike }).performance!.now === 'function'
      ? (globalThis as { performance?: PerfLike }).performance!
      : undefined;

/** Monotonic timestamp in fractional milliseconds. Use only for deltas. */
export function nowMs(): number {
  return perf ? perf.now() : Date.now();
}

/**
 * Elapsed fractional milliseconds since a `nowMs()` reading, rounded to 3
 * decimals so sub-ms handlers still produce a non-zero, comparable duration.
 */
export function elapsedMs(startedAt: number): number {
  const delta = nowMs() - startedAt;
  return Math.round(Math.max(0, delta) * 1000) / 1000;
}
