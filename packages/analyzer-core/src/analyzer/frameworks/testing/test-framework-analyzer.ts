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
 *   E2E     Playwright, Selenium
 *
 * Emits `test` nodes (suites carry the `suite` subcategory, cases do not — the
 * exact shape orchestrator.buildTestSuites lifts into CASTestSuite/CASTestCase),
 * reuses the 'test' CASEntryPoint kind for runnable entries, and — where the
 * subject-under-test resolves statically — a `covers` edge from the suite to the
 * imported symbol/module it exercises, so get_test_summary / find_tests can
 * answer "which tests cover this code".
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
      for (const rule of this.rules()) {
        const files = await glob(rule.filePatterns, {
          cwd: projectPath,
          ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
          nodir: true
        });
        for (const file of files.slice(0, 40)) {
          const content = await fs.readFile(path.join(projectPath, file), 'utf-8').catch(() => '');
          if (this.matchesRule(rule, file, content)) return true;
        }
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
      const ignorePatterns = this.getIgnorePatterns(context);
      const suites = await this.discoverSuites(context.projectPath, ignorePatterns);

      for (const suite of suites) {
        this.emitSuite(suite, nodes, edges, entryPoints, context.existingAnalysis);
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
    const claimedFiles = new Set<string>();

    for (const rule of this.rules()) {
      const files = await glob(rule.filePatterns, {
        cwd: projectPath,
        ignore: ignorePatterns,
        nodir: true
      });

      // Budget-yield per file: with the shared file-read cache warm the await
      // resolves in a microtask (no event-loop hop), so this scan ran as one
      // multi-second synchronous block on a whale repo. Results unchanged.
      const maybeYield = createYieldBudget();
      for (const file of files) {
        await maybeYield();
        const normalized = file.replace(/\\/g, '/');
        // First rule to own a file wins — Jest/Cypress own their own files
        // upstream, so we skip anything they detect via naming.
        if (claimedFiles.has(normalized)) continue;

        const absPath = path.join(projectPath, file);
        const content = await fs.readFile(absPath, 'utf-8').catch(() => '');
        if (!content.trim() || !this.matchesRule(rule, normalized, content)) continue;

        const cases = this.extractCases(rule, content);
        if (cases.length === 0) continue;

        claimedFiles.add(normalized);
        suites.push({
          name: this.suiteName(content, normalized, rule),
          file: normalized,
          absPath,
          framework: rule.framework,
          language: rule.language,
          type: this.inferType(normalized, content),
          lineCount: content.split('\n').length,
          cases,
          imports: this.extractImports(content, rule.language)
        });
      }
    }

    return suites;
  }

  private emitSuite(
    suite: DiscoveredSuite,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    existingAnalysis?: CASContribution[]
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

    entryPoints.push({
      id: `entry_${suiteId}`,
      name: `Test Suite: ${suite.name}`,
      type: 'test',
      source_node: suiteId,
      metadata: {
        file: suite.file,
        test_type: suite.type,
        framework: suite.framework,
        language: suite.language,
        testCount: suite.cases.length
      }
    } as CASEntryPoint);

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

      edges.push(this.createEdge(
        this.generateEdgeId(suiteId, testId, 'contains'),
        suiteId,
        testId,
        'contains',
        'structural'
      ));

      entryPoints.push({
        id: `entry_${testId}`,
        name: `Test: ${testCase.name}`,
        type: 'test',
        source_node: testId,
        metadata: {
          suite: suite.name,
          test_type: suite.type,
          framework: suite.framework,
          language: suite.language,
          skipped: testCase.skipped,
          focused: testCase.focused
        }
      } as CASEntryPoint);
    });

    // covers edge: suite -> subject-under-test, gated on a real local import.
    for (const importPath of suite.imports) {
      const targetId = this.resolveImportToNodeId(importPath, suite.file, nodes, existingAnalysis);
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
    for (const pattern of rule.filePatterns) {
      const suffix = pattern.replace(/^\*\*\//, '').toLowerCase();
      if (!suffix.includes('{') && !suffix.includes('*')) {
        if (lower.endsWith(suffix)) return true;
      }
    }
    // Fall through: glob already selected the file, so trust it.
    return true;
  }

  private extractCases(rule: FrameworkRule, content: string): DiscoveredCase[] {
    const cases: DiscoveredCase[] = [];
    const seen = new Set<string>();

    for (const pattern of rule.casePatterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const name = (match[1] || match[2] || 'anonymous test').trim();
        const line = content.slice(0, match.index).split('\n').length;
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
    nodes: CASNode[],
    existingAnalysis?: CASContribution[]
  ): string | null {
    if (!importPath.startsWith('.')) return null;
    const allNodes = [...nodes, ...(existingAnalysis?.flatMap(contribution => contribution.nodes || []) || [])];
    const candidates = this.resolveImportCandidates(importPath, testFilePath);

    for (const candidate of candidates) {
      const match = allNodes.find(node =>
        node.source?.file &&
        (node.source.file === candidate || node.source.file.endsWith(candidate)) &&
        node.type === 'file'
      );
      if (match) return match.id;
    }
    for (const candidate of candidates) {
      const match = allNodes.find(node =>
        node.source?.file &&
        (node.source.file === candidate || node.source.file.endsWith(candidate)) &&
        node.type !== 'test'
      );
      if (match) return match.id;
    }
    return null;
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
