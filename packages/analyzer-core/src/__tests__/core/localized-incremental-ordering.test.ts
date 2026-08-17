import { AnalyzerOrchestrator, type AnalyzerRegistration } from '../../analyzer/core/orchestrator';
import type { CASContribution, CASEdge, CASNode, FileAnalysisResult, IncrementalState } from '../../types/cas.types';

function node(id: string, file: string): CASNode {
  return { id, name: id, type: 'variable', source: { file, raw: `const ${id} = 1;` } };
}

describe('localized incremental canonical ordering', () => {
  it('returns the same source-first ordering contract as a cold analysis', () => {
    const retained = node('retained', 'z.ts');
    const changed = node('changed', 'a.ts');
    const previousOutput: any = {
      cas_version: '1.0.0',
      analysis_timestamp: '2026-01-01T00:00:00.000Z',
      analysis_id: 'before',
      system: { name: 'fixture', root_path: '/fixture' },
      nodes: [retained, changed],
      edges: [],
      entry_points: [],
      exit_points: [],
      categories: {},
      perspectives: [],
      libraries: [],
      runtime_static_links: [],
      analysis_facts: [],
    };
    const previousState = {
      files: {
        'a.ts': {
          filePath: 'a.ts',
          contentHash: 'before',
          mtimeMs: 1,
          nodeIds: ['changed'],
          edgeIds: [],
          entryPointIds: [],
          exitPointIds: [],
          importedFiles: [],
          exportedSymbols: [],
        },
      },
    } as unknown as IncrementalState;
    const result: FileAnalysisResult = {
      filePath: 'a.ts',
      contentHash: 'after',
      mtimeMs: 2,
      nodes: [changed],
      edges: [],
      entryPoints: [],
      exitPoints: [],
      imports: [],
      exports: [],
    };

    const output = (new AnalyzerOrchestrator() as any).tryBuildLocalizedIncrementalOutput(
      previousOutput,
      previousState,
      { added: [], modified: ['a.ts'], deleted: [], affectedFiles: [] },
      new Map([['a.ts', result]])
    );

    expect(output.nodes.map((item: CASNode) => item.source?.file)).toEqual(['a.ts', 'z.ts']);
  });

  it('refuses localized reuse when behavior changes between existing nodes', () => {
    const caller = { ...node('caller', 'a.ts'), type: 'function' } as CASNode;
    const oldTarget = { ...node('oldTarget', 'a.ts'), type: 'function' } as CASNode;
    const newTarget = { ...node('newTarget', 'a.ts'), type: 'function' } as CASNode;
    const oldEdge = { id: 'call', source: 'caller', target: 'oldTarget', type: 'calls' } as CASEdge;
    const previousOutput: any = {
      cas_version: '1.0.0',
      analysis_timestamp: '2026-01-01T00:00:00.000Z',
      analysis_id: 'before',
      system: { name: 'fixture', root_path: '/fixture' },
      nodes: [caller, oldTarget, newTarget],
      edges: [oldEdge],
      entry_points: [],
      exit_points: [],
      categories: {},
      perspectives: [],
      libraries: [],
      runtime_static_links: [],
      analysis_facts: [],
    };
    const previousState = {
      files: {
        'a.ts': {
          filePath: 'a.ts', contentHash: 'before', mtimeMs: 1,
          nodeIds: ['caller', 'oldTarget', 'newTarget'], edgeIds: ['call'],
          entryPointIds: [], exitPointIds: [], importedFiles: [], exportedSymbols: [],
        },
      },
    } as unknown as IncrementalState;
    const result: FileAnalysisResult = {
      filePath: 'a.ts', contentHash: 'after', mtimeMs: 2,
      nodes: [caller, oldTarget, newTarget],
      edges: [{ ...oldEdge, target: 'newTarget' }],
      entryPoints: [], exitPoints: [], imports: [], exports: [],
    };

    expect((new AnalyzerOrchestrator() as any).tryBuildLocalizedIncrementalOutput(
      previousOutput,
      previousState,
      { added: [], modified: ['a.ts'], deleted: [], affectedFiles: [] },
      new Map([['a.ts', result]])
    )).toBeNull();
  });

  it('localizes an isolated internal function addition across reused dependency fanout', () => {
    const previousFile = {
      ...node('file', 'a.ts'), type: 'file', source: { file: 'a.ts', line: 1, end_line: 10 },
      metadata: { metrics: { lines_of_code: 10 } },
    } as CASNode;
    const currentFile = {
      ...previousFile, source: { ...previousFile.source!, end_line: 12 },
      metadata: { metrics: { lines_of_code: 10 } },
    } as CASNode;
    const addedFunction = { ...node('added', 'a.ts'), type: 'function', metadata: { is_exported: false } } as CASNode;
    const stableDeployable = {
      id: 'deployable', name: 'deployable', type: 'deployable_unit', metadata: { synthetic_anchor: true },
    } as CASNode;
    const stableRoute = { id: 'route', name: 'route', type: 'route' } as CASNode;
    const previousOutput: any = {
      cas_version: '1.0.0', analysis_timestamp: '2026-01-01T00:00:00.000Z', analysis_id: 'before',
      system: { name: 'fixture', root_path: '/fixture' }, nodes: [previousFile, stableDeployable, stableRoute], edges: [],
      entry_points: [], exit_points: [], categories: {}, perspectives: [{
        id: 'restricted', name: 'Restricted', type: 'flow', analyzer_id: 'fixture',
        connection_rules: { visible_node_types: ['route'] },
      }], libraries: [],
      runtime_static_links: [], analysis_facts: [],
    };
    const previousState = {
      files: {
        'a.ts': {
          filePath: 'a.ts', contentHash: 'before', mtimeMs: 1, nodeIds: ['file'], edgeIds: [],
          entryPointIds: [], exitPointIds: [], importedFiles: [], exportedSymbols: [],
        },
        'dependent.ts': {
          filePath: 'dependent.ts', contentHash: 'same', mtimeMs: 1, nodeIds: [], edgeIds: [],
          entryPointIds: [], exitPointIds: [], importedFiles: ['a.ts'], exportedSymbols: [],
        },
      },
    } as unknown as IncrementalState;
    const changed: FileAnalysisResult = {
      filePath: 'a.ts', contentHash: 'after', mtimeMs: 2, nodes: [currentFile, addedFunction],
      edges: [], entryPoints: [], exitPoints: [], imports: [], exports: [],
    };
    const reused: FileAnalysisResult = {
      filePath: 'dependent.ts', contentHash: 'same', mtimeMs: 1, nodes: [], edges: [],
      entryPoints: [], exitPoints: [], imports: ['a.ts'], exports: [],
    };
    const output = (new AnalyzerOrchestrator() as any).tryBuildLocalizedIncrementalOutput(
      previousOutput,
      previousState,
      { added: [], modified: ['a.ts'], deleted: [], affectedFiles: ['dependent.ts'] },
      new Map([['a.ts', changed], ['dependent.ts', reused]])
    );

    const updatedFile = output.nodes.find((item: CASNode) => item.id === 'file');
    const updatedDeployable = output.nodes.find((item: CASNode) => item.id === 'deployable');
    expect(updatedFile.source.end_line).toBe(12);
    expect(updatedFile.metadata.metrics.lines_of_code).toBe(12);
    const updatedFunction = output.nodes.find((item: CASNode) => item.id === 'added');
    expect(updatedFunction.perspectives).toBeDefined();
    expect(updatedFunction.perspectives.restricted).toBeUndefined();
    expect(updatedDeployable.perspectives).toBeUndefined();
    expect(updatedDeployable.structural_importance).toBeUndefined();
  });

  it('refuses localized reuse for an exported function addition', () => {
    const retained = node('retained', 'a.ts');
    const added = { ...node('added', 'a.ts'), type: 'function', metadata: { is_exported: true } } as CASNode;
    const previousOutput: any = {
      cas_version: '1.0.0', analysis_timestamp: '2026-01-01T00:00:00.000Z', analysis_id: 'before',
      system: { name: 'fixture', root_path: '/fixture' }, nodes: [retained], edges: [],
      entry_points: [], exit_points: [], categories: {}, perspectives: [], libraries: [],
      runtime_static_links: [], analysis_facts: [],
    };
    const previousState = {
      files: {
        'a.ts': {
          filePath: 'a.ts', contentHash: 'before', mtimeMs: 1, nodeIds: ['retained'], edgeIds: [],
          entryPointIds: [], exitPointIds: [], importedFiles: [], exportedSymbols: [],
        },
      },
    } as unknown as IncrementalState;
    const result: FileAnalysisResult = {
      filePath: 'a.ts', contentHash: 'after', mtimeMs: 2, nodes: [retained, added], edges: [],
      entryPoints: [], exitPoints: [], imports: [], exports: ['added'],
    };

    expect((new AnalyzerOrchestrator() as any).tryBuildLocalizedIncrementalOutput(
      previousOutput,
      previousState,
      { added: [], modified: ['a.ts'], deleted: [], affectedFiles: [] },
      new Map([['a.ts', result]])
    )).toBeNull();
  });
});

describe('incremental file cache identity', () => {
  const registration = {
    id: 'typescript', name: 'TypeScript', type: 'language', version: '1.0.0',
    detectPatterns: {}, analyzer: {},
  } as unknown as AnalyzerRegistration;
  const upstream = (name: string): CASContribution => ({
    nodes: [{ id: 'upstream', name, type: 'class', source: { file: 'owner.ts' } }],
    edges: [], entry_points: [], exit_points: [],
    analyzer_metadata: {
      analyzer_id: 'language', analyzer_name: 'Language', version: '1.0.0',
      contribution_type: 'language', nodes_contributed: 1, edges_contributed: 0,
      contributed_entry_points: 0, contributed_exit_points: 0,
    },
  });

  it('separates identical bytes at different paths and different upstream revisions', () => {
    const orchestrator = new AnalyzerOrchestrator() as any;
    const context = (relativePath: string, evidence: string) => ({
      projectPath: '/repo', filePath: `/repo/${relativePath}`, relativePath,
      contentHash: 'same-bytes', existingAnalysis: [upstream(evidence)],
    });

    const first = orchestrator.incrementalFileCacheKey(registration, context('a.ts', 'v1'));
    expect(orchestrator.incrementalFileCacheKey(registration, context('b.ts', 'v1'))).not.toBe(first);
    expect(orchestrator.incrementalFileCacheKey(registration, context('a.ts', 'v2'))).not.toBe(first);
  });
});

describe('analyzer registry identity', () => {
  it('changes when detection wiring changes without a version bump', () => {
    const orchestrator = new AnalyzerOrchestrator() as any;
    const registration = (files: string[]) => ({
      id: 'framework', name: 'Framework', type: 'framework', version: '1.0.0',
      detectPatterns: { files }, analyzer: {},
    }) as unknown as AnalyzerRegistration;

    expect(orchestrator.analyzerRegistryFingerprint([registration(['old.config'])]))
      .not.toBe(orchestrator.analyzerRegistryFingerprint([registration(['new.config'])]));
  });
});
