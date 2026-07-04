import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASNode, CASEdge, CASEntryPoint } from '../../../packages/analyzer-core/src/types/cas.types';
import { getCodingContext, getFlowConcepts } from './query';

// Builds a synthetic CAS with a single high-fanout "hub" node that has more
// callers/callees than the default display limit, plus a handful of
// low-fanout nodes for control/comparison.
function buildHighFanoutCas(opts: { callerCount: number; calleeCount: number }): CASOutput {
  const nodes: CASNode[] = [];
  const edges: CASEdge[] = [];

  const hubId = 'class_hub_Hub_0';
  nodes.push({
    id: hubId,
    name: 'Hub',
    type: 'class',
    source: { file: 'src/hub.ts', line: 1 },
    metadata: {},
  } as CASNode);

  for (let i = 0; i < opts.callerCount; i++) {
    const callerId = `class_caller_${i}_Caller${i}_0`;
    nodes.push({
      id: callerId,
      name: `Caller${i}`,
      type: 'class',
      source: { file: `src/caller${i}.ts`, line: 1 },
      metadata: {},
    } as CASNode);
    edges.push({ id: `edge_caller_${i}`, source: callerId, target: hubId, type: 'uses' });
  }

  for (let i = 0; i < opts.calleeCount; i++) {
    const calleeId = `class_callee_${i}_Callee${i}_0`;
    nodes.push({
      id: calleeId,
      name: `Callee${i}`,
      type: 'class',
      source: { file: `src/callee${i}.ts`, line: 1 },
      metadata: {},
    } as CASNode);
    edges.push({ id: `edge_callee_${i}`, source: hubId, target: calleeId, type: 'uses' });
  }

  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-high-fanout-test',
    system: { id: 'system-test', name: 'high-fanout-test', type: 'service', root_path: '/tmp/high-fanout' },
    nodes,
    edges,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('getCodingContext reports truncated:true with real totals when a node has more callers/callees than the default limit', () => {
  const cas = buildHighFanoutCas({ callerCount: 45, calleeCount: 30 });
  const context: any = getCodingContext(cas, 'class_hub_Hub_0');

  const connected = context.connected_code;
  assert.ok(connected, 'connected_code should be present');

  // Default limit is 10, so only 10 of the 45 real callers / 30 real callees come back.
  assert.equal(connected.callers.length, 10);
  assert.equal(connected.callees.length, 10);

  // Truncation must be signaled, not silent.
  assert.equal(connected.truncated, true);
  assert.equal(connected.callers_total, 45);
  assert.equal(connected.callees_total, 30);
  assert.ok(connected.callers_total > connected.callers.length);
  assert.ok(connected.callees_total > connected.callees.length);
  assert.ok(typeof connected.truncation_hint === 'string' && connected.truncation_hint.length > 0);
});

test('getCodingContext returns the full caller/callee set when given a larger limit, and truncated is false when nothing is cut', () => {
  const cas = buildHighFanoutCas({ callerCount: 45, calleeCount: 30 });
  const context: any = getCodingContext(cas, 'class_hub_Hub_0', { caller_limit: 45, callee_limit: 30 });

  const connected = context.connected_code;
  assert.equal(connected.callers.length, 45);
  assert.equal(connected.callees.length, 30);
  assert.equal(connected.callers_total, 45);
  assert.equal(connected.callees_total, 30);
  assert.equal(connected.truncated, false);
  assert.equal(connected.truncation_hint, undefined);
});

test('getCodingContext does not signal truncation for a low-fanout node under the default limit', () => {
  const cas = buildHighFanoutCas({ callerCount: 3, calleeCount: 2 });
  const context: any = getCodingContext(cas, 'class_hub_Hub_0');

  const connected = context.connected_code;
  assert.equal(connected.callers.length, 3);
  assert.equal(connected.callees.length, 2);
  assert.equal(connected.callers_total, 3);
  assert.equal(connected.callees_total, 2);
  assert.equal(connected.truncated, false);
});

// Builds a CAS where the same callee/caller node is reachable both via a plain
// graph edge AND via a method_call record (a real shape: an analyzer can emit
// a `uses`/`calls` edge for a call site as well as a richer method_call record
// for the same call). Before the dedup fix, getCallees/getCallers (and
// therefore getCodingContext's connected_code) listed such a node twice.
function buildDualPathCas(): CASOutput {
  const callerId = 'function_src/a.ts_caller_0';
  const calleeId = 'function_src/b.ts_callee_0';
  const nodes: CASNode[] = [
    { id: callerId, name: 'caller', type: 'function', source: { file: 'src/a.ts', line: 1 }, metadata: {} } as CASNode,
    { id: calleeId, name: 'callee', type: 'function', source: { file: 'src/b.ts', line: 1 }, metadata: {} } as CASNode,
  ];
  const edges: CASEdge[] = [
    { id: 'edge_1', source: callerId, target: calleeId, type: 'calls' },
  ];
  const method_calls = [
    {
      id: 'mc_1',
      caller_node: callerId,
      target_node: calleeId,
      call_details: { method_name: 'callee' },
    },
  ] as unknown as CASOutput['method_calls'];

  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-dual-path-test',
    system: { id: 'system-test', name: 'dual-path-test', type: 'service', root_path: '/tmp/dual-path' },
    nodes,
    edges,
    method_calls,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('getCodingContext connected_code.callees is deduplicated when a node is reachable via both an edge and a method_call record', () => {
  const cas = buildDualPathCas();
  const context: any = getCodingContext(cas, 'function_src/a.ts_caller_0');

  const calleeIds = context.connected_code.callees.map((c: any) => c.id);
  assert.equal(calleeIds.length, 1, `expected exactly one deduped callee, got: ${JSON.stringify(calleeIds)}`);
  assert.equal(context.connected_code.callees_total, 1);
});

test('getCodingContext connected_code.callers is deduplicated when a node is reachable via both an edge and a method_call record', () => {
  const cas = buildDualPathCas();
  const context: any = getCodingContext(cas, 'function_src/b.ts_callee_0');

  const callerIds = context.connected_code.callers.map((c: any) => c.id);
  assert.equal(callerIds.length, 1, `expected exactly one deduped caller, got: ${JSON.stringify(callerIds)}`);
  assert.equal(context.connected_code.callers_total, 1);
});

test('getCodingContext degrades gracefully (never a bare error) when the target is missing from a fresh analysis', () => {
  const cas = buildHighFanoutCas({ callerCount: 1, calleeCount: 1 });
  const context: any = getCodingContext(cas, 'thisSymbolDoesNotExistAnywhere');

  assert.ok(typeof context.error === 'string' && context.error.length > 0);
  assert.equal(context.target, 'thisSymbolDoesNotExistAnywhere');
  assert.ok(Array.isArray(context.near_matches));
  assert.ok(typeof context.analysis_age_hint === 'string' && context.analysis_age_hint.length > 0);
  assert.ok(Array.isArray(context.next_steps) && context.next_steps.length > 0);
  // Must nudge toward the staleness-check tool and (if the tool itself seems
  // broken) get_server_version — never a dead end.
  assert.ok(context.next_steps.some((s: string) => s.includes('get_analysis_freshness')));
  assert.ok(context.next_steps.some((s: string) => s.includes('get_server_version')));
});

test('getCodingContext offers near-name matches for a typo close to a real node name', () => {
  const cas = buildHighFanoutCas({ callerCount: 2, calleeCount: 2 });
  // "Hubb" is a one-character-off typo of the real node name "Hub".
  const context: any = getCodingContext(cas, 'Hubb');

  assert.ok(typeof context.error === 'string');
  assert.ok(context.near_matches.some((m: any) => m.name === 'Hub'), `expected a near match for "Hub", got: ${JSON.stringify(context.near_matches)}`);
});

// Builds a CAS with `entryPointCount` independent traceable entry points
// (each a small function with its own name/route), so getFlowConcepts has
// one candidate flow per entry point when no `target` filter is given —
// the shape that produced 1,133 flows (~1.87MB / ~467k tokens) on the real
// proof-of-concept repo before the default flow cap was added.
function buildManyEntryPointsCas(entryPointCount: number): CASOutput {
  const nodes: CASNode[] = [];
  const entry_points: CASEntryPoint[] = [];

  for (let i = 0; i < entryPointCount; i++) {
    const nodeId = `function_src/handlers/handler${i}.ts_handler${i}_0`;
    nodes.push({
      id: nodeId,
      name: `handler${i}`,
      type: 'function',
      source: { file: `src/handlers/handler${i}.ts`, line: 1 },
      metadata: {},
    } as CASNode);
    entry_points.push({
      id: `entry_${i}`,
      type: 'http_route',
      name: `handler${i}`,
      source_node: nodeId,
      trigger: { method: 'GET', path: `/handler${i}` },
    } as unknown as CASEntryPoint);
  }

  return {
    cas_version: '1.11.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-many-entry-points-test',
    system: { id: 'system-test', name: 'many-entry-points-test', type: 'service', root_path: '/tmp/many-entry-points' },
    nodes,
    edges: [],
    entry_points,
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

test('getFlowConcepts defaults to a bounded number of flows (not one per entry point) when no target is given', () => {
  const cas = buildManyEntryPointsCas(200);
  const result: any = getFlowConcepts(cas, {});

  // Default cap (15) must kick in, not "all 200 entry points".
  assert.ok(result.flows.length <= 15, `expected <= 15 flows by default, got ${result.flows.length}`);
  assert.equal(result.total, result.flows.length);
  assert.equal(result.truncated, true);
  assert.ok(result.total_available >= 200, `expected total_available to reflect the real entry point count, got ${result.total_available}`);
  assert.ok(
    (result.gaps || []).some((g: string) => g.includes('max_flows')),
    `expected a gap explaining the default cap, got: ${JSON.stringify(result.gaps)}`,
  );
});

test('getFlowConcepts returns every flow when max_flows is explicitly raised past the real count', () => {
  const cas = buildManyEntryPointsCas(20);
  const result: any = getFlowConcepts(cas, { maxFlows: 20 });

  assert.equal(result.flows.length, 20);
  assert.equal(result.total, 20);
  assert.equal(result.truncated, false);
});

test('getFlowConcepts does not apply the default browse-cap when target narrows to a specific entry point', () => {
  const cas = buildManyEntryPointsCas(200);
  const result: any = getFlowConcepts(cas, { target: 'handler5' });

  // A targeted lookup is already narrow (matches only entry points whose
  // id/name/route contains "handler5" — here just one), so it should not
  // additionally get capped/truncated by the all-flows default.
  assert.equal(result.truncated, false);
  assert.ok(result.flows.length >= 1);
});
