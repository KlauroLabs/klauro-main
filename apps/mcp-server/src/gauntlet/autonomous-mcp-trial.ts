/**
 * #96 AUTONOMOUS mode harness.
 *
 * Unlike agent-live-trial.ts (WITH-KLAURO = context pre-injected, MCP forbidden;
 * WITHOUT-KLAURO = manual search), this harness measures an agent that
 * AUTONOMOUSLY CALLS the Klauro MCP tools during a task. The two arms are:
 *
 *   A) AUTONOMOUS-KLAURO — the agent is handed the Klauro MCP tools (via an MCP
 *      client config that boots the LOCAL Klauro stdio MCP server pointed at the
 *      DEPLOYED analyzer, https://mcp.klauro.com, using KLAURO_BENCH_ANALYZER_TOKEN)
 *      and is INSTRUCTED to call them to gather context, then complete the task.
 *   B) BASELINE — the same task with NO Klauro tools (manual exploration).
 *
 * Both arms are scored with the SAME rubric the rest of the gauntlet uses
 * (scoreArmQuality from multi-arm-trial.ts — imported, not duplicated). The
 * result carries per-arm scores plus quality_delta and token_reduction.
 *
 * The agent runner is PLUGGABLE (opts.agentRunner). The default runner spawns a
 * real CLI (e.g. `claude --mcp-config ...`). The unit test injects a FAKE runner
 * so the harness is exercised with NO real LLM call and NO network.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { scoreArmQuality } from './multi-arm-trial';
import { DEFAULT_KLAURO_CLOUD_URL } from '../defaults';

const execFileAsync = promisify(execFile);

export type AutonomousArmId = 'autonomous-klauro' | 'baseline';

/** Env used to point the agent's Klauro MCP tools at the deployed product. */
export interface DeployedAnalyzerConfig {
  /** Deployed analyzer/MCP URL. Defaults to KLAURO_BENCH_ANALYZER_URL or Klauro Cloud. */
  serverUrl?: string;
  /** Bearer token for the deployed analyzer. Defaults to KLAURO_BENCH_ANALYZER_TOKEN. */
  token?: string;
  /**
   * Command used to boot the local Klauro stdio MCP server. Defaults to
   * `node <package>/dist/index.cjs`, or `tsx <package>/src/index.ts` when
   * KLAURO_MCP_ENTRY points at a source entry. Override for tests/custom installs.
   */
  serverCommand?: string;
  serverArgs?: string[];
}

/** Rendered MCP client config plus the concrete env it carries. */
export interface KlauroMcpClientConfig {
  /** Absolute path to the written `.mcp.json`-shaped config file. */
  configPath: string;
  /** The parsed config object (also useful for assertions/tests). */
  config: {
    mcpServers: {
      klauro: {
        command: string;
        args: string[];
        env: Record<string, string>;
      };
    };
  };
  serverUrl: string;
}

export interface AutonomousTask {
  taskId: string;
  taskLabel: string;
  instructions: string;
  expectedOutcome: string;
  /** Repo the task is performed against (a copy is made per arm). */
  repoPath: string;
}

/** What the harness hands the runner for one arm. */
export interface AgentRunContext {
  arm: AutonomousArmId;
  /** Copy of the repo the agent should work in. */
  workspace: string;
  /** Rendered prompt file (also inlined as `prompt`). */
  promptFile: string;
  prompt: string;
  /** Where the agent should write its result/metrics JSON. */
  resultFile: string;
  metricsFile: string;
  /**
   * For the autonomous-klauro arm only: the MCP client config that wires the
   * Klauro tools to the deployed analyzer. Undefined for the baseline arm.
   */
  mcpConfig?: KlauroMcpClientConfig;
  /**
   * The concrete shell command the default runner would execute, with template
   * tokens ({workspace}, {prompt_file}, {result_file}, {mcp_config}, {arm})
   * already substituted. A custom/fake runner may ignore this.
   */
  command: string;
  task: AutonomousTask;
}

/** What a runner returns after executing one arm. Deliberately minimal — the
 * harness derives the scored measurement from these raw signals. */
export interface AgentRunResult {
  command_passed: boolean;
  validation_passed?: boolean;
  task_success?: boolean;
  self_reported_quality?: number;
  files_changed: number;
  /** Number of Klauro MCP tool calls the agent made (autonomy signal). */
  klauro_tool_calls?: number;
  files_read?: number;
  provider_total_tokens?: number;
  estimated_work_tokens?: number;
  duration_ms?: number;
  error?: string;
  stdout_tail?: string;
}

/** Pluggable agent runner. Default spawns a CLI; tests inject a fake. */
export type AgentRunner = (context: AgentRunContext) => Promise<AgentRunResult>;

export interface AutonomousArmMeasurement {
  arm_id: AutonomousArmId;
  attempted: boolean;
  quality: number;
  command_passed: boolean;
  validation_passed?: boolean;
  task_success?: boolean;
  files_changed: number;
  files_read?: number;
  klauro_tool_calls: number;
  tokens: number;
  token_source: 'provider-total' | 'estimated-work';
  duration_ms: number;
  error?: string;
  workspace: string;
  mcp_config_path?: string;
  command: string;
}

export interface AutonomousMcpTrialResult {
  trial_id: string;
  trial_directory: string;
  server_url: string;
  autonomous_klauro: AutonomousArmMeasurement;
  baseline: AutonomousArmMeasurement;
  delta: {
    /** autonomous-klauro quality minus baseline quality (positive = Klauro better). */
    quality_delta: number;
    /** Percent fewer tokens the autonomous arm used vs baseline (positive = reduction). */
    token_reduction: number | null;
    /** Whether the autonomous agent actually invoked Klauro tools. */
    klauro_tool_calls: number;
    time_reduction_ms: number;
  };
}

export interface AutonomousMcpTrialOptions {
  task: AutonomousTask;
  analyzer?: DeployedAnalyzerConfig;
  /**
   * Command template for the autonomous-klauro arm. Tokens: {workspace},
   * {prompt_file}, {result_file}, {metrics_file}, {mcp_config}, {arm}, {task_id}.
   * When omitted the default runner still receives a rendered no-op command; a
   * real live run must supply a `claude`-style template that consumes {mcp_config}.
   */
  agentKlauroCmd?: string;
  /** Command template for the baseline arm (no {mcp_config}). */
  agentBaselineCmd?: string;
  /** Injected runner (tests). Defaults to a real CLI-spawning runner. */
  agentRunner?: AgentRunner;
  workRoot?: string;
  keepWorkspaces?: boolean;
  timeoutMs?: number;
}

/** Resolve the deployed-analyzer wiring from opts + env, with Cloud defaults. */
export function resolveDeployedAnalyzer(analyzer?: DeployedAnalyzerConfig): Required<Omit<DeployedAnalyzerConfig, 'token'>> & { token?: string } {
  const serverUrl = analyzer?.serverUrl || process.env.KLAURO_BENCH_ANALYZER_URL || DEFAULT_KLAURO_CLOUD_URL;
  const token = analyzer?.token || process.env.KLAURO_BENCH_ANALYZER_TOKEN;
  const entry = process.env.KLAURO_MCP_ENTRY;
  let serverCommand = analyzer?.serverCommand;
  let serverArgs = analyzer?.serverArgs;
  if (!serverCommand) {
    if (entry && /\.(ts|tsx|mts)$/.test(entry)) {
      serverCommand = 'tsx';
      serverArgs = serverArgs || [entry];
    } else {
      serverCommand = 'node';
      serverArgs = serverArgs || [entry || path.resolve(__dirname, '..', '..', 'dist', 'index.cjs')];
    }
  }
  return { serverUrl, token, serverCommand, serverArgs: serverArgs || [] };
}

/**
 * Build the MCP client config that boots the LOCAL Klauro stdio MCP server with
 * env pointing it at the DEPLOYED analyzer. This is the exact wiring an agent's
 * `--mcp-config` flag consumes: it launches `command args` over stdio and the
 * server reads KLAURO_ANALYZER_URL / KLAURO_ANALYZER_TOKEN from its env.
 */
export async function writeKlauroMcpClientConfig(
  destination: string,
  analyzer?: DeployedAnalyzerConfig
): Promise<KlauroMcpClientConfig> {
  const resolved = resolveDeployedAnalyzer(analyzer);
  const env: Record<string, string> = {
    // The Klauro MCP server honors KLAURO_ANALYZER_URL for the analyzer endpoint.
    KLAURO_ANALYZER_URL: resolved.serverUrl,
    KLAURO_API_URL: resolved.serverUrl,
  };
  if (resolved.token) {
    // connector-auth honors KLAURO_ANALYZER_TOKEN / KLAURO_ACCOUNT_TOKEN.
    env.KLAURO_ANALYZER_TOKEN = resolved.token;
    env.KLAURO_ACCOUNT_TOKEN = resolved.token;
  }
  const config = {
    mcpServers: {
      klauro: {
        command: resolved.serverCommand,
        args: resolved.serverArgs,
        env,
      },
    },
  };
  await fs.ensureDir(path.dirname(destination));
  await fs.writeJson(destination, config, { spaces: 2 });
  return { configPath: destination, config, serverUrl: resolved.serverUrl };
}

function renderCommand(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

function autonomousKlauroPrompt(task: AutonomousTask, workspace: string, resultFile: string): string {
  return [
    `Repo: ${workspace}`,
    `Task: ${task.taskLabel}`,
    task.instructions ? `Instructions: ${task.instructions}` : '',
    `Expected outcome: ${task.expectedOutcome}`,
    '',
    'You have the Klauro codebase-intelligence MCP tools available. AUTONOMOUSLY call them',
    'FIRST to orient and gather the context you need (e.g. find/understand the relevant',
    'entities, flows, and target files) BEFORE reading source or editing. Prefer the Klauro',
    'tools over broad grep/file search. Then make the smallest change that satisfies the task.',
    '',
    `When done, write JSON to ${resultFile} with fields: task_success (bool), quality_score (0-10),`,
    'files_read (number), klauro_tool_calls (number of Klauro MCP tool calls you made).',
    'Keep your final message under 80 words.',
  ].filter(Boolean).join('\n');
}

function baselinePrompt(task: AutonomousTask, workspace: string, resultFile: string): string {
  return [
    `Repo: ${workspace}`,
    `Task: ${task.taskLabel}`,
    task.instructions ? `Instructions: ${task.instructions}` : '',
    `Expected outcome: ${task.expectedOutcome}`,
    '',
    'You do NOT have Klauro. Explore the repository manually (search, read files) to gather',
    'the context you need, then make the smallest change that satisfies the task.',
    '',
    `When done, write JSON to ${resultFile} with fields: task_success (bool), quality_score (0-10),`,
    'files_read (number). Keep your final message under 80 words.',
  ].filter(Boolean).join('\n');
}

/** Recursively copy a repo, skipping heavy/ignored dirs. */
async function copyRepo(source: string, destination: string): Promise<void> {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'coverage', '.next', '.turbo', '.cache']);
  await fs.ensureDir(destination);
  await fs.copy(source, destination, {
    filter: (src) => {
      const base = path.basename(src);
      return !ignored.has(base);
    },
  });
}

/** Count changed files via git (best-effort; 0 when git is unavailable). */
async function countChangedFiles(workspace: string): Promise<number> {
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: workspace });
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: workspace });
    return stdout.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Default runner: spawns a real CLI and reads back the result JSON. */
function defaultAgentRunner(timeoutMs: number): AgentRunner {
  return async (context: AgentRunContext): Promise<AgentRunResult> => {
    const startedAt = Date.now();
    try {
      const { stdout } = await execFileAsync('bash', ['-lc', context.command], {
        cwd: context.workspace,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      const result = await fs.readJson(context.resultFile).catch(() => ({} as any));
      const changed = await countChangedFiles(context.workspace);
      return {
        command_passed: true,
        task_success: typeof result.task_success === 'boolean' ? result.task_success : undefined,
        self_reported_quality: typeof result.quality_score === 'number' ? result.quality_score : undefined,
        files_read: typeof result.files_read === 'number' ? result.files_read : undefined,
        klauro_tool_calls: typeof result.klauro_tool_calls === 'number' ? result.klauro_tool_calls : undefined,
        files_changed: changed,
        provider_total_tokens: typeof result.provider_total_tokens === 'number' ? result.provider_total_tokens : undefined,
        duration_ms: Date.now() - startedAt,
        stdout_tail: stdout.slice(-2000),
      };
    } catch (error) {
      return {
        command_passed: false,
        files_changed: 0,
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

async function runArm(
  arm: AutonomousArmId,
  task: AutonomousTask,
  trialDirectory: string,
  runner: AgentRunner,
  opts: AutonomousMcpTrialOptions
): Promise<AutonomousArmMeasurement> {
  const workspace = path.join(trialDirectory, arm);
  const promptFile = path.join(trialDirectory, `${arm}-prompt.md`);
  const resultFile = path.join(workspace, '.klauro-autonomous-result.json');
  const metricsFile = path.join(workspace, '.klauro-autonomous-metrics.json');
  const startedAt = Date.now();

  try {
    await copyRepo(task.repoPath, workspace);

    let mcpConfig: KlauroMcpClientConfig | undefined;
    if (arm === 'autonomous-klauro') {
      mcpConfig = await writeKlauroMcpClientConfig(path.join(trialDirectory, 'klauro.mcp.json'), opts.analyzer);
    }

    const prompt = arm === 'autonomous-klauro'
      ? autonomousKlauroPrompt(task, workspace, resultFile)
      : baselinePrompt(task, workspace, resultFile);
    await fs.writeFile(promptFile, prompt, 'utf8');

    const template = arm === 'autonomous-klauro'
      ? (opts.agentKlauroCmd || ':')
      : (opts.agentBaselineCmd || ':');
    const command = renderCommand(template, {
      workspace,
      prompt,
      prompt_file: promptFile,
      result_file: resultFile,
      metrics_file: metricsFile,
      mcp_config: mcpConfig?.configPath || '',
      arm,
      task_id: task.taskId,
    });

    const result = await runner({
      arm,
      workspace,
      promptFile,
      prompt,
      resultFile,
      metricsFile,
      mcpConfig,
      command,
      task,
    });

    const quality = scoreArmQuality({
      command_passed: result.command_passed,
      validation_passed: result.validation_passed,
      task_success: result.task_success,
      self_reported_quality: result.self_reported_quality,
      files_changed: result.files_changed,
      error: result.error,
    });
    const providerTotal = result.provider_total_tokens;
    const estWork = result.estimated_work_tokens ?? estimateWorkTokens(prompt, result);
    return {
      arm_id: arm,
      attempted: true,
      quality,
      command_passed: result.command_passed,
      validation_passed: result.validation_passed,
      task_success: result.task_success,
      files_changed: result.files_changed,
      files_read: result.files_read,
      klauro_tool_calls: result.klauro_tool_calls ?? 0,
      tokens: providerTotal ?? estWork,
      token_source: providerTotal ? 'provider-total' : 'estimated-work',
      duration_ms: result.duration_ms ?? (Date.now() - startedAt),
      error: result.error,
      workspace,
      mcp_config_path: mcpConfig?.configPath,
      command,
    };
  } catch (error) {
    return {
      arm_id: arm,
      attempted: true,
      quality: 5,
      command_passed: false,
      files_changed: 0,
      klauro_tool_calls: 0,
      tokens: Number.MAX_SAFE_INTEGER,
      token_source: 'estimated-work',
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      workspace,
      command: '',
    };
  }
}

function estimateWorkTokens(prompt: string, result: AgentRunResult): number {
  const promptTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil((result.stdout_tail?.length || 0) / 4);
  const readTokens = (result.files_read || 0) * 500;
  return promptTokens + outputTokens + readTokens;
}

function tokenReduction(withTokens: number, withoutTokens: number): number | null {
  if (!Number.isFinite(withTokens) || !Number.isFinite(withoutTokens) || withoutTokens <= 0) return null;
  if (withTokens >= Number.MAX_SAFE_INTEGER || withoutTokens >= Number.MAX_SAFE_INTEGER) return null;
  return Math.round(((withoutTokens - withTokens) / withoutTokens) * 1000) / 10;
}

/**
 * Run the #96 autonomous trial: two arms (autonomous-klauro vs baseline), scored
 * with the shared rubric, returning per-arm scores plus quality/token deltas.
 */
export async function runAutonomousMcpTrial(opts: AutonomousMcpTrialOptions): Promise<AutonomousMcpTrialResult> {
  const workRoot = path.resolve(opts.workRoot || path.join(os.tmpdir(), 'klauro-autonomous-mcp-trials'));
  const trialId = `${slugify(opts.task.taskId)}-${Date.now().toString(36)}`;
  const trialDirectory = path.join(workRoot, trialId);
  await fs.ensureDir(trialDirectory);

  const runner = opts.agentRunner || defaultAgentRunner(opts.timeoutMs || 20 * 60 * 1000);
  const serverUrl = resolveDeployedAnalyzer(opts.analyzer).serverUrl;

  const autonomous = await runArm('autonomous-klauro', opts.task, trialDirectory, runner, opts);
  const baseline = await runArm('baseline', opts.task, trialDirectory, runner, opts);

  if (opts.keepWorkspaces === false) {
    await fs.remove(path.join(trialDirectory, 'autonomous-klauro')).catch(() => undefined);
    await fs.remove(path.join(trialDirectory, 'baseline')).catch(() => undefined);
  }

  return {
    trial_id: trialId,
    trial_directory: trialDirectory,
    server_url: serverUrl,
    autonomous_klauro: autonomous,
    baseline,
    delta: {
      quality_delta: autonomous.quality - baseline.quality,
      token_reduction: tokenReduction(autonomous.tokens, baseline.tokens),
      klauro_tool_calls: autonomous.klauro_tool_calls,
      time_reduction_ms: baseline.duration_ms - autonomous.duration_ms,
    },
  };
}

function slugify(input: string): string {
  return String(input).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
}

// ---------------------------------------------------------------------------
// CLI entry. Guarded: with no --agent-cmd it prints usage and exits 0.
// ---------------------------------------------------------------------------

function parseCliArgs(argv: string[]) {
  const out: {
    repo?: string;
    taskId?: string;
    label?: string;
    instructions?: string;
    expected?: string;
    agentKlauroCmd?: string;
    agentBaselineCmd?: string;
    serverUrl?: string;
    token?: string;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--task-id') out.taskId = argv[++i];
    else if (arg === '--label') out.label = argv[++i];
    else if (arg === '--instructions') out.instructions = argv[++i];
    else if (arg === '--expected') out.expected = argv[++i];
    else if (arg === '--agent-cmd') { out.agentKlauroCmd = argv[++i]; }
    else if (arg === '--agent-klauro-cmd') out.agentKlauroCmd = argv[++i];
    else if (arg === '--agent-baseline-cmd') out.agentBaselineCmd = argv[++i];
    else if (arg === '--server-url') out.serverUrl = argv[++i];
    else if (arg === '--token') out.token = argv[++i];
  }
  return out;
}

function printUsage(): void {
  console.log([
    '#96 Autonomous MCP trial — agent AUTONOMOUSLY calls the Klauro MCP tools vs a no-Klauro baseline.',
    '',
    'Usage: npm run autonomous-mcp-trial -- --repo /path --agent-cmd "<cmd>" [options]',
    '',
    'Options:',
    '  --repo /path/to/repo         Repo the task is performed against (required for a live run).',
    '  --task-id id                 Task id (default: autonomous-task).',
    '  --label text                 Human task label.',
    '  --instructions text          Task instructions.',
    '  --expected text              Expected outcome, used by scoring/judge.',
    '  --agent-cmd "<cmd>"          Command template for the autonomous-klauro arm.',
    '                               Must consume {mcp_config} (the Klauro MCP client config) and',
    '                               {prompt_file}. Example (claude CLI):',
    '                                 claude -p --mcp-config {mcp_config} --add-dir {workspace} \\',
    '                                        --safe-mode --no-session-persistence -- "$(cat {prompt_file})"',
    '  --agent-baseline-cmd "<cmd>" Command template for the baseline arm (no {mcp_config}).',
    '                               Defaults to --agent-cmd with {mcp_config} stripped by the template author.',
    '  --server-url url             Deployed analyzer URL (default: KLAURO_BENCH_ANALYZER_URL or Klauro Cloud).',
    '  --token token                Bearer token (default: KLAURO_BENCH_ANALYZER_TOKEN).',
    '',
    'Env: KLAURO_BENCH_ANALYZER_URL, KLAURO_BENCH_ANALYZER_TOKEN, KLAURO_MCP_ENTRY (source entry override).',
    'Template tokens: {workspace} {prompt_file} {result_file} {metrics_file} {mcp_config} {arm} {task_id}.',
  ].join('\n'));
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.agentKlauroCmd || !args.repo) {
    printUsage();
    // Guard: no crash, exit 0 when there's nothing to run live.
    process.exit(0);
  }
  const result = await runAutonomousMcpTrial({
    task: {
      taskId: args.taskId || 'autonomous-task',
      taskLabel: args.label || args.taskId || 'autonomous-task',
      instructions: args.instructions || '',
      expectedOutcome: args.expected || '',
      repoPath: path.resolve(args.repo!),
    },
    analyzer: { serverUrl: args.serverUrl, token: args.token },
    agentKlauroCmd: args.agentKlauroCmd,
    agentBaselineCmd: args.agentBaselineCmd || args.agentKlauroCmd!.replace(/--mcp-config\s+\{mcp_config\}\s*/g, ''),
  });
  console.log(JSON.stringify(result, null, 2));
  console.log(
    `Autonomous-Klauro quality ${result.autonomous_klauro.quality}/100 vs baseline ${result.baseline.quality}/100 ` +
    `(delta ${result.delta.quality_delta >= 0 ? '+' : ''}${result.delta.quality_delta}); ` +
    `token reduction ${result.delta.token_reduction === null ? 'n/a' : `${result.delta.token_reduction}%`}; ` +
    `klauro tool calls ${result.delta.klauro_tool_calls}.`
  );
}

// Only run as a CLI when invoked directly (not when imported by the test).
const invokedName = process.argv[1] ? path.basename(process.argv[1]).replace(/\.(mts|cts|tsx|ts|mjs|cjs|jsx|js)$/, '') : '';
if (invokedName === 'autonomous-mcp-trial') {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
