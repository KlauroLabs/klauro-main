/**
 * Live driver — runs REAL agents per arm and returns measured metrics.
 *
 * This is what turns the gauntlet from "projected" into "proven". It reuses the
 * existing real-agent engine (runLiveAgentPair in agent-live-trial.ts), which
 * copies the repo, launches an agent per arm with/without Klauro, and captures
 * actual wall-clock, provider tokens, diff, validation, and an LLM-judged
 * quality score.
 *
 * Arms:
 *  - klauro and no-tools are run live here (the core proof: Klauro vs the
 *    universal grep/read baseline every coding agent already has).
 *  - competitor arms (ctags, embeddings-rag, cursor-proxy) need their own
 *    retrieval backends + launch command; until one is configured for an arm we
 *    do NOT fabricate a live number — the runner carries those arms as projected
 *    and labels them, so a mixed run is always honest about what was measured.
 *
 * Command templates are environment-specific (which agent CLI, which MCP config)
 * and are supplied via opts or env:
 *   KLAURO_LIVE_WITH_CMD     launch template for the Klauro arm
 *   KLAURO_LIVE_WITHOUT_CMD  launch template for the no-tools arm
 * Templates may use {prompt_file} {workspace} {metrics_file} {result_file}
 * {task_id} {arm} placeholders. If both are absent, live is unavailable and the
 * caller falls back to projection (never a fake measurement).
 */

import * as os from 'os';
import * as path from 'path';
import { type LiveAgentCommandConfig, type LiveAgentPairInput } from '../agent-live-trial';
import type { AgentTask, AgentTaskType } from '../agent-adoption';
import { armsForScenario, type ArmResult, type ScenarioSpec } from './report-schema';
import type { RepoFact } from './projection-model';
import type { WorkspaceFact } from './corpus';
import { runMultiArmTrial, type ArmMeasurement } from './multi-arm-trial';
import { buildArmSpecs } from './arm-registry';

export interface LiveCommandConfig {
  withKlauro?: string;
  withoutKlauro?: string;
  timeoutMs?: number;
  testTimeoutMs?: number;
  keepWorkspaces?: boolean;
}

export interface LiveTarget {
  /** Display name (repo or workspace name). */
  name: string;
  /** Absolute repo path to run the agent in. For workspaces, a representative member. */
  repoPath: string;
}

/** Resolve command templates from explicit opts then env. */
export function resolveLiveCommands(opts: LiveCommandConfig = {}): LiveCommandConfig {
  return {
    withKlauro: opts.withKlauro ?? process.env.KLAURO_LIVE_WITH_CMD,
    withoutKlauro: opts.withoutKlauro ?? process.env.KLAURO_LIVE_WITHOUT_CMD,
    timeoutMs: opts.timeoutMs ?? numEnv('KLAURO_LIVE_TIMEOUT_MS'),
    testTimeoutMs: opts.testTimeoutMs ?? numEnv('KLAURO_LIVE_TEST_TIMEOUT_MS'),
    keepWorkspaces: opts.keepWorkspaces,
  };
}

export function liveAvailable(cfg: LiveCommandConfig): boolean {
  return Boolean(cfg.withKlauro && cfg.withoutKlauro);
}

/**
 * Ready-to-use launcher commands for a known agent CLI, so `--live --agent claude`
 * works without hand-writing command strings. The Klauro arm gets the agent with
 * its normal MCP config (the global unravl server); the other arms run with
 * `--strict-mcp-config` so they genuinely cannot reach Klauro — a real gate, not
 * just a prompt instruction. The prompt (written by the engine) tells the agent
 * to write the result + metrics JSON the harness reads.
 */
export function defaultAgentCommands(agent: 'claude' | 'codex'): { withKlauro: string; withoutKlauro: string } {
  if (agent === 'codex') {
    return {
      withKlauro: 'codex exec --skip-git-repo-check "$(cat {prompt_file})"',
      withoutKlauro: 'codex exec --skip-git-repo-check "$(cat {prompt_file})"',
    };
  }
  return {
    withKlauro: 'claude -p "$(cat {prompt_file})" --permission-mode acceptEdits',
    withoutKlauro: 'claude -p "$(cat {prompt_file})" --permission-mode acceptEdits --strict-mcp-config',
  };
}

/** Map a scenario group to the agent task it poses. */
function taskForScenario(spec: ScenarioSpec, target: LiveTarget): { task: AgentTask; label: string; expected: string; category: string } {
  // Per-scenario task type, falling back to a per-group default.
  const typeById: Record<string, AgentTaskType> = {
    'repo-bug': 'debug',
    'repo-change': 'modify',
    'security-audit': 'review',
    'test-authoring': 'modify',
    'refactor-safety': 'modify',
    'onboarding-depth': 'orient',
    'cross-repo-bug': 'debug',
    'cross-repo-change': 'cross-repo',
    'api-contract-drift': 'cross-repo',
  };
  const typeByGroup: Record<string, AgentTaskType> = {
    'single-repo': 'orient',
    workspace: 'orient',
    'cross-repo': 'cross-repo',
    incremental: 'review',
    analysis: 'orient',
  };
  const task_type = typeById[spec.id] || typeByGroup[spec.group] || 'orient';
  return {
    task: { task_type, target: '' },
    label: `${spec.label} — ${target.name}`,
    expected: scenarioExpectation(spec),
    category: spec.group,
  };
}

function scenarioExpectation(spec: ScenarioSpec): string {
  switch (spec.id) {
    case 'cold-onboarding':
      return 'An accurate, specific description of what this repo is, what it does, and how it is structured, grounded in real entities — not boilerplate.';
    case 'workspace-orientation':
      return 'An accurate description of each repo in the workspace and how they connect into one product.';
    case 'cross-repo-analysis':
      return 'A correct architectural answer about how the repos compose into one product, naming real cross-repo links.';
    case 'repo-change':
      return 'A minimal, correct edit that implements the change and passes the repo tests.';
    case 'repo-bug':
      return 'The root cause of the bug, located precisely with the failing path identified.';
    case 'security-audit':
      return 'The repo’s real security-sensitive surfaces — auth boundaries, input sinks, secret handling — named with file evidence.';
    case 'test-authoring':
      return 'Meaningful tests for the chosen module that exercise its real behavior and pass.';
    case 'refactor-safety':
      return 'A safe refactor of the target with every caller/usage accounted for and tests still passing.';
    case 'dependency-impact':
      return 'The full ripple of the change — every caller, consumer, and contract affected.';
    case 'api-contract-drift':
      return 'The exact producer/consumer points where the contract has drifted, across repos.';
    case 'onboarding-depth':
      return 'A correct, evidence-cited end-to-end explanation of how the asked-about feature works.';
    default:
      return spec.task;
  }
}

/** Convert a measured N-arm result into the gauntlet ArmResult shape. */
export function measurementToArmResult(m: ArmMeasurement, target: string): ArmResult {
  const sourceParts = [`live agent on ${target}`];
  if (m.retrieved_files !== undefined) sourceParts.push(`${m.retrieved_files} retrieved candidates`);
  if (m.index_ms) sourceParts.push(`index ${m.index_ms}ms`);
  return {
    arm_id: m.arm_id,
    mode: 'live',
    attempted: m.attempted,
    metrics: {
      time_ms: m.duration_ms,
      tokens: m.tokens === Number.MAX_SAFE_INTEGER ? undefined : m.tokens,
      token_source: m.token_source,
      quality: m.quality,
      validation_passed: m.validation_passed,
      command_passed: m.command_passed,
      files_changed: m.files_changed,
      files_read: m.files_read,
    },
    source: sourceParts.join(' · '),
    ...(m.error ? { note: `error: ${m.error}` } : m.note ? { note: m.note } : {}),
  };
}

/** Default live work root for trial workspaces. */
function liveWorkRoot(): string {
  return path.join(os.homedir(), '.klauro', 'gauntlet', 'live-trials');
}

/**
 * Run one scenario live against one target across ALL of the scenario's arms
 * (klauro, no-tools, and every competitor with a retrieval backend), returning
 * measured ArmResults. Arms without a configured launcher/backend are omitted —
 * the caller keeps those projected. Throws only if live is wholly unavailable.
 */
export async function runLiveScenario(
  spec: ScenarioSpec,
  target: LiveTarget,
  cfg: LiveCommandConfig
): Promise<ArmResult[]> {
  if (!liveAvailable(cfg)) throw new Error('Live commands not configured (set KLAURO_LIVE_WITH_CMD and KLAURO_LIVE_WITHOUT_CMD).');

  const t = taskForScenario(spec, target);
  const input: LiveAgentPairInput = {
    repo: target.name,
    repoPath: target.repoPath,
    taskId: `${spec.id}__${target.name}`,
    taskLabel: t.label,
    taskCategory: t.category,
    task: t.task as any,
    expectedOutcome: t.expected,
    fileReadPlan: [],
  };
  const commandConfig: LiveAgentCommandConfig = {
    withKlauro: cfg.withKlauro,
    withoutKlauro: cfg.withoutKlauro,
    timeoutMs: cfg.timeoutMs,
    testTimeoutMs: cfg.testTimeoutMs,
    keepWorkspaces: cfg.keepWorkspaces,
  };

  const armIds = armsForScenario(spec).map(a => a.id);
  const specs = buildArmSpecs(armIds, commandConfig);
  if (specs.length === 0) throw new Error('No live-capable arms for this scenario.');

  const trial = await runMultiArmTrial(input, specs, commandConfig, liveWorkRoot());
  return trial.arms.map(m => measurementToArmResult(m, target.name));
}

/** Pick a representative live target for a scenario from corpus facts. */
export function liveTargetFor(
  spec: ScenarioSpec,
  repos: Array<RepoFact & { path?: string }>,
  workspaces: WorkspaceFact[],
  pathByName: Map<string, string>
): LiveTarget | null {
  // Live runs copy the repo per arm, so prefer a modest-sized but non-trivial
  // target (nodes >= floor) — representative without an impractical copy cost.
  const FLOOR = 200;
  const pickModest = (cands: RepoFact[]): RepoFact | undefined => {
    const resolvable = cands.filter(r => pathByName.has(r.name));
    const nonTrivial = resolvable.filter(r => r.nodes >= FLOOR).sort((a, b) => a.nodes - b.nodes);
    return nonTrivial[0] || resolvable.sort((a, b) => a.nodes - b.nodes)[0];
  };

  const isMulti = spec.group === 'workspace' || spec.group === 'cross-repo';
  if (isMulti) {
    const ws = workspaces.find(w => w.repos.length >= 2);
    if (!ws) return null;
    const member = pickModest(ws.repos);
    if (!member) return null;
    return { name: ws.name, repoPath: pathByName.get(member.name)! };
  }
  const repo = pickModest(repos);
  if (!repo) return null;
  return { name: repo.name, repoPath: pathByName.get(repo.name)! };
}

function firstPositive(...vals: Array<number | undefined>): number | undefined {
  for (const v of vals) if (typeof v === 'number' && v > 0) return v;
  return undefined;
}

function numEnv(key: string): number | undefined {
  const v = process.env[key];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
