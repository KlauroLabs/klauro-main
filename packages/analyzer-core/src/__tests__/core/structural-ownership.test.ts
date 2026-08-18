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

  it('connects an otherwise orphaned file to an already-connected declaration', () => {
    const file = { id: 'file_service', name: 'service.ts', type: 'file', source: { file: 'src/service.ts', line: 1 } } as CASNode;
    const declaration = { id: 'class_service', name: 'Service', type: 'class', source: { file: 'src/service.ts', line: 2 } } as CASNode;
    const dependency = { id: 'class_dependency', name: 'Dependency', type: 'class', source: { file: 'src/dependency.ts', line: 1 } } as CASNode;
    const edges: CASEdge[] = [{ id: 'depends', source: declaration.id, target: dependency.id, type: 'depends-on' }];

    linkStructuralOwnership([file, declaration, dependency], edges);

    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: file.id, target: declaration.id, type: 'contains' }),
    ]));
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

  it('uses the canonical file node when analyzers emit the same source file at different depths', () => {
    const canonical = { id: 'file_src_main_rs', name: 'main.rs', type: 'file', source: { file: 'src/main.rs', line: 1 } } as CASNode;
    const language = { id: 'file_src_main_rs_main_rs_47210bc3', name: 'main.rs', type: 'file', source: { file: 'src/main.rs', line: 1 } } as CASNode;
    const handler = { id: 'function:src/main.rs:list_users', name: 'list_users', type: 'function', source: { file: 'src/main.rs', line: 3 } } as CASNode;
    const edges: CASEdge[] = [];

    linkStructuralOwnership([language, handler, canonical], edges);

    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: canonical.id, target: language.id, type: 'contains' }),
      expect.objectContaining({ source: canonical.id, target: handler.id, type: 'contains' }),
    ]));
  });
});
