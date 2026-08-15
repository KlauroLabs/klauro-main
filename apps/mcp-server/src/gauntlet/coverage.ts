









import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { getOrchestrator } from '../analyzer';
import { listAnalyses } from '../storage';
import { discoverAllRealRepoEntries } from './corpus';
import { projectedDelta, type Delta } from './data';
import { scoreAllFixtures } from './analyzer-quality';

export interface AnalyzerCoverage {
  id: string;
  name: string;
  type: string;
  requires: string[];
  detect: { dependencies?: string[]; files?: string[]; content?: string[] };
  incremental: boolean;

  verdict?: string;

  measured?: { repo: string; nodes: number; fns: number };
}

export interface CoverageBacklogItem {
  name: string;
  kind: 'language' | 'framework' | 'library';
  note?: string;
}

export interface CoverageReport {
  generated_at: string;
  totals: { languages: number; frameworks: number; libraries: number; total: number; incremental: number };

  corpus: { repos: number; frameworks: Array<{ name: string; repos: number }> };
  analyzers: AnalyzerCoverage[];
  scorecard: Array<{ stack: string; kind: string; verdict: string; repo?: string; nodes?: number; fns?: number }>;
  backlog: CoverageBacklogItem[];


  quality?: {
    mean_f1: number;
    fixtures: Array<{ fixture: string; stack: string; precision: number; recall: number; f1: number }>;
  };
}


const BACKLOG: CoverageBacklogItem[] = [
  { name: 'SolidStart', kind: 'framework', note: 'Solid.js meta-framework' },
  { name: 'Qwik', kind: 'framework' },
  { name: 'Quarkus', kind: 'framework', note: 'JVM/Java' },
  { name: 'Micronaut', kind: 'framework', note: 'JVM/Java' },
  { name: 'MAUI', kind: 'framework', note: '.NET native UI' },
  { name: 'Hotwire/Stimulus', kind: 'framework', note: 'Rails' },
  { name: 'OpenAPI/Swagger', kind: 'library', note: 'API contract spec' },
  { name: 'EF Core', kind: 'library', note: '.NET ORM' },
  { name: 'ActiveRecord', kind: 'library', note: 'Rails ORM' },
  { name: 'Ent', kind: 'library', note: 'Go ORM' },
  { name: 'XState', kind: 'library', note: 'state machines' },
  { name: 'LlamaIndex (depth)', kind: 'library', note: 'AI/RAG' },
  { name: 'Move / Vyper / Cairo', kind: 'language', note: 'non-EVM smart contracts' },
  { name: 'Scala / Zig / Lua', kind: 'language' },
  { name: 'Objective-C', kind: 'language', note: 'legacy iOS' },
];

export interface StackDrilldown {
  stack: string;
  matched: number;
  total_repos: number;

  delta: Delta;
  repos: Array<{ name: string; nodes: number; edges: number; frameworks: string[]; delta: Delta }>;
}




export async function reposUsingStack(stack: string): Promise<StackDrilldown> {
  const entries = discoverAllRealRepoEntries(await listAnalyses());
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const needle = norm(stack);
  const matches = needle ? entries.filter(e =>
    (e.frameworks || []).some(f => {
      const fl = norm(f);
      return fl === needle || fl.includes(needle) || needle.includes(fl);
    })
  ) : [];
  const repos = matches.map(e => {
    const fact = { name: e.name, nodes: e.node_count, edges: e.edge_count };
    const sig = { nodes: e.node_count, edges: e.edge_count, framework_count: (e.frameworks || []).length };
    return {
      name: e.name, nodes: e.node_count, edges: e.edge_count,
      frameworks: (e.frameworks || []).slice(0, 6),
      delta: projectedDelta('single-repo', [fact], sig),
    };
  }).sort((a, b) => b.nodes - a.nodes);

  const mean = (xs: Array<number | undefined>) => {
    const v = xs.filter((x): x is number => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
  };
  return {
    stack,
    matched: repos.length,
    total_repos: entries.length,
    delta: {
      quality: mean(repos.map(r => r.delta.quality)),
      tokens: mean(repos.map(r => r.delta.tokens)),
      time: mean(repos.map(r => r.delta.time)),
      win: repos.length > 0 && repos.every(r => r.delta.win),
    },
    repos,
  };
}

function scorecardPath(): string {

  return path.join(os.homedir(), '.klauro', 'gauntlet', 'corpus-scorecard.json');
}

async function loadScorecard(): Promise<CoverageReport['scorecard']> {
  try {
    const raw = await fs.readJson(scorecardPath());
    if (Array.isArray(raw?.results)) {
      return raw.results.map((r: any) => ({
        stack: r.stack, kind: r.kind, verdict: r.verdict,
        repo: r.repo, nodes: r.nodes, fns: r.fns,
      }));
    }
  } catch {   }
  return [];
}

export async function buildCoverageReport(): Promise<CoverageReport> {
  const analyzersRaw = getOrchestrator().listRegisteredAnalyzers();
  const scorecard = await loadScorecard();
  const verdictByStack = new Map(scorecard.map(s => [s.stack, s] as const));

  const analyzers: AnalyzerCoverage[] = analyzersRaw.map(a => {

    const sc = verdictByStack.get(a.id);
    return {
      ...a,
      ...(sc ? { verdict: sc.verdict, measured: sc.repo ? { repo: sc.repo, nodes: sc.nodes || 0, fns: sc.fns || 0 } : undefined } : {}),
    };
  });

  const totals = {
    languages: analyzers.filter(a => a.type === 'language').length,
    frameworks: analyzers.filter(a => a.type === 'framework').length,
    libraries: analyzers.filter(a => a.type === 'library').length,
    total: analyzers.length,
    incremental: analyzers.filter(a => a.incremental).length,
  };


  const entries = discoverAllRealRepoEntries(await listAnalyses());
  const fwCount = new Map<string, number>();
  for (const e of entries) for (const f of e.frameworks || []) fwCount.set(f, (fwCount.get(f) || 0) + 1);
  const corpusFrameworks = [...fwCount.entries()]
    .map(([name, repos]) => ({ name, repos }))
    .sort((a, b) => b.repos - a.repos);



  let quality: CoverageReport['quality'];
  try {
    const reports = await scoreAllFixtures();
    if (reports.length) {
      const fixtures = reports.map(r => ({
        fixture: r.fixture, stack: r.stack,
        precision: r.overall.precision, recall: r.overall.recall, f1: r.overall.f1,
      }));
      const mean = fixtures.reduce((a, f) => a + f.f1, 0) / fixtures.length;
      quality = { mean_f1: Math.round(mean * 1000) / 1000, fixtures };
    }
  } catch {   }

  return {
    generated_at: new Date().toISOString(),
    totals,
    corpus: { repos: entries.length, frameworks: corpusFrameworks },
    analyzers,
    scorecard,
    backlog: BACKLOG,
    ...(quality ? { quality } : {}),
  };
}
