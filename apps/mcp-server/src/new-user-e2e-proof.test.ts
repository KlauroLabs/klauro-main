import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  agentWorkflowFollowUps,
  McpWorkflowSession,
  resolveIncrementalTarget,
  selectAnalysisTarget,
  selectedWorkflowPath,
  validateAgentWorkflow,
  validateArtifactBuildIdentity,
} from './new-user-e2e-proof';

test('selectAnalysisTarget prefers a behavioral source-backed node', () => {
  const target = selectAnalysisTarget({
    nodes: [
      { id: 'file-readme', type: 'file', file: 'README.md' },
      { id: 'route-users', type: 'route', source: { file: '/repo/src/users.ts' } },
    ],
  }, '/repo');
  assert.deepEqual(target, { nodeId: 'route-users', target: 'route-users', file: 'src/users.ts' });
});

test('selectedWorkflowPath and incremental targets stay inside the supplied repository', () => {
  assert.throws(() => selectedWorkflowPath({}, '/repo'), /no selected_path/);
  assert.equal(selectedWorkflowPath({ selected_path: '/repo/service' }, '/repo'), '/repo/service');
  assert.throws(() => selectedWorkflowPath({ selected_path: '/other/service' }, '/repo'), /escapes the supplied repository/);
  assert.equal(resolveIncrementalTarget('/repo', 'src/users.ts'), '/repo/src/users.ts');
  assert.throws(() => resolveIncrementalTarget('/repo', '/other/users.ts'), /escapes the supplied repository/);
  assert.throws(() => resolveIncrementalTarget('/repo', '../other/users.ts'), /escapes the supplied repository/);
});

test('artifact build identity is exact and source bound when an expected SHA is supplied', () => {
  const sha = 'a'.repeat(40);
  assert.doesNotThrow(() => validateArtifactBuildIdentity({ version: '1.2.3', git_sha: sha }, '1.2.3', sha));
  assert.throws(() => validateArtifactBuildIdentity({ version: '1.2.4', git_sha: sha }, '1.2.3', sha), /version/);
  assert.throws(() => validateArtifactBuildIdentity({ version: '1.2.3', git_sha: 'dirty' }, '1.2.3', sha), /invalid build identity/);
  assert.throws(() => validateArtifactBuildIdentity({ version: '1.2.3', git_sha: 'b'.repeat(40) }, '1.2.3', sha), /does not match/);
  assert.throws(() => validateArtifactBuildIdentity({ version: '1.2.3', git_sha: sha }, '1.2.3', 'abc'), /full 40-character/);
});

test('agentWorkflowFollowUps preserves dependent order and selected path', () => {
  const task = { task_type: 'review', target: 'route-users' };
  const target = { nodeId: 'route-users', target: 'route-users', file: 'src/users.ts' };
  const calls = agentWorkflowFollowUps('/repo/service', task, target);
  assert.deepEqual(calls.map(call => call.name), [
    'get_agent_start_context',
    'get_agent_tool_plan',
    'get_agent_context',
    'get_coding_context',
  ]);
  assert.ok(calls.every(call => call.arguments.path === '/repo/service'));
  assert.equal(calls[3].arguments.target, 'route-users');
});

test('validateAgentWorkflow requires explicitly represented context evidence fields', () => {
  const target = { nodeId: 'route-users', target: 'route-users', file: 'src/users.ts' };
  const payloads = {
    resolve_agent_analysis: { selected_path: '/repo/service' },
    get_agent_start_context: { system: { nodes: 3 }, readiness: { agent_context_ready: true } },
    get_agent_tool_plan: { steps: [{ tool: 'get_agent_context' }] },
    get_agent_context: {
      selected_node: { id: 'route-users', file: 'src/users.ts' },
      file_read_plan: [],
      work_context: {
        tests: { suites: [], mocks: [], fixtures: [] },
        risk_context: { top_risks: [], repo_top_risks: [] },
        behavioral_invariants: { invariants: [] },
      },
    },
    get_coding_context: { target_node: { id: 'route-users', file: 'src/users.ts' } },
  };
  assert.equal(validateAgentWorkflow(payloads, '/repo', target).selectedPath, '/repo/service');
  assert.throws(() => validateAgentWorkflow({
    ...payloads,
    get_agent_context: {
      ...payloads.get_agent_context,
      work_context: {
        ...payloads.get_agent_context.work_context,
        tests: { suites: [], mocks: [] },
      },
    },
  }, '/repo', target), /fixtures must be an explicitly represented array/);
});

test('McpWorkflowSession keeps dependent calls in one process and records JSONL-ready timings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-mcp-session-'));
  const fixture = path.join(root, 'server.cjs');
  fs.writeFileSync(fixture, [
    "let buffer = '';",
    "process.stdin.on('data', chunk => {",
    "  buffer += chunk.toString();",
    "  let newline;",
    "  while ((newline = buffer.indexOf('\\n')) >= 0) {",
    "    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);",
    "    if (!line) continue;",
    "    const request = JSON.parse(line); if (!request.id) continue;",
    "    const payload = request.method === 'initialize' ? { serverInfo: { name: 'fixture' } } : { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, tool: request.params.name, args: request.params.arguments }) }] };",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: payload }) + '\\n');",
    "  }",
    "});",
  ].join('\n'));
  const session = new McpWorkflowSession(fixture, process.env);
  try {
    await session.initialize();
    const first = await session.callTool('resolve_agent_analysis', { path: '/repo' });
    const second = await session.callTool('get_agent_start_context', { path: '/repo/service' });
    assert.equal(first.pid, second.pid);
    assert.deepEqual(session.transcript.map(entry => entry.tool), ['resolve_agent_analysis', 'get_agent_start_context']);
    assert.ok(session.transcript.every(entry => entry.elapsed_ms >= 0 && entry.started_at.length > 0));
  } finally {
    session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
