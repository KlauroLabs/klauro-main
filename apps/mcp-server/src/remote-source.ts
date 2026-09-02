import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadKlauroConfig, type LoadedKlauroConfig } from './klauro-config';
import { detectRemoteProvider, type RemoteProviderInfo } from './remote-provider';
import { isRegisteredManifest, isRegisteredSourceExtension } from '../../../packages/analyzer-core/src/analyzer/core/language-registry';
import { appendDerivedLocalPackageContext, appendDerivedStreamingLocalPackageContext } from './source-snapshot-package-context';
import { assertSourceTotalBytes } from './source-upload-limits';

export interface RemoteSourceFile {
  path: string;
  content: string;
  hash: string;
}


export type RemoteFileEntry = RemoteSourceFile;

export interface BranchDiffContext {
  base_branch: string;
  target_branch: string;
  base_commit?: string;
  head_commit?: string;
  changed_files: string[];
  files: RemoteFileEntry[];
}

export interface RemoteChangedFile extends RemoteSourceFile {
  status: 'added' | 'modified';
}

export interface RemoteDeletedFile {
  path: string;
  status: 'deleted';
}

export type RemoteFileChange = RemoteChangedFile | RemoteDeletedFile;

export interface SourceSnapshot {
  project_name: string;
  base_commit?: string;
  snapshot_source: 'committed-head' | 'working-tree';
  files: RemoteSourceFile[];
  manifest: SourceManifest;
}

export interface WorkingTreeChangeContext {
  project_name: string;
  base_commit?: string;
  git_diff?: string;
  changed_files: RemoteFileChange[];
  manifest: SourceManifest;
}

export interface StreamingSourceFile {
  path: string;
  hash: string;
  bytes: number;
  status?: 'added' | 'modified';
  readContent: () => Promise<string>;
}

export interface StreamingSourceSnapshotPlan {
  project_name: string;
  base_commit?: string;
  snapshot_source: 'committed-head' | 'working-tree';
  files: StreamingSourceFile[];
  manifest: SourceManifest;
}

export interface StreamingWorkingTreePlan {
  project_name: string;
  base_commit?: string;
  readGitDiff?: () => Promise<string | undefined>;
  changed_files: Array<StreamingSourceFile | RemoteDeletedFile>;
  manifest: SourceManifest;
}








export interface RepoFacts {
  contributor_count?: number;
  first_commit_at?: string;
  last_commit_at?: string;
}

export interface SourceManifest {
  generated_at: string;
  root: string;
  git_remote?: string;
  remote_provider?: RemoteProviderInfo;
  branch?: string;
  base_commit?: string;
  dirty?: boolean;
  transfer_recommendation?: SourceTransferRecommendation;
  file_count: number;
  total_bytes: number;


  snapshot_digest?: string;
  excluded_directories: string[];
  config_file?: string;
  ignore_file?: string;
  upload_mode?: string;
  repo_facts?: RepoFacts;
  policy?: {
    require_manifest_review: boolean;
    allow_dirty_tree_sync: boolean;
    send_git_diff: boolean;
    send_deleted_paths: boolean;
  };
}

export interface UploadManifestFile {
  path: string;
  bytes: number;
  hash: string;
}

export interface UploadManifestExclusion {
  path: string;
  reason: string;
}

export interface UploadManifest {
  generated_at: string;
  root: string;
  config_file?: string;
  ignore_file?: string;
  mode: 'full' | 'dirty-tree';
  branch?: string;
  commit?: string;
  dirty?: boolean;
  summary: {
    included_files: number;
    included_bytes: number;
    excluded_files: number;
    changed_files?: number;
    deleted_files?: number;
  };
  remote_provider?: RemoteProviderInfo;
  transfer_recommendation?: SourceTransferRecommendation;
  workspace_recommendation?: WorkspaceRecommendation;
  included_files: UploadManifestFile[];
  excluded: UploadManifestExclusion[];
}

export interface SourceTransferRecommendation {
  operation: 'submit_commit_analysis' | 'prepare_local_working_copy_context' | 'use_self_hosted_analyzer';
  status: 'active' | 'available' | 'fallback';
  reason: string;
  next_action?: string;
}

export interface WorkspaceCandidate {
  path: string;
  kind: 'git-repo' | 'klauro-project';
  name?: string;
  project_id?: string;
  organization_id?: string;
  remote_provider?: RemoteProviderInfo;
}

export interface WorkspaceRecommendation {
  recommended: boolean;
  reason: string;
  rule: 'workspace-cannot-contain-workspace';
  candidates: WorkspaceCandidate[];
}




export const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.klauro',
  '.klauro-agent-idiom-benchmark',
  '.klauro-agent-proof-machine',
  '.claude',
  '.codex',
  '.agents',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.vite',
  'target',
  'vendor',
  'vendors',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'env',
  '.tox',
  '.dart_tool',
  '.gradle',
  'Pods',
  'obj',
]);










export const EXCLUDED_DIRECTORY_PATTERNS: RegExp[] = [
  /^\.tmp(?:[-_.].*)?$/,
  /^dist(?:[-_.].+)?$/,



  /^build-out(-|$)/,


  /^\.?build-artifacts?$/,

  /^cmake-build-[a-z]+$/,

  /^DerivedData$/,
];







export function matchExcludedDirectoryName(name: string): { excluded: boolean; matchedPattern?: string } {
  if (EXCLUDED_DIRECTORIES.has(name)) return { excluded: true };
  const matched = EXCLUDED_DIRECTORY_PATTERNS.find(pattern => pattern.test(name));
  return matched ? { excluded: true, matchedPattern: matched.source } : { excluded: false };
}





function manifestExclusionReason(verboseReason: string): string {
  return verboseReason.startsWith('vendored-output-shape') ? 'vendored-output-shape' : 'excluded by source policy';
}

const EXCLUDED_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.npmrc',
  '.pypirc',
]);

export function isDefaultSensitiveSourceFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return EXCLUDED_FILES.has(base) || /^\.env(?:\.|$)/.test(base);
}











const EXTRA_INCLUDED_EXTENSIONS = new Set([
  '.yaml',
  '.yml',
  '.toml',
  '.ini',


  '.routes',



  '.ipynb',






  '.conf',
  '.cfg',


  '.wsdl',
  '.xsd',










  '.md',
  '.markdown',
  '.rst',
]);



















const PLATFORM_MANIFEST_BASENAMES = new Set([
  'AndroidManifest.xml',
]);

const IMPORTANT_EXTENSIONLESS = new Set([
  'Dockerfile',
  'Makefile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'artisan',





  'Caddyfile',




  'routes',








  '.klaurorc',
  '.klaurorc.json',
]);

const STREAMING_GIT_BATCH_FILES = 8;

export async function buildSourceSnapshot(projectPath: string): Promise<SourceSnapshot> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  const isGit = isGitRepository(root);
  const head = readGitHead(root);
  const dirty = isGit && head ? listGitChanges(root).length > 0 : false;
  let fellBackFromEmptyHead = false;
  if (isGit && head && dirty) {




    const headSnapshot = await buildHeadSourceSnapshot(root, loaded, head);










    if (headSnapshot.files.length > 0) return headSnapshot;
    fellBackFromEmptyHead = true;
  }
  const files: RemoteSourceFile[] = [];
  const diagnostics = newWalkDiagnostics();
  await walkConfiguredSourceFiles(root, loaded, async absolutePath => {
    const file = await readRemoteSourceFile(root, absolutePath, loaded);
    if (file) files.push(file);
  }, [], diagnostics);

  if (files.length === 0) {
    throw buildEmptySnapshotDiagnostic(root, loaded, {
      isGit,
      hasHead: Boolean(head),
      dirty,
      fellBackFromEmptyHead,
      diagnostics,
    });
  }
  await appendDerivedLocalPackageContext(root, files, hashContent);

  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: head,
    snapshot_source: 'working-tree',
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    manifest: buildManifest(root, loaded, files),
  };
}

export async function buildStreamingSourceSnapshot(projectPath: string): Promise<StreamingSourceSnapshotPlan> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  const isGit = isGitRepository(root);
  const head = readGitHead(root);
  const dirty = isGit && head ? listGitChanges(root).length > 0 : false;
  if (isGit && head && dirty) {
    const committed = await buildStreamingHeadSnapshot(root, loaded, head);
    if (committed.files.length > 0) return committed;
  }

  const files: StreamingSourceFile[] = [];
  const diagnostics = newWalkDiagnostics();
  await walkConfiguredSourceFiles(root, loaded, async absolutePath => {
    const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
    const content = await fs.readFile(absolutePath, 'utf8');
    files.push({
      path: relativePath,
      hash: hashContent(content),
      bytes: Buffer.byteLength(content, 'utf8'),
      readContent: () => fs.readFile(absolutePath, 'utf8'),
    });
  }, [], diagnostics);
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) {
    throw buildEmptySnapshotDiagnostic(root, loaded, {
      isGit,
      hasHead: Boolean(head),
      dirty,
      fellBackFromEmptyHead: Boolean(isGit && head && dirty),
      diagnostics,
    });
  }
  await appendDerivedStreamingLocalPackageContext(root, files, hashContent);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: head,
    snapshot_source: 'working-tree',
    files,
    manifest: buildManifestFromStats(root, loaded, files),
  };
}

async function buildStreamingHeadSnapshot(
  root: string,
  loaded: LoadedKlauroConfig,
  head: string,
): Promise<StreamingSourceSnapshotPlan> {
  const trackedPaths = listGitTrackedPathsAtHead(root).map(normalizeRelativePath).filter(Boolean);
  const objectSizes = readFileSizesAtRef(root, 'HEAD', trackedPaths);
  const included: string[] = [];
  for (const relativePath of trackedPaths) {
    const size = objectSizes.get(relativePath);
    if (size !== undefined && await shouldIncludeRelativePath(root, relativePath, loaded, size)) included.push(relativePath);
  }

  const files: StreamingSourceFile[] = [];
  for (let offset = 0; offset < included.length; offset += STREAMING_GIT_BATCH_FILES) {
    const batch = included.slice(offset, offset + STREAMING_GIT_BATCH_FILES);
    const contents = readFilesAtRef(root, 'HEAD', batch);
    for (const relativePath of batch) {
      const content = contents.get(relativePath);
      if (content === undefined) continue;
      files.push({
        path: relativePath,
        hash: hashContent(content),
        bytes: Buffer.byteLength(content, 'utf8'),
        readContent: async () => {
          const current = readFileAtRef(root, 'HEAD', relativePath);
          if (current === null) throw new Error(`Unable to reread ${relativePath} from committed HEAD during upload`);
          return current;
        },
      });
    }
  }
  await appendDerivedStreamingLocalPackageContext(root, files, hashContent);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: head,
    snapshot_source: 'committed-head',
    files,
    manifest: buildManifestFromStats(root, loaded, files),
  };
}





interface WalkDiagnostics {
  candidatesBeforeIgnores: number;
  candidatesAfterIgnores: number;
  exclusionCounts: Map<string, number>;
}

function newWalkDiagnostics(): WalkDiagnostics {
  return { candidatesBeforeIgnores: 0, candidatesAfterIgnores: 0, exclusionCounts: new Map() };
}

function recordExclusion(diagnostics: WalkDiagnostics | undefined, key: string): void {
  if (!diagnostics) return;
  diagnostics.exclusionCounts.set(key, (diagnostics.exclusionCounts.get(key) || 0) + 1);
}

function topExclusions(diagnostics: WalkDiagnostics, limit = 3): Array<[string, number]> {
  return Array.from(diagnostics.exclusionCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
}

function buildEmptySnapshotDiagnostic(
  root: string,
  loaded: LoadedKlauroConfig,
  info: { isGit: boolean; hasHead: boolean; dirty: boolean; fellBackFromEmptyHead: boolean; diagnostics: WalkDiagnostics }
): Error {
  const { diagnostics } = info;
  const lines: string[] = [];
  lines.push(`Remote analyze requires a source snapshot with files, but the snapshot built for "${root}" is empty. Here is exactly what was checked:`);


  let modeLine: string;
  if (!info.isGit) {
    modeLine = 'snapshot mode: working-tree (not a git repository, so there is no committed HEAD to prefer)';
  } else if (!info.hasHead) {
    modeLine = 'snapshot mode: working-tree (git repository has no HEAD commit yet)';
  } else if (!info.dirty) {
    modeLine = 'snapshot mode: working-tree (working tree is clean, so it matches HEAD)';
  } else if (info.fellBackFromEmptyHead) {
    modeLine = 'snapshot mode: working-tree (working tree is dirty; the committed-HEAD snapshot was tried first but had 0 tracked files under this path, so it fell back to the working tree)';
  } else {
    modeLine = 'snapshot mode: working-tree';
  }
  lines.push(`  - ${modeLine}`);

  if (info.isGit && info.hasHead) {
    const headCount = listGitTrackedPathsAtHead(root).length;
    lines.push(`  - committed-HEAD tracked-file count under this path: ${headCount}`);
  }

  lines.push(`  - working-tree candidates BEFORE ignores: ${diagnostics.candidatesBeforeIgnores}`);
  lines.push(`  - working-tree candidates AFTER ignores: ${diagnostics.candidatesAfterIgnores}`);

  const ignoreSources: string[] = [];
  if (loaded.ignorePath) ignoreSources.push(`.klauroignore (${loaded.ignorePath})`);
  if ((loaded.config.source.exclude || []).length > 0) ignoreSources.push('.klaurorc source.exclude');
  ignoreSources.push('default directory/file exclusions (node_modules, .git, dist, .env*, etc.)');
  lines.push(`  - ignore sources in effect: ${ignoreSources.join(', ')}`);

  const top = topExclusions(diagnostics);
  if (top.length > 0) {
    lines.push('  - top exclusion reasons:');
    for (const [reason, count] of top) {
      lines.push(`      ${reason}: ${count} file(s)`);
    }
  }

  lines.push('');
  if (diagnostics.candidatesBeforeIgnores === 0) {
    lines.push(`NEXT STEP: no files were found under "${root}" at all (before any ignore rule was applied). Check that this is the right path — an empty or wrong directory is the likely cause.`);
  } else if (diagnostics.candidatesAfterIgnores === 0) {
    const [topReason] = top;
    const hint = topReason ? ` (top excluder: ${topReason[0]}, ${topReason[1]} file(s))` : '';
    lines.push(`NEXT STEP: ${diagnostics.candidatesBeforeIgnores} file(s) were found, but every one was excluded${hint}. Loosen .klauroignore or .klaurorc source.exclude, or verify source.include covers your files.`);
  } else if (info.fellBackFromEmptyHead) {
    lines.push('NEXT STEP: this should not happen — the working-tree fallback exists specifically to avoid an empty snapshot. Please report this as a Klauro bug with this error text.');
  } else {
    lines.push('NEXT STEP: Klauro analyzes your working tree — an empty result here is unexpected. Please report this as a Klauro bug with this error text.');
  }

  return new Error(lines.join('\n'));
}










export async function buildHeadSourceSnapshot(
  projectPath: string,
  preloadedConfig?: LoadedKlauroConfig,
  headOverride?: string
): Promise<SourceSnapshot> {
  const root = path.resolve(projectPath);
  const loaded = preloadedConfig ?? await loadKlauroConfig(root);
  const head = headOverride ?? readGitHead(root);
  if (!head) {
    throw new Error('Cannot build a committed-HEAD snapshot: this repository has no HEAD commit.');
  }
  const trackedPaths = listGitTrackedPathsAtHead(root)
    .map(normalizeRelativePath)
    .filter(Boolean);
  const objectSizes = readFileSizesAtRef(root, 'HEAD', trackedPaths);
  const includedPaths: string[] = [];
  for (const normalized of trackedPaths) {
    const byteSize = objectSizes.get(normalized);
    if (byteSize === undefined) continue;
    if (await shouldIncludeRelativePath(root, normalized, loaded, byteSize)) {
      includedPaths.push(normalized);
    }
  }
  const contents = readFilesAtRef(root, 'HEAD', includedPaths);
  const files: RemoteSourceFile[] = [];
  for (const normalized of includedPaths) {
    const content = contents.get(normalized);
    if (content == null) continue;
    files.push({ path: normalized, content, hash: hashContent(content) });
  }
  await appendDerivedLocalPackageContext(root, files, hashContent);

  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: head,
    snapshot_source: 'committed-head',
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    manifest: buildManifest(root, loaded, files),
  };
}

export async function buildWorkingTreeChangeContext(projectPath: string): Promise<WorkingTreeChangeContext> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  if (!loaded.config.upload.allowDirtyTreeSync) {
    throw new Error('Dirty-tree sync is disabled by .klaurorc upload.allowDirtyTreeSync=false');
  }
  const changes = listGitChanges(root);
  const changedFiles: RemoteFileChange[] = [];

  for (const change of changes) {
    const absolutePath = safeJoin(root, change.path);
    if (!absolutePath || !(await shouldIncludeRelativePath(root, change.path, loaded))) continue;

    if (change.status === 'deleted') {
      if (!loaded.config.upload.sendDeletedPaths) continue;
      changedFiles.push({ path: normalizeRelativePath(change.path), status: 'deleted' });
      continue;
    }
    if (loaded.config.policy.blockUntrackedFiles && change.status === 'added') continue;

    const file = await readRemoteSourceFile(root, absolutePath, loaded);
    if (file) changedFiles.push({ ...file, status: change.status });
  }

  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: readGitHead(root),
    git_diff: loaded.config.upload.sendGitDiff ? readGitDiff(root) : undefined,
    changed_files: changedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    manifest: buildManifest(root, loaded, changedFiles.filter((file): file is RemoteChangedFile => file.status !== 'deleted'), 'dirty-tree'),
  };
}

export async function buildStreamingWorkingTreeChanges(projectPath: string): Promise<StreamingWorkingTreePlan> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  if (!loaded.config.upload.allowDirtyTreeSync) {
    throw new Error('Dirty-tree sync is disabled by .klaurorc upload.allowDirtyTreeSync=false');
  }
  const changedFiles: Array<StreamingSourceFile | RemoteDeletedFile> = [];
  for (const change of listGitChanges(root)) {
    const normalized = normalizeRelativePath(change.path);
    const absolutePath = safeJoin(root, normalized);
    if (!absolutePath || !await shouldIncludeRelativePath(root, normalized, loaded)) continue;
    if (change.status === 'deleted') {
      if (loaded.config.upload.sendDeletedPaths) changedFiles.push({ path: normalized, status: 'deleted' });
      continue;
    }
    if (loaded.config.policy.blockUntrackedFiles && change.status === 'added') continue;
    const content = await fs.readFile(absolutePath, 'utf8');
    changedFiles.push({
      path: normalized,
      status: change.status,
      hash: hashContent(content),
      bytes: Buffer.byteLength(content, 'utf8'),
      readContent: () => fs.readFile(absolutePath, 'utf8'),
    });
  }
  changedFiles.sort((left, right) => left.path.localeCompare(right.path));
  const sourceFiles = changedFiles.filter((file): file is StreamingSourceFile => file.status !== 'deleted');
  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: readGitHead(root),
    readGitDiff: loaded.config.upload.sendGitDiff ? async () => readGitDiff(root) : undefined,
    changed_files: changedFiles,
    manifest: buildManifestFromStats(root, loaded, sourceFiles, 'dirty-tree'),
  };
}








export async function buildBranchDiffContext(
  projectPath: string,
  targetBranch: string,
  baseBranch?: string
): Promise<BranchDiffContext> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  const resolvedBase = baseBranch || detectDefaultBranch(root) || 'main';
  const baseCommit = readMergeBase(root, resolvedBase, targetBranch);
  const headCommit = readRevParse(root, targetBranch);
  const range = baseCommit ? `${baseCommit}..${targetBranch}` : targetBranch;

  const changedFiles: string[] = [];
  const files: RemoteFileEntry[] = [];
  for (const change of listBranchDiff(root, range)) {
    const normalized = normalizeRelativePath(change.path);


    const content = readFileAtRef(root, targetBranch, normalized);
    if (content == null) continue;
    const byteSize = Buffer.byteLength(content, 'utf8');
    if (!(await shouldIncludeRelativePath(root, normalized, loaded, byteSize))) continue;
    changedFiles.push(normalized);
    files.push({ path: normalized, content, hash: hashContent(content) });
  }

  return {
    base_branch: resolvedBase,
    target_branch: targetBranch,
    base_commit: baseCommit,
    head_commit: headCommit,
    changed_files: changedFiles.sort((left, right) => left.localeCompare(right)),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export async function buildUploadManifest(projectPath: string, mode: 'full' | 'dirty-tree' = 'full'): Promise<UploadManifest> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  const included: UploadManifestFile[] = [];
  const excluded: UploadManifestExclusion[] = [];

  if (mode === 'dirty-tree') {
    for (const change of listGitChanges(root)) {
      const normalized = normalizeRelativePath(change.path);
      const absolutePath = safeJoin(root, normalized);
      if (!absolutePath) {
        excluded.push({ path: normalized, reason: 'unsafe path' });
        continue;
      }
      const verdict = await shouldIncludeRelativePathVerbose(root, normalized, loaded);
      if (!verdict.included) {
        excluded.push({ path: normalized, reason: manifestExclusionReason(verdict.reason) });
        continue;
      }
      if (change.status === 'deleted') continue;
      const stat = await fs.stat(absolutePath);
      const content = await fs.readFile(absolutePath, 'utf8');
      included.push({ path: normalized, bytes: stat.size, hash: hashContent(content) });
    }
  } else {
    await walkConfiguredSourceFiles(root, loaded, async absolutePath => {
      const normalized = normalizeRelativePath(path.relative(root, absolutePath));
      const verdict = await shouldIncludeRelativePathVerbose(root, normalized, loaded);
      if (verdict.included) {
        const stat = await fs.stat(absolutePath);
        const content = await fs.readFile(absolutePath, 'utf8');
        included.push({ path: normalized, bytes: stat.size, hash: hashContent(content) });
      } else {
        excluded.push({ path: normalized, reason: manifestExclusionReason(verdict.reason) });
      }
    }, excluded);
  }

  const changes = mode === 'dirty-tree' ? listGitChanges(root) : [];
  const remoteProvider = detectRemoteProvider(readGitRemote(root));
  const transferRecommendation = recommendTransfer(loaded, remoteProvider, mode);
  const workspaceRecommendation = await detectWorkspaceRecommendation(root);
  return {
    generated_at: new Date().toISOString(),
    root,
    config_file: loaded.configPath,
    ignore_file: loaded.ignorePath,
    mode,
    branch: readGitBranch(root),
    commit: readGitHead(root),
    dirty: listGitChanges(root).length > 0,
    summary: {
      included_files: included.length,
      included_bytes: included.reduce((sum, file) => sum + file.bytes, 0),
      excluded_files: excluded.length,
      changed_files: mode === 'dirty-tree' ? changes.filter(change => change.status !== 'deleted').length : undefined,
      deleted_files: mode === 'dirty-tree' ? changes.filter(change => change.status === 'deleted').length : undefined,
    },
    remote_provider: remoteProvider,
    transfer_recommendation: transferRecommendation,
    workspace_recommendation: workspaceRecommendation,
    included_files: included.sort((left, right) => left.path.localeCompare(right.path)),
    excluded: excluded.sort((left, right) => left.path.localeCompare(right.path)).slice(0, 500),
  };
}

export async function detectWorkspaceRecommendation(root: string): Promise<WorkspaceRecommendation | undefined> {
  const candidates: WorkspaceCandidate[] = [];
  await walkWorkspaceCandidates(root, root, candidates, 0);
  if (candidates.length === 0) return undefined;
  return {
    recommended: candidates.length > 1,
    reason: candidates.length > 1
      ? 'Multiple child Git repositories or Klauro project configs were found. Initialize this folder as a workspace and attach each child project instead of merging them into one project analysis.'
      : 'A child Git repository or Klauro project config was found. If this folder is meant to group projects, initialize it as a workspace; otherwise initialize inside the child project.',
    rule: 'workspace-cannot-contain-workspace',
    candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function walkWorkspaceCandidates(
  root: string,
  currentDirectory: string,
  candidates: WorkspaceCandidate[],
  depth: number
): Promise<void> {
  if (depth > 5 || candidates.length >= 100) return;
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  const isRoot = currentDirectory === root;
  const names = new Set(entries.map(entry => entry.name));
  if (!isRoot && names.has('.git')) {
    candidates.push({
      path: normalizeRelativePath(path.relative(root, currentDirectory)),
      kind: 'git-repo',
      name: path.basename(currentDirectory),
      remote_provider: detectRemoteProvider(readGitRemote(currentDirectory)),
    });
    return;
  }

  const configName = names.has('.klaurorc') ? '.klaurorc' : names.has('.klaurorc.json') ? '.klaurorc.json' : undefined;
  if (!isRoot && configName) {
    candidates.push(await readKlauroProjectCandidate(root, currentDirectory, configName));
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    await walkWorkspaceCandidates(root, path.join(currentDirectory, entry.name), candidates, depth + 1);
  }
}

async function readKlauroProjectCandidate(root: string, directory: string, configName: string): Promise<WorkspaceCandidate> {
  const candidate: WorkspaceCandidate = {
    path: normalizeRelativePath(path.relative(root, directory)),
    kind: 'klauro-project',
    name: path.basename(directory),
    remote_provider: detectRemoteProvider(readGitRemote(directory)),
  };
  try {
    const raw = await fs.readFile(path.join(directory, configName), 'utf8');
    const parsed = JSON.parse(raw);
    candidate.name = parsed?.project?.name || candidate.name;
    candidate.project_id = parsed?.project?.id;
    candidate.organization_id = parsed?.project?.organizationId;
  } catch {

  }
  return candidate;
}

async function walkConfiguredSourceFiles(
  root: string,
  loaded: LoadedKlauroConfig,
  visit: (absolutePath: string) => Promise<void>,
  exclusions: UploadManifestExclusion[] = [],
  diagnostics?: WalkDiagnostics
): Promise<void> {
  for (const sourceRoot of loaded.config.source.roots || ['.']) {
    const absoluteRoot = safeJoin(root, sourceRoot);
    if (!absoluteRoot) {
      exclusions.push({ path: sourceRoot, reason: 'unsafe source root' });
      continue;
    }
    await walkSourceFiles(root, absoluteRoot, loaded, visit, exclusions, diagnostics);
  }
}

async function walkSourceFiles(
  root: string,
  currentDirectory: string,
  loaded: LoadedKlauroConfig,
  visit: (absolutePath: string) => Promise<void>,
  exclusions: UploadManifestExclusion[],
  diagnostics?: WalkDiagnostics
): Promise<void> {
  const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
    if (entry.isSymbolicLink() && !loaded.config.source.followSymlinks) {
      exclusions.push({ path: relativePath, reason: 'symlink excluded' });
      recordExclusion(diagnostics, 'symlink excluded');
      continue;
    }
    if (entry.isDirectory()) {
      const dirMatch = matchExcludedDirectoryName(entry.name);
      if (dirMatch.excluded) {
        const reason = dirMatch.matchedPattern ? 'vendored-output-shape' : 'default directory exclusion';
        exclusions.push({ path: `${relativePath}/`, reason });
        recordExclusion(
          diagnostics,
          dirMatch.matchedPattern
            ? `vendored-output-shape pattern "${dirMatch.matchedPattern}": ${entry.name}/`
            : `default directory exclusion: ${entry.name}/`
        );
        continue;
      }
    }
    if (entry.isDirectory()) {
      const matchedDirPattern = findMatchingPattern(relativePath, allExcludePatterns(loaded));
      if (matchedDirPattern) {
        exclusions.push({ path: `${relativePath}/`, reason: 'excluded by pattern' });
        recordExclusion(diagnostics, `.klauroignore/source.exclude pattern "${matchedDirPattern}"`);
        continue;
      }
    }
    if (entry.isDirectory()) {
      await walkSourceFiles(root, absolutePath, loaded, visit, exclusions, diagnostics);
    } else if (entry.isFile()) {
      if (diagnostics) diagnostics.candidatesBeforeIgnores++;
      const verbose = await shouldIncludeRelativePathVerbose(root, relativePath, loaded);
      if (verbose.included) {
        if (diagnostics) diagnostics.candidatesAfterIgnores++;
        await visit(absolutePath);
      } else {
        exclusions.push({ path: relativePath, reason: 'excluded by source policy' });
        recordExclusion(diagnostics, verbose.reason);
      }
    }
  }
}

async function readRemoteSourceFile(root: string, absolutePath: string, loaded: LoadedKlauroConfig): Promise<RemoteSourceFile | null> {
  const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
  if (!(await shouldIncludeRelativePath(root, relativePath, loaded))) return null;
  const content = await fs.readFile(absolutePath, 'utf8');
  return {
    path: relativePath,
    content,
    hash: hashContent(content),
  };
}

async function shouldIncludeRelativePath(
  root: string,
  relativePath: string,
  loaded: LoadedKlauroConfig,



  sizeOverride?: number
): Promise<boolean> {
  return (await shouldIncludeRelativePathVerbose(root, relativePath, loaded, sizeOverride)).included;
}

type IncludeVerdict = { included: true } | { included: false; reason: string };








async function shouldIncludeRelativePathVerbose(
  root: string,
  relativePath: string,
  loaded: LoadedKlauroConfig,
  sizeOverride?: number
): Promise<IncludeVerdict> {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    return { included: false, reason: 'unsafe path (outside project root)' };
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    const dirMatch = matchExcludedDirectoryName(part);
    if (dirMatch.excluded) {
      return dirMatch.matchedPattern
        ? { included: false, reason: `vendored-output-shape pattern "${dirMatch.matchedPattern}": ${part}/` }
        : { included: false, reason: `default directory exclusion: ${part}/` };
    }
  }
  const base = parts[parts.length - 1];
  if (isDefaultSensitiveSourceFile(base)) return { included: false, reason: `default file exclusion: ${base}` };
  if (/^\.env\./.test(base)) return { included: false, reason: 'default file exclusion: .env.*' };
  if (/\.lockb$/.test(base)) return { included: false, reason: 'default file exclusion: *.lockb' };

  const matchedIgnorePattern = findMatchingPattern(normalized, loaded.ignorePatterns || []);
  if (matchedIgnorePattern) return { included: false, reason: `.klauroignore pattern "${matchedIgnorePattern}"` };
  const matchedExcludePattern = findMatchingPattern(normalized, loaded.config.source.exclude || []);
  if (matchedExcludePattern) return { included: false, reason: `.klaurorc source.exclude pattern "${matchedExcludePattern}"` };

  if (!patternListMatches(normalized, loaded.config.source.include || ['**/*'])) {
    return { included: false, reason: 'not matched by .klaurorc source.include patterns' };
  }

  if (sizeOverride != null) {
    if (loaded.config.source.maxFileBytes > 0 && sizeOverride > loaded.config.source.maxFileBytes) return { included: false, reason: 'file exceeds source.maxFileBytes' };
  } else {
    try {
      const stat = await fs.stat(path.join(root, normalized));
      if (loaded.config.source.maxFileBytes > 0 && stat.size > loaded.config.source.maxFileBytes) return { included: false, reason: 'file exceeds source.maxFileBytes' };
    } catch {
      return { included: false, reason: 'file not readable (stat failed)' };
    }
  }





  if (isRegisteredSourceExtension(base) || isRegisteredManifest(base) || IMPORTANT_EXTENSIONLESS.has(base) || PLATFORM_MANIFEST_BASENAMES.has(base)) {
    return { included: true };
  }
  const ext = base.slice(base.lastIndexOf('.'));
  if (EXTRA_INCLUDED_EXTENSIONS.has(ext)) return { included: true };
  return { included: false, reason: 'not a registered source/manifest file type' };
}



function listGitTrackedPathsAtHead(root: string): string[] {
  try {
    const output = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function listGitChanges(root: string): Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> {
  try {
    const output = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const entries = output.split('\0').filter(Boolean);
    const changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const code = entry.slice(0, 2);
      let filePath = entry.slice(3);
      if (code.includes('R') || code.includes('C')) {
        const newPath = entries[++i];
        if (newPath) filePath = newPath;
      }
      const status = code.includes('D') ? 'deleted' : code.includes('?') || code.includes('A') ? 'added' : 'modified';
      changes.push({ path: filePath, status });
    }
    return changes;
  } catch {
    return [];
  }
}




function listBranchDiff(root: string, range: string): Array<{ path: string; status: 'added' | 'modified' }> {
  try {
    const output = execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', range], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const fields = output.split('\0').filter(Boolean);
    const changes: Array<{ path: string; status: 'added' | 'modified' }> = [];
    for (let i = 0; i < fields.length; i++) {
      const code = fields[i];


      if (/^[RC]\d*$/.test(code)) {
        i += 1;
        const newPath = fields[++i];
        if (newPath) changes.push({ path: newPath, status: 'modified' });
        continue;
      }
      const filePath = fields[++i];
      if (!filePath) continue;
      if (code.startsWith('D')) continue;
      changes.push({ path: filePath, status: code.startsWith('A') ? 'added' : 'modified' });
    }
    return changes;
  } catch {
    return [];
  }
}

function readMergeBase(root: string, baseRef: string, targetRef: string): string | undefined {
  try {
    return execFileSync('git', ['merge-base', baseRef, targetRef], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readRevParse(root: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', ref], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readFileAtRef(root: string, ref: string, relativePath: string): string | null {
  try {










    return execFileSync('git', ['show', `${ref}:./${relativePath}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function readFileSizesAtRef(root: string, ref: string, relativePaths: string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  if (relativePaths.length === 0) return sizes;
  const input = relativePaths.map(relativePath => `${ref}:./${relativePath}`).join('\n') + '\n';
  const result = spawnSync('git', ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], {
    cwd: root,
    input,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return sizes;
  const lines = result.stdout.trimEnd().split('\n');
  for (let index = 0; index < relativePaths.length; index += 1) {
    const match = /^(\S+)\s+(\d+)$/.exec(lines[index] || '');
    if (match?.[1] === 'blob') sizes.set(relativePaths[index], Number(match[2]));
  }
  return sizes;
}

function readFilesAtRef(root: string, ref: string, relativePaths: string[]): Map<string, string> {
  const contents = new Map<string, string>();
  if (relativePaths.length === 0) return contents;
  const input = relativePaths.map(relativePath => `${ref}:./${relativePath}`).join('\n') + '\n';
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input,
    encoding: null,
    maxBuffer: 1024 * 1024 * 512,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return contents;

  const output = result.stdout;
  let offset = 0;
  for (const relativePath of relativePaths) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) break;
    const header = output.subarray(offset, headerEnd).toString('utf8');
    offset = headerEnd + 1;
    const match = /^[0-9a-f]+\s+blob\s+(\d+)$/.exec(header);
    if (!match) continue;
    const byteSize = Number(match[1]);
    const end = offset + byteSize;
    if (!Number.isSafeInteger(byteSize) || end > output.length) break;
    contents.set(relativePath, output.subarray(offset, end).toString('utf8'));
    offset = end + (output[end] === 0x0a ? 1 : 0);
  }
  return contents;
}



function detectDefaultBranch(root: string): string | undefined {
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (ref) return ref.replace(/^origin\//, '');
  } catch {

  }
  for (const candidate of ['main', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', candidate], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return candidate;
    } catch {

    }
  }
  return undefined;
}

function readGitHead(root: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function isGitRepository(root: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
  } catch {
    return false;
  }
}

function readGitBranch(root: string): string | undefined {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readGitRemote(root: string): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readGitDiff(root: string): string | undefined {
  try {
    return execFileSync('git', ['diff', '--no-ext-diff', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

export function sourceSnapshotDigest(files: Array<{ path?: string; content: string; hash?: string }>): string {
  const digest = crypto.createHash('sha256');
  const ordered = [...files].sort((left, right) => (left.path || '').localeCompare(right.path || ''));
  for (const file of ordered) {
    digest.update(file.path || '');
    digest.update('\0');
    digest.update(file.hash || hashContent(file.content));
    digest.update('\0');
  }
  return digest.digest('hex');
}


function buildManifest(
  root: string,
  loaded: LoadedKlauroConfig,
  files: Array<{ path?: string; content: string; hash?: string }>,
  mode: 'full' | 'dirty-tree' = 'full',
): SourceManifest {
  const gitRemote = readGitRemote(root);
  const remoteProvider = detectRemoteProvider(gitRemote);
  return {
    generated_at: new Date().toISOString(),
    root,
    git_remote: gitRemote,
    remote_provider: remoteProvider,
    branch: readGitBranch(root),
    base_commit: readGitHead(root),
    dirty: listGitChanges(root).length > 0,
    transfer_recommendation: recommendTransfer(loaded, remoteProvider, mode),
    file_count: files.length,
    total_bytes: assertSourceTotalBytes(loaded, files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0)),
    snapshot_digest: sourceSnapshotDigest(files),
    excluded_directories: Array.from(EXCLUDED_DIRECTORIES).sort(),
    config_file: loaded.configPath,
    ignore_file: loaded.ignorePath,
    upload_mode: loaded.config.upload.mode,
    repo_facts: deriveRepoFacts(root),
    policy: {
      require_manifest_review: loaded.config.upload.requireManifestReview,
      allow_dirty_tree_sync: loaded.config.upload.allowDirtyTreeSync,
      send_git_diff: loaded.config.upload.sendGitDiff,
      send_deleted_paths: loaded.config.upload.sendDeletedPaths,
    },
  };
}

function buildManifestFromStats(
  root: string,
  loaded: LoadedKlauroConfig,
  files: Array<{ path: string; hash: string; bytes: number }>,
  mode: 'full' | 'dirty-tree' = 'full',
): SourceManifest {
  const gitRemote = readGitRemote(root);
  const remoteProvider = detectRemoteProvider(gitRemote);
  return {
    generated_at: new Date().toISOString(),
    root,
    git_remote: gitRemote,
    remote_provider: remoteProvider,
    branch: readGitBranch(root),
    base_commit: readGitHead(root),
    dirty: listGitChanges(root).length > 0,
    transfer_recommendation: recommendTransfer(loaded, remoteProvider, mode),
    file_count: files.length,
    total_bytes: assertSourceTotalBytes(loaded, files.reduce((sum, file) => sum + file.bytes, 0)),
    snapshot_digest: sourceSnapshotDigest(files.map(file => ({ path: file.path, hash: file.hash, content: '' }))),
    excluded_directories: Array.from(EXCLUDED_DIRECTORIES).sort(),
    config_file: loaded.configPath,
    ignore_file: loaded.ignorePath,
    upload_mode: loaded.config.upload.mode,
    repo_facts: deriveRepoFacts(root),
    policy: {
      require_manifest_review: loaded.config.upload.requireManifestReview,
      allow_dirty_tree_sync: loaded.config.upload.allowDirtyTreeSync,
      send_git_diff: loaded.config.upload.sendGitDiff,
      send_deleted_paths: loaded.config.upload.sendDeletedPaths,
    },
  };
}





const REPO_FACTS_GIT_TIMEOUT_MS = 3000;










function deriveRepoFacts(root: string): RepoFacts | undefined {
  if (!isGitRepository(root)) return undefined;
  const head = readGitHead(root);
  if (!head) return undefined;

  const facts: RepoFacts = {};

  try {
    const shortlog = execFileSync('git', ['shortlog', '-sn', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: REPO_FACTS_GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 4,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const contributorCount = shortlog.split('\n').filter(line => line.trim().length > 0).length;
    if (contributorCount > 0) facts.contributor_count = contributorCount;
  } catch {

  }

  const firstCommitAt = readFirstCommitAt(root);
  const lastCommitAt = readLastCommitAt(root);
  const commitCount = readCommitCount(root);










  const timestampsCollapsed = !!firstCommitAt && !!lastCommitAt && firstCommitAt === lastCommitAt;
  const knownMultiCommit = typeof commitCount === 'number' && commitCount > 1;
  if (!(timestampsCollapsed && knownMultiCommit)) {
    if (firstCommitAt) facts.first_commit_at = firstCommitAt;
    if (lastCommitAt) facts.last_commit_at = lastCommitAt;
  }

  return Object.keys(facts).length > 0 ? facts : undefined;
}

function readLastCommitAt(root: string): string | undefined {
  try {
    return execFileSync('git', ['log', '-1', '--format=%aI', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: REPO_FACTS_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readCommitCount(root: string): number | undefined {
  try {
    const raw = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: REPO_FACTS_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const count = Number(raw);
    return Number.isFinite(count) && count >= 0 ? count : undefined;
  } catch {
    return undefined;
  }
}












function readFirstCommitAt(root: string): string | undefined {
  try {
    const rootShas = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: REPO_FACTS_GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 4,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').filter(sha => sha.length > 0);
    if (rootShas.length === 0) return undefined;

    const dates = rootShas
      .map(sha => {
        try {
          return execFileSync('git', ['log', '-1', '--format=%aI', sha], {
            cwd: root,
            encoding: 'utf8',
            timeout: REPO_FACTS_GIT_TIMEOUT_MS,
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch {
          return '';
        }
      })
      .filter(date => date.length > 0);
    if (dates.length === 0) return undefined;
    return dates.sort()[0];
  } catch {
    return undefined;
  }
}

function recommendTransfer(loaded: LoadedKlauroConfig, remoteProvider: RemoteProviderInfo | undefined, mode: 'full' | 'dirty-tree'): SourceTransferRecommendation {
  if (loaded.config.policy.requireSelfHosted || loaded.config.analyzer.selfHosted) {
    return {
      operation: 'use_self_hosted_analyzer',
      status: 'active',
      reason: 'This project is configured to use a self-hosted analyzer endpoint.',
    };
  }

  if (mode === 'dirty-tree') {
    return {
      operation: 'prepare_local_working_copy_context',
      status: 'active',
      reason: 'Dirty-tree contexts are private local working-copy context for the signed-in developer and are not shared project analysis.',
      next_action: remoteProvider?.suggested_connection?.action,
    };
  }

  if (remoteProvider?.connectable) {
    return {
      operation: 'submit_commit_analysis',
      status: 'active',
      reason: loaded.config.project.id
        ? 'Submit the current committed tree to the connected Klauro project for shared project analysis.'
        : 'Submit the current committed tree to Klauro for shared project analysis. The detected Git remote can also be connected later for automatic push-triggered analysis.',
      next_action: remoteProvider.suggested_connection?.action,
    };
  }

  return {
    operation: 'submit_commit_analysis',
    status: 'active',
    reason: loaded.config.project.id
      ? 'Submit the current committed tree to the connected Klauro project for shared project analysis.'
      : 'Submit the current committed tree or unversioned source snapshot to Klauro for shared project analysis.',
  };
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function safeJoin(root: string, relativePath: string): string | null {
  const absolutePath = path.resolve(root, relativePath);
  return absolutePath.startsWith(`${root}${path.sep}`) || absolutePath === root ? absolutePath : null;
}

function allExcludePatterns(loaded: LoadedKlauroConfig): string[] {
  return [
    ...(loaded.config.source.exclude || []),
    ...(loaded.ignorePatterns || []),
  ];
}

function patternListMatches(filePath: string, patterns: string[]): boolean {
  return patterns.some(pattern => globLikeMatches(filePath, pattern));
}



function findMatchingPattern(filePath: string, patterns: string[]): string | undefined {
  return patterns.find(pattern => globLikeMatches(filePath, pattern));
}

function globLikeMatches(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeRelativePath(filePath);
  const normalizedPattern = normalizeRelativePath(pattern);
  if (normalizedPattern === '**/*' || normalizedPattern === '**') return true;
  const directPattern = normalizedPattern.startsWith('**/')
    ? normalizedPattern.slice(3)
    : normalizedPattern;
  const regex = new RegExp(`^${globToRegex(normalizedPattern)}$`);
  if (regex.test(normalizedPath)) return true;
  if (!normalizedPattern.includes('/')) {
    return normalizedPath.split('/').some(part => new RegExp(`^${globToRegex(normalizedPattern)}$`).test(part));
  }
  if (normalizedPattern.startsWith('**/')) {
    return new RegExp(`(^|/)${globToRegex(directPattern)}$`).test(normalizedPath);
  }
  return false;
}

function globToRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*' && next === '*') {
      out += '.*';
      i++;
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}
