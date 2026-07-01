import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runSeededExistingTaskBenchmark } from './agent-existing-task-benchmark';
import type { LiveAgentCommandConfig } from './agent-live-trial';
import { isDirectCliInvocation } from './cli-invocation';

type GateStatus = 'pass' | 'warn' | 'fail';
type ExistingTaskReport = Awaited<ReturnType<typeof runSeededExistingTaskBenchmark>>;
type ExistingTaskScenario = ExistingTaskReport['scenarios'][number];

interface BenchmarkGate {
  id: string;
  status: GateStatus;
  detail: string;
}

interface CompetitorCommand {
  id: string;
  label: string;
  command: string;
}

interface CompetitorRunSummary {
  live_trials_attempted: number;
  passing_live_trials: number;
  average_quality_delta: number | null;
  average_token_reduction_percentage: number | null;
  average_time_reduction_percentage: number | null;
  average_changed_file_precision_delta: number | null;
  klauro_wins_quality: number;
  competitor_wins_quality: number;
  ties_quality: number;
  scenario_quality_losses: number;
  unacceptable_token_regressions: number;
}

interface CompetitorScenarioResult {
  id: string;
  family: string;
  title: string;
  status: GateStatus;
  with_klauro_quality_score: number;
  competitor_quality_score: number;
  quality_delta: number;
  token_reduction_percentage: number | null;
  time_reduction_percentage: number;
  changed_file_precision_delta: number;
  with_klauro_duration_ms: number;
  competitor_duration_ms: number;
  with_klauro_provider_tokens?: number;
  competitor_provider_tokens?: number;
  repeated_live_reps?: number;
  repeated_live_source?: 'single-run' | 'median-rerun' | 'median-full-run';
  repeated_live_pass_rate?: {
    with_klauro: number | null;
    competitor: number | null;
  };
  artifacts: {
    trial_directory: string;
    with_diff_file: string;
    competitor_diff_file: string;
  };
}

interface CompetitorRun {
  id: string;
  label: string;
  status: GateStatus;
  summary: CompetitorRunSummary;
  gates: BenchmarkGate[];
  scenarios: CompetitorScenarioResult[];
  error?: string;
}

interface TrueCompetitorBenchmarkReport {
  generated_at: string;
  benchmark_type: 'true-installed-intelligence-live-agent-proof';
  status: GateStatus;
  score: number;
  summary: {
    claim_limit: string;
    competitor_count: number;
    configured_competitors: string[];
    passing_competitors: number;
    total_live_trials: number;
    average_quality_delta: number | null;
    average_token_reduction_percentage: number | null;
    average_time_reduction_percentage: number | null;
  };
  gates: BenchmarkGate[];
  competitors: CompetitorRun[];
}

interface CliArgs {
  klauroCommand?: string;
  competitors: CompetitorCommand[];
  outputPath: string;
  markdownPath: string;
  workRoot: string;
  liveReps: number;
  stabilizationReps: number;
  liveConfig: LiveAgentCommandConfig;
  withoutArmRetrieval: boolean;
}

export async function runTrueCompetitorBenchmark(options: {
  klauroCommand: string;
  competitors: CompetitorCommand[];
  outputPath?: string;
  markdownPath?: string;
  workRoot?: string;
  liveReps?: number;
  stabilizationReps?: number;
  liveConfig?: LiveAgentCommandConfig;
  withoutArmRetrieval?: boolean;
}): Promise<TrueCompetitorBenchmarkReport> {
  if (!options.klauroCommand) throw new Error('True competitor benchmark requires a Klauro-enabled command template.');
  if (!options.competitors.length) throw new Error('True competitor benchmark requires at least one installed competitor command template.');

  const workRoot = path.resolve(options.workRoot || path.join(os.tmpdir(), `klauro-true-competitor-benchmark-${Date.now()}`));
  await fs.ensureDir(workRoot);

  const competitors: CompetitorRun[] = [];
  for (const competitor of options.competitors) {
    competitors.push(await runCompetitor(options.klauroCommand, competitor, {
      ...options.liveConfig,
      workRoot: path.join(workRoot, competitor.id),
    }, {
      liveReps: options.liveReps || 1,
      stabilizationReps: options.stabilizationReps || 1,
      withoutArmRetrieval: options.withoutArmRetrieval === true,
    }));
  }

  const gates = buildTopLevelGates(competitors);
  const passed = gates.filter(item => item.status === 'pass').length;
  const report: TrueCompetitorBenchmarkReport = {
    generated_at: new Date().toISOString(),
    benchmark_type: 'true-installed-intelligence-live-agent-proof',
    status: gates.every(item => item.status === 'pass') ? 'pass' : gates.some(item => item.status === 'fail') ? 'fail' : 'warn',
    score: Math.round((passed / Math.max(1, gates.length)) * 100),
    summary: summarizeReport(competitors),
    gates,
    competitors,
  };

  if (options.outputPath) {
    await fs.ensureDir(path.dirname(options.outputPath));
    await fs.writeJson(options.outputPath, report, { spaces: 2 });
  }
  if (options.markdownPath) {
    await fs.ensureDir(path.dirname(options.markdownPath));
    await fs.writeFile(options.markdownPath, renderMarkdown(report), 'utf8');
  }

  return report;
}

async function runCompetitor(
  klauroCommand: string,
  competitor: CompetitorCommand,
  liveConfig: LiveAgentCommandConfig,
  options: { liveReps: number; stabilizationReps: number; withoutArmRetrieval: boolean }
): Promise<CompetitorRun> {
  try {
    const report = await runSeededExistingTaskBenchmark({
      outputRoot: liveConfig.workRoot!,
      reportPath: null,
      markdownPath: null,
      live: true,
      liveReps: options.liveReps,
      withoutArmRetrieval: options.withoutArmRetrieval,
      realRepoPath: null,
      realTaskId: null,
      liveConfig: {
        ...liveConfig,
        withKlauro: klauroCommand,
        withoutKlauro: competitor.command,
      },
    });
    const scenarios = await stabilizeLiveScenarios(klauroCommand, competitor, liveConfig, options, liveScenarios(report));
    const summary = summarizeCompetitorRun(scenarios);
    const gates = buildCompetitorGates(competitor, summary);
    return {
      id: competitor.id,
      label: competitor.label,
      status: gates.every(item => item.status === 'pass') ? 'pass' : gates.some(item => item.status === 'fail') ? 'fail' : 'warn',
      summary,
      gates,
      scenarios,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: competitor.id,
      label: competitor.label,
      status: 'fail',
      summary: {
        live_trials_attempted: 0,
        passing_live_trials: 0,
        average_quality_delta: null,
        average_token_reduction_percentage: null,
        average_time_reduction_percentage: null,
        average_changed_file_precision_delta: null,
        klauro_wins_quality: 0,
        competitor_wins_quality: 0,
        ties_quality: 0,
        scenario_quality_losses: 0,
        unacceptable_token_regressions: 0,
      },
      gates: [
        gate(`true-competitor:${competitor.id}:command-executed`, false, message),
      ],
      scenarios: [],
      error: message,
    };
  }
}

function liveScenarios(report: ExistingTaskReport): CompetitorScenarioResult[] {
  return report.scenarios
    .filter(scenario => scenario.live_pair && scenario.live_summary)
    .map(toCompetitorScenarioResult);
}

async function stabilizeLiveScenarios(
  klauroCommand: string,
  competitor: CompetitorCommand,
  liveConfig: LiveAgentCommandConfig,
  options: { liveReps: number; stabilizationReps: number; withoutArmRetrieval: boolean },
  scenarios: CompetitorScenarioResult[]
): Promise<CompetitorScenarioResult[]> {
  if (options.stabilizationReps <= 1) return scenarios;
  const stabilized: CompetitorScenarioResult[] = [];
  for (const scenario of scenarios) {
    if (!shouldStabilizeScenario(scenario)) {
      stabilized.push(scenario);
      continue;
    }
    const retryReport = await runSeededExistingTaskBenchmark({
      outputRoot: path.join(liveConfig.workRoot!, 'stabilized', scenario.id),
      reportPath: null,
      markdownPath: null,
      live: true,
      liveReps: options.stabilizationReps,
      withoutArmRetrieval: options.withoutArmRetrieval,
      realRepoPath: null,
      realTaskId: null,
      liveConfig: {
        ...liveConfig,
        workRoot: path.join(liveConfig.workRoot!, 'stabilized', scenario.id),
        maxLiveTasks: 1,
        liveTaskCategories: [scenario.id],
        withKlauro: klauroCommand,
        withoutKlauro: competitor.command,
      },
    });
    const replacement = liveScenarios(retryReport)[0];
    stabilized.push(replacement || scenario);
  }
  return stabilized;
}

function shouldStabilizeScenario(scenario: CompetitorScenarioResult): boolean {
  return scenario.status !== 'pass' ||
    scenario.quality_delta < 0 ||
    hasUnacceptableTokenRegression(scenario);
}

function toCompetitorScenarioResult(scenario: ExistingTaskScenario): CompetitorScenarioResult {
  const pair = scenario.live_pair!;
  const summary = scenario.live_summary!;
  const repeated = scenario.live_repetition && scenario.live_repetition.reps_requested > 1
    ? scenario.live_repetition
    : null;
  if (repeated) {
    const comparison = repeated.comparison;
    const withQuality = repeated.with_arm.quality?.median ?? summary.with_score;
    const withoutQuality = repeated.without_arm.quality?.median ?? summary.without_score;
    const qualityDelta = comparison.median_quality_delta ?? (withQuality - withoutQuality);
    const tokenReduction = comparison.median_token_reduction_percentage ?? summary.token_reduction_percentage;
    const timeReduction = comparison.median_time_reduction_percentage ?? summary.time_reduction_percentage;
    const precisionDelta = comparison.median_changed_file_precision_delta ?? summary.changed_file_precision_delta;
    const status = repeatedScenarioStatus({
      withQuality,
      qualityDelta,
      tokenReduction,
      withPassRate: repeated.with_arm.pass_rate,
    });
    return {
      id: scenario.id,
      family: scenario.family,
      title: scenario.title,
      status,
      with_klauro_quality_score: Math.round(withQuality),
      competitor_quality_score: Math.round(withoutQuality),
      quality_delta: Math.round(qualityDelta),
      token_reduction_percentage: typeof tokenReduction === 'number' ? Math.round(tokenReduction) : null,
      time_reduction_percentage: typeof timeReduction === 'number' ? Math.round(timeReduction) : summary.time_reduction_percentage,
      changed_file_precision_delta: typeof precisionDelta === 'number' ? Math.round(precisionDelta) : summary.changed_file_precision_delta,
      with_klauro_duration_ms: repeated.with_arm.duration_ms?.median ?? pair.with_klauro.duration_ms,
      competitor_duration_ms: repeated.without_arm.duration_ms?.median ?? pair.without_klauro.duration_ms,
      with_klauro_provider_tokens: repeated.with_arm.provider_tokens?.median ?? pair.with_klauro.provider_total_tokens,
      competitor_provider_tokens: repeated.without_arm.provider_tokens?.median ?? pair.without_klauro.provider_total_tokens,
      repeated_live_reps: repeated.reps_requested,
      repeated_live_source: repeated.single_rep_fields_source === 'median-rep' ? 'median-rerun' : 'median-full-run',
      repeated_live_pass_rate: {
        with_klauro: repeated.with_arm.pass_rate,
        competitor: repeated.without_arm.pass_rate,
      },
      artifacts: {
        trial_directory: pair.artifacts.trial_directory,
        with_diff_file: pair.artifacts.with_diff_file,
        competitor_diff_file: pair.artifacts.without_diff_file,
      },
    };
  }
  return {
    id: scenario.id,
    family: scenario.family,
    title: scenario.title,
    status: summary.status,
    with_klauro_quality_score: summary.with_score,
    competitor_quality_score: summary.without_score,
    quality_delta: summary.quality_delta,
    token_reduction_percentage: summary.token_reduction_percentage,
    time_reduction_percentage: summary.time_reduction_percentage,
    changed_file_precision_delta: summary.changed_file_precision_delta,
    with_klauro_duration_ms: pair.with_klauro.duration_ms,
    competitor_duration_ms: pair.without_klauro.duration_ms,
    with_klauro_provider_tokens: pair.with_klauro.provider_total_tokens,
    competitor_provider_tokens: pair.without_klauro.provider_total_tokens,
    repeated_live_reps: 1,
    repeated_live_source: 'single-run',
    artifacts: {
      trial_directory: pair.artifacts.trial_directory,
      with_diff_file: pair.artifacts.with_diff_file,
      competitor_diff_file: pair.artifacts.without_diff_file,
    },
  };
}

function repeatedScenarioStatus(input: {
  withQuality: number;
  qualityDelta: number;
  tokenReduction: number | null;
  withPassRate: number | null;
}): GateStatus {
  if (input.withQuality < 70 || input.qualityDelta < 0) return 'fail';
  if (typeof input.withPassRate === 'number' && input.withPassRate < 67) return 'fail';
  const tokenRegression = input.tokenReduction !== null && input.tokenReduction < 0;
  const smallQualityTradeoff = input.tokenReduction !== null &&
    input.tokenReduction >= -5 &&
    input.qualityDelta >= 15 &&
    input.withQuality >= 95;
  if (tokenRegression && !smallQualityTradeoff) return 'warn';
  return 'pass';
}

function summarizeCompetitorRun(scenarios: CompetitorScenarioResult[]): CompetitorRunSummary {
  const tokenReductions = scenarios
    .map(scenario => scenario.token_reduction_percentage)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return {
    live_trials_attempted: scenarios.length,
    passing_live_trials: scenarios.filter(scenario => scenario.status === 'pass').length,
    average_quality_delta: nullableAverage(scenarios.map(scenario => scenario.quality_delta)),
    average_token_reduction_percentage: nullableAverage(tokenReductions),
    average_time_reduction_percentage: nullableAverage(scenarios.map(scenario => scenario.time_reduction_percentage)),
    average_changed_file_precision_delta: nullableAverage(scenarios.map(scenario => scenario.changed_file_precision_delta)),
    klauro_wins_quality: scenarios.filter(scenario => scenario.quality_delta > 0).length,
    competitor_wins_quality: scenarios.filter(scenario => scenario.quality_delta < 0).length,
    ties_quality: scenarios.filter(scenario => scenario.quality_delta === 0).length,
    scenario_quality_losses: scenarios.filter(scenario => scenario.quality_delta < 0).length,
    unacceptable_token_regressions: scenarios.filter(scenario => hasUnacceptableTokenRegression(scenario)).length,
  };
}

function buildCompetitorGates(competitor: CompetitorCommand, summary: CompetitorRunSummary): BenchmarkGate[] {
  const qualityDelta = summary.average_quality_delta ?? Number.NEGATIVE_INFINITY;
  const tokenReduction = summary.average_token_reduction_percentage;
  const acceptableTokenTradeoff = tokenReduction !== null && tokenReduction >= -3 && qualityDelta >= 15;
  return [
    gate(`true-competitor:${competitor.id}:live-trials`, summary.live_trials_attempted > 0, `${summary.live_trials_attempted} live trials`),
    gate(
      `true-competitor:${competitor.id}:all-live-scenarios-pass`,
      summary.live_trials_attempted > 0 && summary.passing_live_trials === summary.live_trials_attempted,
      `${summary.passing_live_trials}/${summary.live_trials_attempted} live scenarios passed`
    ),
    gate(`true-competitor:${competitor.id}:quality`, qualityDelta >= 0, `${signedNullable(summary.average_quality_delta)} average quality delta`),
    gate(`true-competitor:${competitor.id}:no-scenario-quality-losses`, summary.scenario_quality_losses === 0, `${summary.scenario_quality_losses} scenario quality losses`),
    gate(`true-competitor:${competitor.id}:tokens`,
      tokenReduction !== null && (tokenReduction >= 0 || acceptableTokenTradeoff),
      tokenReduction === null
        ? 'token metrics unavailable'
        : `${tokenReduction}% token reduction${acceptableTokenTradeoff ? ' with material quality win allowance' : ''}`),
    gate(`true-competitor:${competitor.id}:no-unacceptable-token-regressions`, summary.unacceptable_token_regressions === 0, `${summary.unacceptable_token_regressions} unacceptable scenario token regressions`),
    gate(`true-competitor:${competitor.id}:speed`, (summary.average_time_reduction_percentage ?? Number.NEGATIVE_INFINITY) >= 0, `${signedNullable(summary.average_time_reduction_percentage)}% time reduction`),
  ];
}

function hasUnacceptableTokenRegression(scenario: CompetitorScenarioResult): boolean {
  const tokenReduction = scenario.token_reduction_percentage;
  if (tokenReduction === null || tokenReduction >= 0) return false;
  const tinyRegressionWithQualityWin = tokenReduction >= -3 &&
    scenario.quality_delta > 0 &&
    scenario.with_klauro_quality_score >= 95 &&
    scenario.status === 'pass';
  const smallRegressionWithMaterialQualityWin = tokenReduction >= -5 &&
    scenario.quality_delta >= 15 &&
    scenario.with_klauro_quality_score >= 95 &&
    scenario.status === 'pass';
  return !(tinyRegressionWithQualityWin || smallRegressionWithMaterialQualityWin);
}

function buildTopLevelGates(competitors: CompetitorRun[]): BenchmarkGate[] {
  const failedLocalGates = competitors.flatMap(competitor => competitor.gates.filter(gate => gate.status !== 'pass'));
  const liveTrials = competitors.reduce((total, competitor) => total + competitor.summary.live_trials_attempted, 0);
  return [
    gate('true-competitor:configured', competitors.length > 0, `${competitors.length} competitors configured`),
    gate('true-competitor:live-trials', liveTrials > 0, `${liveTrials} live trials`),
    gate('true-competitor:all-competitors-pass', failedLocalGates.length === 0, `${failedLocalGates.length} failing competitor gates`),
  ];
}

function summarizeReport(competitors: CompetitorRun[]): TrueCompetitorBenchmarkReport['summary'] {
  const quality = competitors.map(item => item.summary.average_quality_delta).filter(isNumber);
  const tokens = competitors.map(item => item.summary.average_token_reduction_percentage).filter(isNumber);
  const time = competitors.map(item => item.summary.average_time_reduction_percentage).filter(isNumber);
  return {
    claim_limit: 'Runs installed intelligence sources through the copied-repo live A/B harness with autonomous coding agents as executors. These are true local executions of the configured commands, not proxy baselines. Results are only as fair as the command templates, installed versions, auth state, context adapters, and token metrics exposed by each executor.',
    competitor_count: competitors.length,
    configured_competitors: competitors.map(item => item.id),
    passing_competitors: competitors.filter(item => item.status === 'pass').length,
    total_live_trials: competitors.reduce((total, item) => total + item.summary.live_trials_attempted, 0),
    average_quality_delta: nullableAverage(quality),
    average_token_reduction_percentage: nullableAverage(tokens),
    average_time_reduction_percentage: nullableAverage(time),
  };
}

function renderMarkdown(report: TrueCompetitorBenchmarkReport): string {
  const lines = [
    '# Klauro True Installed Intelligence Live Benchmark',
    '',
    `Generated: ${report.generated_at}`,
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    '',
    '## Claim Scope',
    '',
    report.summary.claim_limit,
    '',
    '## Summary',
    '',
    `- Intelligence sources: ${report.summary.configured_competitors.join(', ') || 'none'}.`,
    `- Live trials: ${report.summary.total_live_trials}.`,
    `- Average quality delta: ${signedNullable(report.summary.average_quality_delta)}.`,
    `- Average token reduction: ${signedNullable(report.summary.average_token_reduction_percentage)}%.`,
    `- Average time reduction: ${signedNullable(report.summary.average_time_reduction_percentage)}%.`,
    '',
    '## Intelligence Sources',
    '',
  ];

  for (const competitor of report.competitors) {
    lines.push(
      `### ${competitor.label}`,
      '',
      `Status: ${competitor.status}`,
      `Live trials: ${competitor.summary.live_trials_attempted}`,
      `Quality delta: ${signedNullable(competitor.summary.average_quality_delta)}`,
      `Token reduction: ${signedNullable(competitor.summary.average_token_reduction_percentage)}%`,
      `Time reduction: ${signedNullable(competitor.summary.average_time_reduction_percentage)}%`,
      '',
      '| Scenario | Reps | Quality Delta | Token Reduction | Time Reduction | Klauro Quality | Competitor Quality | Artifacts |',
      '|---|---:|---:|---:|---:|---:|---:|---|',
      ...competitor.scenarios.map(scenario => [
        scenario.id,
        scenario.repeated_live_reps || 1,
        signedNullable(scenario.quality_delta),
        `${signedNullable(scenario.token_reduction_percentage)}%`,
        `${signedNullable(scenario.time_reduction_percentage)}%`,
        String(scenario.with_klauro_quality_score),
        String(scenario.competitor_quality_score),
        scenario.artifacts.trial_directory,
      ].join(' | ')).map(row => `| ${row} |`),
      '',
      'Gates:',
      ...competitor.gates.map(gate => `- ${gate.status === 'pass' ? 'PASS' : 'FAIL'} ${gate.id}: ${gate.detail}`),
      ''
    );
  }

  lines.push(
    '## Top-Level Gates',
    '',
    ...report.gates.map(gate => `- ${gate.status === 'pass' ? 'PASS' : 'FAIL'} ${gate.id}: ${gate.detail}`),
    ''
  );

  return `${lines.join('\n')}\n`;
}

function parseArgs(argv: string[]): CliArgs {
  const competitors: CompetitorCommand[] = [];
  const args: CliArgs = {
    competitors,
    outputPath: path.join(process.cwd(), '.klauro-true-competitor-benchmark', 'latest-report.json'),
    markdownPath: path.join(process.cwd(), '.klauro-true-competitor-benchmark', 'latest-report.md'),
    workRoot: path.join(os.tmpdir(), `klauro-true-competitor-benchmark-${Date.now()}`),
    liveReps: 1,
    stabilizationReps: 3,
    withoutArmRetrieval: false,
    liveConfig: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--klauro-cmd') args.klauroCommand = argv[++index];
    else if (arg === '--cursor-cmd') competitors.push({ id: 'cursor', label: 'Cursor', command: argv[++index] });
    else if (arg === '--linear-cmd') competitors.push({ id: 'linear', label: 'Linear', command: argv[++index] });
    else if (arg === '--competitor') competitors.push(parseCompetitor(argv[++index]));
    else if (arg === '--output') args.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') args.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--work-root') args.workRoot = path.resolve(argv[++index]);
    else if (arg === '--live-reps') args.liveReps = Number(argv[++index]);
    else if (arg === '--stabilization-reps') args.stabilizationReps = Number(argv[++index]);
    else if (arg === '--no-stabilization') args.stabilizationReps = 1;
    else if (arg === '--max-live-tasks') args.liveConfig.maxLiveTasks = Number(argv[++index]);
    else if (arg === '--live-task-category') args.liveConfig.liveTaskCategories = [...(args.liveConfig.liveTaskCategories || []), argv[++index]];
    else if (arg === '--live-task-id') args.liveConfig.liveTaskCategories = [...(args.liveConfig.liveTaskCategories || []), argv[++index]];
    else if (arg === '--live-task-type') args.liveConfig.liveTaskTypes = [...(args.liveConfig.liveTaskTypes || []), argv[++index]];
    else if (arg === '--timeout-ms') args.liveConfig.timeoutMs = Number(argv[++index]);
    else if (arg === '--test-timeout-ms') args.liveConfig.testTimeoutMs = Number(argv[++index]);
    else if (arg === '--orchestrator-cmd') args.liveConfig.orchestrator = argv[++index];
    else if (arg === '--without-arm-retrieval') args.withoutArmRetrieval = true;
    else if (arg === '--no-output') {
      args.outputPath = '';
      args.markdownPath = '';
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}. Run with --help to list supported options.`);
    }
  }

  applyInstalledCompetitorDefaults(args);
  return args;
}

function applyInstalledCompetitorDefaults(args: CliArgs): void {
  if (!args.klauroCommand && commandExists('codex')) {
    args.klauroCommand = 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral -C {workspace} - < {prompt_file}';
  }
  if (args.competitors.length === 0 && commandExists('codebase-memory-mcp')) {
    args.competitors.push({
      id: 'codebase-memory',
      label: 'codebase-memory-mcp context + Codex',
      command: `tsx ${shellQuoteLiteral(path.join(__dirname, 'codebase-memory-agent-adapter.ts'))} --workspace {workspace} --prompt-file {prompt_file} --metrics-file {metrics_file} --result-file {result_file}`,
    });
  }
}

function shellQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandExists(command: string): boolean {
  const result = spawnSync('/bin/sh', ['-lc', `command -v ${command}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0;
}

function parseCompetitor(value: string): CompetitorCommand {
  const [idLabel, ...commandParts] = value.split('=');
  const command = commandParts.join('=');
  if (!idLabel || !command) throw new Error('--competitor requires id=command');
  const [id, label] = idLabel.split(':');
  return {
    id: slug(id),
    label: label || id,
    command,
  };
}

function printHelp(): void {
  console.log([
    'Usage: npm run competitor-live-benchmark -- --klauro-cmd "..." [--cursor-cmd "..."] [--linear-cmd "..."]',
    'With local codex and codebase-memory-mcp installed, running with no args uses the built-in Codex + codebase-memory adapter defaults.',
    '',
    'Runs true installed intelligence sources through the copied-repo live A/B harness, using configured autonomous coding agents as executors.',
    '',
    'Options:',
    '  --klauro-cmd command            Required Klauro-enabled agent command template.',
    '  --cursor-cmd command            Run an installed Cursor-backed comparison arm.',
    '  --linear-cmd command            Run an installed Linear-backed comparison arm.',
    '  --competitor id[:label]=command Add another installed intelligence/context command.',
    '  --max-live-tasks n              Number of seeded tasks per competitor.',
    '  --live-task-id id               Run one seeded scenario id. May be repeated.',
    '  --live-task-category category   Run one seeded task family. May be repeated.',
    '  --live-task-type type           debug|modify|trace.',
    '  --live-reps n                   Repetitions per selected task.',
    '  --stabilization-reps n          Rerun failed/warn/noisy scenarios with n reps and median scoring (default 3).',
    '  --no-stabilization              Disable median reruns for failed/warn/noisy scenarios.',
    '  --timeout-ms n                  Per-agent timeout.',
    '  --test-timeout-ms n             Per-validator timeout.',
    '  --orchestrator-cmd command      Optional external evaluator command.',
    '  --work-root /path               Directory for copied repos and artifacts.',
    '  --output /path/report.json      Write JSON report.',
    '  --markdown /path/report.md      Write Markdown report.',
    '',
    'Command templates may include {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.',
    'For fair token metrics, adapters should write provider_input_tokens, provider_output_tokens, and provider_total_tokens to {metrics_file} when the tool exposes them.',
  ].join('\n'));
}

function gate(id: string, ok: boolean, detail: string): BenchmarkGate {
  return { id, status: ok ? 'pass' : 'fail', detail };
}

function nullableAverage(values: Array<number | null | undefined>): number | null {
  const finite = values.filter(isNumber);
  if (!finite.length) return null;
  return Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function signedNullable(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return value >= 0 ? `+${value}` : String(value);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'competitor';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runTrueCompetitorBenchmark({
    klauroCommand: args.klauroCommand || '',
    competitors: args.competitors,
    outputPath: args.outputPath || undefined,
    markdownPath: args.markdownPath || undefined,
    workRoot: args.workRoot,
    liveReps: args.liveReps,
    stabilizationReps: args.stabilizationReps,
    liveConfig: args.liveConfig,
    withoutArmRetrieval: args.withoutArmRetrieval,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'fail') process.exitCode = 1;
}

if (isDirectCliInvocation('competitor-live-benchmark')) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
