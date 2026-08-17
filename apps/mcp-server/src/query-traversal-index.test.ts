import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getQueryTraversalIndex } from './query-traversal-index';

test('query traversal index reuses directional graph and method-call lookups', () => {
  const cas = {
    nodes: [
      { id: 'caller', name: 'Caller', type: 'function' },
      { id: 'target', name: 'Target', type: 'function' },
    ],
    edges: [{ id: 'edge', source: 'caller', target: 'target', type: 'calls' }],
    method_calls: [{ id: 'call', caller_node: 'caller', target_node: 'target', call_details: { method_name: 'target' } }],
  } as unknown as CASOutput;

  const first = getQueryTraversalIndex(cas);
  const second = getQueryTraversalIndex(cas);

  assert.equal(first, second);
  assert.deepEqual(first.incomingEdges.get('target')?.map(edge => edge.id), ['edge']);
  assert.deepEqual(first.outgoingMethodCalls.get('caller')?.map(call => call.id), ['call']);
});
