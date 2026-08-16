let activeAnalyses = 0;
const idleWaiters = new Set<() => void>();

export function beginForegroundAnalysis(): () => void {
  activeAnalyses += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeAnalyses = Math.max(0, activeAnalyses - 1);
    if (activeAnalyses > 0) return;
    const waiters = [...idleWaiters];
    idleWaiters.clear();
    for (const resolve of waiters) resolve();
  };
}

export function foregroundAnalysisActive(): boolean {
  return activeAnalyses > 0;
}

export async function waitForForegroundAnalysisIdle(quietMs = 1_000): Promise<void> {
  while (true) {
    if (activeAnalyses > 0) {
      await new Promise<void>(resolve => idleWaiters.add(resolve));
    }
    if (quietMs <= 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, quietMs));
    if (activeAnalyses === 0) return;
  }
}
