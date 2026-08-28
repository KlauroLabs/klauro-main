import type { CASOutput } from '../../types/cas.types';
import { composeCas, type CASCompositionContext } from '../../analyzer/core/cas-composition';
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
  test('recomputes terminal child evidence at each recursive composition boundary without deleting substrate CAS nodes', () => {
    let middleContext: CASCompositionContext | undefined;
    const middle = composeCas({
      id: 'cas:middle',
      label: 'middle',
      cas_version: '3.0.0',
      analysis_id: 'analysis:middle',
      analysis_timestamp: '2026-08-13T00:00:00.000Z',
      system: { id: 'system:middle', name: 'middle', type: 'monorepo', root_path: '.' },
      children: [leaf('cas:leaf-a'), leaf('cas:leaf-b')],
      relations: [{ id: 'relation:a-b', source_cas_id: 'cas:leaf-a', target_cas_id: 'cas:leaf-b', type: 'calls', confidence: 0.8, evidence: ['edge:a-b'] }],
      derive_comprehension: context => {
        middleContext = context;
        return { capabilities: [], flows: [], steps: [], entities: [] };
      },
    });
    const middleById = new Map(middleContext!.child_terminality.map(member => [member.id, member]));
    expect(middleById.get('cas:leaf-a')).toMatchObject({ terminal: false, proximal_terminal: true });
    expect(middleById.get('cas:leaf-a')?.composition_provenance).toMatchObject({
      source_child_id: 'cas:leaf-a',
      confidence: 0.8,
      relation_path: [{ relation_id: 'relation:a-b', source_id: 'cas:leaf-a', target_id: 'cas:leaf-b', evidence_ids: ['edge:a-b'] }],
    });
    expect(middleById.get('cas:leaf-b')).toMatchObject({ terminal: true });
    expect(middle.nodes.map(node => node.id)).toEqual(['cas:leaf-a', 'cas:leaf-b']);

    let rootContext: CASCompositionContext | undefined;
    const root = composeCas({
      id: 'cas:root-recursive',
      label: 'root',
      cas_version: '3.0.0',
      analysis_id: 'analysis:root-recursive',
      analysis_timestamp: '2026-08-13T00:00:00.000Z',
      system: { id: 'system:root-recursive', name: 'root', type: 'monorepo', root_path: '.' },
      children: [middle, leaf('cas:leaf-c')],
      relations: [{ id: 'relation:middle-c', source_cas_id: 'cas:middle', target_cas_id: 'cas:leaf-c', type: 'publishes', confidence: 0.7, evidence: ['edge:middle-c'] }],
      derive_comprehension: context => {
        rootContext = context;
        return { capabilities: [], flows: [], steps: [], entities: [] };
      },
    });
    const rootById = new Map(rootContext!.child_terminality.map(member => [member.id, member]));
    expect(rootById.get('cas:middle')).toMatchObject({ terminal: false, proximal_terminal: true });
    expect(rootById.get('cas:leaf-c')).toMatchObject({ terminal: true });
    expect(root.nodes.map(node => node.id)).toEqual(['cas:middle', 'cas:leaf-c']);
    expect(root.children?.[0].children?.map(child => child.id)).toEqual(['cas:leaf-a', 'cas:leaf-b']);
  });

});
