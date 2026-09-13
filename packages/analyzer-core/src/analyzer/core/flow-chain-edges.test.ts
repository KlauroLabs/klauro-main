import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CASEdge, CASEntryPoint, FlowConcept } from '../../types/cas.types';
import { callDerivedFlowEdges } from './flow-chain-edges';

// Flow chains previously came only from capability dependencies and declared
// continuations. With AI off there are no capabilities, so there were no edges
// at all and every one of 939 flows came back terminal. Chains are now also
// derived from the call graph: when code inside one flow invokes the handler
// that another flow enters at, the first leads to the second.
//
// This needs entry points to be linked to their handlers, which is why it could
// not be done before that work.

function flow(id: string, entryPoint: string, functionIds: string[]): FlowConcept {
  return {
    flow_id: id,
    name: id,
    entry_point: entryPoint,
    steps: functionIds.map((functionId, index) => ({
      step_id: `${id}_${index}`,
      order: index,
      functions: [{ function_id: functionId }]
    }))
  } as unknown as FlowConcept;
}

function entryPoint(id: string, nodeId: string): CASEntryPoint {
  return { id, name: id, type: 'cli', handler: { node_id: nodeId } } as unknown as CASEntryPoint;
}

function edge(source: string, target: string, type = 'calls'): CASEdge {
  return { id: `${source}-${target}-${type}`, source, target, type } as unknown as CASEdge;
}

test('a flow whose code calls another flow entry leads to that flow', () => {
  const flows = [flow('A', 'epA', ['a_entry', 'a_helper']), flow('B', 'epB', ['b_entry'])];
  const entryPoints = [entryPoint('epA', 'a_entry'), entryPoint('epB', 'b_entry')];
  const derived = callDerivedFlowEdges({ flows, entryPoints, edges: [edge('a_helper', 'b_entry')] });
  assert.deepEqual(derived, [{ source: 'A', target: 'B' }]);
});

test('containment and imports do not make a chain', () => {
  const flows = [flow('A', 'epA', ['a_entry']), flow('B', 'epB', ['b_entry'])];
  const entryPoints = [entryPoint('epA', 'a_entry'), entryPoint('epB', 'b_entry')];
  const edges = [edge('a_entry', 'b_entry', 'contains'), edge('a_entry', 'b_entry', 'imports')];
  assert.deepEqual(callDerivedFlowEdges({ flows, entryPoints, edges }), []);
});

test('a call into the middle of another flow is not an entry into it', () => {
  // Reaching a helper that happens to belong to another flow is shared code,
  // not a continuation. Only the entry counts.
  const flows = [flow('A', 'epA', ['a_entry']), flow('B', 'epB', ['b_entry', 'b_helper'])];
  const entryPoints = [entryPoint('epA', 'a_entry'), entryPoint('epB', 'b_entry')];
  assert.deepEqual(callDerivedFlowEdges({ flows, entryPoints, edges: [edge('a_entry', 'b_helper')] }), []);
});

test('a flow calling itself is not a chain', () => {
  const flows = [flow('A', 'epA', ['a_entry', 'a_helper'])];
  const entryPoints = [entryPoint('epA', 'a_entry')];
  assert.deepEqual(callDerivedFlowEdges({ flows, entryPoints, edges: [edge('a_helper', 'a_entry')] }), []);
});

test('the same chain found twice is emitted once', () => {
  const flows = [flow('A', 'epA', ['a_one', 'a_two']), flow('B', 'epB', ['b_entry'])];
  const entryPoints = [entryPoint('epA', 'a_one'), entryPoint('epB', 'b_entry')];
  const edges = [edge('a_one', 'b_entry'), edge('a_two', 'b_entry')];
  assert.deepEqual(callDerivedFlowEdges({ flows, entryPoints, edges }), [{ source: 'A', target: 'B' }]);
});

test('a flow with no linked entry point falls back to its first step', () => {
  const flows = [flow('A', 'epA', ['a_entry']), flow('B', 'missing', ['b_first'])];
  const entryPoints = [entryPoint('epA', 'a_entry')];
  const derived = callDerivedFlowEdges({ flows, entryPoints, edges: [edge('a_entry', 'b_first')] });
  assert.deepEqual(derived, [{ source: 'A', target: 'B' }]);
});

test('no flows means no edges', () => {
  assert.deepEqual(callDerivedFlowEdges({ flows: [], entryPoints: [], edges: [edge('a', 'b')] }), []);
});
