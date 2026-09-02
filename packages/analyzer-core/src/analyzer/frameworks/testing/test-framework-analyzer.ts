import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import { createYieldBudget } from '../../core/event-loop-yield';
import { httpRoutePathsMatch } from '../../core/http-route-path';



























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

  imports: string[];
  content: string;
}

interface HttpRouteTarget {
  nodeId: string;
  method: string;
  path: string;
}

interface HttpRequestLiteral {
  method: string;
  path: string;
}

interface FrameworkRule {

  framework: string;
  language: string;

  filePatterns: string[];





  evidence: RegExp[];

  casePatterns: RegExp[];
}

interface TestCoverageTargetIndex {
  fileNodesByPath: Map<string, string>;
  nonTestNodesByPath: Map<string, string>;
  nodesBySourcePath: Map<string, CASNode[]>;
  nodesById: Map<string, CASNode>;
  callsBySource: Map<string, Array<{ target: string; line?: number }>>;
  reachableProductionTargets: Map<string, ReadonlySet<string>>;
  httpRoutes: HttpRouteTarget[];
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
      for (const file of files) {
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
    let phaseStartedAt = Date.now();
    const recordPhase = (phase: string) => {
      if (process.env.KLAURO_DEBUG_TEST_ANALYZER_PHASES === '1') {
        process.stderr.write(`[Klauro] test analyzer ${phase}: ${Date.now() - phaseStartedAt}ms\n`);
      }
      phaseStartedAt = Date.now();
    };

    try {
      const ignorePatterns = this.getTestIgnorePatterns(context);
      const suites = await this.discoverSuites(context.projectPath, ignorePatterns);
      recordPhase('discover-suites');
      const coverageTargets = this.buildCoverageTargetIndex(context.existingAnalysis, context.projectPath);
      recordPhase('build-coverage-index');
      const edgeIds = new Set<string>();

      for (const suite of suites) {
        this.emitSuite(suite, nodes, edges, edgeIds, coverageTargets);
      }
      recordPhase('emit-suites');

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
        imports: this.extractImports(content, rule.language),
        content,
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
    return this.getPackageDirSafeIgnorePatterns(context).filter(pattern =>
      pattern !== '__tests__/**' && pattern !== '**/__tests__/**'
    );
  }

  private emitSuite(
    suite: DiscoveredSuite,
    nodes: CASNode[],
    edges: CASEdge[],
    edgeIds: Set<string>,
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
      const httpRequests = this.httpRequestsInCase(
        suite,
        testCase.line,
        suite.cases[index + 1]?.line ?? Number.POSITIVE_INFINITY,
      );
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
            focused: testCase.focused,
            http_requests: httpRequests,
          }
        })
        .build();
      nodes.push(testNode);
      caseNodes.push({ discovered: testCase, node: testNode });

      this.pushUniqueEdge(edges, edgeIds, this.createEdge(
        this.generateEdgeId(suiteId, testId, 'contains'),
        suiteId,
        testId,
        'contains',
        'structural'
      ));

    });

    this.attachDetailedTestGraph(suite, suiteNode, caseNodes, edges, edgeIds, coverageTargets);

    for (const importPath of suite.imports) {
      const targetId = this.resolveImportToNodeId(importPath, suite.file, coverageTargets);
      if (targetId) {
        this.pushUniqueEdge(edges, edgeIds, this.createEdge(
          this.generateEdgeId(suiteId, targetId, 'covers'),
          suiteId,
          targetId,
          'covers',
          'test-relationship'
        ));
      }
    }
  }





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






        return /tests\.swift$/.test(lower) || /(?:^|\/)tests\/.*\.swift$/.test(lower);
      case 'exunit':

        return /_test\.exs$/.test(lower) || /(?:^|\/)test\/.*\.exs?$/.test(lower);
      case 'foundry':


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

  private buildCoverageTargetIndex(existingAnalysis: CASContribution[] | undefined, projectPath: string): TestCoverageTargetIndex {
    const fileNodesByPath = new Map<string, string>();
    const nonTestNodesByPath = new Map<string, string>();
    const nodesBySourcePath = new Map<string, CASNode[]>();
    const nodesById = new Map<string, CASNode>();
    const callsBySource = new Map<string, Array<{ target: string; line?: number }>>();
    const httpRoutes = new Map<string, HttpRouteTarget>();
    const sourceKeysByFile = new Map<string, string[]>();
    const sourceKeys = (file: string) => {
      const cached = sourceKeysByFile.get(file);
      if (cached) return cached;
      const keys = this.sourcePathKeys(file, projectPath);
      sourceKeysByFile.set(file, keys);
      return keys;
    };
    for (const contribution of existingAnalysis || []) {
      for (const node of contribution.nodes || []) {
        nodesById.set(node.id, node);
        if (!node.source?.file) continue;
        const testOwned = this.isTestOwnedNode(node);
        if (testOwned) {
          for (const key of sourceKeys(node.source.file)) {
            const sourceNodes = nodesBySourcePath.get(key) || [];
            sourceNodes.push(node);
            nodesBySourcePath.set(key, sourceNodes);
          }
        }
        const index = node.type === 'file'
          ? fileNodesByPath
          : !testOwned
            ? nonTestNodesByPath
            : null;
        if (!index) continue;
        for (const key of sourceKeys(node.source.file)) {
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
      for (const entryPoint of contribution.entry_points || []) {
        const method = entryPoint.trigger?.method;
        const routePath = entryPoint.trigger?.path;
        if (entryPoint.type !== 'http' || !method || !routePath || !entryPoint.source_node) continue;
        const target = {
          nodeId: entryPoint.source_node,
          method: method.toUpperCase(),
          path: routePath,
        };
        httpRoutes.set(`${target.nodeId}\0${target.method}\0${target.path}`, target);
      }
      for (const node of contribution.nodes || []) {
        const attributes = node.metadata?.attributes;
        const method = attributes?.method;
        const routePath = attributes?.path;
        if (node.type !== 'route' || typeof method !== 'string' || typeof routePath !== 'string') continue;
        const target = { nodeId: node.id, method: method.toUpperCase(), path: routePath };
        httpRoutes.set(`${target.nodeId}\0${target.method}\0${target.path}`, target);
      }
    }
    return {
      fileNodesByPath,
      nonTestNodesByPath,
      nodesBySourcePath,
      nodesById,
      callsBySource,
      reachableProductionTargets: new Map(),
      httpRoutes: [...httpRoutes.values()],
    };
  }

  private attachDetailedTestGraph(
    suite: DiscoveredSuite,
    suiteNode: CASNode,
    cases: Array<{ discovered: DiscoveredCase; node: CASNode }>,
    edges: CASEdge[],
    edgeIds: Set<string>,
    index: TestCoverageTargetIndex,
  ): void {
    const fileGraphNodes = this.graphNodesForSuite(suite, index)
      .filter(node => node.id !== suiteNode.id && this.isTestOwnedNode(node));
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
      for (const request of this.httpRequestsInCase(suite, current.discovered.line, nextLine)) {
        for (const route of index.httpRoutes) {
          if (request.method !== route.method || !httpRoutePathsMatch(request.path, route.path)) continue;
          this.pushExactTestEdge(edges, edgeIds, current.node.id, route.nodeId, 'http-request-literal');
        }
      }
    }
  }

  private httpRequestsInCase(suite: DiscoveredSuite, startLine: number, endLine: number): HttpRequestLiteral[] {
    const lines = suite.content.split('\n');
    const source = lines.slice(
      Math.max(0, startLine - 1),
      Number.isFinite(endLine) ? endLine - 1 : undefined,
    ).join('\n');
    const requests = new Map<string, HttpRequestLiteral>();
    const add = (method: string, requestPath: string) => {
      const normalizedMethod = method.toUpperCase().replace(/ASYNC$/, '');
      if (!requestPath.startsWith('/') && !/^[a-z][a-z\d+.-]*:\/\//i.test(requestPath)) return;
      requests.set(`${normalizedMethod}\0${requestPath}`, { method: normalizedMethod, path: requestPath });
    };
    const direct = /(?:^|[^\w])(?:[A-Za-z_$][\w$]*\.)*(get|post|put|patch|delete|head|options)(?:Async)?\s*\(\s*(['"`])([^'"`]+)\2/gi;
    let match: RegExpExecArray | null;
    while ((match = direct.exec(source)) !== null) add(match[1], match[3]);
    const fluent = /\.(get|post|put|patch|delete|head|options)\s*\(\s*\)[\s\S]{0,240}?\.uri\s*\(\s*(['"`])([^'"`]+)\2/gi;
    while ((match = fluent.exec(source)) !== null) add(match[1], match[3]);
    const explicit = /\b(?:request|open|send)\s*\(\s*(['"`])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1\s*,\s*(['"`])([^'"`]+)\3/gi;
    while ((match = explicit.exec(source)) !== null) add(match[2], match[4]);
    return [...requests.values()];
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
    if (!rootCallLines) {
      const targets = new Set<string>();
      for (const startNodeId of startNodeIds) {
        for (const targetId of this.productionTargetsFromTestNode(startNodeId, index)) targets.add(targetId);
      }
      return targets;
    }
    const targets = new Set<string>();
    const rootIds = new Set(startNodeIds);
    for (const sourceId of rootIds) {
      for (const call of index.callsBySource.get(sourceId) || []) {
        if (call.line !== undefined &&
            (call.line < rootCallLines.start || call.line >= rootCallLines.end)) continue;
        const target = index.nodesById.get(call.target);
        if (!target) continue;
        if (!this.isTestOwnedNode(target)) {
          targets.add(call.target);
          continue;
        }
        if (rootIds.has(call.target)) continue;
        for (const targetId of this.productionTargetsFromTestNode(call.target, index)) targets.add(targetId);
      }
    }
    return targets;
  }

  private productionTargetsFromTestNode(
    startNodeId: string,
    index: TestCoverageTargetIndex,
  ): ReadonlySet<string> {
    const cached = index.reachableProductionTargets.get(startNodeId);
    if (cached) return cached;
    const targets = new Set<string>();
    const visited = new Set<string>();
    const queue = [startNodeId];
    let cursor = 0;
    while (cursor < queue.length) {
      const sourceId = queue[cursor++];
      if (visited.has(sourceId)) continue;
      visited.add(sourceId);
      for (const call of index.callsBySource.get(sourceId) || []) {
        const target = index.nodesById.get(call.target);
        if (!target) continue;
        if (this.isTestOwnedNode(target)) queue.push(call.target);
        else targets.add(call.target);
      }
    }
    index.reachableProductionTargets.set(startNodeId, targets);
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

  private sourcePathKeys(filePath: string, projectPath: string): string[] {
    const normalized = this.normalizeSourcePath(filePath);
    if (!path.isAbsolute(filePath)) return [normalized];
    const relative = this.normalizeSourcePath(path.relative(projectPath, filePath));
    return relative === normalized ? [normalized] : [normalized, relative];
  }

  private normalizeSourcePath(filePath: string): string {
    return path.normalize(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  }

  private resolveImportCandidates(importPath: string, testFilePath: string): string[] {
    const basePath = path.normalize(path.join(path.dirname(testFilePath), importPath)).replace(/\\/g, '/');
    const extension = path.extname(basePath);
    if (extension) {



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
        casePatterns: [
          /@Test(?:\s*\([^)]*\))?\s*(?:(?:public|private|protected|internal|suspend|inline|open|final|override)\s+)*fun\s+`([^`\r\n]+)`\s*\(/gm,
          /@Test(?:\s*\([^)]*\))?\s*(?:(?:public|private|protected|internal|suspend|inline|open|final|override)\s+)*fun\s+([A-Za-z0-9_]+)\s*\(/gm,
          /@Test(?:\s*\([^)]*\))?\s*(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:void|[A-Za-z_$][A-Za-z0-9_$<>, ?.\[\]]*)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm,
        ]
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
        evidence: [
          /require\s+['"]minitest/,
          /Minitest::Test/,
          /MiniTest::Test/,
          /ActiveSupport::TestCase/,
          /ActionDispatch::IntegrationTest/,
          /ActionController::TestCase/,
          /class\s+[A-Za-z0-9_:]+\s*<\s*[A-Za-z0-9_:]*TestCase\b/,
          /^\s*test\s+['"][^'"]+['"]\s+do\b/m,
        ],
        casePatterns: [
          /^\s*def\s+(test_[A-Za-z0-9_]+)/gm,
          /^\s*test\s+['"]([^'"]+)['"]\s+do\b/gm,
        ]
      },
      {
        framework: 'phpunit',
        language: 'php',
        filePatterns: ['**/*Test.php', '**/tests/**/*.php'],
        evidence: [/PHPUnit\\Framework\\TestCase/, /extends\s+TestCase/, /@test\b/],
        casePatterns: [/(?:@test[\s\S]{0,40}?)?\bpublic\s+function\s+(test[A-Za-z0-9_]*)\s*\(/gm]
      },
      {






        framework: 'xctest',
        language: 'swift',
        filePatterns: ['**/*Tests.swift', '**/Tests/**/*.swift'],
        evidence: [/import\s+XCTest/, /XCTestCase/, /XCTAssert/],
        casePatterns: [/\bfunc\s+(test[A-Za-z0-9_]*)\s*\(\s*\)/gm]
      },
      {






        framework: 'exunit',
        language: 'elixir',
        filePatterns: ['**/*_test.exs', '**/test/**/*.exs'],
        evidence: [/ExUnit\.Case/, /import\s+ExUnit/],
        casePatterns: [/^\s*test\s+["']([^"']+)["']/gm]
      },
      {





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
