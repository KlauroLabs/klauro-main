import { projectEntryPointFlowsFromCas, projectEntryPointFlowsFromFlows } from '../../analyzer/core/entry-point-flow-projection';
import type { FlowConcept } from '../../types/cas.types';

function flow(id: string, exitId: string, nodeId: string): FlowConcept {
  return {
    flow_id: id,
    name: id === 'approve' ? 'Approve application' : 'Reject application',
    intent: id,
    entry_point: 'review-entry',
    entities: ['application'],
    contract: {
      input: ['application'],
      logic: id,
      constraints: [],
      output: [`Application ${id === 'approve' ? 'approved' : 'rejected'}`],
      side_effects: {
        state_changes: [`Application ${id === 'approve' ? 'updated' : 'rejected'}`],
        external_integrations: [],
      },
    },
    steps: [{
      step_id: `${id}-decision`,
      order: 0,
      name: id === 'approve' ? 'Approve the application' : 'Reject the application',
      description: id,
      description_source: 'deterministic-label',
      contract: {
        input: ['application'],
        logic: id,
        constraints: [],
        output: [],
        side_effects: { state_changes: [], external_integrations: [] },
      },
      functions: [{ function_id: nodeId }],
      entities: ['application'],
    }],
    terminus: { exit_point_id: exitId, kind: 'api', produces: id, node_id: nodeId },
  };
}

test('projects dependency uncertainty without losing the canonical flow or exit', () => {
  const projected = projectEntryPointFlowsFromFlows({
    nodes: [{ id: 'approve-node', name: 'handleReview', type: 'function' }] as any,
    edges: [],
    entryPoints: [{ id: 'review-entry', name: 'POST /review', type: 'http', source_node: 'approve-node' }] as any,
    exitPoints: [{ id: 'dependency', source_node: 'approve-node', type: 'sdk', name: 'Call to transform', target: { sdk: 'formatting-library' } }] as any,
    callChains: [],
    dataEntities: [],
    changeRisks: [],
    flows: [flow('approve', 'dependency', 'approve-node')],
  });
  expect(projected.entryPointFlows).toHaveLength(1);
  expect(projected.entryPointFlows[0].terminal_effects.external_services).toEqual([]);
  expect(projected.entryPointFlows[0].exit_point_ids).toEqual(['dependency']);
  expect(projected.entryPointFlows[0].unresolved_exit_point_ids).toEqual(['dependency']);
});

test('entryPointFlow views are one-to-one projections of canonical flows sharing an entry', () => {
  const flows = [flow('approve', 'approve-exit', 'approve-node'), flow('reject', 'reject-exit', 'reject-node')];
  const result = projectEntryPointFlowsFromFlows({
    nodes: [
      { id: 'review-node', name: 'review', type: 'controller' },
      { id: 'approve-node', name: 'approve', type: 'method' },
      { id: 'reject-node', name: 'reject', type: 'method' },
    ] as any,
    edges: [],
    entryPoints: [{ id: 'review-entry', name: 'POST /applications/:id/review', type: 'http', source_node: 'review-node' }] as any,
    exitPoints: [
      { id: 'approve-exit', name: 'approved', type: 'api', source_node: 'approve-node' },
      { id: 'reject-exit', name: 'rejected', type: 'api', source_node: 'reject-node' },
    ] as any,
    callChains: [
      { id: 'approve-chain', entry_point: { entry_point_id: 'review-entry' }, exit_point: { exit_point_id: 'approve-exit' }, call_path: [{ node_id: 'approve-node' }] },
      { id: 'reject-chain', entry_point: { entry_point_id: 'review-entry' }, exit_point: { exit_point_id: 'reject-exit' }, call_path: [{ node_id: 'reject-node' }] },
    ] as any,
    dataEntities: [{ id: 'application', name: 'Application', fields: [] }] as any,
    changeRisks: [],
    flows,
  });

  expect(result.entryPointFlows.map(entryPointFlow => entryPointFlow.derived_from_flow_id).sort()).toEqual(['approve', 'reject']);
  expect(result.entryPointFlows.find(entryPointFlow => entryPointFlow.derived_from_flow_id === 'approve')?.exit_point_ids).toEqual(['approve-exit']);
  expect(result.entryPointFlows.find(entryPointFlow => entryPointFlow.derived_from_flow_id === 'reject')?.exit_point_ids).toEqual(['reject-exit']);
  expect(result.entryPointFlows.find(entryPointFlow => entryPointFlow.derived_from_flow_id === 'approve')?.terminal_entities).toContainEqual({
    node_id: 'approve-node',
    name: 'approve',
    access: 'read',
    terminal_kind: 'node',
  });
});

test('current CAS derives entryPointFlows from flows without a persisted entryPointFlow collection', () => {
  const cas = {
    cas_version: '3.0.0',
    analysis_id: 'analysis',
    analysis_timestamp: '2026-09-03T00:00:00.000Z',
    system: { id: 'system', name: 'system', type: 'service', root_path: '/repo', technologies: {}, quality: {} },
    nodes: [{ id: 'review-node', name: 'review', type: 'controller' }, { id: 'approve-node', name: 'approve', type: 'method' }],
    edges: [],
    entry_points: [{ id: 'review-entry', name: 'review', type: 'http', source_node: 'review-node' }],
    exit_points: [{ id: 'approve-exit', name: 'approved', type: 'api', source_node: 'approve-node' }],
    flows: [flow('approve', 'approve-exit', 'approve-node')],
    analyzer_contributions: [],
  } as any;

  expect(cas.entry_point_flows).toBeUndefined();
  expect(projectEntryPointFlowsFromCas(cas).entryPointFlows[0]?.derived_from_flow_id).toBe('approve');
});

test('indexed projection preserves exits, guards, tests, and entry aliases without a terminus', () => {
  const unboundedFlow = flow('inspect', 'unused-exit', 'worker-node') as any;
  delete unboundedFlow.terminus;
  const result = projectEntryPointFlowsFromFlows({
    nodes: [
      { id: 'review-node', name: 'review', type: 'controller' },
      { id: 'handler-node', name: 'handleReview', type: 'method' },
      { id: 'worker-node', name: 'inspectApplication', type: 'method', testing: { tested_by: ['metadata-test'] } },
      { id: 'guard-node', name: 'ApplicationPolicy', type: 'guard' },
    ] as any,
    edges: [
      { source: 'worker-node', target: 'guard-node', type: 'guarded_by' },
      { source: 'edge-test', target: 'worker-node', type: 'tests' },
    ] as any,
    entryPoints: [{
      id: 'review-entry',
      name: 'POST /applications/:id/review',
      type: 'http',
      source_node: 'review-node',
      handler: { node_id: 'handler-node' },
    }] as any,
    exitPoints: [
      { id: 'worker-exit', name: 'worker effect', type: 'api', source_node: 'worker-node' },
      { id: 'entry-exit', name: 'entry effect', type: 'api', source_node: 'handler-node' },
      { id: 'unrelated-exit', name: 'other effect', type: 'api', source_node: 'other-node' },
    ] as any,
    callChains: [
      { id: 'source-chain', entry_point: { node_id: 'review-node' }, call_path: [{ node_id: 'worker-node' }] },
      { id: 'handler-chain', entry_point: { node_id: 'handler-node' }, call_path: [{ node_id: 'worker-node' }] },
      { id: 'unrelated-chain', entry_point: { node_id: 'other-node' }, call_path: [{ node_id: 'worker-node' }] },
    ] as any,
    dataEntities: [{ id: 'application', name: 'Application', fields: [] }] as any,
    changeRisks: [],
    flows: [unboundedFlow],
  });

  expect(result.entryPointFlows).toHaveLength(1);
  expect(result.entryPointFlows[0].exit_point_ids).toEqual(['worker-exit', 'entry-exit']);
  expect(result.entryPointFlows[0].call_chain_ids).toEqual(['source-chain', 'handler-chain']);
  expect(result.entryPointFlows[0].security_boundaries).toContainEqual(expect.objectContaining({
    node_id: 'guard-node',
    name: 'ApplicationPolicy',
  }));
  expect(result.entryPointFlows[0].tests_covering).toEqual(['edge-test', 'metadata-test']);
});

test('a entryPointFlow whose entry is tagged unshipped is a low-criticality system entryPointFlow carrying its tag', () => {
  const projected = projectEntryPointFlowsFromFlows({
    nodes: [{ id: 'approve-node', name: 'handleReview', type: 'function' }] as any,
    edges: [],
    entryPoints: [{ id: 'review-entry', name: 'POST /review', type: 'http', source_node: 'approve-node', metadata: { unshipped: { role: 'benchmark' } } }] as any,
    exitPoints: [{ id: 'dependency', source_node: 'approve-node', type: 'sdk', name: 'Call to transform', target: { sdk: 'formatting-library' } }] as any,
    callChains: [],
    dataEntities: [],
    changeRisks: [],
    flows: [flow('approve', 'dependency', 'approve-node')],
  });
  expect(projected.entryPointFlows[0].flow_kind).toBe('system');
  expect(projected.entryPointFlows[0].criticality).toBe('low');
  expect(projected.entryPointFlows[0].unshipped).toBe('benchmark');
  expect(projected.summary.by_kind['user-facing']).toBe(0);
});
