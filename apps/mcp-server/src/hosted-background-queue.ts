let backgroundWork: Promise<void> = Promise.resolve();
let memoryHeavyWork: Promise<void> = Promise.resolve();
let foregroundWork = 0;
let resolveForegroundIdle: (() => void) | undefined;
const backgroundPreflights = new Set<() => void | Promise<void>>();
let cancelMemoryHeavyWork: (() => void) | undefined;

function waitForForegroundIdle(): Promise<void> {
  if (foregroundWork === 0) return Promise.resolve();
  return new Promise(resolve => {
    const previous = resolveForegroundIdle;
    resolveForegroundIdle = () => {
      previous?.();
      resolve();
    };
  });
}

export function registerHostedBackgroundPreflight(preflight: () => void | Promise<void>): () => void {
  backgroundPreflights.add(preflight);
  return () => backgroundPreflights.delete(preflight);
}

export function registerHostedMemoryHeavyCancellation(cancel: () => void): () => void {
  cancelMemoryHeavyWork = cancel;
  return () => {
    if (cancelMemoryHeavyWork === cancel) cancelMemoryHeavyWork = undefined;
  };
}

export async function withHostedForegroundPermit<T>(run: () => Promise<T>): Promise<T> {
  cancelMemoryHeavyWork?.();
  await memoryHeavyWork;
  foregroundWork += 1;
  try {
    return await run();
  } finally {
    foregroundWork -= 1;
    if (foregroundWork === 0) {
      const resolve = resolveForegroundIdle;
      resolveForegroundIdle = undefined;
      resolve?.();
    }
  }
}

export function withHostedBackgroundPermit<T>(
  run: () => Promise<T>,
  options: { releaseForegroundMemory?: boolean } = {},
): Promise<T> {
  const result = backgroundWork.then(async () => {
    await waitForForegroundIdle();
    if (options.releaseForegroundMemory) {
      for (const preflight of backgroundPreflights) await preflight();
      let releaseMemoryHeavy!: () => void;
      memoryHeavyWork = new Promise<void>(resolve => { releaseMemoryHeavy = resolve; });
      try {
        return await run();
      } finally {
        releaseMemoryHeavy();
      }
    }
    return run();
  });
  backgroundWork = result.then(() => undefined, () => undefined);
  return result;
}
