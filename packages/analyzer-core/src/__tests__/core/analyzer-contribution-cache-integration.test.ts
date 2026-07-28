import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator, type AnalyzerRegistration } from '../../analyzer/core/orchestrator';
import type { AnalysisContext } from '../../analyzer/core/base-analyzer';
import type { CASContribution } from '../../types/cas.types';

function result(): CASContribution {
  return {
    nodes: [{ id: 'orders', name: 'Orders', type: 'service' }],
    edges: [],
    entry_points: [],
    exit_points: [],
    analyzer_metadata: {
      analyzer_id: 'fixture-enterprise',
      analyzer_name: 'Fixture Enterprise Analyzer',
      version: '1.0.0',
      contribution_type: 'framework',
      nodes_contributed: 1,
      edges_contributed: 0,
      contributed_entry_points: 0,
      contributed_exit_points: 0,
    },
  };
}

describe('orchestrator analyzer contribution cache integration', () => {
  let root: string;
  let cacheRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-contribution-project-'));
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-contribution-store-'));
    await fs.outputFile(path.join(root, 'src', 'orders.fixture'), 'orders-v1');
    await fs.outputFile(path.join(root, 'src', 'unrelated.fixture'), 'unrelated-v1');
    await fs.outputJson(path.join(root, 'package.json'), { dependencies: { framework: '1.0.0' } });
  });

  afterEach(async () => {
    await fs.remove(root);
    await fs.remove(cacheRoot);
  });

  it('reuses exact contributions and invalidates only when declared evidence changes', async () => {
    let executions = 0;
    const analyzer = {
      analyze: async () => {
        executions++;
        return result();
      },
      getRelevantFiles: async () => ['src/orders.fixture'],
    };
    const registration = {
      id: 'fixture-enterprise',
      name: 'Fixture Enterprise Analyzer',
      type: 'framework',
      version: '1.0.0',
      detectPatterns: {},
      analyzer,
    } as unknown as AnalyzerRegistration;
    const context = { projectPath: root, analysisRootPath: root, filters: [] } as AnalysisContext;

    const first = new AnalyzerOrchestrator() as any;
    first.configureAnalyzerContributionCache(cacheRoot);
    const firstResult = await first.analyzeWithContributionCache(registration, context, root);

    const second = new AnalyzerOrchestrator() as any;
    second.configureAnalyzerContributionCache(cacheRoot);
    await fs.outputFile(path.join(root, 'src', 'unrelated.fixture'), 'unrelated-v2');
    const cachedResult = await second.analyzeWithContributionCache(registration, context, root);

    expect(executions).toBe(1);
    expect(JSON.stringify(cachedResult)).toBe(JSON.stringify(firstResult));
    expect(second.analyzerContributionCacheEvidence.get(registration.id).status).toBe('hit');

    const third = new AnalyzerOrchestrator() as any;
    third.configureAnalyzerContributionCache(cacheRoot);
    await fs.outputFile(path.join(root, 'src', 'orders.fixture'), 'orders-v2');
    await third.analyzeWithContributionCache(registration, context, root);

    expect({
      executions,
      status: third.analyzerContributionCacheEvidence.get(registration.id).status,
      evidence: third.analyzerContributionCacheEvidence.get(registration.id),
    }).toEqual(expect.objectContaining({ executions: 2, status: 'invalidated' }));

    const fourth = new AnalyzerOrchestrator() as any;
    fourth.configureAnalyzerContributionCache(cacheRoot);
    await fs.outputJson(path.join(root, 'package.json'), { dependencies: { framework: '2.0.0' } });
    await fourth.analyzeWithContributionCache(registration, context, root);

    expect({
      executions,
      status: fourth.analyzerContributionCacheEvidence.get(registration.id).status,
      evidence: fourth.analyzerContributionCacheEvidence.get(registration.id),
    }).toEqual(expect.objectContaining({ executions: 3, status: 'invalidated' }));
  });

  it('invalidates when upstream CAS evidence changes while source files stay unchanged', async () => {
    let executions = 0;
    const analyzer = {
      analyze: async (context: AnalysisContext) => {
        executions++;
        const upstreamName = context.existingAnalysis?.[0]?.nodes?.[0]?.name || 'missing';
        return {
          ...result(),
          nodes: [{ id: 'orders', name: upstreamName, type: 'service' }],
        };
      },
      getRelevantFiles: async () => ['src/orders.fixture'],
    };
    const registration = {
      id: 'fixture-enterprise',
      name: 'Fixture Enterprise Analyzer',
      type: 'framework',
      version: '1.0.0',
      detectPatterns: {},
      analyzer,
    } as unknown as AnalyzerRegistration;
    const upstream = (name: string): CASContribution => ({
      nodes: [{
        id: 'upstream',
        name,
        type: 'import',
        source: { file: 'src/orders.fixture' },
        metadata: { source: name } as any,
      }],
      edges: [],
      entry_points: [],
      exit_points: [],
      analyzer_metadata: {
        analyzer_id: 'language',
        analyzer_name: 'Language',
        version: '1.0.0',
        contribution_type: 'language',
        nodes_contributed: 1,
        edges_contributed: 0,
        contributed_entry_points: 0,
        contributed_exit_points: 0,
      },
    });

    const first = new AnalyzerOrchestrator() as any;
    first.configureAnalyzerContributionCache(cacheRoot);
    await first.analyzeWithContributionCache(registration, {
      projectPath: root,
      analysisRootPath: root,
      existingAnalysis: [upstream('@scope/client-v1')],
    } as AnalysisContext, root);

    const second = new AnalyzerOrchestrator() as any;
    second.configureAnalyzerContributionCache(cacheRoot);
    const changed = await second.analyzeWithContributionCache(registration, {
      projectPath: root,
      analysisRootPath: root,
      existingAnalysis: [upstream('@scope/client-v2')],
    } as AnalysisContext, root);

    expect(executions).toBe(2);
    expect(second.analyzerContributionCacheEvidence.get(registration.id).status).toBe('invalidated');
    expect(changed.nodes[0].name).toBe('@scope/client-v2');
  });
});
