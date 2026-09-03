import { projectUserJourneysFromCas, projectUserJourneysFromFlows } from '../../analyzer/core/journey-projection';
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

test('journey views are one-to-one projections of canonical flows sharing an entry', () => {
  const flows = [flow('approve', 'approve-exit', 'approve-node'), flow('reject', 'reject-exit', 'reject-node')];
  const result = projectUserJourneysFromFlows({
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

  expect(result.journeys.map(journey => journey.derived_from_flow_id).sort()).toEqual(['approve', 'reject']);
  expect(result.journeys.find(journey => journey.derived_from_flow_id === 'approve')?.exit_point_ids).toEqual(['approve-exit']);
  expect(result.journeys.find(journey => journey.derived_from_flow_id === 'reject')?.exit_point_ids).toEqual(['reject-exit']);
});

test('current CAS derives journeys from flows without a persisted journey collection', () => {
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

  expect(cas.user_journeys).toBeUndefined();
  expect(projectUserJourneysFromCas(cas).journeys[0]?.derived_from_flow_id).toBe('approve');
});
