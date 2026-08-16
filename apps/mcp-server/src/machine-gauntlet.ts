import * as fs from 'fs-extra';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import pLimit from 'p-limit';
import { analyzeForBench } from './gauntlet/product-analysis';
import { evaluateAgentReadiness } from './agent-adoption';
import { runAgentIdiomBenchmark } from './agent-idiom-benchmark';
import { runAgentGreenfieldBenchmark } from './agent-greenfield-benchmark';
import { runAgentCapabilityMemoryBenchmark } from './agent-capability-memory-benchmark';
import { runSeededExistingTaskBenchmark } from './agent-existing-task-benchmark';
import { runFromZeroBuildContextProof } from './agent-from-zero-build-context-proof';
import { reviewAnalysisUsefulness } from './analysis-usefulness-review';
import { copyIncrementalBenchmarkRepo, runIncrementalValueBenchmark } from './incremental-benchmark';
import { discoverRealRepos, type RealRepoTarget } from './repo-discovery';
import { isDirectCliInvocation } from './cli-invocation';
import { type AnalysisFocus } from './analysis-focus';
import { analyzeCasWithInstalledKlauro, getInstalledKlauroVersion, initializeInstalledKlauroProject } from './installed-klauro';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';
import { graphEquivalenceRate } from './incremental-graph-equivalence';

type GateStatus = 'pass' | 'warn' | 'fail';
export type MachineProofMode = 'fast' | 'full';
type AnalysisPath = 'klauro-product' | 'in-process-harness';
type InFlightPath = 'klauro-product' | 'in-process-harness' | 'isolated-harness';

interface Gate {
  id: string;
  status: GateStatus;
  score: number;
  detail: string;
}

export interface ParsedArgs {
  devRoot: string;
  mode?: MachineProofMode;
  maxTargets?: number;
  startIndex?: number;
  maxSourceFiles?: number;
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
  analysisBudgetMs?: number;
  incrementalBudgetMs?: number;
  analysisPath?: AnalysisPath;
  inFlightPath?: InFlightPath;
  analyzerServerUrl?: string;
  productLocal?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let outputPath = path.join(process.cwd(), '.klauro-agent-proof-machine', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.klauro-agent-proof-machine', 'latest-report.md');
  let maxTargets: number | undefined;
  let startIndex: number | undefined;
  let mode: MachineProofMode | undefined;
  let maxSourceFiles: number | undefined;
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
  let analysisBudgetMs: number | undefined;
  let incrementalBudgetMs: number | undefined;
  let analysisPath: ParsedArgs['analysisPath'];
  let inFlightPath: ParsedArgs['inFlightPath'];
  let analyzerServerUrl: string | undefined;
  let productLocal = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dev-root') devRoot = path.resolve(argv[++i]);
    else if (arg === '--analyzer-server') analyzerServerUrl = argv[++i];
    else if (arg === '--local-analyzer' || arg === '--self-hosted-off') productLocal = true;
    else if (arg === '--mode') mode = parseMachineProofMode(argv[++i]);
    else if (arg === '--max-targets') maxTargets = Number(argv[++i]);
    else if (arg === '--start-index') startIndex = Number(argv[++i]);
    else if (arg === '--max-source-files') maxSourceFiles = Number(argv[++i]);
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
    else if (arg === '--analysis-budget-ms') analysisBudgetMs = Number(argv[++i]);
    else if (arg === '--incremental-budget-ms') incrementalBudgetMs = Number(argv[++i]);
    else if (arg === '--analysis-path') analysisPath = parseAnalysisPath(argv[++i]);
    else if (arg === '--in-flight-path') inFlightPath = parseInFlightPath(argv[++i]);
    else if (arg === '--keep-workspaces') discardWorkspaces = false;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return {
    devRoot,
    mode,
    maxTargets,
    startIndex,
    maxSourceFiles,
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
    analysisBudgetMs,
    incrementalBudgetMs,
    analysisPath,
    inFlightPath,
    analyzerServerUrl,
    productLocal,
  };
}

function parseMachineProofMode(value: string): MachineProofMode {
  if (value === 'fast' || value === 'full') return value;
  throw new Error(`Invalid machine proof mode "${value}". Expected fast or full.`);
}

function parseAnalysisPath(value: string): AnalysisPath {
  if (value === 'klauro-product') return 'klauro-product';
  if (value === 'in-process-harness') return 'in-process-harness';
  throw new Error(`Invalid analysis path "${value}". Expected klauro-product or in-process-harness.`);
}

function parseInFlightPath(value: string): InFlightPath {
  if (value === 'klauro-product') return 'klauro-product';
  if (value === 'in-process-harness') return 'in-process-harness';
  if (value === 'isolated-harness') return 'isolated-harness';
  throw new Error(`Invalid in-flight path "${value}". Expected klauro-product, in-process-harness, or isolated-harness.`);
}

function printHelp(): void {
  console.log([
    'Usage: npm run agent-proof-machine -- [options]',
    '',
    'Options:',
    '  --dev-root /path               Root to discover real Git repos under. Default ~/dev.',
    '  --mode fast|full               fast samples eligible repos with resource budgets; full analyzes every eligible repo. Default fast.',
    '  --max-targets n                Limit eligible repos for expensive analysis/proof while still reporting all discovered repos.',
    '  --start-index n                Start selected eligible repos at this zero-based index after size filtering. Use with --max-targets for batched gauntlets.',
    '  --max-source-files n           Skip eligible repos above this source-file count for expensive checks while still reporting them.',
    '  --no-live                      Skip live idiom A/B gate. The report will fail the live-proof gate.',
    '  --agent-with-cmd command       Live with-Klauro agent command template.',
    '  --agent-without-cmd command    Live without-Klauro agent command template.',
    '  --orchestrator-cmd command     Optional external evaluator command template.',
    '  --test-command command         Optional command to run in copied repos after live agents.',
    '  --work-root /path              Directory for copied repos and benchmark artifacts.',
    '  --max-live-tasks n             Maximum live idiom task pairs.',
    '  --analysis-concurrency n       Number of repo analyses to run concurrently. Default 1.',
    '  --incremental-concurrency n    Number of incremental repo checks to run concurrently. Default 1. Values above 1 are capped by the incremental benchmark.',
    '  --analysis-budget-ms n         Per-selected-repo analysis budget gate. Default 30000 in fast mode, 120000 in full mode.',
    '  --incremental-budget-ms n      Per-selected-repo incremental budget gate. Default 30000 in fast mode, 120000 in full mode.',
    '  --analysis-path path           Cold/warm analysis path: klauro-product or in-process-harness. Default klauro-product.',
    `  --analyzer-server url          Hosted analyzer for the klauro-product path. Default ${DEFAULT_KLAURO_CLOUD_URL} (production).`,
    '  --local-analyzer               Run the installed CLI in OFFLINE local mode instead of the hosted service (testing only).',
    '  --in-flight-path path          In-flight analysis path: klauro-product, in-process-harness, or isolated-harness. Default klauro-product.',
    '  --keep-workspaces              Keep copied repo workspaces.',
    '  --output /path/report.json     Write JSON report.',
    '  --markdown /path/report.md     Write Markdown report.',
  ].join('\n'));
}

export async function runMachineAgentProof(options: ParsedArgs) {
  options = normalizeMachineProofOptions(options);
  const previousFreshOrchestrator = process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS;
  if (previousFreshOrchestrator === undefined) {
    process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS = '1';
  }

  const runId = `machine-${Date.now()}`;
  const workRoot = options.workRoot || defaultMachineProofWorkRoot(runId);
  await fs.ensureDir(workRoot);
  const klauroProductStoragePath = path.join(workRoot, 'klauro-product-analysis-storage');
  const discovery = await discoverRealRepos(options.devRoot);
  const eligible = discovery.repos.filter(repo => repo.status === 'eligible');
  const selectedEligible = selectEligibleReposForMachineProof(eligible, options);
  const analysisFocus = machineProofAnalysisFocus(options);
  const installedCliVersion = options.analysisPath === 'klauro-product' || options.inFlightPath === 'klauro-product'
    ? getInstalledKlauroVersion()
    : null;
  if (options.analysisPath === 'klauro-product' || options.inFlightPath === 'klauro-product') {
    logMachineProgress(options.analyzerServerUrl
      ? `klauro-product path -> hosted analyzer ${options.analyzerServerUrl} (installed CLI ${installedCliVersion})`
      : `klauro-product path -> OFFLINE local mode (installed CLI ${installedCliVersion})`);
  }
  const selectedPaths = new Set(selectedEligible.map(repo => repo.path));
  const unselectedEligible = eligible.filter(repo => !selectedPaths.has(repo.path));
  const limit = pLimit(Math.max(1, options.analysisConcurrency || 3));
  const repoResults = await Promise.all(selectedEligible.map(repo => limit(() => analyzeRepoForMachineProof(repo))));

  async function analyzeRepoForMachineProof(repo: RealRepoTarget) {
    const startedAt = Date.now();
    logMachineProgress(`analyzing ${repo.name} (${repo.path}) with ${analysisFocus} via ${options.analysisPath}`);
    let analysisPath = repo.path;
    try {
      if (options.analysisPath === 'klauro-product') {
        analysisPath = path.join(workRoot, 'product-analysis', `${slugForMachineFile(repo.name)}-${crypto.createHash('sha256').update(repo.path).digest('hex').slice(0, 12)}`);
        await fs.remove(analysisPath);
        await copyIncrementalBenchmarkRepo(repo.path, analysisPath);
        await initializeInstalledKlauroProject(analysisPath, { serverUrl: options.analyzerServerUrl, env: { KLAURO_STORAGE_PATH: klauroProductStoragePath }, timeoutMs: options.analysisBudgetMs ? Math.max(options.analysisBudgetMs * 2, 8 * 60 * 1000) : 8 * 60 * 1000 });
      }
      const cas = options.analysisPath === 'klauro-product'
        ? (await analyzeCasWithInstalledKlauro(analysisPath, {
          analysisFocus, serverUrl: options.analyzerServerUrl,
          env: { KLAURO_STORAGE_PATH: klauroProductStoragePath },
          timeoutMs: options.analysisBudgetMs ? Math.max(options.analysisBudgetMs * 2, 8 * 60 * 1000) : 8 * 60 * 1000,
        })).output
        : await analyzeForBench(repo.path);
      const readiness = evaluateAgentReadiness(cas, analysisPath);
      const analysisQuality = assessAnalysisQuality(cas, repo.path);
      const usefulnessReview = await reviewAnalysisUsefulness(cas, repo.path, repo.name, analysisFocus);
      logMachineProgress(`analyzed ${repo.name} in ${Date.now() - startedAt}ms`);
      return {
        ...repo,
        proof_status: (cas.analysis_errors || []).some(entry => (entry.severity ?? 'error') === 'error') ? 'fail' : readiness.agent_context_ready && analysisQuality.status === 'pass' && usefulnessReview.status === 'pass' ? 'pass' : 'fail',
        analysis_ms: Date.now() - startedAt,
        cas: {
          nodes: cas.nodes.length,
          edges: cas.edges.length,
          entry_points: cas.entry_points?.length || 0,
          exit_points: cas.exit_points?.length || 0,
          behavioral_invariants: cas.behavioral_invariants?.length || 0,
          codebase_idioms: cas.codebase_idioms?.length || 0,
          capabilities: cas.capabilities?.length || 0,
          primary_domain: cas.enhanced_system_purpose?.primary_domain || null,
          description_source: cas.enhanced_system_purpose?.description_source || null,
          description_generation: cas.enhanced_system_purpose?.description_generation || null,
          architectural_patterns: cas.architecture_summary?.architectural_patterns?.length || 0,
          pattern_balance: cas.architecture_summary?.pattern_balance?.status || null,
          analysis_errors: cas.analysis_errors?.length || 0,
        },
        analysis_focus: analysisFocus,
        analysis_path: options.analysisPath,
        analysis_quality: analysisQuality,
        usefulness_review: usefulnessReview,
        readiness: {
          status: readiness.status,
          score: readiness.score,
          agent_context_ready: readiness.agent_context_ready,
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
    } finally {
      if (options.analysisPath === 'klauro-product' && options.discardWorkspaces) await fs.remove(analysisPath).catch(() => undefined);
    }
  }

  const incremental = selectedEligible.length > 0
    ? options.inFlightPath === 'in-process-harness'
      ? await runMachineIncrementalBenchmarkInProcess(selectedEligible, options, path.join(workRoot, 'incremental'))
      : options.inFlightPath === 'klauro-product'
      ? await runMachineInFlightBenchmarkKlauroProduct(selectedEligible, options, path.join(workRoot, 'incremental'))
      : await runMachineIncrementalBenchmarkIsolated(selectedEligible, options, path.join(workRoot, 'incremental'))
    : null;

  const liveConfigured = Boolean(options.agentWithCommand && options.agentWithoutCommand);
  const idiomTargets = selectIdiomProofTargets(selectedEligible, repoResults, Math.max(3, options.maxLiveTasks || 3));
  const idiomBenchmark = idiomTargets.length > 0
    ? await runAgentIdiomBenchmark({
      repos: idiomTargets.map(repo => ({ name: repo.name, path: repo.path })),
      maxTargets: idiomTargets.length,
      maxTasksPerRepo: 2,
      commands: {
        withKlauro: options.agentWithCommand,
        withoutKlauro: options.agentWithoutCommand,
        orchestrator: options.orchestratorCommand,
        testCommand: options.testCommand,
        workRoot: path.join(workRoot, 'idiom-live'),
        maxLiveTasks: options.maxLiveTasks,
        timeoutMs: options.timeoutMs,
        testTimeoutMs: options.testTimeoutMs,
        keepWorkspaces: !options.discardWorkspaces,
      },
      live: liveConfigured && options.runLive,
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

  const greenfieldBenchmark = await runAgentGreenfieldBenchmark({
    references: selectGreenfieldReferencePaths(selectedEligible, repoResults),
    outputPath: path.join(workRoot, 'greenfield', 'report.json'),
    markdownPath: path.join(workRoot, 'greenfield', 'report.md'),
    liveRequested: liveConfigured && options.runLive,
    commands: {
      withKlauro: options.agentWithCommand,
      withoutKlauro: options.agentWithoutCommand,
      orchestrator: options.orchestratorCommand,
      testCommand: options.testCommand,
      workRoot: path.join(workRoot, 'greenfield-live'),
      maxLiveTasks: options.maxLiveTasks,
      timeoutMs: options.timeoutMs,
      testTimeoutMs: options.testTimeoutMs,
      keepWorkspaces: !options.discardWorkspaces,
    },
  }).catch(error => ({
    generated_at: new Date().toISOString(),
    benchmark_type: 'agent-greenfield-benchmark',
    status: 'fail',
    score: 0,
    reference_count: 0,
    summary: {
      scenario_count: 0,
      average_quality_delta: 0,
      scenarios_improved: 0,
      preview_successes: 0,
      error: error instanceof Error ? error.message : String(error),
    },
    results: [],
  }));

  const capabilityMemoryBenchmark = await runAgentCapabilityMemoryBenchmark({
    repos: selectedEligible.map(repo => ({ name: repo.name, path: repo.path })),
    maxTargets: Math.min(selectedEligible.length, 12),
    maxTasksPerRepo: 3,
    outputPath: path.join(workRoot, 'capability-memory', 'report.json'),
    markdownPath: path.join(workRoot, 'capability-memory', 'report.md'),
    quiet: true,
  }).catch(error => ({
    generated_at: new Date().toISOString(),
    benchmark_type: 'agent-capability-memory',
    status: 'fail',
    score: 0,
    summary: {
      target_count: 0,
      task_count: 0,
      memory_hit_rate: 0,
      average_duplicate_avoidance_delta: 0,
      error: error instanceof Error ? error.message : String(error),
    },
    repositories: [],
  }));

  const fromZeroBuildContextProof = await runFromZeroBuildContextProof({
    outputRoot: path.join(workRoot, 'from-zero-build-context-proof'),
    reportPath: path.join(workRoot, 'from-zero-build-context-proof', 'report.json'),
    markdownPath: path.join(workRoot, 'from-zero-build-context-proof', 'report.md'),
  }).catch(error => ({
    generated_at: new Date().toISOString(),
    benchmark_type: 'from-zero-build-context-proof',
    status: 'fail',
    score: 0,
    summary: {
      task_count: 0,
      quality_delta: 0,
      duplicate_class_delta: 0,
      error: error instanceof Error ? error.message : String(error),
    },
  }));

  const existingTaskBenchmark = await runSeededExistingTaskBenchmark({
    outputRoot: path.join(workRoot, 'existing-task-benchmark'),
    reportPath: path.join(workRoot, 'existing-task-benchmark', 'report.json'),
    markdownPath: path.join(workRoot, 'existing-task-benchmark', 'report.md'),
    live: false,
    liveReps: 1,
    liveConfig: {},
    withoutArmRetrieval: true,
    realRepoPath: null,
    realTaskId: null,
  } as any).catch(error => ({
    generated_at: new Date().toISOString(),
    benchmark_type: 'seeded-existing-project-task-proof',
    status: 'fail',
    score: 0,
    summary: {
      proof_strength: 'deterministic-proxy',
      scenario_count: 0,
      family_count: 0,
      passing_scenarios: 0,
      average_score_delta: 0,
      average_file_reduction_percentage: 0,
      average_token_reduction_percentage: 0,
      average_index_retrieval_file_recall: 0,
      average_index_retrieval_tokens: 0,
      klauro_vs_index_retrieval_token_reduction_percentage: 0,
      error: error instanceof Error ? error.message : String(error),
    },
    scenarios: [],
  }));

  const descriptionGenerationProbe = await runDescriptionGenerationProbe(selectedEligible, repoResults, options);
  const gates = buildGates(discovery, selectedEligible, repoResults, incremental, idiomBenchmark, greenfieldBenchmark, capabilityMemoryBenchmark, fromZeroBuildContextProof, existingTaskBenchmark, descriptionGenerationProbe, options);
  const performanceDiagnostics = buildMachinePerformanceDiagnostics(repoResults, incremental, options);
  const report = {
    generated_at: new Date().toISOString(),
    status: aggregateStatus(gates.map(gate => gate.status)),
    score: Math.round(average(gates.map(gate => gate.score))),
    dev_root: options.devRoot,
    mode: options.mode,
    resource_policy: {
      max_targets: options.maxTargets ?? null,
      start_index: options.startIndex ?? 0,
      max_source_files: options.maxSourceFiles ?? null,
      analysis_concurrency: options.analysisConcurrency ?? 1,
      incremental_concurrency: options.incrementalConcurrency ?? 1,
      analysis_budget_ms: options.analysisBudgetMs ?? null,
      incremental_budget_ms: options.incrementalBudgetMs ?? null,
      analysis_path: options.analysisPath,
      in_flight_path: options.inFlightPath,
      klauro_cli_version: installedCliVersion,
      klauro_product_storage: options.analysisPath === 'klauro-product' ? klauroProductStoragePath : null,
      live_enabled: Boolean(options.runLive && options.agentWithCommand && options.agentWithoutCommand),
      discard_workspaces: options.discardWorkspaces,
      work_root: workRoot,
      analysis_focus: analysisFocus,
    },
    ai_interpretation_summary: summarizeAiInterpretation(repoResults),
    description_generation_probe: descriptionGenerationProbe,
    discovery,
    selected_eligible_count: selectedEligible.length,
    performance_diagnostics: performanceDiagnostics,
    repo_results: [
      ...repoResults,
      ...unselectedEligible.map(repo => ({
        ...repo,
        proof_status: 'skipped',
        reason: unselectedMachineProofReason(repo, options, selectedEligible.length, eligible.length),
      })),
      ...discovery.repos.filter(repo => repo.status !== 'eligible').map(repo => ({
        ...repo,
        proof_status: repo.status,
        reason: repo.reason,
      })),
    ],
    incremental,
    idiom_benchmark: idiomBenchmark,
    greenfield_benchmark: greenfieldBenchmark,
    from_zero_build_context_proof: fromZeroBuildContextProof,
    capability_memory_benchmark: capabilityMemoryBenchmark,
    existing_task_benchmark: existingTaskBenchmark,
    gates,
  };
  if (previousFreshOrchestrator === undefined) {
    delete process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS;
  } else {
    process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS = previousFreshOrchestrator;
  }

  return report;
}

export function buildMachinePerformanceDiagnostics(repoResults: any[], incremental: any, options: Pick<ParsedArgs, 'analysisBudgetMs' | 'incrementalBudgetMs'> = {}) {
  const analysisBudgetMs = Number(options.analysisBudgetMs || 120_000);
  const incrementalBudgetMs = Number(options.incrementalBudgetMs || 120_000);
  const analysisWatchMs = Math.min(60_000, Math.max(15_000, Math.round(analysisBudgetMs * 0.5)));
  const proofHarnessWatchMs = Math.min(60_000, Math.max(15_000, Math.round(incrementalBudgetMs * 0.5)));
  const editIncrementalWatchMs = Math.min(60_000, Math.max(15_000, Math.round(incrementalBudgetMs * 0.5)));
  const editLoopWatchMs = Math.min(15_000, Math.max(5_000, Math.round(incrementalBudgetMs * 0.12)));
  const weakTokenReductionThreshold = 50;
  const largeContextTokenThreshold = 6_000;
  const targets = Array.isArray(incremental?.targets) ? incremental.targets : [];
  const slowAnalyses = repoResults
    .filter(result => Number(result.analysis_ms || 0) >= analysisWatchMs)
    .sort((a, b) => Number(b.analysis_ms || 0) - Number(a.analysis_ms || 0))
    .slice(0, 10)
    .map(result => ({
      name: result.name,
      path: result.path,
      analysis_ms: Number(result.analysis_ms || 0),
      source_files: Number(result.source_files || result.sourceFiles || 0) || undefined,
      nodes: Number(result.cas?.nodes || 0) || undefined,
      reason: Number(result.analysis_ms || 0) > analysisBudgetMs
        ? 'exceeds analysis budget'
        : 'slow but within analysis budget',
    }));
  const slowProofHarnesses = targets
    .filter((target: any) => Number(target.timings?.isolated_child_wall_ms || target.timings?.total_wall_ms || 0) >= proofHarnessWatchMs)
    .sort((a: any, b: any) => Number(b.timings?.isolated_child_wall_ms || b.timings?.total_wall_ms || 0) - Number(a.timings?.isolated_child_wall_ms || a.timings?.total_wall_ms || 0))
    .slice(0, 10)
    .map((target: any) => ({
      name: target.name,
      path: target.original_path,
      isolated_child_wall_ms: Number(target.timings?.isolated_child_wall_ms || target.timings?.total_wall_ms || 0),
      copy_repo_ms: Number(target.timings?.copy_repo_ms || 0),
      edit_loop_wall_ms: Number(target.timings?.edit_loop_wall_ms || target.timings?.edit_incremental_ms || 0),
      full_ms: Number(target.timings?.initial_full_ms || 0),
      edit_incremental_ms: Number(target.timings?.edit_incremental_ms || 0),
      edit_speedup_vs_full: Number(target.speedups?.edit_incremental_vs_full || 0),
      nodes: Number(target.output_summary?.nodes || 0) || undefined,
      tracked_files: Number(target.output_summary?.tracked_files || 0) || undefined,
      reason: Number(target.timings?.isolated_child_wall_ms || target.timings?.total_wall_ms || 0) > incrementalBudgetMs
        ? 'proof harness wall time exceeded the incremental budget; inspect copy/setup and analysis phases separately'
        : 'slow proof harness wall time; edit incremental still passed',
    }));
  const slowIncrementals = targets
    .filter((target: any) => Number(target.timings?.edit_incremental_ms || 0) >= editIncrementalWatchMs)
    .sort((a: any, b: any) => Number(b.timings?.edit_incremental_ms || 0) - Number(a.timings?.edit_incremental_ms || 0))
    .slice(0, 10)
    .map((target: any) => ({
      name: target.name,
      path: target.original_path,
      edit_incremental_ms: Number(target.timings?.edit_incremental_ms || 0),
      full_ms: Number(target.timings?.initial_full_ms || 0),
      edit_speedup_vs_full: Number(target.speedups?.edit_incremental_vs_full || 0),
      nodes: Number(target.output_summary?.nodes || 0) || undefined,
      tracked_files: Number(target.output_summary?.tracked_files || 0) || undefined,
      reason: Number(target.timings?.edit_incremental_ms || 0) > incrementalBudgetMs
        ? 'edit incremental analysis exceeded the incremental budget'
        : 'edit incremental analysis is slow enough to watch before tightening budgets',
    }));
  const slowEditLoops = targets
    .filter((target: any) => Number(target.timings?.edit_loop_wall_ms || target.timings?.edit_incremental_ms || 0) >= editLoopWatchMs)
    .sort((a: any, b: any) => Number(b.timings?.edit_loop_wall_ms || b.timings?.edit_incremental_ms || 0) - Number(a.timings?.edit_loop_wall_ms || a.timings?.edit_incremental_ms || 0))
    .slice(0, 10)
    .map((target: any) => ({
      name: target.name,
      path: target.original_path,
      edit_loop_wall_ms: Number(target.timings?.edit_loop_wall_ms || target.timings?.edit_incremental_ms || 0),
      edit_incremental_ms: Number(target.timings?.edit_incremental_ms || 0),
      context_generation_ms: Number(target.agent_value_after_edit?.context_generation_ms || 0),
      reason: 'agent-facing edit loop is near the human-noticeable boundary',
    }));
  const weakTokenReductionTargets = targets
    .filter((target: any) => Number(target.agent_value_after_edit?.estimated_search_token_reduction_percentage || 0) < weakTokenReductionThreshold)
    .sort((a: any, b: any) => Number(a.agent_value_after_edit?.estimated_search_token_reduction_percentage || 0) - Number(b.agent_value_after_edit?.estimated_search_token_reduction_percentage || 0))
    .slice(0, 10)
    .map((target: any) => ({
      name: target.name,
      path: target.original_path,
      token_reduction_vs_search: Number(target.agent_value_after_edit?.estimated_search_token_reduction_percentage || 0),
      context_tokens: Number(target.agent_value_after_edit?.estimated_context_tokens || 0),
      total_context_tokens: Number(target.agent_value_after_edit?.estimated_total_context_tokens || 0),
      search_baseline_tokens: Number(target.agent_value_after_edit?.estimated_search_baseline_tokens || 0),
      reason: 'token reduction is positive but below the preferred margin',
    }));
  const largeContextTargets = targets
    .filter((target: any) => Number(target.agent_value_after_edit?.estimated_context_tokens || 0) > largeContextTokenThreshold)
    .sort((a: any, b: any) => Number(b.agent_value_after_edit?.estimated_context_tokens || 0) - Number(a.agent_value_after_edit?.estimated_context_tokens || 0))
    .slice(0, 10)
    .map((target: any) => ({
      name: target.name,
      path: target.original_path,
      context_tokens: Number(target.agent_value_after_edit?.estimated_context_tokens || 0),
      total_context_tokens: Number(target.agent_value_after_edit?.estimated_total_context_tokens || 0),
      token_reduction_vs_search: Number(target.agent_value_after_edit?.estimated_search_token_reduction_percentage || 0),
      reason: 'context is large enough to watch even when token reduction is strong',
    }));

  const recommendations: string[] = Array.from(new Set([
    slowIncrementals.length > 0 ? 'Prioritize analyzer hot paths for slow incremental repos with high node/file counts before tightening full-mode budgets.' : '',
    slowProofHarnesses.length > 0 ? 'Separate benchmark harness overhead from agent-facing edit-loop latency before treating proof wall time as product latency.' : '',
    slowEditLoops.length > 0 ? 'Keep edit-loop context generation compact for human-interactive agent use; anything above roughly 10-15s should be profiled.' : '',
    weakTokenReductionTargets.length > 0 ? 'For tiny or narrow repos, prefer smaller architecture/idiom contexts so Klauro never costs more tokens than direct targeted search.' : '',
    largeContextTargets.length > 0 ? 'Review large contexts for verbose inventory examples, source snippets, and redundant guidance.' : '',
  ].filter((recommendation): recommendation is string => Boolean(recommendation))));

  return {
    status: slowAnalyses.length || slowProofHarnesses.length || slowIncrementals.length || slowEditLoops.length || weakTokenReductionTargets.length || largeContextTargets.length ? 'watch' : 'pass',
    thresholds: {
      analysis_watch_ms: analysisWatchMs,
      proof_harness_watch_ms: proofHarnessWatchMs,
      incremental_edit_watch_ms: editIncrementalWatchMs,
      edit_loop_watch_ms: editLoopWatchMs,
      weak_token_reduction_threshold: weakTokenReductionThreshold,
      large_context_token_threshold: largeContextTokenThreshold,
    },
    counts: {
      slow_analysis_repos: slowAnalyses.length,
      slow_proof_harness_repos: slowProofHarnesses.length,
      slow_incremental_repos: slowIncrementals.length,
      slow_edit_loop_repos: slowEditLoops.length,
      weak_token_reduction_repos: weakTokenReductionTargets.length,
      large_context_repos: largeContextTargets.length,
    },
    slow_analysis_repos: slowAnalyses,
    slow_proof_harness_repos: slowProofHarnesses,
    slow_incremental_repos: slowIncrementals,
    slow_edit_loop_repos: slowEditLoops,
    weak_token_reduction_repos: weakTokenReductionTargets,
    large_context_repos: largeContextTargets,
    recommendations,
  };
}

export function normalizeMachineProofOptions(options: ParsedArgs): ParsedArgs {
  const mode = options.mode || 'fast';
  const fast = mode === 'fast';
  return {
    ...options,
    mode,
    maxTargets: options.maxTargets ?? (fast ? 8 : undefined),
    startIndex: Math.max(0, Math.floor(options.startIndex || 0)),
    maxSourceFiles: options.maxSourceFiles ?? (fast ? 2500 : undefined),
    runLive: fast && !options.agentWithCommand && !options.agentWithoutCommand ? false : options.runLive,
    analysisConcurrency: Math.max(1, Math.min(fast ? 1 : 2, options.analysisConcurrency || 1)),
    incrementalConcurrency: Math.max(1, Math.min(fast ? 1 : 2, options.incrementalConcurrency || 1)),
    analysisBudgetMs: options.analysisBudgetMs ?? (fast ? 30_000 : 120_000),
    incrementalBudgetMs: options.incrementalBudgetMs ?? (fast ? 30_000 : 120_000),
    analysisPath: options.analysisPath ?? 'klauro-product',
    inFlightPath: options.inFlightPath ?? 'klauro-product',
    analyzerServerUrl: options.productLocal
      ? undefined
      : options.analyzerServerUrl ?? DEFAULT_KLAURO_CLOUD_URL,
  };
}

export function defaultMachineProofWorkRoot(runId = `machine-${Date.now()}`): string {
  return path.join(os.tmpdir(), 'klauro-machine-proof-workspaces', runId);
}

export function machineProofAnalysisFocus(options: Pick<ParsedArgs, 'mode'>): AnalysisFocus {
  void options;
  return 'agent-fast';
}

export function selectEligibleReposForMachineProof(eligible: RealRepoTarget[], options: ParsedArgs): RealRepoTarget[] {
  const withinSizeBudget = typeof options.maxSourceFiles === 'number' && Number.isFinite(options.maxSourceFiles)
    ? eligible.filter(repo => Number(repo.source_files || 0) <= Number(options.maxSourceFiles))
    : eligible;
  const start = Math.max(0, Math.floor(options.startIndex || 0));
  return withinSizeBudget.slice(start, start + (options.maxTargets || withinSizeBudget.length));
}

function unselectedMachineProofReason(repo: RealRepoTarget, options: ParsedArgs, selectedCount: number, eligibleCount: number): string {
  if (typeof options.maxSourceFiles === 'number' && Number(repo.source_files || 0) > options.maxSourceFiles) {
    return `Eligible repo not analyzed in ${options.mode} mode because ${repo.source_files} source files exceeds --max-source-files=${options.maxSourceFiles}.`;
  }
  if (options.maxTargets) {
    return `Eligible repo not analyzed because this ${options.mode} batch selected ${selectedCount} of ${eligibleCount} eligible repos with --start-index=${options.startIndex || 0} and --max-targets=${options.maxTargets}.`;
  }
  return 'Eligible repo was not selected for analysis.';
}

export function assessAnalysisQuality(cas: any, repoPath = ''): { status: GateStatus; score: number; failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  const primaryDomain = String(cas.enhanced_system_purpose?.primary_domain || '');
  const description = String(cas.enhanced_system_purpose?.inferred_description || '');
  const repoSignal = `${repoPath} ${cas.system?.name || ''}`.toLowerCase();
  const capabilities = cas.capabilities || [];
  const architecturalPatterns = cas.architecture_summary?.architectural_patterns || [];
  const architecturalInventory = cas.architecture_summary?.architectural_inventory || {};
  const patternBalance = cas.architecture_summary?.pattern_balance;
  const descriptionGeneration = cas.enhanced_system_purpose?.description_generation;

  if (!primaryDomain || primaryDomain === 'unknown' || isGenericDomain(primaryDomain)) {
    failures.push(`primary domain is weak (${primaryDomain || 'missing'})`);
  }
  if (isCryptoTradingRepoSignal(repoSignal) && !isCryptoTradingDomain(primaryDomain)) {
    failures.push(`crypto/Solana repo signal conflicts with primary domain (${primaryDomain})`);
  }
  if (/testing[-_ ]utilities|test[-_ ]utilities/.test(repoSignal) && /medical-device|hardware-device/.test(primaryDomain)) {
    failures.push(`testing utility repo was classified as ${primaryDomain}`);
  }
  if (capabilities.length === 0) {
    failures.push('no system capabilities inferred');
  }
  if (!description || description.length < 80 || /key capabilities:\s*(test|main|home|settings)(,|\.|$)/i.test(description)) {
    failures.push('system description is missing, too short, or dominated by generic/test capabilities');
  }
  if (!descriptionGeneration?.status) {
    warnings.push('system description generation source is not recorded');
  }
  const weakDescriptionReasons = findWeakMachineDescriptionReasons(cas, description, repoSignal);
  failures.push(...weakDescriptionReasons);
  if (primaryDomain === 'solana-arbitrage' && /\b(dapp|decentralized application|miner|mining|mine tokens?)\b/i.test(description)) {
    failures.push('system description adds unsupported crypto-mining/DApp language');
  }
  if (architecturalPatterns.length === 0 && (cas.nodes?.length || 0) > 50) {
    warnings.push('no architectural patterns detected for non-trivial repo');
  }
  if (patternBalance?.status === 'over-patterned') {
    failures.push('pattern balance reports over-patterned analysis; agents need concrete local examples');
  }
  if (architecturalPatterns.length > 10) {
    const highConfidencePatterns = architecturalPatterns.filter((pattern: any) => Number(pattern.confidence || 0) >= 0.65);
    const primaryPatternCount = Array.isArray(patternBalance?.primary_patterns) ? patternBalance.primary_patterns.length : 0;
    const balanceExplainsPatternSet = patternBalance?.status === 'balanced' &&
      primaryPatternCount > 0 &&
      primaryPatternCount <= 8 &&
      /shared backbone|layered|module/i.test(String(patternBalance?.rationale || patternBalance?.recommendations?.join(' ') || ''));
    if (patternBalance?.status === 'over-patterned' || primaryPatternCount > 8 || (highConfidencePatterns.length > 8 && !balanceExplainsPatternSet)) {
      failures.push(`too many high-confidence architectural patterns detected (${architecturalPatterns.length} total, ${highConfidencePatterns.length} high-confidence); likely pattern splurge`);
    }
  }
  const patternNames = architecturalPatterns.map((pattern: any) => String(pattern.name || '').toLowerCase());
  if (patternNames.some((name: string) => name.includes('mvc'))) {
    requireInventory(architecturalInventory, failures, 'MVC', ['controllers', 'models']);
  }
  if (patternNames.some((name: string) => name.includes('mvvm'))) {
    requireInventory(architecturalInventory, failures, 'MVVM', ['views', 'view_models', 'models']);
  }
  if (patternNames.some((name: string) => name.includes('repository'))) {
    requireInventory(architecturalInventory, failures, 'Repository', ['repositories']);
  }
  if (patternNames.some((name: string) => name.includes('mediator'))) {
    requireInventory(architecturalInventory, failures, 'Mediator', ['mediators']);
  }
  if (patternNames.some((name: string) => name.includes('unit of work'))) {
    requireInventory(architecturalInventory, failures, 'Unit of Work', ['unit_of_work']);
  }
  if (patternNames.some((name: string) => name.includes('singleton'))) {
    requireInventory(architecturalInventory, failures, 'Singleton', ['singletons']);
  }
  const score = Math.max(0, 100 - failures.length * 30 - warnings.length * 10);
  return {
    status: failures.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
    score,
    failures,
    warnings,
  };
}

function summarizeAiInterpretation(repoResults: any[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const result of repoResults) {
    const status = result.cas?.description_generation?.status || 'missing';
    summary[status] = (summary[status] || 0) + 1;
    const source = result.cas?.description_source || 'missing-source';
    summary[`source:${source}`] = (summary[`source:${source}`] || 0) + 1;
  }
  return summary;
}

async function runDescriptionGenerationProbe(
  selectedEligible: RealRepoTarget[],
  repoResults: any[],
  options: ParsedArgs,
) {
  if (options.mode !== 'full') {
    return {
      status: 'pass' as GateStatus,
      proof_strength: 'skipped-fast-mode',
      detail: 'AI description probe is only required in full machine proof mode.',
    };
  }

  const passing = new Set(repoResults
    .filter(result => result.proof_status === 'pass')
    .map(result => result.path));
  const preferredNames = ['treecity', 'dexter', 'elevate-skincare', 'soon-decrypter', 'proof-of-concept'];
  const preferred = preferredNames
    .map(name => selectedEligible.find(repo => repo.name === name && passing.has(repo.path)))
    .find(Boolean);
  const fallback = [...selectedEligible]
    .filter(repo => passing.has(repo.path))
    .sort((left, right) => Number(left.source_files || 0) - Number(right.source_files || 0))[0];
  const repo = preferred || fallback;
  if (!repo) {
    return {
      status: 'fail' as GateStatus,
      proof_strength: 'missing-target',
      detail: 'No passing repository was available for the AI description probe.',
    };
  }

  const previous = {
    interpretation: process.env.KLAURO_AI_INTERPRETATION,
    interpretationForce: process.env.KLAURO_AI_INTERPRETATION_FORCE,
    deterministicKeep: process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP,
    interpretationBudget: process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS,
    elements: process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS,
    elementBudget: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS,
    elementLimit: process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT,
    freshOrchestrator: process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS,
  };

  const startedAt = Date.now();
  try {
    process.env.KLAURO_AI_INTERPRETATION = 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = 'true';
    process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP = 'false';
    process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS || '240000';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS || '30000';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT = '0';
    process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS = '1';

    logMachineProgress(`description probe ${repo.name} (${repo.path})`);
    const cas = await analyzeForBench(repo.path);
    const generation = cas.enhanced_system_purpose?.description_generation;
    const status = String(generation?.status || 'missing');
    const source = String(cas.enhanced_system_purpose?.description_source || 'missing');
    const attempted = generation?.attempted === true;
    const description = String(cas.enhanced_system_purpose?.inferred_description || '');
    const accepted = attempted &&
      status === 'ai_applied' &&
      source === 'ai' &&
      description.length >= 120 &&
      !findWeakMachineDescriptionReasons(cas, description, repo.path).length;
    return {
      status: accepted ? 'pass' as GateStatus : 'fail' as GateStatus,
      proof_strength: status === 'ai_applied' && source === 'ai' ? 'hosted-ai-applied' : attempted ? 'hosted-ai-reviewed-but-not-applied' : 'ai-not-attempted',
      repo: repo.name,
      path: repo.path,
      duration_ms: Date.now() - startedAt,
      description_source: source,
      description_generation: generation || null,
      description_excerpt: description.slice(0, 360),
      detail: accepted
        ? `${repo.name} exercised hosted AI description path (${status}, source ${source})`
        : `${repo.name} did not produce an acceptable hosted AI-applied description (${status}, source ${source})`,
    };
  } catch (error) {
    return {
      status: 'fail' as GateStatus,
      proof_strength: 'hosted-ai-error',
      repo: repo.name,
      path: repo.path,
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      detail: `AI description probe failed for ${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    restoreMachineEnv('KLAURO_AI_INTERPRETATION', previous.interpretation);
    restoreMachineEnv('KLAURO_AI_INTERPRETATION_FORCE', previous.interpretationForce);
    restoreMachineEnv('KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP', previous.deterministicKeep);
    restoreMachineEnv('KLAURO_AI_INTERPRETATION_BUDGET_MS', previous.interpretationBudget);
    restoreMachineEnv('KLAURO_AI_ELEMENT_DESCRIPTIONS', previous.elements);
    restoreMachineEnv('KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS', previous.elementBudget);
    restoreMachineEnv('KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT', previous.elementLimit);
    restoreMachineEnv('KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS', previous.freshOrchestrator);
  }
}

function restoreMachineEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function isCryptoTradingRepoSignal(text: string): boolean {
  return /\b(solana|pumpfun|jito|mev|sniper|bundler|arbitrage)\b/.test(text);
}

function isCryptoTradingDomain(domain: string): boolean {
  return /\b(solana|pumpfun|jito|mev|crypto|trading|arbitrage|sniper)\b/.test(domain);
}

function requireInventory(inventory: any, failures: string[], pattern: string, keys: string[]): void {
  const missing = keys.filter(key => !Array.isArray(inventory[key]) || inventory[key].length === 0);
  if (missing.length > 0) {
    failures.push(`${pattern} detected without inventory for ${missing.join(', ')}`);
  }
}

function isGenericDomain(domain: string): boolean {
  return new Set([
    'test', 'main', 'app', 'application', 'service', 'controller', 'component',
    'services', 'controllers', 'components', 'page', 'route', 'handler',
    'handlers', 'module', 'modules', 'data', 'config', 'settings', 'home',
    'asset', 'assets', 'generated', 'gql', 'graphql', 'document', 'documents',
  ]).has(domain.toLowerCase());
}

function findWeakMachineDescriptionReasons(cas: any, description: string, repoSignal = ''): string[] {
  const reasons: string[] = [];
  const text = String(description || '');
  if (!text || text.length < 80) return reasons;
  const concepts = [
    ...(cas.enhanced_system_purpose?.core_concepts || []),
    ...(cas.domain_concepts || []).map((concept: any) => concept.name),
    ...(cas.capabilities || []).map((capability: any) => capability.name),
  ].map(value => String(value || '').toLowerCase()).filter(Boolean);
  const distinctive = concepts.filter(isDistinctiveMachineDescriptionTerm);
  if (/project text identifies the main concepts as/i.test(text) && distinctive.length < 3) {
    reasons.push('system description uses weak project-text fallback without enough distinctive concepts');
  }
  if (/\b(seamless(?:ly)?|indispensable|unified experience|robust api|complex queries|large datasets|crucial role|underlying platform|wide range of clients|high-quality [a-z ]+ experience|regulatory requirements?|best practices|designed for managing|facilitates|various applications|robust [a-z ]*framework|enhances (?:the )?[a-z ]*(?:security|efficiency)|allowing developers to focus|complex tasks)\b/i.test(text)) {
    reasons.push('system description contains generic AI marketing language');
  }
  if (/\bprimary interface for interacting with (?:the )?(?:application'?s )?database\b/i.test(text) ||
    /\bintermediary between the frontend ui and the server-side logic\b/i.test(text)) {
    reasons.push('system description describes a generic backend role instead of codebase-specific behavior');
  }
  const unsupportedClaim = text.match(/\b(command-line interface|coupons?|discounts?)\b/i)?.[1];
  if (unsupportedClaim &&
    !descriptionClaimIsGroundedInRepoSignal(repoSignal, unsupportedClaim) &&
    !descriptionTermIsGroundedInMachineCas(cas, unsupportedClaim)) {
    reasons.push(`system description claims unsupported ${unsupportedClaim} behavior`);
  }
  if ([...text.matchAll(/\b[A-Z][a-z]{1,3}\b/g)].some(match =>
    !descriptionTermIsGroundedInMachineCas(cas, match[0]) &&
    !/^(A|An|The|This|It|Its|Key|Data|Entry|REST|API|UI|SQL|AWS|GPO)$/.test(match[0])
  )) {
    reasons.push('system description includes unexplained short proper-noun claims');
  }
  return Array.from(new Set(reasons));
}

function descriptionClaimIsGroundedInRepoSignal(repoSignal: string, term: string): boolean {
  const normalized = String(term || '').toLowerCase();
  if (normalized === 'command-line interface') {
    return /\b(cli|command|console)\b|(^|[/_-])bin($|[/_-])|__main__|entry_points/i.test(repoSignal);
  }
  return false;
}

function isDistinctiveMachineDescriptionTerm(value: string): boolean {
  const generic = new Set([
    'app', 'application', 'api', 'service', 'services', 'system', 'data', 'user', 'users',
    'page', 'pages', 'component', 'components', 'route', 'routes', 'access', 'network',
    'main', 'home', 'settings', 'config', 'backend', 'frontend',
  ]);
  return value.split(/[^a-z0-9]+/).some(token => token.length > 3 && !generic.has(token));
}

function descriptionTermIsGroundedInMachineCas(cas: any, term: string): boolean {
  const normalized = String(term || '').toLowerCase();
  if (!normalized) return false;
  const technologies = cas.system?.technologies || {};
  const haystack = JSON.stringify({
    system: cas.system?.name,
    domain: cas.enhanced_system_purpose?.primary_domain,
    concepts: cas.enhanced_system_purpose?.core_concepts,
    domainConcepts: (cas.domain_concepts || []).map((concept: any) => concept.name),
    capabilities: (cas.capabilities || []).map((capability: any) => capability.name),
    entities: [
      ...((cas.database_schema?.entities || []).map((entity: any) => entity?.name || '')),
      ...((cas.entities || []).map((entity: any) => entity.name)),
    ],
    entries: (cas.entry_points || []).map((entry: any) => `${entry.name} ${entry.type}`),
    integrations: ((cas as any).external_services || []).map((service: any) => `${service?.name || ''} ${service?.service || ''} ${service?.type || ''}`),
    languages: (technologies.languages || []).map((language: any) => `${language?.name || language}`),
    frameworks: [
      ...((technologies.frameworks || []).map((framework: any) => `${framework?.name || framework}`)),
      ...(((cas as any).frameworks || []).map((framework: any) => `${framework?.name || framework}`)),
    ],
    packages: [
      ...((cas.libraries || []).map((library: any) => library?.name || '')),
      ...((cas.dependencies?.packages || []).map((pkg: any) => pkg?.name || '')),
      ...(Array.isArray((cas as any).dependencies) ? ((cas as any).dependencies as any[]).map(dependency => `${dependency?.name || dependency}`) : []),
    ],
    nodes: (cas.nodes || []).slice(0, 200).map((node: any) => `${node.name} ${node.type} ${node.source?.file || ''}`),
  }).toLowerCase();
  return haystack.includes(normalized);
}

function selectIdiomProofTargets(selectedEligible: RealRepoTarget[], repoResults: any[], targetCount: number): RealRepoTarget[] {
  const passingPaths = new Set(repoResults.filter(result =>
    result.proof_status === 'pass' &&
    result.readiness?.agent_context_ready === true &&
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

function selectGreenfieldReferencePaths(selectedEligible: RealRepoTarget[], repoResults: any[]): string[] {
  const passing = new Set(repoResults
    .filter(result => result.proof_status === 'pass')
    .map(result => result.path));
  const preferredNames = ['proof-of-concept', 'zerac-api', 'soon-ui', 'soon-bos', 'kadra', 'SoundSyft'];
  const preferred = preferredNames
    .map(name => selectedEligible.find(repo => repo.name === name && passing.has(repo.path)))
    .filter((repo): repo is RealRepoTarget => Boolean(repo));
  const fallback = selectedEligible.filter(repo => passing.has(repo.path) && !preferred.some(item => item.path === repo.path));
  return [...preferred, ...fallback].slice(0, 6).map(repo => repo.path);
}

function logMachineProgress(message: string): void {
  if (process.env.KLAURO_MACHINE_QUIET === '1') return;
  console.error(`[MachineProof] ${message}`);
}

async function runMachineIncrementalBenchmarkIsolated(
  repos: RealRepoTarget[],
  options: ParsedArgs,
  workRoot: string,
) {
  await fs.ensureDir(workRoot);
  const packageDir = path.resolve(__dirname, '..');
  const incrementalTimeoutMs = Number(process.env.KLAURO_MACHINE_INCREMENTAL_TIMEOUT_MS || 600000);
  const limit = pLimit(Math.max(1, Math.min(3, options.incrementalConcurrency || 1)));

  const reports = await Promise.all(repos.map(repo => limit(async () => {
    const startedAt = Date.now();
    logMachineProgress(`incremental ${repo.name} (${repo.path})`);
    const reportPath = path.join(workRoot, 'reports', `${slugForMachineFile(repo.name)}-${Date.now()}.json`);
    const markdownPath = path.join(workRoot, 'reports', `${slugForMachineFile(repo.name)}-${Date.now()}.md`);
    await fs.ensureDir(path.dirname(reportPath));

    const child = await runChildProcess('npm', [
      '--prefix',
      packageDir,
      'run',
      'incremental-benchmark',
      '--',
      '--repo',
      `${repo.name}=${repo.path}`,
      '--max-targets',
      '1',
      '--verify-full',
      options.discardWorkspaces ? '--discard-workspaces' : '--keep-workspaces',
      '--work-root',
      path.join(workRoot, 'workspaces'),
      '--output',
      reportPath,
      '--markdown',
      markdownPath,
    ], {
      cwd: path.resolve(packageDir, '../..'),
      env: {
        ...process.env,
        NODE_OPTIONS: withNodeHeapLimit(process.env.NODE_OPTIONS),
        KLAURO_AI_INTERPRETATION_BUDGET_MS: process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS || '1000',
        KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS: '0',
      },
      timeout: incrementalTimeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });

    if (await fs.pathExists(reportPath)) {
      const report = await fs.readJson(reportPath);
      const target = report.targets?.[0];
      const childWallMs = Math.max(1, Date.now() - startedAt);
      logMachineProgress(`incremental ${repo.name} complete in ${childWallMs}ms`);
      if (!target) {
        return failedIsolatedIncrementalReport(repo, 'Incremental child report did not contain a target result', childWallMs);
      }
      target.timings = {
        ...(target.timings || {}),
        isolated_child_wall_ms: childWallMs,
        isolated_child_overhead_ms: isolatedChildOverheadMs(target.timings, childWallMs),
      };
      return target;
    }

    const detail = [
      child.error instanceof Error ? child.error.message : '',
      child.stderr || '',
      child.stdout || '',
    ].filter(Boolean).join('\n').slice(0, 4000) || `incremental child exited with status ${child.status ?? 'unknown'}`;
    logMachineProgress(`incremental ${repo.name} failed in ${Date.now() - startedAt}ms: ${detail.split('\n')[0]}`);
    return failedIsolatedIncrementalReport(repo, detail, Date.now() - startedAt);
  })));

  const generatedAt = new Date().toISOString();
  const graphVerifiedReports = reports.filter(target => target.full_verify_parity);
  return {
    generated_at: generatedAt,
    generatedAt,
    benchmark_type: 'incremental-analysis-agent-value',
    execution_model: 'isolated-child-process-per-repo',
    status: aggregateStatus(reports.map(target => target.status)),
    score: Math.round(average(reports.map(target => target.score))),
    summary: {
      target_count: reports.length,
      targets_passed: reports.filter(target => target.status === 'pass').length,
      targets_warned: reports.filter(target => target.status === 'warn').length,
      targets_failed: reports.filter(target => target.status === 'fail').length,
      target_pass_rate: Number((average(reports.map(target => target.status === 'pass' ? 100 : 0)) / 100).toFixed(2)),
      incremental_success_rate: Number((average(reports.map(target => !target.change_summary?.was_full_rebuild ? 100 : 0)) / 100).toFixed(2)),
      average_initial_full_ms: Math.round(average(reports.map(target => target.timings?.initial_full_ms || 0))),
      average_no_change_incremental_ms: Math.round(average(reports.map(target => target.timings?.no_change_incremental_ms || 0))),
      average_edit_incremental_ms: Math.round(average(reports.map(target => target.timings?.edit_incremental_ms || 0))),
      average_edit_loop_wall_ms: Math.round(average(reports.map(target => target.timings?.edit_loop_wall_ms || target.timings?.edit_incremental_ms || 0))),
      average_isolated_child_wall_ms: Math.round(average(reports.map(target => target.timings?.isolated_child_wall_ms || target.timings?.total_wall_ms || 0))),
      average_isolated_child_overhead_ms: Math.round(average(reports.map(target => target.timings?.isolated_child_overhead_ms || 0))),
      average_no_change_speedup_vs_full: Number(average(reports.map(target => target.speedups?.no_change_vs_full || 0)).toFixed(2)),
      average_edit_speedup_vs_full: Number(average(reports.map(target => target.speedups?.edit_incremental_vs_full || 0)).toFixed(2)),
      average_context_generation_ms_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit?.context_generation_ms || 0))),
      average_file_read_plan_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit?.file_read_plan_count || 0))),
      average_context_tokens_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit?.estimated_context_tokens || 0))),
      average_total_context_tokens_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit?.estimated_total_context_tokens || 0))),
      average_search_baseline_tokens_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit?.estimated_search_baseline_tokens || 0))),
      average_search_token_reduction_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit?.estimated_search_token_reduction_percentage || 0))),
      average_cold_scan_token_reduction_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit?.estimated_cold_scan_token_reduction_percentage || 0))),
      average_full_verify_count_similarity: average(
        reports
          .map(target => target.full_verify_parity?.count_similarity)
          .filter((value): value is number => typeof value === 'number')
      ),
      full_verify_target_count: graphVerifiedReports.length,
      full_verify_graph_equivalence_rate: graphEquivalenceRate(graphVerifiedReports),
    },
    targets: reports,
  };
}

async function runMachineIncrementalBenchmarkInProcess(
  repos: RealRepoTarget[],
  options: ParsedArgs,
  workRoot: string,
) {
  await fs.ensureDir(workRoot);
  const previousFreshOrchestrator = process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS;
  const previousAiBudget = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
  process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS = '0';
  process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS || '1000';

  try {
    const report = await runIncrementalValueBenchmark({
      repos: repos.map(repo => ({ name: repo.name, path: repo.path })),
      maxTargets: repos.length,
      workRoot: path.join(workRoot, 'workspaces'),
      keepWorkspaces: !options.discardWorkspaces,
      verifyFull: false,
      concurrency: options.incrementalConcurrency,
      quiet: true,
      progress: event => {
        if (event.stage === 'start') {
          logMachineProgress(`incremental ${event.target} (${event.path})`);
        } else if (event.stage === 'complete') {
          logMachineProgress(`incremental ${event.target} complete in ${event.duration_ms}ms`);
        } else {
          logMachineProgress(`incremental ${event.target} failed in ${event.duration_ms}ms: ${event.error || 'unknown error'}`);
        }
      },
    });
    return {
      ...report,
      execution_model: 'in-process-shared-analyzer',
      summary: {
        ...report.summary,
        average_isolated_child_wall_ms: report.summary.average_total_wall_ms,
        average_isolated_child_overhead_ms: 0,
      },
      targets: report.targets.map((target: any) => ({
        ...target,
        timings: {
          ...(target.timings || {}),
          isolated_child_wall_ms: target.timings?.total_wall_ms || target.timings?.edit_loop_wall_ms || target.timings?.edit_incremental_ms || 0,
          isolated_child_overhead_ms: 0,
        },
      })),
    };
  } finally {
    if (previousFreshOrchestrator === undefined) {
      delete process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS;
    } else {
      process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS = previousFreshOrchestrator;
    }
    if (previousAiBudget === undefined) {
      delete process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS;
    } else {
      process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = previousAiBudget;
    }
  }
}

async function runMachineInFlightBenchmarkKlauroProduct(
  repos: RealRepoTarget[],
  options: ParsedArgs,
  workRoot: string,
) {
  await fs.ensureDir(workRoot);
  const report = await runIncrementalValueBenchmark({
    repos: repos.map(repo => ({ name: repo.name, path: repo.path })),
    maxTargets: repos.length,
    workRoot: path.join(workRoot, 'workspaces'),
    keepWorkspaces: !options.discardWorkspaces,
    verifyFull: false,
    useGitBaseline: false,
    concurrency: options.incrementalConcurrency,
    analysisPath: 'klauro-product',
    analyzerServerUrl: options.analyzerServerUrl,
    quiet: true,
    progress: event => {
      if (event.stage === 'start') {
        logMachineProgress(`in-flight ${event.target} (${event.path}) via Klauro product path`);
      } else if (event.stage === 'complete') {
        logMachineProgress(`in-flight ${event.target} complete in ${event.duration_ms}ms via Klauro product path`);
      } else {
        logMachineProgress(`in-flight ${event.target} failed in ${event.duration_ms}ms via Klauro product path: ${event.error || 'unknown error'}`);
      }
    },
  });
  return {
    ...report,
    analysis_path: 'klauro-product',
    track: 'in-flight',
    summary: {
      ...report.summary,
      average_isolated_child_wall_ms: report.summary.average_total_wall_ms,
      average_isolated_child_overhead_ms: 0,
    },
    targets: report.targets.map((target: any) => ({
      ...target,
      timings: {
        ...(target.timings || {}),
        isolated_child_wall_ms: target.timings?.total_wall_ms || target.timings?.edit_loop_wall_ms || target.timings?.edit_incremental_ms || 0,
        isolated_child_overhead_ms: 0,
      },
    })),
  };
}

function failedIsolatedIncrementalReport(repo: RealRepoTarget, detail: string, durationMs: number) {
  return {
    name: repo.name,
    original_path: repo.path,
    workspace: '',
    edit: {
      kind: 'not-applied',
      detail: 'No edit result was produced because the isolated incremental child failed.',
    },
    status: 'fail' as GateStatus,
    score: 0,
    gates: [{
      id: 'incremental-child-completed',
      status: 'fail' as GateStatus,
      score: 0,
      detail,
    }],
    timings: {
      total_wall_ms: Math.max(1, durationMs),
      isolated_child_wall_ms: Math.max(1, durationMs),
      isolated_child_overhead_ms: 0,
      initial_full_ms: Math.max(1, durationMs),
      no_change_incremental_ms: 0,
      edit_incremental_ms: 0,
      edit_loop_wall_ms: 0,
    },
    speedups: {
      no_change_vs_full: 0,
      edit_incremental_vs_full: 0,
    },
    change_summary: {
      files_changed: 0,
      files_added: 0,
      files_modified: 0,
      files_deleted: 0,
      nodes_added: 0,
      nodes_modified: 0,
      nodes_deleted: 0,
      risk_level: 'unknown',
      was_full_rebuild: true,
      full_rebuild_reason: detail,
    },
    output_summary: {
      nodes: 0,
      edges: 0,
      entry_points: 0,
      exit_points: 0,
      analysis_errors: 1,
      tracked_files: 0,
      file_cache_entries: 0,
      file_cache_bytes: 0,
    },
    agent_value_after_edit: {
      context_generation_ms: 0,
      file_read_plan_count: 0,
      next_mcp_calls: 0,
      estimated_context_tokens: 0,
      estimated_source_tokens: 0,
      estimated_total_context_tokens: 0,
      estimated_search_baseline_tokens: 0,
      estimated_search_token_reduction_percentage: 0,
      estimated_cold_scan_tokens: 0,
      estimated_cold_scan_token_reduction_percentage: 0,
      agent_context_ready: false,
    },
  };
}

function isolatedChildOverheadMs(timings: any, childWallMs: number): number {
  const measured = Number(timings?.total_wall_ms || 0) || (
    Number(timings?.initial_full_ms || 0)
    + Number(timings?.no_change_incremental_ms || 0)
    + Number(timings?.edit_incremental_ms || 0)
    + Number(timings?.verify_full_after_edit_ms || 0)
  );
  return Math.max(0, Math.round(childWallMs - measured));
}

function runChildProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
  }
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString('utf8');
      return next.length > options.maxBuffer ? next.slice(next.length - options.maxBuffer) : next;
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      resolve({
        status: null,
        stdout,
        stderr,
        error: new Error(`child process timed out after ${options.timeout}ms`),
      });
    }, options.timeout);
    timeout.unref();

    child.stdout?.on('data', chunk => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', chunk => {
      stderr = append(stderr, chunk);
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status: null, stdout, stderr, error });
    });
    child.on('close', status => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function slugForMachineFile(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'repo';
}

function withNodeHeapLimit(value: string | undefined): string {
  const existing = value || '';
  if (existing.includes('--max-old-space-size')) return existing;
  return `${existing} --max-old-space-size=8192`.trim();
}

function buildGates(
  discovery: Awaited<ReturnType<typeof discoverRealRepos>>,
  selectedEligible: RealRepoTarget[],
  repoResults: any[],
  incremental: any,
  idiomBenchmark: any,
  greenfieldBenchmark: any,
  capabilityMemoryBenchmark: any,
  fromZeroBuildContextProof: any,
  existingTaskBenchmark: any,
  descriptionGenerationProbe: any,
  options: ParsedArgs
): Gate[] {
  const allEligibleAccounted = selectedEligible.every(repo => repoResults.some(result => result.path === repo.path));
  const allSelectedPass = repoResults.length > 0 && repoResults.every(result => result.proof_status === 'pass');
  const allHaveIdioms = repoResults.length > 0 && repoResults.every(result => Number(result.cas?.codebase_idioms || 0) > 0);
  const allDefaultUse = repoResults.length > 0 && repoResults.every(result => result.readiness?.agent_context_ready === true);
  const allHaveAnalysisQuality = repoResults.length > 0 && repoResults.every(result => result.analysis_quality?.status === 'pass');
  const allUsefulForAgents = repoResults.length > 0 && repoResults.every(result => result.usefulness_review?.status === 'pass');
  const eligible = discovery.repos.filter(repo => repo.status === 'eligible');
  const expectedSelectedCount = selectEligibleReposForMachineProof(eligible, options).length;
  const slowAnalyses = repoResults.filter(result => Number(result.analysis_ms || 0) > Number(options.analysisBudgetMs || Infinity));
  const incrementalSummary = incremental?.summary || {};
  const incrementalTargets = Array.isArray(incremental?.targets) ? incremental.targets : [];
  const incrementalHasFailures = incrementalTargets.some((target: any) => target?.status === 'fail');
  const slowIncrementals = incrementalTargets.filter((target: any) => Number(target.timings?.edit_incremental_ms || 0) > Number(options.incrementalBudgetMs || Infinity));
  const slowWallIncrementals = incrementalTargets.filter((target: any) => Number(target.timings?.edit_loop_wall_ms || target.timings?.edit_incremental_ms || 0) > Number(options.incrementalBudgetMs || Infinity));
  const idiomSummary = idiomBenchmark?.summary || {};
  const hasLiveIdiomProof = Number(idiomSummary.live_trials_attempted || 0) > 0;
  const idiomProofPresent = hasLiveIdiomProof || Number(idiomSummary.task_count || 0) > 0;
  const idiomCorrectnessOk = hasLiveIdiomProof
    ? Number(idiomSummary.live_correctness_regressions || 0) === 0
    : Number(idiomSummary.task_count || 0) > 0;
  const idiomDelta = hasLiveIdiomProof
    ? Number(idiomSummary.live_average_idiom_conformance_delta || 0)
    : Number(idiomSummary.average_idiom_conformance_delta || 0);
  const qualityDelta = hasLiveIdiomProof
    ? Number(idiomSummary.live_average_total_quality_delta || 0)
    : Number(idiomSummary.average_total_quality_delta || 0);
  const greenfieldSummary = greenfieldBenchmark?.summary || {};
  const capabilityMemorySummary = capabilityMemoryBenchmark?.summary || {};
  const fromZeroSummary = fromZeroBuildContextProof?.summary || {};
  const existingTaskSummary = existingTaskBenchmark?.summary || {};
  const fromZeroScenarioCount = Number(fromZeroSummary.scenario_count || (fromZeroBuildContextProof?.scenario ? 1 : 0));
  const fromZeroProductFocusCount = Number(fromZeroSummary.product_focus_scenario_count || 0);
  const fromZeroGrowthIterations = Number(fromZeroSummary.growth_iteration_count || fromZeroSummary.task_count || 0);
  const liveAgentConfigured = Boolean(options.runLive && options.agentWithCommand && options.agentWithoutCommand);
  const greenfieldLiveAttempts = Number(greenfieldSummary.live_trials_attempted || 0) +
    Number(greenfieldSummary.live_continuity_trials_attempted || 0);
  const greenfieldLiveQualityDelta = average([
    greenfieldSummary.live_average_quality_delta,
    greenfieldSummary.live_continuity_average_delta,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
  return [
    gate('machine-discovery:repo-accounting', discovery.total_repos === discovery.repos.length && discovery.total_repos > 0, `${discovery.total_repos} discovered, ${discovery.eligible_repos} eligible, ${discovery.unsupported_repos} unsupported, ${discovery.skipped_repos} skipped`),
    gate('machine-discovery:eligible-selected', selectedEligible.length > 0 && selectedEligible.length === expectedSelectedCount, `${selectedEligible.length}/${discovery.eligible_repos} eligible selected for ${options.mode || 'full'} mode`),
    gate('machine-product-flow:klauro-analysis', options.analysisPath === 'klauro-product' && options.inFlightPath === 'klauro-product', `cold/warm=${options.analysisPath}, in-flight=${options.inFlightPath}`),
    gate('machine-analysis:all-accounted', allEligibleAccounted, `${repoResults.length}/${selectedEligible.length} selected eligible repos analyzed`),
    gate('machine-analysis:all-pass', allSelectedPass, `${repoResults.filter(result => result.proof_status === 'pass').length}/${repoResults.length} proof pass`),
    gate('machine-analysis:agent-context-ready', allDefaultUse, `${repoResults.filter(result => result.readiness?.agent_context_ready).length}/${repoResults.length} agent-context-ready ready`),
    gate('machine-analysis:quality', allHaveAnalysisQuality, `${repoResults.filter(result => result.analysis_quality?.status === 'pass').length}/${repoResults.length} with strong domain/capability/description quality`),
    gate(
      'machine-analysis:ai-description-path',
      descriptionGenerationProbe?.status === 'pass',
      descriptionGenerationProbe?.detail || 'AI description probe missing'
    ),
    gate('machine-analysis:agent-usefulness', allUsefulForAgents, `${repoResults.filter(result => result.usefulness_review?.status === 'pass').length}/${repoResults.length} cold CAS/agent-context usefulness pass`),
    gate('machine-analysis:idioms', allHaveIdioms, `${repoResults.filter(result => Number(result.cas?.codebase_idioms || 0) > 0).length}/${repoResults.length} with idioms`),
    gate('machine-performance:analysis-budget', slowAnalyses.length === 0, slowAnalyses.length === 0
      ? `all selected analyses within ${options.analysisBudgetMs}ms budget`
      : `${slowAnalyses.length} selected analyses exceeded ${options.analysisBudgetMs}ms: ${slowAnalyses.slice(0, 5).map(result => `${result.name}=${result.analysis_ms}ms`).join(', ')}`),
    gate(
      'machine-incremental:success',
      Boolean(incremental) && !incrementalHasFailures && Number(incrementalSummary.incremental_success_rate) === 1,
      `${incremental?.status || 'missing'}, ${incrementalSummary.targets_passed ?? 0}/${incrementalSummary.target_count ?? 0} targets passed, ${Math.round(Number(incrementalSummary.incremental_success_rate || 0) * 100)}% stayed incremental`
    ),
    gate(
      'machine-incremental:agent-value',
      Number(incrementalSummary.average_edit_speedup_vs_full || 0) >= 1.5 &&
      Number(incrementalSummary.average_context_tokens_after_edit || 999999) <= 10000 &&
      Number(incrementalSummary.average_search_token_reduction_after_edit || 0) >= 25,
      `${incrementalSummary.average_edit_speedup_vs_full || 0}x edit speedup, ${incrementalSummary.average_context_tokens_after_edit || 'unknown'} agent-context tokens, ${incrementalSummary.average_search_token_reduction_after_edit ?? 'unknown'}% token reduction vs search, ${incrementalSummary.average_edit_loop_wall_ms || 'unknown'}ms edit-loop wall, ${incrementalSummary.average_isolated_child_wall_ms || 'unknown'}ms proof harness wall`
    ),
    gate('machine-performance:incremental-budget', slowIncrementals.length === 0, slowIncrementals.length === 0
      ? `all selected edit-incremental checks within ${options.incrementalBudgetMs}ms budget`
      : `${slowIncrementals.length} selected edit-incremental checks exceeded ${options.incrementalBudgetMs}ms: ${slowIncrementals.slice(0, 5).map((target: any) => `${target.name}=${target.timings?.edit_incremental_ms}ms`).join(', ')}`),
    gate('machine-performance:incremental-edit-loop-wall-clock-budget', slowWallIncrementals.length === 0, slowWallIncrementals.length === 0
      ? `all selected edit loops completed within ${options.incrementalBudgetMs}ms wall-clock budget`
      : `${slowWallIncrementals.length} selected edit loops exceeded ${options.incrementalBudgetMs}ms wall-clock: ${slowWallIncrementals.slice(0, 5).map((target: any) => `${target.name}=${target.timings?.edit_loop_wall_ms || target.timings?.edit_incremental_ms}ms`).join(', ')}`),
    gate(hasLiveIdiomProof ? 'machine-idiom-live:present' : 'machine-idiom-proof:present', idiomProofPresent, hasLiveIdiomProof ? `${idiomSummary.live_trials_attempted || 0} live idiom trials` : `${idiomSummary.task_count || 0} deterministic idiom tasks (${idiomSummary.proof_strength || 'deterministic-proxy'})`),
    gate(hasLiveIdiomProof ? 'machine-idiom-live:no-correctness-regression' : 'machine-idiom-proof:no-correctness-regression', idiomCorrectnessOk, hasLiveIdiomProof ? `${idiomSummary.live_correctness_regressions || 0} correctness regressions` : 'deterministic task scoring has no live correctness regression'),
    gate(hasLiveIdiomProof ? 'machine-idiom-live:positive-delta' : 'machine-idiom-proof:positive-delta', idiomDelta > 0 && qualityDelta >= 0, `idiom delta ${idiomDelta}, quality delta ${qualityDelta}`),
    gate(
      'machine-greenfield:guided-build-value',
      greenfieldBenchmark?.status === 'pass' &&
        Number(greenfieldSummary.scenarios_improved || 0) === Number(greenfieldSummary.scenario_count || -1) &&
        Number(greenfieldSummary.average_quality_delta || 0) > 0 &&
        Number(greenfieldSummary.preview_successes || 0) === Number(greenfieldSummary.scenario_count || -1) &&
        Number(greenfieldSummary.continuity_trial_count || 0) >= 2 &&
        Number(greenfieldSummary.continuity_trials_passed || 0) === Number(greenfieldSummary.continuity_trial_count || -1) &&
        Number(greenfieldSummary.continuity_average_delta || 0) > 0,
      `${greenfieldBenchmark?.status || 'missing'}, ${greenfieldSummary.scenarios_improved || 0}/${greenfieldSummary.scenario_count || 0} improved, +${greenfieldSummary.average_quality_delta || 0} quality delta, ${greenfieldSummary.continuity_trials_passed || 0}/${greenfieldSummary.continuity_trial_count || 0} continuity trials, +${greenfieldSummary.continuity_average_delta || 0} continuity delta`
    ),
    ...(liveAgentConfigured ? [
      gate(
        'machine-greenfield-live:present',
        greenfieldLiveAttempts > 0,
        greenfieldLiveAttempts > 0
          ? `${greenfieldLiveAttempts} live greenfield/continuity trials, quality delta ${greenfieldLiveQualityDelta || 0}`
          : 'live agent commands were configured but no greenfield live trials ran'
      ),
      gate(
        'machine-greenfield-live:positive-delta',
        greenfieldLiveAttempts > 0 && greenfieldLiveQualityDelta >= 0,
        greenfieldLiveAttempts > 0
          ? `live greenfield quality delta ${greenfieldLiveQualityDelta}`
          : 'live greenfield quality delta unavailable'
      ),
    ] : []),
    gate(
      'machine-greenfield:from-zero-build-context',
      fromZeroBuildContextProof?.status === 'pass' &&
        fromZeroScenarioCount >= 3 &&
        Number(fromZeroSummary.scenarios_passed || 0) === fromZeroScenarioCount &&
        fromZeroProductFocusCount === fromZeroScenarioCount &&
        fromZeroGrowthIterations >= 15 &&
        Number(fromZeroSummary.quality_delta || 0) > 0 &&
        Number(fromZeroSummary.duplicate_class_delta || 0) > 0 &&
        Number(fromZeroSummary.context_char_reduction_percentage || 0) > 0 &&
        Number(fromZeroSummary.with_klauro_duplicate_classes || 0) === 0,
      `${fromZeroBuildContextProof?.status || 'missing'}, ${fromZeroSummary.scenarios_passed || 0}/${fromZeroScenarioCount} scenarios, ${fromZeroProductFocusCount}/${fromZeroScenarioCount} product-focus contexts, ${fromZeroGrowthIterations} growth iterations, +${fromZeroSummary.quality_delta || 0} quality delta, +${fromZeroSummary.duplicate_class_delta || 0} duplicate-class delta, ${fromZeroSummary.context_char_reduction_percentage ?? 'unknown'}% context reduction, ${fromZeroSummary.with_klauro_duplicate_classes ?? 'unknown'} with-Klauro duplicate classes`
    ),
    gate(
      'machine-existing-task:index-retrieval-baseline',
      existingTaskBenchmark?.status === 'pass' &&
        Number(existingTaskSummary.scenario_count || 0) >= 10 &&
        Number(existingTaskSummary.klauro_vs_index_retrieval_token_reduction_percentage || 0) > 0 &&
        Number(existingTaskSummary.average_index_retrieval_file_recall || 0) < 100 &&
        Number(existingTaskSummary.average_token_reduction_percentage || 0) > 0,
      `${existingTaskBenchmark?.status || 'missing'}, ${existingTaskSummary.scenario_count || 0} existing-task scenarios, ${existingTaskSummary.average_index_retrieval_file_recall || 0}% Cursor-style retrieval recall, ${existingTaskSummary.klauro_vs_index_retrieval_token_reduction_percentage || 0}% fewer tokens than index retrieval, ${existingTaskSummary.average_token_reduction_percentage || 0}% fewer tokens than cold scan`
    ),
    gate(
      'machine-capability-memory:duplicate-avoidance',
      ['pass', 'warn'].includes(String(capabilityMemoryBenchmark?.status || '')) &&
        Number(capabilityMemorySummary.task_count || 0) > 0 &&
        Number(capabilityMemorySummary.memory_hit_rate || 0) >= 80 &&
        Number(capabilityMemorySummary.average_duplicate_avoidance_delta || 0) > 0,
      `${capabilityMemoryBenchmark?.status || 'missing'}, ${capabilityMemorySummary.task_count || 0} tasks, ${capabilityMemorySummary.memory_hit_rate || 0}% hit rate, +${capabilityMemorySummary.average_duplicate_avoidance_delta || 0} duplicate-avoidance delta`
    ),
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
  const incrementalSummary: any = report.incremental?.summary || {};
  const diagnostics: any = (report as any).performance_diagnostics || {};
  const greenfieldSummary: any = report.greenfield_benchmark?.summary || {};
  const fromZeroSummary: any = report.from_zero_build_context_proof?.summary || {};
  const capabilityMemorySummary: any = report.capability_memory_benchmark?.summary || {};
  const existingTaskSummary: any = (report as any).existing_task_benchmark?.summary || {};
  const descriptionProbe: any = (report as any).description_generation_probe || {};
  const idiomSummary: any = report.idiom_benchmark?.summary || {};
  const lines = [
    '# Klauro Machine-Wide Agent Proof',
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
    `Mode: ${report.mode}`,
    `Discovered: ${report.discovery.total_repos}`,
    `Eligible: ${report.discovery.eligible_repos}`,
    `Eligible analyzed: ${report.selected_eligible_count}/${report.discovery.eligible_repos}`,
    report.mode === 'full'
      ? 'Scope: full machine proof; every eligible repo must be analyzed.'
      : 'Scope: sampled fast proof; unselected eligible repos are reported but not analyzed.',
    `Unsupported: ${report.discovery.unsupported_repos}`,
    `Skipped: ${report.discovery.skipped_repos}`,
    '',
    '| Repo | Status | Proof | Languages | Reason |',
    '| --- | --- | --- | --- | --- |',
    ...report.repo_results.map((repo: any) => `| ${repo.name} | ${repo.status} | ${repo.proof_status || ''} | ${(repo.languages || []).join(', ')} | ${repo.reason || repo.error || ''} |`),
    '',
    '## Incremental Agent Value',
    '',
    report.incremental
      ? `Status: ${report.incremental.status}; targets: ${incrementalSummary.targets_passed || 0}/${incrementalSummary.target_count || 0}; edit speedup: ${incrementalSummary.average_edit_speedup_vs_full || 0}x; context: ${incrementalSummary.average_context_tokens_after_edit || 0} tokens; token reduction: ${incrementalSummary.average_search_token_reduction_after_edit ?? 'unknown'}%; edit-loop wall: ${incrementalSummary.average_edit_loop_wall_ms || 'unknown'}ms; proof harness wall: ${incrementalSummary.average_isolated_child_wall_ms || 'unknown'}ms; isolated overhead: ${incrementalSummary.average_isolated_child_overhead_ms || 0}ms`
      : 'Not run',
    '',
    '## AI Description Probe',
    '',
    descriptionProbe.status
      ? `Status: ${descriptionProbe.status}; strength: ${descriptionProbe.proof_strength || 'unknown'}; repo: ${descriptionProbe.repo || 'none'}; generation: ${descriptionProbe.description_generation?.status || 'unknown'}; source: ${descriptionProbe.description_source || 'unknown'}`
      : 'Not run',
    descriptionProbe.description_excerpt ? `Excerpt: ${String(descriptionProbe.description_excerpt).replace(/\s+/g, ' ')}` : '',
    '',
    '## Performance Diagnostics',
    '',
    diagnostics.status
      ? `Status: ${diagnostics.status}; slow analyses: ${diagnostics.counts?.slow_analysis_repos || 0}; slow proof harnesses: ${diagnostics.counts?.slow_proof_harness_repos || 0}; slow incrementals: ${diagnostics.counts?.slow_incremental_repos || 0}; slow edit loops: ${diagnostics.counts?.slow_edit_loop_repos || 0}; weak token reductions: ${diagnostics.counts?.weak_token_reduction_repos || 0}; large contexts: ${diagnostics.counts?.large_context_repos || 0}`
      : 'Not run',
    ...(Array.isArray(diagnostics.recommendations) && diagnostics.recommendations.length > 0
      ? ['', ...diagnostics.recommendations.map((recommendation: string) => `- ${recommendation}`)]
      : []),
    ...(Array.isArray(diagnostics.slow_proof_harness_repos) && diagnostics.slow_proof_harness_repos.length > 0
      ? [
          '',
          '| Slow proof harness repo | Harness wall ms | Copy ms | Edit-loop ms | Full ms | Edit ms | Nodes | Reason |',
          '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
          ...diagnostics.slow_proof_harness_repos.slice(0, 5).map((item: any) => `| ${item.name} | ${item.isolated_child_wall_ms} | ${item.copy_repo_ms || ''} | ${item.edit_loop_wall_ms} | ${item.full_ms} | ${item.edit_incremental_ms} | ${item.nodes || ''} | ${String(item.reason || '').replace(/\|/g, '\\|')} |`),
        ]
      : []),
    ...(Array.isArray(diagnostics.slow_incremental_repos) && diagnostics.slow_incremental_repos.length > 0
      ? [
          '',
          '| Slow edit incremental repo | Edit ms | Full ms | Speedup | Nodes | Reason |',
          '| --- | ---: | ---: | ---: | ---: | --- |',
          ...diagnostics.slow_incremental_repos.slice(0, 5).map((item: any) => `| ${item.name} | ${item.edit_incremental_ms} | ${item.full_ms} | ${item.edit_speedup_vs_full} | ${item.nodes || ''} | ${String(item.reason || '').replace(/\|/g, '\\|')} |`),
        ]
      : []),
    ...(Array.isArray(diagnostics.weak_token_reduction_repos) && diagnostics.weak_token_reduction_repos.length > 0
      ? [
          '',
          '| Weak token-reduction repo | Reduction | Context tokens | Total context | Search baseline | Reason |',
          '| --- | ---: | ---: | ---: | ---: | --- |',
          ...diagnostics.weak_token_reduction_repos.slice(0, 5).map((item: any) => `| ${item.name} | ${item.token_reduction_vs_search}% | ${item.context_tokens} | ${item.total_context_tokens} | ${item.search_baseline_tokens} | ${String(item.reason || '').replace(/\|/g, '\\|')} |`),
        ]
      : []),
    '',
    '## Greenfield Agent Benchmark',
    '',
    report.greenfield_benchmark
      ? `Status: ${report.greenfield_benchmark.status}; scenarios improved: ${greenfieldSummary.scenarios_improved || 0}/${greenfieldSummary.scenario_count || 0}; average quality delta: +${greenfieldSummary.average_quality_delta || 0}; continuity: ${greenfieldSummary.continuity_trials_passed || 0}/${greenfieldSummary.continuity_trial_count || 0} (+${greenfieldSummary.continuity_average_delta || 0})`
      : 'Not run',
    '',
    '## Idiom Quality Proof',
    '',
    report.idiom_benchmark
      ? `Status: ${report.idiom_benchmark.status}; strength: ${idiomSummary.proof_strength || (idiomSummary.live_trials_attempted ? 'live' : 'deterministic-proxy')}; tasks: ${idiomSummary.task_count || 0}; idiom delta: +${idiomSummary.average_idiom_conformance_delta || idiomSummary.live_average_idiom_conformance_delta || 0}; quality delta: +${idiomSummary.average_total_quality_delta || idiomSummary.live_average_total_quality_delta || 0}`
      : 'Not run',
    '',
    '## From-Zero Build Context Proof',
    '',
    report.from_zero_build_context_proof
      ? `Status: ${report.from_zero_build_context_proof.status}; quality delta: +${fromZeroSummary.quality_delta || 0}; duplicate-class delta: +${fromZeroSummary.duplicate_class_delta || 0}; with-Klauro duplicates: ${fromZeroSummary.with_klauro_duplicate_classes ?? 'unknown'}; context char reduction: ${fromZeroSummary.context_char_reduction_percentage ?? 'unknown'}%`
      : 'Not run',
    '',
    '## Existing-Task Index Retrieval Baseline',
    '',
    (report as any).existing_task_benchmark
      ? `Status: ${(report as any).existing_task_benchmark.status}; scenarios: ${existingTaskSummary.scenario_count || 0}; Klauro vs cold scan token reduction: ${existingTaskSummary.average_token_reduction_percentage || 0}%; Klauro vs Cursor-style retrieval token reduction: ${existingTaskSummary.klauro_vs_index_retrieval_token_reduction_percentage || 0}%; retrieval recall: ${existingTaskSummary.average_index_retrieval_file_recall || 0}%`
      : 'Not run',
    '',
    '## Capability Memory Benchmark',
    '',
    report.capability_memory_benchmark
      ? `Status: ${report.capability_memory_benchmark.status}; tasks: ${capabilityMemorySummary.task_count || 0}; memory hit rate: ${capabilityMemorySummary.memory_hit_rate || 0}%; duplicate-avoidance delta: +${capabilityMemorySummary.average_duplicate_avoidance_delta || 0}`
      : 'Not run',
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
  const workRoot = (report.resource_policy as any).work_root;
  if (args.discardWorkspaces && workRoot && !pathContains(workRoot, args.outputPath) && !pathContains(workRoot, args.markdownPath)) {
    await fs.remove(workRoot).catch(() => undefined);
  }
  console.log(`Machine agent proof: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const gate of report.gates) console.log(`${gate.status.toUpperCase().padEnd(4)} ${gate.id} - ${gate.detail}`);
  console.log(`Report: ${args.outputPath}`);
  console.log(`Markdown: ${args.markdownPath}`);
  if (report.status === 'fail') process.exitCode = 1;
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

if (isDirectCliInvocation('machine-gauntlet')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
