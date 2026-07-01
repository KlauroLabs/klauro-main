import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface MeasurementCondition {
  id: 'mcp-bare' | 'mcp-instructed' | 'control';
  label: string;
  mcpEnabled: boolean;
  workspaceInstructions: boolean;
}

interface ToolCallRecord {
  index: number;
  name: string;
}

interface RunResult {
  condition: MeasurementCondition['id'];
  repetition: number;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
  toolCalls: ToolCallRecord[];
  klauroToolCalls: ToolCallRecord[];
  firstKlauroToolIndex: number | null;
  klauroServerLog: string[];
  numTurns: number | null;
  totalCostUsd: number | null;
  isError: boolean;
  resultPreview: string;
}

const CONDITIONS: MeasurementCondition[] = [
  { id: 'mcp-bare', label: 'MCP available, no instructions', mcpEnabled: true, workspaceInstructions: false },
  { id: 'mcp-instructed', label: 'MCP available + CLAUDE.md operating loop', mcpEnabled: true, workspaceInstructions: true },
  { id: 'control', label: 'No MCP (control)', mcpEnabled: false, workspaceInstructions: false },
];

const REPETITIONS = 2;
const RUN_TIMEOUT_MS = 300_000;

const TASK_PROMPT = [
  'I need to add an audit trail for driver status changes in this codebase.',
  'Investigate how driver status updates currently flow from the UI through services to the backend API.',
  'Identify the specific components, services, and API endpoints involved, assess what could break,',
  'and give me a concrete change plan: the exact files to modify, the risk level, and which existing tests cover this area.',
  'Do not make any code edits; produce the investigation and plan only.',
].join(' ');

const OPERATING_LOOP_INSTRUCTIONS = `## Codebase Intelligence (Klauro)

This repository has a Klauro CAS analysis. Use the Klauro MCP server as the primary source of truth before broad source-file exploration.

Agent operating loop:

1. Call \`resolve_agent_analysis\` for this repository path and the current task.
2. Call \`get_agent_start_context\` for the selected path before broad file reads.
3. Call \`get_agent_tool_plan\` with the task type (orient, modify, debug, review, trace, cross-repo, or runtime).
4. Call \`get_agent_context\` for real work so CAS resolves the target, risk, tests, call context, invariants, and first files to inspect.
5. Before code edits, call \`get_coding_context\` for the target, then \`assess_change_risk\` and \`find_tests\` when connected behavior can be affected.
6. Read source files only after MCP narrows the target to specific files.
7. After edits, call \`validate_behavioral_invariants\` and \`validate_codebase_idioms\` before finalizing.

Do not guess at how the system is structured. Query the analysis.
`;

function repoRoot(): string {
  return path.resolve(__dirname, '..');
}

function parseArgs(argv: string[]): { targetRepo: string; outputDir: string; conditions: Set<string>; repetitions: number; toolProfile: 'core' | 'full' } {
  let targetRepo = '/Users/michaelshattuck/dev/clients/outcode/truckspy/truckspyui';
  let outputDir = '/tmp/klauro-adoption-measurement';
  let repetitions = REPETITIONS;
  let toolProfile: 'core' | 'full' = 'full';
  const conditions = new Set<string>(CONDITIONS.map(condition => condition.id));

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target-repo' && argv[i + 1]) targetRepo = argv[++i];
    else if (argv[i] === '--output-dir' && argv[i + 1]) outputDir = argv[++i];
    else if (argv[i] === '--repetitions' && argv[i + 1]) repetitions = Number(argv[++i]);
    else if (argv[i] === '--tool-profile' && argv[i + 1]) toolProfile = argv[++i] === 'core' ? 'core' : 'full';
    else if (argv[i] === '--conditions' && argv[i + 1]) {
      conditions.clear();
      for (const id of argv[++i].split(',')) conditions.add(id.trim());
    }
  }

  return { targetRepo, outputDir, conditions, repetitions, toolProfile };
}

function writeMcpConfig(outputDir: string, klauroLogPath: string, toolProfile: 'core' | 'full'): string {
  const serverEntry = path.join(repoRoot(), 'dist', 'index.cjs');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Bundled server entry missing at ${serverEntry}. Run npm run build in apps/mcp-server first.`);
  }
  const configPath = path.join(outputDir, `mcp-config-${path.basename(klauroLogPath, '.jsonl')}.json`);
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      klauro: {
        command: process.execPath,
        args: [serverEntry],
        env: { KLAURO_TOOL_CALL_LOG: klauroLogPath, KLAURO_TOOL_PROFILE: toolProfile },
      },
    },
  }, null, 2));
  return configPath;
}

function extractToolCalls(streamJsonLines: string[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const line of streamJsonLines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'assistant') continue;
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        calls.push({ index: calls.length, name: block.name });
      }
    }
  }
  return calls;
}

async function runCondition(
  condition: MeasurementCondition,
  repetition: number,
  targetRepo: string,
  outputDir: string,
  toolProfile: 'core' | 'full'
): Promise<RunResult> {
  const runId = `${condition.id}-rep${repetition}`;
  const klauroLogPath = path.join(outputDir, `${runId}.jsonl`);
  fs.rmSync(klauroLogPath, { force: true });

  const args = [
    '-p', TASK_PROMPT,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'default',
    '--max-budget-usd', '2',
  ];

  const allowedTools = ['Read', 'Grep', 'Glob'];
  if (condition.mcpEnabled) {
    const configPath = writeMcpConfig(outputDir, klauroLogPath, toolProfile);
    args.push('--mcp-config', configPath, '--strict-mcp-config');
    allowedTools.push('mcp__klauro');
  }
  args.push('--allowedTools', ...allowedTools);

  const claudeMdPath = path.join(targetRepo, 'CLAUDE.md');
  const claudeMdBackupPath = `${claudeMdPath}.adoption-measurement-backup`;
  let wroteClaudeMd = false;
  let backedUpClaudeMd = false;
  if (condition.workspaceInstructions) {
    if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, 'utf8');
      if (existing !== OPERATING_LOOP_INSTRUCTIONS) {
        fs.copyFileSync(claudeMdPath, claudeMdBackupPath);
        backedUpClaudeMd = true;
      }
    }
    fs.writeFileSync(claudeMdPath, OPERATING_LOOP_INSTRUCTIONS);
    wroteClaudeMd = true;
  }

  const startedAt = Date.now();
  const stdoutLines: string[] = [];
  let timedOut = false;

  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn('claude', args, {
        cwd: targetRepo,
        env: { ...process.env, CLAUDECODE: undefined as any },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        stdoutLines.push(...lines.filter(line => line.trim().length > 0));
      });
      child.stderr.on('data', () => {});

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, RUN_TIMEOUT_MS);

      child.on('close', (code) => {
        if (buffer.trim()) stdoutLines.push(buffer);
        clearTimeout(timer);
        resolve(code);
      });
    });

    fs.writeFileSync(path.join(outputDir, `${runId}.stream.jsonl`), `${stdoutLines.join('\n')}\n`);

    const toolCalls = extractToolCalls(stdoutLines);
    const klauroToolCalls = toolCalls.filter(call => call.name.startsWith('mcp__klauro__'));
    const klauroServerLog = fs.existsSync(klauroLogPath)
      ? fs.readFileSync(klauroLogPath, 'utf8').trim().split('\n').filter(Boolean).map(line => {
          try {
            return JSON.parse(line).tool as string;
          } catch {
            return line;
          }
        })
      : [];

    let numTurns: number | null = null;
    let totalCostUsd: number | null = null;
    let isError = false;
    let resultPreview = '';
    for (const line of stdoutLines) {
      try {
        const event = JSON.parse(line);
        if (event?.type === 'result') {
          numTurns = event.num_turns ?? null;
          totalCostUsd = event.total_cost_usd ?? null;
          isError = Boolean(event.is_error);
          resultPreview = typeof event.result === 'string' ? event.result.slice(0, 400) : '';
        }
      } catch {
        continue;
      }
    }

    return {
      condition: condition.id,
      repetition,
      durationMs: Date.now() - startedAt,
      timedOut,
      exitCode,
      toolCalls,
      klauroToolCalls,
      firstKlauroToolIndex: klauroToolCalls.length > 0 ? klauroToolCalls[0].index : null,
      klauroServerLog,
      numTurns,
      totalCostUsd,
      isError,
      resultPreview,
    };
  } finally {
    if (wroteClaudeMd) fs.rmSync(claudeMdPath, { force: true });
    if (backedUpClaudeMd) {
      fs.copyFileSync(claudeMdBackupPath, claudeMdPath);
      fs.rmSync(claudeMdBackupPath, { force: true });
    }
  }
}

function formatTable(results: RunResult[]): string {
  const rows = results.map(result => {
    const klauroNames = result.klauroToolCalls.map(call => call.name.replace('mcp__klauro__', ''));
    return [
      `${result.condition} rep${result.repetition}`,
      String(result.toolCalls.length),
      String(result.klauroToolCalls.length),
      result.firstKlauroToolIndex === null ? '-' : String(result.firstKlauroToolIndex),
      `${Math.round(result.durationMs / 1000)}s${result.timedOut ? ' (timeout)' : ''}`,
      klauroNames.slice(0, 6).join(', ') || '-',
    ];
  });
  const header = ['run', 'tool calls', 'klauro calls', 'first klauro idx', 'duration', 'klauro tools used'];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
  const renderRow = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column])).join('  ');
  return [renderRow(header), renderRow(widths.map(width => '-'.repeat(width))), ...rows.map(renderRow)].join('\n');
}

async function main(): Promise<void> {
  const { targetRepo, outputDir, conditions, repetitions, toolProfile } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outputDir, { recursive: true });

  const results: RunResult[] = [];
  for (const condition of CONDITIONS) {
    if (!conditions.has(condition.id)) continue;
    const repetitionRuns: Array<Promise<RunResult>> = [];
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      if (condition.workspaceInstructions) {
        repetitionRuns.push(repetitionRuns.length === 0
          ? runCondition(condition, repetition, targetRepo, outputDir, toolProfile)
          : repetitionRuns[repetitionRuns.length - 1].then(() => runCondition(condition, repetition, targetRepo, outputDir, toolProfile)));
      } else {
        repetitionRuns.push(runCondition(condition, repetition, targetRepo, outputDir, toolProfile));
      }
    }
    try {
      const conditionResults = await Promise.all(repetitionRuns);
      results.push(...conditionResults);
      process.stdout.write(`Completed condition ${condition.id}\n`);
    } catch (error) {
      process.stderr.write(`Condition ${condition.id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify(results, null, 2));
  process.stdout.write(`\n${formatTable(results)}\n\nResults written to ${path.join(outputDir, 'results.json')}\n`);
}

main().catch((error) => {
  process.stderr.write(`agent-adoption-measurement failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
