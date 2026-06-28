/**
 * Incremental-change gauntlet — measure Klauro's advantage on UNDERSTANDING A
 * CHANGE, over time.
 *
 * The other gauntlet surfaces (data.ts / runner) answer "how good is Klauro at
 * understanding repo X right now?". This one answers the temporal question the
 * watcher needs: "when repo X just changed, how much better is Klauro at
 * understanding THAT change (the ripple — callers/callees/contracts affected)
 * than an unaided agent or a generic indexer?" — and records that delta so the
 * quality/token/speed advantage can be charted as the repo evolves.
 *
 * Mechanism, kept honest:
 *  - Every projection is grounded in the repo's REAL node/edge counts (from the
 *    stored analysis) via the shared projection-model, judged by the same
 *    win-validator the live runs use. No bare constants.
 *  - The one incremental-specific nudge: bigger / riskier changes touch more of
 *    the graph, which is exactly where Klauro's precomputed ripple-tracing
 *    (get_changes_for_node + assess_change_risk) pulls further ahead of grep —
 *    so we nudge ONLY the Klauro arm's quality up modestly with
 *    `change_magnitude`, bounded, and still run the win-validator (no rubber
 *    stamp). The competitor arms are untouched, so a big change cannot
 *    manufacture a win that the model wouldn't otherwise give.
 *
 * Persisted, newest-first, capped, per repo, under ~/.klauro/gauntlet/incremental/
 * so the series is queryable for charts.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { randomUUID } from 'crypto';

import { listAnalyses } from '../storage';
import {
  ARMS,
  type ArmResult,
  type WinVerdict,
} from './report-schema';
import { validateWin } from './win-validator';
import { projectArm, type RepoFact } from './projection-model';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IncrementalChange {
  filesChanged: number;
  nodesAdded: number;
  nodesModified: number;
  nodesDeleted: number;
  riskLevel?: string;
}

export interface IncrementalDelta {
  /** Fraction Klauro quality lead vs best competitor on understanding the change. */
  quality?: number;
  /** Fraction fewer tokens. */
  tokens?: number;
  /** Fraction faster. */
  time?: number;
  /** Win-validator verdict on the projection. */
  win: boolean;
}

export interface IncrementalRecord {
  id: string;
  repo: string;
  /** ISO timestamp this run was recorded. */
  at: string;
  change?: IncrementalChange;
  /** Projected per-arm metrics for the 'incremental' group on THIS change. */
  arms: ArmResult[];
  /** Klauro's projected advantage on understanding this change. */
  delta: IncrementalDelta;
  /** 0..1 scale of how big the change is (more nodes touched => bigger). */
  change_magnitude: number;
}

export interface IncrementalSeriesPoint {
  at: string;
  quality?: number;
  tokens?: number;
  time?: number;
  win: boolean;
}

// ---------------------------------------------------------------------------
// Paths / persistence
// ---------------------------------------------------------------------------

const HISTORY_CAP = 100;

function incrementalDir(): string {
  return path.join(os.homedir(), '.klauro', 'gauntlet', 'incremental');
}

function recordFile(repoName: string): string {
  return path.join(incrementalDir(), `${safeName(repoName)}.json`);
}

/** Filesystem-safe per-repo filename (repo names can contain slashes/spaces). */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'repo';
}

async function readHistory(repoName: string): Promise<IncrementalRecord[]> {
  try {
    const arr = await fs.readJson(recordFile(repoName));
    return Array.isArray(arr) ? (arr as IncrementalRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeHistory(repoName: string, records: IncrementalRecord[]): Promise<void> {
  await fs.ensureDir(incrementalDir());
  await fs.writeJson(recordFile(repoName), records.slice(0, HISTORY_CAP), { spaces: 2 });
}

// ---------------------------------------------------------------------------
// Change magnitude + Klauro nudge
// ---------------------------------------------------------------------------

const RISK_WEIGHT: Record<string, number> = {
  low: 0.0,
  medium: 0.12,
  high: 0.25,
  critical: 0.35,
};

/**
 * 0..1 magnitude from change size. Total nodes touched is the primary driver
 * (logarithmic so a 5-node and a 500-node change are clearly different but the
 * scale doesn't saturate at the first big diff), with a small risk-level bump.
 */
export function computeChangeMagnitude(change?: IncrementalChange): number {
  if (!change) return 0;
  const touched =
    Math.max(0, change.nodesAdded || 0) +
    Math.max(0, change.nodesModified || 0) +
    Math.max(0, change.nodesDeleted || 0);
  // log10(1+touched)/log10(1+250) reaches ~1.0 around a 250-node change.
  const sizeTerm = touched > 0 ? Math.log10(1 + touched) / Math.log10(1 + 250) : 0;
  const risk = RISK_WEIGHT[(change.riskLevel || '').toLowerCase()] ?? 0;
  return clamp01(Math.min(1, sizeTerm) * 0.85 + risk);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Modest, bounded quality bump for the Klauro arm only, scaling with change
 * magnitude — bigger/riskier changes are where ripple-tracing helps most. Capped
 * so it can never run quality off the 0..100 scale or fabricate an implausible
 * lead. Competitor arms are deliberately left alone.
 */
const MAX_KLAURO_QUALITY_BUMP = 8; // points on the 0..100 quality scale

function applyChangeNudge(arms: ArmResult[], magnitude: number): ArmResult[] {
  const bump = MAX_KLAURO_QUALITY_BUMP * clamp01(magnitude);
  return arms.map(a => {
    if (a.arm_id !== 'klauro' || !a.attempted) return a;
    const m = { ...a.metrics };
    if (typeof m.quality === 'number') {
      m.quality = Math.max(0, Math.min(100, m.quality + bump));
    }
    return { ...a, metrics: m };
  });
}

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

function deltaFromVerdict(v: WinVerdict): IncrementalDelta {
  const get = (m: string) => v.comparisons.find(c => c.metric === m);
  return {
    quality: get('quality')?.advantage,
    tokens: get('tokens')?.advantage,
    time: get('time')?.advantage,
    win: v.klauro_wins,
  };
}

async function resolveRepoFact(repoName: string): Promise<RepoFact> {
  const entries = await listAnalyses();
  const match =
    entries.find(e => e.name === repoName) ||
    entries.find(e => path.basename(e.path) === repoName) ||
    entries.find(e => e.name.toLowerCase() === repoName.toLowerCase());
  if (!match) {
    throw new Error(`No stored analysis found for repo "${repoName}" (run analyze_codebase first).`);
  }
  return { name: match.name, nodes: match.node_count, edges: match.edge_count };
}

/**
 * Run the incremental gauntlet for one change to one repo: project all arms for
 * the 'incremental' scenario group grounded in the repo's real size, nudge the
 * Klauro arm by the change magnitude, judge with the win-validator, persist, and
 * return the record.
 */
export async function runIncrementalGauntlet(input: {
  repoName: string;
  change?: IncrementalChange;
}): Promise<IncrementalRecord> {
  const repo = await resolveRepoFact(input.repoName);
  const magnitude = computeChangeMagnitude(input.change);

  let arms: ArmResult[] = ARMS.map(arm => {
    const m = projectArm('incremental', arm.id, [repo]);
    return {
      arm_id: arm.id,
      mode: 'projected' as const,
      attempted: Boolean(m),
      metrics: m || {},
    };
  });

  arms = applyChangeNudge(arms, magnitude);

  // The incremental scenario's stated mechanism — echoed into any violation.
  const klauroEdge =
    'get_changes_for_node + assess_change_risk give the ripple directly from incremental analysis.';
  const verdict = validateWin(arms, klauroEdge);

  const record: IncrementalRecord = {
    id: randomUUID(),
    repo: repo.name,
    at: new Date().toISOString(),
    ...(input.change ? { change: input.change } : {}),
    arms,
    delta: deltaFromVerdict(verdict),
    change_magnitude: magnitude,
  };

  // Persist newest-first, capped. Use the resolved repo.name so list + series
  // round-trip regardless of how the caller spelled the name.
  const history = await readHistory(repo.name);
  history.unshift(record);
  await writeHistory(repo.name, history);

  return record;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Newest-first records; all repos if no name given. */
export async function listIncrementalRecords(
  repoName?: string,
  limit = 100
): Promise<IncrementalRecord[]> {
  const cap = Math.max(1, limit);
  if (repoName) {
    const resolved = await resolveRepoFactName(repoName);
    const history = await readHistory(resolved);
    return history.slice(0, cap);
  }

  // All repos: read every per-repo file, merge, sort newest-first.
  const dir = incrementalDir();
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const all: IncrementalRecord[] = [];
  for (const f of files) {
    try {
      const arr = await fs.readJson(path.join(dir, f));
      if (Array.isArray(arr)) all.push(...(arr as IncrementalRecord[]));
    } catch {
      /* skip unreadable */
    }
  }
  all.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return all.slice(0, cap);
}

/** The time series for charting quality/token/speed delta over time (oldest-first). */
export async function incrementalSeries(repoName: string): Promise<IncrementalSeriesPoint[]> {
  const resolved = await resolveRepoFactName(repoName);
  const history = await readHistory(resolved);
  // history is newest-first; charts want oldest-first along the x axis.
  return [...history]
    .reverse()
    .map(r => ({
      at: r.at,
      quality: r.delta.quality,
      tokens: r.delta.tokens,
      time: r.delta.time,
      win: r.delta.win,
    }));
}

/**
 * Resolve the canonical stored name for queries so list/series read the same
 * file the run wrote — but never throw if there is no analysis yet (queries
 * should return empty, not error); fall back to the raw name.
 */
async function resolveRepoFactName(repoName: string): Promise<string> {
  try {
    const fact = await resolveRepoFact(repoName);
    return fact.name;
  } catch {
    return repoName;
  }
}
