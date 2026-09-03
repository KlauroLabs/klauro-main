import { strict as assert } from 'assert';
import { test } from 'node:test';
import { getUserJourneys } from './query';

test('getUserJourneys projects the current flow graph without persisted journey truth', () => {
  const cas = {
    cas_version: '3.0.0',
    analysis_id: 'analysis',
    analysis_timestamp: '2026-09-03T00:00:00.000Z',
    system: {
      id: 'system',
      name: 'Review service',
      type: 'service',
      root_path: '/repo',
      technologies: {},
      quality: {},
    },
    nodes: [
      { id: 'review-node', name: 'review', type: 'controller' },
      { id: 'approve-node', name: 'approve', type: 'method' },
    ],
    edges: [],
    entry_points: [{
      id: 'review-entry',
      name: 'POST /applications/:id/approve',
      type: 'http',
      source_node: 'review-node',
      trigger: { method: 'POST', path: '/applications/:id/approve' },
    }],
    exit_points: [{
      id: 'approve-exit',
      name: 'Application approved',
      type: 'api',
      source_node: 'approve-node',
    }],
    entities: [{ id: 'application', name: 'Application', fields: [] }],
    flows: [{
      flow_id: 'approve-application',
      name: 'Approve application',
      intent: 'Approve an application',
      entry_point: 'review-entry',
      entities: ['application'],
      contract: {
        input: ['application'],
        logic: 'approve',
        constraints: [],
        output: ['Application approved'],
        side_effects: { state_changes: ['Application updated'], external_integrations: [] },
      },
      steps: [{
        step_id: 'approve-decision',
        order: 0,
        name: 'Approve the application',
        description: 'approve',
        description_source: 'deterministic-label',
        contract: {
          input: ['application'],
          logic: 'approve',
          constraints: [],
          output: [],
          side_effects: { state_changes: [], external_integrations: [] },
        },
        functions: [{ function_id: 'approve-node' }],
        entities: ['application'],
      }],
      terminus: { exit_point_id: 'approve-exit', kind: 'api', produces: 'Application approved', node_id: 'approve-node' },
    }],
    analyzer_contributions: [],
  } as any;

  assert.equal(cas.user_journeys, undefined);
  const result = getUserJourneys(cas) as any;
  assert.equal(result.total, 1);
  assert.equal(result.journeys[0].derived_from_flow_id, 'approve-application');
  assert.deepEqual(result.journeys[0].exit_point_ids, ['approve-exit']);
  assert.deepEqual(result.journeys[0].entities_written, ['Application']);
});
