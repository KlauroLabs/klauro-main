import type { CASOutput } from '../../types/cas.types';
import { composeCas } from '../../analyzer/core/cas-composition';
import { validateCasTree } from '../../analyzer/core/recursive-cas';

function leaf(id: string): CASOutput {
  return {
    id,
    parent_id: null,
    label: id,
    cas_version: '3.0.0',
    analysis_id: `analysis:${id}`,
    analysis_timestamp: '2026-08-13T00:00:00.000Z',
    system: { id: `system:${id}`, name: id, type: 'application', root_path: '.' },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 0 },
  };
}

describe('CAS composition', () => {
  test('composes child CAS trees and direct-child relations in linear time structures', () => {
    const tree = composeCas({
      id: 'cas:root',
      label: 'root',
      cas_version: '3.0.0',
      analysis_id: 'analysis:root',
      analysis_timestamp: '2026-08-13T00:00:00.000Z',
      system: { id: 'system:root', name: 'root', type: 'monorepo', root_path: '.' },
      children: [leaf('cas:a'), leaf('cas:b')],
      derive_comprehension: () => ({ capabilities: [], flows: [], steps: [], entities: [] }),
      relations: [
        { source_cas_id: 'cas:a', target_cas_id: 'cas:b', type: 'calls', evidence: ['contract:a-b'] },
        { source_cas_id: 'cas:a', target_cas_id: 'cas:b', type: 'calls', evidence: ['duplicate'] },
      ],
    });

    expect(validateCasTree(tree).valid).toBe(true);
    expect(tree.nodes.map(node => node.id)).toEqual(['cas:a', 'cas:b']);
    expect(tree.edges).toHaveLength(1);
    expect(tree.children?.map(child => child.parent_id)).toEqual(['cas:root', 'cas:root']);
  });

  test('rejects relations outside the direct child boundary', () => {
    expect(() => composeCas({
      id: 'cas:root',
      label: 'root',
      cas_version: '3.0.0',
      analysis_id: 'analysis:root',
      analysis_timestamp: '2026-08-13T00:00:00.000Z',
      system: { id: 'system:root', name: 'root', type: 'monorepo', root_path: '.' },
      children: [leaf('cas:a')],
      derive_comprehension: () => ({ capabilities: [], flows: [], steps: [], entities: [] }),
      relations: [{ source_cas_id: 'cas:a', target_cas_id: 'cas:missing', type: 'calls' }],
    })).toThrow(/outside the composition/);
  });

  test('re-derives parent comprehension instead of unioning child semantics', () => {
    const childA = leaf('cas:a');
    childA.capabilities = [{
      id: 'child-capability',
      name: 'Child behavior',
      description: 'Describes behavior scoped only to the child system boundary.',
      name_source: 'ai',
      description_source: 'ai',
      category: 'core',
      operations: [],
      related_entities: [],
      related_domains: [],
      criticality: 'medium',
      criticality_factors: [],
    }];
    const tree = composeCas({
      id: 'cas:root',
      label: 'root',
      cas_version: '3.0.0',
      analysis_id: 'analysis:root',
      analysis_timestamp: '2026-08-13T00:00:00.000Z',
      system: { id: 'system:root', name: 'root', type: 'monorepo', root_path: '.' },
      children: [childA, leaf('cas:b')],
      derive_comprehension: context => ({
        capabilities: [{
          id: 'parent-capability',
          name: 'Coordinate behavior across systems',
          description: 'Coordinates an outcome that requires both composed child systems.',
          name_source: 'ai',
          description_source: 'ai',
          category: 'core',
          operations: [],
          related_entities: [],
          related_domains: context.children.map(child => child.id!),
          criticality: 'high',
          criticality_factors: context.relations.map(relation => relation.type),
        }],
        flows: [],
        steps: [],
        entities: [],
      }),
    });

    expect(tree.capabilities?.map(capability => capability.id)).toEqual(['parent-capability']);
    expect(tree.capabilities?.map(capability => capability.id)).not.toContain('child-capability');
    expect(tree.terminality?.capabilities[0]).toMatchObject({ id: 'parent-capability', terminal: true });
  });
});
