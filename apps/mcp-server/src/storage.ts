import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import type {
  CASOutput,
  IncrementalState,
  FileAnalysisResult,
  ChangeHistoryEntry,
  ChangeReport,
  INCREMENTAL_STATE_VERSION,
} from '../../../packages/analyzer-core/src/types/cas.types';
import { CAS_VERSION } from '../../../packages/analyzer-core/src/types/cas.types';
import type { RuntimeObservation } from './product';
import { mirrorArtifactsToS3 } from './s3-artifacts';
import type { AnalysisTrack } from './track';
import { trackSuffix } from './track';
import { resolveAnalysisScope, filterEntriesToScope, filterWorkspaceGraphsToScope } from './analysis-scope';

const execFileAsync = promisify(execFile);
const brotliCompressAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const ZSTD_MAX_BUFFER = 1024 * 1024 * 1024;
type JsonStorageCodec = 'none' | 'brotli' | 'zstd';

const DEFAULT_STORAGE_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.klauro',
  'analyses'
);
let resolvedDefaultStoragePath: string | null = null;

interface AnalysisIndex {
  version?: string;
  updated_at?: string;
  analyses: Record<string, AnalysisEntry>;
}

export interface AnalysisEntry {
  name: string;
  path: string;
  file: string;
  analyzed_at: string;
  system_type: string;
  frameworks: string[];
  node_count: number;
  edge_count: number;
  cas_version?: string;
  /** Which analysis track this entry belongs to. Defaults to 'main' (legacy). */
  track?: AnalysisTrack;
  /** Analyzed commit SHA, when the output carried one. */
  base_commit?: string;
  /** Analyzed branch, when the output carried one. */
  branch?: string;
}

export const MINIMUM_COMPATIBLE_CAS_VERSION = '1.6.0';

export type AnalysisVersionStatus = 'current' | 'older-compatible' | 'newer-compatible' | 'unsupported' | 'newer-major';

export interface AnalysisVersionInfo {
  stored_version: string;
  current_version: string;
  minimum_compatible_version: string;
  status: AnalysisVersionStatus;
}

export function parseCasVersion(version: string | undefined): [number, number, number] | null {
  if (!version) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareCasVersions(a: string | undefined, b: string | undefined): number {
  const left = parseCasVersion(a) || [0, 0, 0];
  const right = parseCasVersion(b) || [0, 0, 0];
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function describeAnalysisVersion(storedVersion: string | undefined): AnalysisVersionInfo {
  const stored = parseCasVersion(storedVersion) ? (storedVersion as string).trim() : '0.0.0';
  const current = parseCasVersion(CAS_VERSION) || [0, 0, 0];
  const parsed = parseCasVersion(stored) || [0, 0, 0];

  let status: AnalysisVersionStatus;
  if (parsed[0] > current[0]) {
    status = 'newer-major';
  } else if (parsed[0] < current[0] || compareCasVersions(stored, MINIMUM_COMPATIBLE_CAS_VERSION) < 0) {
    status = 'unsupported';
  } else if (compareCasVersions(stored, CAS_VERSION) === 0) {
    status = 'current';
  } else if (compareCasVersions(stored, CAS_VERSION) > 0) {
    status = 'newer-compatible';
  } else {
    status = 'older-compatible';
  }

  return {
    stored_version: stored,
    current_version: CAS_VERSION,
    minimum_compatible_version: MINIMUM_COMPATIBLE_CAS_VERSION,
    status,
  };
}

export function getAnalysisVersionInfo(cas: CASOutput): AnalysisVersionInfo {
  const tagged = (cas as CASOutput & { analysis_version_info?: AnalysisVersionInfo }).analysis_version_info;
  return tagged || describeAnalysisVersion(cas.cas_version);
}

export function assertAnalysisVersionSupported(cas: CASOutput, projectPath: string): void {
  const info = getAnalysisVersionInfo(cas);
  if (info.status === 'unsupported') {
    throw new Error(
      `Stored analysis for ${projectPath} uses cas_version ${info.stored_version}, which is below the minimum compatible version ${info.minimum_compatible_version} (server is at ${info.current_version}). Re-run analyze_codebase on this path to regenerate the analysis.`
    );
  }
  if (info.status === 'newer-major') {
    throw new Error(
      `Stored analysis for ${projectPath} uses cas_version ${info.stored_version}, which is a newer major version than this server's CAS version ${info.current_version}. Upgrade the Klauro MCP server, or re-run analyze_codebase with this server to regenerate the analysis.`
    );
  }
}

function tagAnalysisVersion(output: CASOutput): CASOutput {
  const info = describeAnalysisVersion(output.cas_version);
  Object.defineProperty(output, 'analysis_version_info', {
    value: info,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return output;
}

export interface ProposalPreviewArtifact {
  id: string;
  type: 'existing_codebase_iteration' | 'greenfield_codebase';
  title: string;
  plan_text: string;
  organization_id?: string;
  project_id?: string;
  codebase_id?: string;
  baseline_analysis_id?: string;
  baseline_path?: string;
  proposed_analysis_id: string;
  proposed_path: string;
  verdict: unknown;
  preview_url: string;
  created_by: string;
  created_at: string;
  artifacts: {
    plan_file: string;
    diff_file?: string;
    proposed_files_file?: string;
    baseline_cas_file?: string;
    proposed_cas_file: string;
    comparison_file: string;
    visualization_file: string;
  };
  s3_artifacts?: Record<string, string>;
}

function getStoragePath(): string {
  if (process.env.KLAURO_STORAGE_PATH) return process.env.KLAURO_STORAGE_PATH;
  if (resolvedDefaultStoragePath) return resolvedDefaultStoragePath;
  try {
    fs.ensureDirSync(DEFAULT_STORAGE_PATH);
    fs.accessSync(DEFAULT_STORAGE_PATH, fs.constants.W_OK);
    resolvedDefaultStoragePath = DEFAULT_STORAGE_PATH;
  } catch {
    const userId = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
    resolvedDefaultStoragePath = path.join(os.tmpdir(), `klauro-analyses-${userId}`);
  }
  return resolvedDefaultStoragePath;
}

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}

function projectSlug(projectPath: string): string {
  const base = slugify(path.basename(projectPath)) || 'project';
  const hash = crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 12);
  return `${base}-${hash}`;
}

let orphanedTmpSweepStarted = false;

async function ensureStorageDir(): Promise<string> {
  const storagePath = getStoragePath();
  await fs.ensureDir(storagePath);
  if (!orphanedTmpSweepStarted) {
    orphanedTmpSweepStarted = true;
    void pruneOrphanedTmpFiles().catch(() => undefined);
    void pruneOrphanedLockOnlyDirs().catch(() => undefined);
  }
  return storagePath;
}

const DEFAULT_ORPHANED_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHANED_TMP_SWEEP_MAX_DEPTH = 6;

export async function pruneOrphanedTmpFiles(options: { maxAgeMs?: number; root?: string } = {}): Promise<{ removed: string[] }> {
  const root = options.root || getStoragePath();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_ORPHANED_TMP_MAX_AGE_MS;
  const cutoffMs = Date.now() - maxAgeMs;
  const removed: string[] = [];

  const sweep = async (directory: string, depth: number): Promise<void> => {
    if (depth > ORPHANED_TMP_SWEEP_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await sweep(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
      const stat = await fs.stat(entryPath).catch(() => null);
      if (stat && stat.mtimeMs < cutoffMs) {
        await fs.remove(entryPath).catch(() => undefined);
        removed.push(entryPath);
      }
    }
  };

  await sweep(root, 0);
  return { removed };
}

const DEFAULT_ORPHANED_LOCK_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remove per-project store directories that contain ONLY a stale
 * `analysis.lock`. withProjectAnalysisLock ensures the project dir and writes
 * the lock BEFORE any analysis artifact exists; a process killed in that
 * window leaves a lock-only directory behind forever (observed in the wild:
 * ~/.klauro/analyses/f7701b18…-1da636e01772 holding nothing but
 * analysis.lock). The lock itself would be broken as stale on the next
 * acquire for the SAME project, but a one-off aborted path never gets a next
 * acquire — so sweep them here, gated on the same staleness rules as
 * acquireStorageLock (dead pid on this host, or older than the age cap).
 */
export async function pruneOrphanedLockOnlyDirs(options: { maxAgeMs?: number; root?: string } = {}): Promise<{ removed: string[] }> {
  const root = options.root || getStoragePath();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_ORPHANED_LOCK_MAX_AGE_MS;
  const removed: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { removed };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(root, entry.name);
    let children: string[];
    try {
      children = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    if (children.length !== 1 || children[0] !== 'analysis.lock') continue;
    const lockPath = path.join(dirPath, 'analysis.lock');
    const state = await readStorageLockState(lockPath);
    // Unreadable lock file (racing writer) is left alone; only a demonstrably
    // stale lock (dead pid on this host / other-host leftovers / too old) is
    // reclaimed, mirroring acquireStorageLock's rules.
    if (state && !isStorageLockStale(state, maxAgeMs)) continue;
    await fs.remove(dirPath).catch(() => undefined);
    removed.push(dirPath);
  }
  return { removed };
}

// =============================================================================
// ADVISORY FILE LOCKING
// =============================================================================
//
// Multiple MCP server processes share one store under the default user-scope
// install. Mutations of shared files (index.json) and whole-analysis runs are
// guarded by advisory lock files holding the owner pid, hostname, and acquire
// time. Stale locks (dead pid on the same host, or older than the age cap) are
// broken automatically; waiting is bounded so a lock can never deadlock a
// caller, only fail with a clear error.

interface StorageLockInfo {
  pid: number;
  hostname: string;
  acquired_at: string;
  purpose?: string;
}

export interface StorageLockHandle {
  lockPath: string;
  release(): Promise<void>;
}

export interface StorageLockOptions {
  waitMs: number;
  staleMs: number;
  purpose: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface StorageLockState {
  raw: string;
  info: StorageLockInfo | null;
  mtimeMs: number;
}

async function readStorageLockState(lockPath: string): Promise<StorageLockState | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)]);
    let info: StorageLockInfo | null = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.pid === 'number') info = parsed as StorageLockInfo;
    } catch {
      info = null;
    }
    return { raw, info, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function storageLockAgeMs(state: StorageLockState): number {
  const acquiredAt = state.info?.acquired_at ? new Date(state.info.acquired_at).getTime() : NaN;
  const reference = Number.isFinite(acquiredAt) ? acquiredAt : state.mtimeMs;
  return Math.max(0, Date.now() - reference);
}

function isStorageLockStale(state: StorageLockState, staleMs: number): boolean {
  if (storageLockAgeMs(state) > staleMs) return true;
  if (!state.info) return false;
  // Same host: the holder is reclaimable only once its pid is gone.
  if (state.info.hostname === os.hostname()) return !isProcessAlive(state.info.pid);
  // Different host: in this single-container deployment a lock stamped with another
  // hostname is a prior container generation left behind by a deploy recreate — the
  // holder is definitively gone, so reclaim it immediately instead of waiting out the
  // age window (the deploy-orphaned-lock stall). If this ever runs multi-container,
  // this branch must instead consult a shared liveness signal.
  return true;
}

async function removeStorageLockIfUnchanged(lockPath: string, expectedRaw: string): Promise<void> {
  const current = await readStorageLockState(lockPath);
  if (current && current.raw === expectedRaw) {
    await fs.remove(lockPath).catch(() => undefined);
  }
}

function describeStorageLockHolder(state: StorageLockState): string {
  const ageSeconds = Math.round(storageLockAgeMs(state) / 1000);
  if (!state.info) return `(lock file is unreadable, last modified ${ageSeconds}s ago)`;
  return `(started ${ageSeconds}s ago by pid ${state.info.pid} on ${state.info.hostname})`;
}

function sleepMs(durationMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

export async function acquireStorageLock(lockPath: string, options: StorageLockOptions): Promise<StorageLockHandle> {
  const startedAt = Date.now();
  let delayMs = 25;

  for (;;) {
    try {
      const fd = await fs.open(lockPath, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquired_at: new Date().toISOString(),
        purpose: options.purpose,
      } satisfies StorageLockInfo);
      await fs.write(fd, payload);
      await fs.close(fd);
      return {
        lockPath,
        release: async () => {
          await fs.remove(lockPath).catch(() => undefined);
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT: the parent directory vanished between the caller's ensureDir
      // and this open — a concurrent releaser prunes empty (artifact-less)
      // project dirs (see withProjectAnalysisLock's cleanup). Recreate and retry.
      if (code === 'ENOENT') {
        await fs.ensureDir(path.dirname(lockPath));
        continue;
      }
      if (code !== 'EEXIST') throw error;
    }

    const existing = await readStorageLockState(lockPath);
    if (!existing) continue;

    if (isStorageLockStale(existing, options.staleMs)) {
      await removeStorageLockIfUnchanged(lockPath, existing.raw);
      continue;
    }

    if (Date.now() - startedAt >= options.waitMs) {
      const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
      throw new Error(
        `${options.purpose} is already in progress ${describeStorageLockHolder(existing)}. ` +
        `Waited ${waitedSeconds}s for ${lockPath} without acquiring it. ` +
        `If no other Klauro process is running, delete the lock file and retry.`
      );
    }

    await sleepMs(delayMs + Math.floor(Math.random() * 25));
    delayMs = Math.min(Math.floor(delayMs * 1.6), 500);
  }
}

export async function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const storagePath = await ensureStorageDir();
  const lock = await acquireStorageLock(path.join(storagePath, 'index.json.lock'), {
    waitMs: parsePositiveIntegerEnv('KLAURO_INDEX_LOCK_WAIT_MS', 10_000),
    staleMs: parsePositiveIntegerEnv('KLAURO_INDEX_LOCK_STALE_MS', 30_000),
    purpose: 'Analysis index update',
  });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export async function withProjectAnalysisLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const projectDir = getProjectStorageDir(projectPath);
  await fs.ensureDir(projectDir);
  const lock = await acquireStorageLock(path.join(projectDir, 'analysis.lock'), {
    waitMs: parsePositiveIntegerEnv('KLAURO_ANALYSIS_LOCK_WAIT_MS', 10 * 60_000),
    staleMs: parsePositiveIntegerEnv('KLAURO_ANALYSIS_LOCK_STALE_MS', 60 * 60_000),
    purpose: `Analysis of ${projectPath}`,
  });
  try {
    return await fn();
  } finally {
    await lock.release();
    await removeProjectDirIfEmpty(projectDir);
  }
}

async function removeProjectDirIfEmpty(projectDir: string): Promise<void> {
  // Don't leave a lock-only directory behind when the analysis produced no
  // artifacts (e.g. it threw before writing anything): an empty project dir
  // here would otherwise persist as store noise forever (the orphaned
  // analysis.lock-only entry pattern — see pruneOrphanedLockOnlyDirs).
  try {
    const remaining = await fs.readdir(projectDir);
    if (remaining.length === 0) await fs.remove(projectDir);
  } catch {
    // best-effort cleanup only
  }
}

export type ProjectAnalysisLockAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/**
 * Zero-wait variant of withProjectAnalysisLock: if analysis.lock is currently
 * held by a live (non-stale) holder, this returns `{ acquired: false }`
 * immediately instead of waiting out the full lock timeout. Built for the L0
 * fast-path index save (see analyzeProjectLayered in analyzer.ts) — that save
 * is a nice-to-have seconds-scale availability optimization, not load-bearing:
 * a full analysis already queued/running on this same project will supersede
 * whatever the L0 stub would have written moments later anyway, so it is
 * never worth blocking on a busy lock. Reclaiming a genuinely stale lock still
 * happens (that's not "waiting", it's dead-holder cleanup), so this only ever
 * short-circuits the case that used to burn the full KLAURO_ANALYSIS_LOCK_WAIT_MS
 * (default 10 min, but a shorter override was seen stalling 120s in prod)
 * before giving up.
 */
export async function withProjectAnalysisLockIfAvailable<T>(
  projectPath: string,
  fn: () => Promise<T>
): Promise<ProjectAnalysisLockAttempt<T>> {
  const projectDir = getProjectStorageDir(projectPath);
  await fs.ensureDir(projectDir);
  let lock: StorageLockHandle;
  try {
    lock = await acquireStorageLock(path.join(projectDir, 'analysis.lock'), {
      waitMs: 0,
      staleMs: parsePositiveIntegerEnv('KLAURO_ANALYSIS_LOCK_STALE_MS', 60 * 60_000),
      purpose: `Analysis of ${projectPath}`,
    });
  } catch {
    // Lock is actively held by a live (non-stale) holder — a zero-wait miss,
    // not a failure. Caller's fallback (the full analysis pipeline) is
    // expected to supersede whatever this attempt would have written.
    return { acquired: false };
  }
  try {
    const value = await fn();
    return { acquired: true, value };
  } finally {
    await lock.release();
    await removeProjectDirIfEmpty(projectDir);
  }
}

async function loadIndex(): Promise<AnalysisIndex> {
  const storagePath = await ensureStorageDir();
  const indexPath = path.join(storagePath, 'index.json');
  if (await fs.pathExists(indexPath)) {
    return fs.readJson(indexPath);
  }
  return { analyses: {} };
}

async function saveIndex(index: AnalysisIndex): Promise<void> {
  const storagePath = await ensureStorageDir();
  const indexPath = path.join(storagePath, 'index.json');
  await writeJsonAtomic(indexPath, {
    ...index,
    version: '2.0.0',
    updated_at: new Date().toISOString(),
  });
}

export async function writeJsonAtomic(filePath: string, value: unknown, options: { spaces?: number } = { spaces: 2 }): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    try {
      if (shouldStreamJson(value, options.spaces)) {
        await writeJsonStreamed(tmpPath, value);
      } else {
        await fs.writeJson(tmpPath, value, options);
      }
    } catch (error) {
      if (!isJsonStringTooLargeError(error)) throw error;
      await writeJsonStreamed(tmpPath, value);
    }
    await fs.move(tmpPath, filePath, { overwrite: true });
  } catch (error) {
    await fs.remove(tmpPath).catch(() => undefined);
    throw error;
  }
}

async function writeCompressedJsonAtomic(filePath: string, value: unknown, options: { spaces?: number } = { spaces: 0 }): Promise<void> {
  const codec = compressionCodecForPath(filePath);
  if (codec === 'none') {
    await writeJsonAtomic(filePath, value, options);
    return;
  }

  await fs.ensureDir(path.dirname(filePath));
  const jsonTmpPath = `${filePath}.${process.pid}.${Date.now()}.json.tmp`;
  const compressedTmpPath = `${filePath}.${process.pid}.${Date.now()}.compressed.tmp`;
  try {
    await writeJsonAtomic(jsonTmpPath, value, options);
    await compressJsonFile(jsonTmpPath, compressedTmpPath, codec);
    await fs.move(compressedTmpPath, filePath, { overwrite: true });
  } finally {
    await fs.remove(jsonTmpPath).catch(() => undefined);
    await fs.remove(compressedTmpPath).catch(() => undefined);
  }
}

async function readJsonMaybeCompressed(filePath: string): Promise<any> {
  const resolved = await resolveJsonStoragePath(filePath);
  if (!resolved) {
    throw new Error(`JSON file not found: ${filePath}`);
  }

  if (resolved.endsWith('.json.zst')) {
    const { stdout } = await execFileAsync('zstd', ['-q', '-d', '-c', resolved], {
      encoding: 'buffer',
      maxBuffer: ZSTD_MAX_BUFFER,
    });
    return JSON.parse(stdout.toString('utf8'));
  }

  if (resolved.endsWith('.json.br')) {
    const compressed = await fs.readFile(resolved);
    const json = await brotliDecompressAsync(compressed);
    return JSON.parse(json.toString('utf8'));
  }

  return fs.readJson(resolved);
}

async function resolveJsonStoragePath(filePath: string): Promise<string | null> {
  if (await fs.pathExists(filePath)) return filePath;
  const candidates = jsonStoragePathCandidates(filePath);
  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) return candidate;
  }
  return null;
}

function jsonStoragePathCandidates(filePath: string): string[] {
  if (filePath.endsWith('.json')) return [`${filePath}.zst`, `${filePath}.br`];
  if (filePath.endsWith('.json.zst')) return [filePath.replace(/\.zst$/, ''), filePath.replace(/\.zst$/, '.br')];
  if (filePath.endsWith('.json.br')) return [filePath.replace(/\.br$/, ''), filePath.replace(/\.br$/, '.zst')];
  return [];
}

function compressedJsonExtension(): '' | '.zst' | '.br' {
  const codec = selectedAnalysisCompressionCodec();
  if (codec === 'zstd') return '.zst';
  if (codec === 'brotli') return '.br';
  return '';
}

function compressionCodecForPath(filePath: string): JsonStorageCodec {
  if (filePath.endsWith('.json.zst')) return 'zstd';
  if (filePath.endsWith('.json.br')) return 'brotli';
  return 'none';
}

function selectedAnalysisCompressionCodec(): JsonStorageCodec {
  const requested = String(process.env.KLAURO_ANALYSIS_COMPRESSION || 'auto').toLowerCase();
  if (requested === 'none' || requested === 'off' || requested === 'false') return 'none';
  if (requested === 'brotli' || requested === 'br') return 'brotli';
  if (requested === 'zstd' || requested === 'zst') return hasZstdCommand() ? 'zstd' : 'brotli';
  return hasZstdCommand() ? 'zstd' : 'brotli';
}

let zstdCommandAvailable: boolean | undefined;

function hasZstdCommand(): boolean {
  if (zstdCommandAvailable !== undefined) return zstdCommandAvailable;
  const result = spawnSync('zstd', ['--version'], { stdio: 'ignore' });
  zstdCommandAvailable = result.status === 0;
  return zstdCommandAvailable;
}

async function compressJsonFile(sourcePath: string, targetPath: string, codec: JsonStorageCodec): Promise<void> {
  if (codec === 'zstd') {
    await execFileAsync('zstd', ['-q', '-10', '-T0', '-f', sourcePath, '-o', targetPath], {
      maxBuffer: 1024 * 1024,
    });
    return;
  }

  if (codec === 'brotli') {
    const json = await fs.readFile(sourcePath);
    const compressed = await brotliCompressAsync(json, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
      },
    });
    await fs.writeFile(targetPath, compressed);
    return;
  }

  await fs.copy(sourcePath, targetPath, { overwrite: true });
}

function shouldStreamJson(value: unknown, spaces?: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    nodes?: unknown[];
    edges?: unknown[];
    domain_concepts?: unknown[];
    method_calls?: unknown[];
    analysis_facts?: unknown[];
    test_gaps?: unknown[];
    fileCache?: unknown;
  };
  const graphItems =
    (candidate.nodes?.length || 0) +
    (candidate.edges?.length || 0) +
    (candidate.domain_concepts?.length || 0) +
    (candidate.method_calls?.length || 0) +
    (candidate.analysis_facts?.length || 0) +
    (candidate.test_gaps?.length || 0);
  // At spaces:0 the streamed writer's output is byte-identical to
  // fs.writeJson (JSON.stringify + trailing newline — verified byte-for-byte
  // on a 258MB whale CAS), and it yields to the event loop on stream
  // backpressure instead of one giant synchronous JSON.stringify macrotask.
  // Stream mid-size graphs too so analysis saves never block the in-process
  // HTTP server for seconds. Indented writes (spaces:2 index/metadata files)
  // keep the legacy threshold: streaming would drop their indentation, so it
  // stays a last resort for oversized payloads only.
  const threshold = spaces === 0 ? 10_000 : 100_000;
  return graphItems > threshold;
}

function isJsonStringTooLargeError(error: unknown): boolean {
  return error instanceof RangeError && /invalid string length/i.test(error.message);
}

async function writeJsonStreamed(filePath: string, value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
    stream.on('error', reject);
    stream.on('finish', resolve);

    const write = (chunk: string) => {
      if (!stream.write(chunk)) {
        return new Promise<void>(resume => stream.once('drain', resume));
      }
      return undefined;
    };

    const writeValue = async (current: unknown, inArray = false): Promise<void> => {
      if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
        await write(inArray ? 'null' : 'null');
        return;
      }
      if (current === null || typeof current !== 'object') {
        await write(JSON.stringify(current));
        return;
      }
      const jsonValue = typeof (current as { toJSON?: unknown }).toJSON === 'function'
        ? (current as { toJSON: () => unknown }).toJSON()
        : current;
      if (jsonValue !== current) {
        await writeValue(jsonValue, inArray);
        return;
      }
      if (Array.isArray(current)) {
        await write('[');
        for (let index = 0; index < current.length; index++) {
          if (index > 0) await write(',');
          if (canStringifyStreamArrayItem(current[index])) {
            await write(JSON.stringify(current[index]));
          } else {
            await writeValue(current[index], true);
          }
        }
        await write(']');
        return;
      }
      await write('{');
      let first = true;
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        if (!first) await write(',');
        first = false;
        await write(JSON.stringify(key));
        await write(':');
        await writeValue(child);
      }
      await write('}');
    };

    writeValue(value)
      .then(() => {
        stream.write('\n');
        stream.end();
      })
      .catch(error => {
        stream.destroy();
        reject(error);
      });
  });
}

function canStringifyStreamArrayItem(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'object') return true;
  if (Array.isArray(value)) return false;
  return !hasCustomJsonShape(value);
}

function hasCustomJsonShape(value: object): boolean {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

interface LoadedAnalysisCacheEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
  output: CASOutput;
}

const loadedAnalysisCache = new Map<string, LoadedAnalysisCacheEntry>();

async function rememberLoadedAnalysis(projectPath: string, filePath: string, output: CASOutput): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    loadedAnalysisCache.set(projectPath, { filePath, mtimeMs: stat.mtimeMs, size: stat.size, output });
  } catch {
    loadedAnalysisCache.delete(projectPath);
  }
}

/**
 * Index key for a (projectPath, track) pair. The 'main' track keeps the bare
 * projectPath key so all existing single-path lookups/deletes are unchanged;
 * other tracks get a distinct key so they coexist without overwriting main.
 */
function analysisIndexKey(projectPath: string, track: AnalysisTrack): string {
  return track === 'main' ? projectPath : `${projectPath}#${track}`;
}

export async function saveAnalysis(
  projectPath: string,
  output: CASOutput,
  track: AnalysisTrack = 'main'
): Promise<AnalysisEntry> {
  const storagePath = await ensureStorageDir();
  const fileName = `${projectSlug(projectPath)}${trackSuffix(track)}.json${compressedJsonExtension()}`;
  const filePath = path.join(storagePath, fileName);

  await writeCompressedJsonAtomic(filePath, output, { spaces: 0 });
  // Only the 'main' track participates in the path-keyed loaded-analysis cache,
  // which is keyed by projectPath and read back by default (main) loads.
  if (track === 'main') {
    await rememberLoadedAnalysis(projectPath, filePath, output);
  }

  const frameworks = output.system.technologies?.frameworks?.map(f => f.name) || [];

  const entry: AnalysisEntry = {
    name: output.system.name,
    path: projectPath,
    file: fileName,
    analyzed_at: output.analysis_timestamp,
    system_type: output.system.type,
    frameworks,
    node_count: output.nodes.length,
    edge_count: output.edges.length,
    cas_version: output.cas_version,
    track,
    ...(output.base_commit ? { base_commit: output.base_commit } : {}),
    ...(output.branch ? { branch: output.branch } : {}),
  };

  await withIndexLock(async () => {
    const index = await loadIndex();
    index.analyses[analysisIndexKey(projectPath, track)] = entry;
    await saveIndex(index);
  });

  return entry;
}

/**
 * Resolve the on-disk analysis file a load for `projectPath` would read,
 * honoring the same track selection and legacy-filename fallbacks as
 * loadAnalysis (which delegates here — single source of truth, no drift).
 */
async function resolveAnalysisFileForLoad(
  projectPath: string,
  requestedTrack?: AnalysisTrack
): Promise<string | null> {
  const index = await loadIndex();
  // Default view (no explicit track): the agent's current working state
  // (in-flight) when one exists, else the shared committed baseline (main). An
  // explicit track is honored exactly. This keeps a dirty-tree sync readable by
  // default while never letting it clobber the preserved main analysis.
  const track: AnalysisTrack = requestedTrack
    ?? (index.analyses[analysisIndexKey(projectPath, 'in-flight')] ? 'in-flight' : 'main');
  // Track-specific entry; for 'main' this is the legacy bare-path key.
  const entry = index.analyses[analysisIndexKey(projectPath, track)];
  // Backward compat: a legacy 'main' analysis may only exist under the bare
  // path key, which analysisIndexKey('main') already returns — no extra work.
  if (!entry) return null;

  const storagePath = getStoragePath();
  const filePath = path.join(storagePath, entry.file);
  let resolved = await resolveJsonStoragePath(filePath);
  // Backward compat: if a track-specific file is missing for 'main', fall back
  // to the legacy on-disk filename (no track suffix).
  if (!resolved && track === 'main') {
    const legacyName = `${projectSlug(projectPath)}.json${compressedJsonExtension()}`;
    resolved = await resolveJsonStoragePath(path.join(storagePath, legacyName));
  }
  return resolved;
}

/**
 * Cheap version fingerprint of the stored analysis for `projectPath`:
 * `mtimeMs:size` of the exact file loadAnalysis would read (same track
 * selection, same legacy fallbacks). Changes on every saveAnalysis rewrite —
 * including each layer stamp of an in-flight reanalyze — so it is a safe
 * (invalidates at least as often as needed) cache key for any response that
 * is a pure function of the stored CAS. Returns null when no analysis file
 * resolves; callers must then bypass their cache.
 */
export async function getAnalysisFileFingerprint(
  projectPath: string,
  options?: { track?: AnalysisTrack }
): Promise<string | null> {
  const resolved = await resolveAnalysisFileForLoad(projectPath, options?.track);
  if (!resolved) return null;
  try {
    const stat = await fs.stat(resolved);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

export async function loadAnalysis(
  projectPath: string,
  options?: { preferCache?: boolean; track?: AnalysisTrack }
): Promise<CASOutput | null> {
  const resolved = await resolveAnalysisFileForLoad(projectPath, options?.track);
  if (!resolved) return null;

  if (options?.preferCache) {
    const cached = loadedAnalysisCache.get(projectPath);
    if (cached && cached.filePath === resolved) {
      try {
        const stat = await fs.stat(resolved);
        if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
          return tagAnalysisVersion(cached.output);
        }
      } catch {
        // fall through to a fresh read
      }
    }
    const output = await readJsonMaybeCompressed(resolved);
    if (output) {
      await rememberLoadedAnalysis(projectPath, resolved, output);
    }
    return output ? tagAnalysisVersion(output) : output;
  }

  const output = await readJsonMaybeCompressed(resolved);
  return output ? tagAnalysisVersion(output) : output;
}

export async function listAnalyses(options: { scopeCwd?: string } = {}): Promise<AnalysisEntry[]> {
  const index = await loadIndex();
  const entries = Object.values(index.analyses);
  const scope = await resolveAnalysisScope({ cwd: options.scopeCwd });
  return filterEntriesToScope(entries, scope);
}

/**
 * Same as listAnalyses, but also returns the resolved scope so a caller can
 * surface "scoped to workspace X" (or explicitly report unscoped) without
 * ever naming what was filtered out. Use this in any tool handler that wants
 * to be honest about isolation; listAnalyses() alone stays the drop-in
 * choke point for existing callers.
 *
 * `scopeCwd` lets a caller anchor the scope on a specific requested path
 * (e.g. resolve_agent_analysis's `path` argument) instead of the MCP
 * process's own process.cwd() — see agent-project-map.ts for why: the
 * process cwd is not necessarily the repo the caller is asking about, and
 * scoping by the wrong directory can fail open to 'machine' (unscoped) even
 * when the REQUESTED path has a real workspace binding of its own.
 */
export async function listAnalysesWithScope(options: { scopeCwd?: string } = {}): Promise<{ entries: AnalysisEntry[]; scope: Awaited<ReturnType<typeof resolveAnalysisScope>> }> {
  const index = await loadIndex();
  const entries = Object.values(index.analyses);
  const scope = await resolveAnalysisScope({ cwd: options.scopeCwd });
  return { entries: await filterEntriesToScope(entries, scope), scope };
}

export async function getAnalysisEntry(projectPath: string): Promise<AnalysisEntry | null> {
  const index = await loadIndex();
  return index.analyses[projectPath] || null;
}

export async function saveWorkspaceGraph(graph: { id: string; name: string; generated_at: string }): Promise<{
  id: string;
  saved_at: string;
  file: string;
}> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'workspace-graphs');
  const id = graph.id || slugify(graph.name) || 'workspace';
  const file = path.join(directory, `${id}.json`);
  const savedAt = new Date().toISOString();
  await writeJsonAtomic(file, {
    ...graph,
    id,
    saved_at: savedAt,
  });
  return { id, saved_at: savedAt, file };
}

export async function loadWorkspaceGraph(idOrName: string): Promise<any | null> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'workspace-graphs');
  const directPath = path.join(directory, `${slugify(idOrName)}.json`);
  if (await fs.pathExists(directPath)) return fs.readJson(directPath);
  if (!(await fs.pathExists(directory))) return null;

  const files = await fs.readdir(directory);
  for (const file of files.filter(candidate => candidate.endsWith('.json'))) {
    const graph = await fs.readJson(path.join(directory, file));
    if (graph.id === idOrName || graph.name === idOrName || slugify(graph.name || '') === slugify(idOrName)) {
      return graph;
    }
  }
  return null;
}

export async function listWorkspaceGraphs(): Promise<Array<{
  id: string;
  name: string;
  generated_at?: string;
  saved_at?: string;
  repository_count?: number;
  link_count?: number;
  file: string;
}>> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'workspace-graphs');
  if (!(await fs.pathExists(directory))) return [];

  const files = await fs.readdir(directory);
  const graphs = [];
  for (const file of files.filter(candidate => candidate.endsWith('.json'))) {
    const graph = await fs.readJson(path.join(directory, file));
    graphs.push({
      id: graph.id,
      name: graph.name,
      generated_at: graph.generated_at,
      saved_at: graph.saved_at,
      repository_count: graph.repository_count,
      link_count: graph.links?.length || 0,
      file: path.join(directory, file),
    });
  }
  return graphs.sort((left, right) => String(right.saved_at || right.generated_at || '').localeCompare(String(left.saved_at || left.generated_at || '')));
}

function workspaceAnalysisMetadataPath(directory: string, id: string): string {
  return path.join(directory, `${id}.meta.json`);
}

function isWorkspaceAnalysisDataFile(file: string): boolean {
  if (file.endsWith('.meta.json')) return false;
  return file.endsWith('.json') || file.endsWith('.json.zst') || file.endsWith('.json.br');
}

function workspaceAnalysisIdFromFile(file: string): string {
  return file
    .replace(/\.json\.zst$/, '')
    .replace(/\.json\.br$/, '')
    .replace(/\.json$/, '');
}

function summarizeWorkspaceAnalysisInputs(inputs: any[]): Array<{ project_id?: string; codebase_id?: string; repo_path?: string; path?: string; cas_generated_at?: string }> {
  return inputs.slice(0, 200).map(input => ({
    project_id: input.project_id,
    codebase_id: input.codebase_id,
    repo_path: input.repo_path,
    path: input.path,
    cas_generated_at: input.cas_generated_at,
  }));
}

function buildCrossCodebaseSystemGraphMetadata(graph: any, file: string) {
  return {
    id: graph.id,
    name: graph.name,
    generated_at: graph.generated_at,
    saved_at: graph.saved_at,
    codebase_count: graph.codebase_count,
    interface_count: graph.interfaces?.length || 0,
    link_count: graph.links?.length || 0,
    unmatched_interface_count: graph.unmatched_interfaces?.length || 0,
    inputs: summarizeWorkspaceAnalysisInputs(graph.inputs || []),
    file,
  };
}

async function readWorkspaceAnalysisMetadata(directory: string, filePath: string): Promise<ReturnType<typeof buildCrossCodebaseSystemGraphMetadata> | null> {
  const id = workspaceAnalysisIdFromFile(path.basename(filePath));
  const metadataPath = workspaceAnalysisMetadataPath(directory, id);
  if (!(await fs.pathExists(metadataPath))) return null;
  try {
    const metadata = await fs.readJson(metadataPath);
    return {
      ...metadata,
      file: filePath,
    };
  } catch {
    return null;
  }
}

export async function saveCrossCodebaseSystemGraph(graph: { id: string; name: string; generated_at: string }): Promise<{
  id: string;
  saved_at: string;
  file: string;
}> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'workspace-analyses');
  const id = graph.id || slugify(graph.name) || 'system-analysis';
  const file = path.join(directory, `${id}.json`);
  const savedAt = new Date().toISOString();
  const payload = {
    ...graph,
    id,
    saved_at: savedAt,
  };
  await writeJsonAtomic(file, payload);
  await writeJsonAtomic(workspaceAnalysisMetadataPath(directory, id), buildCrossCodebaseSystemGraphMetadata(payload, file));
  return { id, saved_at: savedAt, file };
}

export async function loadCrossCodebaseSystemGraph(idOrName: string): Promise<any | null> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'workspace-analyses');
  const directPath = path.join(directory, `${slugify(idOrName)}.json`);
  if (await resolveJsonStoragePath(directPath)) {
    const graph = await readJsonMaybeCompressed(directPath);
    await writeJsonAtomic(workspaceAnalysisMetadataPath(directory, graph.id || slugify(idOrName)), buildCrossCodebaseSystemGraphMetadata(graph, directPath)).catch(() => undefined);
    return graph;
  }
  for (const candidateDirectory of [directory, path.join(storagePath, 'cross-codebase-analyses')]) {
    if (!(await fs.pathExists(candidateDirectory))) continue;
    const files = await fs.readdir(candidateDirectory);
    for (const file of files.filter(isWorkspaceAnalysisDataFile)) {
      const filePath = path.join(candidateDirectory, file);
      const metadata = await readWorkspaceAnalysisMetadata(candidateDirectory, filePath);
      if (metadata && metadata.id !== idOrName && metadata.name !== idOrName && slugify(metadata.name || '') !== slugify(idOrName)) {
        continue;
      }
      if (!metadata && workspaceAnalysisIdFromFile(file) !== slugify(idOrName)) {
        continue;
      }
      const graph = await readJsonMaybeCompressed(filePath);
      if (graph.id === idOrName || graph.name === idOrName || slugify(graph.name || '') === slugify(idOrName)) {
        await writeJsonAtomic(workspaceAnalysisMetadataPath(candidateDirectory, graph.id || workspaceAnalysisIdFromFile(file)), buildCrossCodebaseSystemGraphMetadata(graph, filePath)).catch(() => undefined);
        return graph;
      }
    }
  }
  return null;
}

export interface CrossCodebaseSystemGraphSummary {
  id: string;
  name: string;
  generated_at?: string;
  saved_at?: string;
  codebase_count?: number;
  interface_count?: number;
  link_count?: number;
  unmatched_interface_count?: number;
  inputs?: Array<{ project_id?: string; codebase_id?: string; repo_path?: string; path?: string; cas_generated_at?: string }>;
  file: string;
}

export async function listCrossCodebaseSystemGraphs(): Promise<CrossCodebaseSystemGraphSummary[]> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'workspace-analyses');
  if (!(await fs.pathExists(directory))) return [];

  const files = await fs.readdir(directory);
  const graphs: CrossCodebaseSystemGraphSummary[] = [];
  for (const file of files.filter(isWorkspaceAnalysisDataFile)) {
    const filePath = path.join(directory, file);
    const metadata = await readWorkspaceAnalysisMetadata(directory, filePath);
    if (metadata) {
      graphs.push(metadata);
      continue;
    }
    const stat = await fs.stat(filePath).catch(() => null);
    graphs.push({
      id: workspaceAnalysisIdFromFile(file),
      name: workspaceAnalysisIdFromFile(file),
      generated_at: stat?.mtime.toISOString(),
      saved_at: stat?.mtime.toISOString(),
      file: filePath,
    });
  }
  const sorted = graphs.sort((left, right) => String(right.saved_at || right.generated_at || '').localeCompare(String(left.saved_at || left.generated_at || '')));
  const scope = await resolveAnalysisScope();
  return filterWorkspaceGraphsToScope(sorted, scope);
}

export const saveWorkspaceAnalysis = saveCrossCodebaseSystemGraph;
export const loadWorkspaceAnalysis = loadCrossCodebaseSystemGraph;
export const listWorkspaceAnalyses = listCrossCodebaseSystemGraphs;

export async function saveAgenticBenchmarkReport(report: { id?: string; generated_at?: string; generatedAt?: string }): Promise<{
  id: string;
  saved_at: string;
  file: string;
}> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'agentic-benchmarks');
  const timestamp = report.generated_at || report.generatedAt || new Date().toISOString();
  const id = report.id || `benchmark-${Buffer.from(timestamp, 'utf-8').toString('base64url')}`;
  const file = path.join(directory, `${id}.json`);
  const latestFile = path.join(directory, 'latest.json');
  const savedAt = new Date().toISOString();
  const payload = {
    ...report,
    id,
    saved_at: savedAt,
  };
  await writeJsonAtomic(file, payload);
  await writeJsonAtomic(latestFile, payload);
  await pruneAgenticBenchmarkReports(directory);
  return { id, saved_at: savedAt, file };
}

const DEFAULT_MAX_AGENTIC_BENCHMARK_REPORTS = 50;
const DEFAULT_MAX_AGENTIC_BENCHMARK_BYTES = 256 * 1024 * 1024;

async function pruneAgenticBenchmarkReports(directory: string): Promise<void> {
  try {
    const files = (await fs.readdir(directory))
      .filter(file => file.endsWith('.json') && file !== 'latest.json');
    const reports = [];
    for (const file of files) {
      const filePath = path.join(directory, file);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) continue;
      let savedAt = stat.mtime.toISOString();
      try {
        const report = await fs.readJson(filePath);
        savedAt = report.saved_at || report.generated_at || report.generatedAt || savedAt;
      } catch {
      }
      reports.push({ file, filePath, savedAt, size: stat.size });
    }

    reports.sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)));
    const maxReports = parsePositiveIntegerEnv('KLAURO_MAX_AGENTIC_BENCHMARK_REPORTS', DEFAULT_MAX_AGENTIC_BENCHMARK_REPORTS);
    const maxBytes = parsePositiveIntegerEnv('KLAURO_MAX_AGENTIC_BENCHMARK_BYTES', DEFAULT_MAX_AGENTIC_BENCHMARK_BYTES);
    let retainedBytes = 0;

    for (const [index, report] of reports.entries()) {
      retainedBytes += report.size;
      const exceedsCount = index >= maxReports;
      const exceedsSize = index > 0 && retainedBytes > maxBytes;
      if (exceedsCount || exceedsSize) {
        await fs.remove(report.filePath);
      }
    }
  } catch {
    // Ignore pruning errors; benchmarks are proof artifacts, not the primary data path.
  }
}

export async function loadAgenticBenchmarkReport(id = 'latest'): Promise<any | null> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'agentic-benchmarks');
  const directFile = path.join(directory, `${id || 'latest'}.json`);
  if (await fs.pathExists(directFile)) return fs.readJson(directFile);
  const slugFile = path.join(directory, `${slugify(id) || 'latest'}.json`);
  if (await fs.pathExists(slugFile)) return fs.readJson(slugFile);
  return null;
}

export async function loadLatestAgenticBenchmarkReportByType(benchmarkType: string): Promise<any | null> {
  const reports = await listAgenticBenchmarkReports({ benchmarkType });
  if (reports.length === 0) return null;
  return loadAgenticBenchmarkReport(reports[0].id);
}

export async function listAgenticBenchmarkReports(): Promise<Array<{
  id: string;
  generated_at?: string;
  saved_at?: string;
  status?: string;
  score?: number;
  benchmark_type?: string;
  target_count?: number;
  task_count?: number;
  live_trials_attempted?: number;
  file: string;
}>>;
export async function listAgenticBenchmarkReports(options: { benchmarkType?: string }): Promise<Array<{
  id: string;
  generated_at?: string;
  saved_at?: string;
  status?: string;
  score?: number;
  benchmark_type?: string;
  target_count?: number;
  task_count?: number;
  live_trials_attempted?: number;
  file: string;
}>>;
export async function listAgenticBenchmarkReports(options: { benchmarkType?: string } = {}): Promise<Array<{
  id: string;
  generated_at?: string;
  saved_at?: string;
  status?: string;
  score?: number;
  benchmark_type?: string;
  target_count?: number;
  task_count?: number;
  live_trials_attempted?: number;
  file: string;
}>> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'agentic-benchmarks');
  if (!(await fs.pathExists(directory))) return [];

  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.json') && file !== 'latest.json');
  const reports = [];
  for (const file of files) {
    const report = await fs.readJson(path.join(directory, file));
    if (options.benchmarkType && report.benchmark_type !== options.benchmarkType) continue;
    reports.push({
      id: report.id || path.basename(file, '.json'),
      generated_at: report.generated_at || report.generatedAt,
      saved_at: report.saved_at,
      status: report.status,
      score: report.score,
      benchmark_type: report.benchmark_type,
      target_count: report.summary?.target_count ?? report.targets?.length,
      task_count: report.summary?.task_count ?? report.trials?.length,
      live_trials_attempted: report.summary?.live_trials_attempted,
      file: path.join(directory, file),
    });
  }
  return reports.sort((left, right) => String(right.saved_at || right.generated_at || '').localeCompare(String(left.saved_at || left.generated_at || '')));
}

export async function saveGoldenSnapshot(projectPath: string, snapshot: unknown): Promise<{
  saved_at: string;
  path: string;
  file: string;
}> {
  const projectDir = getProjectStorageDir(projectPath);
  await fs.ensureDir(projectDir);
  const savedAt = new Date().toISOString();
  const snapshotPath = path.join(projectDir, 'cas-golden-snapshot.json');
  await writeJsonAtomic(snapshotPath, {
    saved_at: savedAt,
    project_path: projectPath,
    snapshot,
  });
  return { saved_at: savedAt, path: projectPath, file: snapshotPath };
}

export async function loadGoldenSnapshot(projectPath: string): Promise<{
  saved_at: string;
  project_path: string;
  snapshot: unknown;
} | null> {
  const projectDir = getProjectStorageDir(projectPath);
  const snapshotPath = path.join(projectDir, 'cas-golden-snapshot.json');
  if (!(await fs.pathExists(snapshotPath))) return null;
  return fs.readJson(snapshotPath);
}

// =============================================================================
// PROPOSAL PREVIEW STORAGE
// =============================================================================

export async function saveProposalPreviewArtifact(input: {
  preview: Omit<ProposalPreviewArtifact, 'artifacts'>;
  planText: string;
  diffText?: string;
  proposedFiles?: unknown;
  baselineCas?: CASOutput;
  proposedCas: CASOutput;
  comparison: unknown;
  visualization: unknown;
}): Promise<ProposalPreviewArtifact> {
  const storagePath = await ensureStorageDir();
  const directory = path.join(storagePath, 'proposal-previews', slugify(input.preview.id) || input.preview.id);
  await fs.ensureDir(directory);

  const artifacts: ProposalPreviewArtifact['artifacts'] = {
    plan_file: path.join(directory, 'plan.md'),
    diff_file: input.diffText ? path.join(directory, 'proposal.diff') : undefined,
    proposed_files_file: input.proposedFiles ? path.join(directory, 'proposed-files.json') : undefined,
    baseline_cas_file: input.baselineCas ? path.join(directory, 'baseline-cas.json') : undefined,
    proposed_cas_file: path.join(directory, 'proposed-cas.json'),
    comparison_file: path.join(directory, 'comparison.json'),
    visualization_file: path.join(directory, 'visualization.json'),
  };

  await fs.writeFile(artifacts.plan_file, input.planText, 'utf8');
  if (input.diffText && artifacts.diff_file) await fs.writeFile(artifacts.diff_file, input.diffText, 'utf8');
  if (input.proposedFiles && artifacts.proposed_files_file) await writeJsonAtomic(artifacts.proposed_files_file, input.proposedFiles);
  if (input.baselineCas && artifacts.baseline_cas_file) await writeJsonAtomic(artifacts.baseline_cas_file, input.baselineCas);
  await writeJsonAtomic(artifacts.proposed_cas_file, input.proposedCas);
  await writeJsonAtomic(artifacts.comparison_file, input.comparison);
  await writeJsonAtomic(artifacts.visualization_file, input.visualization);

  const s3Artifacts = await mirrorArtifactsToS3([
    { localPath: artifacts.plan_file, key: `proposal-previews/${input.preview.id}/plan.md`, contentType: 'text/markdown; charset=utf-8' },
    ...(artifacts.diff_file ? [{ localPath: artifacts.diff_file, key: `proposal-previews/${input.preview.id}/proposal.diff`, contentType: 'text/x-diff; charset=utf-8' }] : []),
    ...(artifacts.proposed_files_file ? [{ localPath: artifacts.proposed_files_file, key: `proposal-previews/${input.preview.id}/proposed-files.json`, contentType: 'application/json' }] : []),
    ...(artifacts.baseline_cas_file ? [{ localPath: artifacts.baseline_cas_file, key: `proposal-previews/${input.preview.id}/baseline-cas.json`, contentType: 'application/json' }] : []),
    { localPath: artifacts.proposed_cas_file, key: `proposal-previews/${input.preview.id}/proposed-cas.json`, contentType: 'application/json' },
    { localPath: artifacts.comparison_file, key: `proposal-previews/${input.preview.id}/comparison.json`, contentType: 'application/json' },
    { localPath: artifacts.visualization_file, key: `proposal-previews/${input.preview.id}/visualization.json`, contentType: 'application/json' },
  ]);

  const preview: ProposalPreviewArtifact = {
    ...input.preview,
    artifacts,
    s3_artifacts: Object.keys(s3Artifacts).length > 0 ? s3Artifacts : undefined,
  };
  await writeJsonAtomic(path.join(directory, 'preview.json'), preview);
  await writeJsonAtomic(path.join(storagePath, 'proposal-previews', 'latest.json'), preview);
  return preview;
}

export async function loadProposalPreviewArtifact(id = 'latest'): Promise<ProposalPreviewArtifact | null> {
  const storagePath = await ensureStorageDir();
  const directPath = id === 'latest'
    ? path.join(storagePath, 'proposal-previews', 'latest.json')
    : path.join(storagePath, 'proposal-previews', slugify(id) || id, 'preview.json');
  if (!(await fs.pathExists(directPath))) return null;
  return fs.readJson(directPath);
}

export async function loadProposalPreviewPayload(id = 'latest'): Promise<{
  preview: ProposalPreviewArtifact;
  baseline_cas?: CASOutput;
  proposed_cas: CASOutput;
  comparison: unknown;
  visualization: unknown;
} | null> {
  const preview = await loadProposalPreviewArtifact(id);
  if (!preview) return null;
  return {
    preview,
    baseline_cas: preview.artifacts.baseline_cas_file && await fs.pathExists(preview.artifacts.baseline_cas_file)
      ? await fs.readJson(preview.artifacts.baseline_cas_file)
      : undefined,
    proposed_cas: await fs.readJson(preview.artifacts.proposed_cas_file),
    comparison: await fs.readJson(preview.artifacts.comparison_file),
    visualization: await fs.readJson(preview.artifacts.visualization_file),
  };
}

// =============================================================================
// INCREMENTAL ANALYSIS STORAGE
// =============================================================================

const INCREMENTAL_STATE_VERSION_CURRENT = '1.0.0';

export function getProjectStorageDir(projectPath: string): string {
  const storagePath = getStoragePath();
  const slug = projectSlug(projectPath);
  return path.join(storagePath, slug);
}

function incrementalStateFileName(track: AnalysisTrack): string {
  return `incremental-state${trackSuffix(track)}.json`;
}

export async function saveIncrementalState(
  projectPath: string,
  state: IncrementalState,
  track: AnalysisTrack = 'main'
): Promise<void> {
  const projectDir = getProjectStorageDir(projectPath);
  await fs.ensureDir(projectDir);

  const statePath = path.join(projectDir, incrementalStateFileName(track));

  const stateToSave = {
    ...state,
    files: Object.fromEntries(
      Object.entries(state.files).map(([k, v]) => [k, v])
    ),
  };

  await writeJsonAtomic(statePath, stateToSave);
}

export async function loadIncrementalState(
  projectPath: string,
  track: AnalysisTrack = 'main'
): Promise<IncrementalState | null> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const statePath = path.join(projectDir, incrementalStateFileName(track));

    if (!(await fs.pathExists(statePath))) {
      return null;
    }

    const state = await fs.readJson(statePath);

    if (state.version !== INCREMENTAL_STATE_VERSION_CURRENT) {
      console.warn(
        `Incremental state version mismatch (${state.version} vs ${INCREMENTAL_STATE_VERSION_CURRENT}), discarding`
      );
      await deleteIncrementalState(projectPath, track);
      return null;
    }

    return state as IncrementalState;
  } catch (error) {
    console.warn('Failed to load incremental state:', error);
    return null;
  }
}

export async function deleteIncrementalState(
  projectPath: string,
  track: AnalysisTrack = 'main'
): Promise<void> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const statePath = path.join(projectDir, incrementalStateFileName(track));

    if (await fs.pathExists(statePath)) {
      await fs.remove(statePath);
    }
  } catch (error) {
    console.warn('Failed to delete incremental state:', error);
  }
}

// =============================================================================
// FILE CACHE STORAGE
// =============================================================================

export async function saveFileCache(
  projectPath: string,
  contentHash: string,
  result: FileAnalysisResult
): Promise<void> {
  const projectDir = getProjectStorageDir(projectPath);
  const cacheDir = path.join(projectDir, 'file-cache');
  await fs.ensureDir(cacheDir);

  const cachePath = path.join(cacheDir, `${contentHash}.json`);
  await writeJsonAtomic(cachePath, result, { spaces: 0 });
}

export async function loadFileCache(
  projectPath: string,
  contentHash: string
): Promise<FileAnalysisResult | null> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const cachePath = path.join(projectDir, 'file-cache', `${contentHash}.json`);

    if (!(await fs.pathExists(cachePath))) {
      return null;
    }

    return await fs.readJson(cachePath);
  } catch {
    return null;
  }
}

export async function clearFileCache(projectPath: string): Promise<void> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const cacheDir = path.join(projectDir, 'file-cache');

    if (await fs.pathExists(cacheDir)) {
      await fs.emptyDir(cacheDir);
    }
  } catch (error) {
    console.warn('Failed to clear file cache:', error);
  }
}

export async function getFileCacheSize(projectPath: string): Promise<{
  files: number;
  bytes: number;
}> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const cacheDir = path.join(projectDir, 'file-cache');

    if (!(await fs.pathExists(cacheDir))) {
      return { files: 0, bytes: 0 };
    }

    const files = await fs.readdir(cacheDir);
    let totalBytes = 0;

    for (const file of files) {
      const stat = await fs.stat(path.join(cacheDir, file));
      totalBytes += stat.size;
    }

    return { files: files.length, bytes: totalBytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

// =============================================================================
// CHANGE HISTORY STORAGE
// =============================================================================

const MAX_HISTORY_ENTRIES = 1000;

export async function saveChangeHistoryEntry(
  projectPath: string,
  entry: ChangeHistoryEntry
): Promise<void> {
  const projectDir = getProjectStorageDir(projectPath);
  await fs.ensureDir(projectDir);

  const historyPath = path.join(projectDir, 'change-history.json');

  let history: ChangeHistoryEntry[] = [];
  if (await fs.pathExists(historyPath)) {
    try {
      history = await fs.readJson(historyPath);
    } catch {
      history = [];
    }
  }

  history.unshift(entry);

  if (history.length > MAX_HISTORY_ENTRIES) {
    history = history.slice(0, MAX_HISTORY_ENTRIES);
  }

  await writeJsonAtomic(historyPath, history);
}

export async function loadChangeHistory(
  projectPath: string,
  options?: {
    since?: string;
    until?: string;
    limit?: number;
  }
): Promise<ChangeHistoryEntry[]> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const historyPath = path.join(projectDir, 'change-history.json');

    if (!(await fs.pathExists(historyPath))) {
      return [];
    }

    let history: ChangeHistoryEntry[] = await fs.readJson(historyPath);

    if (options?.since) {
      const sinceDate = new Date(options.since);
      history = history.filter(e => new Date(e.timestamp) >= sinceDate);
    }

    if (options?.until) {
      const untilDate = new Date(options.until);
      history = history.filter(e => new Date(e.timestamp) <= untilDate);
    }

    if (options?.limit && options.limit > 0) {
      history = history.slice(0, options.limit);
    }

    return history;
  } catch {
    return [];
  }
}

export async function getChangeHistoryEntry(
  projectPath: string,
  changeId: string
): Promise<ChangeHistoryEntry | null> {
  const history = await loadChangeHistory(projectPath);
  return history.find(e => e.id === changeId) || null;
}

export async function clearChangeHistory(projectPath: string): Promise<void> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const historyPath = path.join(projectDir, 'change-history.json');

    if (await fs.pathExists(historyPath)) {
      await fs.remove(historyPath);
    }
  } catch (error) {
    console.warn('Failed to clear change history:', error);
  }
}

// =============================================================================
// ANALYSIS SNAPSHOTS (for time travel)
// =============================================================================

const DEFAULT_MAX_SNAPSHOTS = 10;
const DEFAULT_MAX_SNAPSHOT_BYTES_PER_PROJECT = 512 * 1024 * 1024;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function getMaxSnapshots(): number {
  return parsePositiveIntegerEnv('KLAURO_MAX_SNAPSHOTS', DEFAULT_MAX_SNAPSHOTS);
}

function getMaxSnapshotBytesPerProject(): number {
  return parsePositiveIntegerEnv('KLAURO_MAX_SNAPSHOT_BYTES', DEFAULT_MAX_SNAPSHOT_BYTES_PER_PROJECT);
}

function isValidTimestamp(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function encodeSnapshotTimestamp(timestamp: string): string {
  return Buffer.from(timestamp, 'utf-8').toString('base64url');
}

function decodeSnapshotTimestamp(snapshotId: string): string | null {
  const encoded = snapshotId.replace(/^snapshot-/, '');

  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
    if (isValidTimestamp(decoded)) {
      return decoded;
    }
  } catch {
  }

  const legacyMatch = encoded.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/);
  if (legacyMatch) {
    const legacyTimestamp = `${legacyMatch[1]}T${legacyMatch[2]}:${legacyMatch[3]}:${legacyMatch[4]}.${legacyMatch[5]}Z`;
    if (isValidTimestamp(legacyTimestamp)) {
      return legacyTimestamp;
    }
  }

  return null;
}

function isAnalysisSnapshotFile(file: string): boolean {
  return file.startsWith('snapshot-') && (
    file.endsWith('.json') ||
    file.endsWith('.json.br') ||
    file.endsWith('.json.zst')
  );
}

function stripJsonStorageExtension(file: string): string {
  return file
    .replace(/\.json\.zst$/, '')
    .replace(/\.json\.br$/, '')
    .replace(/\.json$/, '');
}

export async function saveAnalysisSnapshot(
  projectPath: string,
  output: CASOutput
): Promise<string> {
  const projectDir = getProjectStorageDir(projectPath);
  const snapshotsDir = path.join(projectDir, 'snapshots');
  await fs.ensureDir(snapshotsDir);

  const timestamp = output.analysis_timestamp;
  const snapshotId = `snapshot-${encodeSnapshotTimestamp(timestamp)}`;
  const snapshotPath = path.join(snapshotsDir, `${snapshotId}.json${compressedJsonExtension()}`);

  await writeCompressedJsonAtomic(snapshotPath, output, { spaces: 0 });

  await pruneOldSnapshots(snapshotsDir);

  return snapshotId;
}

async function pruneOldSnapshots(snapshotsDir: string): Promise<void> {
  try {
    const files = await fs.readdir(snapshotsDir);
    const snapshots: Array<{ file: string; timestamp: string; size: number }> = [];
    for (const file of files) {
      if (!isAnalysisSnapshotFile(file)) continue;
      const filePath = path.join(snapshotsDir, file);
      const stat = await fs.stat(filePath).catch(() => null);
      snapshots.push({
        file,
        timestamp: decodeSnapshotTimestamp(stripJsonStorageExtension(file)) || '',
        size: stat?.size || 0,
      });
    }

    snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const maxSnapshots = getMaxSnapshots();
    const maxBytes = getMaxSnapshotBytesPerProject();
    let retainedBytes = 0;

    for (const [index, snapshot] of snapshots.entries()) {
      retainedBytes += snapshot.size;
      const exceedsCount = index >= maxSnapshots;
      const exceedsSize = index > 0 && retainedBytes > maxBytes;
      if (exceedsCount || exceedsSize) {
        await fs.remove(path.join(snapshotsDir, snapshot.file));
      }
    }
  } catch {
    // Ignore pruning errors
  }
}

export async function loadAnalysisSnapshot(
  projectPath: string,
  snapshotId: string
): Promise<CASOutput | null> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const snapshotPath = path.join(projectDir, 'snapshots', `${snapshotId}.json`);
    const resolved = await resolveJsonStoragePath(snapshotPath);

    if (!resolved) {
      return null;
    }

    return await readJsonMaybeCompressed(resolved);
  } catch {
    return null;
  }
}

export async function listAnalysisSnapshots(
  projectPath: string
): Promise<Array<{ id: string; timestamp: string }>> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const snapshotsDir = path.join(projectDir, 'snapshots');

    if (!(await fs.pathExists(snapshotsDir))) {
      return [];
    }

    const files = await fs.readdir(snapshotsDir);
    const snapshots: Array<{ id: string; timestamp: string }> = [];

    for (const file of files) {
      if (!isAnalysisSnapshotFile(file)) {
        continue;
      }

      const id = stripJsonStorageExtension(file);
      const timestamp = decodeSnapshotTimestamp(id);
      if (timestamp) {
        snapshots.push({ id, timestamp });
      }
    }

    return snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  } catch {
    return [];
  }
}

export async function getAnalysisAt(
  projectPath: string,
  timestamp: string
): Promise<CASOutput | null> {
  const snapshots = await listAnalysisSnapshots(projectPath);

  const targetTime = new Date(timestamp).getTime();
  let closestSnapshot: { id: string; timestamp: string } | null = null;
  let closestDiff = Infinity;

  for (const snapshot of snapshots) {
    const snapshotTime = new Date(snapshot.timestamp).getTime();
    if (snapshotTime <= targetTime) {
      const diff = targetTime - snapshotTime;
      if (diff < closestDiff) {
        closestDiff = diff;
        closestSnapshot = snapshot;
      }
    }
  }

  if (closestSnapshot) {
    return loadAnalysisSnapshot(projectPath, closestSnapshot.id);
  }

  return null;
}

// =============================================================================
// RUNTIME OBSERVATION STORAGE
// =============================================================================

const MAX_RUNTIME_OBSERVATIONS = 5000;

export async function saveRuntimeObservation(
  projectPath: string,
  observation: RuntimeObservation
): Promise<void> {
  const projectDir = getProjectStorageDir(projectPath);
  await fs.ensureDir(projectDir);

  const observationsPath = path.join(projectDir, 'runtime-observations.json');
  let observations: RuntimeObservation[] = [];

  if (await fs.pathExists(observationsPath)) {
    try {
      observations = await fs.readJson(observationsPath);
    } catch {
      observations = [];
    }
  }

  observations.unshift(observation);
  if (observations.length > MAX_RUNTIME_OBSERVATIONS) {
    observations = observations.slice(0, MAX_RUNTIME_OBSERVATIONS);
  }

  await writeJsonAtomic(observationsPath, observations);
}

export async function loadRuntimeObservations(
  projectPath: string,
  options?: {
    since?: string;
    type?: string;
    staticId?: string;
    traceId?: string;
    spanId?: string;
    limit?: number;
  }
): Promise<RuntimeObservation[]> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const observationsPath = path.join(projectDir, 'runtime-observations.json');

    if (!(await fs.pathExists(observationsPath))) {
      return [];
    }

    let observations: RuntimeObservation[] = await fs.readJson(observationsPath);

    if (options?.since) {
      const sinceDate = new Date(options.since);
      observations = observations.filter(observation => new Date(observation.event.timestamp) >= sinceDate);
    }

    if (options?.type) {
      observations = observations.filter(observation => observation.event.type === options.type);
    }

    if (options?.staticId) {
      observations = observations.filter(observation =>
        observation.correlation.matches.some(match => match.id === options.staticId) ||
        observation.event.static_id === options.staticId ||
        observation.event.node_id === options.staticId ||
        observation.event.entry_point_id === options.staticId ||
        observation.event.exit_point_id === options.staticId ||
        observation.event.call_chain_id === options.staticId
      );
    }

    if (options?.traceId) {
      observations = observations.filter(observation => observation.event.trace_id === options.traceId);
    }

    if (options?.spanId) {
      observations = observations.filter(observation => observation.event.span_id === options.spanId || observation.event.parent_span_id === options.spanId);
    }

    if (options?.limit && options.limit > 0) {
      observations = observations.slice(0, options.limit);
    }

    return observations;
  } catch {
    return [];
  }
}

export async function loadRuntimeTrace(projectPath: string, traceId: string): Promise<{
  trace_id: string;
  observations: RuntimeObservation[];
  matched: number;
  unmatched: number;
  static_ids: string[];
}> {
  const observations = await loadRuntimeObservations(projectPath, { traceId });
  const staticIds = new Set<string>();
  for (const observation of observations) {
    for (const match of observation.correlation.matches) {
      staticIds.add(match.id);
    }
    for (const id of [
      observation.event.static_id,
      observation.event.node_id,
      observation.event.entry_point_id,
      observation.event.exit_point_id,
      observation.event.call_chain_id,
    ]) {
      if (id) staticIds.add(id);
    }
  }

  return {
    trace_id: traceId,
    observations,
    matched: observations.filter(observation => observation.correlation.status !== 'unmatched').length,
    unmatched: observations.filter(observation => observation.correlation.status === 'unmatched').length,
    static_ids: Array.from(staticIds).sort(),
  };
}

export async function getStorageHealth(projectPath?: string): Promise<{
  storage_path: string;
  generated_storage_root: string;
  index_version?: string;
  analyses: number;
  workspace_graphs: number;
  agentic_benchmark_reports: number;
  generated_artifacts: {
    total_bytes: number;
    categories: Array<{ category: string; path: string; bytes: number; exists: boolean }>;
  };
  projects: Array<{
    path: string;
    name: string;
    analyzed_at: string;
    node_count: number;
    edge_count: number;
    snapshots: number;
    change_history_entries: number;
    runtime_observations: number;
    golden_snapshot_saved_at?: string;
    file_cache: { files: number; bytes: number };
  }>;
}> {
  const storagePath = await ensureStorageDir();
  const index = await loadIndex();
  const [workspaceGraphs, agenticBenchmarkReports] = await Promise.all([
    listWorkspaceGraphs(),
    listAgenticBenchmarkReports(),
  ]);
  const generatedArtifacts = await getGeneratedArtifactStorageHealth(storagePath);
  const entries = Object.entries(index.analyses)
    .filter(([entryPath]) => !projectPath || path.resolve(entryPath) === path.resolve(projectPath));
  const projects = [];

  for (const [entryPath, entry] of entries) {
    const [snapshots, history, runtimeObservations, fileCache, goldenSnapshot] = await Promise.all([
      listAnalysisSnapshots(entryPath),
      loadChangeHistory(entryPath),
      loadRuntimeObservations(entryPath),
      getFileCacheSize(entryPath),
      loadGoldenSnapshot(entryPath),
    ]);

    projects.push({
      path: entryPath,
      name: entry.name,
      analyzed_at: entry.analyzed_at,
      node_count: entry.node_count,
      edge_count: entry.edge_count,
      snapshots: snapshots.length,
      change_history_entries: history.length,
      runtime_observations: runtimeObservations.length,
      golden_snapshot_saved_at: goldenSnapshot?.saved_at,
      file_cache: fileCache,
    });
  }

  return {
    storage_path: storagePath,
    generated_storage_root: generatedArtifacts.root,
    index_version: index.version,
    analyses: Object.keys(index.analyses).length,
    workspace_graphs: workspaceGraphs.length,
    agentic_benchmark_reports: agenticBenchmarkReports.length,
    generated_artifacts: {
      total_bytes: generatedArtifacts.categories.reduce((sum, item) => sum + item.bytes, 0),
      categories: generatedArtifacts.categories,
    },
    projects,
  };
}

async function getGeneratedArtifactStorageHealth(storagePath: string): Promise<{
  root: string;
  categories: Array<{ category: string; path: string; bytes: number; exists: boolean }>;
}> {
  const root = path.basename(storagePath) === 'analyses' ? path.dirname(storagePath) : storagePath;
  const categories = await Promise.all([
    'incremental-benchmark-workspaces',
    'agent-live-trials',
    'machine-proof-workspaces',
    'scratch-build-benchmark',
    'greenfield-live-continuity',
    'from-zero-build-context-proof',
    'from-zero-dogfood',
  ].map(async category => {
    const artifactPath = path.join(root, category);
    const exists = await fs.pathExists(artifactPath);
    return {
      category,
      path: artifactPath,
      exists,
      bytes: exists ? await storageDirectorySize(artifactPath) : 0,
    };
  }));
  return { root, categories };
}

async function storageDirectorySize(targetPath: string): Promise<number> {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  const entries = await fs.readdir(targetPath).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    total += await storageDirectorySize(path.join(targetPath, entry));
  }
  return total;
}
