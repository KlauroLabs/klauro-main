/**
 * Event-loop yield for long synchronous analysis stretches.
 *
 * The analyzer runs IN-PROCESS with the HTTP server (see
 * apps/mcp-server/src/remote-analyzer-service.ts): every long synchronous CPU
 * stretch (parse, graph passes) blocks the event loop, so EVERY request —
 * including GET /health — stalls for its duration. Measured on a 204-file
 * repo the worst single stretch was ~2.9s (tree-sitter extraction batches);
 * a 2,705-file whale re-analysis compounds that into the minutes-long
 * Cloudflare 524 starvation reported on prod.
 *
 * `yieldToEventLoop()` parks the continuation behind setImmediate — a REAL
 * macrotask boundary (an awaited already-resolved promise or process.nextTick
 * would only queue a microtask, which runs before pending I/O and yields
 * nothing). Call it between analysis phases and every
 * `ANALYSIS_YIELD_EVERY_FILES` iterations of per-file CPU loops. It does not
 * parallelize or reorder anything: the analysis computes the identical result,
 * it just lets pending sockets/timers breathe between chunks.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/** Time budget for per-file CPU loops: yield once the loop has held the event
 * loop this long. Time-based (not every-N-files) because file parse cost is
 * wildly uneven — 10 large files can block ~900ms while 10 small ones block
 * ~10ms (measured). 50ms keeps reads/health snappy; the hop itself is ~µs. */
export const ANALYSIS_YIELD_BUDGET_MS = 50;

/**
 * Returns a `maybeYield()` that awaits a macrotask hop only when
 * ANALYSIS_YIELD_BUDGET_MS of synchronous work has accumulated since the last
 * hop. Use inside per-file loops: `for (...) { work(); await maybeYield(); }`.
 * When under budget it returns a resolved promise (pure microtask, no hop).
 */
export function createYieldBudget(budgetMs: number = ANALYSIS_YIELD_BUDGET_MS): () => Promise<void> {
  let lastYieldAt = Date.now();
  return async () => {
    if (Date.now() - lastYieldAt < budgetMs) return;
    await yieldToEventLoop();
    lastYieldAt = Date.now();
  };
}
