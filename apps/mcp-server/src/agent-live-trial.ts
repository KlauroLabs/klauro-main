import * as fs from 'fs-extra';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentTask } from './agent-adoption';

const execFileAsync = promisify(execFile);

type GateStatus = 'pass' | 'warn' | 'fail';
type LiveArm = 'with-klauro' | 'without-klauro';

export interface LiveAgentCommandConfig {
  withKlauro?: string;
  withoutKlauro?: string;
  orchestrator?: string;
  testCommand?: string;
  workRoot?: string;
  keepWorkspaces?: boolean;
  timeoutMs?: number;
  testTimeoutMs?: number;
  orchestratorTimeoutMs?: number;
  maxLiveTasks?: number;
  liveTaskTypes?: string[];
  liveTaskCategories?: string[];
}

export interface LiveAgentPairInput {
  repo: string;
  repoPath: string;
  taskId: string;
  taskLabel: string;
  taskCategory: string;
  task: AgentTask;
  expectedOutcome: string;
  fileReadPlan: unknown[];
  selectedNode?: unknown;
  validationPlan?: unknown;
  idiomContext?: unknown;
}

export interface LiveAgentArmResult {
  attempted: boolean;
  arm: LiveArm;
  status: GateStatus;
  workspace: string;
  prompt_file: string;
  metrics_file: string;
  result_file: string;
  diff_file: string;
  work_packet_file?: string;
  duration_ms: number;
  exit_code?: number;
  files_changed: number;
  changed_files: string[];
  lines_added: number;
  lines_deleted: number;
  command_passed?: boolean;
  validation_passed?: boolean;
  timed_out?: boolean;
  tests_passed?: boolean;
  test_command?: string;
  provider_input_tokens?: number;
  provider_output_tokens?: number;
  provider_total_tokens?: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_total_tokens: number;
  estimated_source_read_tokens?: number;
  estimated_work_tokens?: number;
  tool_calls?: number;
  files_read?: number;
  tests_run?: number;
  task_success?: boolean;
  self_reported_quality_score?: number;
  stdout_tail?: string;
  stderr_tail?: string;
  error?: string;
}

export interface LiveAgentPairResult {
  trial_id: string;
  status: GateStatus;
  work_root: string;
  with_klauro: LiveAgentArmResult;
  without_klauro: LiveAgentArmResult;
  evaluation: LivePairEvaluation;
  artifacts: {
    trial_directory: string;
    evaluation_input_file: string;
    evaluation_file: string;
    with_diff_file: string;
    without_diff_file: string;
  };
}

export interface LivePairEvaluation {
  mode: 'deterministic-orchestrator' | 'external-orchestrator';
  status: GateStatus;
  with_klauro_quality_score: number;
  without_klauro_quality_score: number;
  quality_score_delta: number;
  with_klauro_success: boolean;
  without_klauro_success: boolean;
  token_reduction_percentage: number | null;
  time_reduction_percentage: number;
  file_change_delta: number;
  changed_file_precision_delta: number;
  with_klauro_completion_score: number;
  without_klauro_completion_score: number;
  completion_score_delta: number;
  with_klauro_command_success: boolean;
  without_klauro_command_success: boolean;
  confidence: number;
  reasons: string[];
  external?: {
    command: string;
    exit_code: number;
    duration_ms: number;
    stdout_tail?: string;
    stderr_tail?: string;
  };
}

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  signal?: string;
}

interface AgentMetricFile {
  provider_input_tokens?: number;
  input_tokens?: number;
  prompt_tokens?: number;
  provider_output_tokens?: number;
  output_tokens?: number;
  completion_tokens?: number;
  provider_total_tokens?: number;
  total_tokens?: number;
  tool_calls?: number;
  files_read?: number | unknown[];
  source_files_read?: number | unknown[];
  tests_run?: number | unknown[];
  task_success?: boolean;
  success?: boolean;
  quality_score?: number;
}

export async function runLiveAgentPair(input: LiveAgentPairInput, config: LiveAgentCommandConfig): Promise<LiveAgentPairResult> {
  if (!config.withKlauro || !config.withoutKlauro) {
    throw new Error('Live agent pair requires both with-Klauro and without-Klauro command templates');
  }

  const trialId = `${slugify(input.repo)}-${slugify(input.taskId)}-${Date.now()}`;
  const workRoot = path.resolve(config.workRoot || path.join(process.env.HOME || process.cwd(), '.klauro', 'agent-live-trials'));
  const trialDirectory = path.join(workRoot, trialId);
  await fs.ensureDir(trialDirectory);

  const withResult = await runLiveAgentArm(input, 'with-klauro', config.withKlauro, config, trialDirectory);
  const withoutResult = await runLiveAgentArm(input, 'without-klauro', config.withoutKlauro, config, trialDirectory);
  const evaluation = await evaluateLivePair(input, withResult, withoutResult, config, trialDirectory);
  const status = aggregateStatus([withResult.status, withoutResult.status, evaluation.status]);

  if (config.keepWorkspaces === false) {
    await fs.remove(path.join(trialDirectory, 'with-klauro'));
    await fs.remove(path.join(trialDirectory, 'without-klauro'));
  }

  return {
    trial_id: trialId,
    status,
    work_root: workRoot,
    with_klauro: withResult,
    without_klauro: withoutResult,
    evaluation,
    artifacts: {
      trial_directory: trialDirectory,
      evaluation_input_file: path.join(trialDirectory, 'evaluation-input.json'),
      evaluation_file: path.join(trialDirectory, 'evaluation.json'),
      with_diff_file: withResult.diff_file,
      without_diff_file: withoutResult.diff_file,
    },
  };
}

async function runLiveAgentArm(
  input: LiveAgentPairInput,
  arm: LiveArm,
  commandTemplate: string,
  config: LiveAgentCommandConfig,
  trialDirectory: string
): Promise<LiveAgentArmResult> {
  const workspace = path.join(trialDirectory, arm);
  const promptFile = path.join(trialDirectory, `${arm}-prompt.md`);
  const workPacketFile = arm === 'with-klauro' ? path.join(trialDirectory, `${arm}-work-packet.json`) : undefined;
  const metricsFile = path.join(workspace, '.klauro-live-metrics.json');
  const resultFile = path.join(workspace, '.klauro-live-result.json');
  const diffFile = path.join(trialDirectory, `${arm}.diff`);
  const prompt = arm === 'with-klauro'
    ? promptWithKlauro(input, workspace, metricsFile, resultFile, workPacketFile)
    : promptWithoutKlauro(input, workspace, metricsFile, resultFile);
  const startedAt = Date.now();

  try {
    await copyRepo(input.repoPath, workspace);
    if (workPacketFile) {
      await fs.writeJson(workPacketFile, buildLiveWorkPacket(input, workspace), { spaces: 2 });
    }
    await fs.writeFile(promptFile, prompt, 'utf8');
    await initializeBaseline(workspace);

    const command = renderCommand(commandTemplate, {
      workspace,
      prompt,
      prompt_file: promptFile,
      metrics_file: metricsFile,
      result_file: resultFile,
      arm,
      task_id: input.taskId,
    });
    const result = await runShell(command, workspace, config.timeoutMs || 20 * 60 * 1000);
    const test = config.testCommand ? await runShell(config.testCommand, workspace, config.testTimeoutMs || 10 * 60 * 1000) : undefined;
    const diff = await diffStats(workspace, diffFile);
    const metrics = await readMetricFile(metricsFile, resultFile);
    const parsed = parseMetricsFromText(`${result.stdout}\n${result.stderr}`);
    const providerInputTokens = firstNumber(metrics.provider_input_tokens, metrics.input_tokens, metrics.prompt_tokens, parsed.provider_input_tokens);
    const providerOutputTokens = firstNumber(metrics.provider_output_tokens, metrics.output_tokens, metrics.completion_tokens, parsed.provider_output_tokens);
    const providerTotalTokens = firstNumber(metrics.provider_total_tokens, metrics.total_tokens, parsed.provider_total_tokens, sumIfPresent(providerInputTokens, providerOutputTokens));
    const estimatedInputTokens = estimateTokens(prompt.length);
    const estimatedOutputTokens = estimateTokens(result.stdout.length + result.stderr.length);
    const filesRead = firstNumber(metricCount(metrics.files_read), metricCount(metrics.source_files_read), metricCount(parsed.files_read));
    const sourceReadTokens = await estimateSourceReadTokens(workspace, filesRead);
    const commandPassed = result.exitCode === 0;
    const validationPassed = test ? test.exitCode === 0 : undefined;
    const taskSuccess = firstBoolean(metrics.task_success, metrics.success, validationPassed, commandPassed && (!test || test.exitCode === 0));

    return {
      attempted: true,
      arm,
      status: armStatus(commandPassed, validationPassed),
      workspace,
      prompt_file: promptFile,
      metrics_file: metricsFile,
      result_file: resultFile,
      diff_file: diffFile,
      work_packet_file: workPacketFile,
      duration_ms: Date.now() - startedAt,
      exit_code: result.exitCode,
      files_changed: diff.files,
      changed_files: diff.changedFiles,
      lines_added: diff.added,
      lines_deleted: diff.deleted,
      command_passed: commandPassed,
      validation_passed: validationPassed,
      timed_out: result.timedOut,
      tests_passed: test ? test.exitCode === 0 : undefined,
      test_command: config.testCommand,
      provider_input_tokens: providerInputTokens,
      provider_output_tokens: providerOutputTokens,
      provider_total_tokens: providerTotalTokens,
      estimated_input_tokens: estimatedInputTokens,
      estimated_output_tokens: estimatedOutputTokens,
      estimated_total_tokens: estimatedInputTokens + estimatedOutputTokens,
      estimated_source_read_tokens: sourceReadTokens,
      estimated_work_tokens: estimatedInputTokens + estimatedOutputTokens + sourceReadTokens,
      tool_calls: firstNumber(metrics.tool_calls, parsed.tool_calls),
      files_read: filesRead,
      tests_run: firstNumber(metricCount(metrics.tests_run), metricCount(parsed.tests_run)),
      task_success: taskSuccess,
      self_reported_quality_score: clampScore(firstNumber(metrics.quality_score)),
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr || test?.stderr || ''),
    };
  } catch (error) {
    return {
      attempted: true,
      arm,
      status: 'fail',
      workspace,
      prompt_file: promptFile,
      metrics_file: metricsFile,
      result_file: resultFile,
      diff_file: diffFile,
      work_packet_file: workPacketFile,
      duration_ms: Date.now() - startedAt,
      files_changed: 0,
      changed_files: [],
      lines_added: 0,
      lines_deleted: 0,
      estimated_input_tokens: estimateTokens(prompt.length),
      estimated_output_tokens: 0,
      estimated_total_tokens: estimateTokens(prompt.length),
      estimated_work_tokens: estimateTokens(prompt.length),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function evaluateLivePair(
  input: LiveAgentPairInput,
  withResult: LiveAgentArmResult,
  withoutResult: LiveAgentArmResult,
  config: LiveAgentCommandConfig,
  trialDirectory: string
): Promise<LivePairEvaluation> {
  const deterministic = deterministicEvaluation(input, withResult, withoutResult);
  const evaluationInputFile = path.join(trialDirectory, 'evaluation-input.json');
  const evaluationFile = path.join(trialDirectory, 'evaluation.json');
  await fs.writeJson(evaluationInputFile, { input, with_klauro: withResult, without_klauro: withoutResult, deterministic }, { spaces: 2 });

  if (!config.orchestrator) {
    await fs.writeJson(evaluationFile, deterministic, { spaces: 2 });
    return deterministic;
  }

  const startedAt = Date.now();
  const command = renderCommand(config.orchestrator, {
    workspace: trialDirectory,
    prompt: '',
    prompt_file: evaluationInputFile,
    metrics_file: evaluationFile,
    result_file: evaluationFile,
    arm: 'orchestrator',
    task_id: input.taskId,
    with_workspace: withResult.workspace,
    without_workspace: withoutResult.workspace,
    with_diff: withResult.diff_file,
    without_diff: withoutResult.diff_file,
    evaluation_input: evaluationInputFile,
    evaluation_file: evaluationFile,
  });
  const result = await runShell(command, trialDirectory, config.orchestratorTimeoutMs || 10 * 60 * 1000);
  const external = await readOptionalJson(evaluationFile);
  const merged = mergeExternalEvaluation(deterministic, external);
  merged.mode = 'external-orchestrator';
  merged.external = {
    command,
    exit_code: result.exitCode,
    duration_ms: Date.now() - startedAt,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
  if (result.exitCode !== 0) {
    merged.status = 'fail';
    merged.reasons.push(`External orchestrator exited ${result.exitCode}`);
  }
  await fs.writeJson(evaluationFile, merged, { spaces: 2 });
  return merged;
}

function deterministicEvaluation(input: LiveAgentPairInput, withResult: LiveAgentArmResult, withoutResult: LiveAgentArmResult): LivePairEvaluation {
  const expectsEdit = taskExpectsEdit(input);
  const expectedEditFiles = extractExpectedEditFiles(input);
  const withPrecision = !expectsEdit && withResult.changed_files.length === 0 ? 100 : changedFilePrecision(withResult.changed_files, expectedEditFiles);
  const withoutPrecision = !expectsEdit && withoutResult.changed_files.length === 0 ? 100 : changedFilePrecision(withoutResult.changed_files, expectedEditFiles);
  const withScore = armQualityScore(withResult, withPrecision, expectsEdit);
  const withoutScore = armQualityScore(withoutResult, withoutPrecision, expectsEdit);
  const withCompletionScore = armCompletionScore(withResult);
  const withoutCompletionScore = armCompletionScore(withoutResult);
  const tokenReduction = tokenReductionPercentage(withResult, withoutResult);
  const precisionDelta = precisionMetricDelta(withPrecision, withoutPrecision);
  const reasons = [
    `With Klauro changed ${withResult.files_changed} files and ${withResult.lines_added + withResult.lines_deleted} lines.`,
    `Without Klauro changed ${withoutResult.files_changed} files and ${withoutResult.lines_added + withoutResult.lines_deleted} lines.`,
    withPrecision === undefined || withoutPrecision === undefined
      ? 'Changed-file precision was not scored because no explicit expected edit file list was available.'
      : `With Klauro changed-file precision ${withPrecision}/100; without-Klauro precision ${withoutPrecision}/100.`,
    `With Klauro completion score ${withCompletionScore}/100; without-Klauro completion score ${withoutCompletionScore}/100.`,
  ];
  if (withResult.provider_total_tokens || withoutResult.provider_total_tokens) {
    reasons.push(`Provider token totals: with ${withResult.provider_total_tokens || 'unknown'}, without ${withoutResult.provider_total_tokens || 'unknown'}.`);
  } else {
    reasons.push(`Provider token totals were not reported; estimated live work tokens: with ${withResult.estimated_work_tokens || withResult.estimated_total_tokens}, without ${withoutResult.estimated_work_tokens || withoutResult.estimated_total_tokens}.`);
  }

  return {
    mode: 'deterministic-orchestrator',
    status: statusFromScore(withScore),
    with_klauro_quality_score: withScore,
    without_klauro_quality_score: withoutScore,
    quality_score_delta: withScore - withoutScore,
    with_klauro_success: armSucceeded(withResult, withScore),
    without_klauro_success: armSucceeded(withoutResult, withoutScore),
    token_reduction_percentage: tokenReduction,
    time_reduction_percentage: percentReduction(withoutResult.duration_ms, withResult.duration_ms),
    file_change_delta: withoutResult.files_changed - withResult.files_changed,
    changed_file_precision_delta: precisionDelta,
    with_klauro_completion_score: withCompletionScore,
    without_klauro_completion_score: withoutCompletionScore,
    completion_score_delta: withCompletionScore - withoutCompletionScore,
    with_klauro_command_success: withResult.command_passed === true,
    without_klauro_command_success: withoutResult.command_passed === true,
    confidence: withResult.tests_passed !== undefined || withoutResult.tests_passed !== undefined ? 0.82 : 0.68,
    reasons,
  };
}

function extractExpectedEditFiles(input: LiveAgentPairInput): string[] {
  const values = [
    input.task.target,
    ...(input.task.related_paths || []),
    input.task.instructions,
    input.expectedOutcome,
    ...(input.task.success_criteria || []),
    ...input.fileReadPlan.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      return [record.file, record.path]
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
    }),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return unique(values.flatMap(extractPathLikeFragments));
}

function armQualityScore(result: LiveAgentArmResult, changedFilePrecision: number | undefined, expectsEdit: boolean): number {
  const validationScore = result.validation_passed === true
    ? 100
    : result.validation_passed === false ? 0 : result.status === 'pass' ? 100 : result.status === 'warn' ? 80 : 0;
  const editScore = expectsEdit
    ? result.files_changed > 0 ? 100 : 50
    : result.files_changed === 0 ? 100 : result.files_changed <= 2 ? 85 : 60;
  const editSizeScore = expectsEdit
    ? result.files_changed <= 6 ? 100 : Math.max(40, 100 - (result.files_changed - 6) * 5)
    : result.files_changed <= 1 ? 100 : Math.max(40, 100 - (result.files_changed - 1) * 10);
  const scores = [
    validationScore,
    result.task_success === undefined ? 80 : result.task_success ? 100 : 0,
    editScore,
    editSizeScore,
  ];
  if (changedFilePrecision !== undefined) scores.push(changedFilePrecision);
  if (typeof result.self_reported_quality_score === 'number') scores.push(result.self_reported_quality_score);
  return Math.round(average(scores));
}

function armSucceeded(result: LiveAgentArmResult, score: number): boolean {
  if (result.command_passed === true && result.validation_passed === true && result.task_success !== false) return true;
  return score >= 90;
}

function precisionMetricDelta(withPrecision: number | undefined, withoutPrecision: number | undefined): number {
  if (withPrecision === undefined || withoutPrecision === undefined) return 0;
  return withPrecision - withoutPrecision;
}

function armCompletionScore(result: LiveAgentArmResult): number {
  if (result.command_passed) return 100;
  if (result.validation_passed) return result.timed_out ? 55 : 70;
  if (result.timed_out) return 20;
  return 35;
}

function armStatus(commandPassed: boolean, validationPassed?: boolean): GateStatus {
  if (commandPassed && validationPassed !== false) return 'pass';
  if (validationPassed === true) return 'warn';
  return 'fail';
}

function taskExpectsEdit(input: LiveAgentPairInput): boolean {
  if (input.task.task_type === 'modify') return true;
  const text = [input.task.instructions, input.expectedOutcome, input.taskLabel].filter(Boolean).join(' ').toLowerCase();
  return /\b(change|update|add|remove|delete|rename|implement|fix|replace|edit)\b/.test(text);
}

function mergeExternalEvaluation(deterministic: LivePairEvaluation, external: any): LivePairEvaluation {
  if (!external || typeof external !== 'object') return { ...deterministic, reasons: [...deterministic.reasons, 'External orchestrator did not write parseable JSON; deterministic evaluation retained.'] };
  const withScore = clampScore(firstNumber(external.with_klauro_quality_score, external.with_quality_score, external.with_score)) ?? deterministic.with_klauro_quality_score;
  const withoutScore = clampScore(firstNumber(external.without_klauro_quality_score, external.without_quality_score, external.without_score)) ?? deterministic.without_klauro_quality_score;
  const reasons = Array.isArray(external.reasons) ? external.reasons.map(String) : deterministic.reasons;
  return {
    ...deterministic,
    status: statusFromScore(withScore),
    with_klauro_quality_score: withScore,
    without_klauro_quality_score: withoutScore,
    quality_score_delta: withScore - withoutScore,
    with_klauro_success: firstBoolean(external.with_klauro_success, withScore >= 90) ?? withScore >= 90,
    without_klauro_success: firstBoolean(external.without_klauro_success, withoutScore >= 90) ?? withoutScore >= 90,
    confidence: typeof external.confidence === 'number' ? Math.max(0, Math.min(1, external.confidence)) : deterministic.confidence,
    reasons,
  };
}

function buildLiveWorkPacket(input: LiveAgentPairInput, workspace: string) {
  return {
    source: 'klauro-live-trial',
    path: workspace,
    generated_at: new Date().toISOString(),
    task: input.task,
    task_label: input.taskLabel,
    task_category: input.taskCategory,
    expected_outcome: input.expectedOutcome,
    selected_node: input.selectedNode || null,
    file_read_plan: input.fileReadPlan,
    validation_plan: input.validationPlan || null,
    idiom_context: input.idiomContext || null,
    source_reading_rule: 'Read only the line_window slices in file_read_plan first. Expand to whole files only when those slices show a concrete gap.',
    next_steps: [
      'Use file_read_plan to inspect the target files before broad repository search.',
      input.idiomContext ? 'Follow idiom_context for naming, placement, boundary, testing, migration, and error/logging style.' : '',
      'Make an edit only when the task requires one.',
      'For behavior changes, inspect and update focused tests from validation_plan or file_read_plan when a relevant test file is available.',
      'Run the narrowest validation that proves the expected outcome.',
      'Record task_success, quality_score, files_read, and tests_run in the result JSON.',
    ].filter(Boolean),
  };
}

function promptWithKlauro(input: LiveAgentPairInput, workspace: string, metricsFile: string, resultFile: string, workPacketFile?: string): string {
  const filePlan = input.fileReadPlan
    .map(item => {
      const value = item as any;
      return [
        value.file || value.path || String(item),
        value.line_window?.instruction,
        value.reason,
      ].filter(Boolean).join(' - ');
    })
    .slice(0, 12);
  const validationCommands = Array.isArray((input.validationPlan as any)?.commands)
    ? (input.validationPlan as any).commands
      .map((command: any) => String(command.command || '').trim())
      .filter(Boolean)
      .slice(0, 5)
    : [];
  const idiomSummary = formatIdiomContextForPrompt(input.idiomContext);
  return [
    `Repository copy: ${workspace}`,
    `Task: ${input.taskLabel}`,
    `Task category: ${input.taskCategory}`,
    `Expected outcome: ${input.expectedOutcome}`,
    input.task.instructions ? `Instructions: ${input.task.instructions}` : '',
    input.task.success_criteria?.length ? `Success criteria: ${input.task.success_criteria.join('; ')}` : '',
    '',
    'Use Klauro before broad source reads.',
    workPacketFile ? `Immediately read this precomputed Klauro work packet first: ${workPacketFile}.` : '',
    'Do not regenerate analysis or run broad repository discovery before using the work packet.',
    `If MCP tools are available, call get_agent_work_packet only if the precomputed packet is missing or unreadable. Use follow-up MCP tools only when the packet names a concrete need.`,
    filePlan.length ? `Precomputed Klauro file-read plan: ${filePlan.join('; ')}` : '',
    validationCommands.length ? `Klauro validation commands: ${validationCommands.join('; ')}` : '',
    input.idiomContext ? 'The work packet includes idiom_context. Treat it as required local style guidance: preserve naming, placement, module boundaries, validation, tests, migrations, auth/tenant scope, error handling, logging, async style, and configuration conventions.' : '',
    idiomSummary ? `Compact idiom_context:\n${idiomSummary}` : '',
    'Read only the work packet and the planned line_window slices first. Expand beyond them only if they prove insufficient for the requested change.',
    'For behavior changes, inspect and update focused tests named by the work packet when feasible.',
    'Use the work packet to choose files, make an edit only when the task requires one, and run relevant tests when possible.',
    'Do not install dependencies or run broad environment setup unless the task explicitly asks for it. If the existing environment cannot run a broad test, record that and stop after focused validation.',
    '',
    `When finished, write JSON to ${resultFile} with keys: task_success, quality_score, files_read, tests_run, provider_input_tokens, provider_output_tokens, provider_total_tokens, notes.`,
    `If your runtime exposes token metrics separately, write them to ${metricsFile}.`,
  ].join('\n');
}

function formatIdiomContextForPrompt(idiomContext: unknown): string {
  if (!idiomContext || typeof idiomContext !== 'object') return '';
  const context = idiomContext as any;
  const lines: string[] = [];
  const selected = Array.isArray(context.selected_idioms) ? context.selected_idioms.slice(0, 5) : [];
  for (const idiom of selected) {
    lines.push(`- ${idiom.category || 'idiom'}: ${idiom.name || idiom.id || 'local convention'}`);
    const doItems = Array.isArray(idiom.do) ? idiom.do.slice(0, 2) : [];
    const avoidItems = Array.isArray(idiom.avoid) ? idiom.avoid.slice(0, 2) : [];
    const validation = Array.isArray(idiom.validation) ? idiom.validation.slice(0, 2) : [];
    if (doItems.length) lines.push(`  Do: ${doItems.join(' | ')}`);
    if (avoidItems.length) lines.push(`  Avoid: ${avoidItems.join(' | ')}`);
    if (validation.length) lines.push(`  Validate: ${validation.join(' | ')}`);
  }
  const examples = Array.isArray(context.local_examples) ? context.local_examples.slice(0, 4) : [];
  if (examples.length) {
    lines.push('Local examples:');
    for (const example of examples) {
      lines.push(`- ${example.file}${example.line ? `:${example.line}` : ''} (${example.category || example.idiom_id || 'idiom'}): ${example.explanation || 'positive example'}`);
    }
  }
  return lines.join('\n').slice(0, 3500);
}

function promptWithoutKlauro(input: LiveAgentPairInput, workspace: string, metricsFile: string, resultFile: string): string {
  return [
    `Repository copy: ${workspace}`,
    `Task: ${input.taskLabel}`,
    `Task category: ${input.taskCategory}`,
    `Expected outcome: ${input.expectedOutcome}`,
    input.task.instructions ? `Instructions: ${input.task.instructions}` : '',
    input.task.success_criteria?.length ? `Success criteria: ${input.task.success_criteria.join('; ')}` : '',
    '',
    'Do not use Klauro, its MCP server, CAS output, generated work packets, or precomputed analysis.',
    'Use normal repository exploration, make an edit only when the task requires one, and run relevant tests when possible.',
    'Do not install dependencies or run broad environment setup unless the task explicitly asks for it. If the existing environment cannot run a broad test, record that and stop after focused validation.',
    '',
    `When finished, write JSON to ${resultFile} with keys: task_success, quality_score, files_read, tests_run, provider_input_tokens, provider_output_tokens, provider_total_tokens, notes.`,
    `If your runtime exposes token metrics separately, write them to ${metricsFile}.`,
  ].join('\n');
}

async function copyRepo(source: string, destination: string): Promise<void> {
  await fs.copy(source, destination, {
    filter: file => {
      const relative = path.relative(source, file);
      if (!relative) return true;
      const normalized = relative.replace(/\\/g, '/');
      if (/\.(?:map|bundle|min)\.(?:js|css)$/i.test(normalized) || /\.(?:js|css)\.map$/i.test(normalized)) {
        return false;
      }
      const parts = normalized.split('/');
      return !parts.some(part => [
        '.git',
        '.claude',
        '.codex',
        '.scannerwork',
        'node_modules',
        'vendor',
        'vendors',
        'dist',
        'build',
        'target',
        'coverage',
        '.next',
        '.turbo',
        '.venv',
        'venv',
        'env',
        'site-packages',
        '.cache',
        '.sourcemaps',
        'sourcemaps',
        '__pycache__',
        '.pytest_cache',
        '.mypy_cache',
        '.ruff_cache',
        '.DS_Store',
        'Generated',
        'generated',
        '.klauro-cache',
        '.klauro-agent-benchmark',
        '.klauro-agent-quality-benchmark',
        '.klauro-agent-live-trials',
        '.klauro-agent-home',
      ].includes(part));
    },
  });
}

async function initializeBaseline(workspace: string): Promise<void> {
  const init = await runShell('git init', workspace, 60 * 1000);
  if (init.exitCode !== 0) throw new Error(`Failed to initialize live benchmark git repo: ${tail(init.stderr || init.stdout)}`);
  const add = await runShell('git add .', workspace, 120 * 1000);
  if (add.exitCode !== 0) throw new Error(`Failed to stage live benchmark baseline: ${tail(add.stderr || add.stdout)}`);
  await execFileAsync('git', ['commit', '-m', 'benchmark baseline'], { cwd: workspace, env: gitEnv(), timeout: 120 * 1000 });
  const head = await runShell('git rev-parse --verify HEAD', workspace, 60 * 1000);
  if (head.exitCode !== 0) throw new Error(`Failed to create live benchmark baseline commit: ${tail(head.stderr || head.stdout)}`);
}

async function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync('/bin/sh', ['-lc', command], { cwd, maxBuffer: 1024 * 1024 * 50, timeout: timeoutMs });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, durationMs: Date.now() - startedAt };
  } catch (error: any) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || String(error),
      durationMs: Date.now() - startedAt,
      timedOut: error.killed === true || error.signal === 'SIGTERM' || String(error.message || '').toLowerCase().includes('timed out'),
      signal: error.signal,
    };
  }
}

async function diffStats(workspace: string, diffFile: string): Promise<{ files: number; added: number; deleted: number; changedFiles: string[] }> {
  const [numstat, names, diff] = await Promise.all([
    runShell('git diff --numstat', workspace, 60 * 1000),
    runShell('git diff --name-only', workspace, 60 * 1000),
    runShell('git diff --binary', workspace, 60 * 1000),
  ]);
  await fs.writeFile(diffFile, diff.stdout, 'utf8');
  const rows = numstat.stdout.split('\n').filter(Boolean);
  const stats = rows.reduce((result, row) => {
    const [added, deleted] = row.split(/\s+/);
    result.files++;
    result.added += Number(added) || 0;
    result.deleted += Number(deleted) || 0;
    return result;
  }, { files: 0, added: 0, deleted: 0 });
  return {
    ...stats,
    changedFiles: names.stdout.split('\n').map(line => line.trim()).filter(Boolean),
  };
}

async function readMetricFile(metricsFile: string, resultFile: string): Promise<AgentMetricFile> {
  const metrics = await readOptionalJson(metricsFile);
  const result = await readOptionalJson(resultFile);
  return { ...(metrics || {}), ...(result || {}) };
}

async function readOptionalJson(file: string): Promise<any | undefined> {
  if (!(await fs.pathExists(file))) return undefined;
  try {
    return await fs.readJson(file);
  } catch {
    return undefined;
  }
}

function renderCommand(command: string, values: Record<string, string>): string {
  let rendered = command;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${key}}`, shellQuote(value));
  }
  return rendered;
}

function parseMetricsFromText(text: string): AgentMetricFile {
  const jsonMetrics = parseJsonMetricsFromText(text);
  return {
    ...jsonMetrics,
    provider_input_tokens: firstNumber(jsonMetrics.provider_input_tokens, numberFromText(text, [/input tokens?[^\n\r\d]+([\d,]+)/i, /prompt tokens?[^\n\r\d]+([\d,]+)/i])),
    provider_output_tokens: firstNumber(jsonMetrics.provider_output_tokens, numberFromText(text, [/output tokens?[^\n\r\d]+([\d,]+)/i, /completion tokens?[^\n\r\d]+([\d,]+)/i])),
    provider_total_tokens: firstNumber(jsonMetrics.provider_total_tokens, numberFromText(text, [/total tokens?[^\n\r\d]+([\d,]+)/i, /tokens used[^\n\r]*[\n\r]+\s*([\d,]+)/i, /tokens used[^\n\r\d]+([\d,]+)/i])),
    tool_calls: firstNumber(jsonMetrics.tool_calls, numberFromText(text, [/tool calls?[^\n\r\d]+([\d,]+)/i])),
    files_read: firstNumber(metricCount(jsonMetrics.files_read), numberFromText(text, [/files read[^\n\r\d]+([\d,]+)/i, /source files read[^\n\r\d]+([\d,]+)/i])),
    tests_run: firstNumber(metricCount(jsonMetrics.tests_run), numberFromText(text, [/tests run[^\n\r\d]+([\d,]+)/i])),
  };
}

function parseJsonMetricsFromText(text: string): AgentMetricFile {
  const metrics: AgentMetricFile = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      collectMetricNumbers(JSON.parse(trimmed), metrics);
    } catch {
      continue;
    }
  }
  return metrics;
}

function collectMetricNumbers(value: unknown, metrics: AgentMetricFile): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(record)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (typeof raw === 'number') {
      if (['input_tokens', 'inputtokens', 'prompt_tokens', 'prompttokens', 'provider_input_tokens'].includes(normalized)) metrics.provider_input_tokens = metrics.provider_input_tokens ?? raw;
      if (['output_tokens', 'outputtokens', 'completion_tokens', 'completiontokens', 'provider_output_tokens'].includes(normalized)) metrics.provider_output_tokens = metrics.provider_output_tokens ?? raw;
      if (['total_tokens', 'totaltokens', 'provider_total_tokens', 'tokens_used', 'tokensused'].includes(normalized)) metrics.provider_total_tokens = metrics.provider_total_tokens ?? raw;
      if (['tool_calls', 'toolcalls', 'tool_call_count'].includes(normalized)) metrics.tool_calls = metrics.tool_calls ?? raw;
    } else if (Array.isArray(raw)) {
      if (['files_read', 'source_files_read'].includes(normalized)) metrics.files_read = metrics.files_read ?? raw.length;
      if (['tests_run'].includes(normalized)) metrics.tests_run = metrics.tests_run ?? raw.length;
      for (const item of raw) collectMetricNumbers(item, metrics);
    } else if (raw && typeof raw === 'object') {
      collectMetricNumbers(raw, metrics);
    }
  }
}

function numberFromText(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return Number(match[1].replace(/,/g, ''));
  }
  return undefined;
}

function changedFilePrecision(changedFiles: string[], plannedFiles: string[]): number | undefined {
  if (plannedFiles.length === 0) return undefined;
  if (changedFiles.length === 0) return 60;
  const matches = changedFiles.filter(file => plannedFiles.some(planned => pathsCompatible(file, planned))).length;
  return Math.round((matches / changedFiles.length) * 100);
}

function extractPathLikeFragments(value: string): string[] {
  const matches = value.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+)?/g) || [];
  return matches
    .map(match => match.replace(/^['"`(]+|['"`),.;:]+$/g, ''))
    .filter(match => match.includes('/') && match.length >= 5 && isSourceLikePath(match));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isSourceLikePath(value: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|cs|java|php|dart|json|ya?ml|toml|md|sql|prisma)$/i.test(value) ||
    /(^|\/)(package\.json|pyproject\.toml|go\.mod|cargo\.toml|pubspec\.yaml|composer\.json|requirements\.txt)$/i.test(value);
}

function tokenReductionPercentage(withResult: LiveAgentArmResult, withoutResult: LiveAgentArmResult): number | null {
  const withTokens = withResult.provider_total_tokens || withResult.estimated_work_tokens || withResult.estimated_total_tokens;
  const withoutTokens = withoutResult.provider_total_tokens || withoutResult.estimated_work_tokens || withoutResult.estimated_total_tokens;
  if (!withTokens || !withoutTokens) return null;
  return percentReduction(withoutTokens, withTokens);
}

async function estimateSourceReadTokens(workspace: string, filesRead?: number): Promise<number> {
  if (!filesRead || filesRead <= 0) return 0;
  const sourceFiles = await collectSourceFiles(workspace, 200);
  if (sourceFiles.length === 0) return 0;
  const sample = sourceFiles.slice(0, 80);
  let totalTokens = 0;
  let counted = 0;
  for (const file of sample) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 250_000) continue;
      const content = await fs.readFile(file, 'utf8');
      totalTokens += estimateTokens(content.length);
      counted++;
    } catch {
      continue;
    }
  }
  if (counted === 0) return 0;
  const averageSourceFileTokens = Math.max(200, Math.round(totalTokens / counted));
  return averageSourceFileTokens * filesRead;
}

async function collectSourceFiles(root: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  async function walk(directory: string): Promise<void> {
    if (results.length >= limit) return;
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if ([
        '.git',
        'node_modules',
        'dist',
        'build',
        'target',
        'coverage',
        '.next',
        '.turbo',
        '.venv',
        'venv',
        '__pycache__',
      ].includes(entry)) continue;
      const fullPath = path.join(directory, entry);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(fullPath);
      } else if (isSourceLikePath(path.relative(root, fullPath))) {
        results.push(fullPath);
      }
    }
  }
  await walk(root);
  return results;
}

function percentReduction(baseline: number, actual: number): number {
  if (baseline <= 0) return actual <= 0 ? 100 : 0;
  return Math.round(((baseline - actual) / baseline) * 100);
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function statusFromScore(score: number): GateStatus {
  if (score >= 90) return 'pass';
  if (score >= 70) return 'warn';
  return 'fail';
}

function average(values: number[]): number {
  if (values.length === 0) return 100;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metricCount(value: number | unknown[] | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find(value => typeof value === 'number' && Number.isFinite(value));
}

function firstBoolean(...values: Array<boolean | undefined>): boolean | undefined {
  return values.find(value => typeof value === 'boolean');
}

function sumIfPresent(left?: number, right?: number): number | undefined {
  if (typeof left !== 'number' && typeof right !== 'number') return undefined;
  return (left || 0) + (right || 0);
}

function clampScore(value?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = value > 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function estimateTokens(size: number): number {
  return Math.max(1, Math.ceil(size / 4));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Klauro Benchmark',
    GIT_AUTHOR_EMAIL: 'benchmark@klauro.local',
    GIT_COMMITTER_NAME: 'Klauro Benchmark',
    GIT_COMMITTER_EMAIL: 'benchmark@klauro.local',
  };
}

function tail(value: string): string {
  return value.split('\n').slice(-30).join('\n').trim();
}

function pathsCompatible(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedRight = right.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function slugify(input: string | undefined): string {
  return String(input || 'target')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80) || 'target';
}
