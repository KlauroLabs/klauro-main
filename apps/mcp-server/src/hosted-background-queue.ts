let backgroundWork: Promise<void> = Promise.resolve();
let foregroundWork = 0;
let resolveForegroundIdle: (() => void) | undefined;
const backgroundPreflights = new Set<() => void | Promise<void>>();

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

export async function withHostedForegroundPermit<T>(run: () => Promise<T>): Promise<T> {
  await backgroundWork;
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

export function withHostedBackgroundPermit<T>(run: () => Promise<T>): Promise<T> {
  const result = backgroundWork.then(async () => {
    await waitForForegroundIdle();
    for (const preflight of backgroundPreflights) await preflight();
    return run();
  });
  backgroundWork = result.then(() => undefined, () => undefined);
  return result;
}
