// Go Base Analyzer - Production-ready Go analyzer
// Phase 2: Language Base Analyzers

import { BaseAnalyzer, LanguageDetection, ComponentDiscovery, FrameworkDetection } from '../base-analyzer';
import { ComponentNode, ComponentType, Connection, RiskArea, CallGraph, DatabaseConnection, TestCoverage, APIEndpoint } from '../../types';
import { telemetry } from '../../telemetry/telemetry-schema';
import { AnalyzerError } from '../errors';
import * as path from 'path';
import * as fs from 'fs-extra';

export class GoAnalyzer extends BaseAnalyzer {
  private goVersion: string = '';
  private hasGoMod: boolean = false;
  
  getAnalyzerName(): string {
    return 'Go Analyzer';
  }

  getSupportedLanguages(): string[] {
    return ['go'];
  }

  getSupportedFrameworks(): string[] {
    return ['gin', 'echo', 'fiber', 'beego', 'gorilla-mux', 'chi', 'iris', 'revel', 'buffalo', 'grpc', 'cobra', 'testify', 'gorm', 'sqlx'];
  }

  protected async detectLanguageAndFramework(): Promise<LanguageDetection> {
    const span = telemetry.createSpan('go-analyzer.detectLanguageAndFramework');
    let confidence = 0;
    const frameworks: FrameworkDetection[] = [];
    const files: string[] = [];

    try {
      const goFiles = await this.findFiles(['**/*.go'], this.options.excludePatterns);
      files.push(...goFiles);
      
      if (goFiles.length > 0) confidence += 0.5;

      // Check for Go-specific files
      const goSpecificFiles = ['go.mod', 'go.sum', 'main.go', 'Makefile'];
      for (const file of goSpecificFiles) {
        const filePath = path.join(this.projectPath, file);
        if (await fs.pathExists(filePath)) {
          confidence += 0.1;
          files.push(filePath);
          if (file === 'go.mod') this.hasGoMod = true;
        }
      }

      // Analyze go.mod for dependencies
      if (this.hasGoMod) {
        const modFrameworks = await this.analyzeGoMod();
        frameworks.push(...modFrameworks);
      }

      // Analyze source files for framework patterns
      if (goFiles.length > 0) {
        const codeFrameworks = await this.analyzeCodeForFrameworks(goFiles.slice(0, 15));
        frameworks.push(...codeFrameworks);
      }

      confidence = Math.min(confidence, 1.0);
      
      telemetry.emit({
        type: 'analysis_started',
        source: { analyzer: this.getAnalyzerName() },
        data: { language: 'go', confidence, filesCount: files.length, frameworksFound: frameworks.length, hasGoMod: this.hasGoMod }
      });

      span.end();
      return { language: 'go', confidence, frameworks: frameworks.sort((a, b) => b.confidence - a.confidence), files };
    } catch (error) {
      span.end();
      throw new AnalyzerError(`Go language detection failed: ${(error as Error).message}`, 'DETECTION_ERROR', { error });
    }
  }

  protected async discoverComponents(): Promise<ComponentDiscovery> {
    const span = telemetry.createSpan('go-analyzer.discoverComponents');
    const components: ComponentNode[] = [];
    let totalFiles = 0, analyzedFiles = 0, skippedFiles = 0;

    try {
      const sourceFiles = await this.findFiles(['**/*.go'], [...(this.options.excludePatterns || []), 'vendor/**']);
      totalFiles = sourceFiles.length;
      console.log(`🐹 Analyzing ${totalFiles} Go files...`);

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

        if ((analyzedFiles + skippedFiles) % 50 === 0) {
          const progress = ((analyzedFiles + skippedFiles) / totalFiles) * 100;
          console.log(`📊 Progress: ${progress.toFixed(1)}% (${analyzedFiles + skippedFiles}/${totalFiles})`);
        }
      }

      console.log(`✅ Go analysis complete: ${analyzedFiles} analyzed, ${skippedFiles} skipped`);
      span.end();
      return { totalFiles, analyzedFiles, skippedFiles, components };
    } catch (error) {
      span.end();
      throw new AnalyzerError(`Go component discovery failed: ${(error as Error).message}`, 'DISCOVERY_ERROR', { error });
    }
  }

  protected async analyzeConnections(components: ComponentNode[]): Promise<Connection[]> {
    const span = telemetry.createSpan('go-analyzer.analyzeConnections');
    const connections: Connection[] = [];

    try {
      console.log(`🔗 Analyzing Go connections between ${components.length} components...`);
      
      for (const component of components) {
        for (const importPath of component.metadata.imports) {
          const targetComponent = this.findComponentByImportPath(components, importPath);
          if (targetComponent && targetComponent.id !== component.id) {
            connections.push({
              from: component.id,
              to: targetComponent.id,
              type: 'import',
              weight: 1,
              metadata: { callSites: 1, dataFlow: 'import' }
            });
          }
        }
      }

      const connectionMap = new Map<string, Connection>();
      for (const conn of connections) {
        const key = `${conn.from}-${conn.to}-${conn.type}`;
        const existing = connectionMap.get(key);
        if (existing) {
          existing.weight += conn.weight;
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
      throw new AnalyzerError(`Go connection analysis failed: ${(error as Error).message}`, 'CONNECTION_ERROR', { error });
    }
  }

  protected async assessRisks(components: ComponentNode[], connections: Connection[]): Promise<RiskArea[]> {
    const risks: RiskArea[] = [];
    for (const component of components) {
      const reasons: string[] = [];
      let riskLevel: 'low' | 'medium' | 'high' = 'low';

      if (component.metadata.complexity >= 8) {
        reasons.push(`High complexity (${component.metadata.complexity})`);
        riskLevel = 'high';
      }
      if (component.metadata.lineCount > 1000) {
        reasons.push(`Large file (${component.metadata.lineCount} lines)`);
        riskLevel = 'high';
      }
      
      const incomingConnections = connections.filter(c => c.to === component.id).length;
      if (incomingConnections > 8) {
        reasons.push(`High coupling (${incomingConnections} dependents)`);
        riskLevel = 'high';
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
      id: comp.id, name: comp.name, type: 'module' as const, file: comp.path,
      complexity: comp.metadata.complexity, fanIn: comp.dependents.length,
      fanOut: comp.dependencies.length, depth: 0,
      critical: comp.metadata.complexity >= 7 || comp.dependents.length > 6
    }));

    const edges = components.flatMap(comp => 
      comp.dependencies.map(dep => ({ from: comp.id, to: dep, count: 1, type: 'direct' as const, async: false, conditional: false }))
    );

    return { nodes, edges, entryPoints: components.filter(c => c.metadata.isEntry).map(c => c.id), cycles: [], layers: [], hotPaths: [], deadCode: [] };
  }

  protected async analyzeDatabaseConnections(components: ComponentNode[]): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    const dbPatterns = [
      { type: 'postgresql', patterns: ['pq', 'pgx', 'postgres'] },
      { type: 'mysql', patterns: ['mysql', 'go-sql-driver'] },
      { type: 'redis', patterns: ['redis', 'go-redis'] },
      { type: 'mongodb', patterns: ['mongo-go-driver', 'mgo'] }
    ];

    for (const component of components) {
      for (const pattern of dbPatterns) {
        const hasPattern = pattern.patterns.some(p => component.metadata.imports.some(imp => imp.includes(p)));
        if (hasPattern) {
          connections.push({
            id: `db_${pattern.type}_${component.id}`, name: `${pattern.type} connection`,
            type: pattern.type as any, componentIds: [component.id],
            usage: [{ componentId: component.id, operations: [], frequency: 1, critical: false }]
          });
        }
      }
    }
    return connections;
  }

  protected async analyzeTestCoverage(components: ComponentNode[]): Promise<TestCoverage | null> {
    const testFiles = components.filter(c => this.isTestFile(c.path));
    const sourceFiles = components.filter(c => !this.isTestFile(c.path));
    
    if (testFiles.length === 0) return null;

    const totalLines = sourceFiles.reduce((sum, c) => sum + c.metadata.lineCount, 0);
    const estimatedCoveredLines = Math.min(testFiles.length * 30, totalLines * 0.6);

    return {
      overall: totalLines > 0 ? (estimatedCoveredLines / totalLines) * 100 : 0,
      lines: { covered: estimatedCoveredLines, total: totalLines, percentage: totalLines > 0 ? (estimatedCoveredLines / totalLines) * 100 : 0 },
      branches: { covered: 0, total: 0, percentage: 0 }, functions: { covered: 0, total: 0, percentage: 0 },
      statements: { covered: 0, total: 0, percentage: 0 }, byComponent: {}, byType: { unit: testFiles.length, integration: 0, e2e: 0 },
      uncoveredFiles: sourceFiles.filter(c => !this.hasCorrespondingTest(c, testFiles)).map(c => c.path)
    };
  }

  // Helper methods
  private async analyzeFile(filePath: string): Promise<ComponentNode | null> {
    try {
      const content = await this.readFile(filePath);
      const relativePath = path.relative(this.projectPath, filePath);
      
      if (content.length === 0) return null;

      return {
        id: this.generateComponentId(filePath), name: path.basename(filePath, path.extname(filePath)),
        type: this.determineComponentType(filePath, content), path: relativePath,
        dependencies: [], dependents: [],
        metadata: {
          lineCount: content.split('\n').length, complexity: this.calculateComplexity(content),
          lastModified: (await fs.stat(filePath)).mtime, exports: this.extractExports(content),
          imports: this.extractImports(content), layer: this.determineArchitecturalLayer(filePath, content),
          responsibilities: this.extractResponsibilities(filePath, content), functions: await this.extractFunctions(content, 'go'),
          testCoverage: this.isTestFile(filePath) ? 100 : undefined, isEntry: this.isEntryPoint(filePath, content),
          httpMethods: this.extractHttpMethods(content), dbQueries: this.extractDatabaseQueries(content),
          externalCalls: this.extractExternalCalls(content)
        }
      };
    } catch (error) {
      throw new AnalyzerError(`Failed to analyze Go file ${filePath}: ${(error as Error).message}`, 'FILE_ANALYSIS_ERROR', { filePath, error });
    }
  }

  private determineComponentType(filePath: string, content: string): ComponentType {
    const fileName = path.basename(filePath).toLowerCase();
    if (this.isTestFile(filePath)) return 'utility';
    if (content.includes('func main(') || fileName === 'main.go') return 'route';
    if (content.includes('http.Handler') || content.includes('.GET(') || content.includes('.POST(')) return 'route';
    if (fileName.includes('service') || fileName.includes('handler')) return 'service';
    if (fileName.includes('model') || fileName.includes('entity')) return 'model';
    if (fileName.includes('repository') || fileName.includes('dao')) return 'database';
    return 'utility';
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const importBlocks = content.match(/import\s+\([\s\S]*?\)/g) || [];
    const singleImports = content.match(/import\s+"([^"]+)"/g) || [];

    for (const block of importBlocks) {
      const lines = block.split('\n');
      for (const line of lines) {
        const match = line.match(/"([^"]+)"/);
        if (match) imports.push(match[1].split('/').pop() || match[1]);
      }
    }

    for (const single of singleImports) {
      const match = single.match(/"([^"]+)"/);
      if (match) imports.push(match[1].split('/').pop() || match[1]);
    }

    return [...new Set(imports)];
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    const publicFunctions = content.match(/func\s+([A-Z]\w*)/g);
    if (publicFunctions) exports.push(...publicFunctions.map(f => f.split(' ')[1]));
    
    const publicTypes = content.match(/type\s+([A-Z]\w*)/g);
    if (publicTypes) exports.push(...publicTypes.map(t => t.split(' ')[1]));
    
    const publicVars = content.match(/var\s+([A-Z]\w*)/g);
    if (publicVars) exports.push(...publicVars.map(v => v.split(' ')[1]));

    return [...new Set(exports)];
  }

  private extractHttpMethods(content: string): string[] {
    const methods: string[] = [];
    const ginMethods = content.match(/r\.(GET|POST|PUT|DELETE|PATCH)\(/g);
    if (ginMethods) methods.push(...ginMethods.map(m => m.match(/\.(GET|POST|PUT|DELETE|PATCH)/)?.[1] || ''));
    
    const echoMethods = content.match(/e\.(GET|POST|PUT|DELETE|PATCH)\(/g);
    if (echoMethods) methods.push(...echoMethods.map(m => m.match(/\.(GET|POST|PUT|DELETE|PATCH)/)?.[1] || ''));

    return [...new Set(methods)];
  }

  private extractDatabaseQueries(content: string): string[] {
    const queries: string[] = [];
    const sqlQueries = content.match(/`(SELECT.*?)`/gis) || content.match(/"(SELECT.*?)"/gis);
    if (sqlQueries) queries.push(...sqlQueries.map(q => q.slice(1, -1)));
    return queries;
  }

  private extractExternalCalls(content: string): string[] {
    const calls: string[] = [];
    const httpCalls = content.match(/http\.(Get|Post|Put|Delete)\s*\(\s*"([^"]+)"/g);
    if (httpCalls) calls.push(...httpCalls.map(call => call.match(/"([^"]+)"/)?.[1] || ''));
    return calls;
  }

  private determineArchitecturalLayer(filePath: string, content: string): any {
    const fileName = path.basename(filePath).toLowerCase();
    if (fileName.includes('handler') || fileName.includes('controller')) return 'presentation';
    if (fileName.includes('service')) return 'business';
    if (fileName.includes('model') || fileName.includes('repository')) return 'data';
    if (content.includes('http.Get') || content.includes('http.Post')) return 'external';
    return 'infrastructure';
  }

  private extractResponsibilities(filePath: string, content: string): string[] {
    const responsibilities: string[] = [];
    if (content.includes('func main(')) responsibilities.push('Application entry point');
    if (content.includes('http.Handler')) responsibilities.push('HTTP request handling');
    if (content.includes('sql.DB')) responsibilities.push('Database operations');
    if (this.isTestFile(filePath)) responsibilities.push('Testing');
    return responsibilities.length > 0 ? responsibilities : ['General utility'];
  }

  private isTestFile(filePath: string): boolean {
    return path.basename(filePath).endsWith('_test.go');
  }

  private isEntryPoint(filePath: string, content: string): boolean {
    return content.includes('func main(') || path.basename(filePath) === 'main.go';
  }

  private async analyzeGoMod(): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const goModPath = path.join(this.projectPath, 'go.mod');
    
    if (await fs.pathExists(goModPath)) {
      const content = await fs.readFile(goModPath, 'utf-8');
      const frameworkPatterns = {
        'gin': /github\.com\/gin-gonic\/gin/,
        'echo': /github\.com\/labstack\/echo/,
        'fiber': /github\.com\/gofiber\/fiber/,
        'gorm': /gorm\.io\/gorm/
      };

      for (const [name, pattern] of Object.entries(frameworkPatterns)) {
        if (pattern.test(content)) {
          frameworks.push({ name, confidence: 0.9, patterns: ['Found in go.mod'], configFiles: ['go.mod'], dependencies: [name] });
        }
      }
    }

    return frameworks;
  }

  private async analyzeCodeForFrameworks(files: string[]): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const indicators = new Map<string, { count: number, files: Set<string> }>();

    for (const filePath of files) {
      try {
        const content = await this.readFile(filePath);
        if (content.includes('gin.New()') || content.includes('gin.Default()')) {
          this.updateFrameworkIndicator(indicators, 'gin', filePath);
        }
        if (content.includes('echo.New()')) {
          this.updateFrameworkIndicator(indicators, 'echo', filePath);
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }

    for (const [name, info] of indicators) {
      frameworks.push({ name, confidence: Math.min(0.8, info.count * 0.15), patterns: [`Found in ${info.files.size} files`], configFiles: Array.from(info.files), dependencies: [name] });
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

  private findComponentByImportPath(components: ComponentNode[], importPath: string): ComponentNode | undefined {
    return components.find(c => c.metadata.exports.some(exp => importPath.includes(exp)));
  }

  private calculateRiskImpact(riskLevel: 'low' | 'medium' | 'high', dependentCount: number): string {
    const baseImpact = riskLevel === 'high' ? 'High' : riskLevel === 'medium' ? 'Medium' : 'Low';
    const scopeImpact = dependentCount > 8 ? 'system-wide' : dependentCount > 4 ? 'module-wide' : 'localized';
    return `${baseImpact} impact, ${scopeImpact} scope`;
  }

  private hasCorrespondingTest(component: ComponentNode, testFiles: ComponentNode[]): boolean {
    const componentName = path.basename(component.path, '.go');
    return testFiles.some(test => test.path.includes(`${componentName}_test.go`));
  }

  protected async analyzeAPIEndpoints(components: ComponentNode[]): Promise<APIEndpoint[]> {
    const endpoints: APIEndpoint[] = [];
    for (const component of components) {
      if (component.type === 'route' && component.metadata.httpMethods) {
        for (const method of component.metadata.httpMethods) {
          endpoints.push({
            id: `${component.id}_${method}`, method: method as any, path: `/${component.name}`,
            description: `${method} endpoint`, parameters: [], requestSchema: null, responseSchema: null,
            statusCodes: [{ code: 200, description: 'Success', schema: null }], middleware: [],
            authentication: { type: 'none', required: false }, componentId: component.id, handler: component.name
          });
        }
      }
    }
    return endpoints;
  }
}