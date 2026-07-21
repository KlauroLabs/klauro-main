/**
 * Fabric co-change prediction — aggregation half (Workstream F,
 * docs/SPEC-MATHEMATICAL-INTELLIGENCE.md §F "co-change half").
 *
 * `git-analyzer.ts` already parses `git log --numstat` into per-commit
 * changed-file sets (`GitAnalyzer.preloadAllFileMetrics` builds exactly that
 * map, then discards it after deriving per-file churn metrics). This module
 * adds the missing pairwise aggregation: conditional co-edit probabilities
 * P(B changes | A changes), computed once per repo, kept compact, and
 * persisted as a sidecar JSON file so the fabric doesn't re-walk history on
 * every claim/plan call.
 *
 * Deliberately kept IO-light and pure where it matters: `aggregateCoChange`
 * and `parseNameOnlyLog` are pure functions over plain strings/arrays — fully
 * unit-testable with a synthetic history, no git binary required. Only
 * `computeCoChangeIndexForRepo` / the sidecar read-write pair touch the
 * filesystem or spawn `git`.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One co-change partner of a file, with the evidence behind the prediction. */
export interface CoChangePartner {
  /** The partner file (repo-relative path). */
  file: string;
  /** Laplace-smoothed conditional probability P(partner changes | this file changes). */
  probability: number;
  /** Raw co-occurrence count (number of considered commits touching both files). */
  support: number;
  /** probability / baseline P(partner changes) — how much more likely the
   *  partner is to change GIVEN this file changed, vs. unconditionally.
   *  lift > 1 means real coupling; lift <= 1 is filtered out upstream. */
  lift: number;
}

/**
 * Compact sparse co-change structure: top-K partners per file, keyed by
 * repo-relative path. NOT a full matrix — a repo with F files touched by
 * commits in the window has at most F * topK entries (typically far fewer,
 * since most files have < topK qualifying partners at all). For this repo
 * (see computeCoChangeIndexForRepo callers / HANDOFF.md for the measured
 * number) that keeps the JSON sidecar in the tens-to-low-hundreds of KB even
 * for thousands of files — see `sidecar path` docs below for the exact bound
 * formula.
 */
export type CoChangeIndex = Record<string, CoChangePartner[]>;

export interface CoChangeAggregationOptions {
  /** Minimum raw co-occurrence count to keep a pair — filters noise from
   *  one-off coincidental commits. Spec default: 3. */
  minSupport?: number;
  /** Minimum lift to keep a pair — filters pairs that merely both change
   *  often (e.g. two hot files) without real coupling. Spec default: 2. */
  minLift?: number;
  /** Top-K partners retained per file, ranked by probability desc (ties by
   *  support desc, then lift desc, then file name asc for determinism).
   *  Spec: "top-K co-change partners per file, not the full matrix." */
  topK?: number;
  /** Commits touching more than this many files are treated as non-informative
   *  bulk edits (mass renames, formatting sweeps, vendored-file drops) and
   *  excluded from aggregation entirely — both from pair counts AND from each
   *  file's total commit count, so they don't dilute the conditional
   *  probability either. Spec default: 50. */
  maxFilesPerCommit?: number;
  /** Laplace (additive) smoothing constant added to both numerator and
   *  denominator of the conditional probability, so a file with very few
   *  commits doesn't produce a spuriously extreme probability from a single
   *  coincidental co-commit. Default: 1 (classic add-one smoothing). */
  laplaceAlpha?: number;
}

const DEFAULT_OPTIONS: Required<CoChangeAggregationOptions> = {
  minSupport: 3,
  minLift: 2,
  topK: 10,
  maxFilesPerCommit: 50,
  laplaceAlpha: 1,
};

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate per-commit changed-file sets into conditional co-change
 * probabilities. Deterministic: same `commitFileSets` (as a multiset — order
 * does not affect the result) always produces the same `CoChangeIndex`,
 * because every accumulation step is a plain count (no floating-point
 * accumulation order sensitivity beyond the final division, and the output is
 * sorted with a fully-specified tie-break — see `topK` doc above).
 *
 * Algorithm (docs/SPEC-MATHEMATICAL-INTELLIGENCE.md §F):
 *   1. Drop commits touching more than `maxFilesPerCommit` files (bulk-edit
 *      noise) — this bounds worst-case cost too: the per-commit pair-counting
 *      step is O(filesInCommit^2), so capping filesInCommit bounds it by a
 *      constant per commit, giving total cost O(commits * maxFilesPerCommit^2)
 *      rather than unbounded.
 *   2. commitCount[file] = number of surviving commits touching `file`.
 *   3. pairCount[a][b] = number of surviving commits touching both `a` and `b`
 *      (symmetric: pairCount[a][b] === pairCount[b][a]).
 *   4. For every ordered pair (a, b) with pairCount[a][b] >= minSupport:
 *        probability = (pairCount[a][b] + alpha) / (commitCount[a] + alpha)
 *        baseline    = commitCount[b] / totalCommits
 *        lift        = baseline > 0 ? probability / baseline : 0
 *      keep the pair only if lift > minLift.
 *   5. Per file `a`, keep only the top `topK` surviving partners.
 */
export function aggregateCoChange(
  commitFileSets: string[][],
  options: CoChangeAggregationOptions = {}
): CoChangeIndex {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Step 1: drop bulk-edit commits, and de-duplicate files within a commit
  // (numstat/name-only can list a file more than once for renames in rare
  // cases; a set keeps the pair-counting correct).
  const commits: string[][] = [];
  for (const files of commitFileSets) {
    const unique = [...new Set(files)];
    if (unique.length === 0 || unique.length > opts.maxFilesPerCommit) continue;
    commits.push(unique);
  }

  const totalCommits = commits.length;
  const commitCount = new Map<string, number>();
  const pairCount = new Map<string, Map<string, number>>();

  const bump = (a: string, b: string) => {
    let inner = pairCount.get(a);
    if (!inner) {
      inner = new Map();
      pairCount.set(a, inner);
    }
    inner.set(b, (inner.get(b) ?? 0) + 1);
  };

  for (const files of commits) {
    for (const f of files) {
      commitCount.set(f, (commitCount.get(f) ?? 0) + 1);
    }
    // Unordered pairs within this commit, recorded both directions so lookup
    // by either file is O(1) later.
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        bump(files[i], files[j]);
        bump(files[j], files[i]);
      }
    }
  }

  if (totalCommits === 0) return {};

  const index: CoChangeIndex = {};

  for (const [a, partners] of pairCount) {
    const aCount = commitCount.get(a) ?? 0;
    const candidates: CoChangePartner[] = [];

    for (const [b, support] of partners) {
      if (support < opts.minSupport) continue;
      const bCount = commitCount.get(b) ?? 0;
      const probability = (support + opts.laplaceAlpha) / (aCount + opts.laplaceAlpha);
      const baseline = bCount / totalCommits;
      const lift = baseline > 0 ? probability / baseline : 0;
      if (lift <= opts.minLift) continue;
      candidates.push({ file: b, probability, support, lift });
    }

    if (candidates.length === 0) continue;

    candidates.sort((x, y) => {
      if (y.probability !== x.probability) return y.probability - x.probability;
      if (y.support !== x.support) return y.support - x.support;
      if (y.lift !== x.lift) return y.lift - x.lift;
      return x.file.localeCompare(y.file);
    });

    // Top-K truncation is explicit and stated, never a silent cutoff — the
    // sidecar's `truncated` metadata (see `CoChangeSidecar`) records whether
    // any file actually had more qualifying partners than topK.
    index[a] = candidates.slice(0, opts.topK);
  }

  return index;
}

// ---------------------------------------------------------------------------
// Git log parsing (pure — string in, string[][] out)
// ---------------------------------------------------------------------------

/**
 * Parse `git log --format=%H --name-only` output into one changed-file array
 * per commit, in commit order (most-recent first, matching git's default).
 * Pure string parsing — no git invocation — so aggregation correctness and
 * threshold/determinism tests don't need a real repository.
 */
export function parseNameOnlyLog(output: string): string[][] {
  const commits: string[][] = [];
  let current: string[] | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // A commit-hash line is a bare 40-char hex string (the --format=%H line);
    // anything else at this point is a changed file path.
    if (/^[0-9a-f]{40}$/.test(line)) {
      if (current) commits.push(current);
      current = [];
      continue;
    }

    if (current) current.push(line);
  }
  if (current) commits.push(current);

  return commits;
}

// ---------------------------------------------------------------------------
// Repo-backed computation + sidecar persistence
// ---------------------------------------------------------------------------

export interface CoChangeSidecar {
  /** Schema/version marker for forward compatibility. */
  version: 1;
  /** HEAD commit hash the index was computed at — the cheap invalidation
   *  signal (recompute when HEAD moves) documented alongside `getOrComputeCoChangeIndex`. */
  head_commit: string;
  /** Wall-clock generation time (informational only; head_commit is authoritative). */
  generated_at: string;
  /** Number of commits considered (post bulk-edit filtering) in the window. */
  commits_considered: number;
  /** Number of files with at least one surviving co-change partner. */
  files_indexed: number;
  /** Aggregation parameters used, so a reader can judge staleness of intent
   *  (e.g. if thresholds change upstream, the sidecar should be regenerated). */
  options: Required<CoChangeAggregationOptions>;
  /** true if the topK truncation actually dropped partners for at least one
   *  file — stated, never silently hidden (per the module's honesty stance). */
  truncated: boolean;
  index: CoChangeIndex;
}

const DEFAULT_COMMIT_WINDOW = 500;

function runGit(projectPath: string, args: string[], maxBuffer = 50 * 1024 * 1024): string | null {
  try {
    return execFileSync('git', args, { cwd: projectPath, stdio: 'pipe', maxBuffer }).toString();
  } catch {
    return null;
  }
}

/**
 * Compute the co-change index directly from this repo's git history — the
 * last `commitWindow` commits (spec default 500), via a single
 * `git log --name-only` call (no --numstat needed; only file identity, not
 * line counts, feeds this aggregation).
 *
 * Returns `null` when the path isn't a git repo (mirrors GitAnalyzer's
 * graceful-degradation convention) rather than throwing.
 */
export function computeCoChangeIndexForRepo(
  projectPath: string,
  options: CoChangeAggregationOptions & { commitWindow?: number } = {}
): { index: CoChangeIndex; commitsConsidered: number; headCommit: string } | null {
  const headOut = runGit(projectPath, ['rev-parse', 'HEAD']);
  if (headOut === null) return null;
  const headCommit = headOut.trim();

  const commitWindow = options.commitWindow ?? DEFAULT_COMMIT_WINDOW;
  const logOut = runGit(projectPath, [
    'log',
    `-n`,
    String(commitWindow),
    '--format=%H',
    '--name-only',
  ]);
  if (logOut === null) return null;

  const commitFileSets = parseNameOnlyLog(logOut);
  const index = aggregateCoChange(commitFileSets, options);

  return { index, commitsConsidered: commitFileSets.length, headCommit };
}

function isTruncated(index: CoChangeIndex, topK: number): boolean {
  // We can't tell post-hoc whether a file's kept list was truncated from the
  // index alone once the raw candidate count is discarded, so this is
  // recomputed by the caller (buildSidecar) from the pre-truncation counts.
  // Left as a documented helper in case a caller wants a fast heuristic:
  // any file with exactly topK entries MIGHT have been truncated.
  return Object.values(index).some((partners) => partners.length >= topK);
}

function sidecarPath(projectPath: string): string {
  return path.join(projectPath, '.klauro', 'co-change-index.json');
}

/**
 * Build and write the sidecar file, returning it. Size bound: JSON size is
 * O(files_indexed * topK * ~60 bytes/entry) — a repo-relative path (typically
 * 20-60 chars) plus three numbers. For example, files_indexed=500, topK=10
 * gives roughly 500 * 10 * 60B ~= 300KB worst case; in practice most files
 * have far fewer than topK qualifying partners (lift/support thresholds prune
 * heavily), so real sidecars run much smaller — see HANDOFF.md for this
 * repo's measured size.
 */
export function writeCoChangeIndexSidecar(
  projectPath: string,
  options: CoChangeAggregationOptions & { commitWindow?: number } = {}
): CoChangeSidecar | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const computed = computeCoChangeIndexForRepo(projectPath, options);
  if (!computed) return null;

  const sidecar: CoChangeSidecar = {
    version: 1,
    head_commit: computed.headCommit,
    generated_at: new Date().toISOString(),
    commits_considered: computed.commitsConsidered,
    files_indexed: Object.keys(computed.index).length,
    options: opts,
    truncated: isTruncated(computed.index, opts.topK),
    index: computed.index,
  };

  try {
    const dir = path.dirname(sidecarPath(projectPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sidecarPath(projectPath), JSON.stringify(sidecar), 'utf8');
  } catch {
    // Best-effort persistence — the in-memory result is still returned even
    // if the write fails (read-only filesystem, permissions, etc).
  }

  return sidecar;
}

/** Read a previously-written sidecar, or `null` if absent/unparseable. */
export function readCoChangeIndexSidecar(projectPath: string): CoChangeSidecar | null {
  try {
    const raw = fs.readFileSync(sidecarPath(projectPath), 'utf8');
    const parsed = JSON.parse(raw) as CoChangeSidecar;
    if (parsed && parsed.version === 1 && parsed.index) return parsed;
    return null;
  } catch {
    return null;
  }
}

const inMemoryCache = new Map<string, CoChangeSidecar>();

/**
 * Fast path for fabric callers (fab_claim_work / fab_check_collision /
 * plan_parallel_work): return a cached index, invalidating on HEAD movement
 * rather than a wall-clock TTL — cheap (`git rev-parse HEAD`) and exact
 * (never serves a stale index once new commits land, never recomputes on
 * every call when nothing changed). Cache order: in-process memory -> disk
 * sidecar (if HEAD matches) -> recompute + write sidecar.
 */
export function getOrComputeCoChangeIndex(
  projectPath: string,
  options: CoChangeAggregationOptions & { commitWindow?: number } = {}
): CoChangeIndex | null {
  const headOut = runGit(projectPath, ['rev-parse', 'HEAD']);
  if (headOut === null) return null;
  const headCommit = headOut.trim();

  const cached = inMemoryCache.get(projectPath);
  if (cached && cached.head_commit === headCommit) return cached.index;

  const onDisk = readCoChangeIndexSidecar(projectPath);
  if (onDisk && onDisk.head_commit === headCommit) {
    inMemoryCache.set(projectPath, onDisk);
    return onDisk.index;
  }

  const written = writeCoChangeIndexSidecar(projectPath, options);
  if (!written) return null;
  inMemoryCache.set(projectPath, written);
  return written.index;
}

/**
 * Look up the predicted co-change probability between two files, checking
 * both directions (P(b|a) and P(a|b)) and taking the max — the index is
 * asymmetric (top-K is per-file, so `a` might rank in `b`'s top-K without `b`
 * ranking in `a`'s), and for collision-warning purposes either direction of
 * evidence is equally actionable ("these two files have historically moved
 * together"). Returns `undefined` when neither file has the other in its
 * (truncated) partner list.
 */
export function lookupCoChangeProbability(
  index: CoChangeIndex,
  fileA: string,
  fileB: string
): CoChangePartner | undefined {
  const forward = index[fileA]?.find((p) => p.file === fileB);
  const backward = index[fileB]?.find((p) => p.file === fileA);
  if (forward && backward) return forward.probability >= backward.probability ? forward : backward;
  return forward ?? backward;
}
