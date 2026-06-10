import * as fs from 'fs-extra';
import * as os from 'os';
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
  withoutArmRetrievedFiles?: string[];
  withoutArmPromptOverrides?: WithoutArmPromptOverrides;
}

export interface WithoutArmPromptOverrides {
  taskLabel?: string;
  expectedOutcome?: string;
  instructions?: string;
  successCriteria?: string[];
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

export interface LiveAgentPairWorkspaceSources {
  withKlauroRepoPath: string;
  withoutKlauroRepoPath: string;
}

export interface LivePairEvaluation {
  mode: 'deterministic-orchestrator' | 'external-orchestrator';
  status: GateStatus;
  with_klauro_quality_score: number;
  without_klauro_quality_score: number;
  quality_score_delta: number;
  with_klauro_architecture_score?: number;
  without_klauro_architecture_score?: number;
  architecture_score_delta?: number;
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
  return runLiveAgentPairInternal(input, config);
}

export async function runLiveAgentPairFromWorkspaces(
  input: LiveAgentPairInput,
  config: LiveAgentCommandConfig,
  sources: LiveAgentPairWorkspaceSources
): Promise<LiveAgentPairResult> {
  return runLiveAgentPairInternal(input, config, sources);
}

async function runLiveAgentPairInternal(
  input: LiveAgentPairInput,
  config: LiveAgentCommandConfig,
  sources?: LiveAgentPairWorkspaceSources
): Promise<LiveAgentPairResult> {
  if (!config.withKlauro || !config.withoutKlauro) {
    throw new Error('Live agent pair requires both with-Klauro and without-Klauro command templates');
  }

  const trialId = `${slugify(input.repo)}-${slugify(input.taskId)}-${Date.now()}`;
  const workRoot = path.resolve(config.workRoot || defaultLiveTrialWorkRoot());
  const trialDirectory = path.join(workRoot, trialId);
  await fs.ensureDir(trialDirectory);

  const withResult = await runLiveAgentArm(input, 'with-klauro', config.withKlauro, config, trialDirectory, sources?.withKlauroRepoPath);
  const withoutResult = await runLiveAgentArm(input, 'without-klauro', config.withoutKlauro, config, trialDirectory, sources?.withoutKlauroRepoPath);
  const evaluation = await evaluateLivePair(input, withResult, withoutResult, config, trialDirectory);
  const status = evaluation.status;

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

export function defaultLiveTrialWorkRoot(): string {
  return path.join(os.tmpdir(), 'klauro-agent-live-trials');
}

async function runLiveAgentArm(
  input: LiveAgentPairInput,
  arm: LiveArm,
  commandTemplate: string,
  config: LiveAgentCommandConfig,
  trialDirectory: string,
  sourceRepoPath?: string
): Promise<LiveAgentArmResult> {
  const workspace = path.join(trialDirectory, arm);
  const promptFile = path.join(trialDirectory, `${arm}-prompt.md`);
  const greenfieldScratch = isGreenfieldScratchLiveTask(input);
  const workPacketFile = arm === 'with-klauro' && !greenfieldScratch
    ? path.join(trialDirectory, `${arm}-work-packet.json`)
    : undefined;
  const metricsFile = path.join(workspace, '.klauro-live-metrics.json');
  const resultFile = path.join(workspace, '.klauro-live-result.json');
  const diffFile = path.join(trialDirectory, `${arm}.diff`);
  const prompt = arm === 'with-klauro'
    ? promptWithKlauro(input, workspace, metricsFile, resultFile, workPacketFile)
    : promptWithoutKlauro(input, workspace, metricsFile, resultFile);
  const startedAt = Date.now();

  try {
    await copyRepo(sourceRepoPath || input.repoPath, workspace);
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
    const providerInputTokens = firstPositiveNumber(metrics.provider_input_tokens, metrics.input_tokens, metrics.prompt_tokens, parsed.provider_input_tokens);
    const providerOutputTokens = firstPositiveNumber(metrics.provider_output_tokens, metrics.output_tokens, metrics.completion_tokens, parsed.provider_output_tokens);
    const providerTotalTokens = firstPositiveNumber(metrics.provider_total_tokens, metrics.total_tokens, parsed.provider_total_tokens, sumIfPresent(providerInputTokens, providerOutputTokens));
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
      self_reported_quality_score: normalizeSelfReportedQualityScore(firstNumber(metrics.quality_score)),
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
  const deterministic = await evaluateLivePairDeterministically(input, withResult, withoutResult);
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

export async function evaluateLivePairDeterministically(input: LiveAgentPairInput, withResult: LiveAgentArmResult, withoutResult: LiveAgentArmResult): Promise<LivePairEvaluation> {
  const expectsEdit = taskExpectsEdit(input);
  const expectedEditFiles = extractExpectedEditFiles(input);
  const withPrecision = !expectsEdit && withResult.changed_files.length === 0 ? 100 : changedFilePrecision(withResult.changed_files, expectedEditFiles);
  const withoutPrecision = !expectsEdit && withoutResult.changed_files.length === 0 ? 100 : changedFilePrecision(withoutResult.changed_files, expectedEditFiles);
  const withBaseScore = armQualityScore(withResult, withPrecision, expectsEdit);
  const withoutBaseScore = armQualityScore(withoutResult, withoutPrecision, expectsEdit);
  const withArchitecture = await architectureContinuityScore(input, withResult);
  const withoutArchitecture = await architectureContinuityScore(input, withoutResult);
  const minimalityPenalty = liveMinimalityPenalty(withResult, withoutResult, expectsEdit);
  const withScore = applyQualityPenalty(combineQualityScores(withBaseScore, withArchitecture?.score), minimalityPenalty.with);
  const withoutScore = applyQualityPenalty(combineQualityScores(withoutBaseScore, withoutArchitecture?.score), minimalityPenalty.without);
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
  if (minimalityPenalty.with || minimalityPenalty.without) {
    reasons.push(`Minimality penalty: with ${minimalityPenalty.with}; without ${minimalityPenalty.without}.`);
  }
  if (withArchitecture || withoutArchitecture) {
    reasons.push(`Architecture continuity score: with ${withArchitecture?.score ?? 'not scored'}/100; without ${withoutArchitecture?.score ?? 'not scored'}/100.`);
    for (const finding of (withArchitecture?.findings || []).slice(0, 3)) reasons.push(`With Klauro architecture finding: ${finding}`);
    for (const finding of (withoutArchitecture?.findings || []).slice(0, 3)) reasons.push(`Without Klauro architecture finding: ${finding}`);
  }
  if (withResult.provider_total_tokens || withoutResult.provider_total_tokens) {
    reasons.push(`Provider token totals: with ${withResult.provider_total_tokens || 'unknown'}, without ${withoutResult.provider_total_tokens || 'unknown'}.`);
  } else {
    reasons.push(`Provider token totals were not reported; estimated live work tokens: with ${withResult.estimated_work_tokens || withResult.estimated_total_tokens}, without ${withoutResult.estimated_work_tokens || withoutResult.estimated_total_tokens}.`);
  }

  const status = statusFromScore(withScore);
  const tokenRegression = tokenReduction !== null && tokenReduction < 0;
  if (tokenRegression) {
    reasons.push('Klauro used more total tokens than the unguided arm; this is a product regression even when quality improves.');
  }

  return {
    mode: 'deterministic-orchestrator',
    status: tokenRegression && status === 'pass' ? 'warn' : status,
    with_klauro_quality_score: withScore,
    without_klauro_quality_score: withoutScore,
    quality_score_delta: withScore - withoutScore,
    with_klauro_architecture_score: withArchitecture?.score,
    without_klauro_architecture_score: withoutArchitecture?.score,
    architecture_score_delta: withArchitecture && withoutArchitecture ? withArchitecture.score - withoutArchitecture.score : undefined,
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

function combineQualityScores(baseScore: number, architectureScore?: number): number {
  if (architectureScore === undefined) return baseScore;
  return Math.round((baseScore * 0.45) + (architectureScore * 0.55));
}

function applyQualityPenalty(score: number, penalty: number): number {
  return Math.max(0, Math.min(100, Math.round(score - penalty)));
}

function liveMinimalityPenalty(withResult: LiveAgentArmResult, withoutResult: LiveAgentArmResult, expectsEdit: boolean): { with: number; without: number } {
  if (!expectsEdit) return { with: 0, without: 0 };
  if (withResult.validation_passed !== true || withoutResult.validation_passed !== true) return { with: 0, without: 0 };
  const withLines = withResult.lines_added + withResult.lines_deleted;
  const withoutLines = withoutResult.lines_added + withoutResult.lines_deleted;
  const linePenalty = relativeMinimalityPenalty(withLines, withoutLines, 10);
  const filePenalty = relativeMinimalityPenalty(withResult.files_changed, withoutResult.files_changed, 6);
  return {
    with: Math.max(linePenalty.with, filePenalty.with),
    without: Math.max(linePenalty.without, filePenalty.without),
  };
}

function relativeMinimalityPenalty(left: number, right: number, maxPenalty: number): { with: number; without: number } {
  if (left <= 0 || right <= 0 || left === right) return { with: 0, without: 0 };
  const larger = Math.max(left, right);
  const smaller = Math.min(left, right);
  const ratio = (larger - smaller) / larger;
  if (ratio < 0.2) return { with: 0, without: 0 };
  const penalty = Math.min(maxPenalty, Math.max(2, Math.round(ratio * maxPenalty)));
  return left > right ? { with: penalty, without: 0 } : { with: 0, without: penalty };
}

async function architectureContinuityScore(input: LiveAgentPairInput, result: LiveAgentArmResult): Promise<{ score: number; findings: string[] } | null> {
  if (!shouldScoreArchitectureContinuity(input)) return null;
  const files = await listArchitectureFiles(result.workspace);
  if (!files.length) return { score: 0, findings: ['No source files were produced.'] };
  const content = await readArchitectureContent(result.workspace, files);
  const joinedPaths = files.join('\n');
  const text = `${input.taskLabel}\n${input.task.instructions || ''}\n${input.expectedOutcome}\n${(input.task.success_criteria || []).join('\n')}`;
  const findings: string[] = [];
  let score = 100;
  const penalize = (condition: boolean, points: number, finding: string) => {
    if (!condition) {
      score -= points;
      findings.push(finding);
    }
  };
  const sourceFiles = files.filter(file => /(^|\/)(src|app|lib|packages|services)\//.test(file) && /\.(ts|tsx|js|jsx|py|rs|go|java|cs|php|dart)$/.test(file)).length;
  const tests = files.filter(file => /(^|\/)(test|tests|__tests__)\/|(\.|-)(test|spec)\./i.test(file)).length;
  const testCases = Array.from(content.matchAll(/\b(?:it|test)\s*\(/g)).length;
  const hasEntry = /route|router|controller|http|endpoint/i.test(joinedPaths);
  const hasService = /service|usecase|use-case|interactor/i.test(joinedPaths);
  const hasDataAccess = /repository|repositories|persistence|data-access|dao|store/i.test(joinedPaths);
  const hasDomain = /model|models|entity|entities|domain|schema/i.test(joinedPaths);
  const hasAuthTenant = /auth|tenant|organization|workspace|role|permission|policy/i.test(content);
  const needsWorker = /worker|job|digest|schedule|queue|background|cron|escalation/i.test(text);
  const hasWorker = /worker|job|digest|schedule|queue|background|cron|escalation/i.test(joinedPaths + '\n' + content);
  const isUiHeavy = /ui|dashboard|component|view|page|screen|command center/i.test(text);
  const needsDataAccess = /database|migration|persistence|persistent|schema|repository|storage|sql|data access/i.test(text) ||
    (!isUiHeavy && /greenfield|scratch/i.test(input.taskCategory));
  const needsPersistence = needsDataAccess;
  const hasPersistence = /(^|\/)migrations?\//i.test(joinedPaths) || /migration|schema|sql|repository|persistence/i.test(joinedPaths + '\n' + content);
  const duplicateConcepts = findArchitectureDuplicateConcepts(files, content);
  const isContinuation = /continuation|continue the existing|continue an existing|existing codebase/i.test(`${input.taskCategory}\n${input.taskLabel}\n${input.task.instructions || ''}`);

  penalize(sourceFiles >= 6, 8, 'Too little source structure for a complex product.');
  penalize(hasEntry, 10, 'No route/controller/entry boundary.');
  penalize(hasService, 10, 'No service/use-case boundary.');
  if (needsDataAccess) penalize(hasDataAccess, 10, 'No repository/data-access boundary.');
  penalize(hasDomain, 8, 'No domain model/entity boundary.');
  penalize(hasAuthTenant, 8, 'No visible tenant/auth/role boundary.');
  if (needsWorker) penalize(hasWorker, 6, 'No worker/background boundary for requested scheduled/asynchronous behavior.');
  if (needsPersistence) penalize(hasPersistence, 8, 'No persistence or migration evidence.');
  const testThreshold = isContinuation ? 3 : 1;
  penalize(tests >= testThreshold || testCases >= testThreshold, 7, isContinuation ? 'Too little focused continuation test evidence.' : 'No focused test evidence.');
  penalize(duplicateConcepts.length === 0, 12, `Potential duplicate concepts: ${duplicateConcepts.map(item => item.concept).join(', ')}.`);

  if (isContinuation) {
    const continuationTerms = [
      ['portal', /portal|public/i],
      ['attachments', /attachment/i],
      ['SLA breach notifications', /sla.*breach|breach.*sla/i],
      ['saved operational views', /operational.*view|saved.*view|view.*filter/i],
      ['webhook intake', /webhook/i],
    ] as const;
    for (const [label, pattern] of continuationTerms) {
      if (pattern.test(text)) penalize(pattern.test(content), 4, `Continuation does not represent ${label}.`);
    }
  }

  if (findings.length >= 3) score = Math.min(score, 82);
  return { score: Math.max(0, Math.min(100, score)), findings };
}

function shouldScoreArchitectureContinuity(input: LiveAgentPairInput): boolean {
  const text = `${input.taskCategory}\n${input.taskLabel}\n${input.task.instructions || ''}\n${input.expectedOutcome}`.toLowerCase();
  return /greenfield|scratch|new codebase|empty folder|continue|continuation|architecture|without rebuilding|without duplicating|large-scale|massive/.test(text);
}

async function listArchitectureFiles(root: string): Promise<string[]> {
  if (!root || !(await fs.pathExists(root))) return [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'coverage', '.next', '.turbo', '.cache', '.venv', 'venv', 'env']);
  const results: string[] = [];
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|php|dart|json|sql|toml|yaml|yml|md)$/.test(relative) && !/(^|\/)\.klauro-live-(metrics|result)\.json$/.test(relative)) {
        results.push(relative);
      }
    }
  };
  await visit(root);
  return results.sort();
}

async function readArchitectureContent(root: string, files: string[]): Promise<string> {
  const chunks: string[] = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > 300_000) continue;
    const content = await fs.readFile(absolute, 'utf8').catch(() => '');
    chunks.push(`${file}\n${content}`);
  }
  return chunks.join('\n');
}

function findArchitectureDuplicateConcepts(files: string[], content: string): Array<{ concept: string; files: string[] }> {
  const concepts = ['organization', 'workspace', 'member', 'user', 'customer', 'request', 'task', 'project', 'comment', 'attachment', 'sla', 'notification', 'audit'];
  return concepts.flatMap(concept => {
    const domainOwnerFiles = files.filter(file => {
      const base = path.basename(file).toLowerCase();
      return base.includes(concept) && /model|entity|schema|type|interface|domain/i.test(file) && !/repository|service|controller|route|worker|test|spec/i.test(file);
    });
    const definitionMatches = Array.from(content.matchAll(new RegExp(`(?:interface|class|type)\\s+\\w*${concept}\\w*`, 'gi')));
    const distinctDefinitionFiles = new Set(definitionMatches.map(match => {
      const before = content.slice(0, match.index || 0);
      const lastPathLine = before.split('\n').reverse().find(line => /\.(ts|tsx|js|jsx|py|rs|go|java|cs|php|dart)\b/.test(line));
      return lastPathLine || '';
    }).filter(file => /model|entity|schema|type|interface|domain/i.test(file) && !/repository|service|controller|route|worker|test|spec/i.test(file)));
    if (domainOwnerFiles.length > 1 && distinctDefinitionFiles.size > 1) {
      return [{ concept, files: domainOwnerFiles.slice(0, 8) }];
    }
    return [];
  });
}

function extractExpectedEditFiles(input: LiveAgentPairInput): string[] {
  const values = [
    input.task.target,
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
  const relatedPaths = (input.task.related_paths || [])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .filter(value => value.includes('/'));
  return unique([
    ...relatedPaths,
    ...values.flatMap(extractPathLikeFragments),
  ]);
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
  const changedLines = result.lines_added + result.lines_deleted;
  const lineSizeScore = changedLines === 0
    ? expectsEdit ? 50 : 100
    : changedLines <= 80 ? 100
      : changedLines <= 140 ? 95
        : changedLines <= 220 ? 85
          : Math.max(50, 85 - Math.ceil((changedLines - 220) / 80) * 5);
  const scores = [
    validationScore,
    result.task_success === undefined ? 80 : result.task_success ? 100 : 0,
    editScore,
    editSizeScore,
    lineSizeScore,
  ];
  if (changedFilePrecision !== undefined) scores.push(changedFilePrecision);
  const selfReportedQuality = normalizeSelfReportedQualityScore(result.self_reported_quality_score);
  if (typeof selfReportedQuality === 'number') scores.push(selfReportedQuality);
  return Math.round(average(scores));
}

function armSucceeded(result: LiveAgentArmResult, score: number): boolean {
  if (result.command_passed === true && result.validation_passed === true && result.task_success !== false) return true;
  if (result.command_passed === true && result.task_success === true && result.validation_passed !== false) return true;
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
  const surgical = isSurgicalLiveTask(input);
  const greenfieldScratch = isGreenfieldScratchLiveTask(input);
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
    idiom_context: greenfieldScratch
      ? compactGreenfieldScratchContext(input.idiomContext)
      : input.idiomContext || null,
    source_reading_rule: surgical
      ? 'This is a surgical target. Read the single planned line_window first, then at most the same file or explicitly named tests. Do not inspect unrelated files unless the slice proves the requested change cannot be made locally.'
      : 'Read only the line_window slices in file_read_plan first. Expand to whole files only when those slices show a concrete gap.',
    next_steps: [
      'Use file_read_plan to inspect the target files before broad repository search.',
      surgical ? 'Because Klauro resolved a concrete target file, avoid broad repository search and avoid opening neighboring files unless validation requires it.' : '',
      input.idiomContext ? 'Follow idiom_context for naming, placement, boundary, testing, migration, and error/logging style.' : '',
      'Make an edit only when the task requires one.',
      'For behavior changes, inspect and update focused tests from validation_plan or file_read_plan when a relevant test file is available.',
      'Run the narrowest validation that proves the expected outcome.',
      'Record task_success, quality_score, files_read, and tests_run in the result JSON.',
    ].filter(Boolean),
  };
}

function compactGreenfieldScratchContext(idiomContext: unknown) {
  if (!idiomContext || typeof idiomContext !== 'object') return null;
  const context = idiomContext as any;
  const capabilityMemory = context.capability_memory || {};
  const architecture = context.recommended_architecture || {};
  const strategy = context.large_scale_build_strategy || {};
  const growth = context.growth_control_plane || {};
  return {
    product: context.product || 'klauro_greenfield_scratch_guidance',
    plan_intent: context.plan_intent,
    reference_scope: context.reference_scope ? {
      count: context.reference_scope.count,
      names: Array.isArray(context.reference_scope.names) ? context.reference_scope.names.slice(0, 6) : undefined,
    } : undefined,
    reuse_decisions_required: Array.isArray(capabilityMemory.reuse_decisions_required)
      ? capabilityMemory.reuse_decisions_required.slice(0, 8).map((item: any) => ({
        proposed_need: item.proposed_need,
        existing_capability: item.existing_capability,
        decision_required: item.decision_required,
      }))
      : [],
    do_not_rebuild: Array.isArray(capabilityMemory.do_not_rebuild)
      ? capabilityMemory.do_not_rebuild.slice(0, 8).map((item: any) => ({
        capabilities: Array.isArray(item.capabilities) ? item.capabilities.slice(0, 4) : undefined,
        entities: Array.isArray(item.entities) ? item.entities.slice(0, 6) : undefined,
      }))
      : [],
    recommended_patterns: Array.isArray(architecture.patterns)
      ? architecture.patterns.slice(0, 6).map((pattern: any) => ({
        name: pattern.name,
        reason: pattern.reason || pattern.guidance,
      }))
      : [],
    file_plan: Array.isArray(architecture.file_plan)
      ? architecture.file_plan.slice(0, 10).map((file: any) => ({
        path: file.path,
        purpose: file.purpose || file.reason || file.role,
      }))
      : [],
    file_budget: strategy.file_budget ? {
      rule: strategy.file_budget.rule,
      split_later_when: Array.isArray(strategy.file_budget.split_later_when)
        ? strategy.file_budget.split_later_when.slice(0, 3)
        : [],
    } : undefined,
    growth_control_plane: growth && typeof growth === 'object' ? {
      mode: growth.mode,
      focus_rule: growth.product_slice?.focus_rule,
      done_when: Array.isArray(growth.product_slice?.done_when) ? growth.product_slice.done_when.slice(0, 4) : [],
      architecture_budget: Array.isArray(growth.architecture_budget?.patterns_to_use_now) ? growth.architecture_budget.patterns_to_use_now.slice(0, 5) : [],
      owner_files: Array.isArray(growth.concept_ownership_contract?.owner_files)
        ? growth.concept_ownership_contract.owner_files.slice(0, 5).map((item: any) => ({
          file: item.file,
          reason: item.reason,
        }))
        : [],
      known_concepts: Array.isArray(growth.concept_ownership_contract?.known_concepts) ? growth.concept_ownership_contract.known_concepts.slice(0, 12) : [],
      duplication_gate: Array.isArray(growth.duplication_gate?.required_before_new_model_or_service) ? growth.duplication_gate.required_before_new_model_or_service.slice(0, 3) : [],
      stop_rule: growth.context_budget?.stop_rule,
      read_rule: growth.context_budget?.read_rule,
      next_klauro_loop: Array.isArray(growth.next_klauro_loop) ? growth.next_klauro_loop.slice(0, 3) : [],
    } : undefined,
    continuation_execution_brief: context.continuation_execution_brief,
    core_concepts_to_name_once: Array.isArray(strategy.core_concepts_to_name_once)
      ? strategy.core_concepts_to_name_once.slice(0, 12)
      : [],
    anti_duplication_rules: Array.isArray(strategy.anti_duplication_rules)
      ? strategy.anti_duplication_rules.slice(0, 5)
      : [],
    model_reuse: Array.isArray(context.model_reuse) ? context.model_reuse.slice(0, 8) : [],
    boundary_rules: Array.isArray(context.boundary_rules) ? context.boundary_rules.slice(0, 8) : [],
  };
}

function promptWithKlauro(input: LiveAgentPairInput, workspace: string, metricsFile: string, resultFile: string, workPacketFile?: string): string {
  const surgical = isSurgicalLiveTask(input);
  const greenfieldScratch = isGreenfieldScratchLiveTask(input);
  const greenfieldContinuation = greenfieldScratch && hasContinuationBrief(input.idiomContext);
  const filePlanLimit = greenfieldContinuation ? 5 : greenfieldScratch ? 6 : 12;
  const filePlan = input.fileReadPlan
    .map(item => {
      const value = item as any;
      if (greenfieldScratch) return value.file || value.path || String(item);
      return [
        value.file || value.path || String(item),
        value.line_window?.instruction,
        value.reason,
      ].filter(Boolean).join(' - ');
    })
    .slice(0, filePlanLimit);
  const validationCommands = Array.isArray((input.validationPlan as any)?.commands)
    ? (input.validationPlan as any).commands
      .map((command: any) => String(command.command || '').trim())
      .filter(Boolean)
      .slice(0, 5)
    : [];
  const validationLine = greenfieldScratch
    ? compactGreenfieldValidationLine(input, validationCommands)
    : validationCommands.length ? `Validate: ${validationCommands.join('; ')}` : '';
  const greenfieldTestLine = greenfieldScratch ? compactGreenfieldTestRequirementLine(input) : '';
  const idiomSummary = greenfieldScratch
    ? formatIdiomContextForPrompt(input.idiomContext, greenfieldContinuation ? 1000 : 850)
    : formatExistingTaskContextForPrompt(input, 650);
  if (!greenfieldScratch) {
    return [
      `Repo: ${workspace}`,
      `Task: ${input.taskLabel}`,
      input.task.instructions ? `Instructions: ${input.task.instructions}` : '',
      'Use this Klauro brief as the complete starting context. Do not call MCP, regenerate analysis, or browse beyond the read-first files unless they are insufficient.',
      idiomSummary ? `Klauro brief:\n${idiomSummary}` : '',
      validationLine,
      surgical
        ? 'Surgical rule: inspect the named file/line window and explicitly named tests only.'
        : 'Work rule: read the named files first, edit only named owner/test files when possible, then stop after focused validation.',
      'Keep output concise; do not print file contents, generated code, or full diffs.',
      `Write JSON to ${resultFile} with: task_success, quality_score, files_read, tests_run, provider_input_tokens, provider_output_tokens, provider_total_tokens, notes.`,
      `If token metrics are exposed separately, write them to ${metricsFile}.`,
    ].filter(Boolean).join('\n');
  }
  return [
    `Repo: ${workspace}`,
    `Task: ${input.taskLabel}`,
    input.task.instructions ? `Instructions: ${input.task.instructions}` : '',
    '',
    greenfieldScratch
      ? greenfieldContinuation
        ? 'Use Klauro as the starting context: read owner files only, extend owners, avoid parallel per-entity modules.'
        : 'Use Klauro as the architecture brief: build one tested vertical slice, group owners, avoid one-file-per-entity scaffolding.'
      : 'Do not regenerate analysis, run broad repository discovery, or open unrelated files before using the compact execution brief.',
    greenfieldScratch ? '' : 'Do not call additional MCP tools for this live trial unless the compact brief is internally contradictory.',
    filePlan.length ? greenfieldScratch
      ? `Klauro first-read files: ${filePlan.join(', ')}`
      : ''
      : '',
    validationLine,
    input.idiomContext ? greenfieldScratch
      ? 'Required Klauro context: ownership, placement, boundaries, tests.'
      : 'Treat the compact Klauro execution brief as required local guidance. Preserve the named owners, boundaries, tests, and forbidden shortcuts.'
      : '',
    idiomSummary ? `${greenfieldScratch ? 'Compact idiom_context' : 'Compact Klauro execution brief'}:\n${idiomSummary}` : '',
    surgical ? 'Surgical-mode rule: the task already has one concrete target file. Read the compact brief, the planned line_window, and then only the same file or explicitly named tests if necessary. Do not browse unrelated files to rediscover context.' : greenfieldScratch ? greenfieldContinuation ? 'Continuation rule: read the first-read owner files, extend those owners, add one migration and focused tests, then stop. Do not re-survey the project.' : 'Greenfield rule: choose architecture and concept ownership from the brief, build, then stop after the focused slice.' : 'Read only the compact brief and the planned files first. Expand beyond them only if they prove insufficient for the requested change.',
    greenfieldScratch ? '' : 'For behavior changes, inspect and update only the focused tests named in the compact brief when feasible.',
    greenfieldTestLine,
    greenfieldScratch ? '' : 'Use the compact brief to choose files, make an edit only when the task requires one, and run relevant tests when possible.',
    greenfieldScratch
      ? greenfieldContinuation
        ? 'Token rule: smallest owner-file diff that satisfies the slice.'
        : 'Token rule: smallest coherent vertical slice.'
      : '',
    greenfieldScratch
      ? 'Validation economy: plan all files first, write each file exactly once, then run ONE combined validation command at the end (typecheck and focused tests together). Never re-read files you wrote, never re-run a passing command, and rely on the harness validator for final verification.'
      : '',
    'Do not install dependencies or run broad setup. Keep stdout/stderr concise; write files directly and summarize validation only.',
    '',
    `When finished, write JSON to ${resultFile} with keys: task_success, quality_score, files_read, tests_run, provider_input_tokens, provider_output_tokens, provider_total_tokens, notes.`,
    `If your runtime exposes token metrics separately, write them to ${metricsFile}.`,
  ].join('\n');
}

function compactGreenfieldTestRequirementLine(input: LiveAgentPairInput): string {
  const context = input.idiomContext as any;
  const continuationContext = context?.continuation_execution_brief;
  const validation = continuationContext?.validation || context?.validation;
  const minFocusedTests = Number(validation?.min_focused_tests || 0);
  if (!Number.isFinite(minFocusedTests) || minFocusedTests <= 0) return '';
  const mode = hasContinuationBrief(input.idiomContext) ? 'continuation' : 'initial';
  return `Focused test rule: create or update at least ${minFocusedTests} focused ${mode} tests or test cases that prove the requested behavior; do not report task_success true with fewer unless you write a blocker in notes.`;
}

function hasContinuationBrief(idiomContext: unknown): boolean {
  return Boolean(idiomContext && typeof idiomContext === 'object' && (idiomContext as any).continuation_execution_brief);
}

function compactGreenfieldValidationLine(input: LiveAgentPairInput, validationCommands: string[]): string {
  if (!validationCommands.length) return '';
  const context = input.idiomContext && typeof input.idiomContext === 'object'
    ? input.idiomContext as any
    : null;
  const continuationContext = context?.continuation_execution_brief;
  const validation = continuationContext?.validation || context?.validation;
  const needsMigration = Boolean(validation?.needs_migration_evidence);
  const continuation = Boolean(continuationContext);
  const parts = [
    'run focused project tests when possible',
    needsMigration
      ? continuation
        ? 'create a new continuation migration file under migrations/'
        : 'include migration evidence under migrations/'
      : '',
    validation?.min_focused_tests ? `${validation.min_focused_tests}+ focused tests/test cases` : '',
    'the harness will run the generated Klauro evidence validator after your edit',
  ].filter(Boolean);
  return `Klauro validation target: ${parts.join('; ')}.`;
}

function isSurgicalLiveTask(input: LiveAgentPairInput): boolean {
  if (input.task.task_type !== 'modify' && input.task.task_type !== 'debug') return false;
  const plans = input.fileReadPlan || [];
  const files = new Set(plans.map(item => String((item as any).file || (item as any).path || '')).filter(Boolean));
  const target = input.task.target || '';
  return files.size === 1 && Boolean(target) && [...files].some(file => target.includes(file) || file.includes(target));
}

function isGreenfieldScratchLiveTask(input: LiveAgentPairInput): boolean {
  const text = `${input.taskCategory}\n${input.taskLabel}\n${input.task.target || ''}\n${input.task.instructions || ''}`.toLowerCase();
  return /greenfield|scratch|empty folder|new codebase/.test(text);
}

function formatIdiomContextForPrompt(idiomContext: unknown, maxLength = 3500): string {
  if (!idiomContext || typeof idiomContext !== 'object') return '';
  const context = idiomContext as any;
  const lines: string[] = [];
  if (context.validation?.needs_migration_evidence || context.validation?.min_focused_tests) {
    lines.push(`Validation target: ${context.validation?.needs_migration_evidence ? 'migration file under migrations/; ' : ''}${context.validation?.min_focused_tests || 0}+ focused tests/test cases.`);
  }
  const continuationBrief = context.continuation_execution_brief;
  if (context.product === 'klauro_greenfield_scratch_build_guidance' && !continuationBrief) {
    const patterns = Array.isArray(context.recommended_architecture?.patterns)
      ? context.recommended_architecture.patterns.slice(0, 5).map(promptItemLabel).filter(Boolean)
      : [];
    const filePlan = Array.isArray(context.recommended_architecture?.file_plan)
      ? context.recommended_architecture.file_plan.slice(0, 5).map(promptItemLabel).filter(Boolean)
      : [];
    if (patterns.length) lines.push(`Architecture pattern: ${patterns.join(', ')}.`);
    if (filePlan.length) lines.push(`File plan: ${filePlan.join(', ')}.`);
    appendGrowthControlLines(lines, context.growth_control_plane, { includeOwners: false, includeLoop: false });
    appendGrowthControlLoopLines(lines, context.growth_control_plane);
    const fileBudgetRule = context.large_scale_build_strategy?.file_budget?.rule || context.file_budget?.rule;
    if (fileBudgetRule) lines.push(`File budget: ${fileBudgetRule}`);
    const modelReuse = Array.isArray(context.model_reuse)
      ? context.model_reuse.slice(0, 2)
      : [];
    if (modelReuse.length) {
      lines.push('Model ownership:');
      for (const item of modelReuse) lines.push(`- ${String(item)}`);
    }
    const boundaryRules = Array.isArray(context.boundary_rules)
      ? context.boundary_rules.slice(0, 5)
      : [];
    if (boundaryRules.length) {
      lines.push('Boundaries:');
      for (const item of boundaryRules) lines.push(`- ${String(item)}`);
    }
    lines.push('Stop rule: create the first tested vertical slice; do not add extra docs, generated graphs, or broad discovery output unless required by the task.');
    return truncatePromptLines(lines, maxLength);
  }
    if (continuationBrief && typeof continuationBrief === 'object') {
    appendGrowthControlLines(lines, context.growth_control_plane, { includeOwners: true, includeLoop: false });
    lines.push(`Continuation brief: ${continuationBrief.task || 'next product slice'}`);
    const readFirst = Array.isArray(continuationBrief.read_first)
      ? continuationBrief.read_first.slice(0, 4)
      : [];
    if (readFirst.length) {
      lines.push(`Read first: ${readFirst.map((item: any) => item.file || item.path || String(item)).filter(Boolean).join(', ')}`);
    }
    lines.push('Read budget: read only those owner files first; do not inspect package.json, tsconfig, README, docs, generated output, or unrelated source before editing.');
    lines.push('Edit budget: extend existing domain/service/repository/controller/test owners, add exactly one new migration file when required, then stop.');
    const fileBudgetRule = context.large_scale_build_strategy?.file_budget?.rule || context.file_budget?.rule;
    if (fileBudgetRule) lines.push(`File budget: ${fileBudgetRule}`);
    const mustRepresent = Array.isArray(continuationBrief.must_represent)
      ? continuationBrief.must_represent.slice(0, 6)
      : [];
    if (mustRepresent.length) lines.push(`Must represent: ${mustRepresent.join(', ')}`);
    const reuse = Array.isArray(continuationBrief.reuse)
      ? continuationBrief.reuse.slice(0, 4)
      : [];
    if (reuse.length) {
      lines.push('Reuse:');
      for (const item of reuse) lines.push(`- ${String(item)}`);
    }
    const boundaries = Array.isArray(continuationBrief.boundaries)
      ? continuationBrief.boundaries.slice(0, 4)
      : [];
    if (boundaries.length) {
      lines.push('Boundaries:');
      for (const item of boundaries) lines.push(`- ${String(item)}`);
    }
    const updateScope = Array.isArray(continuationBrief.update_scope)
      ? continuationBrief.update_scope.slice(0, 2)
      : [];
    if (updateScope.length) {
      lines.push('Stop rule:');
      for (const item of updateScope) lines.push(`- ${String(item)}`);
    }
    if (continuationBrief.validation?.needs_migration_evidence || continuationBrief.validation?.min_focused_tests) {
      lines.push(`Validation target: ${continuationBrief.validation?.needs_migration_evidence ? 'new continuation migration file under migrations/; ' : ''}${continuationBrief.validation?.min_focused_tests || 0}+ focused tests/test cases.`);
    }
  }
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
  const capabilityMemory = context.capability_memory;
  const reuseDecisions = Array.isArray(capabilityMemory?.reuse_decisions_required)
    ? capabilityMemory.reuse_decisions_required.slice(0, 5)
    : [];
  if (reuseDecisions.length) {
    lines.push('Capability memory reuse decisions:');
    for (const decision of reuseDecisions) {
      lines.push(`- ${decision.existing_capability || decision.proposed_need || 'existing capability'}: ${decision.decision_required || 'review_before_building'}`);
    }
  }
  const doNotRebuild = Array.isArray(capabilityMemory?.do_not_rebuild)
    ? capabilityMemory.do_not_rebuild.slice(0, 4)
    : [];
  const explicitDoNotRebuild = Array.isArray(context.do_not_rebuild)
    ? context.do_not_rebuild.slice(0, 6)
    : [];
  const boundaryRules = Array.isArray(context.boundary_rules)
    ? context.boundary_rules.slice(0, 6)
    : [];
  const modelReuse = Array.isArray(context.model_reuse)
    ? context.model_reuse.slice(0, 6)
    : [];
  if (doNotRebuild.length || explicitDoNotRebuild.length) {
    lines.push('Do not silently rebuild:');
    for (const item of doNotRebuild) {
      const capabilities = Array.isArray(item.capabilities) ? item.capabilities.slice(0, 4).join(', ') : '';
      const entities = Array.isArray(item.entities) ? item.entities.slice(0, 4).join(', ') : '';
      lines.push(`- ${[capabilities, entities].filter(Boolean).join(' / ') || item.repository || 'overlapping analyzed behavior'}`);
    }
    for (const item of explicitDoNotRebuild) {
      lines.push(`- ${String(item)}`);
    }
  }
  if (modelReuse.length) {
    lines.push('Model reuse requirements:');
    for (const item of modelReuse) lines.push(`- ${String(item)}`);
  }
  const strategy = context.large_scale_build_strategy;
  if (strategy && typeof strategy === 'object') {
    const concepts = Array.isArray(strategy.core_concepts_to_name_once)
      ? strategy.core_concepts_to_name_once
        .filter((item: unknown) => typeof item === 'string' && item.length <= 40 && !/\b(the|with|json|include|write|continue)\b/i.test(item))
        .slice(0, 6)
      : [];
    const antiDuplication = Array.isArray(strategy.anti_duplication_rules)
      ? strategy.anti_duplication_rules.slice(0, 2)
      : [];
    const iterationLoop = Array.isArray(strategy.iteration_loop)
      ? strategy.iteration_loop.slice(0, 2)
      : [];
    if (concepts.length) lines.push(`Core concepts to name once: ${concepts.join(', ')}`);
    if (antiDuplication.length) {
      lines.push('Large-scale anti-duplication rules:');
      for (const item of antiDuplication) lines.push(`- ${String(item)}`);
    }
    if (iterationLoop.length) {
      lines.push('Iteration loop:');
      for (const item of iterationLoop) lines.push(`- ${String(item)}`);
    }
  }
  if (boundaryRules.length) {
    lines.push('Boundary rules:');
    for (const item of boundaryRules) lines.push(`- ${String(item)}`);
  }
  return truncatePromptLines(lines, maxLength);
}

function formatExistingTaskContextForPrompt(input: LiveAgentPairInput, maxLength = 1400): string {
  const context = input.idiomContext && typeof input.idiomContext === 'object'
    ? input.idiomContext as any
    : {};
  const validation = input.validationPlan && typeof input.validationPlan === 'object'
    ? input.validationPlan as any
    : {};
  const rules = context.semantic_rules || validation.semantic_rules || {};
  const requiredChangedFiles = uniquePromptStrings(arrayOfStrings(rules.required_changed_files));
  const plannedChangedFiles = uniquePromptStrings([
    ...arrayOfStrings(validation.expected_changed_files),
    ...arrayOfStrings(context.changed_files),
  ]);
  const changedFiles = (requiredChangedFiles.length ? requiredChangedFiles : plannedChangedFiles).slice(0, 6);
  const relatedOwners = uniquePromptStrings([
    ...plannedChangedFiles,
    ...arrayOfStrings(context.expected_files),
  ].filter(file => !changedFiles.includes(file))).slice(0, 6);
  const inspectFiles = uniquePromptStrings([
    ...changedFiles,
    ...relatedOwners,
    ...input.fileReadPlan.map(item => {
      const value = item as any;
      return String(value.file || value.path || '').trim();
    }).filter(Boolean),
  ]).slice(0, 10);
  const forbiddenFiles = arrayOfStrings(rules.forbidden_changed_files).slice(0, 6);
  const requiredPatterns = arrayOfStrings(rules.required_diff_patterns).slice(0, 5);
  const forbiddenPatterns = arrayOfStrings(rules.forbidden_diff_patterns).slice(0, 5);
  const guidance = arrayOfStrings(context.guidance).slice(0, 5);
  const lines: string[] = [];
  if (inspectFiles.length) lines.push(`Read first: ${inspectFiles.join(', ')}.`);
  if (changedFiles.length) lines.push(`Edit only when needed: ${changedFiles.join(', ')}.`);
  if (relatedOwners.length) lines.push(`Inspect as owners, not default edits: ${relatedOwners.join(', ')}.`);
  if (forbiddenFiles.length) lines.push(`Do not change: ${forbiddenFiles.join(', ')}.`);
  if (requiredPatterns.length) {
    lines.push('Required patch evidence:');
    for (const pattern of requiredPatterns) lines.push(`- ${pattern}`);
  }
  if (forbiddenPatterns.length) {
    lines.push('Avoid shortcuts:');
    for (const pattern of forbiddenPatterns) lines.push(`- ${pattern}`);
  }
  if (rules.require_test_change === true) lines.push('Test rule: at least one focused test/spec file must change.');
  if (rules.require_production_change === true) lines.push('Production rule: at least one production source file must change.');
  if (rules.require_production_change === false) lines.push('Production rule: do not change production source unless a focused test exposes a defect.');
  if (Number.isFinite(rules.max_changed_files)) lines.push(`Change budget: ${rules.max_changed_files} files maximum.`);
  if (guidance.length) {
    lines.push('Local guidance:');
    for (const item of guidance) lines.push(`- ${item}`);
  }
  return truncatePromptLines(lines, maxLength);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : [];
}

function uniquePromptStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function appendGrowthControlLines(
  lines: string[],
  growthControl: any,
  options: { includeOwners: boolean; includeLoop: boolean }
) {
  if (!growthControl || typeof growthControl !== 'object') return;
  const mode = growthControl.mode;
  const focusRule = growthControl.focus_rule || growthControl.product_slice?.focus_rule;
  if (mode || focusRule) {
    lines.push(`Growth control: ${[mode, focusRule].filter(Boolean).join(' - ')}`);
  }
  const architectureBudget = Array.isArray(growthControl.architecture_budget)
    ? growthControl.architecture_budget
    : growthControl.architecture_budget?.patterns_to_use_now;
  if (Array.isArray(architectureBudget) && architectureBudget.length) {
    lines.push(`Architecture budget: ${architectureBudget.slice(0, 5).join(', ')}.`);
  }
  const knownConcepts = Array.isArray(growthControl.known_concepts)
    ? growthControl.known_concepts
    : growthControl.concept_ownership_contract?.known_concepts;
  if (Array.isArray(knownConcepts) && knownConcepts.length) {
    const domainConcepts = knownConcepts.map(String).filter(isPromptDomainConcept).slice(0, 8);
    if (domainConcepts.length) lines.push(`Owned concepts: ${domainConcepts.join(', ')}.`);
  }
  const ownerFiles = Array.isArray(growthControl.owner_files)
    ? growthControl.owner_files
    : growthControl.concept_ownership_contract?.owner_files;
  if (options.includeOwners && Array.isArray(ownerFiles) && ownerFiles.length) {
    lines.push(`Owner files: ${ownerFiles.slice(0, 5).map((item: any) => item.file || item.path || String(item)).filter(Boolean).join(', ')}`);
  }
  const duplicationGate = Array.isArray(growthControl.duplication_gate)
    ? growthControl.duplication_gate
    : growthControl.duplication_gate?.required_before_new_model_or_service;
  if (Array.isArray(duplicationGate) && duplicationGate.length) {
    lines.push('Duplication gate:');
    for (const item of duplicationGate.slice(0, 2)) lines.push(`- ${String(item)}`);
  }
  const stopRule = growthControl.stop_rule || growthControl.context_budget?.stop_rule;
  if (stopRule) lines.push(`Stop rule: ${String(stopRule)}`);
  const nextLoop = Array.isArray(growthControl.next_klauro_loop) ? growthControl.next_klauro_loop : [];
  if (options.includeLoop && nextLoop.length) {
    lines.push(`Next Klauro loop: ${nextLoop.slice(0, 3).join(' -> ')}`);
  }
}

function appendGrowthControlLoopLines(lines: string[], growthControl: any) {
  const nextLoop = Array.isArray(growthControl?.next_klauro_loop) ? growthControl.next_klauro_loop : [];
  if (nextLoop.length) {
    lines.push(`Next Klauro loop: ${nextLoop.slice(0, 3).join(' -> ')}`);
  }
}

function isPromptDomainConcept(value: string): boolean {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized || normalized.length < 4) return false;
  if (/^(id|ids|uuid|date|iso date|timestamp|string|number|boolean|status|type|action|kind|mode)$/.test(normalized)) return false;
  if (/^(create|update|delete|list|get|set|build|continue|include|write)$/.test(normalized)) return false;
  if (/^(compliance controller|index|main|app|config|options)$/.test(normalized)) return false;
  return true;
}

function truncatePromptLines(lines: string[], maxLength: number): string {
  const selectedLines: string[] = [];
  let length = 0;
  for (const line of lines) {
    const nextLength = length + line.length + 1;
    if (nextLength > maxLength) break;
    selectedLines.push(line);
    length = nextLength;
  }
  return selectedLines.join('\n');
}

function promptItemLabel(item: unknown): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  const value = item as Record<string, unknown>;
  const candidate = value.name || value.pattern || value.path || value.file || value.target || value.label;
  return typeof candidate === 'string' ? candidate : '';
}

function promptWithoutKlauro(input: LiveAgentPairInput, workspace: string, metricsFile: string, resultFile: string): string {
  const retrievedFiles = (input.withoutArmRetrievedFiles || []).filter(Boolean);
  const overrides = input.withoutArmPromptOverrides;
  const taskLabel = overrides?.taskLabel ?? input.taskLabel;
  const expectedOutcome = overrides?.expectedOutcome ?? input.expectedOutcome;
  const instructions = overrides?.instructions ?? input.task.instructions;
  const successCriteria = overrides?.successCriteria ?? input.task.success_criteria;
  return [
    `Repository copy: ${workspace}`,
    `Task: ${taskLabel}`,
    `Task category: ${input.taskCategory}`,
    `Expected outcome: ${expectedOutcome}`,
    instructions ? `Instructions: ${instructions}` : '',
    successCriteria?.length ? `Success criteria: ${successCriteria.join('; ')}` : '',
    '',
    retrievedFiles.length
      ? [
        'Codebase index retrieval (lexical search over this repository using the task text) ranked these candidate files:',
        ...retrievedFiles.map((file, index) => `${index + 1}. ${file}`),
        'These are retrieval candidates, not verified targets: some may be irrelevant and relevant files may be missing. Start from them before broad exploration.',
        '',
      ].join('\n')
      : '',
    'Do not use Klauro, its MCP server, CAS output, generated work packets, or precomputed analysis.',
    'Use normal repository exploration, make an edit only when the task requires one, and run relevant tests when possible.',
    'Do not install dependencies or run broad environment setup unless the task explicitly asks for it. If the existing environment cannot run a broad test, record that and stop after focused validation.',
    'Keep stdout/stderr concise: do not print file contents, generated code, or full diffs; write files directly and summarize only the changed files and validation result.',
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
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'benchmark baseline'], { cwd: workspace, env: gitEnv(), timeout: 120 * 1000 });
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
  const [numstat, names, diff, untracked] = await Promise.all([
    runShell('git diff --numstat', workspace, 60 * 1000),
    runShell('git diff --name-only', workspace, 60 * 1000),
    runShell('git diff --binary', workspace, 60 * 1000),
    runShell('git ls-files --others --exclude-standard', workspace, 60 * 1000),
  ]);
  const untrackedFiles = untracked.stdout.split('\n').map(line => line.trim()).filter(isLiveDiffCandidate);
  const untrackedSummary = await summarizeUntrackedFiles(workspace, untrackedFiles);
  await fs.writeFile(diffFile, [diff.stdout, untrackedSummary.diffText].filter(Boolean).join('\n'), 'utf8');
  const rows = numstat.stdout.split('\n').filter(Boolean);
  const stats = rows.reduce((result, row) => {
    const [added, deleted] = row.split(/\s+/);
    result.files++;
    result.added += Number(added) || 0;
    result.deleted += Number(deleted) || 0;
    return result;
  }, { files: 0, added: 0, deleted: 0 });
  const trackedChangedFiles = names.stdout.split('\n').map(line => line.trim()).filter(isLiveDiffCandidate);
  const changedFiles = unique([...trackedChangedFiles, ...untrackedFiles]);
  return {
    files: changedFiles.length,
    added: stats.added + untrackedSummary.added,
    deleted: stats.deleted,
    changedFiles,
  };
}

function isLiveDiffCandidate(filePath: string): boolean {
  if (!filePath) return false;
  if (/(^|\/)\.klauro-live-(metrics|result)\.json$/.test(filePath)) return false;
  if (/(^|\/)__pycache__\//.test(filePath) || /\.pyc$/i.test(filePath)) return false;
  if (/(^|\/)(node_modules|dist|build|target|coverage|\.next|\.turbo|\.cache|\.venv|venv|env)\//.test(filePath)) return false;
  return true;
}

async function summarizeUntrackedFiles(workspace: string, files: string[]): Promise<{ added: number; diffText: string }> {
  let added = 0;
  const sections: string[] = [];
  for (const file of files) {
    const absolute = path.join(workspace, file);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) continue;
    if (stat.size > 500_000) {
      sections.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n# Klauro live benchmark skipped large untracked file (${stat.size} bytes)`);
      continue;
    }
    let content = '';
    try {
      content = await fs.readFile(absolute, 'utf8');
    } catch {
      sections.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n# Klauro live benchmark skipped binary or unreadable untracked file`);
      continue;
    }
    const lines = content.split('\n');
    added += content.length === 0 ? 0 : lines.length;
    sections.push([
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${file}`,
      `@@ -0,0 +1,${content.length === 0 ? 0 : lines.length} @@`,
      ...lines.map(line => `+${line}`),
    ].join('\n'));
  }
  return { added, diffText: sections.join('\n') };
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
  const withProviderTokens = positiveNumber(withResult.provider_total_tokens);
  const withoutProviderTokens = positiveNumber(withoutResult.provider_total_tokens);
  if ((withProviderTokens && !withoutProviderTokens) || (!withProviderTokens && withoutProviderTokens)) return null;
  const withTokens = withProviderTokens || withResult.estimated_work_tokens || withResult.estimated_total_tokens;
  const withoutTokens = withoutProviderTokens || withoutResult.estimated_work_tokens || withoutResult.estimated_total_tokens;
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

function normalizeSelfReportedQualityScore(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value > 0 && value <= 1) return clampScore(value * 100);
  if (value > 0 && value <= 10) return clampScore(value * 10);
  return clampScore(value);
}

function firstPositiveNumber(...values: Array<number | undefined>): number | undefined {
  return values.find(value => positiveNumber(value) !== undefined);
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
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
  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`) ||
    normalizedLeft.startsWith(`${normalizedRight.replace(/\/$/, '')}/`) ||
    normalizedRight.startsWith(`${normalizedLeft.replace(/\/$/, '')}/`);
}

function slugify(input: string | undefined): string {
  return String(input || 'target')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80) || 'target';
}
