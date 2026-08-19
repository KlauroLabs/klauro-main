#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { isDirectCliInvocation } from './cli-invocation';

type ReadinessStatus = 'ready' | 'candidate' | 'blocked' | 'missing';
type BenchmarkArmKind = 'code-intelligence' | 'retrieval' | 'agent-executor' | 'local-model';
type GateStatus = 'pass' | 'warn' | 'fail';

export interface CompetitorProbe {
  id: string;
  label: string;
  kind: BenchmarkArmKind;
  command?: string;
  installed: boolean;
  version?: string;
  auth_state?: 'authenticated' | 'not-authenticated' | 'not-required' | 'unknown';
  free_or_open_source: boolean;
  live_agent_capable: boolean;
  token_metrics_capable: boolean;
  status: ReadinessStatus;
  proof_role: string;
  benchmark_path: string;
  block_reason?: string;
  recommended_command_template?: string;
}

interface BenchmarkGate {
  id: string;
  status: GateStatus;
  detail: string;
}

export interface CompetitorReadinessReport {
  generated_at: string;
  benchmark_type: 'installed-benchmark-readiness';
  status: GateStatus;
  summary: {
    installed_benchmark_arms: number;
    ready_intelligence_competitors: number;
    ready_or_candidate_free_open_agent_executors: number;
    ready_true_live_agent_executors: number;
    blocked_live_agent_executors: number;
    absent_requested_agent_executors: string[];
    claim_limit: string;
  };
  gates: BenchmarkGate[];
  competitors: CompetitorProbe[];
}

interface CliArgs {
  outputPath?: string;
  markdownPath?: string;
}

export function buildCompetitorReadinessReport(competitors: CompetitorProbe[]): CompetitorReadinessReport {
  const installed = competitors.filter(item => item.installed);
  const readyCodeIntel = competitors.filter(item => item.kind !== 'agent-executor' && item.installed && item.status === 'ready');
  const freeOpenAgentExecutors = competitors.filter(item =>
    item.kind === 'agent-executor' &&
    item.free_or_open_source &&
    (item.status === 'ready' || item.status === 'candidate')
  );
  const readyLiveAgentExecutors = competitors.filter(item => item.kind === 'agent-executor' && item.live_agent_capable && item.status === 'ready');
  const blockedLiveAgentExecutors = competitors.filter(item => item.kind === 'agent-executor' && item.live_agent_capable && item.status === 'blocked');
  const absentRequestedAgentExecutors = competitors
    .filter(item => item.kind === 'agent-executor' && item.status === 'missing')
    .map(item => item.id);

  const gates: BenchmarkGate[] = [
    gate('competitor-readiness:installed-code-intelligence', readyCodeIntel.length >= 5, `${readyCodeIntel.length} ready installed code-intelligence/retrieval competitors`),
    gate('competitor-readiness:codebase-memory-installed', competitors.some(item => item.id === 'codebase-memory-mcp' && item.status === 'ready'), 'codebase-memory-mcp is the strongest installed structural competitor'),
    softGate('competitor-readiness:free-open-agent-executor-candidate', freeOpenAgentExecutors.length > 0, `${freeOpenAgentExecutors.length} free/open local agent executors can be used in A/B runs`),
    softGate('competitor-readiness:true-live-agent-executor-ready', readyLiveAgentExecutors.length > 0, `${readyLiveAgentExecutors.length} true live autonomous agent executors ready; ${blockedLiveAgentExecutors.length} blocked by auth/config`),
  ];

  return {
    generated_at: new Date().toISOString(),
    benchmark_type: 'installed-benchmark-readiness',
    status: gates.some(item => item.status === 'fail') ? 'fail' : gates.some(item => item.status === 'warn') ? 'warn' : 'pass',
    summary: {
      installed_benchmark_arms: installed.length,
      ready_intelligence_competitors: readyCodeIntel.length,
      ready_or_candidate_free_open_agent_executors: freeOpenAgentExecutors.length,
      ready_true_live_agent_executors: readyLiveAgentExecutors.length,
      blocked_live_agent_executors: blockedLiveAgentExecutors.length,
      absent_requested_agent_executors: absentRequestedAgentExecutors,
      claim_limit: [
        'This report proves benchmark readiness, not benchmark wins.',
        'Klauro competes with codebase, product, and workspace intelligence substrates.',
        'Autonomous coding tools are executor arms: they use Klauro or another intelligence source in copied-repo A/B tasks.',
        'Code-intelligence competitors can be measured immediately by existing gauntlet arms.',
        'Agent executors require a runnable CLI command that can edit copied repos and expose token metrics when possible.',
        'Installed but unauthenticated executors are blocked, not counted as live proof.',
      ].join(' '),
    },
    gates,
    competitors,
  };
}

export function detectInstalledCompetitors(): CompetitorProbe[] {
  const ollama = executable('ollama');
  const ollamaModels = ollama ? commandOutput('ollama', ['list']) : '';
  const qwenCoderAvailable = /\bqwen3-coder(?::|\s)/.test(ollamaModels);
  const nomicEmbeddingAvailable = /\bnomic-embed-text(?::|\s)/.test(ollamaModels);
  const opencode = executable('opencode');
  const cursor = executable('cursor-agent');
  const cursorStatus = cursor ? commandOutput('cursor-agent', ['status']) : '';

  const probes: CompetitorProbe[] = [
    codeIntel('codebase-memory-mcp', 'codebase-memory-mcp', 'Real installed LSP/tree-sitter graph competitor used by Camp B/C/DEPTH/WAS head-to-heads.'),
    codeIntel('scip-typescript', 'scip-typescript', 'Compiler-accurate TS/JS code-intelligence ceiling competitor.'),
    codeIntel('stack-graphs-typescript', 'tree-sitter-stack-graphs-typescript', 'GitHub stack-graphs TypeScript name-resolution competitor.'),
    codeIntel('universal-ctags', 'ctags', 'Universal Ctags symbol-index competitor.'),
    codeIntel('ast-grep', 'ast-grep', 'AST pattern-search competitor.'),
    retrieval('ripgrep', 'rg', 'Lexical retrieval floor and first-file discovery baseline.'),
    {
      id: 'ollama-nomic-embed-text',
      label: 'Ollama nomic-embed-text',
      kind: 'retrieval',
      command: ollama || undefined,
      installed: Boolean(ollama && nomicEmbeddingAvailable),
      version: ollama ? firstLine(commandOutput('ollama', ['--version'])) : undefined,
      auth_state: 'not-required',
      free_or_open_source: true,
      live_agent_capable: false,
      token_metrics_capable: false,
      status: ollama && nomicEmbeddingAvailable ? 'ready' : ollama ? 'blocked' : 'missing',
      proof_role: 'Local embedding RAG competitor, run at full strength through the semantic retrieval arm.',
      benchmark_path: 'npm run semantic-retrieval-benchmark / embeddings-rag gauntlet arms',
      block_reason: ollama && !nomicEmbeddingAvailable ? 'nomic-embed-text is not pulled in Ollama.' : undefined,
    },
    {
      id: 'opencode-ollama-qwen3-coder',
      label: 'OpenCode + local qwen3-coder',
      kind: 'agent-executor',
      command: opencode || undefined,
      installed: Boolean(opencode),
      version: opencode ? firstLine(commandOutput('opencode', ['--version'])) : undefined,
      auth_state: 'not-required',
      free_or_open_source: true,
      live_agent_capable: false,
      token_metrics_capable: false,
      status: opencode ? 'blocked' : 'missing',
      proof_role: 'Free/open local autonomous agent executor for copied-repo live A/B tasks; must pass smoke before being counted as a true live executor arm.',
      benchmark_path: 'npm run competitor-live-benchmark -- --competitor opencode-local=...',
      block_reason: opencode && !qwenCoderAvailable
        ? 'OpenCode is installed, but qwen3-coder is not available in Ollama.'
        : opencode
          ? 'OpenCode is installed and qwen3-coder is in Ollama, but the local Ollama provider smoke test has not passed.'
          : undefined,
    },
    {
      id: 'cursor-agent',
      label: 'Cursor Agent',
      kind: 'agent-executor',
      command: cursor || undefined,
      installed: Boolean(cursor),
      version: cursor ? firstLine(commandOutput('cursor-agent', ['--version'])) : undefined,
      auth_state: cursorStatus.includes('Not logged in') ? 'not-authenticated' : cursor ? 'unknown' : undefined,
      free_or_open_source: false,
      live_agent_capable: Boolean(cursor),
      token_metrics_capable: false,
      status: !cursor ? 'missing' : cursorStatus.includes('Not logged in') ? 'blocked' : 'candidate',
      proof_role: 'Installed Cursor autonomous-agent executor. Count only after auth and a smoke live edit pass.',
      benchmark_path: 'npm run competitor-live-benchmark -- --cursor-cmd ...',
      block_reason: cursorStatus.includes('Not logged in') ? 'cursor-agent is installed but not logged in.' : undefined,
      recommended_command_template: cursor && !cursorStatus.includes('Not logged in')
        ? 'cursor-agent -p --output-format json "{prompt_file}"'
        : undefined,
    },
    missingAgent('aider', 'Aider', 'Free/open autonomous coding agent; install and run with a local Ollama model for no paid provider dependency.'),
    missingAgent('cline', 'Cline', 'Open-source VS Code agent; requires a local command/automation adapter before copied-repo CLI benchmarking.'),
    missingAgent('continue-cli', 'Continue CLI', 'Open-source assistant candidate; current shell reports only zsh builtin `continue`, not a runnable competitor CLI.'),
  ];

  return probes;
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = buildCompetitorReadinessReport(detectInstalledCompetitors());
  if (args.outputPath) {
    await fs.ensureDir(path.dirname(args.outputPath));
    await fs.writeJson(args.outputPath, report, { spaces: 2 });
  }
  if (args.markdownPath) {
    await fs.ensureDir(path.dirname(args.markdownPath));
    await fs.writeFile(args.markdownPath, renderMarkdown(report), 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'fail') process.exitCode = 1;
}

function codeIntel(id: string, commandName: string, proofRole: string): CompetitorProbe {
  const command = executable(commandName);
  const versionProbe = command ? probeCommand(command, ['--version']) : undefined;
  return {
    id,
    label: id,
    kind: 'code-intelligence',
    command: command || undefined,
    installed: Boolean(command),
    version: firstLine(versionProbe?.output),
    auth_state: 'not-required',
    free_or_open_source: true,
    live_agent_capable: false,
    token_metrics_capable: false,
    status: command ? versionProbe?.ok ? 'ready' : 'blocked' : 'missing',
    proof_role: proofRole,
    benchmark_path: 'npm test -- src/gauntlet/*.test.ts / npm run agent-proof-full',
    block_reason: command && !versionProbe?.ok
      ? `Executable found but could not run: ${compactOutput(versionProbe?.output)}`
      : undefined,
  };
}

function retrieval(id: string, commandName: string, proofRole: string): CompetitorProbe {
  const item = codeIntel(id, commandName, proofRole);
  return { ...item, kind: 'retrieval' };
}

function missingAgent(id: string, label: string, proofRole: string): CompetitorProbe {
  const command = executable(id);
  return {
    id,
    label,
    kind: 'agent-executor',
    command: command || undefined,
    installed: Boolean(command),
    version: command ? firstLine(commandOutput(id, ['--version'])) : undefined,
    auth_state: command ? 'unknown' : undefined,
    free_or_open_source: true,
    live_agent_capable: Boolean(command),
    token_metrics_capable: false,
    status: command ? 'candidate' : 'missing',
    proof_role: proofRole,
    benchmark_path: 'npm run competitor-live-benchmark -- --competitor ...',
    block_reason: command ? 'Installed but not smoke-tested in the Klauro copied-repo live harness.' : 'No runnable CLI found on PATH.',
  };
}

export function executable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (name === 'continue') return null;
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function commandOutput(command: string, args: string[]): string {
  return probeCommand(command, args).output;
}

export function probeCommand(command: string, args: string[]): { ok: boolean; output: string } {
  try {
    return {
      ok: true,
      output: execFileSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20_000, env: process.env }),
    };
  } catch (error) {
    const anyError = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, output: `${anyError.stdout || ''}${anyError.stderr || ''}` };
  }
}

function compactOutput(value: string | undefined): string {
  const output = String(value || 'unknown execution failure').replace(/\s+/g, ' ').trim();
  return output.length <= 240 ? output : `${output.slice(0, 239)}…`;
}

function firstLine(value: string | undefined): string | undefined {
  const line = String(value || '').trim().split('\n').find(Boolean);
  return line || undefined;
}

function gate(id: string, ok: boolean, detail: string): BenchmarkGate {
  return { id, status: ok ? 'pass' : 'fail', detail };
}

function softGate(id: string, ok: boolean, detail: string): BenchmarkGate {
  return { id, status: ok ? 'pass' : 'warn', detail };
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    outputPath: path.join(process.cwd(), '.klauro-competitor-readiness', 'latest-report.json'),
    markdownPath: path.join(process.cwd(), '.klauro-competitor-readiness', 'latest-report.md'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') args.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') args.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--no-output') {
      args.outputPath = undefined;
      args.markdownPath = undefined;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run competitor-readiness -- [--output report.json] [--markdown report.md]',
        '',
        'Detects installed intelligence competitors and agent executor arms, then reports which are ready, candidate, blocked, or missing.',
      ].join('\n'));
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  return args;
}

function renderMarkdown(report: CompetitorReadinessReport): string {
  const lines = [
    '# Klauro Installed Competitor Readiness',
    '',
    `Generated: ${report.generated_at}`,
    `Status: **${report.status.toUpperCase()}**`,
    '',
    '## Summary',
    '',
    `- Installed benchmark arms: ${report.summary.installed_benchmark_arms}.`,
    `- Ready code-intelligence/retrieval competitors: ${report.summary.ready_intelligence_competitors}.`,
    `- Ready/candidate free-open agent executors: ${report.summary.ready_or_candidate_free_open_agent_executors}.`,
    `- Ready true live autonomous agent executors: ${report.summary.ready_true_live_agent_executors}.`,
    `- Blocked live autonomous agent executors: ${report.summary.blocked_live_agent_executors}.`,
    `- Missing requested agent executors: ${report.summary.absent_requested_agent_executors.join(', ') || 'none'}.`,
    '',
    report.summary.claim_limit,
    '',
    '## Benchmark Arms',
    '',
    '| Benchmark arm | Kind | Status | Free/Open | Proof role | Blocker |',
    '|---|---|---|---|---|---|',
    ...report.competitors.map(item => [
      item.label,
      item.kind,
      item.status,
      item.free_or_open_source ? 'yes' : 'no',
      item.proof_role,
      item.block_reason || '',
    ].map(markdownCell).join(' | ')).map(row => `| ${row} |`),
    '',
    '## Gates',
    '',
    ...report.gates.map(item => `- ${item.status.toUpperCase()} ${item.id}: ${item.detail}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function markdownCell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

if (isDirectCliInvocation('competitor-readiness')) {
  runCli().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
