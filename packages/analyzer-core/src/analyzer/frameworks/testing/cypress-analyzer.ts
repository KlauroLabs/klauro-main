import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface CypressConfiguration {
  baseUrl?: string;
  specPattern: string[];
  supportFile: string;
  fixturesFolder: string;
  screenshotsFolder: string;
  videosFolder: string;
  viewportWidth: number;
  viewportHeight: number;
  defaultCommandTimeout: number;
}

interface CypressSpec {
  name: string;
  filePath: string;
  describes: CypressDescribe[];
  hooks: CypressHook[];
  imports: string[];
  customCommands: string[];
  fixtures: string[];
  pages: string[];
}

interface CypressDescribe {
  name: string;
  type: 'describe' | 'context';
  tests: CypressTest[];
  hooks: CypressHook[];
  nested: CypressDescribe[];
}

interface CypressTest {
  name: string;
  type: 'it' | 'specify';
  tags: string[];
  skip: boolean;
  only: boolean;
  commands: CypressCommand[];
}

interface CypressHook {
  type: 'before' | 'beforeEach' | 'after' | 'afterEach';
  commands: CypressCommand[];
}

interface CypressCommand {
  command: string;
  selector?: string;
  arguments: string[];
  assertion?: string;
  custom: boolean;
}

interface CypressCustomCommand {
  name: string;
  filePath: string;
  parameters: Array<{ name: string; type: string }>;
  implementation: string;
  chainable: boolean;
}

interface CypressPageObject {
  name: string;
  filePath: string;
  elements: Array<{ name: string; selector: string }>;
  methods: Array<{ name: string; parameters: any[] }>;
}

interface CypressFixture {
  name: string;
  filePath: string;
  data: Record<string, any>;
  used: string[];
}

export class CypressAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'cypress',
      'Cypress E2E Testing Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  protected getCapabilities(): string[] {
    return [
      'e2e-testing',
      'browser-automation',
      'component-testing',
      'api-testing',
      'visual-testing',
      'cross-browser-testing',
      'ci-integration',
      'custom-commands',
      'page-objects',
      'fixture-management'
    ];
  }

  protected getLevelName(level: number): string {
    const levelNames: Record<number, string> = {
      1: 'system',
      2: 'module',
      3: 'code',
      4: 'member',
      5: 'implementation'
    };
    return levelNames[level] || 'member';
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

        if (Object.keys(deps).includes('cypress')) {
          return true;
        }
      }

      const cypressConfigExists = await fs.pathExists(path.join(projectPath, 'cypress.config.js')) ||
                                  await fs.pathExists(path.join(projectPath, 'cypress.config.ts')) ||
                                  await fs.pathExists(path.join(projectPath, 'cypress.json'));

      if (cypressConfigExists) return true;

      const cypressFolderExists = await fs.pathExists(path.join(projectPath, 'cypress'));
      if (cypressFolderExists) return true;

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
      const cypressFiles = await glob(['cypress/**/*.{js,ts}', '**/*cy.{js,ts}', '**/*.cy.{js,ts}'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      });

      const configuration = await this.analyzeCypressConfiguration(context.projectPath, nodes);
      const specs = await this.analyzeSpecs(cypressFiles, context.projectPath, nodes, edges, entryPoints);
      const customCommands = await this.analyzeCustomCommands(cypressFiles, context.projectPath, nodes, edges);
      const pageObjects = await this.analyzePageObjects(cypressFiles, context.projectPath, nodes, edges);
      const fixtures = await this.analyzeFixtures(context.projectPath, nodes, edges);

      this.buildCypressRelationships(specs, customCommands, pageObjects, fixtures, nodes, edges);
      this.identifyTestTargets(specs, configuration, exitPoints);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          cypress_version: await this.detectCypressVersion(context.projectPath),
          base_url: configuration?.baseUrl,
          spec_pattern: configuration?.specPattern,
          specs_detected: specs.length,
          custom_commands_detected: customCommands.length,
          page_objects_detected: pageObjects.length,
          fixtures_detected: fixtures.length,
          total_tests: specs.reduce((sum, spec) => sum + this.countTests(spec), 0)
        }
      });

    } catch (error) {
      throw new AnalyzerError(
        `Cypress analysis failed: ${(error as Error).message}`,
        'CYPRESS_ANALYSIS_ERROR'
      );
    }
  }


  private async analyzeCypressConfiguration(projectPath: string, nodes: CASNode[]): Promise<CypressConfiguration | null> {
    try {
      const configFiles = ['cypress.config.js', 'cypress.config.ts', 'cypress.json'];
      let configPath: string | null = null;
      let configContent: string = '';

      for (const configFile of configFiles) {
        const fullPath = path.join(projectPath, configFile);
        if (await fs.pathExists(fullPath)) {
          configPath = fullPath;
          configContent = await fs.readFile(fullPath, 'utf-8');
          break;
        }
      }

      if (!configPath) return null;

      const configuration: CypressConfiguration = {
        baseUrl: this.extractBaseUrl(configContent),
        specPattern: this.extractSpecPattern(configContent),
        supportFile: this.extractSupportFile(configContent),
        fixturesFolder: this.extractFixturesFolder(configContent),
        screenshotsFolder: this.extractScreenshotsFolder(configContent),
        videosFolder: this.extractVideosFolder(configContent),
        viewportWidth: this.extractViewportWidth(configContent),
        viewportHeight: this.extractViewportHeight(configContent),
        defaultCommandTimeout: this.extractDefaultCommandTimeout(configContent)
      };

      const configId = this.generateId('config', configPath, 'cypress-config');
      const configNode = this.createNodeBuilder(configId, 'Cypress Configuration', 'cypress_config')
        .withLevel(1, 'system')
        .withCategory('configuration', ['cypress', 'testing'])
        .withSource({ file: configPath, line: 1, end_line: configContent.split('\n').length })
        .withDescription('Cypress testing framework configuration')
        .withMetadata({
          framework: 'cypress',
          attributes: {
            base_url: configuration.baseUrl,
            spec_pattern: configuration.specPattern,
            support_file: configuration.supportFile,
            fixtures_folder: configuration.fixturesFolder,
            viewport_width: configuration.viewportWidth,
            viewport_height: configuration.viewportHeight,
            default_command_timeout: configuration.defaultCommandTimeout
          }
        })
        .build();
      nodes.push(configNode);

      return configuration;
    } catch {
      return null;
    }
  }

  private async analyzeSpecs(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<CypressSpec[]> {
    const specs: CypressSpec[] = [];
    const specFiles = files.filter(f =>
      f.includes('/e2e/') ||
      f.includes('/integration/') ||
      f.includes('/specs/') ||
      f.includes('.cy.') ||
      f.includes('_spec.') ||
      f.includes('.spec.')
    );

    for (const file of specFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('describe') || content.includes('it') || content.includes('cy.')) {
        try {
          const spec = this.extractSpec(content, file);
          if (spec) {
            specs.push(spec);

            const specId = this.generateId('spec', spec.filePath, spec.name);
            const specNode = this.createNodeBuilder(specId, spec.name, 'cypress_spec')
              .withLevel(2, 'architectural')
              .withCategory('spec', ['cypress', 'e2e', 'testing'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Cypress test spec: ${spec.name}`)
              .withMetadata({
                framework: 'cypress',
                attributes: {
                  describes_count: spec.describes.length,
                  hooks_count: spec.hooks.length,
                  imports_count: spec.imports.length,
                  custom_commands_count: spec.customCommands.length,
                  fixtures_count: spec.fixtures.length,
                  pages_count: spec.pages.length,
                  total_tests: this.countTests(spec)
                }
              })
              .build();
            nodes.push(specNode);

            spec.describes.forEach(describe => {
              this.analyzeDescribe(describe, specId, fullPath, nodes, edges, entryPoints);
            });

            entryPoints.push(this.createEntryPoint(
              `entry_${specId}`,
              specId,
              'event',
              `Test Spec: ${spec.name}`,
              `Cypress E2E test specification`,
              {},
              {},
              {
                attributes: {
                  total_tests: this.countTests(spec),
                  fixtures: spec.fixtures,
                  custom_commands: spec.customCommands
                }
              }
            ));
          }
        } catch (error) {
          console.warn(`Failed to parse Cypress spec ${file}:`, error);
        }
      }
    }

    return specs;
  }

  private analyzeDescribe(
    describe: CypressDescribe,
    parentId: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const describeId = this.generateId('describe', filePath, `${parentId}_${describe.name}`);
    const describeNode = this.createNodeBuilder(describeId, describe.name, 'test_describe')
      .withLevel(3, 'code')
      .withCategory('describe', ['cypress', 'test-suite'])
      .withSource({ file: filePath, line: 1, end_line: 1 })
      .withDescription(`Test suite: ${describe.name}`)
      .withParent(parentId)
      .withMetadata({
        framework: 'cypress',
        attributes: {
          type: describe.type,
          tests_count: describe.tests.length,
          hooks_count: describe.hooks.length,
          nested_count: describe.nested.length
        }
      })
      .build();
    nodes.push(describeNode);

    edges.push(this.createEdge(
      this.generateEdgeId(parentId, describeId, 'contains'),
      parentId,
      describeId,
      'contains',
      'structural'
    ));

    describe.tests.forEach(test => {
      const testId = this.generateId('test', filePath, `${describeId}_${test.name}`);
      const testNode = this.createNodeBuilder(testId, test.name, 'cypress_test')
        .withLevel(4, 'member')
        .withCategory('test', ['cypress', 'e2e'])
        .withSource({ file: filePath, line: 1, end_line: 1 })
        .withDescription(`E2E test: ${test.name}`)
        .withParent(describeId)
        .withMetadata({
          framework: 'cypress',
          attributes: {
            type: test.type,
            tags: test.tags,
            skip: test.skip,
            only: test.only,
            commands_count: test.commands.length,
            assertions_count: test.commands.filter(c => c.assertion).length
          }
        })
        .build();
      nodes.push(testNode);

      edges.push(this.createEdge(
        this.generateEdgeId(describeId, testId, 'contains'),
        describeId,
        testId,
        'contains',
        'structural'
      ));

      entryPoints.push(this.createEntryPoint(
        `entry_${testId}`,
        testId,
        'event',
        `Test: ${test.name}`,
        `Individual Cypress E2E test case`,
        {},
        {},
        {
          attributes: {
            test_framework: 'cypress',
            tags: test.tags,
            skip: test.skip,
            only: test.only,
            commands: test.commands.map(c => c.command)
          }
        }
      ));
    });

    describe.nested.forEach(nested => {
      this.analyzeDescribe(nested, describeId, filePath, nodes, edges, entryPoints);
    });
  }

  private async analyzeCustomCommands(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<CypressCustomCommand[]> {
    const customCommands: CypressCustomCommand[] = [];
    const commandFiles = files.filter(f =>
      f.includes('/support/') ||
      f.includes('commands.') ||
      f.includes('e2e.') && f.includes('/support/')
    );

    for (const file of commandFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('Cypress.Commands.add')) {
        try {
          const commands = this.extractCustomCommands(content, file);
          customCommands.push(...commands);

          commands.forEach(command => {
            const commandId = this.generateId('command', command.filePath, command.name);
            const commandNode = this.createNodeBuilder(commandId, command.name, 'cypress_custom_command')
              .withLevel(3, 'code')
              .withCategory('command', ['cypress', 'custom'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Cypress custom command: ${command.name}`)
              .withSignature({
                parameters: command.parameters,
                return_type: 'Chainable'
              })
              .withMetadata({
                framework: 'cypress',
                attributes: {
                  chainable: command.chainable,
                  parameters_count: command.parameters.length
                }
              })
              .build();
            nodes.push(commandNode);
          });
        } catch (error) {
          console.warn(`Failed to parse Cypress custom commands ${file}:`, error);
        }
      }
    }

    return customCommands;
  }

  private async analyzePageObjects(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<CypressPageObject[]> {
    const pageObjects: CypressPageObject[] = [];
    const pageFiles = files.filter(f =>
      f.includes('/pages/') ||
      f.includes('/page-objects/') ||
      f.includes('Page.') ||
      f.includes('.page.')
    );

    for (const file of pageFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('class ') || content.includes('export')) {
        try {
          const pageObject = this.extractPageObject(content, file);
          if (pageObject) {
            pageObjects.push(pageObject);

            const pageId = this.generateId('page', pageObject.filePath, pageObject.name);
            const pageNode = this.createNodeBuilder(pageId, pageObject.name, 'cypress_page_object')
              .withLevel(3, 'code')
              .withCategory('page', ['cypress', 'pom'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Cypress page object: ${pageObject.name}`)
              .withMetadata({
                framework: 'cypress',
                attributes: {
                  elements_count: pageObject.elements.length,
                  methods_count: pageObject.methods.length
                }
              })
              .build();
            nodes.push(pageNode);

            pageObject.methods.forEach(method => {
              const methodId = this.generateId('method', pageObject.filePath, `${pageObject.name}_${method.name}`);
              const methodNode = this.createNodeBuilder(methodId, method.name, 'page_method')
                .withLevel(4, 'member')
                .withCategory('method', ['cypress', 'page-action'])
                .withSource({ file: fullPath, line: 1, end_line: 1 })
                .withDescription(`Page method: ${method.name}`)
                .withParent(pageId)
                .withSignature({
                  parameters: method.parameters,
                  return_type: 'void'
                })
                .withMetadata({
                  framework: 'cypress'
                })
                .build();
              nodes.push(methodNode);

              edges.push(this.createEdge(
                this.generateEdgeId(pageId, methodId, 'contains'),
                pageId,
                methodId,
                'contains',
                'structural'
              ));
            });
          }
        } catch (error) {
          console.warn(`Failed to parse Cypress page object ${file}:`, error);
        }
      }
    }

    return pageObjects;
  }

  private async analyzeFixtures(
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<CypressFixture[]> {
    const fixtures: CypressFixture[] = [];
    const fixturesPath = path.join(projectPath, 'cypress', 'fixtures');

    if (await fs.pathExists(fixturesPath)) {
      const fixtureFiles = await glob(['**/*.json', '**/*.js', '**/*.ts'], {
        cwd: fixturesPath,
        ignore: this.getIgnorePatterns({ projectPath: fixturesPath }),
        nodir: true
      });

      for (const file of fixtureFiles) {
        const fullPath = path.join(fixturesPath, file);
        const content = await fs.readFile(fullPath, 'utf-8');

        try {
          const fixture = this.extractFixture(content, file);
          if (fixture) {
            fixtures.push(fixture);

            const fixtureId = this.generateId('fixture', fixture.filePath, fixture.name);
            const fixtureNode = this.createNodeBuilder(fixtureId, fixture.name, 'cypress_fixture')
              .withLevel(4, 'member')
              .withCategory('fixture', ['cypress', 'data'])
              .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
              .withDescription(`Cypress test fixture: ${fixture.name}`)
              .withMetadata({
                framework: 'cypress',
                attributes: {
                  data_keys: Object.keys(fixture.data).length,
                  used_by: fixture.used
                }
              })
              .build();
            nodes.push(fixtureNode);
          }
        } catch (error) {
          console.warn(`Failed to parse Cypress fixture ${file}:`, error);
        }
      }
    }

    return fixtures;
  }

  private extractBaseUrl(content: string): string | undefined {
    const baseUrlMatch = content.match(/baseUrl\s*:\s*['"`]([^'"`]+)['"`]/);
    return baseUrlMatch ? baseUrlMatch[1] : undefined;
  }

  private extractSpecPattern(content: string): string[] {
    const specPatternMatch = content.match(/specPattern\s*:\s*\[([^\]]+)\]/);
    if (specPatternMatch) {
      const patterns = specPatternMatch[1].match(/['"`]([^'"`]+)['"`]/g);
      return patterns ? patterns.map(p => p.slice(1, -1)) : [];
    }
    return ['cypress/e2e/**/*.cy.{js,jsx,ts,tsx}'];
  }

  private extractSupportFile(content: string): string {
    const supportFileMatch = content.match(/supportFile\s*:\s*['"`]([^'"`]+)['"`]/);
    return supportFileMatch ? supportFileMatch[1] : 'cypress/support/e2e.{js,ts}';
  }

  private extractFixturesFolder(content: string): string {
    const fixturesMatch = content.match(/fixturesFolder\s*:\s*['"`]([^'"`]+)['"`]/);
    return fixturesMatch ? fixturesMatch[1] : 'cypress/fixtures';
  }

  private extractScreenshotsFolder(content: string): string {
    const screenshotsMatch = content.match(/screenshotsFolder\s*:\s*['"`]([^'"`]+)['"`]/);
    return screenshotsMatch ? screenshotsMatch[1] : 'cypress/screenshots';
  }

  private extractVideosFolder(content: string): string {
    const videosMatch = content.match(/videosFolder\s*:\s*['"`]([^'"`]+)['"`]/);
    return videosMatch ? videosMatch[1] : 'cypress/videos';
  }

  private extractViewportWidth(content: string): number {
    const viewportWidthMatch = content.match(/viewportWidth\s*:\s*(\d+)/);
    return viewportWidthMatch ? parseInt(viewportWidthMatch[1]) : 1000;
  }

  private extractViewportHeight(content: string): number {
    const viewportHeightMatch = content.match(/viewportHeight\s*:\s*(\d+)/);
    return viewportHeightMatch ? parseInt(viewportHeightMatch[1]) : 660;
  }

  private extractDefaultCommandTimeout(content: string): number {
    const timeoutMatch = content.match(/defaultCommandTimeout\s*:\s*(\d+)/);
    return timeoutMatch ? parseInt(timeoutMatch[1]) : 4000;
  }

  private extractSpec(content: string, filePath: string): CypressSpec | null {
    const specName = path.basename(filePath, path.extname(filePath));

    return {
      name: specName,
      filePath,
      describes: this.extractDescribes(content),
      hooks: this.extractHooks(content),
      imports: this.extractImports(content),
      customCommands: this.extractUsedCustomCommands(content),
      fixtures: this.extractUsedFixtures(content),
      pages: this.extractUsedPages(content)
    };
  }

  private extractDescribes(content: string): CypressDescribe[] {
    const describes: CypressDescribe[] = [];
    const describePattern = /(describe|context)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\(\s*\)\s*=>\s*\{/g;

    let match;
    while ((match = describePattern.exec(content)) !== null) {
      const type = match[1] as 'describe' | 'context';
      const name = match[2];

      describes.push({
        name,
        type,
        tests: this.extractTests(content, name),
        hooks: this.extractHooks(content),
        nested: []
      });
    }

    return describes;
  }

  private extractTests(content: string, describeName?: string): CypressTest[] {
    const tests: CypressTest[] = [];
    const testPattern = /(it|specify)(\.(skip|only))?\s*\(\s*['"`]([^'"`]+)['"`]/g;

    let match;
    while ((match = testPattern.exec(content)) !== null) {
      const type = match[1] as 'it' | 'specify';
      const modifier = match[3];
      const name = match[4];

      tests.push({
        name,
        type,
        tags: this.extractTestTags(content, name),
        skip: modifier === 'skip',
        only: modifier === 'only',
        commands: this.extractTestCommands(content, name)
      });
    }

    return tests;
  }

  private extractHooks(content: string): CypressHook[] {
    const hooks: CypressHook[] = [];
    const hookPattern = /(before|beforeEach|after|afterEach)\s*\(/g;

    let match;
    while ((match = hookPattern.exec(content)) !== null) {
      const type = match[1] as 'before' | 'beforeEach' | 'after' | 'afterEach';

      hooks.push({
        type,
        commands: []
      });
    }

    return hooks;
  }

  private extractTestTags(content: string, testName: string): string[] {
    return [];
  }

  private extractTestCommands(content: string, testName: string): CypressCommand[] {
    const commands: CypressCommand[] = [];
    const commandPattern = /cy\.(\w+)\(([^)]*)\)/g;

    let match;
    while ((match = commandPattern.exec(content)) !== null) {
      const command = match[1];
      const args = match[2];

      commands.push({
        command: `cy.${command}`,
        arguments: [args],
        custom: this.isCustomCommand(command),
        assertion: this.extractAssertion(content, command)
      });
    }

    return commands;
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const importPattern = /import\s+(?:\{[^}]*\}|\w+|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]/g;

    let match;
    while ((match = importPattern.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return imports;
  }

  private extractUsedCustomCommands(content: string): string[] {
    const commands: string[] = [];
    const customCommandPattern = /cy\.(\w+)\(/g;

    let match;
    while ((match = customCommandPattern.exec(content)) !== null) {
      const command = match[1];
      if (this.isCustomCommand(command)) {
        commands.push(command);
      }
    }

    return [...new Set(commands)];
  }

  private extractUsedFixtures(content: string): string[] {
    const fixtures: string[] = [];
    const fixturePattern = /cy\.fixture\(['"`]([^'"`]+)['"`]\)/g;

    let match;
    while ((match = fixturePattern.exec(content)) !== null) {
      fixtures.push(match[1]);
    }

    return fixtures;
  }

  private extractUsedPages(content: string): string[] {
    const pages: string[] = [];
    const pagePattern = /new\s+(\w+Page)\(/g;

    let match;
    while ((match = pagePattern.exec(content)) !== null) {
      pages.push(match[1]);
    }

    return pages;
  }

  private extractCustomCommands(content: string, filePath: string): CypressCustomCommand[] {
    const commands: CypressCustomCommand[] = [];
    const commandPattern = /Cypress\.Commands\.add\s*\(\s*['"`](\w+)['"`]\s*,\s*\(([^)]*)\)\s*=>/g;

    let match;
    while ((match = commandPattern.exec(content)) !== null) {
      const name = match[1];
      const params = match[2];

      commands.push({
        name,
        filePath,
        parameters: this.parseParameters(params),
        implementation: '',
        chainable: true
      });
    }

    return commands;
  }

  private extractPageObject(content: string, filePath: string): CypressPageObject | null {
    const classMatch = content.match(/class\s+(\w+)/);
    if (!classMatch) return null;

    const className = classMatch[1];

    return {
      name: className,
      filePath,
      elements: this.extractPageElements(content),
      methods: this.extractPageMethods(content)
    };
  }

  private extractPageElements(content: string): Array<{ name: string; selector: string }> {
    const elements: Array<{ name: string; selector: string }> = [];
    const elementPattern = /(\w+)\s*=\s*['"`]([^'"`]+)['"`]/g;

    let match;
    while ((match = elementPattern.exec(content)) !== null) {
      if (match[2].includes('#') || match[2].includes('.') || match[2].includes('[')) {
        elements.push({
          name: match[1],
          selector: match[2]
        });
      }
    }

    return elements;
  }

  private extractPageMethods(content: string): Array<{ name: string; parameters: any[] }> {
    const methods: Array<{ name: string; parameters: any[] }> = [];
    const methodPattern = /(\w+)\s*\(([^)]*)\)\s*{/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const name = match[1];
      const params = match[2];

      if (name !== 'constructor') {
        methods.push({
          name,
          parameters: this.parseParameters(params)
        });
      }
    }

    return methods;
  }

  private extractFixture(content: string, filePath: string): CypressFixture | null {
    const fixtureName = path.basename(filePath, path.extname(filePath));

    try {
      let data: Record<string, any> = {};
      if (filePath.endsWith('.json')) {
        data = JSON.parse(content);
      }

      return {
        name: fixtureName,
        filePath,
        data,
        used: []
      };
    } catch {
      return null;
    }
  }

  private parseParameters(paramString: string): Array<{ name: string; type: string }> {
    if (!paramString.trim()) return [];

    return paramString.split(',').map(param => {
      const trimmed = param.trim();
      const colonIndex = trimmed.indexOf(':');

      if (colonIndex > -1) {
        return {
          name: trimmed.substring(0, colonIndex).trim(),
          type: trimmed.substring(colonIndex + 1).trim()
        };
      }

      return {
        name: trimmed,
        type: 'any'
      };
    });
  }

  private isCustomCommand(command: string): boolean {
    const builtInCommands = [
      'visit', 'get', 'contains', 'click', 'type', 'should', 'wait',
      'fixture', 'intercept', 'request', 'viewport', 'screenshot',
      'reload', 'go', 'url', 'title', 'window', 'document'
    ];

    return !builtInCommands.includes(command);
  }

  private extractAssertion(content: string, command: string): string | undefined {
    const assertionMatch = content.match(new RegExp(`cy\\.${command}\\([^)]*\\)\\.should\\(['"\`]([^'"\`]+)['"\`]\\)`));
    return assertionMatch ? assertionMatch[1] : undefined;
  }

  private countTests(spec: CypressSpec): number {
    let count = 0;
    spec.describes.forEach(describe => {
      count += describe.tests.length;
      count += this.countNestedTests(describe);
    });
    return count;
  }

  private countNestedTests(describe: CypressDescribe): number {
    let count = 0;
    describe.nested.forEach(nested => {
      count += nested.tests.length;
      count += this.countNestedTests(nested);
    });
    return count;
  }

  private async detectCypressVersion(projectPath: string): Promise<string> {
    try {
      const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return deps.cypress || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private buildCypressRelationships(
    specs: CypressSpec[],
    customCommands: CypressCustomCommand[],
    pageObjects: CypressPageObject[],
    fixtures: CypressFixture[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    specs.forEach(spec => {
      const specId = this.generateId('spec', spec.filePath, spec.name);

      spec.customCommands.forEach(commandName => {
        const command = customCommands.find(c => c.name === commandName);
        if (command) {
          const commandId = this.generateId('command', command.filePath, command.name);
          edges.push(this.createEdge(
            this.generateEdgeId(specId, commandId, 'uses'),
            specId,
            commandId,
            'uses',
            'behavioral',
            { command_name: commandName }
          ));
        }
      });

      spec.pages.forEach(pageName => {
        const pageObject = pageObjects.find(p => p.name === pageName);
        if (pageObject) {
          const pageId = this.generateId('page', pageObject.filePath, pageObject.name);
          edges.push(this.createEdge(
            this.generateEdgeId(specId, pageId, 'uses'),
            specId,
            pageId,
            'uses',
            'structural',
            { page_name: pageName }
          ));
        }
      });

      spec.fixtures.forEach(fixtureName => {
        const fixture = fixtures.find(f => f.name === fixtureName);
        if (fixture) {
          const fixtureId = this.generateId('fixture', fixture.filePath, fixture.name);
          edges.push(this.createEdge(
            this.generateEdgeId(specId, fixtureId, 'uses'),
            specId,
            fixtureId,
            'uses',
            'data',
            { fixture_name: fixtureName }
          ));
        }
      });
    });
  }

  private identifyTestTargets(
    specs: CypressSpec[],
    configuration: CypressConfiguration | null,
    exitPoints: CASExitPoint[]
  ): void {
    if (configuration?.baseUrl || specs.some(s => s.name.includes('e2e'))) {
      exitPoints.push(this.createExitPoint(
        'exit_cypress_application',
        'cypress-config',
        'api',
        'Target Application',
        'Application under test for E2E testing',
        {
          service_id: 'target-application',
          endpoint: configuration?.baseUrl || 'http://localhost'
        },
        {
          action: 'read',
          async: false
        },
        {
          base_url: configuration?.baseUrl,
          specs_count: specs.length
        }
      ));
    }
  }
}
