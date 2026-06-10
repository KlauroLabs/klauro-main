import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { isDirectCliInvocation } from './cli-invocation';

export interface StoragePruneOptions {
  root?: string;
  repoRoot?: string;
  olderThanDays?: number;
  maxBytes?: number;
  includeLocalArtifacts?: boolean;
  includeTempArtifacts?: boolean;
  tempRoot?: string;
  includeAnalyses?: boolean;
  includeEphemeralAnalyses?: boolean;
  confirm?: boolean;
}

export interface PrunableArtifact {
  path: string;
  category: string;
  bytes: number;
  modified_at: string;
  reason: string;
  delete_paths?: string[];
  index_path?: string;
}

export interface StoragePruneReport {
  root: string;
  repo_root?: string;
  dry_run: boolean;
  include_analyses: boolean;
  include_ephemeral_analyses: boolean;
  older_than_days?: number;
  max_bytes?: number;
  scanned_categories: string[];
  candidate_count: number;
  reclaimed_bytes: number;
  candidates: PrunableArtifact[];
  deleted: string[];
}

const GENERATED_STORAGE_CATEGORIES = [
  'incremental-benchmark-workspaces',
  'agent-live-trials',
  'machine-proof-workspaces',
  'scratch-build-benchmark',
  'greenfield-live-continuity',
  'from-zero-build-packet-proof',
  'from-zero-dogfood',
];

const LOCAL_ARTIFACT_PREFIXES = [
  '.klauro-agent-',
  '.klauro-existing-task-',
  '.klauro-from-zero-',
  '.klauro-scratch-',
  '.klauro-vision-',
  '.klauro-incremental-',
];

const TEMP_ARTIFACT_PREFIXES = [
  'klauro-agent-cli-test-',
  'klauro-agent-live-trials',
  'klauro-agent-workflow-test-',
  'klauro-adjacent-greenfield-',
  'klauro-build-memory-filter-',
  'klauro-build-memory-relevance-',
  'klauro-cleanmusic-nochange-debug-',
  'klauro-domain-folder-greenfield-',
  'klauro-empty-greenfield-',
  'klauro-existing-task-benchmark-',
  'klauro-existing-task-proof-',
  'klauro-greenfield-preview-',
  'klauro-growing-greenfield-',
  'klauro-incremental-benchmark-workspaces',
  'klauro-iteration-preview-',
  'klauro-live-compact-validation-',
  'klauro-live-continuation-eval-',
  'klauro-live-eval-',
  'klauro-live-existing-compact-prompt-',
  'klauro-live-initial-validation-prompt-',
  'klauro-live-separate-workspaces-',
  'klauro-live-status-evaluator-',
  'klauro-machine-proof-workspaces',
  'klauro-preview-repo-',
  'klauro-proposal-gauntlet-',
  'klauro-remote-sync-test-',
  'klauro-rsync-debug-',
  'klauro-task-family-coverage-',
];

const EPHEMERAL_ANALYSIS_PATH_MARKERS = [
  'with-klauro',
  'without-klauro',
  'greenfield-preview',
  'benchmark',
  'proof',
  'trial',
  'scratch',
  'from-zero',
];

interface AnalysisIndex {
  version?: string;
  updated_at?: string;
  analyses?: Record<string, { file?: string; analyzed_at?: string; name?: string }>;
}

export async function pruneKlauroStorage(options: StoragePruneOptions = {}): Promise<StoragePruneReport> {
  const root = path.resolve(options.root || defaultKlauroRoot());
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : undefined;
  const includeAnalyses = Boolean(options.includeAnalyses);
  const includeEphemeralAnalyses = Boolean(options.includeEphemeralAnalyses);
  const olderThanDays = options.olderThanDays;
  const maxBytes = options.maxBytes;
  const scannedCategories = [...GENERATED_STORAGE_CATEGORIES];
  const candidates: PrunableArtifact[] = [];

  for (const category of GENERATED_STORAGE_CATEGORIES) {
    candidates.push(...await collectDirectChildArtifacts(path.join(root, category), category, options));
  }

  if (includeAnalyses) {
    scannedCategories.push('analyses/snapshots');
    candidates.push(...await collectAnalysisSnapshotArtifacts(path.join(root, 'analyses'), options));
  }

  if (includeEphemeralAnalyses) {
    scannedCategories.push('ephemeral-analyses');
    const analysesRoot = path.join(root, 'analyses');
    candidates.push(...await collectEphemeralAnalysisArtifacts(analysesRoot, root, options));
    scannedCategories.push('orphan-analysis-storage');
    candidates.push(...await collectOrphanAnalysisStorageArtifacts(analysesRoot, options));
  }

  if (options.includeLocalArtifacts && repoRoot) {
    scannedCategories.push('local-repo-artifacts');
    candidates.push(...await collectLocalRepoArtifacts(repoRoot, options));
  }

  if (options.includeTempArtifacts) {
    scannedCategories.push('temp-artifacts');
    candidates.push(...await collectTempArtifacts(options.tempRoot || os.tmpdir(), options));
  }

  const selected = selectCandidates(candidates, { olderThanDays, maxBytes });
  const deleted: string[] = [];
  const removedIndexPaths: string[] = [];
  if (options.confirm) {
    for (const artifact of selected) {
      const deletePaths = artifact.delete_paths?.length ? artifact.delete_paths : [artifact.path];
      for (const deletePath of deletePaths) {
        await fs.remove(deletePath);
        deleted.push(deletePath);
      }
      if (artifact.index_path) removedIndexPaths.push(artifact.index_path);
    }
    if (removedIndexPaths.length > 0) {
      await removeAnalysisIndexEntries(path.join(root, 'analyses'), removedIndexPaths);
    }
  }

  return {
    root,
    repo_root: repoRoot,
    dry_run: !options.confirm,
    include_analyses: includeAnalyses,
    include_ephemeral_analyses: includeEphemeralAnalyses,
    older_than_days: olderThanDays,
    max_bytes: maxBytes,
    scanned_categories: scannedCategories,
    candidate_count: selected.length,
    reclaimed_bytes: selected.reduce((sum, item) => sum + item.bytes, 0),
    candidates: selected,
    deleted,
  };
}

async function collectEphemeralAnalysisArtifacts(analysesRoot: string, klauroRoot: string, options: StoragePruneOptions): Promise<PrunableArtifact[]> {
  const indexPath = path.join(analysesRoot, 'index.json');
  if (!(await fs.pathExists(indexPath))) return [];

  const index = await fs.readJson(indexPath).catch(() => null) as AnalysisIndex | null;
  const analyses = index?.analyses || {};
  const artifacts: PrunableArtifact[] = [];

  for (const [projectPath, entry] of Object.entries(analyses)) {
    const classification = classifyEphemeralAnalysisPath(projectPath, klauroRoot, options);
    if (!classification) continue;

    const deletePaths = analysisStoragePaths(analysesRoot, projectPath, entry.file);
    const existingDeletePaths = [];
    for (const deletePath of deletePaths) {
      if (await fs.pathExists(deletePath)) existingDeletePaths.push(deletePath);
    }

    if (existingDeletePaths.length === 0) {
      artifacts.push({
        path: projectPath,
        category: 'ephemeral-analyses',
        bytes: 0,
        modified_at: entry.analyzed_at || new Date(0).toISOString(),
        reason: classification,
        delete_paths: [],
        index_path: projectPath,
      });
      continue;
    }

    const stats = await Promise.all(existingDeletePaths.map(async deletePath => ({
      path: deletePath,
      stat: await fs.stat(deletePath).catch(() => null),
    })));
    const modifiedAt = stats
      .map(item => item.stat?.mtime.toISOString())
      .filter(Boolean)
      .sort()
      .at(-1) || entry.analyzed_at || new Date(0).toISOString();

    artifacts.push({
      path: projectPath,
      category: 'ephemeral-analyses',
      bytes: await sumPaths(existingDeletePaths),
      modified_at: modifiedAt,
      reason: classification,
      delete_paths: existingDeletePaths,
      index_path: projectPath,
    });
  }

  return artifacts;
}

async function collectOrphanAnalysisStorageArtifacts(analysesRoot: string, options: StoragePruneOptions): Promise<PrunableArtifact[]> {
  const indexPath = path.join(analysesRoot, 'index.json');
  if (!(await fs.pathExists(indexPath))) return [];

  const index = await fs.readJson(indexPath).catch(() => null) as AnalysisIndex | null;
  const analyses = index?.analyses || {};
  const indexedDirs = new Set(Object.keys(analyses).map(projectPath => projectSlug(projectPath)));
  const specialDirs = new Set(['agentic-benchmarks', 'proposal-previews', 'workspace-graphs']);
  const entries = await fs.readdir(analysesRoot).catch(() => []);
  const artifacts: PrunableArtifact[] = [];

  for (const entry of entries) {
    if (indexedDirs.has(entry) || specialDirs.has(entry)) continue;
    const artifactPath = path.join(analysesRoot, entry);
    const stat = await fs.stat(artifactPath).catch(() => null);
    if (!stat?.isDirectory()) continue;
    artifacts.push(await describeArtifact(
      artifactPath,
      'orphan-analysis-storage',
      staleReason(stat, options)
    ));
  }

  return artifacts;
}

function classifyEphemeralAnalysisPath(projectPath: string, klauroRoot: string, options: StoragePruneOptions): string | null {
  const normalized = normalizeForMatch(projectPath);
  const normalizedKlauroRoot = normalizeForMatch(klauroRoot);
  const tempRoots = [
    options.tempRoot ? normalizeForMatch(options.tempRoot) : normalizeForMatch(os.tmpdir()),
    '/tmp',
    '/private/tmp',
    '/var/folders',
    '/private/var/folders',
  ];

  if (tempRoots.some(tempRoot => normalized === tempRoot || normalized.startsWith(`${tempRoot}/`))) {
    return 'analysis belongs to a Klauro temp workspace';
  }

  for (const category of GENERATED_STORAGE_CATEGORIES) {
    const generatedRoot = `${normalizedKlauroRoot}/${category}`;
    if (normalized === generatedRoot || normalized.startsWith(`${generatedRoot}/`)) {
      return `analysis belongs to generated ${category} workspace`;
    }
  }

  if (EPHEMERAL_ANALYSIS_PATH_MARKERS.some(marker => normalized.includes(marker))) {
    return 'analysis path matches generated benchmark/proof naming';
  }

  return null;
}

function normalizeForMatch(input: string): string {
  return path.resolve(input).replace(/\\/g, '/');
}

function analysisStoragePaths(analysesRoot: string, projectPath: string, fileName?: string): string[] {
  const paths = new Set<string>();
  const projectDir = path.join(analysesRoot, projectSlug(projectPath));
  paths.add(projectDir);

  if (fileName) {
    const filePath = path.join(analysesRoot, fileName);
    paths.add(filePath);
    for (const candidate of jsonStoragePathCandidates(filePath)) {
      paths.add(candidate);
    }
  }

  return Array.from(paths);
}

function jsonStoragePathCandidates(filePath: string): string[] {
  if (filePath.endsWith('.json')) return [`${filePath}.zst`, `${filePath}.br`];
  if (filePath.endsWith('.json.zst')) return [filePath.replace(/\.zst$/, ''), filePath.replace(/\.zst$/, '.br')];
  if (filePath.endsWith('.json.br')) return [filePath.replace(/\.br$/, ''), filePath.replace(/\.br$/, '.zst')];
  return [];
}

function projectSlug(projectPath: string): string {
  const base = slugify(path.basename(projectPath)) || 'project';
  const hash = crypto.createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 12);
  return `${base}-${hash}`;
}

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}

async function sumPaths(paths: string[]): Promise<number> {
  let total = 0;
  for (const item of paths) {
    total += await directorySize(item);
  }
  return total;
}

async function removeAnalysisIndexEntries(analysesRoot: string, projectPaths: string[]): Promise<void> {
  const indexPath = path.join(analysesRoot, 'index.json');
  const index = await fs.readJson(indexPath).catch(() => null) as AnalysisIndex | null;
  if (!index?.analyses) return;

  let changed = false;
  for (const projectPath of projectPaths) {
    if (projectPath in index.analyses) {
      delete index.analyses[projectPath];
      changed = true;
    }
  }

  if (!changed) return;
  await fs.writeJson(indexPath, {
    ...index,
    updated_at: new Date().toISOString(),
  }, { spaces: 2 });
}

async function collectDirectChildArtifacts(directory: string, category: string, options: StoragePruneOptions): Promise<PrunableArtifact[]> {
  if (!(await fs.pathExists(directory))) return [];
  const entries = await fs.readdir(directory);
  const artifacts: PrunableArtifact[] = [];
  for (const entry of entries) {
    const artifactPath = path.join(directory, entry);
    const stat = await fs.stat(artifactPath).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    artifacts.push(await describeArtifact(artifactPath, category, staleReason(stat, options)));
  }
  return artifacts;
}

async function collectAnalysisSnapshotArtifacts(analysesRoot: string, options: StoragePruneOptions): Promise<PrunableArtifact[]> {
  if (!(await fs.pathExists(analysesRoot))) return [];
  const analyses = await fs.readdir(analysesRoot);
  const artifacts: PrunableArtifact[] = [];
  for (const analysis of analyses) {
    const snapshotsDir = path.join(analysesRoot, analysis, 'snapshots');
    if (!(await fs.pathExists(snapshotsDir))) continue;
    const files = await fs.readdir(snapshotsDir);
    for (const file of files) {
      if (!isJsonStorageFile(file)) continue;
      const artifactPath = path.join(snapshotsDir, file);
      const stat = await fs.stat(artifactPath).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      artifacts.push(await describeArtifact(artifactPath, 'analyses/snapshots', staleReason(stat, options)));
    }
  }
  return artifacts;
}

function isJsonStorageFile(file: string): boolean {
  return file.endsWith('.json') || file.endsWith('.json.br') || file.endsWith('.json.zst');
}

async function collectLocalRepoArtifacts(repoRoot: string, options: StoragePruneOptions): Promise<PrunableArtifact[]> {
  if (!(await fs.pathExists(repoRoot))) return [];
  const entries = await fs.readdir(repoRoot);
  const artifacts: PrunableArtifact[] = [];
  for (const entry of entries) {
    if (!LOCAL_ARTIFACT_PREFIXES.some(prefix => entry.startsWith(prefix))) continue;
    const artifactPath = path.join(repoRoot, entry);
    const stat = await fs.stat(artifactPath).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    artifacts.push(await describeArtifact(artifactPath, 'local-repo-artifacts', staleReason(stat, options)));
  }
  return artifacts;
}

async function collectTempArtifacts(tempRoot: string, options: StoragePruneOptions): Promise<PrunableArtifact[]> {
  const root = path.resolve(tempRoot);
  if (!(await fs.pathExists(root))) return [];
  const entries = await fs.readdir(root);
  const artifacts: PrunableArtifact[] = [];
  for (const entry of entries) {
    if (!TEMP_ARTIFACT_PREFIXES.some(prefix => entry === prefix || entry.startsWith(prefix))) continue;
    const artifactPath = path.join(root, entry);
    const stat = await fs.stat(artifactPath).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    artifacts.push(await describeArtifact(artifactPath, 'temp-artifacts', staleReason(stat, options)));
  }
  return artifacts;
}

function selectCandidates(candidates: PrunableArtifact[], options: { olderThanDays?: number; maxBytes?: number }): PrunableArtifact[] {
  const sorted = [...candidates].sort((left, right) => {
    const modified = new Date(left.modified_at).getTime() - new Date(right.modified_at).getTime();
    return modified || right.bytes - left.bytes;
  });
  const byAge = options.olderThanDays === undefined
    ? sorted
    : sorted.filter(candidate => ageDays(candidate.modified_at) >= options.olderThanDays!);

  if (!options.maxBytes || options.maxBytes <= 0) return byAge;

  let runningBytes = sorted.reduce((sum, item) => sum + item.bytes, 0);
  const selected = new Set(byAge.map(item => item.path));
  for (const candidate of sorted) {
    if (runningBytes <= options.maxBytes) break;
    selected.add(candidate.path);
    runningBytes -= candidate.bytes;
  }
  return sorted.filter(candidate => selected.has(candidate.path));
}

async function describeArtifact(artifactPath: string, category: string, reason: string): Promise<PrunableArtifact> {
  const stat = await fs.stat(artifactPath);
  return {
    path: artifactPath,
    category,
    bytes: await directorySize(artifactPath),
    modified_at: stat.mtime.toISOString(),
    reason,
  };
}

async function directorySize(targetPath: string): Promise<number> {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  const entries = await fs.readdir(targetPath);
  let total = 0;
  for (const entry of entries) {
    total += await directorySize(path.join(targetPath, entry));
  }
  return total;
}

function staleReason(stat: fs.Stats, options: StoragePruneOptions): string {
  const days = Math.round(ageDays(stat.mtime.toISOString()) * 10) / 10;
  if (options.olderThanDays !== undefined) return `generated artifact is ${days} days old; threshold is ${options.olderThanDays}`;
  return `generated artifact is ${days} days old`;
}

function ageDays(isoTimestamp: string): number {
  return Math.max(0, (Date.now() - new Date(isoTimestamp).getTime()) / 86_400_000);
}

function defaultKlauroRoot(): string {
  return process.env.KLAURO_HOME || path.join(process.env.HOME || process.cwd(), '.klauro');
}

function parseArgs(argv: string[]): StoragePruneOptions & { outputJson?: boolean } {
  const options: StoragePruneOptions & { outputJson?: boolean } = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index]);
    else if (arg === '--repo-root') options.repoRoot = path.resolve(argv[++index]);
    else if (arg === '--older-than-days') options.olderThanDays = Number(argv[++index]);
    else if (arg === '--max-bytes') options.maxBytes = Number(argv[++index]);
    else if (arg === '--include-local-artifacts') options.includeLocalArtifacts = true;
    else if (arg === '--include-temp-artifacts') options.includeTempArtifacts = true;
    else if (arg === '--temp-root') options.tempRoot = path.resolve(argv[++index]);
    else if (arg === '--include-analyses') options.includeAnalyses = true;
    else if (arg === '--include-ephemeral-analyses') options.includeEphemeralAnalyses = true;
    else if (arg === '--confirm') options.confirm = true;
    else if (arg === '--json') options.outputJson = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return options;
}

function printHelp(): void {
  console.log([
    'Usage: npm run storage-prune -- [options]',
    '',
    'Dry-run by default. Add --confirm to delete selected generated artifacts.',
    '',
    'Options:',
    '  --root /path                 Klauro home root. Default ~/.klauro.',
    '  --repo-root /path            Repo root for local .klauro-* artifacts.',
    '  --older-than-days n          Select generated artifacts older than n days.',
    '  --max-bytes n                Also prune oldest/largest artifacts until generated storage is under n bytes.',
    '  --include-local-artifacts    Include repo-local .klauro-* benchmark directories under --repo-root.',
    '  --include-temp-artifacts     Include Klauro-generated temp proof/preview workspaces under os.tmpdir().',
    '  --temp-root /path            Override temp root for --include-temp-artifacts. Default os.tmpdir().',
    '  --include-analyses           Include analysis snapshot files. Off by default.',
    '  --include-ephemeral-analyses Include temp/proof/benchmark analysis entries and their CAS files. Off by default.',
    '  --confirm                    Delete selected artifacts.',
    '  --json                       Print JSON instead of a compact text summary.',
  ].join('\n'));
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Math.round(value * 10) / 10}${units[unit]}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await pruneKlauroStorage(args);
  if (args.outputJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.dry_run ? 'Dry run' : 'Pruned'} ${report.candidate_count} generated artifacts; ${formatBytes(report.reclaimed_bytes)} ${report.dry_run ? 'recoverable' : 'reclaimed'}.`);
  for (const candidate of report.candidates.slice(0, 30)) {
    console.log(`${formatBytes(candidate.bytes).padStart(8)} ${candidate.category} ${candidate.path}`);
  }
  if (report.candidates.length > 30) {
    console.log(`... ${report.candidates.length - 30} more`);
  }
  if (report.dry_run) {
    console.log('Add --confirm to delete these generated artifacts.');
  }
}

if (isDirectCliInvocation('storage-maintenance')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
