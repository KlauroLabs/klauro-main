import assert from 'node:assert/strict';
import test from 'node:test';
import { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';
import { assignNodeRoles } from './node-roles';

test('controller grouping selects the closest structural owner independent of edge order', () => {
  const build = (reverse: boolean) => {
    const nodes = [
      { id: 'file', name: 'routes.tsx', type: 'file', level: 1 },
      { id: 'component', name: 'Routes', type: 'component', level: 2 },
      { id: 'route-a', name: '/a', type: 'route', level: 3 },
      { id: 'route-b', name: '/b', type: 'route', level: 3 },
    ] as CASNode[];
    const edges = [
      { id: 'file-a', source: 'file', target: 'route-a', type: 'contains' },
      { id: 'component-a', source: 'component', target: 'route-a', type: 'contains' },
      { id: 'file-b', source: 'file', target: 'route-b', type: 'contains' },
      { id: 'component-b', source: 'component', target: 'route-b', type: 'contains' },
    ] as CASEdge[];
    const entryPoints = [
      { id: 'entry-a', type: 'route', source_node: 'route-a', handler: { node_id: 'route-a' } },
      { id: 'entry-b', type: 'route', source_node: 'route-b', handler: { node_id: 'route-b' } },
    ] as CASEntryPoint[];
    assignNodeRoles({ nodes, edges: reverse ? edges.reverse() : edges, entry_points: entryPoints });
    return nodes;
  };

  for (const nodes of [build(false), build(true)]) {
    assert.equal(nodes.find(node => node.id === 'component')?.role, 'controller');
    assert.equal(nodes.find(node => node.id === 'file')?.role, undefined);
  }
});
