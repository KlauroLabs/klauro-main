let backgroundWork: Promise<void> = Promise.resolve();

export function withHostedBackgroundPermit<T>(run: () => Promise<T>): Promise<T> {
  const result = backgroundWork.then(run);
  backgroundWork = result.then(() => undefined, () => undefined);
  return result;
}
