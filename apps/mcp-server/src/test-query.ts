import type { CASOutput, CASNode, CASTestSuite } from '../../../packages/analyzer-core/src/types/cas.types';
import { testsReaching, type GraphTestMatch } from './graph-test-selection';

type Basis = 'exact-by-graph' | 'graph-with-name-guess' | 'explicit-coverage' | 'name-based';

function targetsOf(cas: CASOutput, node?: CASNode): string[] {
  if (!node) return [];
  const file = node.source?.file;
  const held = cas.nodes.filter(other => other.id === node.id || other.parent === node.id || (node.type === 'file' && file !== undefined && other.source?.file === file));
  return held.map(other => other.id);
}

function answerBasis(matches: Array<{ basis: Basis }>): 'exact-by-graph' | 'includes-name-based-matches' | 'no-match' {
  if (matches.length === 0) return 'no-match';
  return matches.every(match => match.basis === 'exact-by-graph' || match.basis === 'explicit-coverage') ? 'exact-by-graph' : 'includes-name-based-matches';
}

function testSupportForQuery(cas: CASOutput, suites: CASTestSuite[], nodeId?: string) {
  const references = new Set(suites.flatMap(suite => [
    suite.id, ...(suite.coverage?.nodes_tested || []),
    ...suite.tests.flatMap(test => [test.id, ...(test.targets || [])]),
  ]));
  if (nodeId) references.add(nodeId);
  const files = suites.map(suite => suite.file_path);
  const fixtures = cas.fixtures || [];
  const byId = new Map(fixtures.map(fixture => [fixture.id, fixture]));
  const included = new Set(fixtures.filter(fixture =>
    fixture.used_by?.some(id => references.has(id)) ||
    Boolean(fixture.file_path && files.some(file => file && projectPathsMatchForQuery(file, fixture.file_path))),
  ).map(fixture => fixture.id));
  const queue = [...included];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const id of byId.get(queue[cursor])?.dependencies || []) {
      if (!byId.has(id) || included.has(id)) continue;
      included.add(id);
      queue.push(id);
    }
  }
  return {
    mocks: (cas.mocks || []).filter(mock =>
      Boolean(mock.target_node && references.has(mock.target_node)) ||
      mock.used_by?.some(id => references.has(id))),
    fixtures: fixtures.filter(fixture => included.has(fixture.id)),
  };
}

export function findTests(cas: CASOutput, opts: { nodeId?: string; filePath?: string; suiteId?: string; limit?: number; offset?: number }) {
  const suites = cas.test_suites || [];
  const mocks = cas.mocks || [];
  const fixtures = cas.fixtures || [];
  const limit = opts.limit || 25;
  const offset = opts.offset || 0;

  if (opts.suiteId) {
    const suite = suites.find(item => item.id === opts.suiteId);
    const page = suite ? [{ ...suite, tests: suite.tests.slice(offset, offset + limit) }] : [];
    return {
      total_suites: suite ? 1 : 0,
      total_tests: suite?.tests.length || 0,
      resolution: { strategy: 'suite-id', suite_id: opts.suiteId, found: Boolean(suite) },
      offset, limit, suites: page,
      ...testSupportForQuery(cas, page),
      next_page: suite && offset + limit < suite.tests.length
        ? { suite_id: suite.id, offset: offset + limit, limit } : null,
    };
  }

  if (opts.nodeId) {
    const node = cas.nodes.find(n => n.id === opts.nodeId);
    const rankedSuites = rankTestSuitesForNode(cas, suites, opts.nodeId, node);
    const relevantSuites = rankedSuites.map(match => match.suite);
    const page = rankedSuites.slice(offset, offset + limit);
    return {
      total_suites: relevantSuites.length,
      suites: relevantSuites.slice(offset, offset + limit),
      ...testSupportForQuery(cas, relevantSuites.slice(offset, offset + limit), opts.nodeId),
      resolution: {
        strategy: 'graph-reach-plus-explicit-coverage-plus-related-test-files',
        answer_basis: answerBasis(rankedSuites),
        node_file: node?.source?.file || null,
        matches: page.map(match => ({
          file_path: match.suite.file_path,
          reason: match.reason,
          score: match.score,
          basis: match.basis,
        })),
      },
    };
  }

  if (opts.filePath) {
    const normalized = normalizeProjectPathForQuery(opts.filePath);
    const inFile = cas.nodes.filter(node => node.source?.file !== undefined && normalizeProjectPathForQuery(node.source.file) === normalized).map(node => node.id);
    const reaching = new Map(testsReaching(cas, inFile).map(match => [normalizeProjectPathForQuery(match.file), match]));
    const rankedSuites = uniqueSuitesForQuery(suites
      .map(suite => {
        const testFile = normalizeProjectPathForQuery(suite.file_path);
        const graph = reaching.get(testFile);
        const score = graph
          ? graph.basis === 'exact-by-graph' ? 100 : 95
          : testFile.includes(normalized)
          ? 100
          : relatedTestCandidates(normalized).some(candidate => projectPathsMatchForQuery(testFile, candidate)) ? 90
            : pathStemForQuery(testFile) === pathStemForQuery(normalized) ? 65
              : 0;
        const basis: Basis = graph ? graph.basis : 'name-based';
        const reason = graph ? graphReason(graph) : score >= 90 ? 'file path match' : score > 0 ? 'related test filename' : '';
        return { suite, score, reason, basis };
      })
      .filter(match => match.score > 0)
      .sort((left, right) => right.score - left.score));
    const relevantSuites = rankedSuites.map(match => match.suite);
    return {
      total_suites: relevantSuites.length,
      suites: relevantSuites.slice(offset, offset + limit),
      ...testSupportForQuery(cas, relevantSuites.slice(offset, offset + limit)),
      resolution: {
        strategy: 'graph-reach-plus-file-path-plus-related-test-files',
        answer_basis: answerBasis(rankedSuites),
        file_path: opts.filePath,
        matches: rankedSuites.slice(offset, offset + limit).map(match => ({
          file_path: match.suite.file_path,
          reason: match.reason,
          score: match.score,
          basis: match.basis,
        })),
      },
    };
  }

  return {
    total_suites: suites.length,
    total_mocks: mocks.length,
    total_fixtures: fixtures.length,
    offset,
    limit,
    suites: suites.slice(offset, offset + limit),
    mocks: mocks.slice(offset, offset + limit),
    fixtures: fixtures.slice(offset, offset + limit),
  };
}

function rankTestSuitesForNode(cas: CASOutput, suites: CASTestSuite[], nodeId: string, node?: CASNode) {
  const nodeFile = node?.source?.file ? normalizeProjectPathForQuery(node.source.file) : '';
  const candidates = nodeFile ? relatedTestCandidates(nodeFile) : [];
  const nodeStem = nodeFile ? pathStemForQuery(nodeFile) : '';
  const reaching = new Map(testsReaching(cas, targetsOf(cas, node)).map(match => [normalizeProjectPathForQuery(match.file), match]));
  return uniqueSuitesForQuery(suites
    .map(suite => {
      const testFile = normalizeProjectPathForQuery(suite.file_path);
      const graph = reaching.get(testFile);
      const coversNode = suite.coverage?.nodes_tested?.includes(nodeId) || suite.tests.some(test => test.targets?.includes(nodeId));
      const colocated = candidates.some(candidate => projectPathsMatchForQuery(testFile, candidate));
      const sameStem = Boolean(nodeStem && pathStemForQuery(testFile) === nodeStem);
      const score = graph?.basis === 'exact-by-graph' || coversNode ? 100 : graph ? 95 : colocated ? 90 : sameStem ? 65 : 0;
      const basis: Basis = graph?.basis === 'exact-by-graph' ? 'exact-by-graph' : coversNode ? 'explicit-coverage' : graph ? 'graph-with-name-guess' : 'name-based';
      const reason = graph?.basis === 'exact-by-graph' || (graph && !coversNode) ? graphReason(graph)
        : coversNode ? 'explicit CAS coverage' : colocated ? 'co-located test file' : sameStem ? 'matching test filename' : '';
      return { suite, score, reason, basis };
    })
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score));
}

function graphReason(match: GraphTestMatch): string {
  const hops = `${match.hops} call${match.hops === 1 ? '' : 's'} away`;
  return match.basis === 'exact-by-graph'
    ? `test '${match.test}' reaches it through resolved calls, ${hops}`
    : `test '${match.test}' reaches it ${hops}, but at least one hop was matched on the name alone`;
}

function uniqueSuitesForQuery<T extends { suite: CASTestSuite }>(matches: T[]) {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const match of matches) {
    if (seen.has(match.suite.file_path)) continue;
    seen.add(match.suite.file_path);
    unique.push(match);
  }
  return unique;
}

function relatedTestCandidates(sourceFile: string): string[] {
  const dir = sourceFile.includes('/') ? sourceFile.split('/').slice(0, -1).join('/') : '';
  const base = sourceFile.split('/').pop() || sourceFile;
  const stem = base.replace(/\.[^.]+$/, '');
  return [
    sourceFile.replace(/\.([cm]?[jt]sx?)$/, '.spec.$1'),
    sourceFile.replace(/\.([cm]?[jt]sx?)$/, '.test.$1'),
    sourceFile.replace(/\.py$/, '_test.py'),
    sourceFile.replace(/\.py$/, '.test.py'),
    sourceFile.endsWith('.py') && dir ? `${dir}/test_${stem}.py` : '',
    sourceFile.endsWith('.py') ? `tests/test_${stem}.py` : '',
    ...pythonApiTestCandidatesForQuery(sourceFile),
    sourceFile.replace(/\.go$/, '_test.go'),
    sourceFile.replace(/\.rs$/, '_test.rs'),
  ].filter(Boolean);
}

function pythonApiTestCandidatesForQuery(sourceFile: string): string[] {
  const normalized = sourceFile.toLowerCase();
  if (!sourceFile.endsWith('.py')) return [];
  if (!/(^|\/)(api|routes|views|controllers)(\/|$)/.test(normalized) && !/(^|\/)(app|main)\.py$/.test(normalized)) return [];
  return [
    'tests/test_api.py',
    'tests/test_app.py',
    'tests/test_routes.py',
  ];
}

function normalizeProjectPathForQuery(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function projectPathsMatchForQuery(left: string, right: string): boolean {
  const normalizedLeft = normalizeProjectPathForQuery(left);
  const normalizedRight = normalizeProjectPathForQuery(right);
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function pathStemForQuery(file: string): string {
  const base = file.split('/').pop() || file;
  return base
    .replace(/\.(spec|test)\.([cm]?[jt]sx?)$/i, '')
    .replace(/^test_/, '')
    .replace(/_test\.(py|go|rs)$/i, '')
    .replace(/\.test\.py$/i, '')
    .replace(/\.([cm]?[jt]sx?|py|go|rs)$/i, '')
    .toLowerCase();
}
