import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { evaluateCapabilityMemoryTarget } from './agent-capability-memory-benchmark';

test('capability-memory proof evaluates the product CAS instead of requiring a second analysis', async () => {
  const cas = {
    id: 'analysis-storefront',
    version: '1.10.0',
    generated_at: new Date().toISOString(),
    system: {
      name: 'Storefront',
      type: 'application',
      description: 'A commerce storefront.',
      technologies: { languages: [{ name: 'JavaScript', percentage: 100 }], frameworks: [], databases: [] },
    },
    nodes: [{
      id: 'cart-owner',
      name: 'CartOwner',
      type: 'service',
      source: { file: 'src/cart.js', line_start: 1, line_end: 20 },
    }],
    edges: [],
    entry_points: [],
    analyzer_contributions: [],
    capabilities: [{
      id: 'capability-cart',
      name: 'Manage carts',
      description: 'Lets shoppers add products and adjust quantities before checkout.',
      category: 'core',
      operations: [{
        entry_point_id: 'cart-owner',
        entry_point_type: 'ui-event',
        action: 'adjust cart quantities',
        path_or_command: 'src/cart.js',
      }],
      related_entities: ['Cart', 'Product'],
      related_domains: ['commerce'],
      criticality: 'high',
      criticality_factors: ['core product outcome'],
    }],
  } as unknown as CASOutput;

  const result = await evaluateCapabilityMemoryTarget(
    { name: 'storefront', path: '/path/that/does/not/exist' },
    cas,
    3,
  );

  assert.equal(result.capability_count, 1);
  assert.equal(result.trial_count, 1);
  assert.equal(result.status, 'pass');
  assert.equal(result.trials[0].with_klauro.matched_requested_capability, true);
  assert.equal(result.trials[0].with_klauro.reuse_decision_present, true);
  assert.ok(result.trials[0].delta > 0);
});
