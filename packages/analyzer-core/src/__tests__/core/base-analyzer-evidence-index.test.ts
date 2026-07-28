import { AnalysisContext, BaseAnalyzer } from '../../analyzer/core/base-analyzer';
import { CASContribution } from '../../types/cas.types';

class EvidenceProbeAnalyzer extends BaseAnalyzer {
  constructor() {
    super('evidence-probe', 'Evidence Probe', '1.0.0', 'library');
  }

  async canAnalyze(): Promise<boolean> {
    return true;
  }

  async analyze() {
    return this.createContribution([], [], [], []);
  }

  protected getCapabilities(): string[] {
    return [];
  }

  protected getLevelName(): string {
    return 'evidence';
  }

  files(context: AnalysisContext, includeDependents: boolean): string[] {
    return this.filesFromExistingAnalysis(context, source => source === '@vendor/auth', includeDependents);
  }

  exitFiles(context: AnalysisContext): string[] {
    return this.filesFromExistingAnalysisExitPoints(context, point => point.type === 'database');
  }
}

function contribution(): CASContribution {
  return {
    nodes: [
      { id: 'import_auth', name: '@vendor/auth', type: 'import', source: { file: 'src/auth.ts' }, metadata: { source: '@vendor/auth' } },
      { id: 'import_service', name: './auth', type: 'import', source: { file: 'src/service.ts' }, metadata: { source: './auth' } },
      { id: 'import_controller', name: './service', type: 'import', source: { file: 'src/controller.ts' }, metadata: { source: './service' } },
      { id: 'repository', name: 'Repository', type: 'class', source: { file: 'src/repository.ts' } },
    ] as any[],
    edges: [],
    entry_points: [],
    exit_points: [{ id: 'db', source_node: 'repository', type: 'database', name: 'query' } as any],
    analyzer_metadata: {
      analyzer_id: 'language',
      analyzer_name: 'Language',
      version: '1.0.0',
      contribution_type: 'language',
      nodes_contributed: 4,
      edges_contributed: 0,
      contributed_entry_points: 0,
      contributed_exit_points: 1,
    },
  };
}

describe('BaseAnalyzer existing-analysis evidence index', () => {
  const analyzer = new EvidenceProbeAnalyzer();
  const context: AnalysisContext = {
    projectPath: '/repo',
    analysisRootPath: '/repo',
    existingAnalysis: [contribution()],
  };

  it('preserves direct import matching', () => {
    expect(analyzer.files(context, false)).toEqual(['src/auth.ts']);
  });

  it('walks reverse relative imports transitively without rescanning all nodes', () => {
    expect(analyzer.files(context, true)).toEqual([
      'src/auth.ts',
      'src/controller.ts',
      'src/service.ts',
    ]);
  });

  it('reuses the indexed source-node mapping for exit points', () => {
    expect(analyzer.exitFiles(context)).toEqual(['src/repository.ts']);
  });
});
