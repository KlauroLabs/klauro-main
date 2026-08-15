import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { validateCASContract } from './cas-contract';

test('accepts a synthetic flow call chain when its backing entry node exists', () => {
  const cas = {
    cas_version: '3.0.0',
    analysis_id: 'analysis_test',
    analysis_timestamp: new Date().toISOString(),
    system: { id: 'system_test', name: 'test', type: 'service', root_path: '/tmp/test' },
    nodes: [{ id: 'method_process', name: 'process', type: 'method' }],
    edges: [],
    analyzer_contributions: [],
    call_chains: [{
      id: 'chain:synthflow:method_process',
      chain_type: 'dead-end',
      entry_point: { node_id: 'method_process', method_name: 'process', entry_point_id: 'synthflow:method_process' },
      call_path: [{ call_id: 'entry:synthflow:method_process', node_id: 'method_process', method_name: 'process', depth: 0 }],
      characteristics: { total_calls: 0, max_depth: 1, has_external_calls: false, has_database_calls: false, has_async_calls: false, is_circular: false, is_recursive: false, complexity_score: 1 },
      risk_analysis: { risk_level: 'low', risk_factors: [] },
    }],
  } as unknown as CASOutput;

  const gate = validateCASContract(cas).gates.find(candidate => candidate.id === 'call-chains-reference-nodes');

  assert.equal(gate?.status, 'pass');
  assert.equal(gate?.score, 100);
});
