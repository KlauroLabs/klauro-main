import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  CASOutput,
  IncrementalState,
  FileAnalysisResult,
  ChangeHistoryEntry,
  ChangeReport,
  INCREMENTAL_STATE_VERSION,
} from '../../backend/src/types/cas.types';
import type { RuntimeObservation } from './product';
import { mirrorArtifactsToS3 } from './s3-artifacts';

const DEFAULT_STORAGE_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.unravl',
  'analyses'
);

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

function projectSlug(projectPath: string): string {
  const base = slugify(path.basename(projectPath)) || 'project';
  const hash = crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 12);
  return `${base}-${hash}`;
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
  await writeJsonAtomic(indexPath, {
    ...index,
    version: '2.0.0',
    updated_at: new Date().toISOString(),
  });
}

async function writeJsonAtomic(filePath: string, value: unknown, options: { spaces?: number } = { spaces: 2 }): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeJson(tmpPath, value, options);
  await fs.move(tmpPath, filePath, { overwrite: true });
}

export async function saveAnalysis(projectPath: string, output: CASOutput): Promise<AnalysisEntry> {
  const storagePath = await ensureStorageDir();
  const fileName = `${projectSlug(projectPath)}.json`;
  const filePath = path.join(storagePath, fileName);

  await writeJsonAtomic(filePath, output);

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
  return { id, saved_at: savedAt, file };
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

  await writeJsonAtomic(statePath, stateToSave);
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

const MAX_SNAPSHOTS = 50;

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

export async function saveAnalysisSnapshot(
  projectPath: string,
  output: CASOutput
): Promise<string> {
  const projectDir = getProjectStorageDir(projectPath);
  const snapshotsDir = path.join(projectDir, 'snapshots');
  await fs.ensureDir(snapshotsDir);

  const timestamp = output.analysis_timestamp;
  const snapshotId = `snapshot-${encodeSnapshotTimestamp(timestamp)}`;
  const snapshotPath = path.join(snapshotsDir, `${snapshotId}.json`);

  await writeJsonAtomic(snapshotPath, output);

  await pruneOldSnapshots(snapshotsDir);

  return snapshotId;
}

async function pruneOldSnapshots(snapshotsDir: string): Promise<void> {
  try {
    const files = await fs.readdir(snapshotsDir);
    const snapshots = files
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .map(file => ({
        file,
        timestamp: decodeSnapshotTimestamp(file.replace('.json', '')) || '',
      }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (snapshots.length > MAX_SNAPSHOTS) {
      const toDelete = snapshots.slice(MAX_SNAPSHOTS);
      for (const snapshot of toDelete) {
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
    const snapshots: Array<{ id: string; timestamp: string }> = [];

    for (const file of files) {
      if (!file.startsWith('snapshot-') || !file.endsWith('.json')) {
        continue;
      }

      const id = file.replace('.json', '');
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
  index_version?: string;
  analyses: number;
  workspace_graphs: number;
  agentic_benchmark_reports: number;
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
    index_version: index.version,
    analyses: Object.keys(index.analyses).length,
    workspace_graphs: workspaceGraphs.length,
    agentic_benchmark_reports: agenticBenchmarkReports.length,
    projects,
  };
}
