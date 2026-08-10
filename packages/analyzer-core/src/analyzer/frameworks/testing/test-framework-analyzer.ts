import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import { createYieldBudget } from '../../core/event-loop-yield';

/**
 * TestFrameworkAnalyzer — cross-language test structure + coverage map.
 *
 * Complements the Jest and Cypress analyzers (which own the AST-level JS/TS
 * detail) by covering every OTHER mainstream framework with a single,
 * evidence-gated regex walker:
 *   TS/JS   Vitest, Mocha, Jasmine, node:test
 *   Python  pytest (test_ fns + fixtures), unittest (TestCase methods)
 *   Java    JUnit 4/5 (@Test), TestNG
 *   Ruby    RSpec (describe/it/context), minitest
 *   Go      func TestXxx(t *testing.T)
 *   Rust    #[test] / #[tokio::test]
 *   C#      xUnit ([Fact]/[Theory]), NUnit ([Test])
 *   PHP     PHPUnit
 *   Elixir  ExUnit
 *   Solidity Foundry (forge-std Test)
 *   E2E     Playwright, Selenium
 *
 * Emits `test` nodes (suites carry the `suite` subcategory, cases do not — the
 * exact shape orchestrator.buildTestSuites lifts into CASTestSuite/CASTestCase).
 * Test code remains outside the operational entry-point surface. When language
 * analyzers provide test-owned AST nodes and call edges, this analyzer attaches
 * helpers and mocks to the suite and emits exact `tests` edges to executed code;
 * import-derived `covers` edges remain the explicitly coarser fallback.
 */

type TestKind = 'unit' | 'integration' | 'e2e' | 'snapshot';

interface DiscoveredCase {
  name: string;
  line: number;
  skipped: boolean;
  focused: boolean;
}

interface DiscoveredSuite {
  name: string;
  file: string;
  absPath: string;
  framework: string;
  language: string;
  type: TestKind;
  lineCount: number;
  cases: DiscoveredCase[];
  /** Project-relative-ish import specifiers pulled from the test file. */
  imports: string[];
}

interface FrameworkRule {
  /** Human framework label emitted on nodes and entry points. */
  framework: string;
  language: string;
  /** File globs whose contents this rule can own. */
  filePatterns: string[];
  /**
   * Import/dependency evidence that must be present in the file before a rule
   * fires — the house-rule gate. A rule with an empty gate relies purely on the
   * file-naming convention (e.g. `*_test.go`), which is itself the evidence.
   */
  evidence: RegExp[];
  /** Case-extraction patterns; capture group 1 is the case name. */
  casePatterns: RegExp[];
}

interface TestCoverageTargetIndex {
  fileNodesByPath: Map<string, string>;
  nonTestNodesByPath: Map<string, string>;
  nodesBySourcePath: Map<string, CASNode[]>;
  nodesById: Map<string, CASNode>;
  callsBySource: Map<string, Array<{ target: string; line?: number }>>;
}

export class TestFrameworkAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'test-framework',
      'Cross-Language Test Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const rules = this.rules();
      const files = await this.discoverCandidateFiles(projectPath, this.getTestIgnorePatterns({ projectPath } as AnalysisContext), rules);
      for (const file of files.slice(0, 200)) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8').catch(() => '');
        if (rules.some(rule => this.matchesRule(rule, file, content))) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const ignorePatterns = this.getTestIgnorePatterns(context);
      const suites = await this.discoverSuites(context.projectPath, ignorePatterns);
      const coverageTargets = this.buildCoverageTargetIndex(context.existingAnalysis);

      for (const suite of suites) {
        this.emitSuite(suite, nodes, edges, coverageTargets);
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        frameworks: [...new Set(suites.map(s => s.framework))],
        languages: [...new Set(suites.map(s => s.language))],
        testSuitesFound: suites.length,
        totalTests: suites.reduce((sum, s) => sum + s.cases.length, 0),
        testTypes: [...new Set(suites.map(s => s.type))]
      });
    } catch (error) {
      throw new AnalyzerError(
        `Test framework analysis failed: ${(error as Error).message}`,
        'TEST_FRAMEWORK_ANALYSIS_ERROR'
      );
    }
  }

  private async discoverSuites(projectPath: string, ignorePatterns: string[]): Promise<DiscoveredSuite[]> {
    const suites: DiscoveredSuite[] = [];
    const rules = this.rules();
    const files = await this.discoverCandidateFiles(projectPath, ignorePatterns, rules);

    const maybeYield = createYieldBudget();
    for (const file of files) {
      await maybeYield();
      const normalized = file.replace(/\\/g, '/');
      const absPath = path.join(projectPath, file);
      const content = await fs.readFile(absPath, 'utf-8').catch(() => '');
      if (!content.trim()) continue;

      const rule = rules.find(candidate => this.matchesRule(candidate, normalized, content));
      if (!rule) continue;
      const cases = this.extractCases(rule, content);
      if (cases.length === 0) continue;

      suites.push({
        name: this.suiteName(content, normalized, rule),
        file: normalized,
        absPath,
        framework: rule.framework,
        language: rule.language,
        type: this.inferType(normalized, content),
        lineCount: this.sourceLineCount(content),
        cases,
        imports: this.extractImports(content, rule.language)
      });
    }

    return suites;
  }

  private async discoverCandidateFiles(
    projectPath: string,
    ignorePatterns: string[],
    rules: FrameworkRule[]
  ): Promise<string[]> {
    return glob([...new Set([
      ...rules.flatMap(rule => rule.filePatterns),
      '**/{__tests__,test,tests,spec,e2e}/**/*.{js,jsx,ts,tsx,mjs,cjs}',
    ])], {
      cwd: projectPath,
      ignore: ignorePatterns,
      nodir: true,
    });
  }

  private getTestIgnorePatterns(context: AnalysisContext): string[] {
    return this.getIgnorePatterns(context).filter(pattern =>
      pattern !== '__tests__/**' && pattern !== '**/__tests__/**'
    );
  }

  private emitSuite(
    suite: DiscoveredSuite,
    nodes: CASNode[],
    edges: CASEdge[],
    coverageTargets: TestCoverageTargetIndex,
  ): void {
    const suiteId = this.suiteNodeId(suite);
    const suiteNode = this.createNodeBuilder(suiteId, suite.name, 'test')
      .withLevel(2, 'architectural')
      .withCategory('test', ['suite'])
      .withSource({ file: suite.absPath, line: 1, end_line: suite.lineCount })
      .withDescription(`${suite.framework} test suite: ${suite.name}`)
      .withMetadata({
        framework: suite.framework,
        language: suite.language,
        attributes: {
          type: suite.type,
          framework: suite.framework,
          tests: suite.cases.length,
          imports: suite.imports.length
        }
      })
      .build();
    nodes.push(suiteNode);

    const caseNodes: Array<{ discovered: DiscoveredCase; node: CASNode }> = [];
    suite.cases.forEach((testCase, index) => {
      const testId = `test_${suiteId}_${index}`;
      const testNode = this.createNodeBuilder(testId, testCase.name, 'test')
        .withLevel(3, 'code')
        .withCategory('test', [suite.type])
        .withSource({ file: suite.absPath, line: testCase.line, end_line: testCase.line })
        .withDescription(`${suite.framework} test: ${testCase.name}`)
        .withMetadata({
          framework: suite.framework,
          language: suite.language,
          attributes: {
            type: suite.type,
            skipped: testCase.skipped,
            focused: testCase.focused
          }
        })
        .build();
      nodes.push(testNode);
      caseNodes.push({ discovered: testCase, node: testNode });

      edges.push(this.createEdge(
        this.generateEdgeId(suiteId, testId, 'contains'),
        suiteId,
        testId,
        'contains',
        'structural'
      ));

    });

    this.attachDetailedTestGraph(suite, suiteNode, caseNodes, edges, coverageTargets);

    // covers edge: suite -> subject-under-test, gated on a real local import.
    for (const importPath of suite.imports) {
      const targetId = this.resolveImportToNodeId(importPath, suite.file, coverageTargets);
      if (targetId) {
        edges.push(this.createEdge(
          this.generateEdgeId(suiteId, targetId, 'covers'),
          suiteId,
          targetId,
          'covers',
          'test-relationship'
        ));
      }
    }
  }

  /**
   * Stable, file-namespaced suite id so same-named suites in different files
   * never collide — mirrors JestAnalyzer.suiteNodeId.
   */
  private suiteNodeId(suite: DiscoveredSuite): string {
    return `test_suite_${this.sanitizeId(suite.file)}_${this.sanitizeId(suite.name)}`;
  }

  private matchesRule(rule: FrameworkRule, file: string, content: string): boolean {
    if (!this.fileMatchesPatterns(file, rule)) return false;
    if (rule.evidence.length === 0) return true;
    return rule.evidence.some(re => re.test(content));
  }

  private fileMatchesPatterns(file: string, rule: FrameworkRule): boolean {
    const lower = file.toLowerCase();
    switch (rule.framework) {
      case 'vitest':
      case 'mocha':
      case 'jasmine':
      case 'node:test':
      case 'playwright':
      case 'selenium':
        return /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(lower) ||
          /(?:^|\/)(?:__tests__|test|tests|spec|e2e)\//.test(lower);
      case 'pytest':
      case 'unittest':
        return /(?:^|\/)(?:test_.*|.*_test)\.py$/.test(lower) ||
          /(?:^|\/)(?:test|tests)\/.*\.py$/.test(lower);
      case 'go-test':
        return /_test\.go$/.test(lower);
      case 'rust-test':
        // (?:^|\/) — not just \/ — or the extremely common top-level
        // `src/lib.rs` / `src/main.rs` / top-level `tests/*.rs` layout
        // (no parent directory before `src`/`tests`) never matches, and
        // rust-test suite discovery silently misses most single-crate repos.
        return /(?:_test\.rs$|(?:^|\/)(?:tests|src)\/.*\.rs$)/.test(lower);
      case 'junit':
      case 'testng':
        return /tests?\.(?:java|kt)$/.test(lower);
      case 'xunit':
      case 'nunit':
        return /tests?\.cs$/.test(lower);
      case 'rspec':
        return /_spec\.rb$/.test(lower) || /(?:^|\/)spec\/.*\.rb$/.test(lower);
      case 'minitest':
        return /_test\.rb$/.test(lower) || /(?:^|\/)test\/.*\.rb$/.test(lower);
      case 'phpunit':
        return /test\.php$/.test(lower) || /(?:^|\/)tests\/.*\.php$/.test(lower);
      case 'xctest':
        // Kept in sync with the xctest FrameworkRule's filePatterns above —
        // this switch is the actual gate (filePatterns is otherwise unused
        // by matchesRule/fileMatchesPatterns), which is itself a latent
        // footgun: adding a FrameworkRule alone silently does nothing until
        // a case is added here too. Out of scope to refactor for task #126,
        // but worth flagging — see the report on this defect.
        return /tests\.swift$/.test(lower) || /(?:^|\/)tests\/.*\.swift$/.test(lower);
      case 'exunit':
        // Mix's own convention: `mix test` only runs `test/**/*_test.exs`.
        return /_test\.exs$/.test(lower) || /(?:^|\/)test\/.*\.exs?$/.test(lower);
      case 'foundry':
        // Foundry's `forge test` default naming (`*.t.sol`) plus the
        // conventional `test/`/`tests/` directory both toolchains use.
        return /\.t\.sol$/.test(lower) || /(?:^|\/)tests?\/.*\.sol$/.test(lower);
      default:
        return false;
    }
  }

  private extractCases(rule: FrameworkRule, content: string): DiscoveredCase[] {
    const cases: DiscoveredCase[] = [];
    const seen = new Set<string>();

    for (const pattern of rule.casePatterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const name = (match[1] || match[2] || 'anonymous test').trim();
        const line = this.sourceLineForIndex(content, match.index);
        const key = `${name}@${line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const window = content.slice(Math.max(0, match.index - 12), match.index + 8);
        cases.push({
          name,
          line,
          skipped: /\.skip|xit|xtest|xdescribe|#\[ignore\]|@Ignore|@Disabled|@pytest\.mark\.skip/.test(window),
          focused: /\.only|fit\b|fdescribe|ftest/.test(window)
        });
      }
    }

    return cases;
  }

  private suiteName(content: string, file: string, rule: FrameworkRule): string {
    // Prefer an explicit suite declaration where the framework has one.
    const describe = content.match(/(?:describe|context|suite|RSpec\.describe)\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (describe) return describe[1];
    const rubyDescribe = content.match(/(?:describe|context)\s+['"]([^'"]+)['"]\s+do/);
    if (rubyDescribe) return rubyDescribe[1];
    const testClass = content.match(/class\s+([A-Za-z0-9_]+(?:Test|Tests|TestCase))/);
    if (testClass) return testClass[1];
    return path.basename(file, path.extname(file));
  }

  private extractImports(content: string, language: string): string[] {
    const imports: string[] = [];

    if (language === 'javascript' || language === 'typescript') {
      const re = /(?:import\s+[^;]*?\s+from\s+['"`]([^'"`]+)['"`]|require\s*\(\s*['"`]([^'"`]+)['"`]\s*\))/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) imports.push(match[1] || match[2]);
    } else if (language === 'python') {
      const re = /^\s*(?:from\s+(\.[\w.]*)\s+import|import\s+(\.[\w.]*))/gm;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) imports.push(match[1] || match[2]);
    }
    // Go/Rust/Java/C#/Ruby/PHP subjects are co-located by convention rather than
    // relative-path imports; coverage there is left to the co-location heuristic
    // in find_tests rather than fabricated edges.

    return imports.filter(spec => spec && (spec.startsWith('.') || spec.startsWith('/')));
  }

  private resolveImportToNodeId(
    importPath: string,
    testFilePath: string,
    coverageTargets: TestCoverageTargetIndex,
  ): string | null {
    if (!importPath.startsWith('.')) return null;
    const candidates = this.resolveImportCandidates(importPath, testFilePath);

    for (const candidate of candidates) {
      const match = coverageTargets.fileNodesByPath.get(this.normalizeSourcePath(candidate));
      if (match) return match;
    }
    for (const candidate of candidates) {
      const match = coverageTargets.nonTestNodesByPath.get(this.normalizeSourcePath(candidate));
      if (match) return match;
    }
    return null;
  }

  private buildCoverageTargetIndex(existingAnalysis?: CASContribution[]): TestCoverageTargetIndex {
    const fileNodesByPath = new Map<string, string>();
    const nonTestNodesByPath = new Map<string, string>();
    const nodesBySourcePath = new Map<string, CASNode[]>();
    const nodesById = new Map<string, CASNode>();
    const callsBySource = new Map<string, Array<{ target: string; line?: number }>>();
    for (const contribution of existingAnalysis || []) {
      for (const node of contribution.nodes || []) {
        nodesById.set(node.id, node);
        if (!node.source?.file) continue;
        for (const key of this.sourcePathSuffixes(node.source.file)) {
          const sourceNodes = nodesBySourcePath.get(key) || [];
          sourceNodes.push(node);
          nodesBySourcePath.set(key, sourceNodes);
        }
        const index = node.type === 'file'
          ? fileNodesByPath
          : !this.isTestOwnedNode(node)
            ? nonTestNodesByPath
            : null;
        if (!index) continue;
        for (const key of this.sourcePathSuffixes(node.source.file)) {
          if (!index.has(key)) index.set(key, node.id);
        }
      }
      for (const edge of contribution.edges || []) {
        if (edge.type !== 'calls') continue;
        const calls = callsBySource.get(edge.source) || [];
        const line = edge.metadata?.attributes?.line;
        calls.push({ target: edge.target, line: typeof line === 'number' ? line : undefined });
        callsBySource.set(edge.source, calls);
      }
    }
    return { fileNodesByPath, nonTestNodesByPath, nodesBySourcePath, nodesById, callsBySource };
  }

  private attachDetailedTestGraph(
    suite: DiscoveredSuite,
    suiteNode: CASNode,
    cases: Array<{ discovered: DiscoveredCase; node: CASNode }>,
    edges: CASEdge[],
    index: TestCoverageTargetIndex,
  ): void {
    const fileGraphNodes = this.graphNodesForSuite(suite, index)
      .filter(node => node.id !== suiteNode.id && this.isTestOwnedNode(node));
    const edgeIds = new Set(edges.map(edge => edge.id));

    for (const node of fileGraphNodes) {
      const relationship = node.type === 'mock' || node.type === 'test_double' ? 'mocks' : 'contains';
      this.pushUniqueEdge(edges, edgeIds, this.createEdge(
        this.generateEdgeId(suiteNode.id, node.id, relationship),
        suiteNode.id,
        node.id,
        relationship,
        relationship === 'mocks' ? 'test-relationship' : 'structural',
        { confidence: 1, attributes: { evidence: 'same-test-source-file' } }
      ));
    }

    const suiteTargets = this.reachableProductionTargets(fileGraphNodes.map(node => node.id), index);
    for (const targetId of suiteTargets) {
      this.pushExactTestEdge(edges, edgeIds, suiteNode.id, targetId, 'suite-call-graph');
    }

    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const current = cases[caseIndex];
      const nextLine = cases[caseIndex + 1]?.discovered.line ?? Number.POSITIVE_INFINITY;
      const roots = fileGraphNodes.filter(node => {
        const line = node.source?.line;
        const endLine = node.source?.end_line ?? line;
        return line !== undefined && (
          (line <= current.discovered.line && (endLine ?? line) >= current.discovered.line) ||
          (line >= current.discovered.line && line < nextLine)
        );
      });
      for (const targetId of this.reachableProductionTargets(
        roots.map(node => node.id),
        index,
        { start: current.discovered.line, end: nextLine }
      )) {
        this.pushExactTestEdge(edges, edgeIds, current.node.id, targetId, 'case-call-graph');
      }
    }
  }

  private graphNodesForSuite(suite: DiscoveredSuite, index: TestCoverageTargetIndex): CASNode[] {
    const matches = new Map<string, CASNode>();
    for (const sourcePath of [suite.absPath, suite.file]) {
      for (const node of index.nodesBySourcePath.get(this.normalizeSourcePath(sourcePath)) || []) {
        matches.set(node.id, node);
      }
    }
    return [...matches.values()];
  }

  private reachableProductionTargets(
    startNodeIds: string[],
    index: TestCoverageTargetIndex,
    rootCallLines?: { start: number; end: number },
  ): Set<string> {
    const targets = new Set<string>();
    const visited = new Set<string>();
    const queue = [...new Set(startNodeIds)].map(id => ({ id, root: true }));
    while (queue.length > 0) {
      const { id: sourceId, root } = queue.shift()!;
      if (visited.has(sourceId)) continue;
      visited.add(sourceId);
      for (const call of index.callsBySource.get(sourceId) || []) {
        if (root && rootCallLines && call.line !== undefined &&
            (call.line < rootCallLines.start || call.line >= rootCallLines.end)) continue;
        const target = index.nodesById.get(call.target);
        if (!target) continue;
        if (this.isTestOwnedNode(target)) queue.push({ id: call.target, root: false });
        else targets.add(call.target);
      }
    }
    return targets;
  }

  private isTestOwnedNode(node: CASNode): boolean {
    return node.metadata?.is_test === true ||
      node.category === 'test' ||
      ['test', 'mock', 'test_double', 'test_fixture'].includes(node.type);
  }

  private pushExactTestEdge(
    edges: CASEdge[],
    edgeIds: Set<string>,
    sourceId: string,
    targetId: string,
    evidence: string,
  ): void {
    this.pushUniqueEdge(edges, edgeIds, this.createEdge(
      this.generateEdgeId(sourceId, targetId, 'tests'),
      sourceId,
      targetId,
      'tests',
      'test-relationship',
      { confidence: 1, attributes: { evidence, exact: true } }
    ));
  }

  private pushUniqueEdge(edges: CASEdge[], edgeIds: Set<string>, edge: CASEdge): void {
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    edges.push(edge);
  }

  private sourcePathSuffixes(filePath: string): string[] {
    const normalized = this.normalizeSourcePath(filePath);
    const keys = [normalized];
    for (let index = normalized.indexOf('/'); index >= 0; index = normalized.indexOf('/', index + 1)) {
      const suffix = normalized.slice(index + 1);
      if (suffix) keys.push(suffix);
    }
    return keys;
  }

  private normalizeSourcePath(filePath: string): string {
    return path.normalize(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  }

  private resolveImportCandidates(importPath: string, testFilePath: string): string[] {
    const basePath = path.normalize(path.join(path.dirname(testFilePath), importPath)).replace(/\\/g, '/');
    const extension = path.extname(basePath);
    if (extension) {
      // TS + ESM projects import `.js`/`.mjs`/`.cjs` specifiers that resolve to
      // the `.ts`/`.tsx` source on disk — try the source siblings too, else the
      // covers edge never lands for the single most common TS convention.
      if (/\.(js|mjs|cjs|jsx)$/i.test(extension)) {
        const stem = basePath.slice(0, -extension.length);
        return [basePath, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`];
      }
      return [basePath];
    }
    const isPy = /\.py$/i.test(testFilePath) || importPath.startsWith('.');
    const exts = isPy && !importPath.includes('/')
      ? ['.py', '/__init__.py']
      : ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '.py'];
    return [basePath, ...exts.map(ext => `${basePath}${ext}`)];
  }

  private inferType(file: string, content: string): TestKind {
    const lower = file.toLowerCase();
    if (lower.includes('e2e') || lower.includes('playwright') || lower.includes('selenium') || lower.includes('.spec.')) {
      if (content.includes('page.goto') || content.includes('driver.get') || content.includes('webdriver')) return 'e2e';
    }
    if (lower.includes('e2e')) return 'e2e';
    if (lower.includes('integration') || lower.includes('/it/')) return 'integration';
    if (content.includes('toMatchSnapshot')) return 'snapshot';
    return 'unit';
  }

  protected sanitizeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '_');
  }

  /**
   * The framework rule table. Each entry is evidence-gated: the file naming
   * convention selects candidates, the `evidence` imports confirm the framework,
   * and `casePatterns` extract runnable cases. Ordering matters — earlier rules
   * claim a file first, so language-specific naming (e.g. *_test.go) never gets
   * mis-owned by a generic JS rule.
   */
  private rules(): FrameworkRule[] {
    return [
      {
        framework: 'vitest',
        language: 'typescript',
        filePatterns: ['**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}'],
        evidence: [/from\s+['"`]vitest['"`]/, /require\(\s*['"`]vitest['"`]/],
        casePatterns: [/(?:^|\s)(?:it|test)(?:\.(?:skip|only|concurrent|todo|each))?\s*\(\s*['"`]([^'"`]+)['"`]/]
      },
      {
        framework: 'mocha',
        language: 'typescript',
        filePatterns: ['**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs}', '**/test/**/*.{js,ts,mjs,cjs}'],
        evidence: [/from\s+['"`]mocha['"`]/, /require\(\s*['"`]mocha['"`]/, /\bmocha\b/],
        casePatterns: [/(?:^|\s)(?:it|specify)(?:\.(?:skip|only))?\s*\(\s*['"`]([^'"`]+)['"`]/]
      },
      {
        framework: 'jasmine',
        language: 'typescript',
        filePatterns: ['**/*.{test,spec}.{js,jsx,ts,tsx}'],
        evidence: [/\bjasmine\b/, /from\s+['"`]jasmine-core['"`]/],
        casePatterns: [/(?:^|\s)(?:it|fit|xit)\s*\(\s*['"`]([^'"`]+)['"`]/]
      },
      {
        framework: 'node:test',
        language: 'javascript',
        filePatterns: ['**/*.{test,spec}.{js,mjs,cjs,ts}', '**/test/**/*.{js,mjs,cjs}'],
        evidence: [/from\s+['"`]node:test['"`]/, /require\(\s*['"`]node:test['"`]/],
        casePatterns: [/(?:^|\s)(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/]
      },
      {
        framework: 'playwright',
        language: 'typescript',
        filePatterns: ['**/*.{test,spec}.{js,ts}', '**/e2e/**/*.{js,ts}', '**/tests/**/*.{js,ts}'],
        evidence: [/from\s+['"`]@playwright\/test['"`]/, /require\(\s*['"`]@playwright\/test['"`]/],
        casePatterns: [/(?:^|\s)test(?:\.(?:skip|only|fixme))?\s*\(\s*['"`]([^'"`]+)['"`]/]
      },
      {
        framework: 'selenium',
        language: 'typescript',
        filePatterns: ['**/*.{test,spec}.{js,ts}', '**/e2e/**/*.{js,ts}'],
        evidence: [/from\s+['"`]selenium-webdriver['"`]/, /require\(\s*['"`]selenium-webdriver['"`]/],
        casePatterns: [/(?:^|\s)(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/]
      },
      {
        framework: 'pytest',
        language: 'python',
        filePatterns: ['**/test_*.py', '**/*_test.py', '**/tests/**/*.py', '**/test/**/*.py'],
        evidence: [/import\s+pytest/, /from\s+pytest/, /^\s*def\s+test_/m, /@pytest\./m],
        casePatterns: [/^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/gm]
      },
      {
        framework: 'unittest',
        language: 'python',
        filePatterns: ['**/test_*.py', '**/*_test.py', '**/tests/**/*.py', '**/test/**/*.py'],
        evidence: [/import\s+unittest/, /unittest\.TestCase/, /class\s+\w*Test\w*\s*\(\s*(?:unittest\.)?TestCase/],
        casePatterns: [/^\s*def\s+(test[A-Za-z0-9_]*)\s*\(\s*self/gm]
      },
      {
        framework: 'go-test',
        language: 'go',
        filePatterns: ['**/*_test.go'],
        evidence: [/testing\.T\b/, /testing\.B\b/, /^\s*func\s+Test/m],
        casePatterns: [/^\s*func\s+(Test[A-Za-z0-9_]*)\s*\(\s*\w+\s+\*testing\.[TB]\s*\)/gm]
      },
      {
        framework: 'rust-test',
        language: 'rust',
        filePatterns: ['**/*_test.rs', '**/tests/**/*.rs', '**/src/**/*.rs'],
        evidence: [/#\[(?:tokio::)?test\]/, /#\[cfg\(test\)\]/],
        casePatterns: [/#\[(?:tokio::)?test\][\s\S]{0,80}?\bfn\s+([A-Za-z0-9_]+)\s*\(/gm]
      },
      {
        framework: 'junit',
        language: 'java',
        filePatterns: ['**/*Test.java', '**/*Tests.java', '**/*Test.kt', '**/*Tests.kt'],
        evidence: [/@Test\b/, /org\.junit/, /import\s+org\.junit/],
        casePatterns: [/@Test[\s\S]{0,120}?\b(?:public|private|protected|fun|void)[\s\S]{0,40}?\b([A-Za-z0-9_]+)\s*\(/gm]
      },
      {
        framework: 'testng',
        language: 'java',
        filePatterns: ['**/*Test.java', '**/*Tests.java'],
        evidence: [/org\.testng/, /import\s+org\.testng/],
        casePatterns: [/@Test[\s\S]{0,120}?\b(?:public|void)[\s\S]{0,40}?\b([A-Za-z0-9_]+)\s*\(/gm]
      },
      {
        framework: 'xunit',
        language: 'csharp',
        filePatterns: ['**/*Test.cs', '**/*Tests.cs'],
        evidence: [/\[Fact\]/, /\[Theory\]/, /using\s+Xunit/],
        casePatterns: [/\[(?:Fact|Theory)\][\s\S]{0,120}?\b(?:public|void|async)[\s\S]{0,60}?\b([A-Za-z0-9_]+)\s*\(/gm]
      },
      {
        framework: 'nunit',
        language: 'csharp',
        filePatterns: ['**/*Test.cs', '**/*Tests.cs'],
        evidence: [/using\s+NUnit/, /\[TestFixture\]/, /\[Test\]/],
        casePatterns: [/\[(?:Test|TestCase)\][\s\S]{0,120}?\b(?:public|void)[\s\S]{0,60}?\b([A-Za-z0-9_]+)\s*\(/gm]
      },
      {
        framework: 'rspec',
        language: 'ruby',
        filePatterns: ['**/*_spec.rb', '**/spec/**/*.rb'],
        evidence: [/RSpec\.describe/, /require\s+['"]rspec['"]/, /\bdescribe\b/],
        casePatterns: [/^\s*(?:it|specify)\s+['"]([^'"]+)['"]\s+do/gm, /^\s*(?:it|specify)\s*\(\s*['"]([^'"]+)['"]/gm]
      },
      {
        framework: 'minitest',
        language: 'ruby',
        filePatterns: ['**/*_test.rb', '**/test/**/*.rb'],
        evidence: [/require\s+['"]minitest/, /Minitest::Test/, /MiniTest::Test/],
        casePatterns: [/^\s*def\s+(test_[A-Za-z0-9_]+)/gm]
      },
      {
        framework: 'phpunit',
        language: 'php',
        filePatterns: ['**/*Test.php', '**/tests/**/*.php'],
        evidence: [/PHPUnit\\Framework\\TestCase/, /extends\s+TestCase/, /@test\b/],
        casePatterns: [/(?:@test[\s\S]{0,40}?)?\bpublic\s+function\s+(test[A-Za-z0-9_]*)\s*\(/gm]
      },
      {
        // XCTest was previously unregistered here entirely — Swift test
        // files never produced suite/case `test` nodes, so `test_summary`
        // undercounted Swift tests independently of the node-tagging fix
        // in swift-analyzer.ts's applyTestFileBoundary. Both fixes are
        // needed: this one for suite/case discovery, that one for the
        // coverage-graph walk to find a test-owned root to traverse from.
        framework: 'xctest',
        language: 'swift',
        filePatterns: ['**/*Tests.swift', '**/Tests/**/*.swift'],
        evidence: [/import\s+XCTest/, /XCTestCase/, /XCTAssert/],
        casePatterns: [/\bfunc\s+(test[A-Za-z0-9_]*)\s*\(\s*\)/gm]
      },
      {
        // ExUnit was previously unregistered here entirely — Elixir test
        // files never produced suite/case `test` nodes, so `test_summary`
        // undercounted Elixir tests independently of the node-tagging fix in
        // elixir-analyzer.ts's applyTestFileBoundary. Both fixes are needed:
        // this one for suite/case discovery, that one for the coverage-graph
        // walk to find a test-owned root to traverse from.
        framework: 'exunit',
        language: 'elixir',
        filePatterns: ['**/*_test.exs', '**/test/**/*.exs'],
        evidence: [/ExUnit\.Case/, /import\s+ExUnit/],
        casePatterns: [/^\s*test\s+["']([^"']+)["']/gm]
      },
      {
        // Foundry (forge-std) was previously unregistered here entirely —
        // Solidity test contracts never produced suite/case `test` nodes.
        // Both fixes needed, same reasoning as xctest/exunit above: this one
        // for suite/case discovery, solidity-analyzer.ts's
        // applyTestFileBoundary for the coverage-graph walk's traversal root.
        framework: 'foundry',
        language: 'solidity',
        filePatterns: ['**/*.t.sol', '**/test/**/*.sol', '**/tests/**/*.sol'],
        evidence: [/forge-std\/Test\.sol/, /\bis\s+Test\b/],
        casePatterns: [/function\s+(test[A-Za-z0-9_]*)\s*\(/gm]
      }
    ];
  }

  protected getCapabilities(): string[] {
    return [
      'test-detection',
      'suite-analysis',
      'coverage-mapping',
      'multi-language-tests'
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }
}
