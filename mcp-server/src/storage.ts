import * as fs from 'fs-extra';
import * as path from 'path';
import type {
  CASOutput,
  IncrementalState,
  FileAnalysisResult,
  ChangeHistoryEntry,
  ChangeReport,
  INCREMENTAL_STATE_VERSION,
} from '../../backend/src/types/cas.types';

const DEFAULT_STORAGE_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.unravl',
  'analyses'
);

interface AnalysisIndex {
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
}

function getStoragePath(): string {
  return process.env.UNRAVL_STORAGE_PATH || DEFAULT_STORAGE_PATH;
}

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}

async function ensureStorageDir(): Promise<string> {
  const storagePath = getStoragePath();
  await fs.ensureDir(storagePath);
  return storagePath;
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
  await fs.writeJson(indexPath, index, { spaces: 2 });
}

export async function saveAnalysis(projectPath: string, output: CASOutput): Promise<AnalysisEntry> {
  const storagePath = await ensureStorageDir();
  const slug = slugify(output.system.name || path.basename(projectPath));
  const fileName = `${slug}.json`;
  const filePath = path.join(storagePath, fileName);

  await fs.writeJson(filePath, output);

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
  };

  const index = await loadIndex();
  index.analyses[projectPath] = entry;
  await saveIndex(index);

  return entry;
}

export async function loadAnalysis(projectPath: string): Promise<CASOutput | null> {
  const index = await loadIndex();
  const entry = index.analyses[projectPath];
  if (!entry) return null;

  const storagePath = getStoragePath();
  const filePath = path.join(storagePath, entry.file);
  if (!(await fs.pathExists(filePath))) return null;

  return fs.readJson(filePath);
}

export async function listAnalyses(): Promise<AnalysisEntry[]> {
  const index = await loadIndex();
  return Object.values(index.analyses);
}

export async function getAnalysisEntry(projectPath: string): Promise<AnalysisEntry | null> {
  const index = await loadIndex();
  return index.analyses[projectPath] || null;
}

// =============================================================================
// INCREMENTAL ANALYSIS STORAGE
// =============================================================================

const INCREMENTAL_STATE_VERSION_CURRENT = '1.0.0';

function getProjectStorageDir(projectPath: string): string {
  const storagePath = getStoragePath();
  const slug = slugify(path.basename(projectPath));
  return path.join(storagePath, slug);
}

export async function saveIncrementalState(
  projectPath: string,
  state: IncrementalState
): Promise<void> {
  const projectDir = getProjectStorageDir(projectPath);
  await fs.ensureDir(projectDir);

  const statePath = path.join(projectDir, 'incremental-state.json');

  const stateToSave = {
    ...state,
    files: Object.fromEntries(
      Object.entries(state.files).map(([k, v]) => [k, v])
    ),
  };

  await fs.writeJson(statePath, stateToSave, { spaces: 2 });
}

export async function loadIncrementalState(
  projectPath: string
): Promise<IncrementalState | null> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const statePath = path.join(projectDir, 'incremental-state.json');

    if (!(await fs.pathExists(statePath))) {
      return null;
    }

    const state = await fs.readJson(statePath);

    if (state.version !== INCREMENTAL_STATE_VERSION_CURRENT) {
      console.log(
        `Incremental state version mismatch (${state.version} vs ${INCREMENTAL_STATE_VERSION_CURRENT}), discarding`
      );
      await deleteIncrementalState(projectPath);
      return null;
    }

    return state as IncrementalState;
  } catch (error) {
    console.warn('Failed to load incremental state:', error);
    return null;
  }
}

export async function deleteIncrementalState(projectPath: string): Promise<void> {
  try {
    const projectDir = getProjectStorageDir(projectPath);
    const statePath = path.join(projectDir, 'incremental-state.json');

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
  await fs.writeJson(cachePath, result);
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

  await fs.writeJson(historyPath, history, { spaces: 2 });
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

const MAX_SNAPSHOTS = 50;

export async function saveAnalysisSnapshot(
  projectPath: string,
  output: CASOutput
): Promise<string> {
  const projectDir = getProjectStorageDir(projectPath);
  const snapshotsDir = path.join(projectDir, 'snapshots');
  await fs.ensureDir(snapshotsDir);

  const timestamp = output.analysis_timestamp;
  const snapshotId = `snapshot-${timestamp.replace(/[:.]/g, '-')}`;
  const snapshotPath = path.join(snapshotsDir, `${snapshotId}.json`);

  await fs.writeJson(snapshotPath, output);

  await pruneOldSnapshots(snapshotsDir);

  return snapshotId;
}

async function pruneOldSnapshots(snapshotsDir: string): Promise<void> {
  try {
    const files = await fs.readdir(snapshotsDir);
    const snapshots = files
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (snapshots.length > MAX_SNAPSHOTS) {
      const toDelete = snapshots.slice(MAX_SNAPSHOTS);
      for (const file of toDelete) {
        await fs.remove(path.join(snapshotsDir, file));
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

    if (!(await fs.pathExists(snapshotPath))) {
      return null;
    }

    return await fs.readJson(snapshotPath);
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
    return files
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .map(f => {
        const id = f.replace('.json', '');
        const timestamp = id
          .replace('snapshot-', '')
          .replace(/-/g, (m, i) => (i < 10 ? '-' : i === 10 ? 'T' : ':'));
        return { id, timestamp };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
