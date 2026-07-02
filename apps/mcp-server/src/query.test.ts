import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput, CASNode, CASEdge } from '../../../packages/analyzer-core/src/types/cas.types';
import { getCodingContext } from './query';

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
