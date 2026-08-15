






































import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  runAutonomousMcpTrial,
  resolveDeployedAnalyzer,
  type AutonomousTask,
  type AgentRunner,
  type AgentRunContext,
  type AgentRunResult,
} from './autonomous-mcp-trial';
import { runDeepInfraAgent, DEFAULT_DEEPINFRA_AGENT_MODEL } from './deepinfra-agent';

export const LARGE_REPO_SOURCE = path.resolve(__dirname, '..', '..', '..', '..', 'packages', 'analyzer-core');


const MANIFEST_FILES = ['package.json', 'tsconfig.json', 'jest.config.js'];






export async function materializeLargeRepoTask(opts?: { destination?: string }): Promise<string> {
  const destination = opts?.destination || (await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-large-repo-')));
  await fs.ensureDir(destination);
  const srcSource = path.join(LARGE_REPO_SOURCE, 'src');
  if (!(await fs.pathExists(srcSource))) {
    throw new Error(`large-repo source not found: ${srcSource} (expected packages/analyzer-core/src)`);
  }
  await fs.copy(srcSource, path.join(destination, 'src'), {
    filter: (src) => path.basename(src) !== '__tests__' || true,
  });
  for (const manifest of MANIFEST_FILES) {
    const from = path.join(LARGE_REPO_SOURCE, manifest);
    if (await fs.pathExists(from)) {
      await fs.copy(from, path.join(destination, manifest));
    }
  }
  return destination;
}

export function largeRepoTask(repoPath: string): AutonomousTask {
  return {
    taskId: 'large-repo-add-language-registry-entry',
    taskLabel: 'Add a Zig language entry to the source-file language registry',
    instructions: [
      'Find the single-source-of-truth registry that the orchestrator uses to decide which',
      'source files belong to which language (it lives under src/analyzer/... and is documented',
      'as replacing a formerly-hardcoded extension list). Add a new entry for the Zig language:',
      'id "zig", source extension "zig" (no leading dot), and manifest file "build.zig.zon".',
      'Follow the exact shape and style of the existing entries in the same array — do not',
      'introduce a second registry or duplicate the extension-matching logic elsewhere.',
    ].join(' '),
    expectedOutcome:
      'The language registry array gains one new entry: { id: "zig", extensions: ["zig"], manifests: ["build.zig.zon"] } ' +
      '(or equivalent, matching the existing entry shape), and no other file duplicates this logic.',
    repoPath,
  };
}


export const LARGE_REPO_TIMEOUT_MS = 6 * 60 * 1000;
export const LARGE_REPO_MAX_ITERS = 10;







export function createDeepInfraDirectRunner(opts?: { model?: string; maxIters?: number }): AgentRunner {
  return async (context: AgentRunContext): Promise<AgentRunResult> => {
    const startedAt = Date.now();
    try {
      const result = await runDeepInfraAgent({
        promptFile: context.promptFile,
        workspace: context.workspace,
        resultFile: context.resultFile,
        mcpConfig: context.mcpConfig?.configPath,
        model: opts?.model,
        maxIters: opts?.maxIters ?? LARGE_REPO_MAX_ITERS,
        timeoutMs: LARGE_REPO_TIMEOUT_MS,
      });


      const touchedRegistry = result.files_changed.some((file) => file.includes('language-registry'));
      const mentionsZig = /zig/i.test(result.summary) || result.files_changed.some((file) => /zig/i.test(file));
      return {
        command_passed: true,
        task_success: touchedRegistry,
        self_reported_quality: touchedRegistry && mentionsZig ? 8 : touchedRegistry ? 6 : 3,
        files_changed: result.files_changed.length,
        files_read: undefined,
        klauro_tool_calls: result.klauro_tool_calls,
        provider_total_tokens: result.provider_total_tokens,
        duration_ms: Date.now() - startedAt,
        stdout_tail: result.summary.slice(-2000),
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

export interface LargeRepoRunReport {
  mode: 'live' | 'projected';
  reason?: string;
  repo_source: string;
  materialized_repo?: string;
  file_count?: number;
  source_bytes?: number;
  server_url: string;
  result?: Awaited<ReturnType<typeof runAutonomousMcpTrial>>;
}

async function countRepoFiles(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        files++;
        const stat = await fs.stat(full);
        bytes += stat.size;
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}






export async function runLargeRepoScenario(opts?: {
  forceProjected?: boolean;
  keepWorkspaces?: boolean;
  model?: string;
  maxIters?: number;
}): Promise<LargeRepoRunReport> {
  const materialized = await materializeLargeRepoTask();
  const { files, bytes } = await countRepoFiles(materialized);
  const serverUrl = resolveDeployedAnalyzer().serverUrl;
  const hasKey = !!process.env.DEEPINFRA_API_KEY;

  if (opts?.forceProjected || !hasKey) {
    return {
      mode: 'projected',
      reason: hasKey
        ? 'forced by caller'
        : 'DEEPINFRA_API_KEY is not set in the environment — no live LLM calls were made. ' +
          'A real run needs DEEPINFRA_API_KEY exported (it is present in .env but .env is not auto-loaded into this shell).',
      repo_source: LARGE_REPO_SOURCE,
      materialized_repo: materialized,
      file_count: files,
      source_bytes: bytes,
      server_url: serverUrl,
    };
  }

  const task = largeRepoTask(materialized);
  const result = await runAutonomousMcpTrial({
    task,
    agentRunner: createDeepInfraDirectRunner({ model: opts?.model, maxIters: opts?.maxIters }),
    timeoutMs: LARGE_REPO_TIMEOUT_MS,
    keepWorkspaces: opts?.keepWorkspaces ?? false,
  });

  return {
    mode: 'live',
    repo_source: LARGE_REPO_SOURCE,
    materialized_repo: materialized,
    file_count: files,
    source_bytes: bytes,
    server_url: serverUrl,
    result,
  };
}

function printReport(report: LargeRepoRunReport): void {
  console.log(`Mode: ${report.mode.toUpperCase()}`);
  if (report.reason) console.log(`Reason: ${report.reason}`);
  console.log(`Repo source: ${report.repo_source}`);
  console.log(`Materialized workspace source: ${report.materialized_repo}`);
  console.log(`File count: ${report.file_count}, source bytes: ${report.source_bytes}`);
  console.log(`Deployed analyzer: ${report.server_url}`);
  if (report.result) {
    const r = report.result;
    console.log('');
    console.log(
      `Autonomous-Klauro quality ${r.autonomous_klauro.quality}/100 vs baseline ${r.baseline.quality}/100 ` +
      `(delta ${r.delta.quality_delta >= 0 ? '+' : ''}${r.delta.quality_delta})`
    );
    console.log(
      `Tokens: klauro=${r.autonomous_klauro.tokens} (${r.autonomous_klauro.token_source}) vs ` +
      `baseline=${r.baseline.tokens} (${r.baseline.token_source}); reduction ${
        r.delta.token_reduction === null ? 'n/a' : `${r.delta.token_reduction}%`
      }`
    );
    console.log(`Klauro tool calls (autonomous arm): ${r.delta.klauro_tool_calls}`);
    console.log(`Time: klauro=${r.autonomous_klauro.duration_ms}ms vs baseline=${r.baseline.duration_ms}ms`);
    console.log(`Task success: klauro=${r.autonomous_klauro.task_success} vs baseline=${r.baseline.task_success}`);
    if (r.autonomous_klauro.error) console.log(`Klauro arm error: ${r.autonomous_klauro.error}`);
    if (r.baseline.error) console.log(`Baseline arm error: ${r.baseline.error}`);
  } else {
    console.log('');
    console.log('No live result — projected mode only verifies materialization + wiring.');
    console.log(`Model that WOULD be used: ${process.env.DEEPINFRA_AGENT_MODEL || DEFAULT_DEEPINFRA_AGENT_MODEL}`);
  }
}

function parseCliArgs(argv: string[]) {
  const out: { forceProjected?: boolean; maxIters?: number; model?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--projected') out.forceProjected = true;
    else if (arg === '--max-iters') out.maxIters = Number(argv[++i]);
    else if (arg === '--model') out.model = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runLargeRepoScenario(args);
  printReport(report);
}

const invokedName = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\.(mts|cts|tsx|ts|mjs|cjs|jsx|js)$/, '')
  : '';
if (invokedName === 'large-repo-scenario') {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
