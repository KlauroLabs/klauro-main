import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { aiCacheProjectScope } from '../../../packages/analyzer-core/src/ai/ai-cache';
import { getAnalysisRunLogPath } from '../../../packages/analyzer-core/src/analyzer/core/run-log';

export interface PurgeRoots {
  klauroRoot: string;
  analysesDir: string;
  aiCacheDir: string;
  runLogPath: string;
}

export interface ProjectPurgeReport {
  project_path: string;
  slug: string;
  removed: string[];
  index_entry_removed: boolean;
  run_log_entries_removed: number;
  ai_cache: {
    project_entries_removed: number;
    unassociated_entries_remaining: number;
    all_ai_cache_removed: boolean;
  };
  notes: string[];
}

export interface FullPurgeReport {
  removed: string[];
  notes: string[];
}

export function resolvePurgeRoots(overrides: Partial<PurgeRoots> = {}): PurgeRoots {
  const klauroRoot = overrides.klauroRoot || path.join(os.homedir(), '.klauro');
  return {
    klauroRoot,
    analysesDir: overrides.analysesDir || process.env.KLAURO_STORAGE_PATH || path.join(klauroRoot, 'analyses'),
    aiCacheDir: overrides.aiCacheDir || path.join(klauroRoot, 'ai-cache'),
    runLogPath: overrides.runLogPath || getAnalysisRunLogPath(),
  };
}

async function removeIfExists(target: string, removed: string[]): Promise<void> {
  if (await fs.pathExists(target)) {
    await fs.remove(target);
    removed.push(target);
  }
}

async function removeIndexEntry(analysesDir: string, projectPath: string): Promise<boolean> {
  const indexPath = path.join(analysesDir, 'index.json');
  if (!(await fs.pathExists(indexPath))) return false;
  let index: any;
  try {
    index = await fs.readJson(indexPath);
  } catch {
    return false;
  }
  if (!index || typeof index !== 'object' || !index.analyses || !(projectPath in index.analyses)) {
    return false;
  }
  delete index.analyses[projectPath];
  const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeJson(tmpPath, { ...index, updated_at: new Date().toISOString() }, { spaces: 2 });
  await fs.move(tmpPath, indexPath, { overwrite: true });
  return true;
}

async function removeRunLogEntries(runLogPath: string, projectPath: string): Promise<number> {
  if (!(await fs.pathExists(runLogPath))) return 0;
  const lines = (await fs.readFile(runLogPath, 'utf8')).split('\n').filter(line => line.trim().length > 0);
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      kept.push(line);
      continue;
    }
    if (parsed && parsed.project_path === projectPath) {
      removed += 1;
    } else {
      kept.push(line);
    }
  }
  if (removed > 0) {
    await fs.writeFile(runLogPath, kept.length > 0 ? `${kept.join('\n')}\n` : '');
  }
  return removed;
}

async function countUnassociatedAiCacheEntries(aiCacheDir: string): Promise<number> {
  if (!(await fs.pathExists(aiCacheDir))) return 0;
  const entries = await fs.readdir(aiCacheDir);
  let count = 0;
  for (const entry of entries) {
    if (entry.endsWith('.json')) count += 1;
  }
  return count;
}

async function countFilesRecursively(dir: string): Promise<number> {
  if (!(await fs.pathExists(dir))) return 0;
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else count += 1;
    }
  }
  return count;
}

export async function purgeProject(
  projectPath: string,
  options: { allAiCache?: boolean; roots?: Partial<PurgeRoots> } = {},
): Promise<ProjectPurgeReport> {
  const roots = resolvePurgeRoots(options.roots);
  const resolved = path.resolve(projectPath);
  const slug = aiCacheProjectScope(resolved);
  const removed: string[] = [];
  const notes: string[] = [];

  for (const suffix of ['.json', '.json.zst', '.json.br']) {
    await removeIfExists(path.join(roots.analysesDir, `${slug}${suffix}`), removed);
  }
  await removeIfExists(path.join(roots.analysesDir, slug), removed);

  const indexEntryRemoved = await removeIndexEntry(roots.analysesDir, resolved);
  const runLogEntriesRemoved = await removeRunLogEntries(roots.runLogPath, resolved);

  const projectAiCacheDir = path.join(roots.aiCacheDir, slug);
  const projectEntriesRemoved = await countFilesRecursively(projectAiCacheDir);
  await removeIfExists(projectAiCacheDir, removed);

  let allAiCacheRemoved = false;
  let unassociatedRemaining = await countUnassociatedAiCacheEntries(roots.aiCacheDir);
  if (options.allAiCache) {
    await removeIfExists(roots.aiCacheDir, removed);
    allAiCacheRemoved = true;
    unassociatedRemaining = 0;
  } else if (unassociatedRemaining > 0) {
    notes.push(
      `${unassociatedRemaining} AI cache entr${unassociatedRemaining === 1 ? 'y' : 'ies'} in ${roots.aiCacheDir} were written before per-project cache association and cannot be attributed to a project. ` +
      'They may include AI-generated descriptions of this project. Remove them with: klauro purge <path> --all-ai-cache (or klauro purge --all).',
    );
  }

  if (removed.length === 0 && !indexEntryRemoved && runLogEntriesRemoved === 0) {
    notes.push(`No stored Klauro data found for ${resolved} (slug ${slug}).`);
  }

  return {
    project_path: resolved,
    slug,
    removed,
    index_entry_removed: indexEntryRemoved,
    run_log_entries_removed: runLogEntriesRemoved,
    ai_cache: {
      project_entries_removed: projectEntriesRemoved,
      unassociated_entries_remaining: unassociatedRemaining,
      all_ai_cache_removed: allAiCacheRemoved,
    },
    notes,
  };
}

export async function purgeAll(options: { roots?: Partial<PurgeRoots> } = {}): Promise<FullPurgeReport> {
  const roots = resolvePurgeRoots(options.roots);
  const removed: string[] = [];
  const notes: string[] = [];

  await removeIfExists(roots.klauroRoot, removed);
  if (!roots.analysesDir.startsWith(`${roots.klauroRoot}${path.sep}`) && roots.analysesDir !== roots.klauroRoot) {
    await removeIfExists(roots.analysesDir, removed);
  }
  if (removed.length === 0) {
    notes.push('No Klauro storage found; nothing to remove.');
  }
  notes.push('Local purge does not delete remote copies (remote analyzer storage, S3 artifacts, AI provider retention, pgvector rows).');
  notes.push('MCP registration and CLAUDE.md instructions are removed by: klauro uninstall.');

  return { removed, notes };
}

export function formatProjectPurgeReport(report: ProjectPurgeReport): string {
  return [
    `Klauro purge: ${report.project_path}`,
    `Slug: ${report.slug}`,
    '',
    'Removed:',
    ...(report.removed.length ? report.removed.map(item => `- ${item}`) : ['- nothing on disk']),
    `Index entry removed: ${report.index_entry_removed ? 'yes' : 'no'}`,
    `Run-log entries removed: ${report.run_log_entries_removed}`,
    `Project AI cache entries removed: ${report.ai_cache.project_entries_removed}`,
    report.ai_cache.all_ai_cache_removed ? 'Entire AI cache removed (--all-ai-cache).' : undefined,
    ...(report.notes.length ? ['', 'Notes:', ...report.notes.map(note => `- ${note}`)] : []),
    '',
  ].filter(item => item !== undefined).join('\n');
}

export function formatFullPurgeReport(report: FullPurgeReport): string {
  return [
    'Klauro purge: ALL local data',
    '',
    'Removed:',
    ...(report.removed.length ? report.removed.map(item => `- ${item}`) : ['- nothing on disk']),
    ...(report.notes.length ? ['', 'Notes:', ...report.notes.map(note => `- ${note}`)] : []),
    '',
  ].join('\n');
}
