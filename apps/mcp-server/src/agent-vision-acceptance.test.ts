import test from 'node:test';
import assert from 'node:assert/strict';
import { competitorBaselineBenchmarkGates, machineProofGates } from './agent-vision-acceptance';

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
      competitor_model: 'cursor-style-lexical-index-proxy-v1',
      scenario_count: 14,
      family_count: 13,
      average_index_retrieval_file_recall: 55,
      average_index_retrieval_file_precision: 60,
      average_context_readiness_delta_vs_index: 35,
      scenarios_with_positive_context_readiness_delta: 13,
      average_token_reduction_vs_index_percentage: 35,
      scenarios_with_positive_token_reduction: 14,
      average_klauro_packet_tokens: 2500,
    },
  }));
  assert.equal(passing.find(gate => gate.id === 'competitor-baseline:quality-lift')?.status, 'pass');
  assert.equal(passing.find(gate => gate.id === 'competitor-baseline:token-reduction')?.status, 'pass');

  const failing = competitorBaselineBenchmarkGates(competitorBaselineReport({
    summary: {
      competitor_model: 'cursor-style-lexical-index-proxy-v1',
      scenario_count: 14,
      family_count: 13,
      average_index_retrieval_file_recall: 55,
      average_index_retrieval_file_precision: 60,
      average_context_readiness_delta_vs_index: 5,
      scenarios_with_positive_context_readiness_delta: 6,
      average_token_reduction_vs_index_percentage: -4,
      scenarios_with_positive_token_reduction: 2,
      average_klauro_packet_tokens: 4200,
    },
  }));
  assert.equal(failing.find(gate => gate.id === 'competitor-baseline:quality-lift')?.status, 'fail');
  assert.equal(failing.find(gate => gate.id === 'competitor-baseline:token-reduction')?.status, 'fail');
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
      { id: 'competitor-baseline:index-proxy-is-nontrivial', status: 'pass' },
      { id: 'competitor-baseline:quality-delta', status: 'pass' },
      { id: 'competitor-baseline:token-delta', status: 'pass' },
      { id: 'competitor-baseline:klauro-token-discipline', status: 'pass' },
    ],
    ...overrides,
  };
}
