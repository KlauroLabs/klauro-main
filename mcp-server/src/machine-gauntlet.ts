import * as fs from 'fs-extra';
import * as path from 'path';
import pLimit from 'p-limit';
import { getOrchestrator } from './analyzer';
import { evaluateAgentReadiness } from './agent-adoption';
import { runAgentIdiomBenchmark } from './agent-idiom-benchmark';
import { runIncrementalValueBenchmark } from './incremental-benchmark';
import { discoverRealRepos, type RealRepoTarget } from './repo-discovery';

type GateStatus = 'pass' | 'warn' | 'fail';

interface Gate {
  id: string;
  status: GateStatus;
  score: number;
  detail: string;
}

interface ParsedArgs {
  devRoot: string;
  maxTargets?: number;
  outputPath: string;
  markdownPath: string;
  workRoot?: string;
  runLive: boolean;
  agentWithCommand?: string;
  agentWithoutCommand?: string;
  orchestratorCommand?: string;
  testCommand?: string;
  maxLiveTasks?: number;
  timeoutMs?: number;
  testTimeoutMs?: number;
  discardWorkspaces: boolean;
  analysisConcurrency?: number;
  incrementalConcurrency?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let outputPath = path.join(process.cwd(), '.unravl-agent-proof-machine', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.unravl-agent-proof-machine', 'latest-report.md');
  let maxTargets: number | undefined;
  let workRoot: string | undefined;
  let runLive = true;
  let agentWithCommand: string | undefined;
  let agentWithoutCommand: string | undefined;
  let orchestratorCommand: string | undefined;
  let testCommand: string | undefined;
  let maxLiveTasks: number | undefined;
  let timeoutMs: number | undefined;
  let testTimeoutMs: number | undefined;
  let discardWorkspaces = true;
  let analysisConcurrency = 1;
  let incrementalConcurrency = 1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dev-root') devRoot = path.resolve(argv[++i]);
    else if (arg === '--max-targets') maxTargets = Number(argv[++i]);
    else if (arg === '--output') outputPath = path.resolve(argv[++i]);
    else if (arg === '--markdown') markdownPath = path.resolve(argv[++i]);
    else if (arg === '--work-root') workRoot = path.resolve(argv[++i]);
    else if (arg === '--no-live') runLive = false;
    else if (arg === '--agent-with-cmd') agentWithCommand = argv[++i];
    else if (arg === '--agent-without-cmd') agentWithoutCommand = argv[++i];
    else if (arg === '--orchestrator-cmd' || arg === '--evaluator-cmd') orchestratorCommand = argv[++i];
    else if (arg === '--test-command') testCommand = argv[++i];
    else if (arg === '--max-live-tasks') maxLiveTasks = Number(argv[++i]);
    else if (arg === '--timeout-ms') timeoutMs = Number(argv[++i]);
    else if (arg === '--test-timeout-ms') testTimeoutMs = Number(argv[++i]);
    else if (arg === '--analysis-concurrency') analysisConcurrency = Number(argv[++i]);
    else if (arg === '--incremental-concurrency') incrementalConcurrency = Number(argv[++i]);
    else if (arg === '--keep-workspaces') discardWorkspaces = false;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return {
    devRoot,
    maxTargets,
    outputPath,
    markdownPath,
    workRoot,
    runLive,
    agentWithCommand,
    agentWithoutCommand,
    orchestratorCommand,
    testCommand,
    maxLiveTasks,
    timeoutMs,
    testTimeoutMs,
    discardWorkspaces,
    analysisConcurrency,
    incrementalConcurrency,
  };
}

function printHelp(): void {
  console.log([
    'Usage: npm run agent-proof-machine -- [options]',
    '',
    'Options:',
    '  --dev-root /path               Root to discover real Git repos under. Default ~/dev.',
    '  --max-targets n                Limit eligible repos for expensive analysis/proof while still reporting all discovered repos.',
    '  --no-live                      Skip live idiom A/B gate. The report will fail the live-proof gate.',
    '  --agent-with-cmd command       Live with-Unravl agent command template.',
    '  --agent-without-cmd command    Live without-Unravl agent command template.',
    '  --orchestrator-cmd command     Optional external evaluator command template.',
    '  --test-command command         Optional command to run in copied repos after live agents.',
    '  --work-root /path              Directory for copied repos and benchmark artifacts.',
    '  --max-live-tasks n             Maximum live idiom task pairs.',
    '  --analysis-concurrency n       Number of repo analyses to run concurrently. Default 1.',
    '  --incremental-concurrency n    Number of incremental repo checks to run concurrently. Default 1. Values above 1 are capped by the incremental benchmark.',
    '  --keep-workspaces              Keep copied repo workspaces.',
    '  --output /path/report.json     Write JSON report.',
    '  --markdown /path/report.md     Write Markdown report.',
  ].join('\n'));
}

export async function runMachineAgentProof(options: ParsedArgs) {
  const discovery = await discoverRealRepos(options.devRoot);
  const eligible = discovery.repos.filter(repo => repo.status === 'eligible');
  const selectedEligible = eligible.slice(0, options.maxTargets || eligible.length);
  const selectedPaths = new Set(selectedEligible.map(repo => repo.path));
  const unselectedEligible = eligible.filter(repo => !selectedPaths.has(repo.path));
  const limit = pLimit(Math.max(1, options.analysisConcurrency || 3));
  const repoResults = await Promise.all(selectedEligible.map(repo => limit(() => analyzeRepoForMachineProof(repo))));

  async function analyzeRepoForMachineProof(repo: RealRepoTarget) {
    const startedAt = Date.now();
    logMachineProgress(`analyzing ${repo.name} (${repo.path})`);
    try {
      const cas = await getOrchestrator().orchestrateAnalysis(repo.path);
      const readiness = evaluateAgentReadiness(cas, repo.path);
      logMachineProgress(`analyzed ${repo.name} in ${Date.now() - startedAt}ms`);
      return {
        ...repo,
        proof_status: cas.analysis_errors?.length ? 'fail' : readiness.default_use && (cas.codebase_idioms?.length || 0) > 0 ? 'pass' : 'fail',
        analysis_ms: Date.now() - startedAt,
        cas: {
          nodes: cas.nodes.length,
          edges: cas.edges.length,
          entry_points: cas.entry_points?.length || 0,
          exit_points: cas.exit_points?.length || 0,
          behavioral_invariants: cas.behavioral_invariants?.length || 0,
          codebase_idioms: cas.codebase_idioms?.length || 0,
          analysis_errors: cas.analysis_errors?.length || 0,
        },
        readiness: {
          status: readiness.status,
          score: readiness.score,
          default_use: readiness.default_use,
          gaps: readiness.adoption_gaps,
        },
      };
    } catch (error) {
      logMachineProgress(`failed ${repo.name} in ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
      return {
        ...repo,
        proof_status: 'fail',
        analysis_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const incremental = selectedEligible.length > 0
    ? await runIncrementalValueBenchmark({
      repos: selectedEligible.map(repo => ({ name: repo.name, path: repo.path })),
      maxTargets: selectedEligible.length,
      workRoot: options.workRoot ? path.join(options.workRoot, 'incremental') : undefined,
      verifyFull: false,
      keepWorkspaces: !options.discardWorkspaces,
      quiet: true,
      concurrency: options.incrementalConcurrency || 3,
      progress: event => {
        if (event.stage === 'start') {
          logMachineProgress(`incremental ${event.target} (${event.path})`);
        } else if (event.stage === 'complete') {
          logMachineProgress(`incremental ${event.target} complete in ${event.duration_ms}ms`);
        } else {
          logMachineProgress(`incremental ${event.target} failed in ${event.duration_ms}ms: ${event.error}`);
        }
      },
    })
    : null;

  const liveConfigured = Boolean(options.agentWithCommand && options.agentWithoutCommand);
  const idiomTargets = selectIdiomProofTargets(selectedEligible, repoResults, Math.max(3, options.maxLiveTasks || 3));
  const idiomBenchmark = options.runLive || liveConfigured
    ? await runAgentIdiomBenchmark({
      repos: idiomTargets.map(repo => ({ name: repo.name, path: repo.path })),
      maxTargets: idiomTargets.length,
      maxTasksPerRepo: 2,
      commands: {
        withUnravl: options.agentWithCommand,
        withoutUnravl: options.agentWithoutCommand,
        orchestrator: options.orchestratorCommand,
        testCommand: options.testCommand,
        workRoot: options.workRoot ? path.join(options.workRoot, 'idiom-live') : undefined,
        maxLiveTasks: options.maxLiveTasks,
        timeoutMs: options.timeoutMs,
        testTimeoutMs: options.testTimeoutMs,
        keepWorkspaces: !options.discardWorkspaces,
      },
      live: options.runLive,
      quiet: true,
    }).catch(error => ({
      generated_at: new Date().toISOString(),
      benchmark_type: 'live-agent-idiom-quality-ab',
      status: 'fail',
      score: 0,
      summary: {
        target_count: idiomTargets.length,
        task_count: 0,
        live_trials_attempted: 0,
        live_correctness_regressions: idiomTargets.length,
        live_average_idiom_conformance_delta: null,
        live_average_total_quality_delta: null,
        error: error instanceof Error ? error.message : String(error),
      },
      trials: [],
    }))
    : null;

  const gates = buildGates(discovery, selectedEligible, repoResults, incremental, idiomBenchmark, options);
  const report = {
    generated_at: new Date().toISOString(),
    status: aggregateStatus(gates.map(gate => gate.status)),
    score: Math.round(average(gates.map(gate => gate.score))),
    dev_root: options.devRoot,
    discovery,
    selected_eligible_count: selectedEligible.length,
    repo_results: [
      ...repoResults,
      ...unselectedEligible.map(repo => ({
        ...repo,
        proof_status: 'skipped',
        reason: options.maxTargets
          ? `Eligible repo not analyzed because --max-targets limited this run to ${selectedEligible.length} of ${eligible.length} eligible repos.`
          : 'Eligible repo was not selected for analysis.',
      })),
      ...discovery.repos.filter(repo => repo.status !== 'eligible').map(repo => ({
        ...repo,
        proof_status: repo.status,
        reason: repo.reason,
      })),
    ],
    incremental,
    idiom_benchmark: idiomBenchmark,
    gates,
  };
  return report;
}

function selectIdiomProofTargets(selectedEligible: RealRepoTarget[], repoResults: any[], targetCount: number): RealRepoTarget[] {
  const passingPaths = new Set(repoResults.filter(result =>
    result.proof_status === 'pass' &&
    result.readiness?.default_use === true &&
    Number(result.cas?.codebase_idioms || 0) > 0
  ).map(result => result.path));
  const preferredNames = ['proof-of-concept', 'zerac-api', 'soon-ui', 'soon-bos', 'zerac-ui', 'admin-ui'];
  const preferred = preferredNames
    .map(name => selectedEligible.find(repo => repo.name === name && passingPaths.has(repo.path)))
    .filter((repo): repo is RealRepoTarget => Boolean(repo));
  const fallback = selectedEligible.filter(repo => passingPaths.has(repo.path) && !preferred.some(item => item.path === repo.path));
  const selected = [...preferred, ...fallback].slice(0, targetCount);
  return selected.length > 0 ? selected : selectedEligible.slice(0, Math.min(targetCount, selectedEligible.length));
}

function logMachineProgress(message: string): void {
  if (process.env.UNRAVL_MACHINE_QUIET === '1') return;
  console.error(`[MachineProof] ${message}`);
}

function buildGates(
  discovery: Awaited<ReturnType<typeof discoverRealRepos>>,
  selectedEligible: RealRepoTarget[],
  repoResults: any[],
  incremental: any,
  idiomBenchmark: any,
  options: ParsedArgs
): Gate[] {
  const allEligibleAccounted = selectedEligible.every(repo => repoResults.some(result => result.path === repo.path));
  const allSelectedPass = repoResults.length > 0 && repoResults.every(result => result.proof_status === 'pass');
  const allHaveIdioms = repoResults.length > 0 && repoResults.every(result => Number(result.cas?.codebase_idioms || 0) > 0);
  const allDefaultUse = repoResults.length > 0 && repoResults.every(result => result.readiness?.default_use === true);
  const incrementalSummary = incremental?.summary || {};
  const idiomSummary = idiomBenchmark?.summary || {};
  return [
    gate('machine-discovery:repo-accounting', discovery.total_repos === discovery.repos.length && discovery.total_repos > 0, `${discovery.total_repos} discovered, ${discovery.eligible_repos} eligible, ${discovery.unsupported_repos} unsupported, ${discovery.skipped_repos} skipped`),
    gate('machine-discovery:eligible-selected', selectedEligible.length > 0 && selectedEligible.length === Math.min(options.maxTargets || discovery.eligible_repos, discovery.eligible_repos), `${selectedEligible.length}/${discovery.eligible_repos} eligible selected`),
    gate('machine-analysis:all-accounted', allEligibleAccounted, `${repoResults.length}/${selectedEligible.length} selected eligible repos analyzed`),
    gate('machine-analysis:all-pass', allSelectedPass, `${repoResults.filter(result => result.proof_status === 'pass').length}/${repoResults.length} proof pass`),
    gate('machine-analysis:default-use', allDefaultUse, `${repoResults.filter(result => result.readiness?.default_use).length}/${repoResults.length} default-use ready`),
    gate('machine-analysis:idioms', allHaveIdioms, `${repoResults.filter(result => Number(result.cas?.codebase_idioms || 0) > 0).length}/${repoResults.length} with idioms`),
    gate('machine-incremental:success', incremental?.status === 'pass' && Number(incrementalSummary.incremental_success_rate) === 1, `${incremental?.status || 'missing'}, ${Math.round(Number(incrementalSummary.incremental_success_rate || 0) * 100)}% success`),
    gate('machine-incremental:agent-value', Number(incrementalSummary.average_edit_speedup_vs_full || 0) >= 1.5 && Number(incrementalSummary.average_packet_tokens_after_edit || 999999) <= 10000, `${incrementalSummary.average_edit_speedup_vs_full || 0}x edit speedup, ${incrementalSummary.average_packet_tokens_after_edit || 'unknown'} tokens`),
    gate('machine-idiom-live:present', Number(idiomSummary.live_trials_attempted || 0) > 0, `${idiomSummary.live_trials_attempted || 0} live idiom trials`),
    gate('machine-idiom-live:no-correctness-regression', Number(idiomSummary.live_correctness_regressions || 0) === 0 && Number(idiomSummary.live_trials_attempted || 0) > 0, `${idiomSummary.live_correctness_regressions || 0} correctness regressions`),
    gate('machine-idiom-live:positive-delta', Number(idiomSummary.live_average_idiom_conformance_delta || 0) > 0 && Number(idiomSummary.live_average_total_quality_delta || 0) >= 0, `idiom delta ${idiomSummary.live_average_idiom_conformance_delta ?? 'missing'}, quality delta ${idiomSummary.live_average_total_quality_delta ?? 'missing'}`),
  ];
}

function gate(id: string, condition: boolean, detail: string): Gate {
  return { id, status: condition ? 'pass' : 'fail', score: condition ? 100 : 0, detail };
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMarkdown(report: Awaited<ReturnType<typeof runMachineAgentProof>>): string {
  const lines = [
    '# Unravl Machine-Wide Agent Proof',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Dev root: ${report.dev_root}`,
    '',
    '## Gates',
    '',
    '| Gate | Status | Detail |',
    '| --- | --- | --- |',
    ...report.gates.map(gate => `| ${gate.id} | ${gate.status} | ${String(gate.detail).replace(/\|/g, '\\|')} |`),
    '',
    '## Repository Accounting',
    '',
    `Discovered: ${report.discovery.total_repos}`,
    `Eligible: ${report.discovery.eligible_repos}`,
    `Unsupported: ${report.discovery.unsupported_repos}`,
    `Skipped: ${report.discovery.skipped_repos}`,
    '',
    '| Repo | Status | Proof | Languages | Reason |',
    '| --- | --- | --- | --- | --- |',
    ...report.repo_results.map((repo: any) => `| ${repo.name} | ${repo.status} | ${repo.proof_status || ''} | ${(repo.languages || []).join(', ')} | ${repo.reason || repo.error || ''} |`),
  ];
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runMachineAgentProof(args);
  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(args.markdownPath));
  await fs.writeFile(args.markdownPath, formatMarkdown(report), 'utf8');
  console.log(`Machine agent proof: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const gate of report.gates) console.log(`${gate.status.toUpperCase().padEnd(4)} ${gate.id} - ${gate.detail}`);
  console.log(`Report: ${args.outputPath}`);
  console.log(`Markdown: ${args.markdownPath}`);
  if (report.status === 'fail') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
