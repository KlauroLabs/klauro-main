import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { CASAnalysisError } from '../../types/cas.types';

function emptyTarget() {
  return { allNodes: [] as any[], allEdges: [] as any[], allEntryPoints: [] as any[], allExitPoints: [] as any[] };
}

function contribution(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_metadata: {
      analyzer_id: 'rust',
      analyzer_name: 'Rust Analyzer',
      version: '1.0.0',
      contribution_type: 'language',
      nodes_contributed: 0,
      edges_contributed: 0
    },
    ...overrides
  } as any;
}

function cliEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry:main:bin/agent/build.rs',
    source_node: 'function:bin/agent/build.rs:main',
    source_analyzer: 'rust',
    type: 'cli',
    name: 'main',
    description: 'Program entry point',
    ...overrides
  };
}

describe('contribution merge duplicate-id semantics', () => {
  let orchestrator: any;
  let analysisErrors: CASAnalysisError[];

  beforeEach(() => {
    orchestrator = new AnalyzerOrchestrator() as any;
    analysisErrors = [];
  });

  it('drops an identical-content duplicate entry point silently within one contribution', () => {
    const target = emptyTarget();
    orchestrator.mergeAnalysisResult(
      target,
      contribution({ entry_points: [cliEntry(), cliEntry()] }),
      { analyzerId: 'rust', analysisErrors }
    );

    expect(target.allEntryPoints).toHaveLength(1);
    expect(analysisErrors).toHaveLength(0);
  });

  it('drops an identical-content duplicate entry point silently across contributions', () => {
    const target = emptyTarget();
    orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [cliEntry()] }), { analyzerId: 'rust', analysisErrors });
    orchestrator.mergeAnalysisResult(target, contribution({ entry_points: [cliEntry()] }), { analyzerId: 'rust', analysisErrors });

    expect(target.allEntryPoints).toHaveLength(1);
    expect(analysisErrors).toHaveLength(0);
  });

  it('keeps the first entry point and warns when a duplicate id carries different content', () => {
    const target = emptyTarget();
    const first = cliEntry({
      id: 'entry_http_server',
      type: 'http',
      name: 'HTTP Server: port 3000',
      source_analyzer: 'nestjs',
      metadata: { file: 'apps/api/src/main.ts', port: 3000 }
    });
    const second = cliEntry({
      id: 'entry_http_server',
      type: 'http',
      name: 'HTTP Server: port 3030',
      source_analyzer: 'nestjs',
      metadata: { file: 'apps/api-internal/src/main.ts', port: 3030 }
    });

    orchestrator.mergeAnalysisResult(
      target,
      contribution({ entry_points: [first, second] }),
      { analyzerId: 'nestjs', analysisErrors }
    );

    expect(target.allEntryPoints).toHaveLength(1);
    expect(target.allEntryPoints[0].name).toBe('HTTP Server: port 3000');
    expect(analysisErrors).toHaveLength(1);
    expect(analysisErrors[0].code).toBe('PARTIAL_ANALYSIS');
    expect(analysisErrors[0].severity).toBe('warning');
    expect(analysisErrors[0].message).toContain('entry_http_server');
    expect(analysisErrors[0].message).toContain('apps/api/src/main.ts');
    expect(analysisErrors[0].message).toContain('apps/api-internal/src/main.ts');
  });

  it('applies the same semantics to exit points', () => {
    const target = emptyTarget();
    const exit = {
      id: 'exit:db:src/store.rs',
      source_node: 'function:src/store.rs:save',
      source_analyzer: 'rust',
      type: 'database',
      name: 'save'
    };

    orchestrator.mergeAnalysisResult(
      target,
      contribution({ exit_points: [exit, { ...exit }, { ...exit, name: 'save_other' }] }),
      { analyzerId: 'rust', analysisErrors }
    );

    expect(target.allExitPoints).toHaveLength(1);
    expect(target.allExitPoints[0].name).toBe('save');
    expect(analysisErrors).toHaveLength(1);
    expect(analysisErrors[0].message).toContain('exit:db:src/store.rs');
  });

  it('keeps the first edge and warns when a duplicate edge id carries different content', () => {
    const target = emptyTarget();
    const edge = { id: 'edge:1', source: 'a', target: 'b', type: 'calls' };

    orchestrator.mergeAnalysisResult(target, contribution({ edges: [edge] }), { analyzerId: 'rust', analysisErrors });
    orchestrator.mergeAnalysisResult(
      target,
      contribution({ edges: [{ ...edge }, { ...edge, type: 'imports' }] }),
      { analyzerId: 'react', analysisErrors }
    );

    expect(target.allEdges).toHaveLength(1);
    expect(target.allEdges[0].type).toBe('calls');
    expect(analysisErrors).toHaveLength(1);
    expect(analysisErrors[0].message).toContain('edge:1');
  });

  it('treats key order as identical content', () => {
    const target = emptyTarget();
    const reordered = {
      description: 'Program entry point',
      name: 'main',
      type: 'cli',
      source_analyzer: 'rust',
      source_node: 'function:bin/agent/build.rs:main',
      id: 'entry:main:bin/agent/build.rs'
    };

    orchestrator.mergeAnalysisResult(
      target,
      contribution({ entry_points: [cliEntry(), reordered] }),
      { analyzerId: 'rust', analysisErrors }
    );

    expect(target.allEntryPoints).toHaveLength(1);
    expect(analysisErrors).toHaveLength(0);
  });
});

describe('graph integrity duplicate-id validation', () => {
  it('counts duplicate ids per section and records validation warnings', () => {
    const orchestrator = new AnalyzerOrchestrator() as any;
    const node = (id: string) => ({ id, name: id, type: 'function', source: { file: 'a.ts', line: 1 } });
    const validation = orchestrator.buildValidation(
      [node('n1'), node('n1'), node('n2')],
      [{ id: 'e1', source: 'n1', target: 'n2' }, { id: 'e1', source: 'n1', target: 'n2' }],
      [cliEntry(), cliEntry()],
      []
    );

    expect(validation.graph_integrity.duplicate_ids).toEqual({
      nodes: 1,
      edges: 1,
      entry_points: 1,
      exit_points: 0
    });
    const messages = (validation.validation_warnings || []).map((w: any) => w.message).join('\n');
    expect(messages).toContain('Duplicate nodes id "n1"');
    expect(messages).toContain('Duplicate edges id "e1"');
    expect(messages).toContain('Duplicate entry_points id "entry:main:bin/agent/build.rs"');
  });

  it('reports zero duplicates for a clean graph', () => {
    const orchestrator = new AnalyzerOrchestrator() as any;
    const validation = orchestrator.buildValidation(
      [{ id: 'n1', name: 'n1', type: 'function', source: { file: 'a.ts', line: 1 } }],
      [],
      [],
      []
    );
    expect(validation.graph_integrity.duplicate_ids).toEqual({
      nodes: 0,
      edges: 0,
      entry_points: 0,
      exit_points: 0
    });
  });
});
