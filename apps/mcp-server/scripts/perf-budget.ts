/**
 * perf:budget — the enforced latency-budget gate (task #115).
 *
 * Runs the REAL product analysis path (analyzeProjectLayered, same function
 * the MCP server/CLI call) against the two pinned reference fixtures under
 * fixtures/perf-budget/{small,medium}, measuring:
 *   - time-to-L0 (the l0 promise resolving — pure filesystem walk, no
 *     analyzer-pipeline dependency)
 *   - deterministic-pass wall time (the rest promise — orchestrateAnalysis
 *     via analyzeProjectDeferred, i.e. L1-L4)
 *   - per-phase breakdown, read from the same AnalysisRunLog record that
 *     KLAURO_DEBUG_ANALYZER_PHASES=1 prints to stderr (packages/analyzer-core/
 *     src/analyzer/core/run-log.ts), so this gate and that debug flag always
 *     agree on phase names.
 *
 * Compares actuals against fixtures/perf-budget/budgets.json. Any exceeded
 * budget (L0, deterministic wall time, or any named phase ceiling) prints a
 * clear actual-vs-budget table and exits nonzero.
 *
 * Every run appends one record to ~/.klauro/logs/perf-budget.jsonl (or
 * $KLAURO_LOG_DIR/perf-budget.jsonl) so trends are visible over time,
 * independent of pass/fail.
 *
 * This is a NAMED gate step (npm run perf:budget), not part of the default
 * test suite — it is too slow to run on every `npm test`.
 *
 * Usage:
 *   npm run perf:budget
 *   npm run perf:budget -- --budgets=/path/to/alternate-budgets.json
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { analyzeProjectLayered } from '../src/analyzer';
import { getAnalysisRunLogPath, type AnalysisRunFinalRecord, type AnalysisRunRecord } from '../../../packages/analyzer-core/src/analyzer/core/run-log';

const FIXTURES_ROOT = path.resolve(__dirname, '..', 'fixtures', 'perf-budget');
const DEFAULT_BUDGETS_PATH = path.join(FIXTURES_ROOT, 'budgets.json');

interface PhaseBudgets {
  [phase: string]: number;
}

interface FixtureBudget {
  l0_ms: number;
  deterministic_ms: number;
  phases: PhaseBudgets;
}

interface BudgetsFile {
  fixtures: Record<string, FixtureBudget>;
}

interface MeasuredPhase {
  phase: string;
  duration_ms: number;
}

interface FixtureMeasurement {
  fixture: string;
  file_count: number;
  l0_ms: number;
  deterministic_ms: number;
  phases: MeasuredPhase[];
  nodes: number;
  edges: number;
}

interface GateRow {
  fixture: string;
  metric: string;
  actual_ms: number;
  budget_ms: number;
  pass: boolean;
}

function parseArgs(argv: string[]): { budgetsPath: string } {
  const budgetsArg = argv.find((arg) => arg.startsWith('--budgets='));
  return {
    budgetsPath: budgetsArg ? path.resolve(budgetsArg.slice('--budgets='.length)) : DEFAULT_BUDGETS_PATH,
  };
}

async function countFiles(root: string): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        count += 1;
      }
    }
  };
  await walk(root);
  return count;
}

async function readLatestRunCompleteRecord(runLogPath: string, sinceMs: number): Promise<AnalysisRunFinalRecord | null> {
  if (!(await fs.pathExists(runLogPath))) return null;
  const content = await fs.readFile(runLogPath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  let latest: AnalysisRunFinalRecord | null = null;
  for (const line of lines) {
    let record: AnalysisRunRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.event !== 'run-complete') continue;
    const endedAtMs = Date.parse(record.ended_at);
    if (endedAtMs < sinceMs) continue;
    if (!latest || endedAtMs > Date.parse(latest.ended_at)) {
      latest = record;
    }
  }
  return latest;
}

async function measureFixture(name: string, projectPath: string, runLogPath: string): Promise<FixtureMeasurement> {
  const fileCount = await countFiles(projectPath);
  const overallStart = Date.now();

  const { l0, rest } = await analyzeProjectLayered(projectPath, `perf-budget-${name}`);
  await l0;
  const l0Ms = Date.now() - overallStart;

  const restStart = Date.now();
  const deferred = await rest;
  const deterministicMs = Date.now() - restStart;

  const runRecord = await readLatestRunCompleteRecord(runLogPath, restStart);
  const phases: MeasuredPhase[] = (runRecord?.phases ?? []).map((p) => ({ phase: p.phase, duration_ms: p.duration_ms }));

  return {
    fixture: name,
    file_count: fileCount,
    l0_ms: l0Ms,
    deterministic_ms: deterministicMs,
    phases,
    nodes: deferred.output.nodes?.length ?? 0,
    edges: deferred.output.edges?.length ?? 0,
  };
}

function evaluateGate(measurement: FixtureMeasurement, budget: FixtureBudget): GateRow[] {
  const rows: GateRow[] = [];
  rows.push({
    fixture: measurement.fixture,
    metric: 'time-to-L0',
    actual_ms: measurement.l0_ms,
    budget_ms: budget.l0_ms,
    pass: measurement.l0_ms <= budget.l0_ms,
  });
  rows.push({
    fixture: measurement.fixture,
    metric: 'deterministic-pass',
    actual_ms: measurement.deterministic_ms,
    budget_ms: budget.deterministic_ms,
    pass: measurement.deterministic_ms <= budget.deterministic_ms,
  });

  const phaseTotals = new Map<string, number>();
  for (const p of measurement.phases) {
    phaseTotals.set(p.phase, (phaseTotals.get(p.phase) ?? 0) + p.duration_ms);
  }

  for (const [phase, ceiling] of Object.entries(budget.phases)) {
    const actual = phaseTotals.get(phase) ?? 0;
    rows.push({
      fixture: measurement.fixture,
      metric: `phase:${phase}`,
      actual_ms: actual,
      budget_ms: ceiling,
      pass: actual <= ceiling,
    });
  }

  return rows;
}

function formatTable(rows: GateRow[]): string {
  const header = ['fixture', 'metric', 'actual_ms', 'budget_ms', 'result'];
  const lines: string[][] = [header];
  for (const row of rows) {
    lines.push([
      row.fixture,
      row.metric,
      String(row.actual_ms),
      String(row.budget_ms),
      row.pass ? 'PASS' : `FAIL (+${row.actual_ms - row.budget_ms}ms over)`,
    ]);
  }
  const widths = header.map((_, col) => Math.max(...lines.map((line) => line[col].length)));
  return lines
    .map((line) => line.map((cell, col) => cell.padEnd(widths[col])).join('  '))
    .join('\n');
}

function getLogDir(): string {
  if (process.env.KLAURO_LOG_DIR) return process.env.KLAURO_LOG_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.klauro', 'logs');
}

async function appendHistory(entry: Record<string, unknown>): Promise<void> {
  const logDir = getLogDir();
  await fs.ensureDir(logDir);
  const historyPath = path.join(logDir, 'perf-budget.jsonl');
  await fs.appendFile(historyPath, `${JSON.stringify(entry)}\n`);
}

async function main(): Promise<void> {
  const { budgetsPath } = parseArgs(process.argv.slice(2));
  const budgetsFile: BudgetsFile = await fs.readJson(budgetsPath);
  const runLogPath = getAnalysisRunLogPath();

  const fixtureNames = Object.keys(budgetsFile.fixtures);
  const measurements: FixtureMeasurement[] = [];
  const allRows: GateRow[] = [];

  for (const name of fixtureNames) {
    const projectPath = path.join(FIXTURES_ROOT, name);
    if (!(await fs.pathExists(projectPath))) {
      throw new Error(`Fixture "${name}" not found at ${projectPath}. Run: npx tsx scripts/generate-perf-fixtures.ts`);
    }
    console.log(`analyzing fixture "${name}" at ${projectPath} ...`);
    const measurement = await measureFixture(name, projectPath, runLogPath);
    measurements.push(measurement);
    allRows.push(...evaluateGate(measurement, budgetsFile.fixtures[name]));
  }

  const table = formatTable(allRows);
  console.log('');
  console.log(table);
  console.log('');

  const failures = allRows.filter((row) => !row.pass);
  const passed = failures.length === 0;

  await appendHistory({
    timestamp: new Date().toISOString(),
    budgets_path: budgetsPath,
    passed,
    measurements,
    rows: allRows,
  });

  if (!passed) {
    console.error(`perf:budget FAILED — ${failures.length} budget(s) exceeded:`);
    for (const failure of failures) {
      console.error(`  ${failure.fixture} / ${failure.metric}: ${failure.actual_ms}ms > budget ${failure.budget_ms}ms`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('perf:budget PASSED — all fixtures within budget.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
