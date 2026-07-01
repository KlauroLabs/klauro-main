/**
 * Multi-arm live trial — runs N arms through the SAME real measurement path.
 *
 * The two-arm pair (runLiveAgentPair) proves Klauro vs the grep/read baseline.
 * To prove "Klauro beats every other indexer too", we need the competitor arms
 * (ctags, embeddings/RAG, Cursor-style lexical index) to run as real agents with
 * their retrieval injected — not projected. This module generalizes the pair's
 * per-arm runner to an arbitrary arm set, reusing the exact engine internals
 * (copyRepo, runShell, diffStats, readMetricFile, the prompt builders) so every
 * arm is measured identically. No parallel, divergent measurement path.
 *
 * Arm shapes:
 *  - klauro:     gets a precomputed agent context (promptWithKlauro).
 *  - no-tools:   bare baseline (promptWithoutKlauro, no candidates).
 *  - competitor: promptWithoutKlauro + the arm's retrieval backend ranked
 *                candidates injected as withoutArmRetrievedFiles, and the
 *                backend's index time folded into the arm's wall-clock.
 *
 * Quality is scored UNIFORMLY across arms (scoreArmQuality) from measured
 * execution signals so the comparison is fair; when an external judge command is
 * supplied it overrides the proxy. This is deliberately conservative for Klauro.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import {
  _copyRepo, _initializeBaseline, _runShell, _diffStats, _readMetricFile,
  _renderCommand, _parseMetricsFromText, _estimateSourceReadTokens,
  _firstPositiveNumber, _estimateTokens, _promptWithoutKlauro, _promptWithKlauro,
  _buildLiveAgentContext,
  type LiveAgentPairInput, type LiveAgentCommandConfig,
} from '../agent-live-trial';
import type { RetrievalBackend } from './retrieval/types';
import { DEFAULT_K } from './retrieval/types';
import { judgeQuality } from './judge';

export type ArmKind = 'klauro' | 'no-tools' | 'competitor';

export interface ArmRunSpec {
  id: string;
  kind: ArmKind;
  /** Launch command template; klauro arm uses the Klauro-enabled launcher. */
  command: string;
  /** Retrieval backend for competitor arms (injects ranked candidates). */
  retrieval?: RetrievalBackend;
}

export interface ArmMeasurement {
  arm_id: string;
  attempted: boolean;
  status: 'pass' | 'warn' | 'fail';
  duration_ms: number;          // includes retrieval index time for competitors
  agent_ms: number;             // agent run only
  index_ms: number;             // retrieval build/query time (0 for klauro/no-tools)
  provider_total_tokens?: number;
  estimated_work_tokens: number;
  tokens: number;               // best available token figure (lower = better)
  token_source: 'provider-total' | 'estimated-work';
  quality: number;              // 0..100, judged when a judge is enabled, else proxy
  quality_source?: 'judge' | 'execution-proxy';
  judge?: string;               // which judge produced the score, when judged
  command_passed: boolean;
  validation_passed?: boolean;
  task_success?: boolean;
  files_changed: number;
  files_read?: number;
  retrieved_files?: number;
  self_reported_quality?: number;
  note?: string;
  error?: string;
}

export interface MultiArmTrialResult {
  trial_id: string;
  trial_directory: string;
  arms: ArmMeasurement[];
}

/**
 * Uniform per-arm quality proxy from measured execution signals (0..100).
 *
 * For tasks with a validation command, passing tests dominates. For
 * understanding tasks (no validation), we fall back to whether the agent
 * completed cleanly plus its self-reported quality and change discipline. This
 * is intentionally modest for Klauro so the win-validator stays a real test; a
 * configured judge command should override it for headline numbers.
 */
export function scoreArmQuality(m: {
  command_passed: boolean;
  validation_passed?: boolean;
  task_success?: boolean;
  self_reported_quality?: number;
  files_changed: number;
  error?: string;
  retrieved_files?: number;
}): number {
  if (m.error) return 5;
  let score = 0;
  // Clean execution.
  score += m.command_passed ? 25 : 0;
  // Validation (when present) is the strongest signal.
  if (m.validation_passed === true) score += 35;
  else if (m.validation_passed === false) score += 0;
  else score += 18; // no validation available — neutral-positive
  // Task self-assessment of success.
  if (m.task_success === true) score += 15;
  // Self-reported quality 0..10 -> 0..15.
  if (typeof m.self_reported_quality === 'number') {
    score += Math.max(0, Math.min(15, (m.self_reported_quality / 10) * 15));
  } else {
    score += 7;
  }
  // Change discipline: made a focused change (not zero, not sprawling).
  if (m.files_changed > 0 && m.files_changed <= 8) score += 10;
  else if (m.files_changed === 0) score += 4;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function statusOf(commandPassed: boolean, validationPassed?: boolean): 'pass' | 'warn' | 'fail' {
  if (validationPassed === false) return 'fail';
  if (!commandPassed) return 'fail';
  return validationPassed === undefined ? 'warn' : 'pass';
}

/** Run one arm and return its measurement. Never throws. */
async function runArm(
  input: LiveAgentPairInput,
  arm: ArmRunSpec,
  config: LiveAgentCommandConfig,
  trialDirectory: string
): Promise<ArmMeasurement> {
  const workspace = path.join(trialDirectory, arm.id);
  const promptFile = path.join(trialDirectory, `${arm.id}-prompt.md`);
  const metricsFile = path.join(workspace, '.klauro-live-metrics.json');
  const resultFile = path.join(workspace, '.klauro-live-result.json');
  const diffFile = path.join(trialDirectory, `${arm.id}.diff`);
  const agentContextFile = arm.kind === 'klauro' ? path.join(trialDirectory, `${arm.id}-agent-context.json`) : undefined;

  const startedAt = Date.now();
  let indexMs = 0;
  let retrievedCount = 0;
  let retrievalNote: string | undefined;

  try {
    await _copyRepo(input.repoPath, workspace);

    // Competitor arms: run their retrieval backend against the task and inject
    // the ranked candidates into the prompt. Index time counts against the arm.
    let armInput = input;
    if (arm.kind === 'competitor' && arm.retrieval) {
      const query = `${input.taskLabel}\n${input.expectedOutcome}`;
      const retrieval = await arm.retrieval.retrieve({ repoPath: workspace, query, k: DEFAULT_K });
      indexMs = retrieval.index_ms;
      retrievedCount = retrieval.candidates.length;
      retrievalNote = retrieval.note;
      armInput = {
        ...input,
        withoutArmRetrievedFiles: retrieval.candidates.map(c => c.file),
        withoutArmPromptOverrides: {
          instructions: `${input.task.instructions || ''}\nA ${arm.retrieval.id} index ranked the candidate files below by relevance.`.trim(),
        },
      };
    }

    const prompt = arm.kind === 'klauro'
      ? _promptWithKlauro(armInput, workspace, metricsFile, resultFile, agentContextFile, true)
      : _promptWithoutKlauro(armInput, workspace, metricsFile, resultFile, true);

    if (agentContextFile) await fs.writeJson(agentContextFile, _buildLiveAgentContext(armInput, workspace), { spaces: 2 });
    await fs.writeFile(promptFile, prompt, 'utf8');
    await _initializeBaseline(workspace);

    const command = _renderCommand(arm.command, {
      workspace, prompt, prompt_file: promptFile, metrics_file: metricsFile,
      result_file: resultFile, arm: arm.id, task_id: input.taskId,
    });

    const agentStart = Date.now();
    const result = await _runShell(command, workspace, config.timeoutMs || 20 * 60 * 1000);
    const agentMs = Date.now() - agentStart;
    const test = config.testCommand ? await _runShell(config.testCommand, workspace, config.testTimeoutMs || 10 * 60 * 1000) : undefined;
    const diff = await _diffStats(workspace, diffFile);
    const metrics = await _readMetricFile(metricsFile, resultFile);
    const parsed = _parseMetricsFromText(`${result.stdout}\n${result.stderr}`);

    const providerTotal = _firstPositiveNumber(metrics.provider_total_tokens, metrics.total_tokens, parsed.provider_total_tokens);
    const filesRead = numberish(metrics.files_read) ?? numberish(metrics.source_files_read) ?? numberish(parsed.files_read);
    const sourceReadTokens = await _estimateSourceReadTokens(workspace, filesRead);
    const estInput = _estimateTokens(prompt.length);
    const estOutput = _estimateTokens(result.stdout.length + result.stderr.length);
    const estWork = estInput + estOutput + sourceReadTokens;

    const commandPassed = result.exitCode === 0;
    const validationPassed = test ? test.exitCode === 0 : undefined;
    const taskSuccess = typeof metrics.task_success === 'boolean' ? metrics.task_success
      : typeof metrics.success === 'boolean' ? metrics.success : (validationPassed ?? commandPassed);
    const selfQuality = numberish(metrics.quality_score);

    const proxyQuality = scoreArmQuality({
      command_passed: commandPassed, validation_passed: validationPassed, task_success: taskSuccess,
      self_reported_quality: selfQuality, files_changed: diff.files, retrieved_files: retrievedCount,
    });
    // Prefer an LLM judge of the arm's actual answer when one is enabled; the
    // judge scores the RESULT against the expected outcome, making quality
    // measured rather than inferred. Falls back to the execution proxy.
    let quality = proxyQuality;
    let qualitySource: 'judge' | 'execution-proxy' = 'execution-proxy';
    let judgeLabel: string | undefined;
    let resultText = '';
    try { resultText = await fs.readFile(resultFile, 'utf8'); } catch { /* none */ }
    resultText = `${resultText}\n${(result.stdout || '').slice(-2000)}`.trim();
    const verdict = await judgeQuality({
      task: input.taskLabel,
      expected: input.expectedOutcome,
      armLabel: arm.id,
      resultText,
      evidence: `command ${commandPassed ? 'passed' : 'failed'}${validationPassed === undefined ? '' : `, validation ${validationPassed ? 'passed' : 'failed'}`}, ${diff.files} files changed`,
    });
    if (verdict) { quality = verdict.score; qualitySource = 'judge'; judgeLabel = verdict.judge; }

    const providerOrEst = providerTotal ?? estWork;
    return {
      arm_id: arm.id,
      attempted: true,
      status: statusOf(commandPassed, validationPassed),
      duration_ms: (Date.now() - startedAt),
      agent_ms: agentMs,
      index_ms: indexMs,
      provider_total_tokens: providerTotal,
      estimated_work_tokens: estWork,
      tokens: providerOrEst,
      token_source: providerTotal ? 'provider-total' : 'estimated-work',
      quality,
      command_passed: commandPassed,
      validation_passed: validationPassed,
      task_success: taskSuccess,
      files_changed: diff.files,
      files_read: filesRead,
      retrieved_files: arm.kind === 'competitor' ? retrievedCount : undefined,
      self_reported_quality: selfQuality,
      quality_source: qualitySource,
      judge: judgeLabel,
      note: retrievalNote,
    };
  } catch (error) {
    return {
      arm_id: arm.id,
      attempted: true,
      status: 'fail',
      duration_ms: Date.now() - startedAt,
      agent_ms: 0,
      index_ms: indexMs,
      estimated_work_tokens: 0,
      tokens: Number.MAX_SAFE_INTEGER, // worst on the efficiency axis
      token_source: 'estimated-work',
      quality: 5,
      command_passed: false,
      files_changed: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Run an arm set against one task; arms run sequentially to bound machine load. */
export async function runMultiArmTrial(
  input: LiveAgentPairInput,
  arms: ArmRunSpec[],
  config: LiveAgentCommandConfig,
  workRoot: string
): Promise<MultiArmTrialResult> {
  const trialId = `${input.taskId}__${Date.now().toString(36)}`;
  const trialDirectory = path.join(workRoot, trialId);
  await fs.ensureDir(trialDirectory);

  const measurements: ArmMeasurement[] = [];
  for (const arm of arms) {
    measurements.push(await runArm(input, arm, config, trialDirectory));
  }

  if (config.keepWorkspaces === false) {
    await fs.remove(trialDirectory).catch(() => undefined);
  }
  return { trial_id: trialId, trial_directory: trialDirectory, arms: measurements };
}

function numberish(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.length;
  return undefined;
}
