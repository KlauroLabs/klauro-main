import { existsSync } from 'node:fs';

export function treeSitterWorkerResourceLimits(): { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number; stackSizeMb: number } {
  return { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 128, stackSizeMb: 8 };
}

export function treeSitterWorkerExecArgv(execArgv: string[]): string[] {
  return execArgv.filter(argument =>
    !argument.startsWith('--max-old-space-size=') &&
    !argument.startsWith('--max_old_space_size='));
}

export function resolveTreeSitterWorkerPath(
  bundledWorkerPath: string,
  compiledWorkerPath: string,
  sourceWorkerPath: string,
  exists: (filePath: string) => boolean = existsSync
): string {
  if (exists(bundledWorkerPath)) return bundledWorkerPath;
  return exists(compiledWorkerPath) ? compiledWorkerPath : sourceWorkerPath;
}
