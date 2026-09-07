import * as fs from 'fs-extra';
import * as path from 'path';
import { segmentedAnalysisRoot } from './segmented-analysis-storage';

const STORAGE_ACCESS_ERROR_CODES = new Set(['EROFS', 'EACCES', 'EPERM']);

export class SegmentedStorageAccessError extends Error {
  readonly code: string;
  constructor(entryPath: string, code: string, cause: unknown) {
    super(`Segmented analysis storage for ${entryPath} is not accessible (${code}): read leases require a writable analysis index directory, and the whole-CAS fallback is not attempted for access failures.`);
    this.name = 'SegmentedStorageAccessError';
    this.code = code;
    (this as { cause?: unknown }).cause = cause;
  }
}

export function segmentedStorageAccessError(entryPath: string, error: unknown): SegmentedStorageAccessError | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && STORAGE_ACCESS_ERROR_CODES.has(code) ? new SegmentedStorageAccessError(entryPath, code, error) : null;
}

const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

export type SegmentedIndexProbe = (pointerPath: string) => Promise<unknown>;

export async function segmentedReadFailureFallback(
  entry: { path: string; storage_format?: string },
  filePath: string,
  error: unknown,
  probe: SegmentedIndexProbe = pointerPath => fs.stat(pointerPath),
): Promise<null> {
  const access = segmentedStorageAccessError(entry.path, error);
  if (access) {
    try {
      await probe(path.join(segmentedAnalysisRoot(filePath), 'current.json'));
      throw access;
    } catch (probeError) {
      if (probeError === access) throw access;
      const code = (probeError as NodeJS.ErrnoException | undefined)?.code;
      if (typeof code !== 'string' || !ABSENT_CODES.has(code)) throw segmentedStorageAccessError(entry.path, probeError) || access;
    }
  }
  if (entry.storage_format === 'segmented-v2') throw error;
  return null;
}
