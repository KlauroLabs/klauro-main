import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

interface AnalysisNode {
  id?: string;
  name?: string;
  file?: string;
  source?: { file?: string };
  type?: string;
}

interface AnalysisPayload {
  nodes?: AnalysisNode[];
}

export interface WorkflowTarget {
  nodeId: string;
  target: string;
  file: string;
}

export interface WorkflowCall {
  name: keyof AgentWorkflowPayloads;
  arguments: Record<string, unknown>;
}

export interface AgentWorkflowPayloads {
  resolve_agent_analysis: Record<string, unknown>;
  get_agent_start_context: Record<string, unknown>;
  get_agent_tool_plan: Record<string, unknown>;
  get_agent_context: Record<string, unknown>;
  get_coding_context: Record<string, unknown>;
}

export interface WorkflowTranscriptEntry {
  sequence: number;
  tool: string;
  arguments: Record<string, unknown>;
  started_at: string;
  elapsed_ms: number;
  response: Record<string, unknown>;
}

const preferredTargetTypes = new Set([
  'route',
  'endpoint',
  'controller',
  'function',
  'method',
  'service',
  'component',
  'class',
]);

export function selectAnalysisTarget(cas: AnalysisPayload, repo: string): WorkflowTarget {
  const candidates = Array.isArray(cas.nodes)
    ? cas.nodes.filter(node => typeof node.id === 'string' && sourceFile(node).length > 0)
    : [];
  const selected = candidates.find(node => preferredTargetTypes.has(String(node.type || '').toLowerCase()))
    || candidates.find(node => !/(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)/i.test(sourceFile(node)))
    || candidates[0];
  if (!selected?.id) throw new Error('Remote analysis produced no source-backed node for the MCP workflow');
  const selectedFile = sourceFile(selected);
  const relativeFile = selectedFile.startsWith(repo)
    ? selectedFile.slice(repo.length).replace(/^[/\\]+/, '')
    : selectedFile;
  return {
    nodeId: selected.id,
    target: selected.id,
    file: relativeFile || selectedFile,
  };
}

function sourceFile(node: AnalysisNode): string {
  return typeof node.file === 'string' ? node.file : typeof node.source?.file === 'string' ? node.source.file : '';
}

export function selectedWorkflowPath(payload: Record<string, unknown>, requestedPath: string): string {
  const selectedPath = payload.selected_path;
  if (typeof selectedPath !== 'string' || selectedPath.trim().length === 0) {
    throw new Error('resolve_agent_analysis returned no selected_path');
  }
  return requireContainedPath(requestedPath, selectedPath, 'resolve_agent_analysis selected path');
}

export function resolveIncrementalTarget(repo: string, sourceFilePath: string): string {
  if (!sourceFilePath.trim()) throw new Error('Incremental target has no source file');
  const candidate = path.isAbsolute(sourceFilePath)
    ? path.resolve(sourceFilePath)
    : path.resolve(repo, sourceFilePath);
  return requireContainedPath(repo, candidate, 'incremental target');
}

function requireContainedPath(rootPath: string, candidatePath: string, label: string): string {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the supplied repository: ${candidatePath}`);
  }
  return candidatePath;
}

export function agentWorkflowFollowUps(
  selectedPath: string,
  task: Record<string, unknown>,
  target: WorkflowTarget,
): WorkflowCall[] {
  return [
    { name: 'get_agent_start_context', arguments: { path: selectedPath, task } },
    { name: 'get_agent_tool_plan', arguments: { path: selectedPath, task } },
    { name: 'get_agent_context', arguments: { path: selectedPath, task } },
    { name: 'get_coding_context', arguments: { path: selectedPath, target: target.target, task_type: 'modify' } },
  ];
}

export function validateArtifactBuildIdentity(
  stamp: Record<string, unknown>,
  packageVersion: string,
  expectedSha?: string | null,
): void {
  if (stamp.version !== packageVersion) {
    throw new Error(`Customer artifact version ${String(stamp.version)} does not match package ${packageVersion}`);
  }
  const gitSha = typeof stamp.git_sha === 'string' ? stamp.git_sha : '';
  if (!gitSha || /dirty|unknown/i.test(gitSha)) throw new Error(`Customer artifact has invalid build identity: ${gitSha || 'missing'}`);
  if (expectedSha) {
    if (!/^[0-9a-f]{40}$/i.test(expectedSha)) throw new Error('Expected release SHA must be a full 40-character Git SHA');
    if (gitSha !== expectedSha) throw new Error(`Customer artifact SHA ${gitSha} does not match expected release SHA ${expectedSha}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned no structured object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an explicitly represented array`);
}

export function validateAgentWorkflow(
  payloads: AgentWorkflowPayloads,
  requestedPath: string,
  target: WorkflowTarget,
): { selectedPath: string } {
  const resolution = requireRecord(payloads.resolve_agent_analysis, 'resolve_agent_analysis');
  const selectedPath = selectedWorkflowPath(resolution, requestedPath);
  const start = requireRecord(payloads.get_agent_start_context, 'get_agent_start_context');
  const plan = requireRecord(payloads.get_agent_tool_plan, 'get_agent_tool_plan');
  const context = requireRecord(payloads.get_agent_context, 'get_agent_context');
  const coding = requireRecord(payloads.get_coding_context, 'get_coding_context');

  if (!start.system || typeof start.system !== 'object') throw new Error('get_agent_start_context returned no system context');
  const readiness = requireRecord(start.readiness, 'get_agent_start_context.readiness');
  if (readiness.agent_context_ready !== true) throw new Error('get_agent_start_context did not report agent context ready');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) throw new Error('get_agent_tool_plan returned no ordered steps');

  const selected = requireRecord(context.selected_node, 'get_agent_context.selected_node');
  const selectedId = typeof selected.id === 'string' ? selected.id : '';
  const selectedFile = typeof selected.file === 'string' ? selected.file : '';
  if (selectedId !== target.nodeId && selectedFile !== target.file) {
    throw new Error(`get_agent_context selected ${selectedId || selectedFile || 'nothing'}, expected ${target.nodeId} or ${target.file}`);
  }
  requireArray(context.file_read_plan, 'get_agent_context.file_read_plan');
  const workContext = requireRecord(context.work_context, 'get_agent_context.work_context');
  const tests = requireRecord(workContext.tests, 'get_agent_context.work_context.tests');
  requireArray(tests.suites, 'get_agent_context.work_context.tests.suites');
  requireArray(tests.mocks, 'get_agent_context.work_context.tests.mocks');
  requireArray(tests.fixtures, 'get_agent_context.work_context.tests.fixtures');
  const risks = requireRecord(workContext.risk_context, 'get_agent_context.work_context.risk_context');
  requireArray(risks.top_risks, 'get_agent_context.work_context.risk_context.top_risks');
  requireArray(risks.repo_top_risks, 'get_agent_context.work_context.risk_context.repo_top_risks');
  const invariants = requireRecord(workContext.behavioral_invariants, 'get_agent_context.work_context.behavioral_invariants');
  requireArray(invariants.invariants, 'get_agent_context.work_context.behavioral_invariants.invariants');

  const targetNode = requireRecord(coding.target_node, 'get_coding_context.target_node');
  if (targetNode.id !== target.nodeId && targetNode.file !== target.file) {
    throw new Error(`get_coding_context resolved ${String(targetNode.id || targetNode.file || 'nothing')}, expected ${target.nodeId} or ${target.file}`);
  }
  return { selectedPath };
}

export class McpWorkflowSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, {
    resolve: (message: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private buffer = '';
  private stderr = '';
  private nextId = 0;
  readonly transcript: WorkflowTranscriptEntry[] = [];

  constructor(bundlePath: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [bundlePath], { env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on('data', chunk => this.consume(chunk.toString()));
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
    this.child.on('error', error => this.rejectPending(error));
    this.child.on('exit', code => {
      if (this.pending.size > 0) this.rejectPending(new Error(`MCP process exited with code ${String(code)}: ${this.stderr.slice(-500)}`));
    });
  }

  async initialize(): Promise<void> {
    const response = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'klauro-new-user-e2e', version: '1' },
    });
    if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const startedAt = new Date();
    const started = Date.now();
    const response = await this.request('tools/call', { name: tool, arguments: args });
    const text = response?.result?.content?.[0]?.text;
    let payload: Record<string, unknown>;
    try {
      payload = typeof text === 'string' ? JSON.parse(text) : requireRecord(response?.result, tool);
    } catch {
      payload = { text };
    }
    this.transcript.push({
      sequence: this.transcript.length + 1,
      tool,
      arguments: args,
      started_at: startedAt.toISOString(),
      elapsed_ms: Date.now() - started,
      response: payload,
    });
    if (response?.error || response?.result?.isError) {
      throw new Error(response?.error?.message || text || JSON.stringify(response));
    }
    return payload;
  }

  close(): void {
    this.child.kill();
  }

  private request(method: string, params: unknown, timeoutMs = 180_000): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms: ${this.stderr.slice(-500)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
