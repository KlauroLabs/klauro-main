import * as path from 'node:path';

export function defaultBenchmarkReferencePaths(
  sourceDirectory: string,
  configured = process.env.KLAURO_BENCH_REFERENCE_PATHS,
): string[] {
  if (configured?.trim()) {
    return Array.from(new Set(configured
      .split(path.delimiter)
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => path.resolve(value))));
  }
  return [path.resolve(sourceDirectory, '../../..')];
}
