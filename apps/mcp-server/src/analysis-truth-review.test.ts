import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildAnalysisTruthReview } from './analysis-truth-review';

test('truth review preserves named terminality and source-backed flow evidence', () => {
  const cas = {
    system: { name: 'orders', type: 'service', technologies: { languages: [], frameworks: [] } },
    nodes: [{ id: 'auth', name: 'Authenticate', type: 'function' }, { id: 'order', name: 'PlaceOrder', type: 'function' }],
    edges: [{ source: 'auth', target: 'order', type: 'calls' }],
    entry_points: [
      { id: 'entry-auth', name: 'Sign in', type: 'http', handler: { file: 'src/auth.ts' } },
      { id: 'entry-order', name: 'Place order', type: 'http', handler: { file: 'src/orders.ts' } },
    ],
    exit_points: [],
    analyzer_contributions: [],
    analysis_errors: [],
    entities: [],
    capabilities: [],
    user_journeys: [],
    flows: [
      {
        flow_id: 'auth-flow', name: 'Sign in', intent: 'Authenticate', entry_point: 'entry-auth', capability_id: 'auth-cap', entities: [],
        contract: { input: [], logic: '', side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
        steps: [], continuations: ['order-flow'],
      },
      {
        flow_id: 'order-flow', name: 'Place order', intent: 'Purchase', entry_point: 'entry-order', capability_id: 'order-cap', entities: [],
        contract: { input: [], logic: '', side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
        steps: [],
      },
    ],
    terminality: {
      nodes: [], entities: [], capabilities: [],
      flows: [
        { id: 'order-flow', terminal: true, proximal_terminal: false, distance_to_terminal: 0, incoming: 1, outgoing: 0, strongly_connected_size: 1 },
        { id: 'auth-flow', terminal: false, proximal_terminal: true, distance_to_terminal: 1, incoming: 0, outgoing: 1, strongly_connected_size: 1 },
      ],
    },
    progressive_levels: {} as any,
  } as unknown as CASOutput;

  const review = buildAnalysisTruthReview(cas, '/workspace/orders');

  assert.equal(review.terminality.terminal_flows[0].name, 'Place order');
  assert.equal(review.terminality.proximal_flows[0].name, 'Sign in');
  assert.equal(review.terminality.flow_evidence.find(flow => flow.id === 'order-flow')?.entry_file, 'src/orders.ts');
  assert.equal(review.comprehension.ready, false);
});
