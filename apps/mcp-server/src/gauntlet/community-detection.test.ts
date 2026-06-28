import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCommunities } from '../../../../packages/analyzer-core/src/analyzer/core/community-detection';

// Structural parity with codebase-memory's Louvain community detection: cluster
// the call graph into functional modules. Two tightly-connected triangles with a
// single weak bridge must resolve to two communities.

test('Louvain splits two weakly-bridged clusters into two communities', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'];
  const edges = [
    // triangle 1
    { source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' },
    // triangle 2
    { source: 'd', target: 'e' }, { source: 'e', target: 'f' }, { source: 'f', target: 'd' },
    // weak bridge
    { source: 'c', target: 'd' },
  ];
  const communities = detectCommunities(nodes, edges);
  assert.equal(communities.length, 2, `expected 2 communities, got ${JSON.stringify(communities)}`);
  const sets = communities.map(c => c.members.join(',')).sort();
  assert.deepEqual(sets, ['a,b,c', 'd,e,f'], `wrong split: ${JSON.stringify(sets)}`);
  // Cohesion: each triangle has 3 internal edges.
  assert.ok(communities.every(c => c.internal_edges === 3), 'each triangle has 3 internal edges');
});

test('Louvain is deterministic — same graph, same result', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'];
  const edges = [
    { source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' },
    { source: 'd', target: 'e' }, { source: 'e', target: 'f' }, { source: 'f', target: 'd' },
    { source: 'c', target: 'd' },
  ];
  const a = JSON.stringify(detectCommunities(nodes, edges));
  const b = JSON.stringify(detectCommunities(nodes, edges));
  assert.equal(a, b);
});

test('Louvain returns no communities for an edgeless graph', () => {
  assert.deepEqual(detectCommunities(['a', 'b', 'c'], []), []);
});
