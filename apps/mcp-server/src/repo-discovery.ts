import * as fs from 'fs-extra';
import * as path from 'path';
import { isDirectCliInvocation } from './cli-invocation';
import { isRegisteredManifest, languageForSourceFile } from '../../../packages/analyzer-core/src/analyzer/core/language-registry';

export type RepoDiscoveryStatus = 'eligible' | 'unsupported' | 'skipped';

export interface RealRepoTarget {
  name: string;
  path: string;
  status: RepoDiscoveryStatus;
  supported: boolean;
  reason?: string;
  languages: string[];
  manifests: string[];
  source_files: number;
}

export interface RepoDiscoveryReport {
  generated_at: string;
  dev_root: string;
  total_repos: number;
  eligible_repos: number;
  unsupported_repos: number;
  skipped_repos: number;
  repos: RealRepoTarget[];
}

const EXCLUDED_DIRS = new Set([
  '.git',
  '.claude',
  '.codex',
  '.scannerwork',
  'node_modules',
  'dist',
  'build',
  'target',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.terraform',
  '.sourcemaps',
  'sourcemaps',
  '.npm',
  '.yarn',
  '.pnpm-store',
  '.venv',
  'venv',
  'env',
  'site-packages',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.klauro-agent-home',
  '.dart_tool',
  '.gradle',
  'Pods',
  'vendor',
  'vendors',
  'Generated',
  'generated',
  'fixtures',
  '__fixtures__',
  'testdata',
  'cas-tests',
]);

const GENERATED_NAME_PATTERNS = [
  /^\.klauro/i,
  /^\.claude/i,
  /^\.codex/i,
  /^klauro-agent-live/i,
  /^agent-live-trials/i,
  /^live-trial/i,
  /^benchmark-work/i,
  /^\.?tmp[-_]/i,
  /^cloned[_-]?repo$/i,
];

export async function discoverRealRepos(devRoot = path.join(process.env.HOME || '', 'dev')): Promise<RepoDiscoveryReport> {
  const root = path.resolve(devRoot);
  const repos: RealRepoTarget[] = [];
  await walk(root, repos, root);
  repos.sort((left, right) => left.path.localeCompare(right.path));
  return {
    generated_at: new Date().toISOString(),
    dev_root: root,
    total_repos: repos.length,
    eligible_repos: repos.filter(repo => repo.status === 'eligible').length,
    unsupported_repos: repos.filter(repo => repo.status === 'unsupported').length,
    skipped_repos: repos.filter(repo => repo.status === 'skipped').length,
    repos,
  };
}

async function walk(directory: string, repos: RealRepoTarget[], devRoot: string): Promise<void> {
  if (shouldSkipDirectory(directory, devRoot)) return;

  if (await isGitRepo(directory)) {
    repos.push(await classifyRepo(directory));
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    if (shouldSkipDirectory(child, devRoot)) continue;
    await walk(child, repos, devRoot);
  }
}

async function classifyRepo(repoPath: string): Promise<RealRepoTarget> {
  const files = await scanRepoFiles(repoPath, 25000);
  const manifests = files.filter(file => matchesManifest(file));
  const languageCounts = new Map<string, number>();
  let sourceFiles = 0;
  for (const file of files) {
    const language = languageForSourceFile(file);
    if (!language) continue;
    sourceFiles++;
    languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
  }
  const languages = [...languageCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([language]) => language);

  if (isGeneratedRepo(repoPath)) {
    return baseTarget(repoPath, 'skipped', 'Generated benchmark/live-trial/cache repository', languages, manifests, sourceFiles);
  }
  if (sourceFiles === 0 && manifests.length === 0) {
    return baseTarget(repoPath, 'unsupported', 'No supported source files or manifests found', languages, manifests, sourceFiles);
  }
  if (languages.length === 0 && manifests.length > 0) {
    return baseTarget(repoPath, 'unsupported', 'Manifest-only repository without supported source files', languages, manifests, sourceFiles);
  }
  const incompleteReason = detectIncompleteSourceRepo(repoPath, files, manifests, sourceFiles);
  if (incompleteReason) {
    return baseTarget(repoPath, 'unsupported', incompleteReason, languages, manifests, sourceFiles);
  }

  return baseTarget(repoPath, 'eligible', undefined, languages, manifests, sourceFiles);
}

function detectIncompleteSourceRepo(
  repoPath: string,
  files: string[],
  manifests: string[],
  sourceFiles: number
): string | undefined {
  if (!manifests.some(file => path.basename(file) === 'package.json')) return undefined;
  if (sourceFiles > 3) return undefined;

  const packagePath = path.join(repoPath, 'package.json');
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    return undefined;
  }

  const fileSet = new Set(files.map(file => file.replace(/\\/g, '/')));
  const scriptTargets = Object.values(pkg.scripts || {})
    .flatMap(script => extractScriptSourceTargets(String(script)));
  if (scriptTargets.length < 2) return undefined;

  const missingTargets = scriptTargets.filter(target => !fileSet.has(target));
  if (missingTargets.length >= Math.max(2, Math.ceil(scriptTargets.length * 0.6))) {
    return `Package scripts reference missing source files (${missingTargets.slice(0, 4).join(', ')}); repository appears incomplete`;
  }

  return undefined;
}

function extractScriptSourceTargets(script: string): string[] {
  const matches = script.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)/g) || [];
  return Array.from(new Set(matches
    .map(match => match.replace(/^\.\//, '').replace(/\\/g, '/'))
    .filter(match => !/(^|\/)(node_modules|dist|build|coverage)\//.test(match))));
}

function baseTarget(
  repoPath: string,
  status: RepoDiscoveryStatus,
  reason: string | undefined,
  languages: string[],
  manifests: string[],
  sourceFiles: number
): RealRepoTarget {
  return {
    name: path.basename(repoPath),
    path: repoPath,
    status,
    supported: status === 'eligible',
    reason,
    languages,
    manifests,
    source_files: sourceFiles,
  };
}

async function scanRepoFiles(root: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  async function scan(directory: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!isExcludedDirectoryName(entry.name)) await scan(absolute);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  await scan(root);
  return files;
}

async function isGitRepo(directory: string): Promise<boolean> {
  return fs.pathExists(path.join(directory, '.git'));
}

function shouldSkipDirectory(directory: string, devRoot: string): boolean {
  const name = path.basename(directory);
  if (directory !== devRoot && isExcludedDirectoryName(name)) return true;
  if (directory !== devRoot && GENERATED_NAME_PATTERNS.some(pattern => pattern.test(name))) return true;
  const normalized = directory.replace(/\\/g, '/');
  return /\/\.klauro[^/]*\//.test(`${normalized}/`) ||
    /\/(agent-live-trials|benchmark-workspaces|live-trials|worktrees)\//i.test(`${normalized}/`);
}

function isExcludedDirectoryName(name: string): boolean {
  return EXCLUDED_DIRS.has(name) ||
    name.startsWith('.klauro') ||
    /^\.?venv/i.test(name) ||
    /^env/i.test(name) ||
    /^sourcemaps?$/i.test(name);
}

function isGeneratedRepo(repoPath: string): boolean {
  const normalized = repoPath.replace(/\\/g, '/');
  return normalized.includes('/.klauro') ||
    /\/(agent-live-trials|benchmark-workspaces|live-trials|worktrees|\.klauro-agent-live-trials)\//i.test(normalized) ||
    GENERATED_NAME_PATTERNS.some(pattern => pattern.test(path.basename(repoPath)));
}

function matchesManifest(file: string): boolean {
  return isRegisteredManifest(file);
}

async function main(): Promise<void> {
  const devRootArgIndex = process.argv.indexOf('--dev-root');
  const devRoot = devRootArgIndex >= 0 ? process.argv[devRootArgIndex + 1] : path.join(process.env.HOME || '', 'dev');
  const report = await discoverRealRepos(devRoot);
  const json = process.argv.includes('--json');
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Real repo discovery: ${report.eligible_repos} eligible, ${report.unsupported_repos} unsupported, ${report.skipped_repos} skipped under ${report.dev_root}`);
  for (const repo of report.repos) {
    console.log(`${repo.status.toUpperCase().padEnd(11)} ${repo.path}${repo.reason ? ` - ${repo.reason}` : ''}`);
  }
}

if (isDirectCliInvocation('repo-discovery')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
