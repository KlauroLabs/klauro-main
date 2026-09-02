import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BaseAnalyzer, AnalysisContext } from './base-analyzer';
import { CASContribution } from '../../types/cas.types';

// Concrete, minimal BaseAnalyzer subclass so these tests can exercise the
// protected createContribution/createEntryPoint/createNode helpers directly —
// the generic handler backfill lives in BaseAnalyzer and must work for ANY
// analyzer, not just react/async-messaging, so a bare-bones stand-in analyzer
// is the right fixture (no framework-specific behavior to entangle it with).
class TestAnalyzer extends BaseAnalyzer {
  constructor() {
    super('test-analyzer', 'Test Analyzer', '1.0.0', 'pattern');
  }

  async canAnalyze(): Promise<boolean> {
    return true;
  }

  async analyze(_context: AnalysisContext): Promise<CASContribution> {
    return this.createContribution();
  }

  protected getCapabilities(): string[] {
    return [];
  }

  protected getLevelName(level: number): string {
    return `level_${level}`;
  }

  // Test-only passthroughs to the protected builder helpers.
  public buildNode(id: string, name: string, type: string, file?: string, line?: number) {
    return this.createNode(id, name, type, 3, file, line);
  }

  public buildEntryPoint(id: string, sourceNode: string, name: string, handler?: any) {
    return this.createEntryPoint(id, sourceNode, 'event', name, undefined, undefined, undefined, undefined, handler);
  }

  // Test-only passthroughs to the protected ignore-pattern helpers.
  public exposedIgnorePatterns(context: AnalysisContext): string[] {
    return this.getIgnorePatterns(context);
  }

  public exposedPackageDirSafeIgnorePatterns(context: AnalysisContext): string[] {
    return this.getPackageDirSafeIgnorePatterns(context);
  }

  public buildContribution(nodes: any[], entryPoints: any[], metadata: Record<string, any> = {}): CASContribution {
    return this.createContribution(nodes, [], entryPoints, [], metadata);
  }

  public selectSourceFiles(files: string[]): string[] {
    return this.capAndPrioritizeSourceFiles(files, 'test source files');
  }

  public exposedPyprojectHasRealDependency(pyprojectContent: string, needle: string): boolean {
    return this.pyprojectHasRealDependency(pyprojectContent, needle);
  }
}

test('canonical analyzer extraction retains files beyond the former per-analyzer cap', () => {
  const previousLimit = process.env.KLAURO_MAX_FILES_PER_ANALYZER;
  process.env.KLAURO_MAX_FILES_PER_ANALYZER = '2';
  try {
    const analyzer = new TestAnalyzer();
    const files = [
      'src/first.ts',
      'src/second.ts',
      'src/beyond-former-cap.ts',
    ];

    assert.deepEqual(analyzer.selectSourceFiles(files), files);
  } finally {
    if (previousLimit === undefined) delete process.env.KLAURO_MAX_FILES_PER_ANALYZER;
    else process.env.KLAURO_MAX_FILES_PER_ANALYZER = previousLimit;
  }
});

test('analyzer coverage metadata cannot claim complete when analyzed files are below eligible files', () => {
  const analyzer = new TestAnalyzer();
  const contribution = analyzer.buildContribution([], [], {
    analysis_scope: {
      files_eligible: 3,
      files_analyzed: 2,
      files_skipped: 0,
      complete: true,
    },
  });

  assert.equal(contribution.analyzer_metadata?.analysis_scope?.complete, false);
  assert.match(
    contribution.analyzer_metadata?.warnings?.join('\n') || '',
    /incomplete source coverage: analyzed 2 of 3 eligible files/,

  );
});
test('BaseAnalyzer backfills entry_point.handler from a backing node with a real source location (UI-event-like case)', () => {
  const analyzer = new TestAnalyzer();
  const componentNode = analyzer.buildNode('component_1', 'Checkout', 'functional_component', '/repo/src/Checkout.tsx', 1);
  const entryPoint = analyzer.buildEntryPoint('entry_1', 'component_1', 'Checkout click');

  const contribution = analyzer.buildContribution([componentNode], [entryPoint]);
  const backfilled = contribution.entry_points![0];

  assert.equal(backfilled.handler?.node_id, 'component_1');
  assert.equal(backfilled.handler?.method_name, 'Checkout');
  assert.equal(backfilled.handler?.file, '/repo/src/Checkout.tsx');
  assert.equal(backfilled.handler?.line, 1);
});

test('BaseAnalyzer backfills entry_point.handler from a backing node with a real source location (message-consumer-like case)', () => {
  const analyzer = new TestAnalyzer();
  const consumerNode = analyzer.buildNode('consumer_1', 'orders.created consumer', 'consumer', '/repo/src/kafka.ts', 12);
  const entryPoint = analyzer.buildEntryPoint('entry_2', 'consumer_1', 'orders.created consumer');

  const contribution = analyzer.buildContribution([consumerNode], [entryPoint]);
  const backfilled = contribution.entry_points![0];

  assert.equal(backfilled.handler?.node_id, 'consumer_1');
  assert.equal(backfilled.handler?.file, '/repo/src/kafka.ts');
  assert.equal(backfilled.handler?.line, 12);
});

test('BaseAnalyzer never fabricates a handler when the backing node has no resolvable source', () => {
  const analyzer = new TestAnalyzer();
  // Node exists but was built without a file (no `.withSource(...)` evidence).
  const noSourceNode = analyzer.buildNode('node_no_source', 'Mystery', 'util');
  const entryPointForNoSourceNode = analyzer.buildEntryPoint('entry_3', 'node_no_source', 'Mystery util');

  // source_node references a node id that isn't even in the nodes array.
  const entryPointForMissingNode = analyzer.buildEntryPoint('entry_4', 'does_not_exist', 'Ghost entry');

  const contribution = analyzer.buildContribution(
    [noSourceNode],
    [entryPointForNoSourceNode, entryPointForMissingNode]
  );

  for (const entryPoint of contribution.entry_points!) {
    assert.equal(entryPoint.handler, undefined, `expected no fabricated handler for ${entryPoint.id}`);
  }
});

test('BaseAnalyzer respects an explicit handler already set by the analyzer and does not overwrite it', () => {
  const analyzer = new TestAnalyzer();
  const componentNode = analyzer.buildNode('component_2', 'Precise', 'functional_component', '/repo/src/Other.tsx', 99);
  const explicitHandler = { node_id: 'some_other_node', method_name: 'preciseHandler', file: '/repo/src/handlers/precise.ts', line: 7 };
  const entryPoint = analyzer.buildEntryPoint('entry_5', 'component_2', 'Precise click', explicitHandler);

  const contribution = analyzer.buildContribution([componentNode], [entryPoint]);
  const result = contribution.entry_points![0];

  assert.deepEqual(result.handler, explicitHandler);
});

// ---------------------------------------------------------------------------
// Ignore-pattern regressions (scaffold-paths.ts centralization)
// ---------------------------------------------------------------------------

test('getIgnorePatterns excludes __tests__/ alongside fixtures/testdata/cas-tests', () => {
  const analyzer = new TestAnalyzer();
  const patterns = analyzer.exposedIgnorePatterns({ projectPath: '/repo' });
  assert.ok(patterns.includes('**/__tests__/**'), 'must exclude **/__tests__/**');
  assert.ok(patterns.includes('__tests__/**'), 'must exclude __tests__/**');
  assert.ok(patterns.includes('**/fixtures/**'), 'must still exclude **/fixtures/**');
  assert.ok(patterns.includes('**/testdata/**'), 'must still exclude **/testdata/**');
  assert.ok(patterns.includes('**/cas-tests/**'), 'must still exclude **/cas-tests/**');
});

test('agent-fast focus cannot exclude first-party legacy directories from canonical extraction', () => {
  const previous = process.env.KLAURO_AGENT_FAST_EXCLUDE_LEGACY;
  process.env.KLAURO_AGENT_FAST_EXCLUDE_LEGACY = 'true';
  try {
    const analyzer = new TestAnalyzer();
    const patterns = analyzer.exposedIgnorePatterns({ projectPath: '/repo' });
    assert.ok(!patterns.includes('legacy/**'));
    assert.ok(!patterns.includes('**/legacy/**'));
  } finally {
    if (previous === undefined) delete process.env.KLAURO_AGENT_FAST_EXCLUDE_LEGACY;
    else process.env.KLAURO_AGENT_FAST_EXCLUDE_LEGACY = previous;
  }
});


test('getIgnorePatterns excludes named distribution output variants', () => {
  const analyzer = new TestAnalyzer();
  const patterns = analyzer.exposedIgnorePatterns({ projectPath: '/repo' });
  assert.ok(patterns.includes('**/dist-*/**'));
  assert.ok(patterns.includes('**/dist_*/**'));
  assert.ok(patterns.includes('**/dist.*/**'));
});

test('getPackageDirSafeIgnorePatterns keeps fixtures/testdata/__tests__ excluded (only samples/examples are JVM-package-name safe)', () => {
  const analyzer = new TestAnalyzer();
  const patterns = analyzer.exposedPackageDirSafeIgnorePatterns({ projectPath: '/repo' });
  // samples/examples ARE stripped — a real JVM reversed-domain package can
  // legitimately contain a "samples" segment (org.springframework.samples.*).
  assert.ok(!patterns.includes('**/samples/**'), 'samples must be stripped for package-dir-safe callers');
  assert.ok(!patterns.includes('**/examples/**'), 'examples must be stripped for package-dir-safe callers');
  // fixtures/testdata/cas-tests/__tests__ must NEVER be stripped — none of
  // them are a plausible real JVM package segment, and stripping "fixtures"
  // here was the root cause of KotlinAnalyzer minting a duplicate "Android
  // Activity: MainActivity" entry point from Klauro's own
  // apps/mcp-server/fixtures/component-bench/compose-tree/App.kt test fixture.
  assert.ok(patterns.includes('**/fixtures/**'), 'fixtures must stay excluded even for package-dir-safe callers');
  assert.ok(patterns.includes('**/testdata/**'), 'testdata must stay excluded even for package-dir-safe callers');
  assert.ok(patterns.includes('**/__tests__/**'), '__tests__ must stay excluded even for package-dir-safe callers');
});

// ---------------------------------------------------------------------------
// pyprojectHasRealDependency (framework self-detection defect, 2026-07-21):
// Klauro ships packages/klauro-sdk-py/pyproject.toml, a telemetry SDK whose
// `dependencies = []` is empty but whose `[project.optional-dependencies]`
// names integration targets (django/flask/fastapi->starlette) a customer
// might use. django/flask/fastapi/starlette-analyzer.ts previously did a
// naive `pyproject.includes('django')` substring check, which matched those
// extras-table lines directly and reported confidence-1 Django/Flask/
// FastAPI/Starlette detections on Klauro's own ~99% TypeScript repo.
// ---------------------------------------------------------------------------

test('pyprojectHasRealDependency ignores [project.optional-dependencies] extras groups', () => {
  const analyzer = new TestAnalyzer();
  const pyproject = [
    '[project]',
    'name = "klauro-telemetry"',
    'dependencies = []',
    '',
    '[project.optional-dependencies]',
    'fastapi = ["starlette>=0.27"]',
    'flask = ["flask>=2.0"]',
    'django = ["django>=3.2"]',
  ].join('\n');

  assert.equal(analyzer.exposedPyprojectHasRealDependency(pyproject, 'django'), false);
  assert.equal(analyzer.exposedPyprojectHasRealDependency(pyproject, 'flask'), false);
  assert.equal(analyzer.exposedPyprojectHasRealDependency(pyproject, 'fastapi'), false);
  assert.equal(analyzer.exposedPyprojectHasRealDependency(pyproject, 'starlette'), false);
});

test('pyprojectHasRealDependency detects a real PEP 621 top-level dependencies array entry', () => {
  const analyzer = new TestAnalyzer();
  const pyproject = [
    '[project]',
    'name = "real-django-app"',
    'dependencies = [',
    '    "django>=4.0",',
    '    "psycopg2",',
    ']',
  ].join('\n');

  assert.equal(analyzer.exposedPyprojectHasRealDependency(pyproject, 'django'), true);
});

test('pyprojectHasRealDependency detects a real [tool.poetry.dependencies] entry', () => {
  const analyzer = new TestAnalyzer();
  const pyproject = [
    '[tool.poetry.dependencies]',
    'python = "^3.11"',
    'flask = "^2.0"',
    '',
    '[tool.poetry.extras]',
    'fastapi = ["starlette"]',
  ].join('\n');

  assert.equal(analyzer.exposedPyprojectHasRealDependency(pyproject, 'flask'), true);
  assert.equal(analyzer.exposedPyprojectHasRealDependency(pyproject, 'starlette'), false);
});

test('pyprojectHasRealDependency detects a real [tool.poetry.group.<name>.dependencies] entry', () => {
  const analyzer = new TestAnalyzer();
  const pyproject = [
    '[tool.poetry.group.dev.dependencies]',
    'pytest = "^8.0"',
    'fastapi = "^0.110"',
  ].join('\n');

  assert.equal(analyzer.exposedPyprojectHasRealDependency(pyproject, 'fastapi'), true);
});
