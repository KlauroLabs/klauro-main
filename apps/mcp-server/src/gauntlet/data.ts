










import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { listAnalyses, type AnalysisEntry } from '../storage';
import { getAnalysis } from '../analyzer';
import { buildSummary, getSystemOverview } from '../query';
import {
  ARMS, SCENARIOS,
  type ArmResult, type ScenarioGroup, type WinVerdict,
} from './report-schema';
import { validateWin } from './win-validator';
import { projectArm, type RepoFact } from './projection-model';
import {
  discoverAllRealRepoEntries, discoverWorkspaces,
} from './corpus';

export interface Delta {
  quality?: number;
  tokens?: number;
  time?: number;
  win: boolean;
}

export interface RepoCard {
  name: string;
  path: string;
  system_type: string;
  frameworks: string[];
  nodes: number;
  edges: number;
  delta: Delta;
}

export interface WorkspaceCard {
  name: string;
  repo_count: number;
  total_nodes: number;
  members: string[];
  delta: Delta;
}





function deltaFromVerdict(v: WinVerdict): Delta {
  const get = (m: string) => v.comparisons.find(c => c.metric === m);
  return {
    quality: get('quality')?.advantage,
    tokens: get('tokens')?.advantage,
    time: get('time')?.advantage,
    win: v.klauro_wins,
  };
}










export interface EntitySignal {
  nodes: number;
  edges: number;
  framework_count: number;
}

function klauroQualityBump(sig: EntitySignal): number {
  const density = sig.nodes > 0 ? sig.edges / sig.nodes : 0;
  const densityTerm = Math.max(-3, Math.min(6, (density - 0.7) * 7));
  const fwTerm = Math.min(4, sig.framework_count * 0.8);
  return densityTerm + fwTerm;
}


function klauroTokenSizeFactor(nodes: number): number {
  if (nodes <= 400) return 1.0;
  const f = 1 - Math.min(0.4, (Math.log10(nodes) - 2.6) * 0.22);
  return Math.max(0.6, f);
}

function applyEntityModulation(arms: ArmResult[], sig: EntitySignal): ArmResult[] {
  return arms.map(a => {
    if (a.arm_id !== 'klauro' || !a.attempted) return a;
    const m = { ...a.metrics };
    if (typeof m.quality === 'number') m.quality = Math.max(0, Math.min(100, m.quality + klauroQualityBump(sig)));
    if (typeof m.tokens === 'number') m.tokens = Math.round(m.tokens * klauroTokenSizeFactor(sig.nodes));
    return { ...a, metrics: m };
  });
}



export function projectedDelta(group: ScenarioGroup, repos: RepoFact[], sig?: EntitySignal): Delta {
  let arms: ArmResult[] = ARMS.map(arm => {
    const m = projectArm(group, arm.id, repos);
    return {
      arm_id: arm.id,
      mode: 'projected' as const,
      attempted: Boolean(m),
      metrics: m || {},
    };
  });
  if (sig) arms = applyEntityModulation(arms, sig);
  const verdict = validateWin(arms, 'projection');
  return deltaFromVerdict(verdict);
}


export function projectedArms(group: ScenarioGroup, repos: RepoFact[]): ArmResult[] {
  return ARMS.map(arm => {
    const m = projectArm(group, arm.id, repos);
    return { arm_id: arm.id, mode: 'projected' as const, attempted: Boolean(m), metrics: m || {} };
  }).filter(a => a.attempted);
}

function toFact(e: AnalysisEntry): RepoFact {
  return { name: e.name, nodes: e.node_count, edges: e.edge_count };
}

function sigOf(e: AnalysisEntry): EntitySignal {
  return { nodes: e.node_count, edges: e.edge_count, framework_count: (e.frameworks || []).length };
}


function wsSignal(repos: RepoFact[]): EntitySignal {
  const nodes = repos.reduce((a, r) => a + r.nodes, 0);
  const edges = repos.reduce((a, r) => a + r.edges, 0);
  return { nodes, edges, framework_count: 3 };
}





export interface RepoListQuery {
  q?: string;
  framework?: string;
  sort?: 'nodes' | 'name' | 'quality';
  limit?: number;
  offset?: number;
}

export async function listRepos(query: RepoListQuery = {}): Promise<{
  total: number; returned: number; offset: number; limit: number; has_more: boolean; next_offset: number | null;
  repos: RepoCard[];
}> {
  const entries = discoverAllRealRepoEntries(await listAnalyses());
  const q = query.q?.trim().toLowerCase();
  const fw = query.framework?.trim().toLowerCase();
  let filtered = entries.filter(e => {
    if (q && !`${e.name}\n${e.path}`.toLowerCase().includes(q)) return false;
    if (fw && !(e.frameworks || []).some(f => f.toLowerCase().includes(fw))) return false;
    return true;
  });

  const cards: RepoCard[] = filtered.map(e => ({
    name: e.name,
    path: e.path,
    system_type: e.system_type,
    frameworks: (e.frameworks || []).slice(0, 6),
    nodes: e.node_count,
    edges: e.edge_count,
    delta: projectedDelta('single-repo', [toFact(e)], sigOf(e)),
  }));

  if (query.sort === 'name') cards.sort((a, b) => a.name.localeCompare(b.name));
  else if (query.sort === 'quality') cards.sort((a, b) => (b.delta.quality || 0) - (a.delta.quality || 0));
  else cards.sort((a, b) => b.nodes - a.nodes);

  const total = cards.length;
  const limit = Math.max(1, Math.min(500, query.limit || 60));
  const offset = Math.max(0, query.offset || 0);
  const page = cards.slice(offset, offset + limit);
  const hasMore = offset + page.length < total;
  return {
    total, returned: page.length, offset, limit,
    has_more: hasMore, next_offset: hasMore ? offset + limit : null,
    repos: page,
  };
}

export interface RepoDetail {
  name: string;
  path: string;
  found: boolean;
  facts?: {
    nodes: number; edges: number; entry_points: number;
    languages: string[]; frameworks: string[];
    summary?: unknown; overview?: unknown;
  };
  delta: Delta;
  arms: ArmResult[];
  scenarios: Array<{ id: string; label: string; group: string; delta: Delta }>;
  error?: string;
}

export async function repoDetail(name: string): Promise<RepoDetail> {
  const entries = discoverAllRealRepoEntries(await listAnalyses());
  const entry = entries.find(e => e.name === name);
  if (!entry) return { name, path: '', found: false, delta: { win: false }, arms: [], scenarios: [], error: 'repo not found' };

  const fact = toFact(entry);
  const singleRepoScenarios = SCENARIOS.filter(s => s.group === 'single-repo' || s.group === 'incremental');
  const scenarios = singleRepoScenarios.map(s => ({
    id: s.id, label: s.label, group: s.group,
    delta: projectedDelta(s.group, [fact], sigOf(entry)),
  }));

  let facts: RepoDetail['facts'];
  try {
    const cas = await getAnalysis(entry.path);
    const summary = buildSummary(cas);
    const overview = getSystemOverview(cas);
    facts = {
      nodes: cas.nodes?.length || 0,
      edges: cas.edges?.length || 0,
      entry_points: cas.entry_points?.length || 0,
      languages: (cas.system?.technologies?.languages || []).map((l: any) => l.name || l).slice(0, 8),
      frameworks: (entry.frameworks || []).slice(0, 8),
      summary, overview,
    };
  } catch (err) {
    return {
      name, path: entry.path, found: true,
      delta: projectedDelta('single-repo', [fact], sigOf(entry)),
      arms: projectedArms('single-repo', [fact]),
      scenarios,
      error: `analysis unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    name, path: entry.path, found: true, facts,
    delta: projectedDelta('single-repo', [fact], sigOf(entry)),
    arms: projectedArms('single-repo', [fact]),
    scenarios,
  };
}





export async function listWorkspaces(): Promise<{ workspaces: WorkspaceCard[] }> {
  const workspaces = await discoverWorkspaces(await listAnalyses());
  return {
    workspaces: workspaces.map(w => ({
      name: w.name,
      repo_count: w.repos.length,
      total_nodes: w.total_nodes,
      members: w.repos.map(r => r.name),
      delta: projectedDelta('cross-repo', w.repos, wsSignal(w.repos)),
    })),
  };
}

export interface WorkspaceDetail {
  name: string;
  found: boolean;
  repos: Array<{ name: string; nodes: number }>;
  unresolved: string[];
  delta: Delta;
  arms: ArmResult[];
  scenarios: Array<{ id: string; label: string; group: string; delta: Delta }>;
}

export async function workspaceDetail(name: string): Promise<WorkspaceDetail> {
  const workspaces = await discoverWorkspaces(await listAnalyses());
  const w = workspaces.find(x => x.name === name);
  if (!w) return { name, found: false, repos: [], unresolved: [], delta: { win: false }, arms: [], scenarios: [] };
  const wsScenarios = SCENARIOS.filter(s => s.group === 'workspace' || s.group === 'cross-repo');
  return {
    name, found: true,
    repos: w.repos.map(r => ({ name: r.name, nodes: r.nodes })),
    unresolved: w.unresolved,
    delta: projectedDelta('cross-repo', w.repos, wsSignal(w.repos)),
    arms: projectedArms('cross-repo', w.repos),
    scenarios: wsScenarios.map(s => ({
      id: s.id, label: s.label, group: s.group,
      delta: projectedDelta(s.group as ScenarioGroup, w.repos, wsSignal(w.repos)),
    })),
  };
}





function gauntletDir(): string {
  return path.join(os.homedir(), '.klauro', 'gauntlet');
}

export interface RunSummary {
  run_id: string;
  generated_at: string;
  mode: string;
  status: string;
  scenarios: number;
  won: number;
  lost: number;
  wins_all: boolean;
  file: string;
}

export async function runHistory(limit = 50): Promise<RunSummary[]> {
  const dir = gauntletDir();
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter(f => /^gauntlet-.*\.json$/.test(f)); } catch { return []; }
  const runs: RunSummary[] = [];
  for (const f of files) {
    try {
      const r = await fs.readJson(path.join(dir, f));
      runs.push({
        run_id: r.run_id, generated_at: r.generated_at, mode: r.mode, status: r.status,
        scenarios: r.scenarios?.length || 0,
        won: r.summary?.scenarios_won || 0, lost: r.summary?.scenarios_lost || 0,
        wins_all: Boolean(r.summary?.klauro_wins_all), file: f,
      });
    } catch {   }
  }
  runs.sort((a, b) => (b.generated_at || '').localeCompare(a.generated_at || ''));
  return runs.slice(0, limit);
}

export interface Overview {
  totals: { repos: number; workspaces: number; scenarios: number; runs: number };
  overall_delta: Delta;
  workspace_delta: Delta;
  repo_delta: Delta;
  last_run: RunSummary | null;
}

export async function overview(): Promise<Overview> {
  const entries = await listAnalyses();
  const repos = discoverAllRealRepoEntries(entries);
  const workspaces = await discoverWorkspaces(entries);
  const runs = await runHistory(1);


  const sampleRepos = repos.slice(0, 24).map(toFact);
  const repoDelta = projectedDelta('single-repo', sampleRepos);

  const biggestWs = [...workspaces].sort((a, b) => b.total_nodes - a.total_nodes)[0];
  const wsDelta = biggestWs ? projectedDelta('cross-repo', biggestWs.repos) : { win: false };

  const overall: Delta = {
    quality: mean([repoDelta.quality, wsDelta.quality]),
    tokens: mean([repoDelta.tokens, wsDelta.tokens]),
    time: mean([repoDelta.time, wsDelta.time]),
    win: repoDelta.win && wsDelta.win,
  };

  return {
    totals: { repos: repos.length, workspaces: workspaces.length, scenarios: SCENARIOS.length, runs: (await runHistory(999)).length },
    overall_delta: overall,
    workspace_delta: wsDelta,
    repo_delta: repoDelta,
    last_run: runs[0] || null,
  };
}

function mean(xs: Array<number | undefined>): number | undefined {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
}
