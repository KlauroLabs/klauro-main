import { linkStructuralOwnership } from '../../analyzer/core/structural-ownership';
import type { CASEdge, CASNode } from '../../types/cas.types';

describe('structural ownership', () => {
  it('links unconnected nodes to declared parents before same-file owners', () => {
    const file = { id: 'file_service', name: 'service.ts', type: 'file', source: { file: 'src/service.ts', line: 1 } } as CASNode;
    const owner = { id: 'class_service', name: 'Service', type: 'class', source: { file: 'src/service.ts', line: 2 } } as CASNode;
    const property = { id: 'property_client', name: 'client', type: 'property', parent: owner.id, source: { file: 'src/service.ts', line: 3 } } as CASNode;
    const usage = { id: 'library_sdk_usage', name: 'SDK call', type: 'library_service_sdk_usage', source: { file: 'src/service.ts', line: 4 } } as CASNode;
    const edges: CASEdge[] = [{ id: 'file-owner', source: file.id, target: owner.id, type: 'contains' }];
    linkStructuralOwnership([file, owner, property, usage], edges);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: owner.id, target: property.id, type: 'contains' }),
      expect.objectContaining({ source: file.id, target: usage.id, type: 'contains' }),
    ]));
  });

  it('does not duplicate ownership for nodes already present in the graph', () => {
    const file = { id: 'file_service', name: 'service.ts', type: 'file', source: { file: 'src/service.ts', line: 1 } } as CASNode;
    const usage = { id: 'library_sdk_usage', name: 'SDK call', type: 'library_service_sdk_usage', source: { file: 'src/service.ts', line: 4 } } as CASNode;
    const edges: CASEdge[] = [{ id: 'existing', source: file.id, target: usage.id, type: 'uses' }];
    linkStructuralOwnership([file, usage], edges);
    expect(edges).toHaveLength(1);
  });

  it('rebuilds derived ownership from non-structural edges independent of prior output and node order', () => {
    const file = { id: 'file_service', name: 'service.ts', type: 'file', source: { file: 'src/service.ts', line: 1 } } as CASNode;
    const first = { id: 'usage_first', name: 'First call', type: 'library_service_sdk_usage', source: { file: 'src/service.ts', line: 3 } } as CASNode;
    const second = { id: 'usage_second', name: 'Second call', type: 'library_service_sdk_usage', source: { file: 'src/service.ts', line: 4 } } as CASNode;
    const stale: CASEdge = {
      id: 'structural_ownership_stale',
      source: first.id,
      target: second.id,
      type: 'contains',
      metadata: { attributes: { relationship: 'structural_ownership', resolution: 'declared-parent' } },
    };
    const forward = [stale];
    const reverse = [stale];

    linkStructuralOwnership([file, first, second], forward);
    linkStructuralOwnership([second, first, file], reverse);

    const pairs = (edges: CASEdge[]) => edges.map(edge => `${edge.source}:${edge.target}`).sort();
    expect(pairs(forward)).toEqual([`${file.id}:${first.id}`, `${file.id}:${second.id}`]);
    expect(pairs(reverse)).toEqual(pairs(forward));
  });
});
