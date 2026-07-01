import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadKlauroConfig, type LoadedKlauroConfig } from './klauro-config';
import { detectRemoteProvider, type RemoteProviderInfo } from './remote-provider';
import { isRegisteredManifest, isRegisteredSourceExtension } from '../../../packages/analyzer-core/src/analyzer/core/language-registry';

export interface RemoteSourceFile {
  path: string;
  content: string;
  hash: string;
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
  excluded_directories: string[];
  config_file?: string;
  ignore_file?: string;
  upload_mode?: string;
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

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.klauro',
  '.klauro-agent-idiom-benchmark',
  '.klauro-agent-proof-machine',
  '.claude',
  '.codex',
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
  // NOTE: 'bin' is intentionally NOT excluded — it holds real source in several
  // ecosystems (OCaml/Dune `bin/main.ml`, Rust `src/bin`, shell scripts). Compiled
  // artifacts there (.dll/.exe/.o) are dropped anyway by the registered-source-ext
  // gate below, so excluding the whole dir only lost legitimate source.
  'obj',
]);

const EXCLUDED_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.npmrc',
  '.pypirc',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.cs',
  '.go',
  '.rs',
  '.php',
  '.dart',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.prisma',
  '.graphql',
  '.gql',
  '.md',
  '.txt',
  '.sql',
  '.html',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
]);

const IMPORTANT_EXTENSIONLESS = new Set([
  'Dockerfile',
  'Makefile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'artisan',
]);

export async function buildSourceSnapshot(projectPath: string): Promise<SourceSnapshot> {
  const root = path.resolve(projectPath);
  const loaded = await loadKlauroConfig(root);
  const head = readGitHead(root);
  if (isGitRepository(root) && listGitChanges(root).length > 0) {
    throw new Error('Shared Klauro project analysis runs on committed source. Commit or stash uncommitted changes before remote analysis. Use klauro index --dirty-tree for private local agent assistance.');
  }
  const files: RemoteSourceFile[] = [];
  await walkConfiguredSourceFiles(root, loaded, async absolutePath => {
    const file = await readRemoteSourceFile(root, absolutePath, loaded);
    if (file) files.push(file);
  });

  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: head,
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
    manifest: buildManifest(root, loaded, changedFiles.filter((file): file is RemoteChangedFile => file.status !== 'deleted')),
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
      if (!(await shouldIncludeRelativePath(root, normalized, loaded))) {
        excluded.push({ path: normalized, reason: 'excluded by source policy' });
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
      if (await shouldIncludeRelativePath(root, normalized, loaded)) {
        const stat = await fs.stat(absolutePath);
        const content = await fs.readFile(absolutePath, 'utf8');
        included.push({ path: normalized, bytes: stat.size, hash: hashContent(content) });
      } else {
        excluded.push({ path: normalized, reason: 'excluded by source policy' });
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

async function detectWorkspaceRecommendation(root: string): Promise<WorkspaceRecommendation | undefined> {
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
    // Candidate discovery should not fail the upload manifest.
  }
  return candidate;
}

async function walkConfiguredSourceFiles(
  root: string,
  loaded: LoadedKlauroConfig,
  visit: (absolutePath: string) => Promise<void>,
  exclusions: UploadManifestExclusion[] = []
): Promise<void> {
  for (const sourceRoot of loaded.config.source.roots || ['.']) {
    const absoluteRoot = safeJoin(root, sourceRoot);
    if (!absoluteRoot) {
      exclusions.push({ path: sourceRoot, reason: 'unsafe source root' });
      continue;
    }
    await walkSourceFiles(root, absoluteRoot, loaded, visit, exclusions);
  }
}

async function walkSourceFiles(
  root: string,
  currentDirectory: string,
  loaded: LoadedKlauroConfig,
  visit: (absolutePath: string) => Promise<void>,
  exclusions: UploadManifestExclusion[]
): Promise<void> {
  const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name);
    const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
    if (entry.isSymbolicLink() && !loaded.config.source.followSymlinks) {
      exclusions.push({ path: relativePath, reason: 'symlink excluded' });
      continue;
    }
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
      exclusions.push({ path: `${relativePath}/`, reason: 'default directory exclusion' });
      continue;
    }
    if (entry.isDirectory() && patternListMatches(relativePath, allExcludePatterns(loaded))) {
      exclusions.push({ path: `${relativePath}/`, reason: 'excluded by pattern' });
      continue;
    }
    if (entry.isDirectory()) {
      await walkSourceFiles(root, absolutePath, loaded, visit, exclusions);
    } else if (entry.isFile()) {
      if (await shouldIncludeRelativePath(root, relativePath, loaded)) {
        await visit(absolutePath);
      } else {
        exclusions.push({ path: relativePath, reason: 'excluded by source policy' });
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

async function shouldIncludeRelativePath(root: string, relativePath: string, loaded: LoadedKlauroConfig): Promise<boolean> {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized.startsWith('../') || path.isAbsolute(normalized)) return false;
  const parts = normalized.split('/');
  if (parts.some(part => EXCLUDED_DIRECTORIES.has(part))) return false;
  const base = parts[parts.length - 1];
  if (EXCLUDED_FILES.has(base)) return false;
  if (/^\.env\./.test(base)) return false;
  if (/\.lockb$/.test(base)) return false;
  if (patternListMatches(normalized, allExcludePatterns(loaded))) return false;
  if (!patternListMatches(normalized, loaded.config.source.include || ['**/*'])) return false;

  try {
    const stat = await fs.stat(path.join(root, normalized));
    if (stat.size > loaded.config.source.maxFileBytes) return false;
  } catch {
    return false;
  }

  // Use the analyzer's language registry as the single source of truth for what is
  // analyzable source/manifest — so the snapshot we send to the product can never
  // drift behind the languages the analyzer supports (the stale hardcoded list
  // dropped Kotlin/.kt, Ruby/.rb, C# .csproj manifests, Swift, C++, etc.).
  return isRegisteredSourceExtension(base) || isRegisteredManifest(base) || IMPORTANT_EXTENSIONLESS.has(base);
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

function buildManifest(root: string, loaded: LoadedKlauroConfig, files: Array<{ content: string }>): SourceManifest {
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
    transfer_recommendation: recommendTransfer(loaded, remoteProvider, 'full'),
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0),
    excluded_directories: Array.from(EXCLUDED_DIRECTORIES).sort(),
    config_file: loaded.configPath,
    ignore_file: loaded.ignorePath,
    upload_mode: loaded.config.upload.mode,
    policy: {
      require_manifest_review: loaded.config.upload.requireManifestReview,
      allow_dirty_tree_sync: loaded.config.upload.allowDirtyTreeSync,
      send_git_diff: loaded.config.upload.sendGitDiff,
      send_deleted_paths: loaded.config.upload.sendDeletedPaths,
    },
  };
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
