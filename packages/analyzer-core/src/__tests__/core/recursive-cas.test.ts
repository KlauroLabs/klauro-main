import type { CASOutput } from '../../types/cas.types';
import { assertValidCasTree, namespaceCasTree, reidentifyCasTree, validateCasTree, walkCasTree } from '../../analyzer/core/recursive-cas';

function leaf(id: string, parentId: string | null): CASOutput {
  return {
    id,
    parent_id: parentId,
    label: id,
    cas_version: '3.0.0',
    analysis_timestamp: '2026-08-13T00:00:00.000Z',
    analysis_id: `analysis:${id}`,
    system: { id: `system:${id}`, name: id, type: 'application', root_path: id },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 0 },
  };
}

function parent(id: string, parentId: string | null, children: CASOutput[]): CASOutput {
  return { ...leaf(id, parentId), composition_mode: 'composed', children };
}

describe('recursive CAS conformance', () => {
  test('accepts the same CAS shape at arbitrary depth without a level vocabulary or maximum', () => {
    const depth = 12;
    let tree = leaf(`cas:${depth}`, `cas:${depth - 1}`);
    for (let index = depth - 1; index >= 1; index -= 1) {
      tree = parent(`cas:${index}`, index === 1 ? null : `cas:${index - 1}`, [tree]);
    }

    const result = validateCasTree(tree);
    expect(result).toEqual({ valid: true, node_count: depth, max_depth: depth - 1, issues: [] });
    expect(walkCasTree(tree).map(row => row.cas.id)).toEqual(
      Array.from({ length: depth }, (_, index) => `cas:${index + 1}`),
    );
    expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
  });

  test('rejects cycles, duplicate identities, broken parent chains, and non-leaf composition omissions', () => {
    const child = leaf('cas:child', 'cas:wrong-parent');
    const duplicate = leaf('cas:child', 'cas:root');
    const root = { ...parent('cas:root', null, [child, duplicate]), composition_mode: undefined };
    child.children = [root];
    child.composition_mode = 'derived';

    const result = validateCasTree(root);
    expect(result.valid).toBe(false);
    expect(new Set(result.issues.map(issue => issue.code))).toEqual(new Set([
      'missing-composition-mode',
      'parent-mismatch',
      'cycle',
      'duplicate-id',
    ]));
    expect(() => assertValidCasTree(root)).toThrow(/Recursive CAS conformance failed/);
  });

  test('requires leaves to omit both children and composition mode', () => {
    const invalidLeaf = { ...leaf('cas:leaf', null), children: [], composition_mode: 'derived' as const };
    const result = validateCasTree(invalidLeaf);
    expect(result.valid).toBe(false);
    expect(result.issues.map(issue => issue.code).sort()).toEqual(['empty-children', 'leaf-composition-mode']);
  });

  test('namespaces every recursive CAS identity and its composition graph references', () => {
    const child = leaf('cas:child', 'cas:root');
    const root = parent('cas:root', null, [child]);
    root.nodes = [{
      id: 'cas:child',
      name: 'child',
      type: 'cas',
      metadata: { attributes: { cas_id: 'cas:child' } },
    }];
    root.edges = [{ id: 'edge:child', source: 'cas:root', target: 'cas:child', type: 'contains' }];
    root.terminality = {
      nodes: [{ id: 'cas:child', terminal: true, proximal_terminal: false, distance_to_terminal: 0, incoming: 1, outgoing: 0, strongly_connected_size: 1 }],
      entities: [],
      flows: [],
      capabilities: [],
    };

    const namespaced = namespaceCasTree(root, 'workspace:alpha');

    expect(namespaced.id).toBe('workspace:alpha:cas:root');
    expect(namespaced.children?.[0]).toMatchObject({
      id: 'workspace:alpha:cas:child',
      parent_id: 'workspace:alpha:cas:root',
    });
    expect(namespaced.terminality?.nodes[0].id).toBe('workspace:alpha:cas:child');
    expect(namespaced.nodes[0]).toMatchObject({
      id: 'workspace:alpha:cas:child',
      metadata: { attributes: { cas_id: 'workspace:alpha:cas:child' } },
    });
    expect(namespaced.edges[0]).toMatchObject({
      source: 'workspace:alpha:cas:root',
      target: 'workspace:alpha:cas:child',
    });
    expect(validateCasTree(namespaced).valid).toBe(true);
    expect(root.id).toBe('cas:root');
  });

  test('reidentifies a complete CAS tree while preserving non-identity fields', () => {
    const child = leaf('cas:child', 'cas:root');
    child.nodes = [{ id: 'child-node', name: 'child node', type: 'function' }];
    const root = parent('cas:root', null, [child]);
    root.nodes = [{
      id: 'cas:child',
      name: 'child',
      type: 'cas',
      metadata: { attributes: { cas_id: 'cas:child' } },
    }];
    root.edges = [{ id: 'edge:child', source: 'cas:root', target: 'cas:child', type: 'contains' }];
    root.dependencies = { manager: 'npm', packages: [{ name: 'dependency', version: '1.0.0', direct: true }] };

    const reidentified = reidentifyCasTree(root, 'workspace:member', 'member');

    expect(reidentified.id).toBe('workspace:member');
    expect(reidentified.label).toBe('member');
    expect(reidentified.dependencies).toBe(root.dependencies);
    expect(reidentified.children?.[0]).toMatchObject({
      id: 'workspace:member:cas:child',
      parent_id: 'workspace:member',
      nodes: child.nodes,
    });
    expect(reidentified.nodes[0]).toMatchObject({
      id: 'workspace:member:cas:child',
      metadata: { attributes: { cas_id: 'workspace:member:cas:child' } },
    });
    expect(reidentified.edges[0]).toMatchObject({
      source: 'workspace:member',
      target: 'workspace:member:cas:child',
    });
    expect(validateCasTree(reidentified).valid).toBe(true);
    expect(root.id).toBe('cas:root');
    expect(child.id).toBe('cas:child');
  });
});
