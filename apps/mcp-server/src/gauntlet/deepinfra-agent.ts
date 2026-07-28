/**
 * #96 DeepInfra-backed CODING-AGENT RUNNER.
 *
 * A self-contained coding agent that runs entirely on DeepInfra (an
 * OpenAI-compatible endpoint) so the live agent-vs-agent trials can run WITHOUT
 * an external agent CLI (no authed `claude`/`codex` needed). It is designed to
 * be dropped into the existing gauntlet harnesses as the injected/autonomous
 * runner command:
 *
 *   BASELINE / injected (no --mcp-config): a plain DeepInfra chat loop with a
 *     small filesystem tool set (read_file / write_file / list_dir) sandboxed to
 *     the workspace. The model edits files by calling write_file.
 *
 *   AUTONOMOUS (--mcp-config <f>): ALSO exposes the Klauro MCP tools so the model
 *     can autonomously gather codebase context before editing. It connects to the
 *     Klauro stdio MCP server described in the .mcp.json via the MCP SDK
 *     (@modelcontextprotocol/sdk). If the SDK is unavailable or the server fails
 *     to start, it FALLS BACK to a single HTTP-backed `klauro_analyze` tool that
 *     posts a source snapshot to the DEPLOYED analyzer (KLAURO_ANALYZER_URL /
 *     KLAURO_ANALYZER_TOKEN) and returns a compact CAS summary.
 *
 * CLI:
 *   tsx src/gauntlet/deepinfra-agent.ts --prompt-file <f> --workspace <dir> \
 *       --result-file <f> [--mcp-config <f>] [--model <id>] [--max-iters N]
 *
 * Result JSON written to --result-file:
 *   { summary, files_changed: string[], provider_total_tokens, klauro_tool_calls }
 *
 * Everything the harness needs (token count, files_changed) is derived from that
 * JSON by the default runner in autonomous-mcp-trial.ts.
 *
 * The DeepInfra client and MCP connector are INJECTABLE so the unit test drives
 * the whole runner with NO network.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION } from '../remote-analyzer-protocol';

export const DEFAULT_DEEPINFRA_BASE_URL = 'https://api.deepinfra.com/v1/openai';
/** Tool-calling-capable DeepInfra model (matches the analyzer-core default). */
// A real, tool-calling-capable DeepInfra model id (verified against the models API).
export const DEFAULT_DEEPINFRA_AGENT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

const SYSTEM_PROMPT =
  'You are a coding agent. Complete the task by editing files under the workspace. ' +
  'When done, output a short summary.';

// ---------------------------------------------------------------------------
// OpenAI-compatible chat types (minimal — we only use what we need).
// ---------------------------------------------------------------------------

export interface ChatToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatTool {
  type: 'function';
  function: ChatToolFunction;
}

export interface ChatToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'none';
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  choices: Array<{
    message: ChatMessage;
    finish_reason?: string;
  }>;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}

/** Pluggable chat client. The default calls DeepInfra; tests inject a fake. */
export type ChatClient = (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;

/** A tool the model can call. Handlers return a string result. */
export interface AgentTool {
  spec: ChatTool;
  handler: (args: Record<string, unknown>) => Promise<string>;
  /** True for Klauro-provided tools (MCP or HTTP fallback), for call counting. */
  isKlauro?: boolean;
}

// ---------------------------------------------------------------------------
// Default DeepInfra chat client (raw fetch — no dependency on the `openai` pkg,
// which is not resolvable from the mcp-server workspace).
// ---------------------------------------------------------------------------

export function createDeepInfraChatClient(opts: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}): ChatClient {
  const baseUrl = (opts.baseUrl || DEFAULT_DEEPINFRA_BASE_URL).replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`DeepInfra chat failed (${response.status}): ${body.slice(0, 500)}`);
      }
      return (await response.json()) as ChatCompletionResponse;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Workspace-sandboxed filesystem tools.
// ---------------------------------------------------------------------------

/** Resolve a possibly-relative path and ensure it stays under the workspace. */
export function resolveInWorkspace(workspace: string, target: string): string {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, target);
  const rel = path.relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${target}`);
  }
  return resolved;
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`missing/invalid "${key}"`);
  return value;
}

export function createFilesystemTools(workspace: string, changed: Set<string>): AgentTool[] {
  const readFile: AgentTool = {
    spec: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a UTF-8 text file relative to the workspace root.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
          required: ['path'],
        },
      },
    },
    handler: async (args) => {
      const rel = argString(args, 'path');
      const abs = resolveInWorkspace(workspace, rel);
      try {
        const content = await fsp.readFile(abs, 'utf8');
        return content.length > 20_000 ? `${content.slice(0, 20_000)}\n...[truncated]` : content;
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };

  const writeFile: AgentTool = {
    spec: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write (create or overwrite) a UTF-8 text file relative to the workspace root.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
            content: { type: 'string', description: 'Full file contents to write.' },
          },
          required: ['path', 'content'],
        },
      },
    },
    handler: async (args) => {
      const rel = argString(args, 'path');
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
      const abs = resolveInWorkspace(workspace, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
      changed.add(path.relative(path.resolve(workspace), abs));
      return `wrote ${rel} (${content.length} bytes)`;
    },
  };

  const listDir: AgentTool = {
    spec: {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List entries of a directory relative to the workspace root.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Workspace-relative directory path (default ".").' } },
          required: [],
        },
      },
    },
    handler: async (args) => {
      const rel = typeof args.path === 'string' && args.path ? args.path : '.';
      const abs = resolveInWorkspace(workspace, rel);
      try {
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        return entries
          .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git')
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .join('\n') || '(empty)';
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };

  return [readFile, writeFile, listDir];
}

// ---------------------------------------------------------------------------
// Klauro tools — MCP SDK (primary) or HTTP fallback.
// ---------------------------------------------------------------------------

interface McpJsonServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpJson {
  mcpServers?: Record<string, McpJsonServer>;
}

/** A connected Klauro tool provider that can be closed. */
export interface KlauroToolProvider {
  tools: AgentTool[];
  close: () => Promise<void>;
  transport: 'mcp' | 'http' | 'none';
}

/** Injection seam for tests: build Klauro tools without spawning anything. */
export type KlauroConnector = (mcpConfigPath: string) => Promise<KlauroToolProvider>;

function readMcpConfig(mcpConfigPath: string): { server?: McpJsonServer; name: string } {
  const raw = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) as McpJson;
  const servers = raw.mcpServers || {};
  const name = Object.keys(servers)[0] || 'klauro';
  return { server: servers[name], name };
}

/** JSON-schema-ish object with a fallback for MCP tools that omit a schema. */
function toolParameters(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema && typeof inputSchema === 'object') return inputSchema as Record<string, unknown>;
  return { type: 'object', properties: {} };
}

/**
 * Default Klauro connector: spawn the stdio MCP server from the .mcp.json using
 * @modelcontextprotocol/sdk, list its tools, and expose each as an AgentTool. If
 * the SDK import or connection fails, fall back to an HTTP `klauro_analyze` tool.
 */
export function createDefaultKlauroConnector(): KlauroConnector {
  return async (mcpConfigPath: string): Promise<KlauroToolProvider> => {
    const { server } = readMcpConfig(mcpConfigPath);
    if (server && server.command) {
      try {
        return await connectViaMcpSdk(server);
      } catch (error) {
        process.stderr.write(
          `[deepinfra-agent] MCP SDK connect failed, falling back to HTTP: ${
            error instanceof Error ? error.message : String(error)
          }\n`
        );
      }
    }
    return connectViaHttp(server);
  };
}

async function connectViaMcpSdk(server: McpJsonServer): Promise<KlauroToolProvider> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args || [],
    env: { ...process.env, ...(server.env || {}) } as Record<string, string>,
  });
  const client = new Client({ name: 'deepinfra-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const listed = await client.listTools();
  const tools: AgentTool[] = (listed.tools || []).map((tool: any) => ({
    isKlauro: true,
    spec: {
      type: 'function',
      function: {
        name: tool.name,
        description: (tool.description || `Klauro MCP tool ${tool.name}`).slice(0, 1000),
        parameters: toolParameters(tool.inputSchema),
      },
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const result: any = await client.callTool({ name: tool.name, arguments: args });
        const parts = Array.isArray(result?.content) ? result.content : [];
        const text = parts
          .map((part: any) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part)))
          .join('\n');
        return (text || JSON.stringify(result)).slice(0, 20_000);
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  }));
  return {
    tools,
    transport: 'mcp',
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

/**
 * HTTP fallback: a single `klauro_analyze` tool that snapshots the given repo
 * path and posts it to the deployed analyzer, returning a compact CAS summary.
 * Uses the analyzer URL/token from the .mcp.json server env.
 */
function connectViaHttp(server?: McpJsonServer): KlauroToolProvider {
  const env = server?.env || {};
  const url = (env.KLAURO_ANALYZER_URL || env.KLAURO_API_URL || process.env.KLAURO_ANALYZER_URL || '').replace(/\/$/, '');
  const token = env.KLAURO_ANALYZER_TOKEN || env.KLAURO_ACCOUNT_TOKEN || process.env.KLAURO_ANALYZER_TOKEN;

  const analyze: AgentTool = {
    isKlauro: true,
    spec: {
      type: 'function',
      function: {
        name: 'klauro_analyze',
        description:
          'Analyze a repository with Klauro and return a compact codebase-analysis (CAS) summary: ' +
          'top entities, domains, and flows. Call once to orient before editing.',
        parameters: {
          type: 'object',
          properties: { repoPath: { type: 'string', description: 'Absolute path to the repo to analyze.' } },
          required: ['repoPath'],
        },
      },
    },
    handler: async (args) => {
      if (!url) return 'error: no KLAURO_ANALYZER_URL configured for HTTP fallback';
      const repoPath = argString(args, 'repoPath');
      try {
        const { buildSourceSnapshot } = await import('../remote-source');
        const snapshot = await buildSourceSnapshot(repoPath);
        const response = await fetch(`${url}/v1/analyze`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            protocol_version: REMOTE_ANALYSIS_PROTOCOL_VERSION,
            project_id: (snapshot as any).project_name || path.basename(repoPath),
            project_path: repoPath,
            snapshot,
            async: true,
          }),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return `error: analyzer returned ${response.status}: ${body.slice(0, 300)}`;
        }
        const data: any = await response.json();
        return summarizeCas(data).slice(0, 20_000);
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
  return { tools: [analyze], transport: 'http', close: async () => undefined };
}

function summarizeCas(response: any): string {
  const cas = response?.cas || response;
  const entities = Array.isArray(cas?.entities) ? cas.entities : [];
  const domains = Array.isArray(cas?.domains) ? cas.domains : [];
  const flows = Array.isArray(cas?.flows) ? cas.flows : [];
  const topEntities = entities.slice(0, 15).map((entity: any) => entity?.name || entity?.id).filter(Boolean);
  const topDomains = domains.slice(0, 10).map((domain: any) => domain?.name || domain?.label).filter(Boolean);
  return [
    `project: ${cas?.project_name || cas?.name || 'unknown'}`,
    `entities (${entities.length}): ${topEntities.join(', ') || '(none)'}`,
    `domains (${domains.length}): ${topDomains.join(', ') || '(none)'}`,
    `flows: ${flows.length}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Agent loop.
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  chat: ChatClient;
  workspace: string;
  taskPrompt: string;
  tools: AgentTool[];
  model: string;
  maxIters: number;
}

export interface RunAgentResult {
  summary: string;
  filesChanged: string[];
  providerTotalTokens: number;
  klauroToolCalls: number;
  iterations: number;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runAgentLoop(opts: RunAgentOptions, changed: Set<string>): Promise<RunAgentResult> {
  const toolByName = new Map(opts.tools.map((tool) => [tool.spec.function.name, tool]));
  const toolSpecs = opts.tools.map((tool) => tool.spec);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: opts.taskPrompt },
  ];

  let providerTotalTokens = 0;
  let klauroToolCalls = 0;
  let summary = '';
  let iterations = 0;

  for (let i = 0; i < opts.maxIters; i++) {
    iterations = i + 1;
    const response = await opts.chat({
      model: opts.model,
      messages,
      tools: toolSpecs,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 2048,
    });
    providerTotalTokens += response.usage?.total_tokens || 0;

    const choice = response.choices?.[0];
    const message = choice?.message;
    if (!message) break;

    const toolCalls = message.tool_calls || [];
    // Record the assistant turn (content may be null when it's a pure tool call).
    messages.push({
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: toolCalls.length ? toolCalls : undefined,
    });

    if (message.content && message.content.trim()) summary = message.content.trim();

    if (!toolCalls.length) break; // model is done

    for (const call of toolCalls) {
      const name = call.function?.name;
      const tool = name ? toolByName.get(name) : undefined;
      let result: string;
      if (!tool) {
        result = `error: unknown tool "${name}"`;
      } else {
        if (tool.isKlauro) klauroToolCalls++;
        try {
          result = await tool.handler(safeParseArgs(call.function.arguments || ''));
        } catch (error) {
          result = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: result,
      });
    }
  }

  return {
    summary: summary || '(no summary produced)',
    filesChanged: Array.from(changed).sort(),
    providerTotalTokens,
    klauroToolCalls,
    iterations,
  };
}

// ---------------------------------------------------------------------------
// Orchestration: wire tools, run the loop, write the result file.
// ---------------------------------------------------------------------------

export interface DeepInfraAgentOptions {
  promptFile: string;
  workspace: string;
  resultFile: string;
  mcpConfig?: string;
  model?: string;
  maxIters?: number;
  timeoutMs?: number;
  /** Injected chat client (tests). Defaults to a DeepInfra fetch client. */
  chat?: ChatClient;
  /** Injected Klauro connector (tests). Defaults to MCP-SDK-with-HTTP-fallback. */
  klauroConnector?: KlauroConnector;
}

export interface DeepInfraAgentResultFile {
  summary: string;
  files_changed: string[];
  provider_total_tokens: number;
  klauro_tool_calls: number;
  klauro_transport?: 'mcp' | 'http' | 'none';
  iterations?: number;
}

export async function runDeepInfraAgent(opts: DeepInfraAgentOptions): Promise<DeepInfraAgentResultFile> {
  const workspace = path.resolve(opts.workspace);
  if (!fs.existsSync(workspace)) throw new Error(`workspace does not exist: ${workspace}`);
  const taskPrompt = await fsp.readFile(opts.promptFile, 'utf8');
  const model = opts.model || process.env.DEEPINFRA_AGENT_MODEL || DEFAULT_DEEPINFRA_AGENT_MODEL;
  const maxIters = Math.max(1, opts.maxIters ?? 8);

  const chat =
    opts.chat ||
    createDeepInfraChatClient({
      apiKey: requireEnv('DEEPINFRA_API_KEY'),
      baseUrl: process.env.DEEPINFRA_BASE_URL,
      timeoutMs: opts.timeoutMs,
    });

  const changed = new Set<string>();
  const tools = createFilesystemTools(workspace, changed);

  let klauro: KlauroToolProvider | undefined;
  if (opts.mcpConfig) {
    const connector = opts.klauroConnector || createDefaultKlauroConnector();
    try {
      klauro = await connector(opts.mcpConfig);
      tools.push(...klauro.tools);
    } catch (error) {
      process.stderr.write(
        `[deepinfra-agent] Klauro tools unavailable: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  let loopResult: RunAgentResult;
  try {
    loopResult = await runAgentLoop({ chat, workspace, taskPrompt, tools, model, maxIters }, changed);
  } finally {
    if (klauro) await klauro.close().catch(() => undefined);
  }

  const result: DeepInfraAgentResultFile = {
    summary: loopResult.summary,
    files_changed: loopResult.filesChanged,
    provider_total_tokens: loopResult.providerTotalTokens,
    klauro_tool_calls: loopResult.klauroToolCalls,
    klauro_transport: klauro?.transport,
    iterations: loopResult.iterations,
  };
  await fsp.mkdir(path.dirname(path.resolve(opts.resultFile)), { recursive: true });
  await fsp.writeFile(opts.resultFile, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (set it in .env)`);
  return value;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): {
  promptFile?: string;
  workspace?: string;
  resultFile?: string;
  mcpConfig?: string;
  model?: string;
  maxIters?: number;
} {
  const out: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--prompt-file') out.promptFile = argv[++i];
    else if (arg === '--workspace') out.workspace = argv[++i];
    else if (arg === '--result-file') out.resultFile = argv[++i];
    else if (arg === '--mcp-config') out.mcpConfig = argv[++i];
    else if (arg === '--model') out.model = argv[++i];
    else if (arg === '--max-iters') out.maxIters = Number(argv[++i]);
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(
    [
      'DeepInfra coding-agent runner (#96 live trials without an external agent CLI).',
      '',
      'Usage:',
      '  tsx src/gauntlet/deepinfra-agent.ts --prompt-file <f> --workspace <dir> \\',
      '      --result-file <f> [--mcp-config <f>] [--model <id>] [--max-iters N]',
      '',
      'Env: DEEPINFRA_API_KEY (required), DEEPINFRA_BASE_URL, DEEPINFRA_AGENT_MODEL.',
      `Default model: ${DEFAULT_DEEPINFRA_AGENT_MODEL}.`,
      'With --mcp-config it also exposes the Klauro MCP tools (autonomous mode).',
      '',
    ].join('\n')
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.promptFile || !args.workspace || !args.resultFile) {
    printUsage();
    process.exit(args.promptFile || args.workspace || args.resultFile ? 1 : 0);
  }
  const hardTimeout = setTimeout(() => {
    process.stderr.write('[deepinfra-agent] hard timeout — exiting\n');
    process.exit(1);
  }, 20 * 60 * 1000);
  hardTimeout.unref();

  const result = await runDeepInfraAgent({
    promptFile: args.promptFile!,
    workspace: args.workspace!,
    resultFile: args.resultFile!,
    mcpConfig: args.mcpConfig,
    model: args.model,
    maxIters: args.maxIters,
  });
  clearTimeout(hardTimeout);

  const tail = [
    `summary: ${result.summary.slice(0, 400)}`,
    `files_changed: ${result.files_changed.join(', ') || '(none)'}`,
    `provider_total_tokens: ${result.provider_total_tokens}`,
    `klauro_tool_calls: ${result.klauro_tool_calls}${result.klauro_transport ? ` (${result.klauro_transport})` : ''}`,
  ].join('\n');
  process.stdout.write(`${tail}\n`);
}

const invokedName = process.argv[1]
  ? path.basename(process.argv[1]).replace(/\.(mts|cts|tsx|ts|mjs|cjs|jsx|js)$/, '')
  : '';
if (invokedName === 'deepinfra-agent') {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
