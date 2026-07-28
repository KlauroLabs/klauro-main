import {
  buildReverseFileDependencyIndex,
  computeAffectedFileClosure,
  computeGraphAffectedFileClosure,
  filesRequiringIncrementalAnalysis,
  remapIncrementalNodeReferences,
  resolveImportedFileReferences,
} from '../../analyzer/core/incremental-impact';
import type { CASEdge, CASNode, FileAnalysisRecord, IncrementalState } from '../../types/cas.types';

function record(filePath: string, importedFiles: string[] = []): FileAnalysisRecord {
  return {
    filePath,
    contentHash: filePath,
    mtimeMs: 0,
    lastAnalyzed: '2026-01-01T00:00:00.000Z',
    analyzerId: 'fixture',
    nodeIds: [],
    edgeIds: [],
    entryPointIds: [],
    exitPointIds: [],
    importedFiles,
    exportedSymbols: [],
  };
}

function chain(length: number): IncrementalState['files'] {
  const files: IncrementalState['files'] = {};
  for (let index = 0; index < length; index++) {
    const filePath = `src/layer-${index}.ts`;
    files[filePath] = record(filePath, index === 0 ? [] : [`src/layer-${index - 1}.ts`]);
  }
  return files;
}

describe('incremental dependency impact', () => {
  it('finds transitive graph dependents without requiring import records', () => {
    const affected = computeGraphAffectedFileClosure({
      projectPath: '/repo',
      changedFiles: ['domain/order.go'],
      nodes: [
        { id: 'order', name: 'Order', type: 'class', source: { file: 'domain/order.go' } },
        { id: 'service', name: 'CreateOrder', type: 'function', source: { file: 'service/orders.go' } },
        { id: 'handler', name: 'HandleCreate', type: 'function', source: { file: 'api/handler.go' } },
      ],
      edges: [
        { id: 'service-order', source: 'service', target: 'order', type: 'uses' },
        { id: 'handler-service', source: 'handler', target: 'service', type: 'calls' },
      ],
    });

    expect(affected).toEqual(['api/handler.go', 'service/orders.go']);
  });
  it('walks every downstream layer without a depth cutoff', () => {
    const files = chain(12);
    expect(computeAffectedFileClosure(['src/layer-0.ts'], files)).toEqual(
      Array.from({ length: 11 }, (_, index) => `src/layer-${index + 1}.ts`).sort()
    );
  });

  it('terminates cycles and returns each dependent once', () => {
    const files = chain(4);
    files['src/layer-0.ts'].importedFiles = ['src/layer-3.ts'];
    const reverse = buildReverseFileDependencyIndex(files);

    expect(reverse.get('src/layer-3.ts')).toEqual(new Set(['src/layer-0.ts']));
    expect(computeAffectedFileClosure(['src/layer-0.ts'], files)).toEqual([
      'src/layer-1.ts',
      'src/layer-2.ts',
      'src/layer-3.ts',
    ]);
  });

  it('includes affected files in incremental execution and excludes deletions', () => {
    expect(filesRequiringIncrementalAnalysis({
      added: ['src/new.ts'],
      modified: ['src/base.ts'],
      deleted: ['src/deleted.ts'],
      affectedFiles: ['src/dependent.ts', 'src/deleted.ts'],
      affectedNodeIds: new Set(),
      requiresFullRebuild: false,
      detectionMethod: 'hybrid',
    })).toEqual(['src/base.ts', 'src/dependent.ts', 'src/new.ts']);
  });

  it('resolves common cross-language import forms conservatively', () => {
    const knownFiles = new Set([
      'src/domain/order.ts',
      'src/domain/customer/index.ts',
      'app/services/payment.py',
      'src/main/java/com/acme/User.java',
    ]);

    expect(resolveImportedFileReferences('src/api/handler.ts', [
      '../domain/order',
      '../domain/customer',
    ], knownFiles)).toEqual([
      'src/domain/customer/index.ts',
      'src/domain/order.ts',
    ]);
    expect(resolveImportedFileReferences('app/api/routes.py', [
      'app.services.payment',
    ], knownFiles)).toEqual(['app/services/payment.py']);
    expect(resolveImportedFileReferences('src/main/java/com/acme/Admin.java', [
      'com/acme/User',
    ], knownFiles)).toEqual(['src/main/java/com/acme/User.java']);
  });
});

describe('incremental node reference remapping', () => {
  it('redirects retained graph references when a stable symbol receives a new analyzer id', () => {
    const previousNodes: CASNode[] = [
      { id: 'file_service', name: 'service.ts', type: 'file', source: { file: 'src/service.ts', line: 1 } },
      { id: 'old_service_owner', name: 'service', type: 'service', source: { file: 'src/service.ts', line: 1 } },
      { id: 'function_service_calculate_0', name: 'calculate', type: 'function', parent: 'old_service_owner', source: { file: 'src/service.ts', line: 1 } },
      { id: 'function_route_handler_0', name: 'handler', type: 'function', source: { file: 'src/route.ts', line: 1 } },
    ];
    const nodes: CASNode[] = [
      previousNodes[0],
      { id: 'function_service_calculate_1', name: 'calculate', type: 'function', parent: 'file_service', source: { file: 'src/service.ts', line: 2 } },
      previousNodes[2],
    ];
    const edges: CASEdge[] = [{
      id: 'call_handler_calculate',
      source: 'function_route_handler_0',
      target: 'function_service_calculate_0',
      type: 'calls',
    }];

    const remapped = remapIncrementalNodeReferences({
      projectPath: '/repo',
      previousNodes,
      nodes,
      edges,
      entryPoints: [],
      exitPoints: [],
    });

    expect(remapped).toBe(1);
    expect(edges[0].target).toBe('function_service_calculate_1');
  });

  it('does not guess when the replacement identity is ambiguous', () => {
    const previousNodes: CASNode[] = [
      { id: 'old', name: 'run', type: 'function', source: { file: 'src/job.ts', line: 1 } },
    ];
    const nodes: CASNode[] = [
      { id: 'new_a', name: 'run', type: 'function', source: { file: 'src/job.ts', line: 2 } },
      { id: 'new_b', name: 'run', type: 'function', source: { file: 'src/job.ts', line: 3 } },
    ];
    const edges: CASEdge[] = [{ id: 'edge', source: 'old', target: 'new_a', type: 'calls' }];

    expect(remapIncrementalNodeReferences({
      projectPath: '/repo',
      previousNodes,
      nodes,
      edges,
      entryPoints: [],
      exitPoints: [],
    })).toBe(0);
    expect(edges[0].source).toBe('old');
  });
});
