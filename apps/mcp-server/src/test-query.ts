import type { CASOutput, CASNode, CASTestSuite } from '../../../packages/analyzer-core/src/types/cas.types';

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
    return {
      total_suites: relevantSuites.length,
      suites: relevantSuites.slice(offset, offset + limit),
      ...testSupportForQuery(cas, relevantSuites.slice(offset, offset + limit), opts.nodeId),
      resolution: {
        strategy: 'explicit-coverage-plus-related-test-files',
        node_file: node?.source?.file || null,
        matches: rankedSuites.slice(offset, offset + limit).map(match => ({
          file_path: match.suite.file_path,
          reason: match.reason,
          score: match.score,
        })),
      },
    };
  }

  if (opts.filePath) {
    const normalized = normalizeProjectPathForQuery(opts.filePath);
    const rankedSuites = uniqueSuitesForQuery(suites
      .map(suite => {
        const testFile = normalizeProjectPathForQuery(suite.file_path);
        const score = testFile.includes(normalized)
          ? 100
          : relatedTestCandidates(normalized).some(candidate => projectPathsMatchForQuery(testFile, candidate)) ? 90
            : pathStemForQuery(testFile) === pathStemForQuery(normalized) ? 65
              : 0;
        return { suite, score, reason: score >= 90 ? 'file path match' : score > 0 ? 'related test filename' : '' };
      })
      .filter(match => match.score > 0)
      .sort((left, right) => right.score - left.score));
    const relevantSuites = rankedSuites.map(match => match.suite);
    return {
      total_suites: relevantSuites.length,
      suites: relevantSuites.slice(offset, offset + limit),
      ...testSupportForQuery(cas, relevantSuites.slice(offset, offset + limit)),
      resolution: {
        strategy: 'file-path-plus-related-test-files',
        file_path: opts.filePath,
        matches: rankedSuites.slice(offset, offset + limit).map(match => ({
          file_path: match.suite.file_path,
          reason: match.reason,
          score: match.score,
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
  return uniqueSuitesForQuery(suites
    .map(suite => {
      const testFile = normalizeProjectPathForQuery(suite.file_path);
      const coversNode = suite.coverage?.nodes_tested?.includes(nodeId) || suite.tests.some(test => test.targets?.includes(nodeId));
      const colocated = candidates.some(candidate => projectPathsMatchForQuery(testFile, candidate));
      const sameStem = Boolean(nodeStem && pathStemForQuery(testFile) === nodeStem);
      const score = coversNode ? 100 : colocated ? 90 : sameStem ? 65 : 0;
      const reason = coversNode ? 'explicit CAS coverage' : colocated ? 'co-located test file' : sameStem ? 'matching test filename' : '';
      return { suite, score, reason };
    })
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score));
}

function uniqueSuitesForQuery(matches: Array<{ suite: CASTestSuite; score: number; reason: string }>) {
  const seen = new Set<string>();
  const unique: Array<{ suite: CASTestSuite; score: number; reason: string }> = [];
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
