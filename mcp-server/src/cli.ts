#!/usr/bin/env tsx
import * as path from 'path';
import { analyzeProjectIncremental, getAnalysis } from './analyzer';
import { getAgentBootstrap } from './agent-bootstrap';
import type { AgentTask, AgentTaskType } from './agent-adoption';

interface ParsedArgs {
  command?: string;
  path?: string;
  task: AgentTask;
  json: boolean;
  refresh: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    return;
  }

  if (args.command !== 'agent-start') {
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (!args.path) {
    throw new Error('agent-start requires a project path');
  }

  const projectPath = path.resolve(args.path);
  const cas = await withQuietLogs(args.json, () => loadOrAnalyze(projectPath, args.refresh));
  const bootstrap = getAgentBootstrap(cas, projectPath, args.task);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(bootstrap, null, 2)}\n`);
  } else {
    process.stdout.write(`${bootstrap.prompt}\n`);
  }
}

async function loadOrAnalyze(projectPath: string, refresh: boolean) {
  if (refresh) return (await analyzeProjectIncremental(projectPath)).output;

  try {
    return await getAnalysis(projectPath);
  } catch {
    return (await analyzeProjectIncremental(projectPath)).output;
  }
}

async function withQuietLogs<T>(quiet: boolean, fn: () => Promise<T>): Promise<T> {
  if (!quiet) return fn();
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: argv[0],
    path: undefined,
    task: {},
    json: false,
    refresh: false,
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--refresh') {
      parsed.refresh = true;
    } else if (arg === '--task-type') {
      parsed.task.task_type = argv[++i] as AgentTaskType;
    } else if (arg === '--target') {
      parsed.task.target = argv[++i];
    } else if (!parsed.path) {
      parsed.path = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write([
    'Usage:',
    '  unravl agent-start /path/to/repo [--task-type orient|modify|debug|review|trace|cross-repo|runtime] [--target query] [--json] [--refresh]',
    '',
    'Examples:',
    '  unravl agent-start .',
    '  unravl agent-start ~/dev/unravl/proof-of-concept --task-type debug --target auth',
    '  npm run agent-start -- . --json',
  ].join('\n') + '\n');
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
