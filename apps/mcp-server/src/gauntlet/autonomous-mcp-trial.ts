




















import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { scoreArmQuality } from './multi-arm-trial';
import { DEFAULT_KLAURO_CLOUD_URL } from '../defaults';

const execFileAsync = promisify(execFile);

export type AutonomousArmId = 'autonomous-klauro' | 'baseline';


export interface DeployedAnalyzerConfig {

  serverUrl?: string;

  token?: string;





  serverCommand?: string;
  serverArgs?: string[];
}


export interface KlauroMcpClientConfig {

  configPath: string;

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

  repoPath: string;
}


export interface AgentRunContext {
  arm: AutonomousArmId;

  workspace: string;

  promptFile: string;
  prompt: string;

  resultFile: string;
  metricsFile: string;




  mcpConfig?: KlauroMcpClientConfig;





  command: string;
  task: AutonomousTask;
}



export interface AgentRunResult {
  command_passed: boolean;
  validation_passed?: boolean;
  task_success?: boolean;
  self_reported_quality?: number;
  files_changed: number;

  klauro_tool_calls?: number;
  files_read?: number;
  provider_total_tokens?: number;
  estimated_work_tokens?: number;
  duration_ms?: number;
  error?: string;
  stdout_tail?: string;
}


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

    quality_delta: number;

    token_reduction: number | null;

    klauro_tool_calls: number;
    time_reduction_ms: number;
  };
}

export interface AutonomousMcpTrialOptions {
  task: AutonomousTask;
  analyzer?: DeployedAnalyzerConfig;






  agentKlauroCmd?: string;

  agentBaselineCmd?: string;

  agentRunner?: AgentRunner;
  workRoot?: string;
  keepWorkspaces?: boolean;
  timeoutMs?: number;
}


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







export async function writeKlauroMcpClientConfig(
  destination: string,
  analyzer?: DeployedAnalyzerConfig
): Promise<KlauroMcpClientConfig> {
  const resolved = resolveDeployedAnalyzer(analyzer);
  const env: Record<string, string> = {

    KLAURO_ANALYZER_URL: resolved.serverUrl,
    KLAURO_API_URL: resolved.serverUrl,
  };
  if (resolved.token) {

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


async function countChangedFiles(workspace: string): Promise<number> {
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: workspace });
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: workspace });
    return stdout.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}


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


const invokedName = process.argv[1] ? path.basename(process.argv[1]).replace(/\.(mts|cts|tsx|ts|mjs|cjs|jsx|js)$/, '') : '';
if (invokedName === 'autonomous-mcp-trial') {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
