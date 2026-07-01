import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  runAutonomousMcpTrial,
  writeKlauroMcpClientConfig,
  resolveDeployedAnalyzer,
  type AgentRunner,
  type AgentRunContext,
  type AgentRunResult,
} from './autonomous-mcp-trial';

// A tiny repo the harness can copy per arm. No network, no git required.
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autonomous-repo-'));
  await fs.writeFile(path.join(dir, 'index.ts'), 'export const answer = 41;\n', 'utf8');
  return dir;
}

function baseTask(repoPath: string) {
  return {
    taskId: 'fix-answer',
    taskLabel: 'Fix the answer constant',
    instructions: 'Change answer from 41 to 42.',
    expectedOutcome: 'answer === 42',
    repoPath,
  };
}

test('writeKlauroMcpClientConfig wires the local MCP server at the deployed analyzer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autonomous-cfg-'));
  const cfg = await writeKlauroMcpClientConfig(path.join(dir, 'klauro.mcp.json'), {
    serverUrl: 'https://mcp.klauro.com',
    token: 'test-token',
    serverCommand: 'node',
    serverArgs: ['/opt/klauro/dist/index.cjs'],
  });
  assert.equal(cfg.serverUrl, 'https://mcp.klauro.com');
  const onDisk = await fs.readJson(cfg.configPath);
  assert.deepEqual(onDisk, cfg.config);
  assert.equal(onDisk.mcpServers.klauro.command, 'node');
  assert.deepEqual(onDisk.mcpServers.klauro.args, ['/opt/klauro/dist/index.cjs']);
  // The deployed analyzer wiring lives in env the server reads.
  assert.equal(onDisk.mcpServers.klauro.env.KLAURO_ANALYZER_URL, 'https://mcp.klauro.com');
  assert.equal(onDisk.mcpServers.klauro.env.KLAURO_ANALYZER_TOKEN, 'test-token');
  assert.equal(onDisk.mcpServers.klauro.env.KLAURO_ACCOUNT_TOKEN, 'test-token');
  await fs.remove(dir);
});

test('resolveDeployedAnalyzer defaults to Klauro Cloud', () => {
  const prevUrl = process.env.KLAURO_BENCH_ANALYZER_URL;
  delete process.env.KLAURO_BENCH_ANALYZER_URL;
  try {
    const resolved = resolveDeployedAnalyzer();
    assert.equal(resolved.serverUrl, 'https://mcp.klauro.com');
  } finally {
    if (prevUrl !== undefined) process.env.KLAURO_BENCH_ANALYZER_URL = prevUrl;
  }
});

test('runAutonomousMcpTrial: fake runner drives both arms, scores them, computes deltas (no network/LLM)', async () => {
  const repo = await makeRepo();
  const seen: AgentRunContext[] = [];

  // Fake runner: simulates the autonomous agent CALLING a Klauro tool and
  // succeeding cheaply; the baseline flails more (more tokens, no tools, worse).
  const fakeRunner: AgentRunner = async (ctx: AgentRunContext): Promise<AgentRunResult> => {
    seen.push(ctx);
    // Simulate the agent writing its result JSON, as a real agent would.
    if (ctx.arm === 'autonomous-klauro') {
      // Assert the harness handed us the MCP config wiring.
      assert.ok(ctx.mcpConfig, 'autonomous arm must receive an MCP config');
      assert.match(ctx.command, /klauro\.mcp\.json/);
      await fs.writeJson(ctx.resultFile, {
        task_success: true,
        quality_score: 9,
        files_read: 1,
        klauro_tool_calls: 3,
      });
      return {
        command_passed: true,
        validation_passed: true,
        task_success: true,
        self_reported_quality: 9,
        files_read: 1,
        klauro_tool_calls: 3,
        files_changed: 1,
        provider_total_tokens: 4000,
        duration_ms: 1000,
      };
    }
    assert.equal(ctx.mcpConfig, undefined, 'baseline arm must NOT receive an MCP config');
    await fs.writeJson(ctx.resultFile, { task_success: true, quality_score: 6, files_read: 9 });
    return {
      command_passed: true,
      validation_passed: false,
      task_success: false,
      self_reported_quality: 6,
      files_read: 9,
      files_changed: 4,
      provider_total_tokens: 12000,
      duration_ms: 3000,
    };
  };

  const result = await runAutonomousMcpTrial({
    task: baseTask(repo),
    analyzer: { serverUrl: 'https://mcp.klauro.com', token: 'tkn', serverCommand: 'node', serverArgs: ['/x/dist/index.cjs'] },
    agentKlauroCmd: 'claude --mcp-config {mcp_config} -- "$(cat {prompt_file})"',
    agentBaselineCmd: 'claude -- "$(cat {prompt_file})"',
    agentRunner: fakeRunner,
    keepWorkspaces: false,
  });

  // Both arms attempted, in order.
  assert.equal(seen.length, 2);
  assert.equal(seen[0].arm, 'autonomous-klauro');
  assert.equal(seen[1].arm, 'baseline');

  // Scored with the shared rubric.
  assert.ok(result.autonomous_klauro.quality > result.baseline.quality, 'klauro arm should score higher');
  assert.equal(result.delta.quality_delta, result.autonomous_klauro.quality - result.baseline.quality);
  assert.ok(result.delta.quality_delta > 0);

  // Autonomy signal + token reduction surfaced in the delta.
  assert.equal(result.delta.klauro_tool_calls, 3);
  assert.equal(result.autonomous_klauro.token_source, 'provider-total');
  assert.equal(result.baseline.tokens, 12000);
  assert.equal(result.delta.token_reduction, 66.7); // (12000-4000)/12000
  assert.equal(result.delta.time_reduction_ms, 2000);

  // The autonomous arm recorded where its MCP config was written.
  assert.ok(result.autonomous_klauro.mcp_config_path);
  assert.equal(result.server_url, 'https://mcp.klauro.com');

  await fs.remove(repo);
  await fs.remove(result.trial_directory).catch(() => undefined);
});

test('runAutonomousMcpTrial: runner error floors the arm quality', async () => {
  const repo = await makeRepo();
  const runner: AgentRunner = async (ctx) => ({
    command_passed: false,
    files_changed: 0,
    error: ctx.arm === 'baseline' ? 'boom' : undefined,
    ...(ctx.arm === 'autonomous-klauro'
      ? { command_passed: true, task_success: true, self_reported_quality: 8, files_changed: 1, klauro_tool_calls: 2 }
      : {}),
  });
  const result = await runAutonomousMcpTrial({
    task: baseTask(repo),
    agentKlauroCmd: 'true {mcp_config} {prompt_file}',
    agentBaselineCmd: 'true {prompt_file}',
    agentRunner: runner,
    keepWorkspaces: false,
  });
  assert.equal(result.baseline.quality, 5); // scoreArmQuality floors errored arms at 5
  assert.ok(result.autonomous_klauro.quality > result.baseline.quality);
  await fs.remove(repo);
  await fs.remove(result.trial_directory).catch(() => undefined);
});
