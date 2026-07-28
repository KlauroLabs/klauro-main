/**
 * Corpus enumeration for the extractor differential-parity harness.
 *
 * The corpus is a PARAMETER, not a hard-coded path: the default is this
 * repository's own TypeScript, but any checkout can be pointed at (an external
 * repo, a downloaded package, a reduced repro set) by passing a different root
 * or a different set of roots. That is what makes the harness reusable as the
 * extractor's acceptance surface rather than a one-repo snapshot.
 *
 * Enumeration is deterministic: directory entries are sorted, so two runs on
 * the same tree produce the same file list in the same order, and a report from
 * run N is comparable line-for-line with run N+1.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CorpusOptions {
  /** Absolute directory roots to walk. */
  roots: string[];
  /** Directory basenames pruned during the walk. */
  excludeDirs?: string[];
  /** File extensions to include (with leading dot). */
  extensions?: string[];
  /**
   * Absolute path the returned entries are made relative to, so reports are
   * stable across machines and worktrees.
   */
  relativeTo?: string;
  /** Optional cap, applied after sorting — for smoke runs, not for the gate. */
  limit?: number;
}

export interface CorpusFile {
  /** Absolute path, used to read the file. */
  absolutePath: string;
  /** Path relative to `relativeTo`, used in reports and the allowlist. */
  relativePath: string;
  /** Byte size, used only to report corpus scale. */
  size: number;
}

/**
 * Excluded by default:
 *  - `node_modules`, `dist`, `build`, `coverage` — not this repo's source
 *  - `.tmp` — scratch space, deliberately untracked and unstable
 *  - `.git`, `.wt-*` worktrees — not source at all
 */
export const DEFAULT_EXCLUDE_DIRS = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.tmp',
  '.git',
  '.next',
  '.turbo',
  '.cache',
];

export const DEFAULT_EXTENSIONS = ['.ts', '.tsx'];

/** Absolute path of the monorepo root, derived from this file's location. */
export function repoRoot(): string {
  // .../packages/analyzer-core/src/__tests__/parity/ -> up 5
  return path.resolve(__dirname, '..', '..', '..', '..', '..');
}

export function enumerateCorpus(options: CorpusOptions): CorpusFile[] {
  const excludeDirs = new Set(options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS);
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const relativeTo = options.relativeTo ?? options.roots[0];
  const found: CorpusFile[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort by name so the walk order — and therefore the report — is stable.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow links out of the tree
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.d.ts')) continue; // declaration-only, no bodies
      if (!extensions.some(ext => entry.name.endsWith(ext))) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      found.push({
        absolutePath: full,
        relativePath: path.relative(relativeTo, full),
        size,
      });
    }
  };

  for (const root of options.roots) walk(root);

  found.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return typeof options.limit === 'number' ? found.slice(0, options.limit) : found;
}

/** The default corpus: every non-declaration `.ts`/`.tsx` file in this repo. */
export function defaultCorpus(limit?: number): CorpusFile[] {
  const root = repoRoot();
  return enumerateCorpus({ roots: [root], relativeTo: root, limit });
}
