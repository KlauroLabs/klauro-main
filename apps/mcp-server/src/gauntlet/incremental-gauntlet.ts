


























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





export interface IncrementalChange {
  filesChanged: number;
  nodesAdded: number;
  nodesModified: number;
  nodesDeleted: number;
  riskLevel?: string;
}

export interface IncrementalDelta {

  quality?: number;

  tokens?: number;

  time?: number;

  win: boolean;
}

export interface IncrementalRecord {
  id: string;
  repo: string;

  at: string;
  change?: IncrementalChange;

  arms: ArmResult[];

  delta: IncrementalDelta;

  change_magnitude: number;
}

export interface IncrementalSeriesPoint {
  at: string;
  quality?: number;
  tokens?: number;
  time?: number;
  win: boolean;
}





const HISTORY_CAP = 100;

function incrementalDir(): string {
  return path.join(os.homedir(), '.klauro', 'gauntlet', 'incremental');
}

function recordFile(repoName: string): string {
  return path.join(incrementalDir(), `${safeName(repoName)}.json`);
}


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





const RISK_WEIGHT: Record<string, number> = {
  low: 0.0,
  medium: 0.12,
  high: 0.25,
  critical: 0.35,
};






export function computeChangeMagnitude(change?: IncrementalChange): number {
  if (!change) return 0;
  const touched =
    Math.max(0, change.nodesAdded || 0) +
    Math.max(0, change.nodesModified || 0) +
    Math.max(0, change.nodesDeleted || 0);

  const sizeTerm = touched > 0 ? Math.log10(1 + touched) / Math.log10(1 + 250) : 0;
  const risk = RISK_WEIGHT[(change.riskLevel || '').toLowerCase()] ?? 0;
  return clamp01(Math.min(1, sizeTerm) * 0.85 + risk);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}







const MAX_KLAURO_QUALITY_BUMP = 8;

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



  const history = await readHistory(repo.name);
  history.unshift(record);
  await writeHistory(repo.name, history);

  return record;
}






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

    }
  }
  all.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return all.slice(0, cap);
}


export async function incrementalSeries(repoName: string): Promise<IncrementalSeriesPoint[]> {
  const resolved = await resolveRepoFactName(repoName);
  const history = await readHistory(resolved);

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






async function resolveRepoFactName(repoName: string): Promise<string> {
  try {
    const fact = await resolveRepoFact(repoName);
    return fact.name;
  } catch {
    return repoName;
  }
}
