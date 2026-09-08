import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { getHeapStatistics } from 'v8';
import pLimit from 'p-limit';
import type {
  CASOutput,
  IncrementalState,
  FileAnalysisResult,
  ChangeHistoryEntry,
} from '../../../packages/analyzer-core/src/types/cas.types';
import type { RuntimeObservation } from './product';
import { mirrorArtifactsToS3 } from './s3-artifacts';
import type { AnalysisTrack } from './track';
import { trackSuffix } from './track';
import { resolveAnalysisScope, filterEntriesToScope, filterWorkspaceGraphsToScope } from './analysis-scope';
import {
  CAS_SECTION_NAMES,
  createCasSectionManifest,
  hydrateCasSections,
  selectCasSections,
  selectExactCasSection,
  type CasSectionManifest,
  type CasSectionName,
} from './cas-sections';
import { iterateDeployableChildCas, materializeDeployableCasTree, prepareDeployableCasProjection } from './deployable-analysis';
import { readZstdJson } from './zstd-json';
import { describeAnalysisVersion, hasFailedStructuralAnalysisLayer, type AnalysisVersionInfo } from './analysis-version';
import { segmentedReadFailureFallback } from './segmented-storage-access';
import { createAnalysisIndexEntry } from './analysis-index-entry';
import {
  acquireSegmentedAnalysisLease,
  loadCompactCASGraph,
  loadCompactCASSearch,
  resolveSegmentedAnalysis,
  segmentedAnalysisRoot,
  segmentedLegacyExportPath,
  type ResolvedSegmentedAnalysis,
  writeSegmentedAnalysis,
  writeSegmentedLegacyExport,
} from './segmented-analysis-storage';
import type { CompactCASGraph } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import type { LoadedCompactCASSearch } from './segmented-analysis-storage';
import { STRUCTURAL_ANALYSIS_LAYERS } from './analysis-layer-contract';
import { findCasById, hydrateSegmentedCasTree, loadCasProjection, loadLegacyProjectedCas, type LoadedAnalysisProjection } from './recursive-cas-storage';
import {
  compressLegacyJsonArtifact,
  compressedJsonExtension,
  compressionCodecForPath,
  writeCompressedJsonAtomic,
  writeJsonAtomic,
  type JsonStorageCodec,
} from './json-storage-writer';
export { writeJsonAtomic } from './json-storage-writer';
export { MINIMUM_COMPATIBLE_CAS_VERSION, parseCasVersion, compareCasVersions, describeAnalysisVersion } from './analysis-version';
export type { AnalysisVersionInfo, AnalysisVersionStatus } from './analysis-version';
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
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
  analysis_id?: string;
  analyzed_at: string;
  system_type: string;
  frameworks: string[];
  node_count: number;
  edge_count: number;
  cas_version?: string;
  layers_ready?: CASOutput['layers_ready'];
  storage_format?: 'whole-json' | 'segmented-v2';
  track?: AnalysisTrack;
  base_commit?: string;
  branch?: string;
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
    fs.accessSync(DEFAULT_STORAGE_PATH, fs.constants.R_OK);
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

    if (state && !isStorageLockStale(state, maxAgeMs)) continue;
    await fs.remove(dirPath).catch(() => undefined);
    removed.push(dirPath);
  }
  return { removed };
}

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

  if (state.info.hostname === os.hostname()) return !isProcessAlive(state.info.pid);

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

  try {
    const remaining = await fs.readdir(projectDir);
    if (remaining.length === 0) await fs.remove(projectDir);
  } catch {

  }
}

export type ProjectAnalysisLockAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false };

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

async function saveIndex(index: AnalysisIndex, onCommitted?: () => void): Promise<void> {
  const storagePath = await ensureStorageDir();
  const indexPath = path.join(storagePath, 'index.json');
  await writeJsonAtomic(indexPath, {
    ...index,
    version: '2.0.0',
    updated_at: new Date().toISOString(),
  }, { spaces: 2, onCommitted });
}

async function readJsonMaybeCompressed(
  filePath: string,
  options: { maxBufferedZstdBytes?: number } = {},
): Promise<any> {
  const resolved = await resolveJsonStoragePath(filePath);
  if (!resolved) {
    throw new Error(`JSON file not found: ${filePath}`);
  }

  if (resolved.endsWith('.json.zst')) {
    return readZstdJson(resolved, { maxBufferedCompressedBytes: options.maxBufferedZstdBytes });
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

interface LoadedAnalysisCacheEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
  estimatedBytes: number;
  output: CASOutput;
}

const loadedAnalysisCache = new Map<string, LoadedAnalysisCacheEntry>();

function parsedAnalysisCacheMaxEntries(): number {
  return parsePositiveIntegerEnv('KLAURO_PARSED_ANALYSIS_CACHE_MAX_ENTRIES', 1);
}

function parsedAnalysisCacheMaxBytes(): number {
  const heapBound = defaultParsedAnalysisCacheMaxBytes();
  return parsePositiveIntegerEnv('KLAURO_PARSED_ANALYSIS_CACHE_MAX_BYTES', heapBound);
}

const MAX_DEFAULT_PARSED_ANALYSIS_CACHE_BYTES = 256 * 1024 * 1024;

export function defaultParsedAnalysisCacheMaxBytes(heapLimit = getHeapStatistics().heap_size_limit): number {
  return Math.min(MAX_DEFAULT_PARSED_ANALYSIS_CACHE_BYTES, Math.floor(heapLimit / 8));
}

export function estimateParsedAnalysisBytes(output: CASOutput): number {
  const cas = output as CASOutput & {
    method_calls?: unknown[];
    analysis_facts?: unknown[];
    domain_concepts?: unknown[];
    intents?: unknown[];
    runtime_static_links?: unknown[];
  };
  return (
    64 * 1024 +
    (cas.nodes?.length || 0) * 2_048 +
    (cas.edges?.length || 0) * 768 +
    (cas.method_calls?.length || 0) * 1_536 +
    (cas.analysis_facts?.length || 0) * 1_024 +
    (cas.domain_concepts?.length || 0) * 1_024 +
    (cas.intents?.length || 0) * 768 +
    (cas.runtime_static_links?.length || 0) * 768
  );
}

function trimLoadedAnalysisCache(): void {
  const maxEntries = parsedAnalysisCacheMaxEntries();
  const maxBytes = parsedAnalysisCacheMaxBytes();
  let retainedBytes = [...loadedAnalysisCache.values()].reduce((sum, entry) => sum + entry.estimatedBytes, 0);
  while (loadedAnalysisCache.size > maxEntries || retainedBytes > maxBytes) {
    const oldestKey = loadedAnalysisCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const removed = loadedAnalysisCache.get(oldestKey);
    loadedAnalysisCache.delete(oldestKey);
    retainedBytes -= removed?.estimatedBytes || 0;
  }
}

export function clearLoadedAnalysisCache(): void {
  loadedAnalysisCache.clear();
}

export function getLoadedAnalysisCacheStats(): { entries: number; estimated_bytes: number; max_entries: number; max_bytes: number } {
  return {
    entries: loadedAnalysisCache.size,
    estimated_bytes: [...loadedAnalysisCache.values()].reduce((sum, entry) => sum + entry.estimatedBytes, 0),
    max_entries: parsedAnalysisCacheMaxEntries(),
    max_bytes: parsedAnalysisCacheMaxBytes(),
  };
}

async function rememberLoadedAnalysis(projectPath: string, filePath: string, output: CASOutput): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    const estimatedBytes = estimateParsedAnalysisBytes(output);
    loadedAnalysisCache.delete(projectPath);
    if (estimatedBytes > parsedAnalysisCacheMaxBytes()) return;
    loadedAnalysisCache.set(projectPath, { filePath, mtimeMs: stat.mtimeMs, size: stat.size, estimatedBytes, output });
    trimLoadedAnalysisCache();
  } catch {
    loadedAnalysisCache.delete(projectPath);
  }
}

async function getValidCachedAnalysis(projectPath: string, filePath: string): Promise<CASOutput | null> {
  const cached = loadedAnalysisCache.get(projectPath);
  if (!cached || cached.filePath !== filePath) return null;
  try {
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs !== cached.mtimeMs || stat.size !== cached.size) return null;
    loadedAnalysisCache.delete(projectPath);
    loadedAnalysisCache.set(projectPath, cached);
    return cached.output;
  } catch {
    return null;
  }
}

const segmentedWriteGeneration = new Map<string, number>();
const pendingSegmentedWrites = new Set<Promise<void>>();
const pendingSegmentedWriteFlushes = new Set<() => void>();
const DEFAULT_DEFERRED_SEGMENT_WRITE_DELAY_MS = 30_000;

function beginSegmentedWriteGeneration(filePath: string): number {
  const generation = (segmentedWriteGeneration.get(filePath) || 0) + 1;
  segmentedWriteGeneration.set(filePath, generation);
  return generation;
}

function isSegmentedWriteCurrent(filePath: string, generation: number): boolean {
  return segmentedWriteGeneration.get(filePath) === generation;
}

function scheduleSegmentedAnalysisWrite(filePath: string, output: CASOutput, generation: number, delayMs: number): void {
  let pending: Promise<void>;
  pending = new Promise<void>(resolve => {
    let started = false;
    let timer: NodeJS.Timeout;
    const start = () => {
      if (started) return;
      started = true;
      clearTimeout(timer);
      pendingSegmentedWriteFlushes.delete(start);
      void writeSegmentedAnalysis(
        filePath,
        output,
        compressedJsonExtension(),
        writeCompressedJsonAtomic,
        writeJsonAtomic,
        () => isSegmentedWriteCurrent(filePath, generation),
      ).catch(error => {
        console.warn(`[Klauro] deferred segmented analysis write failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(resolve);
    };
    pendingSegmentedWriteFlushes.add(start);
    timer = setTimeout(start, Math.max(0, delayMs));
  }).finally(() => pendingSegmentedWrites.delete(pending));
  pendingSegmentedWrites.add(pending);
}

export async function waitForPendingSegmentedWrites(): Promise<void> {
  for (const flush of [...pendingSegmentedWriteFlushes]) flush();
  await Promise.all([...pendingSegmentedWrites]);
}

function analysisIndexKey(projectPath: string, track: AnalysisTrack): string {
  return track === 'main' ? projectPath : `${projectPath}#${track}`;
}

export async function saveAnalysis(
  projectPath: string,
  output: CASOutput,
  track: AnalysisTrack = 'main',
  options: { deferSegmentedWrite?: boolean; segmentedWriteDelayMs?: number; writeSegmentedAnalysis?: boolean; canonicalSegmented?: boolean } = {},
): Promise<AnalysisEntry> {
  const storagePath = await ensureStorageDir();
  const fileName = `${projectSlug(projectPath)}${trackSuffix(track)}.json${compressedJsonExtension()}`;
  const filePath = path.join(storagePath, fileName);
  const layersReady = output.layers_ready;
  const hasLayerManifest = Boolean(layersReady?.layers?.length);
  const completedOutput = hasLayerManifest && layersReady?.complete === true;
  const structurallyQueryable = hasLayerManifest && (layersReady?.complete === true || STRUCTURAL_ANALYSIS_LAYERS.every(layer =>
    layersReady?.layers?.some(candidate => candidate.layer === layer && candidate.status === 'ready') === true
  ));
  const segmentsWorthWriting = structurallyQueryable && options.writeSegmentedAnalysis !== false;
  const canonicalSegmented = segmentsWorthWriting && (options.canonicalSegmented
    ?? process.env.KLAURO_CANONICAL_SEGMENTED_STORAGE !== '0');
  const canonicalProjection = prepareDeployableCasProjection(output);
  const canonicalOutput = canonicalProjection.root;
  const persistedOutput = canonicalSegmented
    ? canonicalOutput
    : completedOutput ? materializeDeployableCasTree(output) : output;
  const entry = createAnalysisIndexEntry(projectPath, fileName, persistedOutput, track, canonicalSegmented ? 'segmented-v2' : 'whole-json');
  const publishIndex = async (restoreGeneration?: () => Promise<void>) => {
    const key = analysisIndexKey(projectPath, track);
    let committed = false;
    try {
      await withIndexLock(async () => {
        const index = await loadIndex();
        index.analyses[key] = entry;
        await saveIndex(index, () => { committed = true; });
      });
    } catch (error) {
      if (restoreGeneration && !committed) await restoreGeneration();
      throw error;
    }
  };
  const segmentedGeneration = beginSegmentedWriteGeneration(filePath);
  const wholeStartedAt = Date.now();
  if (!canonicalSegmented) await writeCompressedJsonAtomic(filePath, persistedOutput, { spaces: 0 });
  const wholeMs = canonicalSegmented ? null : Date.now() - wholeStartedAt;

  const segmentedStartedAt = Date.now();
  if (segmentsWorthWriting && (canonicalSegmented || !options.deferSegmentedWrite)) {
    if (canonicalSegmented) {
      await writeSegmentedAnalysis(
        filePath,
        canonicalOutput,
        compressedJsonExtension(),
        writeCompressedJsonAtomic,
        writeJsonAtomic,
        () => isSegmentedWriteCurrent(filePath, segmentedGeneration),
        { rootOnlyTree: true, childProjections: iterateDeployableChildCas(output, canonicalProjection), subCasNodes: canonicalProjection.analysis.sub_cas_nodes, onPublished: publishIndex },
      );
      await fs.remove(filePath);
    } else {
      try {
        await writeSegmentedAnalysis(
          filePath,
          persistedOutput,
          compressedJsonExtension(),
          writeCompressedJsonAtomic,
          writeJsonAtomic,
          () => isSegmentedWriteCurrent(filePath, segmentedGeneration),
        );
      } catch (error) {
        console.warn(`[Klauro] segmented analysis write failed for ${projectPath}; authoritative analysis remains available: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const segmentedMs = Date.now() - segmentedStartedAt;

  if ((wholeMs ?? 0) + segmentedMs >= 1000) {
    process.stderr.write(`${JSON.stringify({
      event: 'analysis_save_slow',
      track,
      whole_ms: wholeMs,
      segmented_ms: segmentsWorthWriting ? segmentedMs : null,
      nodes: (canonicalOutput.nodes || []).length,
      edges: (canonicalOutput.edges || []).length,
    })}\n`);
  }

  if (track === 'main') {
    if (!canonicalSegmented) await rememberLoadedAnalysis(projectPath, filePath, persistedOutput);
  }

  if (!canonicalSegmented) await publishIndex();

  if (segmentsWorthWriting && options.deferSegmentedWrite && !canonicalSegmented) {
    scheduleSegmentedAnalysisWrite(
      filePath,
      persistedOutput,
      segmentedGeneration,
      options.segmentedWriteDelayMs ?? DEFAULT_DEFERRED_SEGMENT_WRITE_DELAY_MS,
    );
  }

  return entry;
}

export interface ResolvedAnalysisForLoad {
  entry: AnalysisEntry;
  filePath: string;
}

export async function resolveAnalysisForLoad(
  projectPath: string,
  requestedTrack?: AnalysisTrack
): Promise<ResolvedAnalysisForLoad | null> {
  const index = await loadIndex();

  const track: AnalysisTrack = requestedTrack
    ?? (index.analyses[analysisIndexKey(projectPath, 'in-flight')] ? 'in-flight' : 'main');

  const entry = index.analyses[analysisIndexKey(projectPath, track)];

  if (!entry || hasFailedStructuralAnalysisLayer(entry)) return null;

  const storagePath = getStoragePath();
  const filePath = path.join(storagePath, entry.file);
  let resolved = await resolveJsonStoragePath(filePath);

  if (!resolved && entry.storage_format !== 'whole-json' && await fs.pathExists(path.join(segmentedAnalysisRoot(filePath), 'current.json'))) resolved = filePath;

  if (!resolved && track === 'main') {
    const legacyName = `${projectSlug(projectPath)}.json${compressedJsonExtension()}`;
    resolved = await resolveJsonStoragePath(path.join(storagePath, legacyName));
  }
  return resolved ? { entry, filePath: resolved } : null;
}

async function resolveCurrentSegmentedAnalysis(
  resolved: ResolvedAnalysisForLoad,
): Promise<ResolvedSegmentedAnalysis | null> {
  let segmented: ResolvedSegmentedAnalysis | null;
  try {
    segmented = await resolveSegmentedAnalysis(resolved.filePath);
  } catch (error) {
    return segmentedReadFailureFallback(resolved.entry, resolved.filePath, error);
  }
  if (!segmented && resolved.entry.storage_format === 'segmented-v2') throw new Error(`Current segmented analysis for ${resolved.entry.path} is unavailable.`);
  if (!segmented) return null;
  if (segmented.manifest.analysis_timestamp !== resolved.entry.analyzed_at
    || (resolved.entry.analysis_id && segmented.manifest.analysis_id !== resolved.entry.analysis_id)) {
    if (resolved.entry.storage_format === 'segmented-v2') throw new Error(`Current segmented analysis for ${resolved.entry.path} does not match the analysis index.`);
    return null;
  }
  return segmented;
}

export async function acquireCurrentSegmentedAnalysisLease(
  resolved: ResolvedAnalysisForLoad,
): Promise<{ segmented: ResolvedSegmentedAnalysis; release: () => Promise<void> } | null> {
  let lease: Awaited<ReturnType<typeof acquireSegmentedAnalysisLease>>;
  try {
    lease = await acquireSegmentedAnalysisLease(resolved.filePath);
  } catch (error) {
    return segmentedReadFailureFallback(resolved.entry, resolved.filePath, error);
  }
  if (!lease && resolved.entry.storage_format === 'segmented-v2') throw new Error(`Current segmented analysis for ${resolved.entry.path} is unavailable.`);
  if (!lease) return null;
  if (lease.segmented.manifest.analysis_timestamp !== resolved.entry.analyzed_at
    || (resolved.entry.analysis_id && lease.segmented.manifest.analysis_id !== resolved.entry.analysis_id)) {
    await lease.release();
    if (resolved.entry.storage_format === 'segmented-v2') throw new Error(`Current segmented analysis for ${resolved.entry.path} does not match the analysis index.`);
    return null;
  }
  return lease;
}

export async function loadAnalysisSectionManifest(
  projectPath: string,
  options?: { track?: AnalysisTrack },
): Promise<CasSectionManifest | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, options?.track);
  if (!resolved) return null;
  const segmented = await resolveCurrentSegmentedAnalysis(resolved);
  if (segmented) return segmented.manifest;

  const legacy = await readJsonMaybeCompressed(resolved.filePath) as CASOutput;
  return createCasSectionManifest(legacy);
}

export async function loadAnalysisSections(
  projectPath: string,
  sections: readonly CasSectionName[],
  options?: { track?: AnalysisTrack; cas_id?: string; pinned?: { filePath: string; segmented: ResolvedSegmentedAnalysis } },
): Promise<Partial<CASOutput> | null> {
  const current = options?.pinned ? null : await resolveAnalysisForLoad(projectPath, options?.track);
  const resolved = options?.pinned?.filePath || current?.filePath;
  if (!resolved) return null;
  const requested = [...new Set<CasSectionName>(['identity', ...sections])];
  const cached = options?.pinned ? null : await getValidCachedAnalysis(projectPath, resolved);
  if (cached) {
    const selected = options?.cas_id ? findCasById(cached, options.cas_id) : cached;
    if (!selected) throw new Error(`Unknown CAS id '${options!.cas_id}'`);
    return selectCasSections(selected, requested);
  }
  if (!options?.pinned && current) {
    const leased = await acquireCurrentSegmentedAnalysisLease(current);
    if (leased) {
      try {
        return await loadAnalysisSections(projectPath, sections, {
          ...options,
          pinned: { filePath: resolved, segmented: leased.segmented },
        });
      } finally {
        await leased.release();
      }
    }
  }
  const segmented = options?.pinned?.segmented || null;
  if (!segmented) {
    const legacy = await readJsonMaybeCompressed(resolved) as CASOutput;
    const selected = options?.cas_id ? findCasById(legacy, options.cas_id) : legacy;
    if (!selected) throw new Error(`Unknown CAS id '${options!.cas_id}'`);
    const parts = requested.map(section => selectExactCasSection(selected, section));
    return hydrateCasSections(parts);
  }
  const projection = segmented.manifest.tree_projection;
  if (options?.cas_id && projection?.format === 'derived-deployable-references') {
    return loadLegacyProjectedCas(projection, segmented.directory, options.cas_id, requested,
      async filePath => await readJsonMaybeCompressed(filePath) as CASOutput);
  }
  const treeNode = options?.cas_id && projection?.format === 'recursive-cas-section-references'
    ? projection.nodes.find(node => node.id === options.cas_id)
    : undefined;
  if (options?.cas_id && projection?.format === 'recursive-cas-section-references' && !treeNode) throw new Error(`Unknown CAS id '${options.cas_id}'`);
  const descriptors = treeNode?.sections || segmented.manifest.sections;
  const descriptorByName = new Map(descriptors.map(section => [section.name, section]));
  const expansion = Math.max(1, Number(process.env.KLAURO_SECTION_PARSE_EXPANSION) || 24);
  const configuredBudgetMb = Number(process.env.KLAURO_SECTION_PARSE_BUDGET_MB);
  const parsedSectionBudget = Number.isFinite(configuredBudgetMb) && configuredBudgetMb > 0
    ? configuredBudgetMb * 1024 * 1024
    : getHeapStatistics().heap_size_limit / 8;
  const largestEstimatedSection = requested.reduce(
    (maximum, section) => Math.max(maximum, (descriptorByName.get(section)?.bytes || 0) * expansion),
    1,
  );
  const sectionConcurrency = Math.max(1, Math.min(4, Math.floor(parsedSectionBudget / largestEstimatedSection)));
  const memoryBoundRead = sectionConcurrency === 1;
  const readSection = pLimit(sectionConcurrency);
  const readOne = async (section: CasSectionName): Promise<Partial<CASOutput> | undefined> => readSection(async () => {
    const descriptor = descriptorByName.get(section);
    if (!descriptor) return undefined;
    if (!descriptor.file) {
      throw new Error(`Segmented CAS section '${section}' is listed in the manifest for ${resolved} but has no file recorded`);
    }
    if (path.basename(descriptor.file) !== descriptor.file) {
      throw new Error(`Segmented CAS section '${section}' has an invalid artifact path`);
    }
    const sectionPath = path.join(segmented.directory, descriptor.file);
    let sectionData: Partial<CASOutput>;
    try {
      if (descriptor.sha256) {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(sectionPath)) hash.update(chunk as Buffer);
        if (hash.digest('hex') !== descriptor.sha256) throw new Error('checksum mismatch');
      }
      sectionData = await readJsonMaybeCompressed(sectionPath, {
        maxBufferedZstdBytes: (descriptor.bytes || 0) * expansion > parsedSectionBudget ? 0 : undefined,
      }) as Partial<CASOutput>;
    } catch (error) {
      throw new Error(`Segmented CAS section '${section}' (${sectionPath}) could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (sectionData == null) {
      throw new Error(`Segmented CAS section '${section}' (${sectionPath}) is missing or empty on disk`);
    }
    return sectionData;
  });
  const parts: Partial<CASOutput>[] = [];
  if (memoryBoundRead) {
    for (const section of requested) {
      const part = await readOne(section);
      if (part) parts.push(part);
    }
  } else {
    parts.push(...(await Promise.all(requested.map(readOne))).filter((part): part is Partial<CASOutput> => Boolean(part)));
  }
  return hydrateCasSections(parts);
}

export type { LoadedAnalysisProjection } from './recursive-cas-storage';

export async function loadAnalysisProjection(
  projectPath: string,
  sections: readonly CasSectionName[],
  options?: { track?: AnalysisTrack; cas_id?: string; require_sub_cas_index?: boolean },
): Promise<LoadedAnalysisProjection | null> {
  return loadCasProjection(projectPath, sections, options,
    () => resolveAnalysisForLoad(projectPath, options?.track),
    acquireCurrentSegmentedAnalysisLease,
    loadAnalysisSections,
    async filePath => await readJsonMaybeCompressed(filePath) as CASOutput);
}

export async function loadCompactAnalysisGraph(projectPath: string): Promise<CompactCASGraph | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, 'main');
  const segmented = resolved ? await resolveCurrentSegmentedAnalysis(resolved) : null;
  return segmented ? loadCompactCASGraph(resolved!.filePath, segmented) : null;
}

export async function loadCompactAnalysisSearch(projectPath: string): Promise<LoadedCompactCASSearch | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, 'main');
  const segmented = resolved ? await resolveCurrentSegmentedAnalysis(resolved) : null;
  return segmented ? loadCompactCASSearch(resolved!.filePath, segmented) : null;
}

export async function loadCompleteAnalysisFromSections(
  projectPath: string,
  options?: { track?: AnalysisTrack; cas_id?: string },
): Promise<CASOutput | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, options?.track);
  if (!resolved) return null;
  const leased = await acquireCurrentSegmentedAnalysisLease(resolved);
  if (!leased) return options?.cas_id ? await loadAnalysisSections(projectPath, CAS_SECTION_NAMES, options) as CASOutput | null : loadAnalysis(projectPath, { ...options, preferAuthoritative: true });
  try {
    return await hydrateSegmentedCasTree(projectPath, resolved.filePath, leased.segmented, loadAnalysisSections, async filePath => await readJsonMaybeCompressed(filePath) as CASOutput, options?.track, options?.cas_id);
  } finally {
    await leased.release();
  }
}

export interface AnalysisExportArtifact {
  filePath: string;
  codec: JsonStorageCodec;
  bytes: number;
}

export async function resolveSegmentedAnalysisExportManifest(
  projectPath: string,
  options?: { track?: AnalysisTrack },
): Promise<CasSectionManifest | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, options?.track);
  if (!resolved) return null;
  return (await resolveCurrentSegmentedAnalysis(resolved))?.manifest || null;
}

export async function resolveAnalysisSectionExportArtifact(
  projectPath: string,
  section: CasSectionName,
  options?: { track?: AnalysisTrack },
): Promise<AnalysisExportArtifact | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, options?.track);
  if (!resolved) return null;
  const segmented = await resolveCurrentSegmentedAnalysis(resolved);
  const descriptor = segmented?.manifest.sections.find(item => item.name === section);
  if (!segmented || !descriptor?.file || path.basename(descriptor.file) !== descriptor.file) return null;
  const filePath = path.join(segmented.directory, descriptor.file);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  return { filePath, codec: compressionCodecForPath(filePath), bytes: stat.size };
}

export async function resolveAnalysisExportArtifact(
  projectPath: string,
  options?: { track?: AnalysisTrack },
): Promise<AnalysisExportArtifact | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, options?.track);
  if (!resolved) return null;
  const segmented = await resolveCurrentSegmentedAnalysis(resolved);
  if (segmented) {
    const exportPath = segmentedLegacyExportPath(resolved.filePath, path.basename(segmented.directory));
    const exportStat = await fs.stat(exportPath).catch(() => null);
    if (!exportStat) {
      const { runIsolatedAnalysisExport } = await import('./analysis-export-process');
      return runIsolatedAnalysisExport(projectPath, options);
    }
    return { filePath: exportPath, codec: compressionCodecForPath(exportPath), bytes: exportStat.size };
  }
  const stat = await fs.stat(resolved.filePath).catch(() => null);
  return stat ? { filePath: resolved.filePath, codec: compressionCodecForPath(resolved.filePath), bytes: stat.size } : null;
}

export async function materializeAnalysisExportArtifact(
  projectPath: string,
  options?: { track?: AnalysisTrack },
): Promise<AnalysisExportArtifact | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, options?.track);
  if (!resolved) return null;
  const lease = await acquireCurrentSegmentedAnalysisLease(resolved);
  if (lease) {
    try {
      const exportPath = segmentedLegacyExportPath(resolved.filePath, path.basename(lease.segmented.directory));
      let stat = await fs.stat(exportPath).catch(() => null);
      if (!stat) {
        await writeSegmentedLegacyExport(resolved.filePath, exportPath, lease.segmented);
        stat = await fs.stat(exportPath).catch(() => null);
      }
      return stat ? { filePath: exportPath, codec: compressionCodecForPath(exportPath), bytes: stat.size } : null;
    } finally {
      await lease.release();
    }
  }
  const stat = await fs.stat(resolved.filePath).catch(() => null);
  return stat ? { filePath: resolved.filePath, codec: compressionCodecForPath(resolved.filePath), bytes: stat.size } : null;
}

export async function getAnalysisFileFingerprint(
  projectPath: string,
  options?: { track?: AnalysisTrack }
): Promise<string | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, options?.track);
  if (!resolved) return null;
  try {
    const segmented = await resolveCurrentSegmentedAnalysis(resolved);
    const fingerprintPath = segmented
      ? path.join(segmentedAnalysisRoot(resolved.filePath), 'current.json')
      : resolved.filePath;
    const stat = await fs.stat(fingerprintPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

export async function loadAnalysis(
  projectPath: string,
  options?: { preferCache?: boolean; track?: AnalysisTrack; preferAuthoritative?: boolean }
): Promise<CASOutput | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, options?.track);
  if (!resolved) return null;

  if (options?.preferCache) {
    const cached = await getValidCachedAnalysis(projectPath, resolved.filePath);
    if (cached) return tagAnalysisVersion(cached);
    const output = await loadCompleteAnalysis(projectPath, resolved, options.track, options.preferAuthoritative);
    if (output) {
      await rememberLoadedAnalysis(projectPath, resolved.filePath, output);
    }
    return output ? tagAnalysisVersion(output) : output;
  }
  const output = await loadCompleteAnalysis(projectPath, resolved, options?.track, options?.preferAuthoritative);
  return output ? tagAnalysisVersion(output) : output;
}

async function loadCompleteAnalysis(
  projectPath: string,
  resolved: ResolvedAnalysisForLoad,
  track?: AnalysisTrack,
  preferAuthoritative = false,
): Promise<CASOutput | null> {
  const leased = preferAuthoritative && resolved.entry.storage_format !== 'segmented-v2'
    ? null
    : await acquireCurrentSegmentedAnalysisLease(resolved);
  if (leased) {
    try {
      return await hydrateSegmentedCasTree(projectPath, resolved.filePath, leased.segmented, loadAnalysisSections, async filePath => await readJsonMaybeCompressed(filePath) as CASOutput, track);
    } catch (error) {
      if (resolved.entry.storage_format === 'segmented-v2') throw error;
      console.warn(`[Klauro] segmented analysis read failed for ${projectPath}; using authoritative analysis: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await leased.release();
    }
  }
  return await readJsonMaybeCompressed(resolved.filePath) as CASOutput;
}

export async function listAnalyses(options: { scopeCwd?: string } = {}): Promise<AnalysisEntry[]> {
  const index = await loadIndex();
  const entries = Object.values(index.analyses);
  const scope = await resolveAnalysisScope({ cwd: options.scopeCwd });
  return filterEntriesToScope(entries, scope);
}

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

const INCREMENTAL_STATE_VERSION_CURRENT = '1.0.0';

export function getProjectStorageDir(projectPath: string): string {
  const storagePath = getStoragePath();
  const slug = projectSlug(projectPath);
  return path.join(storagePath, slug);
}

function incrementalStateBaseFileName(track: AnalysisTrack): string {
  return `incremental-state${trackSuffix(track)}.json`;
}

function incrementalStateFileName(track: AnalysisTrack): string {
  return `${incrementalStateBaseFileName(track)}${compressedJsonExtension()}`;
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

  await writeCompressedJsonAtomic(statePath, stateToSave);
  const basePath = path.join(projectDir, incrementalStateBaseFileName(track));
  for (const stalePath of [basePath, ...jsonStoragePathCandidates(basePath)]) {
    if (stalePath !== statePath) await fs.remove(stalePath).catch(() => undefined);
  }
}

export async function loadIncrementalState(
  projectPath: string,
  track: AnalysisTrack = 'main'
): Promise<IncrementalState | null> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const statePath = path.join(projectDir, incrementalStateBaseFileName(track));
    const resolved = await resolveJsonStoragePath(statePath);
    if (!resolved) return null;
    const state = await readJsonMaybeCompressed(resolved);

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
    const statePath = path.join(projectDir, incrementalStateBaseFileName(track));
    await Promise.all([statePath, ...jsonStoragePathCandidates(statePath)].map(candidate => fs.remove(candidate).catch(() => undefined)));
  } catch (error) {
    console.warn('Failed to delete incremental state:', error);
  }
}

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

const MAX_HISTORY_ENTRIES = 1000;

function changeHistoryDirectory(projectDir: string): string {
  return path.join(projectDir, 'change-history');
}

function changeHistoryEntryFileName(entry: ChangeHistoryEntry): string {
  const timestamp = String(entry.timestamp || new Date().toISOString()).replace(/[^0-9TZ]/g, '-');
  const identity = crypto.createHash('sha256').update(`${entry.id || ''}\0${entry.timestamp || ''}`).digest('hex').slice(0, 12);
  return `${timestamp}-${identity}.json${compressedJsonExtension()}`;
}

export async function saveChangeHistoryEntry(
  projectPath: string,
  entry: ChangeHistoryEntry
): Promise<void> {
  const projectDir = getProjectStorageDir(projectPath);
  const directory = changeHistoryDirectory(projectDir);
  await fs.ensureDir(directory);
  await writeCompressedJsonAtomic(path.join(directory, changeHistoryEntryFileName(entry)), entry);
  await compressLegacyJsonArtifact(path.join(projectDir, 'change-history.json'));
  const files = (await fs.readdir(directory))
    .filter(file => /\.json(?:\.zst|\.br)?$/.test(file))
    .sort()
    .reverse();
  await Promise.all(files.slice(MAX_HISTORY_ENTRIES).map(file => fs.remove(path.join(directory, file))));
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
    const directory = changeHistoryDirectory(projectDir);
    const history: ChangeHistoryEntry[] = [];
    if (await fs.pathExists(directory)) {
      const files = (await fs.readdir(directory))
        .filter(file => /\.json(?:\.zst|\.br)?$/.test(file))
        .sort()
        .reverse();
      for (const file of files) history.push(await readJsonMaybeCompressed(path.join(directory, file)) as ChangeHistoryEntry);
    }
    const legacyPath = await resolveJsonStoragePath(historyPath);
    if (legacyPath) {
      const legacy = await readJsonMaybeCompressed(legacyPath);
      if (Array.isArray(legacy)) history.push(...legacy);
    }
    const deduped = [...new Map(history.map(entry => [entry.id || entry.timestamp, entry])).values()]
      .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));
    let filtered = deduped;

    if (options?.since) {
      const sinceDate = new Date(options.since);
      filtered = filtered.filter(e => new Date(e.timestamp) >= sinceDate);
    }

    if (options?.until) {
      const untilDate = new Date(options.until);
      filtered = filtered.filter(e => new Date(e.timestamp) <= untilDate);
    }

    if (options?.limit && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
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
    await fs.remove(changeHistoryDirectory(projectDir));
    await Promise.all([historyPath, ...jsonStoragePathCandidates(historyPath)].map(candidate => fs.remove(candidate).catch(() => undefined)));
  } catch (error) {
    console.warn('Failed to clear change history:', error);
  }
}

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

  const current = loadedAnalysisCache.get(projectPath);
  const persistedOutput = materializeDeployableCasTree(output);
  const matchesCurrent = current && (
    current.output === output ||
    current.output.analysis_id === persistedOutput.analysis_id &&
      current.output.analysis_timestamp === persistedOutput.analysis_timestamp
  );
  if (matchesCurrent && current.filePath.endsWith(compressedJsonExtension())) {
    const tempPath = `${snapshotPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      await fs.copyFile(current.filePath, tempPath);
      await fs.rename(tempPath, snapshotPath);
    } catch (error) {
      await fs.remove(tempPath).catch(() => undefined);
      throw error;
    }
  } else {
    await writeCompressedJsonAtomic(snapshotPath, persistedOutput, { spaces: 0 });
  }

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
): Promise<Array<{ id: string; timestamp: string; saved_at: string }>> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const snapshotsDir = path.join(projectDir, 'snapshots');

    if (!(await fs.pathExists(snapshotsDir))) {
      return [];
    }

    const files = await fs.readdir(snapshotsDir);
    const snapshots: Array<{ id: string; timestamp: string; saved_at: string }> = [];

    for (const file of files) {
      if (!isAnalysisSnapshotFile(file)) {
        continue;
      }

      const id = stripJsonStorageExtension(file);
      const timestamp = decodeSnapshotTimestamp(id);
      if (timestamp) {
        const stat = await fs.stat(path.join(snapshotsDir, file));
        snapshots.push({ id, timestamp, saved_at: stat.mtime.toISOString() });
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
