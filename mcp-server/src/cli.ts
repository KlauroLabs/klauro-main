#!/usr/bin/env tsx
import * as path from 'path';
import { analyzeProjectIncremental, getAnalysis } from './analyzer';
import { getAgentBootstrap } from './agent-bootstrap';
import { writeAgentDefaultConfig } from './agent-defaults';
import { getAgentDoctor } from './agent-doctor';
import { buildCASGoldenSnapshot } from './cas-contract';
import { saveGoldenSnapshot } from './storage';
import { getAgentWorkPacket } from './agent-adoption';
import type { AgentTask, AgentTaskType } from './agent-adoption';

interface ParsedArgs {
  command?: string;
  path?: string;
  task: AgentTask;
  json: boolean;
  refresh: boolean;
  compact: boolean;
  quiet: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    return;
  }

  if (!['agent-start', 'agent-work-packet', 'agent-install', 'doctor', 'save-golden'].includes(args.command)) {
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (!args.path) throw new Error(`${args.command} requires a project path`);

  const projectPath = path.resolve(args.path);
  const cas = await withLogHandling(args.json, args.quiet, () => loadOrAnalyze(projectPath, args.refresh));

  if (args.command === 'agent-start') {
    const bootstrap = getAgentBootstrap(cas, projectPath, args.task);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(bootstrap, null, 2)}\n`);
    } else {
      process.stdout.write(`${bootstrap.prompt}\n`);
    }
    return;
  }

  if (args.command === 'agent-work-packet') {
    const packet = getAgentWorkPacket(cas, projectPath, args.task);
    const output = args.compact ? compactWorkPacket(packet) : packet;
    process.stdout.write(args.json ? `${JSON.stringify(output, null, 2)}\n` : formatWorkPacket(packet));
    return;
  }

  if (args.command === 'doctor') {
    const doctor = await getAgentDoctor(cas, projectPath);
    process.stdout.write(args.json ? `${JSON.stringify(doctor, null, 2)}\n` : formatDoctor(doctor));
    return;
  }

  if (args.command === 'agent-install') {
    const config = await writeAgentDefaultConfig(cas, projectPath, args.task);
    process.stdout.write(args.json ? `${JSON.stringify(config, null, 2)}\n` : `Installed Unravl agent defaults: ${config.install?.markdown_file}\n`);
    return;
  }

  if (args.command === 'save-golden') {
    const snapshot = buildCASGoldenSnapshot(cas);
    const saved = await saveGoldenSnapshot(projectPath, snapshot);
    const output = { saved, snapshot };
    process.stdout.write(args.json ? `${JSON.stringify(output, null, 2)}\n` : `Saved CAS golden snapshot: ${saved.file}\n`);
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

async function withLogHandling<T>(json: boolean, quiet: boolean, fn: () => Promise<T>): Promise<T> {
  if (!json && !quiet) return fn();
  const originalLog = console.log;
  console.log = quiet ? () => undefined : (...args: unknown[]) => console.error(...args);
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
    compact: false,
    quiet: false,
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--refresh') {
      parsed.refresh = true;
    } else if (arg === '--compact') {
      parsed.compact = true;
    } else if (arg === '--quiet') {
      parsed.quiet = true;
    } else if (arg === '--task-type') {
      parsed.task.task_type = argv[++i] as AgentTaskType;
    } else if (arg === '--target') {
      parsed.task.target = argv[++i];
    } else if (arg === '--instructions') {
      parsed.task.instructions = argv[++i];
    } else if (arg === '--success-criterion') {
      parsed.task.success_criteria = [...(parsed.task.success_criteria || []), argv[++i]];
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
    '  unravl agent-work-packet /path/to/repo [--task-type orient|modify|debug|review|trace|cross-repo|runtime] [--target query] [--instructions text] [--success-criterion text] [--json] [--compact] [--quiet] [--refresh]',
    '  unravl agent-install /path/to/repo [--task-type orient|modify|debug|review|trace|cross-repo|runtime] [--target query] [--json] [--refresh]',
    '  unravl doctor /path/to/repo [--json] [--refresh]',
    '  unravl save-golden /path/to/repo [--json] [--refresh]',
    '',
    'Examples:',
    '  unravl agent-start .',
    '  unravl agent-work-packet . --task-type modify --target auth --json',
    '  unravl agent-install .',
    '  unravl doctor .',
    '  unravl save-golden .',
    '  unravl agent-start ~/dev/unravl/proof-of-concept --task-type debug --target auth',
    '  npm run agent-start -- . --json',
    '  npm run agent-install -- .',
  ].join('\n') + '\n');
}

function compactWorkPacket(packet: Awaited<ReturnType<typeof getAgentWorkPacket>>) {
  const context = packet.work_context as any;
  return {
    path: packet.path,
    generated_at: packet.generated_at,
    task: packet.task,
    status: packet.status,
    default_use: packet.default_use,
    readiness: packet.readiness,
    selected_node: packet.selected_node,
    target_gaps: (packet.target_resolution as any)?.gaps || [],
    file_read_plan: packet.file_read_plan.slice(0, 12).map((item: any) => ({
      file: item.file,
      reason: item.reason,
      line: item.line,
      node_ids: Array.isArray(item.node_ids) ? item.node_ids.slice(0, 8) : item.node_ids,
    })),
    risk: context.risk ? {
      level: context.risk.level,
      score: context.risk.score,
      reasons: context.risk.reasons || context.risk.factors || context.risk.details,
    } : null,
    tests: summarizeTests(context.tests),
    behavioral_invariants: context.behavioral_invariants ? {
      total: context.behavioral_invariants.total,
      invariants: context.behavioral_invariants.invariants?.slice(0, 8),
    } : null,
    validation_plan: (packet as any).validation_plan,
    next_mcp_calls: packet.next_mcp_calls.slice(0, 6).map((step: any) => ({
      tool: step.tool,
      purpose: step.purpose,
      required: step.required,
      args: step.args,
    })),
    source_reading_rule: packet.source_reading_rule,
    gaps: packet.gaps,
  };
}

function summarizeTests(tests: any) {
  if (!tests) return null;
  if (Array.isArray(tests)) return tests.slice(0, 10);
  return {
    status: tests.status,
    total: tests.total ?? tests.total_tests ?? tests.tests?.length,
    tests: Array.isArray(tests.tests) ? tests.tests.slice(0, 10) : undefined,
    suites: Array.isArray(tests.suites) ? tests.suites.slice(0, 10) : undefined,
    resolution: tests.resolution,
    gaps: tests.gaps,
  };
}

function formatWorkPacket(packet: Awaited<ReturnType<typeof getAgentWorkPacket>>): string {
  const selected = packet.selected_node
    ? `${packet.selected_node.name || packet.selected_node.id} (${packet.selected_node.file || 'unknown file'})`
    : 'none';
  const lines = [
    `Unravl work packet: ${packet.status.toUpperCase()}`,
    `Default use: ${packet.default_use ? 'yes' : 'no'}`,
    `Path: ${packet.path}`,
    `Task: ${packet.task.task_type || 'orient'}${packet.task.target ? ` -> ${packet.task.target}` : ''}`,
    `Selected node: ${selected}`,
    '',
    'First files:',
    ...packet.file_read_plan.slice(0, 10).map(item => `- ${item.file}: ${item.reason}`),
    '',
    'Validation:',
    ...(((packet as any).validation_plan?.commands || []).slice(0, 5).map((command: any) => `- ${command.command}: ${command.purpose}`) || ['- none inferred']),
    '',
    'Gaps:',
    ...(packet.gaps.length ? packet.gaps.map(gap => `- ${gap}`) : ['- none']),
  ];
  return `${lines.join('\n')}\n`;
}

function formatDoctor(doctor: Awaited<ReturnType<typeof getAgentDoctor>>): string {
  const lines = [
    `Unravl agent doctor: ${doctor.status.toUpperCase()}`,
    `Default use: ${doctor.default_use ? 'yes' : 'no'}`,
    `Path: ${doctor.path}`,
    '',
    'Checks:',
    ...doctor.checks.map(check => `- ${check.status.toUpperCase()} ${check.id}: ${check.detail}`),
    '',
    'First commands:',
    ...doctor.first_commands.map(command => `- ${command}`),
  ];
  return `${lines.join('\n')}\n`;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
