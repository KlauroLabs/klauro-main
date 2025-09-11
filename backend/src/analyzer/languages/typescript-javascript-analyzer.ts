// TypeScript/JavaScript Base Analyzer - Comprehensive AST-based analysis
// Phase 2: Language Base Analyzers - Production-ready TypeScript/JavaScript analyzer

import { BaseAnalyzer, LanguageDetection, ComponentDiscovery, FrameworkDetection } from '../base-analyzer';
import { ComponentNode, ComponentType, Connection, RiskArea, CallGraph, DatabaseConnection, TestCoverage, APIEndpoint } from '../../types';
import { telemetry } from '../../telemetry/telemetry-schema';
import { AnalyzerError } from '../errors';
import * as path from 'path';
import * as fs from 'fs-extra';

export class TypeScriptJavaScriptAnalyzer extends BaseAnalyzer {
  private isTypeScriptProject: boolean = false;
  private packageManager: 'npm' | 'yarn' | 'pnpm' = 'npm';
  
  getAnalyzerName(): string {
    return 'TypeScript/JavaScript Analyzer';
  }

  getSupportedLanguages(): string[] {
    return ['typescript', 'javascript'];
  }

  getSupportedFrameworks(): string[] {
    return [
      'react', 'vue', 'angular', 'svelte', 'next', 'nuxt', 'gatsby',
      'express', 'fastify', 'koa', 'hapi', 'nestjs', 'meteor',
      'electron', 'react-native', 'ionic', 'cordova',
      'jest', 'mocha', 'jasmine', 'cypress', 'playwright',
      'webpack', 'vite', 'rollup', 'parcel', 'gulp', 'grunt',
      'tailwindcss', 'styled-components', 'emotion', 'material-ui',
      'redux', 'mobx', 'zustand', 'recoil', 'apollo', 'relay'
    ];
  }

  protected async detectLanguageAndFramework(): Promise<LanguageDetection> {
    const span = telemetry.createSpan('typescript-javascript-analyzer.detectLanguageAndFramework');
    let confidence = 0;
    const frameworks: FrameworkDetection[] = [];
    const files: string[] = [];

    try {
      // Check for JavaScript/TypeScript files
      const jsFiles = await this.findFiles(['**/*.{js,jsx,mjs,cjs}'], this.options.excludePatterns);
      const tsFiles = await this.findFiles(['**/*.{ts,tsx}'], this.options.excludePatterns);
      
      files.push(...jsFiles, ...tsFiles);
      
      if (jsFiles.length > 0 || tsFiles.length > 0) {
        confidence += 0.4;
      }

      // Determine if it's primarily TypeScript
      this.isTypeScriptProject = tsFiles.length > 0;
      if (this.isTypeScriptProject && tsFiles.length > jsFiles.length) {
        confidence += 0.1;
      }

      // Check for Node.js/JavaScript specific files
      const jsSpecificFiles = [
        'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
        'tsconfig.json', 'jsconfig.json', 'webpack.config.js', 'vite.config.js',
        'next.config.js', 'nuxt.config.js', 'vue.config.js', 'angular.json',
        'jest.config.js', 'babel.config.js', '.eslintrc.js', '.prettierrc.js'
      ];

      for (const file of jsSpecificFiles) {
        const filePath = path.join(this.projectPath, file);
        if (await fs.pathExists(filePath)) {
          confidence += 0.05;
          files.push(filePath);
        }
      }

      // Detect package manager
      await this.detectPackageManager();

      // Analyze package.json for frameworks
      const packageFrameworks = await this.analyzePackageJson();
      frameworks.push(...packageFrameworks);

      // Analyze source files for framework patterns
      if (files.length > 0) {
        const sampleFiles = [...jsFiles, ...tsFiles].slice(0, 30);
        const codeFrameworks = await this.analyzeCodeForFrameworks(sampleFiles);
        frameworks.push(...codeFrameworks);
      }

      // Detect package manager
      await this.detectPackageManager();

      confidence = Math.min(confidence, 1.0);
      
      telemetry.emit({
        type: 'analysis_started',
        source: { analyzer: this.getAnalyzerName() },
        data: {
          language: this.isTypeScriptProject ? 'typescript' : 'javascript',
          confidence,
          filesCount: files.length,
          frameworksFound: frameworks.length,
          isTypeScript: this.isTypeScriptProject,
          packageManager: this.packageManager
        }
      });

      span.end();
      return {
        language: this.isTypeScriptProject ? 'typescript' : 'javascript',
        confidence,
        frameworks: frameworks.sort((a, b) => b.confidence - a.confidence),
        files
      };
    } catch (error) {
      span.end();
      throw new AnalyzerError(
        `TypeScript/JavaScript language detection failed: ${(error as Error).message}`,
        'DETECTION_ERROR',
        { error }
      );
    }
  }

  protected async discoverComponents(): Promise<ComponentDiscovery> {
    const span = telemetry.createSpan('typescript-javascript-analyzer.discoverComponents');
    const components: ComponentNode[] = [];
    let totalFiles = 0;
    let analyzedFiles = 0;
    let skippedFiles = 0;

    try {
      const sourceFiles = await this.findFiles(
        ['**/*.{js,jsx,ts,tsx,mjs,cjs}'], 
        [...(this.options.excludePatterns || []), 'node_modules/**', 'dist/**', 'build/**']
      );
      
      totalFiles = sourceFiles.length;

      console.log(`⚡ Analyzing ${totalFiles} TypeScript/JavaScript files...`);

      for (const filePath of sourceFiles) {
        try {
          const component = await this.analyzeFile(filePath);
          if (component) {
            components.push(component);
            analyzedFiles++;
          } else {
            skippedFiles++;
          }
        } catch (error) {
          console.warn(`⚠️ Failed to analyze ${filePath}: ${(error as Error).message}`);
          skippedFiles++;
        }

        // Progress reporting
        if ((analyzedFiles + skippedFiles) % 50 === 0) {
          const progress = ((analyzedFiles + skippedFiles) / totalFiles) * 100;
          console.log(`📊 Progress: ${progress.toFixed(1)}% (${analyzedFiles + skippedFiles}/${totalFiles})`);
        }
      }

      console.log(`✅ TypeScript/JavaScript analysis complete: ${analyzedFiles} analyzed, ${skippedFiles} skipped`);

      span.end();
      return {
        totalFiles,
        analyzedFiles,
        skippedFiles,
        components
      };
    } catch (error) {
      span.end();
      throw new AnalyzerError(
        `TypeScript/JavaScript component discovery failed: ${(error as Error).message}`,
        'DISCOVERY_ERROR',
        { error }
      );
    }
  }

  protected async analyzeConnections(components: ComponentNode[]): Promise<Connection[]> {
    const span = telemetry.createSpan('typescript-javascript-analyzer.analyzeConnections');
    const connections: Connection[] = [];

    try {
      console.log(`🔗 Analyzing TypeScript/JavaScript connections between ${components.length} components...`);

      for (const component of components) {
        // Analyze ES6 imports and CommonJS requires
        for (const importPath of component.metadata.imports) {
          const targetComponent = this.findComponentByImportPath(components, importPath, component.path);
          if (targetComponent && targetComponent.id !== component.id) {
            connections.push({
              from: component.id,
              to: targetComponent.id,
              type: 'import',
              weight: 1,
              metadata: {
                callSites: 1,
                dataFlow: this.getImportType(importPath)
              }
            });
          }
        }

        // Analyze function calls within the component
        if (component.metadata.functions) {
          for (const func of component.metadata.functions) {
            for (const call of func.calls) {
              const targetComponent = this.findComponentByFunctionCall(components, call.target);
              if (targetComponent && targetComponent.id !== component.id) {
                connections.push({
                  from: component.id,
                  to: targetComponent.id,
                  type: 'function_call',
                  weight: call.count,
                  metadata: {
                    callSites: call.count,
                    dataFlow: `${func.name} -> ${call.target}`
                  }
                });
              }
            }
          }
        }

        // Analyze HTTP endpoints for API connections
        if (component.metadata.httpMethods) {
          for (const method of component.metadata.httpMethods) {
            connections.push({
              from: component.id,
              to: 'external_http',
              type: 'http_call',
              weight: 1,
              metadata: {
                callSites: 1,
                httpMethod: method
              }
            });
          }
        }
      }

      // Remove duplicates and aggregate weights
      const connectionMap = new Map<string, Connection>();
      for (const conn of connections) {
        const key = `${conn.from}-${conn.to}-${conn.type}`;
        const existing = connectionMap.get(key);
        if (existing) {
          existing.weight += conn.weight;
          existing.metadata!.callSites! += conn.metadata?.callSites || 0;
        } else {
          connectionMap.set(key, conn);
        }
      }

      const uniqueConnections = Array.from(connectionMap.values());
      console.log(`🔗 Found ${uniqueConnections.length} unique connections`);

      span.end();
      return uniqueConnections;
    } catch (error) {
      span.end();
      throw new AnalyzerError(
        `TypeScript/JavaScript connection analysis failed: ${(error as Error).message}`,
        'CONNECTION_ERROR',
        { error }
      );
    }
  }

  protected async assessRisks(components: ComponentNode[], connections: Connection[]): Promise<RiskArea[]> {
    const risks: RiskArea[] = [];

    for (const component of components) {
      const reasons: string[] = [];
      let riskLevel: 'low' | 'medium' | 'high' = 'low';

      // High complexity
      if (component.metadata.complexity >= 8) {
        reasons.push(`High complexity (${component.metadata.complexity})`);
        riskLevel = 'high';
      } else if (component.metadata.complexity >= 5) {
        reasons.push(`Medium complexity (${component.metadata.complexity})`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // Large files
      if (component.metadata.lineCount > 800) {
        reasons.push(`Large file (${component.metadata.lineCount} lines)`);
        riskLevel = 'high';
      } else if (component.metadata.lineCount > 400) {
        reasons.push(`Large file (${component.metadata.lineCount} lines)`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // High fan-in (many dependents)
      const incomingConnections = connections.filter(c => c.to === component.id).length;
      if (incomingConnections > 15) {
        reasons.push(`High fan-in (${incomingConnections} dependents)`);
        riskLevel = 'high';
      } else if (incomingConnections > 8) {
        reasons.push(`High fan-in (${incomingConnections} dependents)`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // Async operations without error handling
      if (this.hasAsyncOperationsWithoutHandling(component)) {
        reasons.push('Async operations without proper error handling');
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // External API calls
      if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) {
        reasons.push(`External API calls (${component.metadata.externalCalls.length})`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // TypeScript specific risks
      if (this.isTypeScriptProject && this.hasTypeScriptRisks(component)) {
        reasons.push('TypeScript type safety concerns');
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      if (reasons.length > 0) {
        risks.push({
          componentId: component.id,
          riskLevel,
          reasons,
          impact: this.calculateRiskImpact(riskLevel, incomingConnections)
        });
      }
    }

    return risks;
  }

  protected async generateCallGraph(components: ComponentNode[]): Promise<CallGraph> {
    const nodes = components.map(comp => ({
      id: comp.id,
      name: comp.name,
      type: this.getCallGraphNodeType(comp.type),
      file: comp.path,
      complexity: comp.metadata.complexity,
      fanIn: comp.dependents.length,
      fanOut: comp.dependencies.length,
      depth: 0, // Will be calculated
      critical: comp.metadata.complexity >= 7 || comp.dependents.length > 10
    }));

    const edges = components.flatMap(comp => 
      comp.dependencies.map(dep => ({
        from: comp.id,
        to: dep,
        count: 1,
        type: 'direct' as const,
        async: this.hasAsyncCalls(comp),
        conditional: false
      }))
    );

    return {
      nodes,
      edges,
      entryPoints: components.filter(c => c.metadata.isEntry).map(c => c.id),
      cycles: [], // TODO: Implement cycle detection
      layers: [], // TODO: Implement layer analysis
      hotPaths: [],
      deadCode: components.filter(c => c.dependents.length === 0 && !c.metadata.isEntry).map(c => c.id)
    };
  }

  protected async analyzeDatabaseConnections(components: ComponentNode[]): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    const dbPatterns = [
      { type: 'mongodb', patterns: ['mongodb', 'mongoose', 'MongoClient'] },
      { type: 'postgresql', patterns: ['pg', 'postgres', 'Sequelize', 'TypeORM', 'Prisma'] },
      { type: 'mysql', patterns: ['mysql2', 'mysql', 'Sequelize'] },
      { type: 'redis', patterns: ['redis', 'ioredis', 'connect-redis'] },
      { type: 'sqlite', patterns: ['sqlite3', 'better-sqlite3'] }
    ];

    for (const component of components) {
      const componentConnections: DatabaseConnection[] = [];
      
      for (const pattern of dbPatterns) {
        const hasPattern = pattern.patterns.some(p => 
          component.metadata.imports.some(imp => imp.toLowerCase().includes(p.toLowerCase())) ||
          (component.metadata.dbQueries && component.metadata.dbQueries.some(query => 
            query.toLowerCase().includes(p.toLowerCase())
          ))
        );

        if (hasPattern) {
          componentConnections.push({
            id: `db_${pattern.type}_${component.id}`,
            name: `${pattern.type} connection`,
            type: pattern.type as any,
            componentIds: [component.id],
            usage: [{
              componentId: component.id,
              operations: this.extractDbOperations(component),
              frequency: component.metadata.dbQueries?.length || 1,
              critical: component.metadata.complexity >= 6
            }]
          });
        }
      }
      
      connections.push(...componentConnections);
    }

    return connections;
  }

  protected async analyzeTestCoverage(components: ComponentNode[]): Promise<TestCoverage | null> {
    const testFiles = components.filter(c => this.isTestFile(c.path));
    const sourceFiles = components.filter(c => !this.isTestFile(c.path));
    
    if (testFiles.length === 0) {
      return null;
    }

    const totalLines = sourceFiles.reduce((sum, c) => sum + c.metadata.lineCount, 0);
    const estimatedCoveredLines = Math.min(testFiles.length * 30, totalLines * 0.75);

    return {
      overall: totalLines > 0 ? (estimatedCoveredLines / totalLines) * 100 : 0,
      lines: {
        covered: estimatedCoveredLines,
        total: totalLines,
        percentage: totalLines > 0 ? (estimatedCoveredLines / totalLines) * 100 : 0
      },
      branches: { covered: 0, total: 0, percentage: 0 },
      functions: { covered: 0, total: 0, percentage: 0 },
      statements: { covered: 0, total: 0, percentage: 0 },
      byComponent: {},
      byType: {
        unit: testFiles.filter(f => f.path.includes('.test.') || f.path.includes('.spec.')).length,
        integration: testFiles.filter(f => f.path.includes('integration')).length,
        e2e: testFiles.filter(f => f.path.includes('e2e') || f.path.includes('cypress')).length
      },
      uncoveredFiles: sourceFiles.filter(c => !this.hasCorrespondingTest(c, testFiles)).map(c => c.path)
    };
  }

  // Private helper methods
  private async analyzeFile(filePath: string): Promise<ComponentNode | null> {
    try {
      const content = await this.readFile(filePath);
      const relativePath = path.relative(this.projectPath, filePath);
      
      // Skip empty files, very large files, or generated files
      if (content.length === 0 || 
          content.length > (this.options.maxFileSize || 1024 * 1024) ||
          this.isGeneratedFile(content)) {
        return null;
      }

      const component: ComponentNode = {
        id: this.generateComponentId(filePath),
        name: path.basename(filePath, path.extname(filePath)),
        type: this.determineComponentType(filePath, content),
        path: relativePath,
        dependencies: [],
        dependents: [],
        metadata: {
          lineCount: content.split('\n').length,
          complexity: this.calculateComplexity(content),
          lastModified: (await fs.stat(filePath)).mtime,
          exports: this.extractExports(content),
          imports: this.extractImports(content),
          layer: this.determineArchitecturalLayer(filePath, content),
          responsibilities: this.extractResponsibilities(filePath, content),
          functions: await this.extractFunctions(content, this.isTypeScriptProject ? 'typescript' : 'javascript'),
          testCoverage: this.isTestFile(filePath) ? 100 : undefined,
          isEntry: this.isEntryPoint(filePath, content),
          httpMethods: this.extractHttpMethods(content),
          dbQueries: this.extractDatabaseQueries(content),
          externalCalls: this.extractExternalCalls(content)
        }
      };

      return component;
    } catch (error) {
      throw new AnalyzerError(
        `Failed to analyze TypeScript/JavaScript file ${filePath}: ${(error as Error).message}`,
        'FILE_ANALYSIS_ERROR',
        { filePath, error }
      );
    }
  }

  private determineComponentType(filePath: string, content: string): ComponentType {
    const fileName = path.basename(filePath).toLowerCase();
    const fileExtension = path.extname(filePath).toLowerCase();
    
    // Test files
    if (this.isTestFile(filePath)) {
      return 'utility';
    }
    
    // React components
    if ((fileExtension === '.jsx' || fileExtension === '.tsx') ||
        content.includes('import React') ||
        content.includes('from "react"') ||
        content.includes('export default function') && content.includes('return (')) {
      return 'controller'; // UI Controller
    }
    
    // Vue components
    if (fileExtension === '.vue' || content.includes('<template>')) {
      return 'controller';
    }
    
    // Angular components
    if (content.includes('@Component') || content.includes('angular')) {
      return 'controller';
    }
    
    // Express/API routes
    if (content.includes('app.get') || content.includes('app.post') || 
        content.includes('router.') || content.includes('@Get(') || 
        content.includes('@Post(')) {
      return 'route';
    }
    
    // Model/Entity files
    if (fileName.includes('model') || fileName.includes('entity') ||
        content.includes('@Entity') || content.includes('Schema') ||
        fileName.includes('.model.')) {
      return 'model';
    }
    
    // Service files
    if (fileName.includes('service') || content.includes('@Injectable') ||
        fileName.includes('.service.')) {
      return 'service';
    }
    
    // Middleware
    if (fileName.includes('middleware') || content.includes('next()') ||
        content.includes('req, res, next')) {
      return 'middleware';
    }
    
    // Configuration files
    if (fileName.includes('config') || fileName.includes('settings') ||
        fileName.startsWith('.') && fileName.includes('rc')) {
      return 'config';
    }
    
    // Database related
    if (content.includes('CREATE TABLE') || content.includes('mongoose.model') ||
        content.includes('Sequelize')) {
      return 'database';
    }

    return 'utility';
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    
    // ES6 imports
    const es6ImportRegex = /import\s+(?:[\w*\s{},]*\s+from\s+)?['"](.*?)['"]/gm;
    let match;
    while ((match = es6ImportRegex.exec(content)) !== null) {
      if (match[1] && !match[1].startsWith('.')) {
        imports.push(match[1].split('/')[0]);
      }
    }
    
    // CommonJS require
    const requireRegex = /require\(['"](.*?)['"]\)/gm;
    while ((match = requireRegex.exec(content)) !== null) {
      if (match[1] && !match[1].startsWith('.')) {
        imports.push(match[1].split('/')[0]);
      }
    }
    
    // Dynamic imports
    const dynamicImportRegex = /import\(['"](.*?)['"]\)/gm;
    while ((match = dynamicImportRegex.exec(content)) !== null) {
      if (match[1] && !match[1].startsWith('.')) {
        imports.push(match[1].split('/')[0]);
      }
    }

    return [...new Set(imports)];
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    
    // Named exports
    const namedExportRegex = /export\s+(?:const|let|var|function|class|interface|type)\s+(\w+)/gm;
    let match;
    while ((match = namedExportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }
    
    // Export { } syntax
    const exportBraceRegex = /export\s*\{\s*(.*?)\s*\}/gm;
    while ((match = exportBraceRegex.exec(content)) !== null) {
      const exportNames = match[1].split(',').map(name => name.trim().split(' as ')[0]);
      exports.push(...exportNames);
    }
    
    // Default export function name
    const defaultExportFunctionRegex = /export\s+default\s+function\s+(\w+)/gm;
    while ((match = defaultExportFunctionRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }

    return [...new Set(exports)];
  }

  private extractHttpMethods(content: string): string[] {
    const methods: string[] = [];
    
    // Express routes
    const expressMethods = content.match(/app\.(get|post|put|delete|patch|head|options)/g);
    if (expressMethods) {
      methods.push(...expressMethods.map(method => method.split('.')[1].toUpperCase()));
    }
    
    // Router methods
    const routerMethods = content.match(/router\.(get|post|put|delete|patch|head|options)/g);
    if (routerMethods) {
      methods.push(...routerMethods.map(method => method.split('.')[1].toUpperCase()));
    }
    
    // NestJS decorators
    const nestMethods = content.match(/@(Get|Post|Put|Delete|Patch|Head|Options)/g);
    if (nestMethods) {
      methods.push(...nestMethods.map(method => method.substring(1).toUpperCase()));
    }

    return [...new Set(methods)];
  }

  private extractDatabaseQueries(content: string): string[] {
    const queries: string[] = [];
    
    // SQL strings
    const sqlPatterns = [
      /['"`](SELECT.*?)['"`]/gis,
      /['"`](INSERT.*?)['"`]/gis,
      /['"`](UPDATE.*?)['"`]/gis,
      /['"`](DELETE.*?)['"`]/gis
    ];

    for (const pattern of sqlPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        queries.push(...matches.map(match => match.slice(1, -1)));
      }
    }
    
    // ORM calls
    const ormCalls = content.match(/\.(find|findOne|findMany|create|update|delete|save)\s*\(/g);
    if (ormCalls) {
      queries.push(...ormCalls);
    }

    return queries;
  }

  private extractExternalCalls(content: string): string[] {
    const calls: string[] = [];
    
    // Fetch API
    const fetchCalls = content.match(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/g);
    if (fetchCalls) {
      calls.push(...fetchCalls.map(call => `FETCH ${call.match(/['"`]([^'"`]+)['"`]/)?.[1]}`));
    }
    
    // Axios calls
    const axiosCalls = content.match(/axios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g);
    if (axiosCalls) {
      calls.push(...axiosCalls.map(call => {
        const matches = call.match(/axios\.(\w+)\s*\(\s*['"`]([^'"`]+)['"`]/);
        return matches ? `${matches[1].toUpperCase()} ${matches[2]}` : call;
      }));
    }

    return calls;
  }

  private determineArchitecturalLayer(filePath: string, content: string): any {
    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();

    // Presentation layer
    if (fileName.includes('component') || fileName.includes('page') || 
        content.includes('JSX') || content.includes('render') ||
        dirName.includes('components') || dirName.includes('pages')) {
      return 'presentation';
    }

    // Data layer
    if (fileName.includes('model') || fileName.includes('entity') || 
        fileName.includes('schema') || content.includes('mongoose') ||
        dirName.includes('models') || dirName.includes('entities')) {
      return 'data';
    }

    // Business layer
    if (fileName.includes('service') || fileName.includes('controller') ||
        dirName.includes('services') || dirName.includes('business')) {
      return 'business';
    }

    // Infrastructure layer
    if (fileName.includes('config') || fileName.includes('util') || 
        fileName.includes('helper') || dirName.includes('utils')) {
      return 'infrastructure';
    }

    // External layer
    if (content.includes('fetch(') || content.includes('axios') || 
        content.includes('http.')) {
      return 'external';
    }

    return 'infrastructure';
  }

  private extractResponsibilities(filePath: string, content: string): string[] {
    const responsibilities: string[] = [];
    
    if (content.includes('render') || content.includes('JSX')) {
      responsibilities.push('UI rendering');
    }
    
    if (content.includes('useState') || content.includes('useEffect')) {
      responsibilities.push('State management');
    }
    
    if (content.includes('fetch(') || content.includes('axios')) {
      responsibilities.push('HTTP communication');
    }
    
    if (this.isTestFile(filePath)) {
      responsibilities.push('Testing');
    }
    
    if (content.includes('router') || content.includes('Route')) {
      responsibilities.push('Routing');
    }
    
    if (content.includes('middleware') || content.includes('next()')) {
      responsibilities.push('Request processing');
    }

    return responsibilities.length > 0 ? responsibilities : ['General utility'];
  }

  private isTestFile(filePath: string): boolean {
    const fileName = path.basename(filePath).toLowerCase();
    return fileName.includes('.test.') ||
           fileName.includes('.spec.') ||
           fileName.includes('__tests__') ||
           filePath.includes('/test/') ||
           filePath.includes('/tests/') ||
           filePath.includes('__tests__');
  }

  private isEntryPoint(filePath: string, content: string): boolean {
    const fileName = path.basename(filePath);
    
    return fileName === 'index.js' ||
           fileName === 'index.ts' ||
           fileName === 'main.js' ||
           fileName === 'main.ts' ||
           fileName === 'app.js' ||
           fileName === 'app.ts' ||
           fileName === 'server.js' ||
           fileName === 'server.ts' ||
           content.includes('app.listen') ||
           content.includes('createServer') ||
           content.includes('ReactDOM.render') ||
           content.includes('ReactDOM.createRoot');
  }

  private isGeneratedFile(content: string): boolean {
    return content.includes('// Generated by') ||
           content.includes('/* Generated by') ||
           content.includes('// This file was automatically generated') ||
           content.includes('// Auto-generated') ||
           content.includes('@generated');
  }

  private async detectPackageManager(): Promise<void> {
    if (await fs.pathExists(path.join(this.projectPath, 'pnpm-lock.yaml'))) {
      this.packageManager = 'pnpm';
    } else if (await fs.pathExists(path.join(this.projectPath, 'yarn.lock'))) {
      this.packageManager = 'yarn';
    } else {
      this.packageManager = 'npm';
    }
  }


  private async analyzePackageJson(): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJSON(packageJsonPath);
      const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      const frameworkMappings = {
        react: { confidence: 0.9, type: 'UI Framework' },
        vue: { confidence: 0.9, type: 'UI Framework' },
        angular: { confidence: 0.9, type: 'UI Framework' },
        svelte: { confidence: 0.9, type: 'UI Framework' },
        express: { confidence: 0.9, type: 'Web Server' },
        fastify: { confidence: 0.8, type: 'Web Server' },
        '@nestjs/core': { confidence: 0.9, type: 'Web Framework' },
        next: { confidence: 0.9, type: 'Full-stack Framework' },
        nuxt: { confidence: 0.9, type: 'Full-stack Framework' },
        gatsby: { confidence: 0.8, type: 'Static Site Generator' },
        jest: { confidence: 0.7, type: 'Testing Framework' },
        mocha: { confidence: 0.7, type: 'Testing Framework' },
        cypress: { confidence: 0.8, type: 'E2E Testing' }
      };

      for (const [dep, info] of Object.entries(frameworkMappings)) {
        if (allDeps[dep]) {
          frameworks.push({
            name: dep,
            version: allDeps[dep],
            confidence: info.confidence,
            patterns: [`Found in package.json`],
            configFiles: ['package.json'],
            dependencies: [dep],
            metadata: { type: info.type }
          });
        }
      }
    }

    return frameworks;
  }

  private async analyzeCodeForFrameworks(files: string[]): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const frameworkIndicators = new Map<string, { count: number, files: Set<string> }>();

    for (const filePath of files.slice(0, 20)) { // Sample first 20 files
      try {
        const content = await this.readFile(filePath);
        
        // React indicators
        if (content.includes('import React') || content.includes('JSX.Element') ||
            content.includes('useState') || content.includes('useEffect')) {
          this.updateFrameworkIndicator(frameworkIndicators, 'react', filePath);
        }
        
        // Vue indicators
        if (content.includes('Vue.') || content.includes('<template>')) {
          this.updateFrameworkIndicator(frameworkIndicators, 'vue', filePath);
        }
        
        // Express indicators
        if (content.includes('app.listen') || content.includes('express()')) {
          this.updateFrameworkIndicator(frameworkIndicators, 'express', filePath);
        }
        
        // Add more framework detection as needed
      } catch (error) {
        // Skip files that can't be read
      }
    }

    // Convert indicators to framework detections
    for (const [name, info] of frameworkIndicators) {
      frameworks.push({
        name,
        confidence: Math.min(0.8, info.count * 0.15),
        patterns: [`Found in ${info.files.size} files`],
        configFiles: Array.from(info.files),
        dependencies: [name]
      });
    }

    return frameworks;
  }

  private updateFrameworkIndicator(indicators: Map<string, { count: number, files: Set<string> }>, framework: string, filePath: string): void {
    const existing = indicators.get(framework);
    if (existing) {
      existing.count++;
      existing.files.add(filePath);
    } else {
      indicators.set(framework, { count: 1, files: new Set([filePath]) });
    }
  }

  private findComponentByImportPath(components: ComponentNode[], importPath: string, currentFile: string): ComponentNode | undefined {
    // Handle relative imports
    if (importPath.startsWith('.')) {
      const resolvedPath = path.resolve(path.dirname(currentFile), importPath);
      return components.find(c => c.path.includes(path.basename(resolvedPath)));
    }
    
    // Handle module imports
    return components.find(c => {
      const moduleName = path.basename(c.path, path.extname(c.path));
      return importPath.includes(moduleName) || c.metadata.exports.some(exp => importPath.includes(exp));
    });
  }

  private findComponentByFunctionCall(components: ComponentNode[], functionName: string): ComponentNode | undefined {
    return components.find(c => c.metadata.exports.includes(functionName));
  }

  private getImportType(importPath: string): string {
    if (importPath.startsWith('.')) return 'relative';
    if (importPath.startsWith('/')) return 'absolute';
    return 'module';
  }

  private hasAsyncOperationsWithoutHandling(component: ComponentNode): boolean {
    // This would require more sophisticated AST analysis
    // For now, we'll use simple heuristics
    if (component.metadata.functions) {
      return component.metadata.functions.some(func => 
        func.isAsync && !func.name.includes('catch') && !func.name.includes('error')
      );
    }
    return false;
  }

  private hasTypeScriptRisks(component: ComponentNode): boolean {
    // Look for 'any' types, missing return types, etc.
    // This would require AST analysis for proper implementation
    return component.path.endsWith('.ts') || component.path.endsWith('.tsx');
  }

  private getCallGraphNodeType(componentType: ComponentType): 'function' | 'method' | 'class' | 'module' {
    switch (componentType) {
      case 'route':
      case 'controller':
        return 'method';
      case 'model':
      case 'service':
        return 'class';
      default:
        return 'module';
    }
  }

  private hasAsyncCalls(component: ComponentNode): boolean {
    return component.metadata.functions?.some(f => f.isAsync) || false;
  }

  private extractDbOperations(component: ComponentNode): any[] {
    const operations: any[] = [];
    
    if (component.metadata.dbQueries) {
      for (const query of component.metadata.dbQueries) {
        operations.push({
          type: this.getQueryType(query),
          tables: [],
          complexity: 1,
          optimized: false
        });
      }
    }

    return operations;
  }

  private getQueryType(query: string): 'read' | 'write' | 'transaction' | 'batch' {
    const upperQuery = query.toUpperCase();
    if (upperQuery.includes('SELECT') || upperQuery.includes('FIND')) return 'read';
    if (upperQuery.includes('INSERT') || upperQuery.includes('UPDATE') || 
        upperQuery.includes('DELETE') || upperQuery.includes('CREATE')) return 'write';
    return 'read';
  }

  private calculateRiskImpact(riskLevel: 'low' | 'medium' | 'high', dependentCount: number): string {
    const baseImpact = riskLevel === 'high' ? 'High' : riskLevel === 'medium' ? 'Medium' : 'Low';
    const scopeImpact = dependentCount > 15 ? 'system-wide' : dependentCount > 8 ? 'module-wide' : 'localized';
    return `${baseImpact} impact, ${scopeImpact} scope`;
  }

  private hasCorrespondingTest(component: ComponentNode, testFiles: ComponentNode[]): boolean {
    const componentName = path.basename(component.path, path.extname(component.path));
    return testFiles.some(test => 
      test.path.includes(`${componentName}.test.`) || 
      test.path.includes(`${componentName}.spec.`) ||
      test.path.includes(`__tests__/${componentName}`)
    );
  }

  protected async analyzeAPIEndpoints(components: ComponentNode[]): Promise<APIEndpoint[]> {
    const endpoints: APIEndpoint[] = [];
    
    for (const component of components) {
      if (component.type === 'route' && component.metadata.httpMethods) {
        for (const method of component.metadata.httpMethods) {
          endpoints.push({
            id: `${component.id}_${method}`,
            method: method as any,
            path: this.extractRoutePath(component.path),
            description: `${method} endpoint in ${component.name}`,
            parameters: [],
            requestSchema: null,
            responseSchema: null,
            statusCodes: [{ code: 200, description: 'Success', schema: null }],
            middleware: [],
            authentication: { type: 'none', required: false },
            componentId: component.id,
            handler: component.name
          });
        }
      }
    }

    return endpoints;
  }

  private extractRoutePath(filePath: string): string {
    const relativePath = path.relative(this.projectPath, filePath);
    return `/${relativePath.replace(/\\/g, '/').replace(/\.(js|ts|jsx|tsx)$/, '')}`;
  }
}