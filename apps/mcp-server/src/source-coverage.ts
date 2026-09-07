import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { SourceManifest } from './remote-source';
import { getProjectStorageDir, saveAnalysis } from './storage';
import { writeJsonAtomic } from './json-storage-writer';

export interface SourceFileExclusion {
  path: string;
  bytes: number;
}

const DIAGNOSTIC_CODE = 'SOURCE_FILE_EXCLUDED';
const COVERAGE_ORIGIN = 'source-upload';
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

export function normalizeSourceExclusions(value: unknown): SourceFileExclusion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Source exclusions must be an array');
  const files = new Map<string, number>();
  let metadataBytes = 128;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string'
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error('Source exclusion requires a relative path and a nonnegative safe byte count');
    }
    const file = entry.path.replace(/\\/g, '/');
    if (!file || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file)
      || file.startsWith('/') || /^[A-Za-z]:/.test(file)
      || file.split('/').some((part: string) => !part || part === '.' || part === '..')) {
      throw new Error('Source exclusion path must be a canonical relative file path');
    }
    metadataBytes += Buffer.byteLength(JSON.stringify({ path: file, bytes: entry.bytes }), 'utf8') + 1;
    if (metadataBytes > MAX_METADATA_BYTES) throw new Error('Source exclusion metadata exceeds its byte budget');
    if (files.has(file) && files.get(file) !== entry.bytes) throw new Error('Conflicting sizes for source exclusion');
    files.set(file, entry.bytes);
  }
  return [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, bytes]) => ({ path: file, bytes }));
}

export function validateSnapshotSourceCoverage(
  manifest: Pick<SourceManifest, 'excluded_oversize_files'>,
  files: ReadonlyArray<{ path: string }>,
): SourceFileExclusion[] {
  const exclusions = normalizeSourceExclusions(manifest.excluded_oversize_files);
  const included = new Set(files.map(file => file.path.replace(/\\/g, '/')));
  if (exclusions.some(file => included.has(file.path))) throw new Error('A source file cannot be both uploaded and excluded');
  return exclusions;
}

function coveragePath(workspace: string): string {
  return path.join(getProjectStorageDir(workspace), 'source-coverage.json');
}

export async function readWorkspaceSourceExclusions(workspace: string): Promise<SourceFileExclusion[] | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(coveragePath(workspace), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (size > MAX_METADATA_BYTES) throw new Error('Stored source exclusion metadata exceeds its byte budget');
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== size) throw new Error('Stored source exclusion metadata changed while reading');
    const record = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (record.version !== 1 || !Array.isArray(record.excluded_oversize_files)) throw new Error('Invalid stored source coverage record');
    return normalizeSourceExclusions(record.excluded_oversize_files);
  } finally {
    await handle.close();
  }
}

export async function writeWorkspaceSourceExclusions(workspace: string, exclusions: SourceFileExclusion[]): Promise<void> {
  await writeJsonAtomic(coveragePath(workspace), {
    version: 1,
    excluded_oversize_files: normalizeSourceExclusions(exclusions),
  }, { spaces: 0 });
}

export function mergeSourceExclusions(
  previous: SourceFileExclusion[] | undefined,
  changes: ReadonlyArray<{ path: string }>,
  incoming: SourceFileExclusion[],
): SourceFileExclusion[] {
  const changed = new Set(changes.map(file => file.path.replace(/\\/g, '/')));
  const merged = new Map((previous || []).filter(file => !changed.has(file.path)).map(file => [file.path, file]));
  for (const file of incoming) merged.set(file.path, file);
  return normalizeSourceExclusions([...merged.values()]);
}

export function applySourceExclusions(cas: CASOutput, exclusions: SourceFileExclusion[] | undefined): void {
  if (exclusions === undefined) return;
  const files = normalizeSourceExclusions(exclusions);
  const diagnostics = (cas.analysis_errors || []).filter(error => error.code !== DIAGNOSTIC_CODE || error.analyzer !== COVERAGE_ORIGIN);
  const gaps = (cas.coverage_gaps || []).filter(gap => gap.kind !== 'source-file-excluded' || gap.detail?.origin !== COVERAGE_ORIGIN);
  for (const file of files) {
    const evidence = `Client omitted ${file.path} (${file.bytes} bytes) because it exceeded the upload file-size limit; its behavior and relationships were not scanned.`;
    diagnostics.push({
      severity: 'warning', code: DIAGNOSTIC_CODE, message: evidence, file: file.path,
      analyzer: COVERAGE_ORIGIN, recoverable: true,
      suggestion: 'Upload this file and reanalyze before relying on complete codebase understanding.',
    });
    gaps.push({
      kind: 'source-file-excluded', evidence, file: file.path, key: file.path, severity: 'high',
      detail: { origin: COVERAGE_ORIGIN, reason: 'upload-file-size-limit', bytes: file.bytes },
    });
  }
  if (diagnostics.length || cas.analysis_errors) cas.analysis_errors = diagnostics;
  if (gaps.length || cas.coverage_gaps) cas.coverage_gaps = gaps;
}

export async function saveAnalysisWithSourceCoverage(...args: Parameters<typeof saveAnalysis>): Promise<void> {
  const [workspace, cas] = args;
  applySourceExclusions(cas, await readWorkspaceSourceExclusions(workspace));
  await saveAnalysis(...args);
}

export function sourceExclusionReadiness(cas: Pick<CASOutput, 'coverage_gaps'>) {
  const count = (cas.coverage_gaps || []).filter(gap => gap.kind === 'source-file-excluded').length;
  const detail = `${count} source file(s) were omitted before analysis; inspect get_coverage_gaps. Known results remain usable, but analysis-only understanding is incomplete.`;
  return {
    count, detail,
    gates: count ? [{ id: 'source-coverage', status: 'warn' as const, score: 75, detail }] : [],
  };
}
