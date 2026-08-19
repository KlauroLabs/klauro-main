import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCompetitorReadinessReport, executable, probeCommand, type CompetitorProbe } from './competitor-readiness';

function probe(overrides: Partial<CompetitorProbe> & Pick<CompetitorProbe, 'id' | 'kind' | 'status'>): CompetitorProbe {
  return {
    id: overrides.id,
    label: overrides.label || overrides.id,
    kind: overrides.kind,
    installed: overrides.status !== 'missing',
    free_or_open_source: overrides.free_or_open_source ?? true,
    live_agent_capable: overrides.live_agent_capable ?? false,
    token_metrics_capable: overrides.token_metrics_capable ?? false,
    status: overrides.status,
    proof_role: overrides.proof_role || 'test competitor',
    benchmark_path: overrides.benchmark_path || 'test benchmark',
    command: overrides.command,
    version: overrides.version,
    auth_state: overrides.auth_state,
    block_reason: overrides.block_reason,
    recommended_command_template: overrides.recommended_command_template,
  };
}

test('competitor readiness separates intelligence competitors from blocked agent executors', () => {
  const report = buildCompetitorReadinessReport([
    probe({ id: 'codebase-memory-mcp', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'scip-typescript', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'stack-graphs-typescript', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'universal-ctags', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'ast-grep', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'opencode-ollama-qwen3-coder', kind: 'agent-executor', status: 'candidate', live_agent_capable: true }),
    probe({ id: 'cursor-agent', kind: 'agent-executor', status: 'blocked', live_agent_capable: true, free_or_open_source: false }),
    probe({ id: 'aider', kind: 'agent-executor', status: 'missing' }),
  ]);

  assert.equal(report.status, 'warn');
  assert.equal(report.benchmark_type, 'installed-benchmark-readiness');
  assert.equal(report.summary.ready_intelligence_competitors, 5);
  assert.equal(report.summary.ready_or_candidate_free_open_agent_executors, 1);
  assert.equal(report.summary.ready_true_live_agent_executors, 0);
  assert.deepEqual(report.summary.absent_requested_agent_executors, ['aider']);
  assert.equal(report.gates.find(gate => gate.id === 'competitor-readiness:true-live-agent-executor-ready')?.status, 'warn');
  assert.match(report.summary.claim_limit, /Autonomous coding tools are executor arms/);
});

test('competitor readiness passes when at least one true live autonomous executor is ready', () => {
  const report = buildCompetitorReadinessReport([
    probe({ id: 'codebase-memory-mcp', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'scip-typescript', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'stack-graphs-typescript', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'universal-ctags', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'ast-grep', kind: 'code-intelligence', status: 'ready' }),
    probe({ id: 'opencode-ollama-qwen3-coder', kind: 'agent-executor', status: 'ready', live_agent_capable: true }),
  ]);

  assert.equal(report.status, 'pass');
  assert.equal(report.summary.ready_true_live_agent_executors, 1);
  assert.ok(report.gates.every(gate => gate.status === 'pass'));
});

test('competitor executable discovery preserves the provided PATH', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-competitor-path-'));
  const command = path.join(directory, 'codebase-memory-mcp');
  try {
    fs.writeFileSync(command, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(command, 0o755);
    assert.equal(executable('codebase-memory-mcp', { PATH: directory }), command);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('competitor command probes reject executables that cannot run', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-competitor-probe-'));
  const command = path.join(directory, 'broken-tool');
  try {
    fs.writeFileSync(command, '#!/bin/sh\necho missing-runtime >&2\nexit 127\n');
    fs.chmodSync(command, 0o755);
    const probe = probeCommand(command, ['--version']);
    assert.equal(probe.ok, false);
    assert.match(probe.output, /missing-runtime/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
