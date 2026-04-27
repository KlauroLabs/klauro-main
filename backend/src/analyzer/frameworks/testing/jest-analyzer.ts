import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, AnalysisContext } from '../../core/base-analyzer';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import { parse } from '@typescript-eslint/typescript-estree';

interface JestConfiguration {
  name: string;
  filePath: string;
  testEnvironment: string;
  setupFilesAfterEnv: string[];
  testMatch: string[];
  collectCoverageFrom: string[];
  coverageDirectory: string;
  reporters: string[];
  moduleNameMapping: Record<string, string>;
  transform: Record<string, string>;
}

interface JestTestSuite {
  name: string;
  filePath: string;
  type: 'unit' | 'integration' | 'e2e' | 'snapshot';
  framework: string;
  tests: JestTest[];
  hooks: JestHook[];
  setup: string[];
  teardown: string[];
  mocks: JestMock[];
  imports: string[];
}

interface JestTest {
  name: string;
  description: string;
  type: 'test' | 'it' | 'fit' | 'xit';
  async: boolean;
  timeout?: number;
  assertions: JestAssertion[];
  mocks: string[];
  spies: string[];
  skipped: boolean;
  focused: boolean;
}

interface JestHook {
  type: 'beforeAll' | 'beforeEach' | 'afterAll' | 'afterEach';
  description?: string;
  async: boolean;
  timeout?: number;
}

interface JestAssertion {
  type: string;
  matcher: string;
  expected?: any;
  actual?: string;
  negated: boolean;
}

interface JestMock {
  name: string;
  type: 'jest.fn' | 'jest.mock' | 'jest.spyOn' | 'manual';
  module?: string;
  implementation?: string;
  mockReturnValue?: any;
  calls: number;
}

interface JestSnapshot {
  name: string;
  filePath: string;
  testFile: string;
  count: number;
  outdated: boolean;
}

interface JestCoverage {
  file: string;
  statements: { covered: number; total: number; percentage: number };
  branches: { covered: number; total: number; percentage: number };
  functions: { covered: number; total: number; percentage: number };
  lines: { covered: number; total: number; percentage: number };
}

interface JestUtility {
  name: string;
  filePath: string;
  type: 'helper' | 'factory' | 'fixture' | 'mock' | 'custom-matcher';
  exports: string[];
  dependencies: string[];
}

export class JestAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'jest',
      'Jest Testing Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      if (Object.keys(deps).includes('jest') || Object.keys(deps).includes('@jest/core')) {
        return true;
      }

      if (packageJson.scripts) {
        const hasJestScript = Object.values(packageJson.scripts).some(script =>
          typeof script === 'string' && script.includes('jest')
        );
        if (hasJestScript) return true;
      }

      const jestConfigPath = path.join(projectPath, 'jest.config.js');
      const jestConfigTsPath = path.join(projectPath, 'jest.config.ts');
      if (await fs.pathExists(jestConfigPath) || await fs.pathExists(jestConfigTsPath)) {
        return true;
      }

      const testFiles = await glob(['**/*.{test,spec}.{js,ts,jsx,tsx}'], {
        cwd: projectPath,
        ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/coverage/**', '**/.nyc_output/**', '**/src/analyzer/**', '**/analyzer/**', '**/analyzers/**', '**/compliance/**']
      });

      if (testFiles.length > 0) {
        for (const file of testFiles) {
          const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
          if (content.includes('describe(') || content.includes('test(') || content.includes('it(')) {
            return true;
          }
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: any[] = [];
    const exitPoints: any[] = [];

    try {
      const baseIgnorePatterns = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/coverage/**', '**/.nyc_output/**'];

      // Add context filters if they exist
      const ignorePatterns = [...baseIgnorePatterns];
      if (context.filters && Array.isArray(context.filters)) {
        ignorePatterns.push(...context.filters);
      }
      // Skip compliance test files that contain non-JS/TS code
      ignorePatterns.push('**/compliance/**');

      const testFiles = await glob(['**/*.{test,spec}.{js,ts,jsx,tsx}'], {
        cwd: context.projectPath,
        ignore: ignorePatterns
      });

      const setupFiles = await glob(['**/setupTests.{js,ts}', '**/jest.setup.{js,ts}', '**/test-setup.{js,ts}'], {
        cwd: context.projectPath,
        ignore: ignorePatterns
      });

      const utilityFiles = await glob(['**/__tests__/helpers/**/*.{js,ts}', '**/test-utils/**/*.{js,ts}', '**/__mocks__/**/*.{js,ts}'], {
        cwd: context.projectPath,
        ignore: ignorePatterns
      });

      const configuration = await this.analyzeConfiguration(context.projectPath, nodes);
      const testSuites = await this.analyzeTestSuites(testFiles, context.projectPath, nodes, edges, entryPoints);
      const snapshots = await this.analyzeSnapshots(context.projectPath, nodes, edges);
      const utilities = await this.analyzeUtilities(utilityFiles, setupFiles, context.projectPath, nodes, edges);
      const coverage = await this.analyzeCoverage(context.projectPath, nodes);

      this.buildJestRelationships(configuration, testSuites, utilities, nodes, edges);
      this.createTestToCodeEdges(testSuites, nodes, edges, context.existingAnalysis);
      this.identifyTestTargets(testSuites, exitPoints);

      return this.createAnalysisResult(nodes, edges, entryPoints, exitPoints, {
        framework: 'jest',
        version: await this.detectJestVersion(context.projectPath),
        configurationFound: configuration !== null,
        testSuitesFound: testSuites.length,
        totalTests: testSuites.reduce((sum, suite) => sum + suite.tests.length, 0),
        snapshotsFound: snapshots.length,
        utilitiesFound: utilities.length,
        coverageEnabled: coverage.length > 0,
        testTypes: this.getTestTypes(testSuites)
      });

    } catch (error) {
      throw new AnalyzerError(
        `Jest analysis failed: ${(error as Error).message}`,
        'JEST_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeConfiguration(projectPath: string, nodes: CASNode[]): Promise<JestConfiguration | null> {
    const configPaths = [
      'jest.config.js',
      'jest.config.ts',
      'jest.config.mjs',
      'jest.config.json'
    ];

    for (const configPath of configPaths) {
      const fullPath = path.join(projectPath, configPath);
      if (await fs.pathExists(fullPath)) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const config = this.extractConfiguration(content, configPath);

          const configId = `jest_config`;
          const configNode = this.createNodeBuilder(configId, 'Jest Configuration', 'config')
            .withLevel(1, 'system')
            .withCategory('config', ['testing'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription('Jest testing framework configuration')
            .withMetadata({
              framework: 'jest',
              attributes: {
                testEnvironment: config.testEnvironment,
                setupFiles: config.setupFilesAfterEnv.length,
                testMatch: config.testMatch.length,
                coverage: config.collectCoverageFrom.length > 0,
                reporters: config.reporters.length,
                transforms: Object.keys(config.transform).length
              }
            })
            .build();
          nodes.push(configNode);

          return config;
        } catch (error) {
          console.warn(`Failed to parse Jest config ${configPath}:`, error);
        }
      }
    }

    // Check package.json for Jest config
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        if (packageJson.jest) {
          const config = this.extractPackageJsonConfig(packageJson.jest);

          const configId = `jest_config_package`;
          nodes.push(this.createNode(
            configId,
            'Jest Configuration (package.json)',
            'service',
            1,
            packageJsonPath,
            1,
            1,
            {
              testEnvironment: config.testEnvironment,
              setupFiles: config.setupFilesAfterEnv.length,
              testMatch: config.testMatch.length,
              coverage: config.collectCoverageFrom.length > 0
            }
          ));

          return config;
        }
      }
    } catch {
      // Continue without package.json config
    }

    return null;
  }

  private async analyzeTestSuites(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<JestTestSuite[]> {
    const testSuites: JestTestSuite[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

        try {
          const jsx = this.shouldParseJsx(file);
          const ast = parse(content, {
            loc: true,
            jsx,
            ecmaVersion: 2020,
            sourceType: 'module'
          });

        const suite = this.extractTestSuite(ast, content, file);
        testSuites.push(suite);

        const suiteId = `test_suite_${this.sanitizeId(suite.name)}`;
        const suiteNode = this.createNodeBuilder(suiteId, suite.name, 'test')
          .withLevel(2, 'architectural')
          .withCategory('test', ['suite'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`Jest test suite: ${suite.name}`)
          .withMetadata({
            framework: 'jest',
            attributes: {
              type: suite.type,
              framework: suite.framework,
              tests: suite.tests.length,
              hooks: suite.hooks.length,
              mocks: suite.mocks.length,
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
            file,
            test_type: suite.type,
            test_style: this.detectTestStyle(content),
            uses_mocks: suite.mocks.length > 0,
            is_async: suite.tests.some(t => t.async),
            framework: suite.framework,
            testCount: suite.tests.length,
            mockCount: suite.mocks.length
          }
        });

        suite.tests.forEach((test, index) => {
          const testId = `test_${suiteId}_${index}`;
          const testNode = this.createNodeBuilder(testId, test.description, 'test')
            .withLevel(3, 'code')
            .withCategory('test', ['unit'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
            .withDescription(`Jest test: ${test.description}`)
            .withMetadata({
              framework: 'jest',
              attributes: {
                type: test.type,
                async: test.async,
                timeout: test.timeout,
                assertions: test.assertions.length,
                mocks: test.mocks.length,
                spies: test.spies.length,
                skipped: test.skipped,
                focused: test.focused
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
            name: `Test: ${test.description}`,
            type: 'test',
            source_node: testId,
            metadata: {
              suite: suite.name,
              test_type: suite.type,
              test_style: test.assertions.length > 0 ? 'procedural' : 'procedural',
              uses_mocks: test.mocks.length > 0 || test.spies.length > 0,
              is_async: test.async,
              framework: suite.framework,
              skipped: test.skipped,
              focused: test.focused,
              assertionCount: test.assertions.length
            }
          });
        });

        suite.hooks.forEach((hook, index) => {
          const hookId = `hook_${suiteId}_${hook.type}_${index}`;
          const hookNode = this.createNodeBuilder(hookId, `${hook.type}${hook.description ? ': ' + hook.description : ''}`, 'hook')
            .withLevel(4, 'member')
            .withCategory('hook', ['test'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
            .withDescription(`Jest ${hook.type} hook`)
            .withMetadata({
              framework: 'jest',
              attributes: {
                type: hook.type,
                async: hook.async,
                timeout: hook.timeout
              }
            })
            .build();
          nodes.push(hookNode);

          edges.push(this.createEdge(
            this.generateEdgeId(suiteId, hookId, 'uses'),
            suiteId,
            hookId,
            'uses',
            'functional'
          ));
        });

        suite.mocks.forEach((mock, index) => {
          const mockId = `mock_${suiteId}_${index}`;
          const mockNode = this.createNodeBuilder(mockId, mock.name, 'mock')
            .withLevel(4, 'member')
            .withCategory('mock', ['test'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
            .withDescription(`Jest mock: ${mock.name}`)
            .withMetadata({
              framework: 'jest',
              attributes: {
                type: mock.type,
                module: mock.module,
                implementation: mock.implementation,
                calls: mock.calls
              }
            })
            .build();
          nodes.push(mockNode);

          edges.push(this.createEdge(
            this.generateEdgeId(suiteId, mockId, 'uses'),
            suiteId,
            mockId,
            'uses',
            'functional'
          ));
        });

      } catch (error) {
        console.warn(`Failed to parse Jest test file ${file}:`, error);

        // Fallback: basic analysis without AST
        const suite = this.extractTestSuiteBasic(content, file);
        if (suite.tests.length > 0) {
          testSuites.push(suite);

          const suiteId = `test_suite_${this.sanitizeId(suite.name)}`;
          const fallbackSuiteNode = this.createNodeBuilder(suiteId, suite.name, 'test-suite')
            .withLevel(2, 'architectural')
            .withCategory('test-suite', ['test'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Jest test suite: ${suite.name}`)
            .withMetadata({
              framework: 'jest',
              attributes: {
                type: suite.type,
                tests: suite.tests.length
              }
            })
            .build();
          nodes.push(fallbackSuiteNode);
        }
      }
    }

    return testSuites;
  }

  private async analyzeSnapshots(
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<JestSnapshot[]> {
    const snapshots: JestSnapshot[] = [];

    const snapshotFiles = await glob(['**/__snapshots__/**/*.snap'], {
      cwd: projectPath,
      ignore: ['**/node_modules/**']
    });

    for (const file of snapshotFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const snapshotCount = this.countSnapshots(content);
      const testFile = this.inferTestFile(file);

      const snapshot: JestSnapshot = {
        name: path.basename(file, '.snap'),
        filePath: file,
        testFile,
        count: snapshotCount,
        outdated: false
      };

      snapshots.push(snapshot);

      const snapshotId = `snapshot_${this.sanitizeId(snapshot.name)}`;
      nodes.push(this.createNode(
        snapshotId,
        snapshot.name,
        'test',
        3,
        fullPath,
        1,
        content.split('\n').length,
        {
          testFile,
          count: snapshotCount,
          outdated: false
        }
      ));
    }

    return snapshots;
  }

  private async analyzeUtilities(
    utilityFiles: string[],
    setupFiles: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<JestUtility[]> {
    const utilities: JestUtility[] = [];

    const allFiles = [...utilityFiles, ...setupFiles];

    for (const file of allFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const utility = this.extractUtility(content, file);
      utilities.push(utility);

      const utilityId = `utility_${this.sanitizeId(utility.name)}`;
      nodes.push(this.createNode(
        utilityId,
        utility.name,
        `jest_${utility.type}`,
        3,
        fullPath,
        1,
        content.split('\n').length,
        {
          type: utility.type,
          exports: utility.exports.length,
          dependencies: utility.dependencies.length
        }
      ));
    }

    return utilities;
  }

  private async analyzeCoverage(projectPath: string, nodes: CASNode[]): Promise<JestCoverage[]> {
    const coverage: JestCoverage[] = [];

    const coverageJsonPath = path.join(projectPath, 'coverage', 'coverage-final.json');
    if (await fs.pathExists(coverageJsonPath)) {
      try {
        const coverageData = await fs.readJson(coverageJsonPath);

        for (const [filePath, fileData] of Object.entries(coverageData)) {
          const data = fileData as any;
          const relativePath = path.relative(projectPath, filePath);

          coverage.push({
            file: relativePath,
            statements: this.calculateCoverage(data.s, data.statementMap),
            branches: this.calculateCoverage(data.b, data.branchMap),
            functions: this.calculateCoverage(data.f, data.fnMap),
            lines: this.calculateCoverage(data.l, {})
          });
        }

        if (coverage.length > 0) {
          const coverageId = `jest_coverage`;
          nodes.push(this.createNode(
            coverageId,
            'Jest Coverage Report',
            'service',
            1,
            coverageJsonPath,
            1,
            1,
            {
              files: coverage.length,
              averageStatements: this.calculateAverageCoverage(coverage, 'statements'),
              averageBranches: this.calculateAverageCoverage(coverage, 'branches'),
              averageFunctions: this.calculateAverageCoverage(coverage, 'functions'),
              averageLines: this.calculateAverageCoverage(coverage, 'lines')
            }
          ));
        }
      } catch (error) {
        console.warn('Failed to parse Jest coverage data:', error);
      }
    }

    return coverage;
  }

  private extractConfiguration(content: string, filePath: string): JestConfiguration {
    const config: JestConfiguration = {
      name: path.basename(filePath),
      filePath,
      testEnvironment: 'jsdom',
      setupFilesAfterEnv: [],
      testMatch: [],
      collectCoverageFrom: [],
      coverageDirectory: 'coverage',
      reporters: ['default'],
      moduleNameMapping: {},
      transform: {}
    };

    // Basic extraction - could be enhanced with actual JS parsing
    if (content.includes('testEnvironment')) {
      const envMatch = content.match(/testEnvironment:\s*['"]([^'"]+)['"]/);
      if (envMatch) config.testEnvironment = envMatch[1];
    }

    if (content.includes('setupFilesAfterEnv')) {
      const setupMatch = content.match(/setupFilesAfterEnv:\s*\[([^\]]+)\]/);
      if (setupMatch) {
        config.setupFilesAfterEnv = setupMatch[1]
          .split(',')
          .map(s => s.trim().replace(/['"]/g, ''))
          .filter(Boolean);
      }
    }

    return config;
  }

  private extractPackageJsonConfig(jestConfig: any): JestConfiguration {
    return {
      name: 'package.json',
      filePath: 'package.json',
      testEnvironment: jestConfig.testEnvironment || 'jsdom',
      setupFilesAfterEnv: jestConfig.setupFilesAfterEnv || [],
      testMatch: jestConfig.testMatch || [],
      collectCoverageFrom: jestConfig.collectCoverageFrom || [],
      coverageDirectory: jestConfig.coverageDirectory || 'coverage',
      reporters: jestConfig.reporters || ['default'],
      moduleNameMapping: jestConfig.moduleNameMapper || {},
      transform: jestConfig.transform || {}
    };
  }

  private extractTestSuite(ast: any, content: string, filePath: string): JestTestSuite {
    const suite: JestTestSuite = {
      name: this.extractSuiteName(content, filePath),
      filePath,
      type: this.inferTestType(filePath, content),
      framework: this.detectTestingFramework(content),
      tests: [],
      hooks: [],
      setup: [],
      teardown: [],
      mocks: [],
      imports: this.extractImports(content)
    };

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'CallExpression') {
        const callee = node.callee;

        if (callee.type === 'Identifier') {
          if (['describe', 'test', 'it', 'fit', 'xit'].includes(callee.name)) {
            if (callee.name === 'describe') {
              // Handle nested describes
            } else {
              const test = this.extractTest(node, content);
              suite.tests.push(test);
            }
          } else if (['beforeAll', 'beforeEach', 'afterAll', 'afterEach'].includes(callee.name)) {
            const hook = this.extractHook(node, content, callee.name);
            suite.hooks.push(hook);
          }
        }
      }

      for (const key in node) {
        if (typeof node[key] === 'object' && node[key] !== null) {
          if (Array.isArray(node[key])) {
            node[key].forEach(walk);
          } else {
            walk(node[key]);
          }
        }
      }
    };

    walk(ast);

    suite.mocks = this.extractMocks(content);

    return suite;
  }

  private extractTestSuiteBasic(content: string, filePath: string): JestTestSuite {
    const suite: JestTestSuite = {
      name: this.extractSuiteName(content, filePath),
      filePath,
      type: this.inferTestType(filePath, content),
      framework: this.detectTestingFramework(content),
      tests: [],
      hooks: [],
      setup: [],
      teardown: [],
      mocks: [],
      imports: this.extractImports(content)
    };

    // Extract tests using regex
    const testPatterns = [
      /(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      /(?:test|it)\s*\.\s*(?:each|skip|only)\s*\(\s*['"`]([^'"`]+)['"`]/g
    ];

    testPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        suite.tests.push({
          name: match[1],
          description: match[1],
          type: 'test',
          async: content.includes('async'),
          assertions: [],
          mocks: [],
          spies: [],
          skipped: false,
          focused: false
        });
      }
    });

    return suite;
  }

  private extractSuiteName(content: string, filePath: string): string {
    const describeMatch = content.match(/describe\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (describeMatch) return describeMatch[1];

    return path.basename(filePath, path.extname(filePath));
  }

  private extractTest(node: any, content: string): JestTest {
    const description = this.getStringLiteral(node.arguments[0]);
    const callback = node.arguments[1];

    return {
      name: description || 'Unnamed test',
      description: description || 'Unnamed test',
      type: node.callee.name,
      async: callback && callback.async === true,
      assertions: this.extractAssertions(node, content),
      mocks: this.extractTestMocks(node, content),
      spies: this.extractSpies(node, content),
      skipped: node.callee.name === 'xit' || content.includes('.skip'),
      focused: node.callee.name === 'fit' || content.includes('.only')
    };
  }

  private extractHook(node: any, content: string, type: string): JestHook {
    const callback = node.arguments[0];

    return {
      type: type as any,
      async: callback && callback.async === true
    };
  }

  private extractMocks(content: string): JestMock[] {
    const mocks: JestMock[] = [];

    const jestFnPattern = /jest\.fn\s*\(\s*([^)]*)\s*\)/g;
    let match;
    while ((match = jestFnPattern.exec(content)) !== null) {
      mocks.push({
        name: `mockFn_${mocks.length}`,
        type: 'jest.fn',
        implementation: match[1] || undefined,
        calls: 0
      });
    }

    const jestMockPattern = /jest\.mock\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((match = jestMockPattern.exec(content)) !== null) {
      mocks.push({
        name: match[1],
        type: 'jest.mock',
        module: match[1],
        calls: 0
      });
    }

    const jestSpyPattern = /jest\.spyOn\s*\(\s*([^,]+),\s*['"`]([^'"`]+)['"`]/g;
    while ((match = jestSpyPattern.exec(content)) !== null) {
      mocks.push({
        name: `${match[1]}.${match[2]}`,
        type: 'jest.spyOn',
        calls: 0
      });
    }

    return mocks;
  }

  private extractAssertions(node: any, content: string): JestAssertion[] {
    const assertions: JestAssertion[] = [];

    const expectPattern = /expect\s*\([^)]*\)\s*\.(?:not\s*\.)?(\w+)\s*\(/g;
    let match;
    while ((match = expectPattern.exec(content)) !== null) {
      assertions.push({
        type: 'expect',
        matcher: match[1],
        negated: content.includes('.not.')
      });
    }

    return assertions;
  }

  private extractTestMocks(node: any, content: string): string[] {
    // Extract mocks used in this specific test
    return [];
  }

  private extractSpies(node: any, content: string): string[] {
    // Extract spies used in this specific test
    return [];
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const importPattern = /(?:import\s+[^;]+\s+from\s+['"`]([^'"`]+)['"`]|require\s*\(\s*['"`]([^'"`]+)['"`]\s*\))/g;

    let match;
    while ((match = importPattern.exec(content)) !== null) {
      imports.push(match[1] || match[2]);
    }

    return imports;
  }

  private extractUtility(content: string, filePath: string): JestUtility {
    const name = path.basename(filePath, path.extname(filePath));
    let type: 'helper' | 'factory' | 'fixture' | 'mock' | 'custom-matcher' = 'helper';

    if (filePath.includes('factory') || filePath.includes('factories')) type = 'factory';
    else if (filePath.includes('fixture') || filePath.includes('fixtures')) type = 'fixture';
    else if (filePath.includes('mock') || filePath.includes('mocks') || filePath.includes('__mocks__')) type = 'mock';
    else if (content.includes('expect.extend') || content.includes('toMatch')) type = 'custom-matcher';

    return {
      name,
      filePath,
      type,
      exports: this.extractExports(content),
      dependencies: this.extractImports(content)
    };
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    const exportPattern = /export\s+(?:const|function|class|default)?\s*(\w+)/g;

    let match;
    while ((match = exportPattern.exec(content)) !== null) {
      exports.push(match[1]);
    }

    return exports;
  }

  private getStringLiteral(node: any): string | null {
    if (node && node.type === 'Literal' && typeof node.value === 'string') {
      return node.value;
    }
    return null;
  }

  private inferTestType(filePath: string, content: string): 'unit' | 'integration' | 'e2e' | 'snapshot' {
    if (filePath.includes('e2e') || filePath.includes('integration')) return 'e2e';
    if (filePath.includes('integration')) return 'integration';
    if (content.includes('toMatchSnapshot')) return 'snapshot';
    return 'unit';
  }

  private detectTestStyle(content: string): 'procedural' | 'bdd' | 'property-based' | 'snapshot' | 'parameterized' {
    if (content.includes('given(') || content.includes('when(') || content.includes('then(') ||
        content.includes('Given ') || content.includes('When ') || content.includes('Then ')) {
      return 'bdd';
    }
    if (content.includes('fc.') || content.includes('fast-check') || content.includes('jsverify')) {
      return 'property-based';
    }
    if (content.includes('toMatchSnapshot') || content.includes('toMatchInlineSnapshot')) {
      return 'snapshot';
    }
    if (content.includes('.each(') || content.includes('.each`') || content.includes('test.each')) {
      return 'parameterized';
    }
    return 'procedural';
  }

  private detectTestingFramework(content: string): string {
    if (content.includes('@testing-library')) return 'testing-library';
    if (content.includes('enzyme')) return 'enzyme';
    if (content.includes('supertest')) return 'supertest';
    return 'jest';
  }

  private countSnapshots(content: string): number {
    const snapshotPattern = /exports\[`[^`]+`\]\s*=/g;
    const matches = content.match(snapshotPattern);
    return matches ? matches.length : 0;
  }

  private inferTestFile(snapshotFile: string): string {
    return snapshotFile.replace('/__snapshots__/', '/').replace('.snap', '');
  }

  private calculateCoverage(coverageData: any, mappingData: any): { covered: number; total: number; percentage: number } {
    if (!coverageData) return { covered: 0, total: 0, percentage: 0 };

    const values = Object.values(coverageData) as number[];
    const total = values.length;
    const covered = values.filter(v => v > 0).length;
    const percentage = total > 0 ? Math.round((covered / total) * 100) : 0;

    return { covered, total, percentage };
  }

  private calculateAverageCoverage(coverage: JestCoverage[], type: keyof Pick<JestCoverage, 'statements' | 'branches' | 'functions' | 'lines'>): number {
    if (coverage.length === 0) return 0;
    const total = coverage.reduce((sum, c) => sum + c[type].percentage, 0);
    return Math.round(total / coverage.length);
  }

  private getTestTypes(testSuites: JestTestSuite[]): string[] {
    const types = new Set(testSuites.map(suite => suite.type));
    return Array.from(types);
  }

  private async detectJestVersion(projectPath: string): Promise<string> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return deps.jest || deps['@jest/core'] || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private buildJestRelationships(
    configuration: JestConfiguration | null,
    testSuites: JestTestSuite[],
    utilities: JestUtility[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    if (configuration) {
      const configId = configuration.filePath.includes('package.json') ? 'jest_config_package' : 'jest_config';

      testSuites.forEach(suite => {
        const suiteId = `test_suite_${this.sanitizeId(suite.name)}`;
        edges.push(this.createEdge(
          `${configId}_configures_${suiteId}`,
          configId,
          suiteId,
          'configures'
        ));
      });

      utilities.forEach(utility => {
        if (configuration.setupFilesAfterEnv.some(file => file.includes(utility.name))) {
          const utilityId = `utility_${this.sanitizeId(utility.name)}`;
          edges.push(this.createEdge(
            `${configId}_uses_${utilityId}`,
            configId,
            utilityId,
            'uses'
          ));
        }
      });
    }

    testSuites.forEach(suite => {
      const suiteId = `test_suite_${this.sanitizeId(suite.name)}`;

      suite.imports.forEach(importPath => {
        const utility = utilities.find(u => importPath.includes(u.name));
        if (utility) {
          const utilityId = `utility_${this.sanitizeId(utility.name)}`;
          edges.push(this.createEdge(
            `${suiteId}_imports_${utilityId}`,
            suiteId,
            utilityId,
            'imports'
          ));
        }
      });
    });
  }

  private identifyTestTargets(testSuites: JestTestSuite[], exitPoints: any[]): void {
    const targets = new Set<string>();

    testSuites.forEach(suite => {
      suite.imports.forEach(importPath => {
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
          targets.add(importPath);
        }
      });
    });

    if (targets.size > 0) {
      exitPoints.push({
        id: 'exit_jest_test_targets',
        name: 'Jest Test Targets',
        type: 'test_coverage',
        source_node: 'jest_test_runner',
        metadata: {
          testSuites: testSuites.length,
          totalTests: testSuites.reduce((sum, suite) => sum + suite.tests.length, 0),
          targets: Array.from(targets),
          frameworks: [...new Set(testSuites.map(s => s.framework))]
        }
      });
    }
  }

  private createTestToCodeEdges(
    testSuites: JestTestSuite[],
    nodes: CASNode[],
    edges: CASEdge[],
    existingAnalysis?: CASAnalysisResult[]
  ): void {
    testSuites.forEach(suite => {
      const suiteId = `test_suite_${this.sanitizeId(suite.name)}`;

      suite.imports.forEach(importPath => {
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
          const targetId = this.resolveImportToNodeId(importPath, suite.filePath, nodes, existingAnalysis);
          if (targetId) {
            edges.push(this.createEdge(
              this.generateEdgeId(suiteId, targetId, 'tests'),
              suiteId,
              targetId,
              'tests',
              'test-relationship'
            ));
          }
        }
      });

      suite.mocks.forEach((mock, index) => {
        if (mock.module) {
          const mockId = `mock_${suiteId}_${index}`;
          const targetId = this.resolveImportToNodeId(mock.module, suite.filePath, nodes, existingAnalysis);
          if (targetId) {
            edges.push(this.createEdge(
              this.generateEdgeId(mockId, targetId, 'mocks'),
              mockId,
              targetId,
              'mocks',
              'test-relationship'
            ));
          }
        }
      });
    });
  }

  private resolveImportToNodeId(
    importPath: string,
    testFilePath: string,
    nodes: CASNode[],
    existingAnalysis?: CASAnalysisResult[]
  ): string | null {
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
    const basePath = path.normalize(path.join(path.dirname(testFilePath), importPath));
    const extension = path.extname(basePath);
    if (extension) return [basePath];

    return [
      basePath,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      `${basePath}.js`,
      `${basePath}.jsx`,
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
      path.join(basePath, 'index.js'),
      path.join(basePath, 'index.jsx')
    ];
  }

  protected sanitizeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9]/g, '_');
  }

  private shouldParseJsx(filePath: string): boolean {
    return /\.(jsx|tsx)$/i.test(filePath);
  }


  private createAnalysisResult(
    nodes: any[],
    edges: any[],
    entryPoints: any[],
    exitPoints: any[],
    metadata: any
  ): any {
    return this.createContribution(nodes, edges, entryPoints, exitPoints, metadata);
  }

  protected getCapabilities(): string[] {
    return [
      'test-detection',
      'suite-analysis',
      'mock-analysis',
      'snapshot-analysis',
      'coverage-analysis',
      'hook-detection',
      'configuration-parsing'
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
