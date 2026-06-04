import * as fs from 'fs-extra';
import * as path from 'path';
import { formatMarkdownReport as formatContextMarkdownReport, runAgenticBenchmark } from './agent-benchmark';
import type { AgentTask } from './agent-adoption';
import type { AnalysisTruthExpectation } from './analysis-mastery';
import { runLiveAgentPair, type LiveAgentArmResult, type LiveAgentCommandConfig, type LiveAgentPairResult } from './agent-live-trial';
import { saveAgenticBenchmarkReport } from './storage';

type GateStatus = 'pass' | 'warn' | 'fail';

interface QualityTargetInput {
  name?: string;
  path: string;
  expectation?: AnalysisTruthExpectation;
}

type AgentCommandConfig = LiveAgentCommandConfig;

interface QualityTrialReport {
  repo: string;
  path: string;
  task_id: string;
  task_label: string;
  task_category: string;
  task: AgentTask;
  expected_outcome: string;
  status: GateStatus;
  quality_score: number;
  with_klauro: {
    context_success: boolean;
    context_score: number;
    context_completeness: number;
    target_resolved: boolean;
    files_to_read: number;
    estimated_context_tokens: number;
    estimated_cached_solution_ms: number;
    estimated_first_run_solution_ms: number;
    provider_input_tokens?: number;
    provider_output_tokens?: number;
    provider_total_tokens?: number;
    live?: LiveAgentArmResult;
  };
  without_klauro: {
    projected_success_probability: number;
    projected_quality_score: number;
    risk_factors: string[];
    search_files: number;
    search_tokens: number;
    estimated_solution_ms: number;
    provider_input_tokens?: number;
    provider_output_tokens?: number;
    provider_total_tokens?: number;
    live?: LiveAgentArmResult;
  };
  deltas: {
    quality_score_delta: number;
    success_probability_delta: number;
    token_reduction_vs_search_percentage: number;
    time_reduction_vs_search_percentage: number;
    file_reduction_vs_search_percentage: number;
    context_completeness_delta: number;
  };
  live_pair?: LiveAgentPairResult;
}

function parseArgs(argv: string[]) {
  const repos: QualityTargetInput[] = [];
  let outputPath = path.join(process.cwd(), '.klauro-agent-quality-benchmark', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.klauro-agent-quality-benchmark', 'latest-report.md');
  let includeRealRepos = false;
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let maxTargets = 6;
  let maxTasksPerRepo = 8;
  let task: AgentTask | undefined;
  const commands: AgentCommandConfig = {};
  let liveRequested = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[++i];
      if (!value) throw new Error('--repo requires a path or name=path value');
      const [namePart, repoPathPart] = value.includes('=') ? value.split('=') : [undefined, value];
      const repoPath = path.resolve(repoPathPart);
      repos.push({ name: namePart || path.basename(repoPath), path: repoPath, expectation: {} });
    } else if (arg === '--real-repos') {
      includeRealRepos = true;
    } else if (arg === '--dev-root') {
      devRoot = path.resolve(argv[++i]);
    } else if (arg === '--max-targets') {
      maxTargets = Number(argv[++i]);
    } else if (arg === '--max-tasks-per-repo') {
      maxTasksPerRepo = Number(argv[++i]);
    } else if (arg === '--task-type') {
      task = { ...(task || {}), task_type: argv[++i] as any };
    } else if (arg === '--target') {
      task = { ...(task || {}), target: argv[++i] };
    } else if (arg === '--instructions') {
      task = { ...(task || {}), instructions: argv[++i] };
    } else if (arg === '--success-criterion') {
      task = { ...(task || {}), success_criteria: [...(task?.success_criteria || []), argv[++i]] };
    } else if (arg === '--agent-with-cmd') {
      commands.withKlauro = argv[++i];
    } else if (arg === '--agent-without-cmd') {
      commands.withoutKlauro = argv[++i];
    } else if (arg === '--orchestrator-cmd' || arg === '--evaluator-cmd') {
      commands.orchestrator = argv[++i];
    } else if (arg === '--test-command') {
      commands.testCommand = argv[++i];
    } else if (arg === '--work-root') {
      commands.workRoot = path.resolve(argv[++i]);
    } else if (arg === '--max-live-tasks') {
      commands.maxLiveTasks = Number(argv[++i]);
    } else if (arg === '--live-task-type') {
      const value = argv[++i];
      if (!value) throw new Error('--live-task-type requires a value');
      commands.liveTaskTypes = [...(commands.liveTaskTypes || []), value];
    } else if (arg === '--live-task-category') {
      const value = argv[++i];
      if (!value) throw new Error('--live-task-category requires a value');
      commands.liveTaskCategories = [...(commands.liveTaskCategories || []), value];
    } else if (arg === '--timeout-ms') {
      commands.timeoutMs = Number(argv[++i]);
    } else if (arg === '--test-timeout-ms') {
      commands.testTimeoutMs = Number(argv[++i]);
    } else if (arg === '--orchestrator-timeout-ms') {
      commands.orchestratorTimeoutMs = Number(argv[++i]);
    } else if (arg === '--discard-workspaces') {
      commands.keepWorkspaces = false;
    } else if (arg === '--live') {
      liveRequested = true;
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--markdown') {
      markdownPath = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, outputPath, markdownPath, includeRealRepos, devRoot, maxTargets, maxTasksPerRepo, task, commands, liveRequested };
}

function printHelp(): void {
  console.log([
    'Usage: npm run agent-quality-benchmark -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo       Run a specific repo. May be repeated.',
    '  --real-repos                   Include discovered repos under --dev-root.',
    '  --dev-root /path               Root used for real repo discovery.',
    '  --max-targets n                Limit total targets.',
    '  --max-tasks-per-repo n         Limit generated tasks per repo.',
    '  --task-type type               orient|modify|debug|review|trace|cross-repo|runtime.',
    '  --target query                 Target for one task.',
    '  --instructions text            Specific task instructions for requested-task and live runs.',
    '  --success-criterion text       Success criterion for requested-task and live runs. May be repeated.',
    '  --agent-with-cmd command       Optional live agent command template for the with-Klauro arm.',
    '  --agent-without-cmd command    Optional live agent command template for the without-Klauro arm.',
    '  --orchestrator-cmd command     Optional evaluator command template for comparing both diffs.',
    '  --test-command command         Optional command to run after each live agent attempt.',
    '  --work-root /path              Directory for live repo copies and artifacts.',
    '  --max-live-tasks n             Maximum task pairs to run with live agents.',
    '  --live-task-type type          Only run live pairs for this task type. May be repeated.',
    '  --live-task-category category  Only run live pairs for this generated category. May be repeated.',
    '  --timeout-ms n                 Per-agent command timeout.',
    '  --test-timeout-ms n            Per-test command timeout.',
    '  --discard-workspaces           Remove copied repos after collecting diffs.',
    '  --output /path/report.json     Write JSON report.',
    '  --markdown /path/report.md     Write Markdown report.',
    '',
    'Command templates may include {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.',
    'Orchestrator templates may also include {with_workspace}, {without_workspace}, {with_diff}, {without_diff}, {evaluation_input}, and {evaluation_file}.',
  ].join('\n'));
}

export async function runAgentQualityBenchmark(options: {
  repos: QualityTargetInput[];
  includeRealRepos?: boolean;
  devRoot?: string;
  maxTargets?: number;
  maxTasksPerRepo?: number;
  task?: AgentTask;
  commands?: AgentCommandConfig;
  live?: boolean;
  quiet?: boolean;
}) {
  if (options.live && !(options.commands?.withKlauro && options.commands?.withoutKlauro)) {
    throw new Error('Live benchmark requires --agent-with-cmd and --agent-without-cmd');
  }

  const contextReport = await runAgenticBenchmark({
    repos: options.repos,
    includeFixtures: false,
    includeRealRepos: options.includeRealRepos,
    devRoot: options.devRoot,
    maxTargets: options.maxTargets,
    maxTasksPerRepo: options.maxTasksPerRepo,
    task: options.task,
    suite: !options.task,
    quiet: options.quiet,
  });

  const liveEnabled = Boolean(options.commands?.withKlauro && options.commands?.withoutKlauro);
  const trials: QualityTrialReport[] = [];
  let liveTasksStarted = 0;
  for (const target of contextReport.targets) {
    for (const task of target.tasks) {
      const trial = buildQualityTrial(target, task);
      const maxLiveTasks = options.commands?.maxLiveTasks;
      if (liveEnabled && shouldRunLiveTask(task, options.commands) && (maxLiveTasks === undefined || liveTasksStarted < maxLiveTasks)) {
        liveTasksStarted++;
        trial.live_pair = await runLiveAgentPair({
          repo: target.name,
          repoPath: target.path,
          taskId: task.task_id,
          taskLabel: task.task_label,
          taskCategory: task.task_category,
          task: task.task,
          expectedOutcome: task.expected_outcome,
          fileReadPlan: task.file_read_plan,
          selectedNode: task.selected_node,
          validationPlan: task.validation_plan,
        }, options.commands!);
        trial.with_klauro.live = trial.live_pair.with_klauro;
        trial.without_klauro.live = trial.live_pair.without_klauro;
        applyLiveResult(trial);
      }
      trials.push(trial);
    }
  }

  const generatedAt = new Date().toISOString();
  const report = {
    generated_at: generatedAt,
    generatedAt,
    benchmark_type: liveEnabled ? 'live-agent-quality-ab' : 'deterministic-agent-quality-proxy',
    status: aggregateStatus(trials.map(trial => trial.status)),
    score: Math.round(average(trials.map(trial => trial.quality_score))),
    summary: summarizeQuality(trials, contextReport.targets.length),
    context_benchmark: contextReport,
    context_markdown: formatContextMarkdownReport(contextReport),
    trials,
  };

  return report;
}

function shouldRunLiveTask(task: any, commands?: AgentCommandConfig): boolean {
  const taskTypes = commands?.liveTaskTypes || [];
  const taskCategories = commands?.liveTaskCategories || [];
  const typeMatches = taskTypes.length === 0 || taskTypes.includes(String(task.task?.task_type || ''));
  const categoryMatches = taskCategories.length === 0 || taskCategories.includes(String(task.task_category || ''));
  return typeMatches && categoryMatches;
}

function buildQualityTrial(target: any, task: any): QualityTrialReport {
  const comparison = task.agentic_comparison;
  const withContextCompleteness = contextCompleteness(task);
  const withoutQuality = Math.round(task.solution.without_klauro_proxy.projected_success_probability * 100);
  const qualityScore = Math.round(average([
    task.score,
    withContextCompleteness,
    task.solution.with_klauro.success ? 100 : 0,
    Boolean(task.selected_node) || task.task.task_type === 'orient' ? 100 : 85,
  ]));

  return {
    repo: target.name,
    path: target.path,
    task_id: task.task_id,
    task_label: task.task_label,
    task_category: task.task_category,
    task: task.task,
    expected_outcome: task.expected_outcome,
    status: statusFromScore(qualityScore),
    quality_score: qualityScore,
    with_klauro: {
      context_success: task.solution.with_klauro.success,
      context_score: task.score,
      context_completeness: withContextCompleteness,
      target_resolved: Boolean(task.selected_node) || task.task.task_type === 'orient',
      files_to_read: comparison.with_klauro.files_to_read,
      estimated_context_tokens: comparison.with_klauro.total_context_tokens,
      estimated_cached_solution_ms: comparison.with_klauro.estimated_cached_solution_ms,
      estimated_first_run_solution_ms: comparison.with_klauro.estimated_first_run_solution_ms,
    },
    without_klauro: {
      projected_success_probability: task.solution.without_klauro_proxy.projected_success_probability,
      projected_quality_score: withoutQuality,
      risk_factors: task.solution.without_klauro_proxy.risk_factors,
      search_files: comparison.without_klauro.search_strategy_files,
      search_tokens: comparison.without_klauro.search_strategy_tokens,
      estimated_solution_ms: comparison.without_klauro.search_strategy_estimated_solution_ms,
    },
    deltas: {
      quality_score_delta: qualityScore - withoutQuality,
      success_probability_delta: task.solution.advantage.success_probability_delta,
      token_reduction_vs_search_percentage: comparison.deltas.search_strategy_token_reduction_percentage,
      time_reduction_vs_search_percentage: task.solution.advantage.time_reduction_vs_search_percentage,
      file_reduction_vs_search_percentage: comparison.deltas.search_strategy_file_reduction_percentage,
      context_completeness_delta: withContextCompleteness - withoutQuality,
    },
  };
}

function contextCompleteness(task: any): number {
  const gates = task.gates || [];
  const wanted = ['target-resolved', 'file-plan-present', 'mcp-followups-present', 'coding-context-present', 'risk-context-present', 'selected-file-included'];
  const selected = gates.filter((gate: any) => wanted.includes(gate.id));
  if (selected.length === 0) return task.score;
  return Math.round(average(selected.map((gate: any) => gate.score)));
}

function applyLiveResult(trial: QualityTrialReport): void {
  const livePair = trial.live_pair;
  if (!livePair?.with_klauro.attempted || !livePair.without_klauro.attempted) return;

  trial.quality_score = livePair.evaluation.with_klauro_quality_score;
  trial.status = statusFromScore(livePair.evaluation.with_klauro_quality_score);
  trial.with_klauro.provider_input_tokens = livePair.with_klauro.provider_input_tokens;
  trial.with_klauro.provider_output_tokens = livePair.with_klauro.provider_output_tokens;
  trial.with_klauro.provider_total_tokens = livePair.with_klauro.provider_total_tokens;
  trial.without_klauro.provider_input_tokens = livePair.without_klauro.provider_input_tokens;
  trial.without_klauro.provider_output_tokens = livePair.without_klauro.provider_output_tokens;
  trial.without_klauro.provider_total_tokens = livePair.without_klauro.provider_total_tokens;
  trial.deltas.quality_score_delta = livePair.evaluation.quality_score_delta;
  trial.deltas.time_reduction_vs_search_percentage = livePair.evaluation.time_reduction_percentage;
  if (livePair.evaluation.token_reduction_percentage !== null) {
    trial.deltas.token_reduction_vs_search_percentage = livePair.evaluation.token_reduction_percentage;
  }
}

function summarizeQuality(trials: QualityTrialReport[], targetCount: number) {
  const liveTrials = trials.filter(trial => trial.live_pair);
  const withProviderTokens = liveTrials.map(trial => trial.live_pair?.with_klauro.provider_total_tokens).filter((value): value is number => typeof value === 'number');
  const withoutProviderTokens = liveTrials.map(trial => trial.live_pair?.without_klauro.provider_total_tokens).filter((value): value is number => typeof value === 'number');
  const liveTokenReductions = liveTrials.map(trial => trial.live_pair?.evaluation.token_reduction_percentage).filter((value): value is number => typeof value === 'number');
  return {
    target_count: targetCount,
    task_count: trials.length,
    with_klauro_success_rate: Number((average(trials.map(trial => trial.with_klauro.context_success ? 100 : 0)) / 100).toFixed(2)),
    projected_without_klauro_success_rate: Number((average(trials.map(trial => trial.without_klauro.projected_success_probability * 100)) / 100).toFixed(2)),
    average_quality_score: Math.round(average(trials.map(trial => trial.quality_score))),
    average_quality_score_delta: Math.round(average(trials.map(trial => trial.deltas.quality_score_delta))),
    average_token_reduction_vs_search: Math.round(average(trials.map(trial => trial.deltas.token_reduction_vs_search_percentage))),
    average_time_reduction_vs_search: Math.round(average(trials.map(trial => trial.deltas.time_reduction_vs_search_percentage))),
    average_file_reduction_vs_search: Math.round(average(trials.map(trial => trial.deltas.file_reduction_vs_search_percentage))),
    average_context_completeness: Math.round(average(trials.map(trial => trial.with_klauro.context_completeness))),
    live_trials_attempted: liveTrials.length,
    live_with_klauro_success_rate: liveTrials.length === 0 ? null : Number((average(liveTrials.map(trial => trial.live_pair!.evaluation.with_klauro_success ? 100 : 0)) / 100).toFixed(2)),
    live_without_klauro_success_rate: liveTrials.length === 0 ? null : Number((average(liveTrials.map(trial => trial.live_pair!.evaluation.without_klauro_success ? 100 : 0)) / 100).toFixed(2)),
    live_average_quality_delta: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.live_pair!.evaluation.quality_score_delta))),
    live_average_with_klauro_completion_score: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.live_pair!.evaluation.with_klauro_completion_score))),
    live_average_without_klauro_completion_score: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.live_pair!.evaluation.without_klauro_completion_score))),
    live_average_completion_delta: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.live_pair!.evaluation.completion_score_delta))),
    live_with_klauro_command_success_rate: liveTrials.length === 0 ? null : Number((average(liveTrials.map(trial => trial.live_pair!.evaluation.with_klauro_command_success ? 100 : 0)) / 100).toFixed(2)),
    live_without_klauro_command_success_rate: liveTrials.length === 0 ? null : Number((average(liveTrials.map(trial => trial.live_pair!.evaluation.without_klauro_command_success ? 100 : 0)) / 100).toFixed(2)),
    live_average_time_reduction: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.live_pair!.evaluation.time_reduction_percentage))),
    live_average_token_reduction: liveTokenReductions.length === 0 ? null : Math.round(average(liveTokenReductions)),
    live_average_with_klauro_duration_ms: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.live_pair!.with_klauro.duration_ms))),
    live_average_without_klauro_duration_ms: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.live_pair!.without_klauro.duration_ms))),
    live_average_with_klauro_provider_tokens: withProviderTokens.length === 0 ? null : Math.round(average(withProviderTokens)),
    live_average_without_klauro_provider_tokens: withoutProviderTokens.length === 0 ? null : Math.round(average(withoutProviderTokens)),
    live_average_orchestrator_confidence: liveTrials.length === 0 ? null : Number(average(liveTrials.map(trial => trial.live_pair!.evaluation.confidence)).toFixed(2)),
  };
}

export function formatQualityMarkdownReport(report: Awaited<ReturnType<typeof runAgentQualityBenchmark>>): string {
  const lines = [
    '# Klauro Agent Work Quality Benchmark',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Benchmark type: ${report.benchmark_type}`,
    '',
    '## Executive Summary',
    '',
    `Targets: ${report.summary.target_count}`,
    `Tasks: ${report.summary.task_count}`,
    `With Klauro context success rate: ${Math.round(report.summary.with_klauro_success_rate * 100)}%`,
    `Projected without-Klauro success rate: ${Math.round(report.summary.projected_without_klauro_success_rate * 100)}%`,
    `Average work quality score: ${report.summary.average_quality_score}/100`,
    `Average quality delta: ${signed(report.summary.average_quality_score_delta)} points`,
    `Average token reduction vs targeted search: ${report.summary.average_token_reduction_vs_search}%`,
    `Average time reduction vs targeted search: ${report.summary.average_time_reduction_vs_search}%`,
    `Average file reduction vs targeted search: ${report.summary.average_file_reduction_vs_search}%`,
    `Average context completeness: ${report.summary.average_context_completeness}/100`,
    `Live trials attempted: ${report.summary.live_trials_attempted}`,
    '',
  ];

  if (report.summary.live_trials_attempted > 0) {
    lines.push(
      '## Live Trial Summary',
      '',
      `Live with-Klauro success rate: ${Math.round((report.summary.live_with_klauro_success_rate || 0) * 100)}%`,
      `Live without-Klauro success rate: ${Math.round((report.summary.live_without_klauro_success_rate || 0) * 100)}%`,
      `Live quality delta: ${signed(report.summary.live_average_quality_delta || 0)} points`,
      `Live with-Klauro completion score: ${report.summary.live_average_with_klauro_completion_score}/100`,
      `Live without-Klauro completion score: ${report.summary.live_average_without_klauro_completion_score}/100`,
      `Live completion delta: ${report.summary.live_average_completion_delta === null ? 'n/a' : `${report.summary.live_average_completion_delta >= 0 ? '+' : ''}${report.summary.live_average_completion_delta} points`}`,
      `Live with-Klauro command success rate: ${Math.round((report.summary.live_with_klauro_command_success_rate || 0) * 100)}%`,
      `Live without-Klauro command success rate: ${Math.round((report.summary.live_without_klauro_command_success_rate || 0) * 100)}%`,
      `Live time reduction: ${report.summary.live_average_time_reduction}%`,
      `Live token reduction: ${report.summary.live_average_token_reduction === null ? 'not reported by provider' : `${report.summary.live_average_token_reduction}%`}`,
      `Live average with-Klauro duration: ${report.summary.live_average_with_klauro_duration_ms}ms`,
      `Live average without-Klauro duration: ${report.summary.live_average_without_klauro_duration_ms}ms`,
      `Live average orchestrator confidence: ${report.summary.live_average_orchestrator_confidence}`,
      ''
    );
  }

  lines.push(
    '## Repository Summary',
    '',
    '| Repo | Tasks | Avg Quality | Success | Baseline Success | Token Reduction | Time Reduction |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );

  const byRepo = groupBy(report.trials, trial => trial.repo);
  for (const [repo, trials] of Object.entries(byRepo)) {
    lines.push(`| ${repo} | ${trials.length} | ${Math.round(average(trials.map(trial => trial.quality_score)))} | ${Math.round(average(trials.map(trial => trial.with_klauro.context_success ? 100 : 0)))}% | ${Math.round(average(trials.map(trial => trial.without_klauro.projected_success_probability * 100)))}% | ${Math.round(average(trials.map(trial => trial.deltas.token_reduction_vs_search_percentage)))}% | ${Math.round(average(trials.map(trial => trial.deltas.time_reduction_vs_search_percentage)))}% |`);
  }

  lines.push('', '## Task Trials', '');
  for (const trial of report.trials) {
    lines.push(`### ${trial.repo}: ${trial.task_label}`);
    lines.push('');
    lines.push(`Status: ${trial.status}, quality ${trial.quality_score}/100, projected baseline ${trial.without_klauro.projected_quality_score}/100`);
    lines.push(`Expected: ${trial.expected_outcome}`);
    lines.push(`With Klauro: ${trial.with_klauro.estimated_context_tokens} estimated tokens, ${trial.with_klauro.files_to_read} files, ${trial.with_klauro.context_completeness}/100 context completeness, ${trial.with_klauro.estimated_cached_solution_ms}ms cached solution.`);
    lines.push(`Without Klauro: ${trial.without_klauro.search_tokens} search tokens, ${trial.without_klauro.search_files} files, ${trial.without_klauro.estimated_solution_ms}ms projected solution.`);
    lines.push(`Deltas: ${signed(trial.deltas.quality_score_delta)} quality points, ${trial.deltas.token_reduction_vs_search_percentage}% token reduction, ${trial.deltas.time_reduction_vs_search_percentage}% time reduction.`);
    if (trial.live_pair) {
      lines.push(`Live with Klauro: ${trial.live_pair.with_klauro.duration_ms}ms, ${trial.live_pair.with_klauro.files_changed} files changed, provider tokens ${trial.live_pair.with_klauro.provider_total_tokens || 'not reported'}, patch quality ${trial.live_pair.evaluation.with_klauro_quality_score}/100, completion ${trial.live_pair.evaluation.with_klauro_completion_score}/100, validation ${statusWord(trial.live_pair.with_klauro.validation_passed)}, command ${statusWord(trial.live_pair.with_klauro.command_passed)}.`);
      lines.push(`Live without Klauro: ${trial.live_pair.without_klauro.duration_ms}ms, ${trial.live_pair.without_klauro.files_changed} files changed, provider tokens ${trial.live_pair.without_klauro.provider_total_tokens || 'not reported'}, patch quality ${trial.live_pair.evaluation.without_klauro_quality_score}/100, completion ${trial.live_pair.evaluation.without_klauro_completion_score}/100, validation ${statusWord(trial.live_pair.without_klauro.validation_passed)}, command ${statusWord(trial.live_pair.without_klauro.command_passed)}.`);
      lines.push(`Orchestrator: ${trial.live_pair.evaluation.mode}, confidence ${trial.live_pair.evaluation.confidence}, reasons: ${trial.live_pair.evaluation.reasons.join('; ')}`);
      lines.push(`Artifacts: ${trial.live_pair.artifacts.trial_directory}`);
    }
    if (trial.without_klauro.risk_factors.length > 0) lines.push(`Baseline risks: ${trial.without_klauro.risk_factors.join('; ')}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function statusWord(value: boolean | undefined): string {
  if (value === true) return 'pass';
  if (value === false) return 'fail';
  return 'not-run';
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    const key = keyFn(item);
    groups[key] = groups[key] || [];
    groups[key].push(item);
    return groups;
  }, {});
}

function statusFromScore(score: number): GateStatus {
  if (score >= 90) return 'pass';
  if (score >= 70) return 'warn';
  return 'fail';
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function average(values: number[]): number {
  if (values.length === 0) return 100;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runAgentQualityBenchmark({
    repos: args.repos,
    includeRealRepos: args.includeRealRepos,
    devRoot: args.devRoot,
    maxTargets: args.maxTargets,
    maxTasksPerRepo: args.maxTasksPerRepo,
    task: args.task,
    commands: args.commands,
    live: args.liveRequested,
  });

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(args.markdownPath));
  await fs.writeFile(args.markdownPath, formatQualityMarkdownReport(report), 'utf8');
  const saved = await saveAgenticBenchmarkReport(report);
  console.log(`Agent work quality benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
  console.log(`Tasks: ${report.summary.task_count} | With Klauro context success ${Math.round(report.summary.with_klauro_success_rate * 100)}% | Projected baseline success ${Math.round(report.summary.projected_without_klauro_success_rate * 100)}% | Quality delta ${signed(report.summary.average_quality_score_delta)} | Token reduction ${report.summary.average_token_reduction_vs_search}% | Time reduction ${report.summary.average_time_reduction_vs_search}%`);
  if (report.summary.live_trials_attempted > 0) {
    console.log(`Live trials: ${report.summary.live_trials_attempted} | With Klauro success ${Math.round((report.summary.live_with_klauro_success_rate || 0) * 100)}% | Without Klauro success ${Math.round((report.summary.live_without_klauro_success_rate || 0) * 100)}% | Live quality delta ${signed(report.summary.live_average_quality_delta || 0)} | Live token reduction ${report.summary.live_average_token_reduction === null ? 'not reported' : `${report.summary.live_average_token_reduction}%`}`);
  }
  console.log(`Report: ${args.outputPath}`);
  console.log(`Markdown: ${args.markdownPath}`);
  console.log(`Persisted MCP report: ${saved.file}`);
  if (report.status === 'fail') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
