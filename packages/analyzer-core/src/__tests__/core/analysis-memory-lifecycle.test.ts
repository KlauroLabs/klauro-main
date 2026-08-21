import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { captureAnalysisMemorySample } from '../../analyzer/core/analysis-memory-profile';
import { getActiveSourceCorpus } from '../../analyzer/core/source-corpus';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';

test('node lookup indexes use weak graph ownership', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const nodes = Array.from({ length: 10_000 }, (_, index) => ({ id: `node-${index}` }));
  const lookup = orchestrator.getNodeLookup(nodes);

  expect(lookup.size).toBe(nodes.length);
  expect(orchestrator.nodeLookups.get(nodes)).toBe(lookup);
  expect(orchestrator.nodeLookupSource).toBeUndefined();
  expect(orchestrator.nodeLookupById).toBeUndefined();
});

test('orchestration does not retain a source corpus around the whole analysis job', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-memory-lifecycle-'));
  const orchestrator = new AnalyzerOrchestrator() as any;
  let corpusDuringExecution: unknown;
  orchestrator.executeAnalysis = async () => {
    corpusDuringExecution = getActiveSourceCorpus();
    return { nodes: [], edges: [] };
  };
  try {
    await orchestrator.orchestrateAnalysis(projectPath);
    expect(corpusDuringExecution).toBeUndefined();
    expect(getActiveSourceCorpus()).toBeUndefined();
  } finally {
    await fs.remove(projectPath);
  }
});

test('phase memory samples expose resident and retained heap budgets in MiB', () => {
  const sample = captureAnalysisMemorySample('fixture');
  expect(sample.phase).toBe('fixture');
  expect(sample.rss_mb).toBeGreaterThanOrEqual(sample.heap_used_mb);
  expect(sample.max_rss_mb).toBeGreaterThan(0);
  expect(sample.array_buffers_mb).toBeGreaterThanOrEqual(0);
});

test('language analyzer lifecycle cleanup releases every per-job graph index', () => {
  const analyzer = new TypeScriptJavaScriptAnalyzer() as any;
  const fields = [
    'astCache',
    'importSourceMap',
    'importAliasMap',
    'importsByConsumerFile',
    'classFieldTypes',
    'repositoryPropertyTypes',
    'prismaModelsByName',
    'nodeById',
    'nodesByName',
    'methodsByParent',
    'callEdgeIds',
    'exitPointIds',
    'callTargetResolutionCache',
  ];
  for (const field of fields) {
    if (analyzer[field] instanceof Set) analyzer[field].add('retained');
    else analyzer[field].set('retained', { id: 'retained' });
  }
  analyzer.currentProjectPath = '/retained';
  analyzer.releaseAnalysisState();
  for (const field of fields) expect(analyzer[field].size).toBe(0);
  expect(analyzer.currentProjectPath).toBe('');
});
