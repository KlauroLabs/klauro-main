/**
 * Unit tests for the DeepInfra coding-agent runner. NO network: the DeepInfra
 * chat client and the Klauro connector are both injected/mocked. The tests
 * simulate the model issuing tool calls and assert the runner applies edits,
 * writes the result JSON (tokens + files_changed), counts Klauro tool calls,
 * and enforces workspace sandboxing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  runDeepInfraAgent,
  resolveInWorkspace,
  createFilesystemTools,
  parseArgs,
  type ChatClient,
  type ChatCompletionResponse,
  type KlauroConnector,
  type KlauroToolProvider,
  type AgentTool,
} from './deepinfra-agent';

async function makeWorkspace(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepinfra-agent-test-'));
  return dir;
}

/**
 * A scripted chat client: yields the queued responses in order, then a final
 * plain assistant message with no tool calls (loop terminator).
 */
function scriptedChat(responses: ChatCompletionResponse[], finalSummary = 'done'): ChatClient {
  let i = 0;
  return async () => {
    if (i < responses.length) return responses[i++];
    return {
      choices: [{ message: { role: 'assistant', content: finalSummary }, finish_reason: 'stop' }],
      usage: { total_tokens: 5 },
    };
  };
}

function toolCallResponse(name: string, args: Record<string, unknown>, totalTokens: number): ChatCompletionResponse {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { total_tokens: totalTokens },
  };
}

test('baseline: model write_file tool call is applied and result JSON is written', async () => {
  const workspace = await makeWorkspace();
  const promptFile = path.join(workspace, 'prompt.md');
  const resultFile = path.join(workspace, 'result.json');
  await fsp.writeFile(promptFile, 'Create hello.txt with "hi".', 'utf8');

  const chat = scriptedChat([
    toolCallResponse('write_file', { path: 'hello.txt', content: 'hi' }, 100),
  ], 'Created hello.txt');

  const result = await runDeepInfraAgent({ promptFile, workspace, resultFile, chat, maxIters: 4 });

  // Edit applied under the workspace.
  const written = await fsp.readFile(path.join(workspace, 'hello.txt'), 'utf8');
  assert.equal(written, 'hi');

  // Result JSON on disk carries the token count and files_changed.
  assert.ok(fs.existsSync(resultFile));
  const onDisk = JSON.parse(await fsp.readFile(resultFile, 'utf8'));
  assert.deepEqual(onDisk.files_changed, ['hello.txt']);
  assert.equal(onDisk.provider_total_tokens, 105); // 100 (tool turn) + 5 (final)
  assert.equal(onDisk.klauro_tool_calls, 0);
  assert.equal(result.summary, 'Created hello.txt');
});

test('autonomous: mocked Klauro tool is offered and its calls are counted', async () => {
  const workspace = await makeWorkspace();
  const promptFile = path.join(workspace, 'prompt.md');
  const resultFile = path.join(workspace, 'result.json');
  const mcpConfig = path.join(workspace, 'klauro.mcp.json');
  await fsp.writeFile(promptFile, 'Orient with Klauro, then add note.txt.', 'utf8');
  await fsp.writeFile(
    mcpConfig,
    JSON.stringify({ mcpServers: { klauro: { command: 'noop', args: [], env: {} } } }),
    'utf8'
  );

  // Capture whether klauro_analyze was offered to the model.
  let offeredToolNames: string[] = [];
  const chat: ChatClient = (() => {
    let step = 0;
    return async (request) => {
      offeredToolNames = (request.tools || []).map((t) => t.function.name);
      step++;
      if (step === 1) return toolCallResponse('klauro_analyze', { repoPath: workspace }, 50);
      if (step === 2) return toolCallResponse('write_file', { path: 'note.txt', content: 'ok' }, 40);
      return {
        choices: [{ message: { role: 'assistant', content: 'used klauro then edited' }, finish_reason: 'stop' }],
        usage: { total_tokens: 5 },
      };
    };
  })();

  let closed = false;
  const klauroTool: AgentTool = {
    isKlauro: true,
    spec: {
      type: 'function',
      function: {
        name: 'klauro_analyze',
        description: 'mock klauro analyze',
        parameters: { type: 'object', properties: { repoPath: { type: 'string' } }, required: ['repoPath'] },
      },
    },
    handler: async () => 'entities: Foo, Bar',
  };
  const connector: KlauroConnector = async (): Promise<KlauroToolProvider> => ({
    tools: [klauroTool],
    transport: 'mcp',
    close: async () => {
      closed = true;
    },
  });

  const result = await runDeepInfraAgent({
    promptFile,
    workspace,
    resultFile,
    mcpConfig,
    chat,
    klauroConnector: connector,
    maxIters: 5,
  });

  assert.ok(offeredToolNames.includes('klauro_analyze'), 'klauro tool offered to model');
  assert.ok(offeredToolNames.includes('write_file'), 'fs tools also offered');
  assert.equal(result.klauro_tool_calls, 1);
  assert.equal(result.klauro_transport, 'mcp');
  assert.deepEqual(result.files_changed, ['note.txt']);
  assert.equal(result.provider_total_tokens, 95); // 50 + 40 + 5
  assert.ok(closed, 'connector was closed');

  const onDisk = JSON.parse(await fsp.readFile(resultFile, 'utf8'));
  assert.equal(onDisk.klauro_tool_calls, 1);
});

test('sandboxing: writes outside the workspace are rejected', async () => {
  const workspace = await makeWorkspace();
  // resolveInWorkspace guards traversal.
  assert.throws(() => resolveInWorkspace(workspace, '../escape.txt'), /escapes workspace/);
  assert.throws(() => resolveInWorkspace(workspace, '/etc/passwd'), /escapes workspace/);

  // The write_file tool surfaces the rejection as an error string (no file written).
  const changed = new Set<string>();
  const tools = createFilesystemTools(workspace, changed);
  const writeTool = tools.find((t) => t.spec.function.name === 'write_file')!;
  const outside = path.join(path.dirname(workspace), 'should-not-exist.txt');
  await assert.rejects(() => writeTool.handler({ path: '../should-not-exist.txt', content: 'x' }), /escapes workspace/);
  assert.equal(fs.existsSync(outside), false);
  assert.equal(changed.size, 0);

  // A valid in-workspace write succeeds.
  const okResult = await writeTool.handler({ path: 'sub/ok.txt', content: 'y' });
  assert.match(okResult, /wrote sub\/ok\.txt/);
  assert.equal(await fsp.readFile(path.join(workspace, 'sub/ok.txt'), 'utf8'), 'y');
});

test('CLI arg parsing maps flags to options', () => {
  const parsed = parseArgs([
    '--prompt-file', '/p.md',
    '--workspace', '/ws',
    '--result-file', '/r.json',
    '--mcp-config', '/m.json',
    '--model', 'some/Model',
    '--max-iters', '3',
  ]);
  assert.equal(parsed.promptFile, '/p.md');
  assert.equal(parsed.workspace, '/ws');
  assert.equal(parsed.resultFile, '/r.json');
  assert.equal(parsed.mcpConfig, '/m.json');
  assert.equal(parsed.model, 'some/Model');
  assert.equal(parsed.maxIters, 3);
});
