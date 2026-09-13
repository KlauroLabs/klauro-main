import { existsSync, statSync } from 'node:fs';

export function treeSitterWorkerResourceLimits(): { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number; stackSizeMb: number } {
  return { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 128, stackSizeMb: 8 };
}

export function treeSitterWorkerExecArgv(execArgv: string[]): string[] {
  return execArgv.filter(argument =>
    !argument.startsWith('--max-old-space-size=') &&
    !argument.startsWith('--max_old_space_size='));
}

function modifiedAt(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export function resolveTreeSitterWorkerPath(
  bundledWorkerPath: string,
  compiledWorkerPath: string,
  sourceWorkerPath: string,
  sourceSiblings: readonly string[] = [],
  exists: (filePath: string) => boolean = existsSync,
  modified: (filePath: string) => number | null = modifiedAt
): string {
  const sources = [sourceWorkerPath, ...sourceSiblings].filter(exists);
  for (const builtPath of [bundledWorkerPath, compiledWorkerPath]) {
    if (!exists(builtPath)) continue;
    if (sources.length === 0) return builtPath;
    const builtAt = modified(builtPath);
    if (builtAt === null) return builtPath;
    let newestSource: number | null = null;
    for (const sourcePath of sources) {
      const stamp = modified(sourcePath);
      if (stamp === null) return builtPath;
      if (newestSource === null || stamp > newestSource) newestSource = stamp;
    }
    if (newestSource === null || builtAt >= newestSource) return builtPath;
    return sourceWorkerPath;
  }
  return sourceWorkerPath;
}
