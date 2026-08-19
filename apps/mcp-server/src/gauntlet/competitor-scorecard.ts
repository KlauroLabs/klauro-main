


























import * as path from 'path';
import type { ArmResult, WinVerdict } from './report-schema';



import { runRouteFactsBench, type FrameworkBenchResult } from './framework-bench';
import { runCallersBench, type PrimitiveBenchResult } from './primitive-bench';
import { runWasCrossRepoBench, type WasBenchResult } from './was-bench';
import { runOrmRelationsBench, type OrmBenchResult } from './orm-bench';
import { runComponentTreeBench, type ComponentBenchResult } from './component-bench';
import { buildCampCRoutesVsCbmReport, type CampCRoutesVsCbmReport } from './camp-c-routes-cbm';
import { buildDepthBehavioralDiffReport, type DepthBehavioralDiffReport } from './depth-behavioral-diff-bench';
import { buildFullGrid, type FullGridReport, type GridCell } from './full-grid';





export type Camp = 'A' | 'B' | 'C';
export type Verdict = 'win' | 'tie' | 'loss';

export interface ScorecardRow {


  camp: Camp;

  scenario: string;

  task: string;

  metric: string;


  klauro_score: number | null;

  best_competitor: string;

  best_competitor_score: number | null;


  verdict: Verdict;
}

export interface CampSummary {
  camp: Camp;

  label: string;

  target: string;
  rows: ScorecardRow[];
  wins: number;
  ties: number;
  losses: number;
}

export interface CompetitorScorecard {
  endpoint: string;
  timestamp: string;
  complete: boolean;
  runner_failures: Array<{ runner: keyof ScorecardRunners; error: string }>;
  camps: CampSummary[];
  totals: { wins: number; ties: number; losses: number; scenarios: number };

  zeroLosses: boolean;
}





const CAMP_A_COMPETITORS = new Set(['codebase-memory', 'codebase-memory-mcp', 'cbm']);
const CAMP_B_COMPETITORS = new Set([
  'ripgrep', 'ast-grep', 'ctags', 'scip-typescript', 'scip', 'stack-graphs',
  'embeddings-nomic', 'embeddings', 'nomic', 'all-minilm',
]);

function campForCompetitor(competitor: string): Camp {
  const c = competitor.toLowerCase();
  if (CAMP_A_COMPETITORS.has(c)) return 'A';
  if (CAMP_B_COMPETITORS.has(c) || c.startsWith('embeddings-')) return 'B';

  return 'C';
}






interface ArmBenchResult { fixture: string; arms: ArmResult[]; verdict: WinVerdict; }



function bestCompetitorArm(arms: ArmResult[]): { arm: ArmResult | null; attempted: boolean } {
  const others = arms.filter(a => a.arm_id !== 'klauro');
  const attempted = others.filter(a => a.attempted);
  if (attempted.length) {
    const best = attempted.reduce((a, b) =>
      (b.metrics.quality ?? 0) > (a.metrics.quality ?? 0) ? b : a);
    return { arm: best, attempted: true };
  }
  return { arm: others[0] ?? null, attempted: false };
}


function verdictFromWin(win: WinVerdict): Verdict {
  if (!win.klauro_wins) return 'loss';
  return win.quality_tied_at_ceiling ? 'tie' : 'win';
}

function rowFromArmBench(
  benchLabel: string,
  task: string,
  metric: string,
  result: ArmBenchResult,
): ScorecardRow {
  const klauro = result.arms.find(a => a.arm_id === 'klauro');
  const { arm: bestArm, attempted } = bestCompetitorArm(result.arms);
  const camp = bestArm ? campForCompetitor(bestArm.arm_id) : 'C';
  const klauroScore = typeof klauro?.metrics.quality === 'number' ? klauro.metrics.quality / 100 : null;


  const competitorScore =
    bestArm && attempted && typeof bestArm.metrics.quality === 'number'
      ? bestArm.metrics.quality / 100
      : null;
  return {
    camp,
    scenario: `${benchLabel}: ${result.fixture}`,
    task,
    metric,
    klauro_score: klauroScore,
    best_competitor: bestArm?.arm_id ?? 'none',
    best_competitor_score: competitorScore,
    verdict: verdictFromWin(result.verdict),
  };
}





function rowsFromCampCRoutes(report: CampCRoutesVsCbmReport): ScorecardRow[] {
  if (!report.available) throw new Error('codebase-memory was not available for the route comparison');
  return report.results.map(r => ({
    camp: 'A' as Camp,
    scenario: `camp-c-routes-vs-cbm: ${r.fixture}`,
    task: 'route-facts',
    metric: 'route-F1',
    klauro_score: r.klauroF1,
    best_competitor: 'codebase-memory',
    best_competitor_score: r.cbmF1,

    verdict: r.verdict === 'tie-ceiling' ? 'tie' : r.verdict,
  }));
}

function rowsFromBehavioralDiff(report: DepthBehavioralDiffReport): ScorecardRow[] {
  if (!report.available) throw new Error('codebase-memory was not available for the behavioral-diff comparison');
  return report.results.map(r => ({
    camp: 'A' as Camp,
    scenario: `depth-behavioral-diff-vs-cbm: ${r.fixture}`,
    task: 'behavioral-delta',
    metric: 'behavior-F1',
    klauro_score: r.klauroF1,
    best_competitor: 'codebase-memory',
    best_competitor_score: r.cbmF1,

    verdict: r.verdict,
  }));
}






function verdictFromGrid(v: GridCell['verdict']): Verdict {
  if (v === 'loss') return 'loss';
  if (v === 'ceiling-tie') return 'tie';
  return 'win';
}

function rowsFromFullGrid(report: FullGridReport): ScorecardRow[] {
  const rows: ScorecardRow[] = [];
  for (const cell of report.cells) {
    if (cell.verdict === 'uncovered') continue;


    const best = cell.armsRan.length ? cell.armsRan[0] : 'none';

    const camp = cell.armsRan.length
      ? cell.armsRan.map(campForCompetitor).sort()[0]
      : 'C';
    rows.push({
      camp,
      scenario: `full-grid: ${cell.rowKind}/${cell.row} [${cell.metric}]`,
      task: cell.metric,
      metric: 'cell-F1',
      klauro_score: cell.klauroF1,
      best_competitor: best,
      best_competitor_score: cell.competitorBestF1,
      verdict: verdictFromGrid(cell.verdict),
    });
  }
  return rows;
}







const FIXTURES = path.resolve(__dirname, '../../fixtures');

export interface ScorecardRunners {
  frameworkRoutes: () => Promise<ScorecardRow[]>;
  primitiveCallers: () => Promise<ScorecardRow[]>;
  campCRoutes: () => Promise<ScorecardRow[]>;
  behavioralDiff: () => Promise<ScorecardRow[]>;
  wasCrossRepo: () => Promise<ScorecardRow[]>;
  ormRelations: () => Promise<ScorecardRow[]>;
  componentTree: () => Promise<ScorecardRow[]>;
  fullGrid: () => Promise<ScorecardRow[]>;
}



export function defaultRunners(): ScorecardRunners {
  return {
    frameworkRoutes: async () => [
      rowFromArmBench('framework-routes', 'route-facts', 'quality-F1',
        (await runRouteFactsBench(path.join(FIXTURES, 'framework-bench', 'express-routes'))) as FrameworkBenchResult),
    ],
    primitiveCallers: async () => [
      rowFromArmBench('primitive-who-calls', 'who-calls', 'caller-F1',
        (await runCallersBench(path.join(FIXTURES, 'primitive-bench', 'callers-py'), { heavyArms: true })) as PrimitiveBenchResult),
    ],
    campCRoutes: async () => rowsFromCampCRoutes(await buildCampCRoutesVsCbmReport()),
    behavioralDiff: async () => rowsFromBehavioralDiff(await buildDepthBehavioralDiffReport()),
    wasCrossRepo: async () => [
      rowFromArmBench('was-cross-repo', 'cross-repo-links', 'link-F1',
        (await runWasCrossRepoBench(path.join(FIXTURES, 'was-bench', 'ui-api-worker'))) as WasBenchResult),
    ],
    ormRelations: async () => [
      rowFromArmBench('orm-relations', 'orm-relations', 'relation-F1',
        (await runOrmRelationsBench(path.join(FIXTURES, 'orm-bench', 'drizzle-rel'))) as OrmBenchResult),
    ],
    componentTree: async () => [
      rowFromArmBench('component-tree', 'component-tree', 'render-F1',
        (await runComponentTreeBench(path.join(FIXTURES, 'component-bench', 'react-tree'))) as ComponentBenchResult),
    ],
    fullGrid: async () => rowsFromFullGrid(await buildFullGrid()),
  };
}





export interface GenerateScorecardOptions {


  runners?: Partial<ScorecardRunners>;

  timestamp?: string;


  endpoint?: string;
}

const CAMP_META: Record<Camp, { label: string; target: string }> = {
  A: { label: 'Camp A — vs codebase-memory (DeusData)', target: 'tie-or-beat (Klauro never loses)' },
  B: { label: 'Camp B — vs structural indexers (ripgrep / ast-grep / ctags / scip / stack-graphs / embeddings)', target: 'win' },
  C: { label: 'Camp C — comprehension / out-of-category (routes, ORM, component tree, comprehension facts)', target: 'always win' },
};

export async function generateCompetitorScorecard(
  opts: GenerateScorecardOptions = {},
): Promise<CompetitorScorecard> {
  const runners: ScorecardRunners = { ...defaultRunners(), ...opts.runners };
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const endpoint =
    opts.endpoint ?? process.env.KLAURO_BENCH_ANALYZER_URL ?? 'in-process bench analyzer (offline)';



  const groups = await Promise.all(
    (Object.keys(runners) as (keyof ScorecardRunners)[]).map(async key => {
      try {
        const rows = await runners[key]();
        return { key, rows, error: rows.length === 0 ? 'runner returned no scenarios' : undefined };
      } catch (error) {
        return { key, rows: [] as ScorecardRow[], error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const rows = groups.flatMap(group => group.rows);
  const runnerFailures = groups
    .filter((group): group is typeof group & { error: string } => Boolean(group.error))
    .map(group => ({ runner: group.key, error: group.error }));

  const camps: CampSummary[] = (['A', 'B', 'C'] as Camp[]).map(camp => {
    const campRows = rows.filter(r => r.camp === camp);
    return {
      camp,
      label: CAMP_META[camp].label,
      target: CAMP_META[camp].target,
      rows: campRows,
      wins: campRows.filter(r => r.verdict === 'win').length,
      ties: campRows.filter(r => r.verdict === 'tie').length,
      losses: campRows.filter(r => r.verdict === 'loss').length,
    };
  });

  const totals = {
    wins: camps.reduce((a, c) => a + c.wins, 0),
    ties: camps.reduce((a, c) => a + c.ties, 0),
    losses: camps.reduce((a, c) => a + c.losses, 0),
    scenarios: rows.length,
  };

  const complete = runnerFailures.length === 0 &&
    camps.every(camp => camp.rows.length > 0) &&
    camps.filter(camp => camp.camp !== 'C').every(camp => camp.rows.some(row => row.best_competitor_score !== null));

  return {
    endpoint,
    timestamp,
    complete,
    runner_failures: runnerFailures,
    camps,
    totals,
    zeroLosses: complete && totals.losses === 0,
  };
}





function fmtScore(s: number | null): string {
  return s == null ? '—' : s.toFixed(2);
}

function verdictBadge(v: Verdict): string {
  return v === 'win' ? 'WIN' : v === 'tie' ? 'TIE' : 'LOSS';
}

export function renderScorecardMarkdown(report: CompetitorScorecard): string {
  const lines: string[] = [];
  lines.push('# Klauro Competitor Scorecard');
  lines.push('');
  lines.push(`- Endpoint: \`${report.endpoint}\``);
  lines.push(`- Generated: ${report.timestamp}`);
  lines.push(`- Evidence complete: ${report.complete ? 'yes' : 'no'}`);
  lines.push('');

  if (report.runner_failures.length > 0) {
    lines.push('## Runner failures');
    lines.push('');
    for (const failure of report.runner_failures) lines.push(`- ${failure.runner}: ${failure.error}`);
    lines.push('');
  }

  for (const camp of report.camps) {
    lines.push(`## ${camp.label}`);
    lines.push('');
    lines.push(`Target: ${camp.target} — ${camp.wins} win / ${camp.ties} tie / ${camp.losses} loss`);
    lines.push('');
    if (camp.rows.length === 0) {
      lines.push('_No scenarios recorded._');
      lines.push('');
      continue;
    }
    lines.push('| Scenario | Metric | Klauro | Best competitor | Verdict |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of camp.rows) {
      const comp = r.best_competitor_score == null
        ? `${r.best_competitor} (n/a)`
        : `${r.best_competitor} ${fmtScore(r.best_competitor_score)}`;
      lines.push(
        `| ${r.scenario} | ${r.metric} | ${fmtScore(r.klauro_score)} | ${comp} | ${verdictBadge(r.verdict)} |`,
      );
    }
    lines.push('');
  }

  const t = report.totals;
  lines.push('## Summary');
  lines.push('');
  lines.push(`Total: ${t.wins} win / ${t.ties} tie / ${t.losses} loss across ${t.scenarios} scenarios.`);
  lines.push('');
  lines.push(
    report.zeroLosses
      ? '**Zero losses** — Klauro ties-or-beats every competitor in every camp.'
      : !report.complete
        ? '**Incomplete evidence** — runner failures, missing camp coverage, or unmeasured competitors prevent a win claim.'
        : `**${t.losses} loss(es)** — a Klauro bug to fix; surfaced, never hidden.`,
  );
  lines.push('');
  return lines.join('\n');
}





function parseArgs(argv: string[]): { out?: string; md?: string } {
  const out: { out?: string; md?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--md') out.md = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {

  const fsMod = await import('fs-extra');
  const fs: typeof import('fs-extra') = (fsMod as any).default ?? fsMod;
  const { out, md } = parseArgs(process.argv.slice(2));
  const report = await generateCompetitorScorecard({ timestamp: new Date().toISOString() });
  const markdown = renderScorecardMarkdown(report);

  if (out) {
    await fs.writeJson(out, report, { spaces: 2 });
    console.error(`[scorecard] wrote JSON -> ${out}`);
  }
  if (md) {
    await fs.writeFile(md, markdown, 'utf8');
    console.error(`[scorecard] wrote markdown -> ${md}`);
  }
  if (!out && !md) {

    process.stdout.write(markdown);
  }
  if (!report.complete || !report.zeroLosses) process.exitCode = 1;
}


if (require.main === module) {
  main().catch(err => {
    console.error('[scorecard] failed:', err);
    process.exit(1);
  });
}
