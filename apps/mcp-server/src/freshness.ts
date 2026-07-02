import * as fs from 'fs-extra';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { glob } from 'glob';
import { getAnalysisEntry, loadIncrementalState } from './storage';
import { getRepoRevision, compareRevision, type RevisionMatch } from './revision';

export type FreshnessStatus = 'fresh' | 'stale' | 'no-analysis';

export interface RevisionFreshness {
  match: RevisionMatch;
  analyzed_commit: string | null;
  current: { branch: string | null; head_sha: string | null; dirty: boolean } | null;
  recommendation: string;
}

/**
 * Revision-accurate freshness: compares the stored analysis's commit SHA (stamped at
 * save time) against the current working copy. This is exact where the mtime heuristic
 * is approximate, and is the basis for never-stale, read-through caching. `behind`
 * means the cache should fetch the current revision from the VPS. See revision.ts and
 * docs/KLAURO-PRODUCT-MODEL.md.
 */
export function revisionFreshness(projectPath: string, analyzedCommit: string | null | undefined): RevisionFreshness {
  const current = getRepoRevision(projectPath);
  const match = compareRevision(analyzedCommit, current);
  const recommendation =
    match === 'committed-current' ? 'Cache is the current commit — CAS file/line citations are trustworthy.'
    : match === 'in-flight' ? 'On the analyzed commit with uncommitted edits — the in-flight/working overlay applies.'
    : match === 'behind' ? 'HEAD has moved past the analyzed commit — fetch the current revision from Klauro before trusting citations.'
    : 'Revision identity unavailable (not a git repo or no recorded commit) — falling back to mtime freshness.';
  return {
    match,
    analyzed_commit: analyzedCommit ?? null,
    current: current ? { branch: current.branch, head_sha: current.head_sha, dirty: current.dirty } : null,
    recommendation,
  };
}

export interface AnalysisFreshnessReport {
  generated_at: string;
  path: string;
  status: FreshnessStatus;
  analyzed_at?: string;
  analysis_age_seconds?: number;
  source_files: number;
  tracked_files: number;
  modified_since_analysis: number;
  sample_modified_files: Array<{
    path: string;
    modified_at: string;
  }>;
  recommendation: string;
}

const SOURCE_PATTERNS = [
  '**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rs,java,kt,cs,php,vue,svelte}',
  '**/package.json',
  '**/pyproject.toml',
  '**/requirements.txt',
  '**/Cargo.toml',
  '**/go.mod',
  '**/*.csproj',
  '**/composer.json',
  '**/prisma/schema.prisma',
  '**/*.{graphql,gql,proto,openapi.yaml,openapi.yml,openapi.json}',
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/vendor/**',
  '**/vendors/**',
  '**/site-packages/**',
  '**/.sourcemaps/**',
  '**/sourcemaps/**',
  '**/*.js.map',
  '**/*.css.map',
  '**/*.bundle.js',
  '**/*.bundle.css',
  '**/*.min.js',
  '**/*.min.css',
  '**/Generated/**',
  '**/generated/**',
  '**/venv/**',
  '**/.venv/**',
  '**/env/**',
  '**/.git/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/__pycache__/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.vite/**',
  '**/out/**',
  '**/web/assets/**',
  '**/public/assets/**',
  '**/static/assets/**',
];

export type AnalysisStaleness = 'fresh' | 'aging' | 'stale';

export interface AnalysisFreshnessSummary {
  analyzed_at: string;
  age: string;
  files_changed_since_analysis: { count: number; examples: string[] };
  files_deleted_since_analysis: { count: number; examples: string[] };
  staleness: AnalysisStaleness;
  recommendation: string;
  scan: { method: 'git' | 'walk'; bounded: boolean; duration_ms: number; note?: string };
}

const FRESHNESS_SUMMARY_EXAMPLE_LIMIT = 5;
const FRESHNESS_STALE_CHANGED_FILE_THRESHOLD = 10;
const FRESHNESS_MTIME_VERIFY_LIMIT = 500;
const FRESHNESS_WALK_FILE_LIMIT = 4000;
const FRESHNESS_SUMMARY_CACHE_TTL_MS = 5000;
const GIT_COMMAND_TIMEOUT_MS = 4000;

const SOURCE_FILE_EXTENSION_REGEX = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|cs|php|vue|svelte|graphql|gql|proto)$/i;
const SOURCE_MANIFEST_BASENAMES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'cargo.toml',
  'go.mod',
  'composer.json',
  'schema.prisma',
]);
const WALK_IGNORED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'target', 'vendor', 'vendors', 'site-packages',
  'coverage', '__pycache__', 'out', 'venv', 'env', 'generated', 'Generated',
]);

const freshnessSummaryCache = new Map<string, { computed_at: number; value: AnalysisFreshnessSummary }>();

export function clearFreshnessSummaryCache(): void {
  freshnessSummaryCache.clear();
}

function isSourceLikeFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return SOURCE_FILE_EXTENSION_REGEX.test(base) || SOURCE_MANIFEST_BASENAMES.has(base) || base.endsWith('.csproj');
}

function formatAnalysisAge(ageMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(ageMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function runGit(projectPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectPath,
    encoding: 'utf8',
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function collectGitCandidates(projectPath: string, analyzedAtIso: string): { changed: Set<string>; deleted: Set<string> } {
  const changed = new Set<string>();
  const deleted = new Set<string>();

  // `-uall` (as opposed to the default `-unormal`) makes git enumerate every
  // untracked FILE individually instead of collapsing a brand-new, entirely
  // untracked directory into a single `?? some/new/dir/` line. Without this, a
  // freshly-added module (e.g. a new coordination/ directory with new source
  // files, none of them tracked yet) is invisible to isSourceLikeFile below —
  // it only ever sees the directory path, which has no recognized extension —
  // and the freshness summary silently reports "fresh" even though a whole new
  // module was just added. This was a real gap: added files were only picked
  // up once at least one file in the new directory had been staged/tracked.
  for (const line of runGit(projectPath, ['status', '--porcelain', '-uall']).split('\n')) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    let filePath = line.slice(3).trim();
    if (status.startsWith('R') && filePath.includes(' -> ')) {
      const [oldPath, newPath] = filePath.split(' -> ');
      deleted.add(stripGitQuoting(oldPath));
      filePath = newPath;
    }
    filePath = stripGitQuoting(filePath);
    if (!isSourceLikeFile(filePath)) continue;
    if (status.includes('D')) deleted.add(filePath);
    else changed.add(filePath);
  }

  for (const line of runGit(projectPath, ['log', `--since=${analyzedAtIso}`, '--name-status', '--format=']).split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0];
    if (status.startsWith('R') && parts.length >= 3) {
      if (isSourceLikeFile(parts[1])) deleted.add(parts[1]);
      if (isSourceLikeFile(parts[2])) changed.add(parts[2]);
      continue;
    }
    const filePath = parts[1];
    if (!isSourceLikeFile(filePath)) continue;
    if (status === 'D') deleted.add(filePath);
    else changed.add(filePath);
  }

  for (const filePath of deleted) changed.delete(filePath);
  return { changed, deleted };
}

function stripGitQuoting(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

function verifyCandidatesByMtime(
  projectPath: string,
  candidates: { changed: Set<string>; deleted: Set<string> },
  analyzedAtMs: number,
): { changed: string[]; deleted: string[]; bounded: boolean } {
  const changed: string[] = [];
  const deleted: string[] = [];
  let verified = 0;
  for (const filePath of candidates.changed) {
    if (verified >= FRESHNESS_MTIME_VERIFY_LIMIT) {
      changed.push(filePath);
      continue;
    }
    verified += 1;
    try {
      const stat = fs.statSync(path.join(projectPath, filePath));
      if (stat.mtimeMs > analyzedAtMs) changed.push(filePath);
    } catch {
      deleted.push(filePath);
    }
  }
  for (const filePath of candidates.deleted) {
    try {
      const stat = fs.statSync(path.join(projectPath, filePath));
      if (stat.mtimeMs > analyzedAtMs) changed.push(filePath);
    } catch {
      deleted.push(filePath);
    }
  }
  return { changed, deleted, bounded: candidates.changed.size > FRESHNESS_MTIME_VERIFY_LIMIT };
}

function walkChangedSourceFiles(projectPath: string, analyzedAtMs: number): { changed: string[]; bounded: boolean } {
  const changed: string[] = [];
  const directories = [projectPath];
  let examined = 0;
  while (directories.length > 0 && examined < FRESHNESS_WALK_FILE_LIMIT) {
    const directory = directories.pop()!;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || WALK_IGNORED_DIRECTORIES.has(entry.name)) continue;
        directories.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !isSourceLikeFile(entry.name)) continue;
      examined += 1;
      if (examined > FRESHNESS_WALK_FILE_LIMIT) break;
      const absolute = path.join(directory, entry.name);
      try {
        const stat = fs.statSync(absolute);
        if (stat.mtimeMs > analyzedAtMs) changed.push(path.relative(projectPath, absolute));
      } catch {
        continue;
      }
    }
  }
  return { changed, bounded: examined >= FRESHNESS_WALK_FILE_LIMIT };
}

function classifyStaleness(changedCount: number, deletedCount: number): AnalysisStaleness {
  if (changedCount === 0 && deletedCount === 0) return 'fresh';
  if (deletedCount > 0 || changedCount > FRESHNESS_STALE_CHANGED_FILE_THRESHOLD) return 'stale';
  return 'aging';
}

function freshnessRecommendation(staleness: AnalysisStaleness, changedCount: number, deletedCount: number, projectPath: string): string {
  if (staleness === 'fresh') return 'Analysis is current; CAS file and line citations are trustworthy.';
  if (staleness === 'aging') {
    return `${changedCount} source file(s) changed since analysis. Citations into those files may be off; run analyze_codebase on ${projectPath} (incremental, seconds) if working near them.`;
  }
  return `Analysis is stale: ${changedCount} source file(s) changed and ${deletedCount} deleted since analysis. Re-run analyze_codebase on ${projectPath} before trusting file/line citations.`;
}

export function summarizeAnalysisFreshness(projectPath: string, analyzedAt: string | undefined): AnalysisFreshnessSummary | null {
  if (!analyzedAt) return null;
  const analyzedAtMs = Date.parse(analyzedAt);
  if (!Number.isFinite(analyzedAtMs)) return null;

  const cacheKey = `${projectPath}|${analyzedAt}`;
  const cached = freshnessSummaryCache.get(cacheKey);
  if (cached && Date.now() - cached.computed_at < FRESHNESS_SUMMARY_CACHE_TTL_MS) return cached.value;

  const started = Date.now();
  let method: 'git' | 'walk' = 'git';
  let bounded = false;
  let note: string | undefined;
  let changed: string[] = [];
  let deleted: string[] = [];

  try {
    if (!fs.existsSync(path.join(projectPath, '.git'))) throw new Error('not a git repository');
    const candidates = collectGitCandidates(projectPath, new Date(analyzedAtMs).toISOString());
    const verified = verifyCandidatesByMtime(projectPath, candidates, analyzedAtMs);
    changed = verified.changed;
    deleted = verified.deleted;
    bounded = verified.bounded;
  } catch {
    method = 'walk';
    if (!fs.existsSync(projectPath)) return null;
    const walked = walkChangedSourceFiles(projectPath, analyzedAtMs);
    changed = walked.changed;
    bounded = walked.bounded;
    note = 'Non-git directory: bounded mtime walk; deletions since analysis are not detectable in this mode.';
  }

  changed.sort();
  deleted.sort();
  const staleness = classifyStaleness(changed.length, deleted.length);
  const summary: AnalysisFreshnessSummary = {
    analyzed_at: new Date(analyzedAtMs).toISOString(),
    age: formatAnalysisAge(Date.now() - analyzedAtMs),
    files_changed_since_analysis: {
      count: changed.length,
      examples: changed.slice(0, FRESHNESS_SUMMARY_EXAMPLE_LIMIT),
    },
    files_deleted_since_analysis: {
      count: deleted.length,
      examples: deleted.slice(0, FRESHNESS_SUMMARY_EXAMPLE_LIMIT),
    },
    staleness,
    recommendation: freshnessRecommendation(staleness, changed.length, deleted.length, projectPath),
    scan: {
      method,
      bounded,
      duration_ms: Date.now() - started,
      ...(note ? { note } : {}),
    },
  };

  freshnessSummaryCache.set(cacheKey, { computed_at: Date.now(), value: summary });
  return summary;
}

export async function getAnalysisFreshness(projectPath: string): Promise<AnalysisFreshnessReport> {
  const entry = await getAnalysisEntry(projectPath);
  if (!entry) {
    return {
      generated_at: new Date().toISOString(),
      path: projectPath,
      status: 'no-analysis',
      source_files: 0,
      tracked_files: 0,
      modified_since_analysis: 0,
      sample_modified_files: [],
      recommendation: 'Run analyze_codebase before relying on CAS-backed MCP context.',
    };
  }

  const analyzedAtMs = Date.parse(entry.analyzed_at);
  const sourceFiles = await glob(SOURCE_PATTERNS, {
    cwd: projectPath,
    ignore: IGNORE_PATTERNS,
    nodir: true,
    absolute: false,
  });
  const modified = [];
  for (const file of sourceFiles) {
    const stat = await fs.stat(path.join(projectPath, file));
    if (stat.mtimeMs > analyzedAtMs) {
      modified.push({ path: file, modified_at: new Date(stat.mtimeMs).toISOString() });
    }
  }

  modified.sort((left, right) => Date.parse(right.modified_at) - Date.parse(left.modified_at));
  const incrementalState = await loadIncrementalState(projectPath);
  const status: FreshnessStatus = modified.length > 0 ? 'stale' : 'fresh';

  return {
    generated_at: new Date().toISOString(),
    path: projectPath,
    status,
    analyzed_at: entry.analyzed_at,
    analysis_age_seconds: Math.max(0, Math.round((Date.now() - analyzedAtMs) / 1000)),
    source_files: sourceFiles.length,
    tracked_files: incrementalState ? Object.keys(incrementalState.files || {}).length : 0,
    modified_since_analysis: modified.length,
    sample_modified_files: modified.slice(0, 25),
    recommendation: status === 'fresh'
      ? 'CAS is fresh relative to source file mtimes.'
      : 'Run analyze_codebase to refresh CAS before using it as default agent context.',
  };
}
