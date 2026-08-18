import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { capabilityInferenceBenchmarkGates, competitorBaselineBenchmarkGates, discoverCurrentScratchReports, freshnessGates, machineProofGates, newUserE2EGates } from './agent-vision-acceptance';

test('scratch acceptance discovers current reports by proof shape and task identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-vision-scratch-discovery-'));
  const directory = path.join(root, '.klauro-agent-scratch-build-benchmark');
  await fs.ensureDir(directory);
  const report = (id: string, generatedAt: string, score: number) => ({
    generated_at: generatedAt,
    task: { id },
    with_klauro: { score },
    without_klauro: { score: score - 1 },
    comparison: { quality_delta: 1 },
  });
  await fs.writeJson(path.join(directory, 'arbitrary-old.json'), report('domain-a', '2026-01-01T00:00:00.000Z', 91));
  await fs.writeJson(path.join(directory, 'arbitrary-current.json'), report('domain-a', '2026-01-02T00:00:00.000Z', 96));
  await fs.writeJson(path.join(directory, 'another-shape.json'), report('domain-b', '2026-01-01T00:00:00.000Z', 94));
  await fs.writeJson(path.join(directory, 'unrelated.json'), { generated_at: '2026-01-03T00:00:00.000Z', status: 'pass' });

  const reports = await discoverCurrentScratchReports(root);

  assert.deepEqual(reports.map(item => item.identity), ['domain-a', 'domain-b']);
  assert.equal(reports.find(item => item.identity === 'domain-a')?.report.with_klauro.score, 96);
});

test('acceptance freshness follows live execution time instead of rescore time', () => {
  const now = new Date();
  const staleExecution = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const gates = freshnessGates(168, {
    'live-proof': {
      generated_at: now.toISOString(),
      rescored_at: now.toISOString(),
      execution_generated_at: staleExecution,
    },
  });

  assert.equal(gates[0].status, 'fail');
  assert.equal(freshnessGates(168, {
    'live-proof': {
      generated_at: staleExecution,
      execution_generated_at: now.toISOString(),
    },
  })[0].status, 'pass');
});

test('capability vision acceptance requires proven domain provenance instead of a fixture label', () => {
  const report = {
    status: 'pass',
    score: 100,
    summary: { primary_domain: '', generic_capability_count: 0 },
    capabilities: [
      { name: 'Vehicle Operations' },
      { name: 'Fuel Purchases' },
      { name: 'Invoice Settlement' },
    ],
    gates: [
      { id: 'capability-inference:primary-domain-provenance', status: 'pass', detail: 'primary domain absent because AI enrichment was disabled' },
      { id: 'capability-inference:capability-1', status: 'pass' },
      { id: 'capability-inference:capability-2', status: 'pass' },
      { id: 'capability-inference:capability-3', status: 'pass' },
      { id: 'capability-inference:capability-4', status: 'pass' },
      { id: 'capability-inference:capability-5', status: 'pass' },
    ],
  };

  const gates = capabilityInferenceBenchmarkGates(report);

  assert.equal(gates.find(gate => gate.id === 'capability-inference:domain')?.status, 'pass');
  report.gates[0].status = 'fail';
  assert.equal(capabilityInferenceBenchmarkGates(report).find(gate => gate.id === 'capability-inference:domain')?.status, 'fail');
});

test('machine vision acceptance requires full-mode analysis of every eligible repo', () => {
  const fastSample = machineReport({
    mode: 'fast',
    selected_eligible_count: 1,
    repo_results: [
      { name: 'repo-a', path: '/dev/repo-a', status: 'eligible', proof_status: 'pass' },
      {
        name: 'repo-b',
        path: '/dev/repo-b',
        status: 'eligible',
        proof_status: 'skipped',
        reason: 'Eligible repo not analyzed because this fast batch selected 1 of 2 eligible repos with --start-index=0 and --max-targets=1.',
      },
    ],
  });

  const gates = machineProofGates(fastSample);

  assert.equal(gates.find(gate => gate.id === 'machine-proof:eligible-accounting')?.status, 'pass');
  assert.equal(gates.find(gate => gate.id === 'machine-proof:full-eligible-analysis')?.status, 'fail');
});

test('machine vision acceptance passes full-mode proof only when every eligible repo was analyzed', () => {
  const full = machineReport({
    mode: 'full',
    selected_eligible_count: 2,
    repo_results: [
      { name: 'repo-a', path: '/dev/repo-a', status: 'eligible', proof_status: 'pass' },
      { name: 'repo-b', path: '/dev/repo-b', status: 'eligible', proof_status: 'pass' },
    ],
  });

  const gates = machineProofGates(full);

  assert.equal(gates.find(gate => gate.id === 'machine-proof:full-eligible-analysis')?.status, 'pass');
});

test('vision acceptance requires competitor baseline quality and token lift', () => {
  const passing = competitorBaselineBenchmarkGates(competitorBaselineReport({
    summary: {
      scenario_count: 14,
      family_count: 13,
      average_klauro_context_tokens: 2500,
      cursor: {
        model: 'cursor-style-index-context-proxy-v2',
        average_context_readiness_score: 51,
        average_file_recall: 55,
        average_file_precision: 60,
        average_context_readiness_delta: 35,
        scenarios_with_positive_context_readiness_delta: 13,
        average_token_reduction_percentage: 35,
        scenarios_with_positive_token_reduction: 14,
      },
      linear: {
        model: 'linear-style-workflow-code-context-proxy-v1',
        average_context_readiness_score: 76,
        average_file_recall: 55,
        average_context_readiness_delta: 18,
        scenarios_with_positive_context_readiness_delta: 14,
        average_token_reduction_percentage: 87,
        scenarios_with_positive_token_reduction: 14,
      },
      competitor_model: 'cursor-style-index-context-proxy-v2',
      average_index_retrieval_file_recall: 55,
      average_index_retrieval_file_precision: 60,
      average_context_readiness_delta_vs_index: 35,
      scenarios_with_positive_context_readiness_delta: 13,
      average_token_reduction_vs_index_percentage: 35,
      scenarios_with_positive_token_reduction: 14,
    },
  }));
  assert.equal(passing.find(gate => gate.id === 'competitor-baseline:cursor-quality-lift')?.status, 'pass');
  assert.equal(passing.find(gate => gate.id === 'competitor-baseline:cursor-token-reduction')?.status, 'pass');
  assert.equal(passing.find(gate => gate.id === 'competitor-baseline:linear-quality-lift')?.status, 'pass');
  assert.equal(passing.find(gate => gate.id === 'competitor-baseline:linear-token-reduction')?.status, 'pass');

  const failing = competitorBaselineBenchmarkGates(competitorBaselineReport({
    summary: {
      scenario_count: 14,
      family_count: 13,
      average_klauro_context_tokens: 4200,
      cursor: {
        model: 'cursor-style-index-context-proxy-v2',
        average_context_readiness_score: 51,
        average_file_recall: 55,
        average_file_precision: 60,
        average_context_readiness_delta: 5,
        scenarios_with_positive_context_readiness_delta: 6,
        average_token_reduction_percentage: -4,
        scenarios_with_positive_token_reduction: 2,
      },
      linear: {
        model: 'linear-style-workflow-code-context-proxy-v1',
        average_context_readiness_score: 76,
        average_file_recall: 55,
        average_context_readiness_delta: 4,
        scenarios_with_positive_context_readiness_delta: 5,
        average_token_reduction_percentage: 8,
        scenarios_with_positive_token_reduction: 4,
      },
      competitor_model: 'cursor-style-index-context-proxy-v2',
      average_index_retrieval_file_recall: 55,
      average_index_retrieval_file_precision: 60,
      average_context_readiness_delta_vs_index: 5,
      scenarios_with_positive_context_readiness_delta: 6,
      average_token_reduction_vs_index_percentage: -4,
      scenarios_with_positive_token_reduction: 2,
    },
  }));
  assert.equal(failing.find(gate => gate.id === 'competitor-baseline:cursor-quality-lift')?.status, 'fail');
  assert.equal(failing.find(gate => gate.id === 'competitor-baseline:cursor-token-reduction')?.status, 'fail');
  assert.equal(failing.find(gate => gate.id === 'competitor-baseline:linear-quality-lift')?.status, 'fail');
  assert.equal(failing.find(gate => gate.id === 'competitor-baseline:linear-token-reduction')?.status, 'fail');
});

test('vision acceptance requires new-user install-to-value and hosted incremental sync', () => {
  const passing = newUserE2EGates({
    status: 'pass',
    total_ms: 8000,
    max_total_ms: 600000,
    steps: [
      { name: 'build customer artifact', ok: true, detail: 'built the lightweight customer bundle' },
      { name: 'pack and install from customer tarball', ok: true, detail: 'installed the customer tarball' },
      { name: 'installed CLI is executable', ok: true, detail: 'klauro 1.0.0' },
      { name: 'account registration', ok: true, detail: 'registered and stored a session' },
      { name: 'remote analyzer project init', ok: true, detail: '.klaurorc points at https://mcp.klauro.com' },
      { name: 'hosted analyzer full analysis', ok: true, detail: 'full remote analysis returned 33 nodes' },
      { name: 'installed MCP first context', ok: true, detail: 'installed MCP returned hosted system context' },
      { name: 'hosted analyzer incremental sync', ok: true, detail: 'incremental sync returned 1 changed file(s)' },
    ],
  });
  assert.equal(passing.find(gate => gate.id === 'new-user-e2e:status')?.status, 'pass');
  assert.equal(passing.find(gate => gate.id === 'new-user-e2e:first-value')?.status, 'pass');
  assert.equal(passing.find(gate => gate.id === 'new-user-e2e:hosted-incremental')?.status, 'pass');

  const failing = newUserE2EGates({
    status: 'pass',
    total_ms: 700000,
    max_total_ms: 600000,
    steps: [
      { name: 'pack and install from customer tarball', ok: true, detail: 'installed only' },
      { name: 'installed CLI is executable', ok: true, detail: 'klauro 1.0.0' },
    ],
  });
  assert.equal(failing.find(gate => gate.id === 'new-user-e2e:ten-minute-bar')?.status, 'fail');
  assert.equal(failing.find(gate => gate.id === 'new-user-e2e:required-steps')?.status, 'fail');
  assert.equal(failing.find(gate => gate.id === 'new-user-e2e:first-value')?.status, 'fail');
});

function machineReport(overrides: Record<string, unknown>) {
  return {
    status: 'pass',
    score: 100,
    mode: 'full',
    selected_eligible_count: 2,
    discovery: {
      total_repos: 2,
      repos: [
        { name: 'repo-a', path: '/dev/repo-a', status: 'eligible' },
        { name: 'repo-b', path: '/dev/repo-b', status: 'eligible' },
      ],
    },
    repo_results: [
      { name: 'repo-a', path: '/dev/repo-a', status: 'eligible', proof_status: 'pass' },
      { name: 'repo-b', path: '/dev/repo-b', status: 'eligible', proof_status: 'pass' },
    ],
    gates: [
      { id: 'example', status: 'pass' },
    ],
    ...overrides,
  };
}

function competitorBaselineReport(overrides: Record<string, unknown>) {
  return {
    status: 'pass',
    score: 100,
    summary: {},
    gates: [
      { id: 'competitor-baseline:seeded-proof-passes', status: 'pass' },
      { id: 'competitor-baseline:scenario-coverage', status: 'pass' },
      { id: 'competitor-baseline:cursor-proxy-is-nontrivial', status: 'pass' },
      { id: 'competitor-baseline:linear-proxy-is-nontrivial', status: 'pass' },
      { id: 'competitor-baseline:cursor-quality-delta', status: 'pass' },
      { id: 'competitor-baseline:linear-quality-delta', status: 'pass' },
      { id: 'competitor-baseline:cursor-token-delta', status: 'pass' },
      { id: 'competitor-baseline:linear-token-delta', status: 'pass' },
      { id: 'competitor-baseline:klauro-token-discipline', status: 'pass' },
    ],
    ...overrides,
  };
}
