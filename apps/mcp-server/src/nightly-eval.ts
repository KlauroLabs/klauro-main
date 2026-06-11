import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { isDirectCliInvocation } from './cli-invocation';
import { loadAnalysis } from './storage';
import { getProductMap } from './query';
import { buildCrossRepoRouteDrift } from './product';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const OUTPUT_DIR = '/tmp/klauro-nightly-eval';
const SCORECARD_PATH = path.join(REPO_ROOT, 'docs', 'mcp', 'SCORECARD.md');
const TREND_BEGIN = '<!-- trend:begin -->';
const TREND_END = '<!-- trend:end -->';
const MAX_TREND_ROWS = 30;

export type SuiteStatus = 'pass' | 'warn' | 'fail' | 'timeout' | 'error';

export interface SuiteResult {
  suite: string;
  status: SuiteStatus;
  durationMs: number;
  detail: string;
  metrics: Record<string, unknown>;
}

export interface AnswerPackCheck {
  id: string;
  question: string;
  invariant: string;
  observed: string;
  status: 'pass' | 'fail';
}

export interface NightlyEvalRun {
  generatedAt: string;
  status: SuiteStatus;
  durationMs: number;
  suites: SuiteResult[];
  answerPackChecks: AnswerPackCheck[];
}

interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runBoundedCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutSeconds: number }
): CommandOutcome {
  const startedAt = Date.now();
  const hasGtimeout = spawnSync('which', ['gtimeout']).status === 0;
  const invocation = hasGtimeout
    ? { command: 'gtimeout', args: [String(options.timeoutSeconds), command, ...args] }
    : { command, args };

  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: hasGtimeout ? undefined : options.timeoutSeconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });

  const timedOut = hasGtimeout
    ? result.status === 124
    : result.signal === 'SIGTERM' && result.status === null;

  return {
    exitCode: result.status,
    timedOut,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    durationMs: Date.now() - startedAt,
  };
}

async function runAnalysisGauntletSuite(): Promise<SuiteResult> {
  const reportPath = path.join(OUTPUT_DIR, 'analysis-gauntlet.json');
  const outcome = runBoundedCommand(
    'npm',
    ['run', 'analysis-gauntlet', '--', '--output', reportPath],
    { cwd: PACKAGE_ROOT, timeoutSeconds: 600 }
  );

  if (outcome.timedOut) {
    return suiteResult('analysis-gauntlet', 'timeout', outcome.durationMs, 'Gauntlet exceeded 600s bound', {});
  }

  if (!await fs.pathExists(reportPath)) {
    return suiteResult('analysis-gauntlet', 'error', outcome.durationMs,
      `Gauntlet produced no report (exit ${outcome.exitCode}): ${tail(outcome.stderr || outcome.stdout)}`, {});
  }

  const report = await fs.readJson(reportPath);
  const status: SuiteStatus = report.status === 'pass' ? 'pass' : report.status === 'warn' ? 'warn' : 'fail';
  return suiteResult('analysis-gauntlet', status, outcome.durationMs,
    `${report.targets?.length || 0} truth fixtures, score ${report.score}/100`, {
      score: report.score,
      targets: report.targets?.length || 0,
      failing_targets: (report.targets || [])
        .filter((target: { status: string }) => target.status === 'fail')
        .map((target: { name: string }) => target.name),
    });
}

function runStabilitySuite(): SuiteResult {
  const analyzerCoreRoot = path.join(REPO_ROOT, 'packages', 'analyzer-core');
  const testFile = 'src/__tests__/ai/run-stability.test.ts';
  const outcome = runBoundedCommand(
    'npx',
    ['jest', testFile, '--silent'],
    { cwd: analyzerCoreRoot, timeoutSeconds: 420 }
  );

  if (outcome.timedOut) {
    return suiteResult('run-stability', 'timeout', outcome.durationMs, 'Stability jest run exceeded 420s bound', {});
  }

  const status: SuiteStatus = outcome.exitCode === 0 ? 'pass' : 'fail';
  const detail = status === 'pass'
    ? 'Deterministic re-analysis verdict: stable'
    : `jest exit ${outcome.exitCode}: ${tail(outcome.stderr || outcome.stdout)}`;
  return suiteResult('run-stability', status, outcome.durationMs, detail, { test_file: testFile });
}

async function loadStoredAnalysis(projectPath: string): Promise<CASOutput | null> {
  try {
    return await loadAnalysis(projectPath);
  } catch {
    return null;
  }
}

export function evaluateAnswerPackChecks(input: {
  rails: CASOutput | null;
  truckspyApp: CASOutput | null;
  truckspyUi: CASOutput | null;
  truckspyAppPath: string;
  truckspyUiPath: string;
}): AnswerPackCheck[] {
  const checks: AnswerPackCheck[] = [];
  const record = (id: string, question: string, invariant: string, observed: string, pass: boolean) => {
    checks.push({ id, question, invariant, observed, status: pass ? 'pass' : 'fail' });
  };

  const railsEntryPoints = input.rails?.entry_points?.length ?? -1;
  record(
    'rails-entry-point-sanity',
    'Does the rails-work-orders truth fixture expose a sane entry point count?',
    'between 2 and 100 entry points',
    input.rails ? `${railsEntryPoints} entry points` : 'analysis not loaded',
    railsEntryPoints >= 2 && railsEntryPoints <= 100
  );

  const journeys = input.truckspyApp?.user_journeys || [];
  const journeysWithTerminals = journeys.filter(journey => (journey.terminal_entities || []).length > 0);
  record(
    'truckspy-journeys-terminal-entities',
    'Does truckspyapp surface user journeys that terminate in concrete entities?',
    'at least 1 journey, at least 1 with terminal entities',
    input.truckspyApp
      ? `${journeys.length} journeys, ${journeysWithTerminals.length} with terminal entities`
      : 'analysis not loaded',
    journeys.length >= 1 && journeysWithTerminals.length >= 1
  );

  const paradigms = input.truckspyApp?.paradigm_conformance || [];
  const cohorts = paradigms.filter(paradigm => (paradigm.adoption?.comparable_count ?? 0) > 0);
  record(
    'truckspy-paradigm-cohorts',
    'Does truckspyapp report paradigm conformance with populated adoption cohorts?',
    'at least 1 paradigm with a comparable cohort',
    input.truckspyApp
      ? `${paradigms.length} paradigms, ${cohorts.length} with cohorts`
      : 'analysis not loaded',
    cohorts.length >= 1
  );

  let productMapLines = -1;
  if (input.rails) {
    const rendered = getProductMap(input.rails, { format: 'markdown' }) as { markdown?: string };
    productMapLines = rendered.markdown ? rendered.markdown.split('\n').length : -1;
  }
  record(
    'rails-product-map-renders',
    'Does the rails-work-orders product map render compactly as markdown?',
    'renders and stays under 150 lines',
    productMapLines >= 0 ? `${productMapLines} lines` : 'did not render',
    productMapLines > 0 && productMapLines < 150
  );

  let driftCount = -1;
  if (input.truckspyApp && input.truckspyUi) {
    driftCount = buildCrossRepoRouteDrift([
      { path: input.truckspyAppPath, name: 'truckspyapp', cas: input.truckspyApp },
      { path: input.truckspyUiPath, name: 'truckspyui', cas: input.truckspyUi },
    ]).length;
  }
  record(
    'truckspy-route-drift-bounded',
    'Is route drift between truckspyui and truckspyapp computable and bounded?',
    'drift computes with 0 to 200 findings',
    driftCount >= 0 ? `${driftCount} drift findings` : 'pair not loaded',
    driftCount >= 0 && driftCount <= 200
  );

  return checks;
}

async function runAnswerPackSuite(): Promise<{ result: SuiteResult; checks: AnswerPackCheck[] }> {
  const startedAt = Date.now();
  const railsPath = path.join(PACKAGE_ROOT, 'fixtures', 'analysis-truth', 'rails-work-orders');
  const truckspyAppPath = process.env.KLAURO_EVAL_TRUCKSPY_APP
    || path.join(os.homedir(), 'dev', 'clients', 'outcode', 'truckspy', 'truckspyapp');
  const truckspyUiPath = process.env.KLAURO_EVAL_TRUCKSPY_UI
    || path.join(os.homedir(), 'dev', 'clients', 'outcode', 'truckspy', 'truckspyui');

  const [rails, truckspyApp, truckspyUi] = await Promise.all([
    loadStoredAnalysis(railsPath),
    loadStoredAnalysis(truckspyAppPath),
    loadStoredAnalysis(truckspyUiPath),
  ]);

  const checks = evaluateAnswerPackChecks({ rails, truckspyApp, truckspyUi, truckspyAppPath, truckspyUiPath });
  const failing = checks.filter(check => check.status === 'fail');
  const result = suiteResult(
    'answer-pack',
    failing.length === 0 ? 'pass' : 'fail',
    Date.now() - startedAt,
    `${checks.length - failing.length}/${checks.length} invariant questions held`,
    { failing: failing.map(check => check.id) }
  );
  return { result, checks };
}

function runBundleSmokeSuite(): SuiteResult {
  const outcome = runBoundedCommand('npm', ['run', 'smoke:bundle'], {
    cwd: PACKAGE_ROOT,
    timeoutSeconds: 300,
  });

  if (outcome.timedOut) {
    return suiteResult('bundle-smoke', 'timeout', outcome.durationMs, 'Bundle smoke exceeded 300s bound', {});
  }

  const initMatches = [...outcome.stdout.matchAll(/(core|full): initialize answered in (\d+)ms/g)];
  const initMs: Record<string, number> = {};
  for (const match of initMatches) initMs[match[1]] = Number(match[2]);

  const status: SuiteStatus = outcome.exitCode === 0 ? 'pass' : 'fail';
  const detail = status === 'pass'
    ? `Bundle initialized (core ${initMs.core ?? '?'}ms, full ${initMs.full ?? '?'}ms)`
    : `smoke:bundle exit ${outcome.exitCode}: ${tail(outcome.stderr || outcome.stdout)}`;
  return suiteResult('bundle-smoke', status, outcome.durationMs, detail, { init_ms: initMs });
}

function suiteResult(
  suite: string,
  status: SuiteStatus,
  durationMs: number,
  detail: string,
  metrics: Record<string, unknown>
): SuiteResult {
  return { suite, status, durationMs, detail, metrics };
}

function tail(text: string, maxLength = 400): string {
  const trimmed = text.trim();
  return trimmed.length <= maxLength ? trimmed : `...${trimmed.slice(-maxLength)}`;
}

function aggregateStatus(suites: SuiteResult[]): SuiteStatus {
  if (suites.some(suite => suite.status === 'fail' || suite.status === 'error' || suite.status === 'timeout')) return 'fail';
  if (suites.some(suite => suite.status === 'warn')) return 'warn';
  return 'pass';
}

export function formatScorecardRow(run: NightlyEvalRun): string {
  const bySuite = new Map(run.suites.map(suite => [suite.suite, suite]));
  const gauntlet = bySuite.get('analysis-gauntlet');
  const stability = bySuite.get('run-stability');
  const answerPack = bySuite.get('answer-pack');
  const bundle = bySuite.get('bundle-smoke');

  const gauntletCell = gauntlet
    ? `${gauntlet.status} ${typeof gauntlet.metrics.score === 'number' ? `${gauntlet.metrics.score}/100` : '-'}`
    : 'missing';
  const answerPassCount = run.answerPackChecks.filter(check => check.status === 'pass').length;
  const answerCell = answerPack
    ? `${answerPack.status} ${answerPassCount}/${run.answerPackChecks.length}`
    : 'missing';
  const initMs = bundle?.metrics.init_ms as Record<string, number> | undefined;
  const bundleCell = bundle
    ? `${bundle.status} ${typeof initMs?.core === 'number' ? `${initMs.core}ms` : '-'}`
    : 'missing';

  return [
    '',
    run.generatedAt.slice(0, 16).replace('T', ' '),
    run.status,
    gauntletCell,
    stability ? stability.status : 'missing',
    answerCell,
    bundleCell,
    `${Math.round(run.durationMs / 1000)}s`,
    '',
  ].join(' | ').trim();
}

export function extractTrendRows(markdown: string): string[] {
  const beginIndex = markdown.indexOf(TREND_BEGIN);
  const endIndex = markdown.indexOf(TREND_END);
  if (beginIndex < 0 || endIndex < 0 || endIndex <= beginIndex) return [];
  return markdown
    .slice(beginIndex + TREND_BEGIN.length, endIndex)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && !line.startsWith('| Date') && !line.startsWith('| ---'));
}

export function renderScorecard(run: NightlyEvalRun, previousTrendRows: string[]): string {
  const trendRows = [...previousTrendRows, formatScorecardRow(run)].slice(-MAX_TREND_ROWS);
  const lines: string[] = [];

  lines.push('# Klauro Nightly Eval Scorecard');
  lines.push('');
  lines.push('Living quality scorecard generated by `npm run nightly-eval` from `apps/mcp-server/`.');
  lines.push('Do not edit the run sections by hand; each run rewrites this file and appends one trend row.');
  lines.push('');
  lines.push(`## Latest Run: ${run.generatedAt}`);
  lines.push('');
  lines.push(`- Overall: **${run.status.toUpperCase()}**`);
  lines.push(`- Total runtime: ${Math.round(run.durationMs / 1000)}s`);
  lines.push(`- Machine artifact: \`/tmp/klauro-nightly-eval/latest.json\``);
  lines.push('');
  lines.push('| Suite | Status | Duration | Detail |');
  lines.push('| --- | --- | --- | --- |');
  for (const suite of run.suites) {
    lines.push(`| ${suite.suite} | ${suite.status} | ${Math.round(suite.durationMs / 1000)}s | ${suite.detail} |`);
  }
  lines.push('');
  lines.push('### Answer Pack Invariants');
  lines.push('');
  lines.push('| Check | Status | Invariant | Observed |');
  lines.push('| --- | --- | --- | --- |');
  for (const check of run.answerPackChecks) {
    lines.push(`| ${check.id} | ${check.status} | ${check.invariant} | ${check.observed} |`);
  }
  lines.push('');
  lines.push(`## Trend (last ${MAX_TREND_ROWS} runs)`);
  lines.push('');
  lines.push(TREND_BEGIN);
  lines.push('| Date (UTC) | Overall | Gauntlet | Stability | Answer Pack | Bundle Init | Runtime |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  lines.push(...trendRows);
  lines.push(TREND_END);
  lines.push('');
  lines.push('## Schedule');
  lines.push('');
  lines.push('The eval runs nightly at 02:00 local time via launchd.');
  lines.push('');
  lines.push('Install:');
  lines.push('');
  lines.push('```bash');
  lines.push('cp apps/mcp-server/scripts/com.klauro.nightly-eval.plist ~/Library/LaunchAgents/');
  lines.push('launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.klauro.nightly-eval.plist');
  lines.push('```');
  lines.push('');
  lines.push('Uninstall:');
  lines.push('');
  lines.push('```bash');
  lines.push('launchctl bootout gui/$(id -u)/com.klauro.nightly-eval');
  lines.push('rm ~/Library/LaunchAgents/com.klauro.nightly-eval.plist');
  lines.push('```');
  lines.push('');
  lines.push('Verify and run on demand:');
  lines.push('');
  lines.push('```bash');
  lines.push('launchctl list | grep com.klauro.nightly-eval');
  lines.push('launchctl kickstart gui/$(id -u)/com.klauro.nightly-eval');
  lines.push('tail -f /tmp/klauro-nightly-eval/cron.log');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

async function writeArtifacts(run: NightlyEvalRun): Promise<void> {
  await fs.ensureDir(OUTPUT_DIR);
  await fs.writeJson(path.join(OUTPUT_DIR, 'latest.json'), run, { spaces: 2 });

  const previous = await fs.pathExists(SCORECARD_PATH)
    ? await fs.readFile(SCORECARD_PATH, 'utf8')
    : '';
  await fs.ensureDir(path.dirname(SCORECARD_PATH));
  await fs.writeFile(SCORECARD_PATH, renderScorecard(run, extractTrendRows(previous)));
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await fs.ensureDir(OUTPUT_DIR);
  const suites: SuiteResult[] = [];
  let answerPackChecks: AnswerPackCheck[] = [];

  const stages: Array<{ name: string; run: () => Promise<SuiteResult> }> = [
    { name: 'analysis-gauntlet', run: runAnalysisGauntletSuite },
    { name: 'run-stability', run: async () => runStabilitySuite() },
    {
      name: 'answer-pack',
      run: async () => {
        const { result, checks } = await runAnswerPackSuite();
        answerPackChecks = checks;
        return result;
      },
    },
    { name: 'bundle-smoke', run: async () => runBundleSmokeSuite() },
  ];

  for (const stage of stages) {
    console.log(`[nightly-eval] running ${stage.name}`);
    try {
      const result = await stage.run();
      suites.push(result);
      console.log(`[nightly-eval] ${stage.name}: ${result.status} (${Math.round(result.durationMs / 1000)}s) ${result.detail}`);
    } catch (error) {
      const failure = suiteResult(stage.name, 'error', 0, error instanceof Error ? error.message : String(error), {});
      suites.push(failure);
      console.error(`[nightly-eval] ${stage.name}: error ${failure.detail}`);
    }
  }

  const run: NightlyEvalRun = {
    generatedAt: new Date().toISOString(),
    status: aggregateStatus(suites),
    durationMs: Date.now() - startedAt,
    suites,
    answerPackChecks,
  };

  await writeArtifacts(run);
  console.log(`[nightly-eval] overall: ${run.status} in ${Math.round(run.durationMs / 1000)}s`);
  console.log(`[nightly-eval] scorecard: ${SCORECARD_PATH}`);
  process.exit(run.status === 'fail' ? 1 : 0);
}

if (isDirectCliInvocation('nightly-eval')) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
