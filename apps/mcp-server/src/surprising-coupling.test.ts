import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surprisingCoupling } from './surprising-coupling';

test('a small community reaching into a hub of another through one link is reported', () => {
  const hubMembers = Array.from({ length: 12 }, (_, at) => `hub${at}`);
  const callers = hubMembers.slice(1);
  const edges = callers.map(source => ({ source, target: 'hub0' }));
  edges.push({ source: 'edge0', target: 'hub0' });
  const communities = [
    { id: 1, members: hubMembers, internal_edges: callers.length },
    { id: 2, members: ['edge0', 'edge1'], internal_edges: 1 },
  ];
  const found = surprisingCoupling(communities, edges, id => id);
  assert.equal(found.length, 1);
  assert.equal(found[0].from, 'edge0');
  assert.equal(found[0].to, 'hub0');
  assert.equal(found[0].links_between_the_communities, 1);
});

test('links inside one community and between many-linked communities are not surprising', () => {
  const members = Array.from({ length: 10 }, (_, at) => `a${at}`);
  const edges = members.slice(1).map(source => ({ source, target: 'a0' }));
  assert.deepEqual(surprisingCoupling([{ id: 1, members, internal_edges: 9 }], edges, id => id), []);
});
