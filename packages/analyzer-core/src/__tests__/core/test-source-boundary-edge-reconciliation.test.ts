import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { dropEdgesReferencingRemovedEndpoints, checkEdgeReferentialIntegrity } from '../../analyzer/core/graph-referential-integrity';
import type { CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';

/**
 * THE DEFECT UNDER TEST: the test-source boundary drops the entry and exit
 * points owned by test code (a `vi.fn()` in a spec is not a product surface)
 * but the `calls` edges pointing at those exit points survived. Measured on a
 * real repository: 17,656 `calls` edges targeting ids present in no
 * collection, dominated by spec-file call sites (`expect`, `fireEvent`,
 * `vi.spyOn`) — the single largest source of graph endpoints that resolve
 * nowhere.
 */
function node(id: string, file: string): CASNode {
  return { id, name: id, type: 'function', level: 3, source: { file, line: 1 }, metadata: {} } as CASNode;
}

describe('test-source boundary reconciles the edges it orphans', () => {
  it('drops the calls edge whose exit point the boundary discarded', () => {
    const analyzer = new TypeScriptJavaScriptAnalyzer() as any;
    const nodes = [
      node('prod', 'src/service.ts'),
      node('spec', 'src/__tests__/service.test.ts'),
    ];
    const entryPoints: CASEntryPoint[] = [
      { id: 'entry_prod', source_node: 'prod', type: 'http', name: 'GET /x' } as CASEntryPoint,
      { id: 'entry_spec', source_node: 'spec', type: 'test', name: 'it works' } as CASEntryPoint,
    ];
    const exitPoints: CASExitPoint[] = [
      { id: 'exit_sdk_prod_fetch_4', source_node: 'prod', type: 'sdk', name: 'fetch' } as CASExitPoint,
      { id: 'exit_sdk_spec_expect_9', source_node: 'spec', type: 'sdk', name: 'expect' } as CASExitPoint,
    ];
    const edges: CASEdge[] = [
      { id: 'e_prod', source: 'prod', target: 'exit_sdk_prod_fetch_4', type: 'calls' } as CASEdge,
      { id: 'e_spec', source: 'spec', target: 'exit_sdk_spec_expect_9', type: 'calls' } as CASEdge,
      { id: 'e_entry_spec', source: 'entry_spec', target: 'spec', type: 'handles' } as CASEdge,
    ];

    analyzer.applyTestSourceBoundary(nodes, entryPoints, exitPoints, edges);

    expect(exitPoints.map(e => e.id)).toEqual(['exit_sdk_prod_fetch_4']);
    expect(entryPoints.map(e => e.id)).toEqual(['entry_prod']);
    expect(edges.map(e => e.id)).toEqual(['e_prod']);

    // The whole point: nothing left over that resolves nowhere.
    const report = checkEdgeReferentialIntegrity(edges, { nodes, entry_points: entryPoints, exit_points: exitPoints });
    expect(report.dangling_edges).toBe(0);

    // Test code itself stays in the graph, tagged.
    expect(nodes.map(n => n.id)).toEqual(['prod', 'spec']);
    expect(nodes[1].metadata).toMatchObject({ is_test: true });
  });
});

describe('dropEdgesReferencingRemovedEndpoints', () => {
  it('removes edges on either endpoint and leaves the rest in order', () => {
    const edges = [
      { id: 'a', source: 'n1', target: 'n2' },
      { id: 'b', source: 'n1', target: 'gone' },
      { id: 'c', source: 'gone', target: 'n2' },
      { id: 'd', source: 'n2', target: 'n3' },
    ];
    const dropped = dropEdgesReferencingRemovedEndpoints(edges, new Set(['gone']));
    expect(dropped).toBe(2);
    expect(edges.map(e => e.id)).toEqual(['a', 'd']);
  });

  it('is a no-op when nothing was removed', () => {
    const edges = [{ id: 'a', source: 'n1', target: 'n2' }];
    expect(dropEdgesReferencingRemovedEndpoints(edges, new Set())).toBe(0);
    expect(edges).toHaveLength(1);
  });
});
