import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerOrchestrator } from './orchestrator';
import type { CASCallChain, FlowConcept } from '../../types/cas.types';

function flow(id: string, stepCount: number, capabilityId?: string): FlowConcept {
  return {
    flow_id: id,
    name: id,
    intent: id,
    entry_point: `entry::${id}`,
    capability_id: capabilityId,
    capability_relationships: capabilityId ? [{ capability_id: capabilityId, role: 'primary', rationale: 'entry point' }] : undefined,
    entities: [],
    contract: { input: [], logic: id, side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
    steps: Array.from({ length: stepCount }, (_, index) => ({
      step_id: `${id}::step${index}`,
      order: index,
      name: `Step ${index}`,
      description: `Executes step ${index} of the materialized flow.`,
      description_source: 'deterministic-label',
      contract: { input: [], logic: `step ${index}`, side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
      functions: [],
      entities: [],
    })),
  };
}

test('canonical flows retain full steps and receive call-chain criticality', () => {
  const flows = [flow('flow::chain::create-order', 2, 'capability::orders'), flow('flow::entry::tool', 1)];
  const chains = [{ id: 'chain::create-order', criticality: 'critical' }] as unknown as CASCallChain[];
  const orchestrator = new AnalyzerOrchestrator() as any;
  orchestrator.stampFlowCriticality(flows, chains);

  assert.equal(flows[0].criticality, 'critical');
  assert.equal(flows[0].steps.length, 2);
  assert.equal(flows[1].criticality, undefined);
});

test('every capability flow reference resolves to one canonical full flow', () => {
  const flows = [flow('flow::orders', 2, 'capability::orders'), flow('flow::tools', 1, 'capability::tools')];
  const capabilities = [{
    id: 'capability::orders',
    related_flows: [
      { flow_id: 'flow::orders', role: 'primary', rationale: 'entry point' },
      { flow_id: 'flow::tools', role: 'supporting', rationale: 'shared behavior' },
    ],
  }];
  const resolvable = new Set(flows.map(candidate => candidate.flow_id));
  const dangling = capabilities.flatMap(capability => capability.related_flows)
    .map(reference => reference.flow_id)
    .filter(flowId => !resolvable.has(flowId));
  assert.deepEqual(dangling, []);
});

test('every canonical step id is namespaced by its containing flow', () => {
  const flows = [flow('flow::orders', 3), flow('flow::tools', 2)];
  for (const candidate of flows) {
    for (const step of candidate.steps) {
      assert.ok(step.step_id.startsWith(`${candidate.flow_id}::step`));
    }
  }
});

test('workflow references resolve to canonical flows', () => {
  const flows = [flow('flow::deploy', 2), flow('flow::verify', 1)];
  const purpose = { primary_workflow_id: 'flow::deploy', supporting_workflow_ids: ['flow::verify'] };
  const known = new Set(flows.map(candidate => candidate.flow_id));
  const references = [purpose.primary_workflow_id, ...purpose.supporting_workflow_ids];
  assert.deepEqual(references.filter(id => !known.has(id)), []);
});
