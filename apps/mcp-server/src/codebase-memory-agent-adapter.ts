#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { isDirectCliInvocation } from './cli-invocation';

interface Args {
  workspace: string;
  promptFile: string;
  metricsFile: string;
  resultFile: string;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface CodebaseMemoryContext {
  project?: string;
  index_status: 'indexed' | 'failed';
  index_ms: number;
  architecture?: unknown;
  search_results: Array<{ query: string; result: unknown }>;
  errors: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompt = await fs.readFile(args.promptFile, 'utf8');
  const context = await buildCodebaseMemoryContext(args.workspace, prompt);
  const contextFile = path.join(path.dirname(args.promptFile), 'codebase-memory-context.json');
  const augmentedPromptFile = path.join(path.dirname(args.promptFile), 'codebase-memory-augmented-prompt.md');
  await fs.writeJson(contextFile, context, { spaces: 2 });
  await fs.writeFile(augmentedPromptFile, buildAugmentedPrompt(prompt, context), 'utf8');

  const startedAt = Date.now();
  const result = runCodex(args.workspace, augmentedPromptFile);
  const durationMs = Date.now() - startedAt;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  const existingMetrics = await readJson(args.metricsFile);
  await fs.writeJson(args.metricsFile, {
    ...(existingMetrics || {}),
    codebase_memory_index_status: context.index_status,
    codebase_memory_index_ms: context.index_ms,
    codebase_memory_project: context.project,
    codebase_memory_search_queries: context.search_results.map(item => item.query),
    codebase_memory_errors: context.errors,
    adapter_duration_ms: durationMs,
  }, { spaces: 2 });

  process.exitCode = result.status;
}

async function buildCodebaseMemoryContext(workspace: string, prompt: string): Promise<CodebaseMemoryContext> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const index = runCodebaseMemory('index_repository', { repo_path: workspace }, 240_000);
  const indexJson = parseLastJson(index.stdout);
  if (index.status !== 0 || !indexJson?.project) {
    errors.push(`index_repository failed: ${compact(`${index.stderr}\n${index.stdout}`, 1200)}`);
    return {
      index_status: 'failed',
      index_ms: Date.now() - startedAt,
      search_results: [],
      errors,
    };
  }

  const project = String(indexJson.project);
  const architecture = parseLastJson(runCodebaseMemory('get_architecture', {
    project,
    aspects: ['all'],
  }, 120_000).stdout);

  const search_results: Array<{ query: string; result: unknown }> = [];
  for (const query of selectSearchQueries(prompt)) {
    const result = runCodebaseMemory('search_code', { project, pattern: query, limit: 8 }, 60_000);
    const parsed = parseLastJson(result.stdout);
    if (parsed) search_results.push({ query, result: shrinkSearchResult(parsed) });
    else if (result.status !== 0) errors.push(`search_code ${query} failed: ${compact(result.stderr || result.stdout, 500)}`);
  }

  return {
    project,
    index_status: 'indexed',
    index_ms: Date.now() - startedAt,
    architecture: shrinkArchitecture(architecture),
    search_results,
    errors,
  };
}

function buildAugmentedPrompt(originalPrompt: string, context: CodebaseMemoryContext): string {
  return [
    originalPrompt,
    '',
    'Codebase-memory context:',
    'Use this installed codebase-memory-mcp index as your starting codebase intelligence. Prefer the files, symbols, hotspots, and search results below before broad exploration. If this context is insufficient, inspect the repo directly.',
    fencedJson(context),
  ].join('\n');
}

function runCodebaseMemory(tool: string, payload: unknown, timeoutMs: number): CommandResult {
  const child = spawnSync('codebase-memory-mcp', ['cli', tool, JSON.stringify(payload)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    status: typeof child.status === 'number' ? child.status : child.error ? 1 : 0,
    stdout: child.stdout || '',
    stderr: child.stderr || (child.error ? child.error.message : ''),
  };
}

function runCodex(workspace: string, promptFile: string): CommandResult {
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const child = spawnSync('codex', [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    workspace,
    '-',
  ], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
    env: process.env,
  });
  return {
    status: typeof child.status === 'number' ? child.status : child.error ? 1 : 0,
    stdout: child.stdout || '',
    stderr: child.stderr || (child.error ? child.error.message : ''),
  };
}

function selectSearchQueries(prompt: string): string[] {
  const candidates = [
    ...Array.from(prompt.matchAll(/target:\s*([^\n]+)/gi)).map(match => match[1]),
    ...Array.from(prompt.matchAll(/Task:\s*([^\n]+)/gi)).map(match => match[1]),
    ...Array.from(prompt.matchAll(/\b([A-Z][A-Za-z0-9]+(?:Service|Repository|Controller|Finder|Policy|Exception|Model|Entity))\b/g)).map(match => match[1]),
    ...Array.from(prompt.matchAll(/\b([a-z][a-z0-9]+(?:Service|Repository|Controller|Finder|Policy|Exception|Model|Entity))\b/g)).map(match => match[1]),
  ];
  const words = candidates.flatMap(value => value.split(/[^A-Za-z0-9_]+/))
    .map(value => value.trim())
    .filter(value => value.length >= 4 && !STOP_WORDS.has(value.toLowerCase()));
  return unique(words).slice(0, 8);
}

function shrinkArchitecture(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const doc = value as any;
  return {
    total_nodes: doc.total_nodes,
    total_edges: doc.total_edges,
    node_labels: arrayLimit(doc.node_labels, 12),
    edge_types: arrayLimit(doc.edge_types, 12),
    languages: arrayLimit(doc.languages, 8),
    packages: arrayLimit(doc.packages, 10),
    hotspots: arrayLimit(doc.hotspots, 12),
    file_tree: arrayLimit(doc.file_tree, 20),
  };
}

function shrinkSearchResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const doc = value as any;
  return {
    results: arrayLimit(doc.results, 8).map((item: any) => ({
      node: item.node,
      label: item.label,
      file: item.file,
      start_line: item.start_line,
      end_line: item.end_line,
      in_degree: item.in_degree,
      out_degree: item.out_degree,
    })),
    directories: doc.directories,
    total_results: doc.total_results,
    elapsed_ms: doc.elapsed_ms,
  };
}

function arrayLimit(value: unknown, limit: number): any[] {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function parseLastJson(text: string): any | undefined {
  for (const line of text.trim().split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
  return undefined;
}

async function readJson(file: string): Promise<any | undefined> {
  try {
    return await fs.readJson(file);
  } catch {
    return undefined;
  }
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function compact(value: string, limit: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}...`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace') args.workspace = path.resolve(argv[++index]);
    else if (arg === '--prompt-file') args.promptFile = path.resolve(argv[++index]);
    else if (arg === '--metrics-file') args.metricsFile = path.resolve(argv[++index]);
    else if (arg === '--result-file') args.resultFile = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx codebase-memory-agent-adapter.ts --workspace DIR --prompt-file PROMPT --metrics-file METRICS --result-file RESULT');
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  for (const key of ['workspace', 'promptFile', 'metricsFile', 'resultFile'] as const) {
    if (!args[key]) throw new Error(`Missing required --${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
  }
  return args as Args;
}

const STOP_WORDS = new Set([
  'this', 'that', 'with', 'when', 'then', 'from', 'into', 'only', 'task', 'repo', 'read',
  'file', 'files', 'edit', 'test', 'tests', 'klauro', 'codebase', 'memory', 'context',
  'required', 'existing', 'service', 'repository', 'controller', 'behavior', 'change',
]);

if (isDirectCliInvocation('codebase-memory-agent-adapter')) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
