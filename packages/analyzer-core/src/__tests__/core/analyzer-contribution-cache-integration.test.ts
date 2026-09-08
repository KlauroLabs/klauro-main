jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator, type AnalyzerRegistration } from '../../analyzer/core/orchestrator';
import type { AnalysisContext } from '../../analyzer/core/base-analyzer';
import type { CASContribution } from '../../types/cas.types';
import { ArchitecturalLibraryAnalyzer } from '../../analyzer/libraries/architecture/architectural-library-analyzer';
import { AIStackAnalyzer } from '../../analyzer/libraries/ai-stack-analyzer';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';

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


  it('recomputes cheap architectural file extraction without hashing unused upstream evidence', async () => {
    const analyzer = new ArchitecturalLibraryAnalyzer();
    const registration = { id: analyzer.id, name: analyzer.name, version: analyzer.version, type: analyzer.type, detectPatterns: {}, analyzer } as AnalyzerRegistration;
    await fs.outputJson(path.join(root, 'package.json'), { dependencies: { '@aws-sdk/client-s3': '1.0.0' } });
    const relativePath = 'src/upload.ts';
    await fs.outputFile(path.join(root, relativePath), [
      "import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';",
      'const client = new S3Client({});',
      'client.send(new PutObjectCommand({}));',
    ].join('\n'));
    const context = {
      projectPath: root, relativePath, filePath: path.join(root, relativePath), contentHash: 'unchanged',
      get existingAnalysis(): CASContribution[] { throw new Error('Unused graph evidence was accessed'); },
    };
    const orchestrator = new AnalyzerOrchestrator() as any;
    expect(orchestrator.incrementalFileCacheKey(registration, context)).toBeNull();
    const first = await analyzer.analyzeFileSingle(context);
    expect(first.nodes.length).toBeGreaterThan(0);
    expect(first.exitPoints.length).toBeGreaterThan(0);
    await fs.outputJson(path.join(root, 'package.json'), { dependencies: {} });
    expect(orchestrator.incrementalFileCacheKey(registration, context)).toBeNull();
    const changedDependencies = await analyzer.analyzeFileSingle(context);
    expect(changedDependencies.nodes).toEqual([]);
    expect(changedDependencies.exitPoints).toEqual([]);
    await fs.outputJson(path.join(root, 'package.json'), { dependencies: { '@aws-sdk/client-s3': '1.0.0' } });
    const restored = await analyzer.analyzeFileSingle(context);
    expect(restored).toEqual(first);
  });

  it('defaults file-scoped extraction to recompute without reading irrelevant graph evidence', async () => {
    const analyzer = new AIStackAnalyzer();
    const registration = { id: analyzer.id, name: analyzer.name, version: analyzer.version, type: analyzer.type, detectPatterns: {}, analyzer } as AnalyzerRegistration;
    const relativePath = 'src/mcp.ts';
    await fs.outputFile(path.join(root, relativePath), [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "const server = new McpServer({ name: 'search-server', version: '1.0.0' });",
      "server.registerTool('search', { description: 'Search the index' }, async () => ({ content: [] }));",
    ].join('\n'));
    const context = {
      projectPath: root, relativePath, filePath: path.join(root, relativePath),
      get existingAnalysis(): CASContribution[] { throw new Error('Unused graph evidence was accessed'); },
    };
    const orchestrator = new AnalyzerOrchestrator() as any;
    expect(analyzer.incrementalContributionScope()).toBe('file');
    expect(analyzer.incrementalFileCachePolicy()).toBe('recompute');
    expect(orchestrator.incrementalFileCacheKey(registration, context)).toBeNull();
    const extracted = await analyzer.analyzeFileSingle(context);
    expect(extracted.nodes.length).toBeGreaterThan(0);
    expect(await analyzer.analyzeFileSingle(context)).toEqual(extracted);
  });

  it('retains evidence caching for project-scoped extraction and explicit file-scoped opt-in', () => {
    class CachedAIStackAnalyzer extends AIStackAnalyzer {
      incrementalFileCachePolicy(): 'evidence' { return 'evidence'; }
    }
    const projectAnalyzer = new TypeScriptJavaScriptAnalyzer();
    expect(projectAnalyzer.incrementalContributionScope()).toBe('project');
    for (const analyzer of [projectAnalyzer, new CachedAIStackAnalyzer()]) {
      expect(analyzer.incrementalFileCachePolicy()).toBe('evidence');
      const registration: AnalyzerRegistration = { id: analyzer.id, name: analyzer.name, version: analyzer.version, type: analyzer.type, detectPatterns: {}, analyzer };
      const orchestrator = new AnalyzerOrchestrator() as any;
      const context = { projectPath: root, relativePath: 'orders.ts', contentHash: 'same' };
      const before = orchestrator.incrementalFileCacheKey(registration, { ...context, existingAnalysis: [result()] });
      const changed = result();
      changed.nodes![0].name = 'Changed';
      const after = orchestrator.incrementalFileCacheKey(registration, { ...context, existingAnalysis: [changed] });
      expect(before).not.toBeNull();
      expect(after).not.toBe(before);
    }
  });

  it('keeps upstream evidence in the opted-in incremental file cache policy', () => {
    const analyzer = { incrementalFileCachePolicy: () => 'evidence' };
    const registration = { id: 'dependent', version: '1', type: 'framework', analyzer } as unknown as AnalyzerRegistration;
    const orchestrator = new AnalyzerOrchestrator() as any;
    const context = { projectPath: root, relativePath: 'orders.ts', contentHash: 'same' };
    const before = orchestrator.incrementalFileCacheKey(registration, { ...context, existingAnalysis: [result()] });
    const changed = result();
    changed.nodes![0].name = 'Changed';
    expect(orchestrator.incrementalFileCacheKey(registration, { ...context, existingAnalysis: [changed] })).not.toBe(before);
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
