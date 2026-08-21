import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { captureAnalysisMemorySample } from '../../analyzer/core/analysis-memory-profile';
import { AnalyzerSourceCorpus, getActiveSourceCorpus } from '../../analyzer/core/source-corpus';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { CallGraphBuilder } from '../../analyzer/core/call-graph-builder';
import { withAnalyzerFileReadCache } from '../../analyzer/core/analyzer-file-read-cache';

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

test('source corpus releases captured content without losing completed statistics', () => {
  const corpus = new AnalyzerSourceCorpus();
  corpus.capture('/project/src/large.ts', `export const value = '${'x'.repeat(4096)}';`);
  const completed = corpus.stats();

  corpus.clear();

  expect(corpus.get('/project/src/large.ts')).toBeUndefined();
  expect(completed.files).toBe(1);
  expect(corpus.stats().files).toBe(0);
});

test('analysis read-cache scope clears file and corpus ownership on exit', async () => {
  let corpus: AnalyzerSourceCorpus | undefined;
  await withAnalyzerFileReadCache(async () => {
    corpus = getActiveSourceCorpus();
    corpus?.capture('/project/src/large.ts', `export const value = '${'x'.repeat(4096)}';`);
  });

  expect(corpus?.get('/project/src/large.ts')).toBeUndefined();
  expect(corpus?.stats().files).toBe(0);
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

test('call graph indexes release their graph references after their final consumer', () => {
  const builder = new CallGraphBuilder(
    [{ id: 'source' }, { id: 'target' }] as any,
    [{ id: 'edge', source: 'source', target: 'target', type: 'calls' }] as any,
  ) as any;
  expect(builder.nodeIndex.size).toBe(2);
  expect(builder.edgeIndex.size).toBe(1);
  builder.release();
  for (const field of ['callerIndex', 'calleeIndex', 'nodeIndex', 'edgeIndex', 'exitPointNodes', 'exitPointIndex']) {
    expect(builder[field].size).toBe(0);
  }
});
