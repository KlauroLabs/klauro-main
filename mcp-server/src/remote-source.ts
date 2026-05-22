import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadUnravlConfig, type LoadedUnravlConfig } from './unravl-config';

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

export interface WorkingTreeChangePacket {
  project_name: string;
  base_commit?: string;
  git_diff?: string;
  changed_files: RemoteFileChange[];
  manifest: SourceManifest;
}

export interface SourceManifest {
  generated_at: string;
  root: string;
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
  summary: {
    included_files: number;
    included_bytes: number;
    excluded_files: number;
    changed_files?: number;
    deleted_files?: number;
  };
  included_files: UploadManifestFile[];
  excluded: UploadManifestExclusion[];
}

const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.unravl',
  '.unravl-agent-idiom-benchmark',
  '.unravl-agent-proof-machine',
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
  'bin',
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
  const loaded = await loadUnravlConfig(root);
  const files: RemoteSourceFile[] = [];
  await walkConfiguredSourceFiles(root, loaded, async absolutePath => {
    const file = await readRemoteSourceFile(root, absolutePath, loaded);
    if (file) files.push(file);
  });

  return {
    project_name: loaded.config.project.name || path.basename(root),
    base_commit: readGitHead(root),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    manifest: buildManifest(root, loaded, files),
  };
}

export async function buildWorkingTreeChangePacket(projectPath: string): Promise<WorkingTreeChangePacket> {
  const root = path.resolve(projectPath);
  const loaded = await loadUnravlConfig(root);
  if (!loaded.config.upload.allowDirtyTreeSync) {
    throw new Error('Dirty-tree sync is disabled by .unravlrc upload.allowDirtyTreeSync=false');
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
  const loaded = await loadUnravlConfig(root);
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
  return {
    generated_at: new Date().toISOString(),
    root,
    config_file: loaded.configPath,
    ignore_file: loaded.ignorePath,
    mode,
    summary: {
      included_files: included.length,
      included_bytes: included.reduce((sum, file) => sum + file.bytes, 0),
      excluded_files: excluded.length,
      changed_files: mode === 'dirty-tree' ? changes.filter(change => change.status !== 'deleted').length : undefined,
      deleted_files: mode === 'dirty-tree' ? changes.filter(change => change.status === 'deleted').length : undefined,
    },
    included_files: included.sort((left, right) => left.path.localeCompare(right.path)),
    excluded: excluded.sort((left, right) => left.path.localeCompare(right.path)).slice(0, 500),
  };
}

async function walkConfiguredSourceFiles(
  root: string,
  loaded: LoadedUnravlConfig,
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
  loaded: LoadedUnravlConfig,
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

async function readRemoteSourceFile(root: string, absolutePath: string, loaded: LoadedUnravlConfig): Promise<RemoteSourceFile | null> {
  const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
  if (!(await shouldIncludeRelativePath(root, relativePath, loaded))) return null;
  const content = await fs.readFile(absolutePath, 'utf8');
  return {
    path: relativePath,
    content,
    hash: hashContent(content),
  };
}

async function shouldIncludeRelativePath(root: string, relativePath: string, loaded: LoadedUnravlConfig): Promise<boolean> {
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

  const ext = path.extname(base);
  return SOURCE_EXTENSIONS.has(ext) || IMPORTANT_EXTENSIONLESS.has(base);
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

function buildManifest(root: string, loaded: LoadedUnravlConfig, files: Array<{ content: string }>): SourceManifest {
  return {
    generated_at: new Date().toISOString(),
    root,
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

function allExcludePatterns(loaded: LoadedUnravlConfig): string[] {
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
