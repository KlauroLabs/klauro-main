import { computeCapabilityTelemetry, unexercisedFlows, type FlowConcept, type ContractTelemetry } from '../../analyzer/core/flow-concepts';

/**
 * Tier 4 capability-level rollup + "unexercised paths" (docs/analysis-scope/
 * SPECIFICATION.md §8) — closes the gap left by the flow/step telemetry join
 * (attachTelemetryToFlows) alone: a capability aggregates telemetry ACROSS its
 * flows, and "exercised vs dormant" needs that aggregate, not a per-flow fact.
 *
 * Fixtures below build minimal FlowConcept-shaped objects (only the fields
 * computeCapabilityTelemetry/unexercisedFlows actually read) rather than
 * running the full computeFlowConcepts pipeline — this module's contract is
 * narrow and pure over flow_id/name/entry_point/contract.telemetry.
 */

function flow(id: string, telemetry?: ContractTelemetry): FlowConcept {
  return {
    flow_id: id,
    name: `flow ${id}`,
    intent: 'test flow',
    entry_point: `ep_${id}`,
    entities: [],
    contract: { input: [], logic: '', side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [], telemetry },
    steps: [],
  } as unknown as FlowConcept;
}

const tel = (requestCount: number, errorRate: number, p95?: number): ContractTelemetry => ({
  static_id: 'x',
  request_count: requestCount,
  error_rate: errorRate,
  p95_ms: p95,
  source: 'ingested',
  last_seen: '2026-08-01T00:00:00.000Z',
});

describe('computeCapabilityTelemetry — capability-level exercised/dormant rollup', () => {
  test('full coverage, all flows observed -> exercised, not dormant, aggregated request_count/error_rate', () => {
    const flows = [flow('f1', tel(100, 0.1, 20)), flow('f2', tel(300, 0.02, 40))];
    const capabilities = [{ id: 'cap1', related_flows: [{ flow_id: 'f1' }, { flow_id: 'f2' }] }];

    const [result] = computeCapabilityTelemetry(capabilities, flows);
    expect(result.coverage).toBe('full');
    expect(result.exercised).toBe(true);
    expect(result.dormant).toBe(false);
    expect(result.flows_total).toBe(2);
    expect(result.flows_observed).toBe(2);
    expect(result.request_count).toBe(400);
    // weighted error rate: (100*0.1 + 300*0.02) / 400 = (10 + 6) / 400 = 0.04
    expect(result.error_rate).toBeCloseTo(0.04, 5);
    expect(result.p95_ms).toBe(40);
  });

  test('full coverage, zero flows observed -> dormant is asserted (only case it ever is)', () => {
    const flows = [flow('f1'), flow('f2')];
    const capabilities = [{ id: 'cap1', related_flows: [{ flow_id: 'f1' }, { flow_id: 'f2' }] }];

    const [result] = computeCapabilityTelemetry(capabilities, flows);
    expect(result.coverage).toBe('full');
    expect(result.exercised).toBe(false);
    expect(result.dormant).toBe(true);
    expect(result.request_count).toBe(0);
  });

  test('partial coverage never asserts dormant, even with zero observed among the in-scope flows', () => {
    const flows = [flow('f1')]; // f2 was not part of this call's computed set at all
    const capabilities = [{ id: 'cap1', related_flows: [{ flow_id: 'f1' }, { flow_id: 'f2' }] }];

    const [result] = computeCapabilityTelemetry(capabilities, flows);
    expect(result.coverage).toBe('partial');
    expect(result.dormant).toBe(false);
    // still tells the truth about what WAS observed in scope
    expect(result.exercised).toBe(false);
    expect(result.flows_in_scope).toBe(1);
    expect(result.flows_total).toBe(2);
  });

  test('none of a capability\'s flows were computed this call -> exercised is undefined, not false', () => {
    const flows = [flow('other')];
    const capabilities = [{ id: 'cap1', related_flows: [{ flow_id: 'f1' }] }];

    const [result] = computeCapabilityTelemetry(capabilities, flows);
    expect(result.coverage).toBe('none');
    expect(result.exercised).toBeUndefined();
    expect(result.dormant).toBe(false);
  });

  test('a capability with no related_flows is skipped entirely (not a zero-observation claim)', () => {
    const flows = [flow('f1', tel(10, 0))];
    const capabilities = [{ id: 'cap-unknown', related_flows: [] }];
    expect(computeCapabilityTelemetry(capabilities, flows)).toEqual([]);
  });
});

describe('unexercisedFlows — paths that exist in source but never ran in production', () => {
  test('flags flows with no contract.telemetry only when real metrics were supplied for the scope', () => {
    const flows = [flow('f1', tel(50, 0)), flow('f2')];
    const metrics = [{ static_id: 'n1', request_count: 1, error_rate: 0 }];

    const result = unexercisedFlows(flows, metrics);
    expect(result).toEqual([{ flow_id: 'f2', name: 'flow f2', entry_point: 'ep_f2' }]);
  });

  test('empty metrics never asserts anything unexercised — absence of telemetry data is a different fact than instrumented-and-silent', () => {
    const flows = [flow('f1'), flow('f2')];
    expect(unexercisedFlows(flows, [])).toEqual([]);
  });
});
