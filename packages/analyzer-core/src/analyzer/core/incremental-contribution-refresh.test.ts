import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASEdge, CASEntryPoint, CASNode, CASOutput, FileAnalysisRecord, FileAnalysisResult } from '../../types/cas.types';
import {
  analyzerOwnershipClosure,
  canReplaceAnalyzerContributions,
  createIncrementalAnalysisSnapshot,
  createIncrementalGraphAccumulator,
  indexIncrementalGraphItemsByFile,
  refreshProjectScopedContributions,
  isRefreshableContribution,
  removeAnalyzerContributions,
  removeFileScopedGraphItems,
  removeFileScopedGraphItemsBatch,
  removeReplaceableFileScopedGraphItems,
  retainedContributionFieldsMatch,
  projectScopedFileAnalysisSnapshot,
  shouldPromoteIncrementalAnalyzerRefresh,
  shouldPreferFullRebuildForFanout,
  updatedIncrementalFileRecord,
} from './incremental-contribution-refresh';
import { linkStructuralOwnership } from './structural-ownership';

function node(id: string, analyzers: string[]): CASNode {
  return {
    id,
    type: 'function',
    name: id,
    analyzers,
    primaryAnalyzer: analyzers[0],
  } as CASNode;
}

function edge(id: string, source: string, target: string, analyzer: string): CASEdge {
  return {
    id,
    source,
    target,
    type: 'calls',
    metadata: { attributes: { source_analyzer: analyzer } },
  } as CASEdge;
}

function entry(source: string, analyzer: string, merged: string[] = []): CASEntryPoint {
  return {
    id: `entry_${source}`,
    source_node: source,
    source_analyzer: analyzer,
    type: 'api',
    name: source,
    metadata: { merged_from_analyzers: merged },
  } as CASEntryPoint;
}

test('incremental file index owns edges through source and target file identities', () => {
  const fileNode = { ...node('file', ['language']), type: 'file', source: { file: 'src/file.ts', line: 1 } } as CASNode;
  const aggregateNode = node('module', ['language']);
  const attached = edge('module_contains_file', aggregateNode.id, fileNode.id, 'language');
  const index = indexIncrementalGraphItemsByFile('/workspace', {
    nodes: [aggregateNode, fileNode], edges: [attached], entry_points: [], exit_points: [],
  });
  assert.deepEqual(index.edgesByFile.get('src/file.ts')?.map(item => item.id), [attached.id]);
});

test('derived graph items attached to replaced nodes do not expand analyzer ownership', () => {
  const derivedEdge = edge('derived_edge', 'owned', 'retained', 'orchestrator');
  derivedEdge.metadata!.attributes!.contribution_scope = 'derived-rebuild';
  const derivedEntry = entry('owned', 'orchestrator');
  derivedEntry.metadata = {
    ...derivedEntry.metadata,
    attributes: { source_analyzer: 'orchestrator', contribution_scope: 'derived-rebuild' },
  };
  const graph = {
    nodes: [node('owned', ['framework']), node('retained', ['language'])],
    edges: [derivedEdge],
    entryPoints: [derivedEntry],
    exitPoints: [],
  };

  const closure = analyzerOwnershipClosure(graph, new Set(['framework']), new Set(['framework']));
  assert.deepEqual([...closure], ['framework']);
  assert.equal(canReplaceAnalyzerContributions(graph, closure), true);
  assert.deepEqual(removeAnalyzerContributions(graph, closure), {
    nodes: [graph.nodes[1]],
    edges: [],
    entryPoints: [],
    exitPoints: [],
  });
});

test('derived structural ownership does not make analyzer contributions non-replaceable', () => {
  const owned = node('owned', ['framework']);
  owned.parent = 'retained';
  const retained = node('retained', ['language']);
  const graph = { nodes: [owned, retained], edges: [] as CASEdge[], entryPoints: [], exitPoints: [] };

  linkStructuralOwnership(graph.nodes, graph.edges);

  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0].metadata?.attributes, {
    source_analyzer: 'orchestrator',
    contribution_scope: 'derived-rebuild',
    relationship: 'structural_ownership',
    resolution: 'declared-parent',
  });
  assert.equal(canReplaceAnalyzerContributions(graph, new Set(['framework'])), true);
});

test('project refresh reports a classified ownership failure without running analyzers', async () => {
  const failures: Array<{ reason: string }> = [];
  const graph = {
    nodes: [node('owned', ['framework']), node('retained', ['language'])],
    edges: [{ id: 'unknown', source: 'owned', target: 'retained', type: 'calls' } as CASEdge],
    entryPoints: [],
    exitPoints: [],
  };
  const refreshed = await refreshProjectScopedContributions({
    projectPath: '/workspace',
    registrations: [{ id: 'framework', type: 'framework', analyzer: { analyze: async () => { throw new Error('must not run'); } } }],
    analyzerIds: new Set(['framework']), graph, ownershipGraph: graph,
    analyzerRoot: () => '/workspace', analysisFilters: [], scopeFilters: () => [],
    normalizeContribution: () => undefined, mergeContribution: async current => current,
    onFailure: failure => failures.push(failure),
  });

  assert.equal(refreshed, null);
  assert.deepEqual(failures, [{ reason: 'non-replaceable-ownership', analyzerIds: ['framework'] }]);
});

test('unmarked non-registered graph ownership still fails closed', () => {
  const graph = {
    nodes: [node('owned', ['framework']), node('retained', ['language'])],
    edges: [edge('unmarked', 'owned', 'retained', 'postprocessor')],
    entryPoints: [],
    exitPoints: [],
  };

  assert.equal(canReplaceAnalyzerContributions(graph, new Set(['framework'])), false);
});

test('file replacement retains nodes wholly owned by a project-scoped analyzer', () => {
  const graph = {
    nodes: [node('language-node', ['language']), node('framework-node', ['framework'])],
    edges: [],
    entryPoints: [],
    exitPoints: [],
  };
  const record = {
    filePath: 'controller.rb', contentHash: 'old', mtimeMs: 1, lastAnalyzed: '', analyzerId: 'language',
    nodeIds: ['language-node', 'framework-node'], edgeIds: [], entryPointIds: [], exitPointIds: [],
    importedFiles: [], exportedSymbols: [],
  };

  assert.equal(removeReplaceableFileScopedGraphItems(graph, record, new Set(['language'])), false);
  const deferred: string[][] = [];
  assert.equal(removeReplaceableFileScopedGraphItems(
    graph, record, new Set(['language']), analyzerIds => deferred.push([...analyzerIds])
  ), true);
  assert.deepEqual(graph.nodes.map(item => item.id), ['framework-node']);
  assert.deepEqual(deferred, [['framework']]);
});

test('explicit deferral retains a shared node and reports its complete ownership set', () => {
  const graph = { nodes: [node('shared', ['language', 'framework'])], edges: [], entryPoints: [], exitPoints: [] };
  const record = {
    filePath: 'controller.java', contentHash: 'old', mtimeMs: 1, lastAnalyzed: '', analyzerId: 'language',
    nodeIds: ['shared'], edgeIds: [], entryPointIds: [], exitPointIds: [], importedFiles: [], exportedSymbols: [],
  };
  const deferred: string[][] = [];

  assert.equal(removeReplaceableFileScopedGraphItems(
    graph, record, new Set(['language']), analyzerIds => deferred.push([...analyzerIds])
  ), true);
  assert.deepEqual(graph.nodes.map(item => item.id), ['shared']);
  assert.deepEqual(deferred, [['language', 'framework']]);
});

test('shared node ownership still expands the replaceable analyzer closure', () => {
  const graph = {
    nodes: [node('shared', ['framework', 'language'])],
    edges: [],
    entryPoints: [],
    exitPoints: [],
  };

  const closure = analyzerOwnershipClosure(graph, new Set(['framework']));
  assert.deepEqual([...closure], ['framework', 'language']);
  assert.equal(canReplaceAnalyzerContributions(graph, closure), true);
});

test('registered analyzers attached to replaced nodes join the refresh closure', () => {
  const graph = {
    nodes: [node('owned', ['language'])],
    edges: [],
    entryPoints: [],
    exitPoints: [entry('owned', 'outbound-http-client')],
  };

  const closure = analyzerOwnershipClosure(
    graph,
    new Set(['language']),
    new Set(['language', 'outbound-http-client'])
  );
  assert.deepEqual([...closure], ['language', 'outbound-http-client']);
});

test('merged endpoint ownership remains atomic', () => {
  const graph = {
    nodes: [node('retained', ['language'])],
    edges: [],
    entryPoints: [entry('retained', 'framework', ['framework', 'library'])],
    exitPoints: [],
  };

  const closure = analyzerOwnershipClosure(graph, new Set(['framework']));
  assert.deepEqual([...closure], ['framework', 'library']);
  assert.equal(canReplaceAnalyzerContributions(graph, new Set(['framework'])), false);
});

test('project refresh fails closed when attached graph facts have unknown ownership', () => {
  const graph = {
    nodes: [node('owned', ['framework']), node('retained', ['language'])],
    edges: [{ id: 'unknown', source: 'owned', target: 'retained', type: 'calls' } as CASEdge],
    entryPoints: [],
    exitPoints: [],
  };

  assert.equal(canReplaceAnalyzerContributions(graph, new Set(['framework'])), false);
});

test('project refresh never runs after complete replaceability cannot be proven', async () => {
  let analyzeCalls = 0;
  const graph = {
    nodes: [node('owned', ['framework']), node('retained', ['language'])],
    edges: [{ id: 'unknown', source: 'owned', target: 'retained', type: 'calls' } as CASEdge],
    entryPoints: [],
    exitPoints: [],
  };
  const refreshed = await refreshProjectScopedContributions({
    projectPath: '/workspace',
    registrations: [{
      id: 'framework', type: 'framework', analyzer: { analyze: async () => {
        analyzeCalls += 1;
        return {
          nodes: [], edges: [], entry_points: [], exit_points: [],
          analyzer_metadata: {
            analyzer_id: 'framework', analyzer_name: 'Framework', version: '1',
            contribution_type: 'framework', nodes_contributed: 0, edges_contributed: 0,
            contributed_entry_points: 0, contributed_exit_points: 0,
          },
        };
      } },
    }],
    analyzerIds: new Set(['framework']),
    graph,
    ownershipGraph: graph,
    analyzerRoot: () => '/workspace',
    analysisFilters: [],
    scopeFilters: () => [],
    normalizeContribution: () => undefined,
    mergeContribution: async current => current,
  });

  assert.equal(refreshed, null);
  assert.equal(analyzeCalls, 0);
});

test('project refresh preserves base analysis filters and analyzer scope filters', async () => {
  const observedFilters: string[][] = [];
  const graph = { nodes: [node('owned', ['language'])], edges: [], entryPoints: [], exitPoints: [] };
  const refreshed = await refreshProjectScopedContributions({
    projectPath: '/workspace',
    registrations: [{
      id: 'language',
      type: 'language',
      analyzer: {
        analyze: async context => {
          observedFilters.push(context.filters || []);
          return {
            nodes: [],
            edges: [],
            entry_points: [],
            exit_points: [],
            analyzer_metadata: {
              analyzer_id: 'language',
              analyzer_name: 'Language',
              version: '1',
              contribution_type: 'language',
              nodes_contributed: 0,
              edges_contributed: 0,
              contributed_entry_points: 0,
              contributed_exit_points: 0,
            },
          };
        },
      },
    }],
    analyzerIds: new Set(['language']),
    graph,
    ownershipGraph: graph,
    analyzerRoot: () => '/workspace/package',
    analysisFilters: ['**/*credential*/**'],
    scopeFilters: () => ['sibling/**'],
    normalizeContribution: () => undefined,
    mergeContribution: async current => current,
  });

  assert.ok(refreshed);
  assert.deepEqual(observedFilters, [['**/*credential*/**', 'sibling/**']]);
});

test('promotes repeated contextual file analysis after the square-root crossover', () => {
  assert.equal(shouldPromoteIncrementalAnalyzerRefresh(1, 1), false);
  assert.equal(shouldPromoteIncrementalAnalyzerRefresh(5, 100), false);
  assert.equal(shouldPromoteIncrementalAnalyzerRefresh(11, 100), true);
  assert.equal(shouldPromoteIncrementalAnalyzerRefresh(275, 1003), true);
});

test('prefers a full rebuild only when project-scoped refresh duplicates a broad affected closure', () => {
  assert.equal(shouldPreferFullRebuildForFanout(50, 100, 1), false);
  assert.equal(shouldPreferFullRebuildForFanout(511, 1_000, 1), false);
  assert.equal(shouldPreferFullRebuildForFanout(512, 1_024, 1), false);
  assert.equal(shouldPreferFullRebuildForFanout(1_000, 1_000, 1), true);
  assert.equal(shouldPreferFullRebuildForFanout(1_000, 1_000, 0), false);
  assert.equal(shouldPreferFullRebuildForFanout(1, 0, 1), false);
});

test('rejects non-graph analyzer facts that cannot be transactionally replaced', () => {
  assert.equal(isRefreshableContribution({
    nodes: [],
    libraries: [{ id: 'lib', name: 'Library' }],
    analyzer_metadata: {
      analyzer_id: 'library',
      analyzer_name: 'Library',
      contribution_type: 'library',
    },
  }), false);
});

test('project refresh fails closed when non-graph facts lack an explicit retention contract', async () => {
  let analyzeCalls = 0;
  const graph = { nodes: [node('owned', ['framework'])], edges: [], entryPoints: [], exitPoints: [] };
  const refreshed = await refreshProjectScopedContributions({
    projectPath: '/workspace',
    registrations: [{
      id: 'framework', type: 'framework', analyzer: { analyze: async () => {
        analyzeCalls += 1;
        return { nodes: [], edges: [], entry_points: [], exit_points: [], categories: { '1': {} } };
      } },
    }],
    analyzerIds: new Set(['framework']), graph, ownershipGraph: graph,
    analyzerRoot: () => '/workspace', analysisFilters: [], scopeFilters: () => [],
    retainedContribution: { categories: { '1': {} } },
    normalizeContribution: () => undefined, mergeContribution: async current => current,
  });

  assert.equal(refreshed, null);
  assert.equal(analyzeCalls, 1);
  assert.deepEqual(graph.nodes.map(item => item.id), ['owned']);
});

test('project refresh accepts declared retained facts only when they match persisted values', async () => {
  const graph = { nodes: [node('owned', ['framework'])], edges: [], entryPoints: [], exitPoints: [] };
  const run = (description: string) => refreshProjectScopedContributions({
    projectPath: '/workspace',
    registrations: [{
      id: 'framework', type: 'framework', analyzer: {
        incrementalSourceInvariantContributionFields: () => ['categories'] as const,
        analyze: async () => ({
          nodes: [node('replacement', ['framework'])], edges: [], entry_points: [], exit_points: [],
          categories: { '1': { modules: { name: 'Modules', types: ['file'], description } } },
        }),
      },
    }],
    analyzerIds: new Set(['framework']), graph, ownershipGraph: graph,
    analyzerRoot: () => '/workspace', analysisFilters: [], scopeFilters: () => [],
    retainedContribution: {
      categories: { '1': { modules: { name: 'Modules', types: ['file'], description: 'stable' } } },
    },
    normalizeContribution: () => undefined,
    mergeContribution: async (current, contribution) => ({
      ...current,
      nodes: [...current.nodes, ...(contribution.nodes || [])],
    }),
  });

  assert.ok(await run('stable'));
  assert.equal(await run('changed'), null);
});

test('retained category comparison rejects removed object keys', () => {
  assert.equal(retainedContributionFieldsMatch(
    { nodes: [], categories: { '1': { modules: { name: 'Modules', types: ['file'] } } } },
    { categories: {
      '1': { modules: { name: 'Modules', types: ['file'] } },
      '2': { services: { name: 'Services', types: ['service'] } },
    } },
    new Set(['categories'])
  ), false);
});

test('retained array comparison rejects removed identified items', () => {
  assert.equal(retainedContributionFieldsMatch(
    { nodes: [], libraries: [{ id: 'one', name: 'One' }] },
    { libraries: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] },
    new Set(['libraries'])
  ), false);
});

test('retained perspectives compare only the declaring analyzer slice', () => {
  const current = { id: 'nestjs-flow', name: 'Request Flow', description: 'Nest flow', analyzer_id: 'nestjs', type: 'flow' as const };
  const other = { id: 'other-flow', name: 'Other Flow', description: 'Other flow', analyzer_id: 'other', type: 'flow' as const };
  assert.equal(isRefreshableContribution({ nodes: [], perspectives: [current], provided_perspectives: [current.id] }, new Set(['perspectives'])), true);
  assert.equal(retainedContributionFieldsMatch(
    { nodes: [], perspectives: [current] },
    { perspectives: [other, current] },
    new Set(['perspectives'])
  ), true);
  assert.equal(retainedContributionFieldsMatch(
    { nodes: [], perspectives: [{ ...current, description: 'Changed' }] },
    { perspectives: [current] },
    new Set(['perspectives'])
  ), false);
});

test('file replacement removes prior same-id facts before adding changed facts', () => {
  const previous = node('same', ['language']);
  previous.name = 'old';
  const graph = { nodes: [previous], edges: [], entryPoints: [], exitPoints: [] };
  const record = {
    filePath: 'source.ts', contentHash: 'old', mtimeMs: 1, lastAnalyzed: 'before', analyzerId: 'language',
    nodeIds: ['same'], edgeIds: [], entryPointIds: [], exitPointIds: [], importedFiles: [], exportedSymbols: [],
  } satisfies FileAnalysisRecord;

  assert.equal(removeReplaceableFileScopedGraphItems(graph, record, new Set(['language'])), true);
  createIncrementalGraphAccumulator(graph)({
    filePath: 'source.ts', contentHash: 'new', mtimeMs: 2,
    nodes: [{ ...previous, name: 'new' }], edges: [], entryPoints: [], exitPoints: [], imports: [], exports: [],
  });
  assert.deepEqual(graph.nodes.map(item => item.name), ['new']);
});

test('file replacement fails closed when node fields have shared analyzer ownership', () => {
  const graph = { nodes: [node('shared', ['language', 'framework'])], edges: [], entryPoints: [], exitPoints: [] };
  const record = {
    filePath: 'source.ts', contentHash: 'old', mtimeMs: 1, lastAnalyzed: 'before', analyzerId: 'language',
    nodeIds: ['shared'], edgeIds: [], entryPointIds: [], exitPointIds: [], importedFiles: [], exportedSymbols: [],
  } satisfies FileAnalysisRecord;

  assert.equal(removeReplaceableFileScopedGraphItems(graph, record, new Set(['language'])), false);
  assert.equal(graph.nodes.length, 1);
});

test('project refresh is sequential, canonical, and transactional on analyzer failure', async () => {
  const calls: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const graph = { nodes: [node('owned', ['zeta', 'alpha'])], edges: [], entryPoints: [], exitPoints: [] };
  const registrations = ['zeta', 'alpha'].map(id => ({
    id,
    type: 'framework' as const,
    analyzer: {
      analyze: async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        calls.push(id);
        active--;
        if (id === 'zeta') throw new Error('failed');
        return { nodes: [], edges: [], entry_points: [], exit_points: [] };
      },
    },
  }));
  const refreshed = await refreshProjectScopedContributions({
    projectPath: '/workspace', registrations, analyzerIds: new Set(['zeta', 'alpha']), graph,
    ownershipGraph: graph, analyzerRoot: () => '/workspace', analysisFilters: [], scopeFilters: () => [],
    normalizeContribution: () => undefined, mergeContribution: async current => current,
  });

  assert.equal(refreshed, null);
  assert.deepEqual(calls, ['alpha', 'zeta']);
  assert.equal(maximumActive, 1);
  assert.deepEqual(graph.nodes.map(item => item.id), ['owned']);
});

test('project refresh returns the untouched graph boundary when merge fails', async () => {
  const graph = { nodes: [node('owned', ['framework'])], edges: [], entryPoints: [], exitPoints: [] };
  const refreshed = await refreshProjectScopedContributions({
    projectPath: '/workspace',
    registrations: [{
      id: 'framework', type: 'framework', analyzer: {
        analyze: async () => ({ nodes: [node('replacement', ['framework'])], edges: [] }),
      },
    }],
    analyzerIds: new Set(['framework']), graph, ownershipGraph: graph,
    analyzerRoot: () => '/workspace', analysisFilters: [], scopeFilters: () => [],
    normalizeContribution: () => undefined,
    mergeContribution: async () => { throw new Error('merge failed'); },
  });

  assert.equal(refreshed, null);
  assert.deepEqual(graph.nodes.map(item => item.id), ['owned']);
});

test('incremental snapshots replace same-id facts for subsequent analyzers', () => {
  const oldNode = node('same', ['language']);
  oldNode.name = 'old';
  const snapshot = createIncrementalAnalysisSnapshot({ nodes: [oldNode], edges: [] });
  snapshot.append({
    filePath: 'source.ts', contentHash: 'new', mtimeMs: 2,
    nodes: [{ ...oldNode, name: 'new' }], edges: [], entryPoints: [], exitPoints: [], imports: [], exports: [],
  });

  assert.deepEqual(snapshot.current().nodes?.map(item => item.name), ['new']);
});

test('reanalysis of an unchanged dependent removes only file-scoped analyzer graph items', () => {
  const languageEdge = edge('language-edge', 'file', 'target', 'language');
  const frameworkEdge = edge('framework-edge', 'file', 'handler', 'framework');
  const graph = {
    nodes: [node('file', ['language', 'framework']), node('target', ['language']), node('handler', ['framework'])],
    edges: [languageEdge, frameworkEdge],
    entryPoints: [entry('file', 'framework')],
    exitPoints: [],
  };
  const record = {
    filePath: 'dependent.ts',
    contentHash: 'hash',
    mtimeMs: 1,
    lastAnalyzed: 'now',
    analyzerId: 'language',
    nodeIds: ['file'],
    edgeIds: [languageEdge.id, frameworkEdge.id],
    entryPointIds: ['entry_file'],
    exitPointIds: [],
    importedFiles: [],
    exportedSymbols: [],
  } satisfies FileAnalysisRecord;

  removeFileScopedGraphItems(graph, record, new Set(['language']));

  assert.deepEqual(graph.edges.map(item => item.id), ['framework-edge']);
  assert.deepEqual(graph.entryPoints.map(item => item.id), ['entry_file']);
});

test('batched dependent reanalysis applies every file ownership rule in one graph pass', () => {
  const firstLanguageEdge = edge('first-language', 'first', 'target', 'language');
  const sharedFrameworkEdge = edge('shared', 'first', 'second', 'framework');
  const secondLibraryEdge = edge('second-library', 'second', 'target', 'library');
  const graph = {
    nodes: [],
    edges: [firstLanguageEdge, sharedFrameworkEdge, secondLibraryEdge],
    entryPoints: [],
    exitPoints: [],
  };
  const record = (filePath: string, edgeIds: string[]): FileAnalysisRecord => ({
    filePath,
    contentHash: 'hash',
    mtimeMs: 1,
    lastAnalyzed: 'now',
    analyzerId: 'language',
    nodeIds: [],
    edgeIds,
    entryPointIds: [],
    exitPointIds: [],
    importedFiles: [],
    exportedSymbols: [],
  });

  removeFileScopedGraphItemsBatch(graph, [
    { record: record('first.ts', ['first-language', 'shared']), analyzerIds: new Set(['language']) },
    { record: record('second.ts', ['shared', 'second-library']), analyzerIds: new Set(['library']) },
  ]);

  assert.deepEqual(graph.edges.map(item => item.id), ['shared']);
});

test('project-scoped single-file snapshots exclude unrelated graph scale', () => {
  const local = { ...node('local', ['language']), source: { file: 'src/local.ts', line: 1 } } as CASNode;
  const related = { ...node('related', ['language']), source: { file: 'src/local.ts', line: 2 } } as CASNode;
  const remote = { ...node('remote', ['language']), source: { file: 'src/remote.ts', line: 1 } } as CASNode;
  const snapshot = projectScopedFileAnalysisSnapshot({
    nodes: [local, related, remote],
    edges: [edge('local-edge', local.id, related.id, 'language'), edge('remote-edge', local.id, remote.id, 'language')],
    entry_points: [entry(local.id, 'language'), entry(remote.id, 'language')],
    exit_points: [],
  }, 'src/local.ts');

  assert.deepEqual(snapshot.nodes?.map(item => item.id), ['local', 'related']);
  assert.deepEqual(snapshot.edges?.map(item => item.id), ['local-edge']);
  assert.deepEqual(snapshot.entry_points?.map(item => item.id), ['entry_local']);
});

test('incremental graph accumulation does not duplicate retained nodes', () => {
  const retained = node('file', ['language', 'framework']);
  const graph = { nodes: [retained], edges: [], entryPoints: [], exitPoints: [] };
  const append = createIncrementalGraphAccumulator(graph);
  append({
    filePath: 'dependent.ts',
    contentHash: 'hash',
    mtimeMs: 1,
    nodes: [node('file', ['language'])],
    edges: [],
    entryPoints: [],
    exitPoints: [],
    imports: [],
    exports: [],
  });

  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0], retained);
});

test('incremental file state retains live auxiliary facts for unchanged dependents', () => {
  const previous = {
    filePath: 'dependent.ts',
    contentHash: 'hash',
    mtimeMs: 1,
    lastAnalyzed: 'before',
    analyzerId: 'language',
    nodeIds: ['file'],
    edgeIds: ['language-edge', 'framework-edge'],
    entryPointIds: ['entry_file'],
    exitPointIds: [],
    importedFiles: [],
    exportedSymbols: [],
  } satisfies FileAnalysisRecord;
  const result: FileAnalysisResult = {
    filePath: 'dependent.ts',
    contentHash: 'hash',
    mtimeMs: 1,
    nodes: [node('file', ['language'])],
    edges: [edge('language-edge', 'file', 'target', 'language')],
    entryPoints: [],
    exitPoints: [],
    imports: [],
    exports: [],
  };
  const output = {
    nodes: [node('file', ['language', 'framework'])],
    edges: [result.edges[0], edge('framework-edge', 'file', 'handler', 'framework')],
    entry_points: [entry('file', 'framework')],
    exit_points: [],
  } as CASOutput;

  const updated = updatedIncrementalFileRecord({ previous, result, output, preservePreviousFacts: true });

  assert.deepEqual(updated.edgeIds.sort(), ['framework-edge', 'language-edge']);
  assert.deepEqual(updated.entryPointIds, ['entry_file']);
});
