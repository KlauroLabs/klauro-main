import { removeTestEntryPoints } from '../../analyzer/core/analysis-comprehension-surface';
import type { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';

function node(id: string, type: string, file: string, categories: string[] = []): CASNode {
  return {
    id,
    name: id,
    type,
    level: 3,
    category: categories[0] || 'code',
    categories,
    source: { file, line: 1 },
    metadata: {},
  } as CASNode;
}

describe('test entry-point separation', () => {
  it('keeps test evidence in nodes while removing it from the production entry surface', () => {
    const nodes = [
      node('route', 'method', 'src/users.controller.ts'),
      node('unit', 'test', 'src/users.controller.spec.ts', ['test']),
      node('browser', 'cypress_test', 'cypress/e2e/login.cy.ts'),
    ];
    const entryPoints = [
      { id: 'http-entry', source_node: 'route', type: 'http', name: 'GET /users' },
      { id: 'unit-entry', source_node: 'unit', type: 'test', name: 'returns users' },
      {
        id: 'browser-entry',
        source_node: 'browser',
        type: 'event',
        name: 'logs in',
        metadata: { attributes: { test_framework: 'cypress' } },
      },
    ] as CASEntryPoint[];
    const edges = [
      { id: 'route-edge', source: 'route', target: 'http-entry', type: 'handles' },
      { id: 'test-edge', source: 'unit', target: 'unit-entry', type: 'handles' },
    ] as CASEdge[];

    removeTestEntryPoints(nodes, edges, entryPoints, () => false);

    expect(entryPoints.map(entryPoint => entryPoint.id)).toEqual(['http-entry']);
    expect(edges.map(edge => edge.id)).toEqual(['route-edge']);
    expect(nodes.map(item => item.id)).toEqual(['route', 'unit', 'browser']);
  });
});
