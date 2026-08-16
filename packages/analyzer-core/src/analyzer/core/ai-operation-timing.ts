export async function awaitAiOperation<T>(promise: Promise<T>, operation: string, slowMs: number): Promise<T> {
  const startedAt = Date.now();
  let slowTimer: NodeJS.Timeout | undefined;
  let outcome = 'failed';
  if (Number.isFinite(slowMs) && slowMs > 0) {
    slowTimer = setTimeout(() => {
      process.stderr.write(`[Klauro] ${operation} is still running after ${Date.now() - startedAt}ms; continuing until the provider completes\n`);
    }, slowMs);
    slowTimer.unref?.();
  }
  try {
    const value = await promise;
    outcome = 'ok';
    return value;
  } finally {
    if (slowTimer) clearTimeout(slowTimer);
    process.stderr.write(`[Klauro] AI operation ${operation}: ${outcome} in ${Date.now() - startedAt}ms\n`);
  }
}
