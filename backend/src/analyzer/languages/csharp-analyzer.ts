// C# Base Analyzer - Comprehensive analysis for .NET projects
// Phase 2: Language Base Analyzers - Production-ready C# analyzer

import { BaseAnalyzer, LanguageDetection, ComponentDiscovery, FrameworkDetection } from '../base-analyzer';
import { ComponentNode, ComponentType, Connection, RiskArea, CallGraph, DatabaseConnection, TestCoverage, APIEndpoint } from '../../types';
import { telemetry } from '../../telemetry/telemetry-schema';
import { AnalyzerError } from '../errors';
import * as path from 'path';
import * as fs from 'fs-extra';

export class CSharpAnalyzer extends BaseAnalyzer {
  private dotnetVersion: string = '';
  private isWebProject: boolean = false;
  private targetFramework: string = '';
  
  getAnalyzerName(): string {
    return 'C# Analyzer';
  }

  getSupportedLanguages(): string[] {
    return ['csharp', 'fsharp', 'vb'];
  }

  getSupportedFrameworks(): string[] {
    return [
      'asp.net-core', 'asp.net-mvc', 'web-api', 'blazor', 'razor-pages',
      'entity-framework', 'entity-framework-core', 'dapper', 'nhibernate',
      'xunit', 'nunit', 'mstest', 'moq',
      'xamarin', 'maui', 'wpf', 'winforms', 'uwp',
      'signalr', 'grpc', 'wcf',
      'autofac', 'ninject', 'structuremap',
      'serilog', 'nlog', 'log4net',
      'newtonsoft.json', 'system.text.json'
    ];
  }

  protected async detectLanguageAndFramework(): Promise<LanguageDetection> {
    const span = telemetry.createSpan('csharp-analyzer.detectLanguageAndFramework');
    let confidence = 0;
    const frameworks: FrameworkDetection[] = [];
    const files: string[] = [];

    try {
      // Check for C# files
      const csharpFiles = await this.findFiles(['**/*.cs'], this.options.excludePatterns);
      const fsharpFiles = await this.findFiles(['**/*.fs', '**/*.fsx'], this.options.excludePatterns);
      const vbFiles = await this.findFiles(['**/*.vb'], this.options.excludePatterns);
      
      files.push(...csharpFiles, ...fsharpFiles, ...vbFiles);
      
      if (csharpFiles.length > 0) confidence += 0.5;
      if (fsharpFiles.length > 0) confidence += 0.3;
      if (vbFiles.length > 0) confidence += 0.2;

      // Check for .NET specific files
      const dotnetFiles = [
        '*.csproj', '*.fsproj', '*.vbproj', '*.sln',
        'global.json', 'nuget.config', 'Directory.Build.props',
        'web.config', 'app.config', 'appsettings.json',
        'Program.cs', 'Startup.cs', 'Global.asax.cs'
      ];

      for (const pattern of dotnetFiles) {
        const matchingFiles = await this.findFiles([pattern], this.options.excludePatterns);
        if (matchingFiles.length > 0) {
          confidence += 0.1;
          files.push(...matchingFiles);
        }
      }

      // Analyze project files for frameworks
      const projectFrameworks = await this.analyzeProjectFiles();
      frameworks.push(...projectFrameworks);

      // Analyze source files for framework patterns
      if (csharpFiles.length > 0) {
        const sampleFiles = csharpFiles.slice(0, 20);
        const codeFrameworks = await this.analyzeCodeForFrameworks(sampleFiles);
        frameworks.push(...codeFrameworks);
      }

      await this.detectDotNetVersion();
      this.isWebProject = frameworks.some(f => f.name.toLowerCase().includes('asp.net'));

      confidence = Math.min(confidence, 1.0);
      
      telemetry.emit({
        type: 'analysis_started',
        source: { analyzer: this.getAnalyzerName() },
        data: {
          language: 'csharp',
          confidence,
          filesCount: files.length,
          frameworksFound: frameworks.length,
          isWebProject: this.isWebProject,
          dotnetVersion: this.dotnetVersion
        }
      });

      span.end();
      return {
        language: csharpFiles.length > 0 ? 'csharp' : fsharpFiles.length > 0 ? 'fsharp' : 'vb',
        confidence,
        frameworks: frameworks.sort((a, b) => b.confidence - a.confidence),
        files
      };
    } catch (error) {
      span.end();
      throw new AnalyzerError(
        `C# language detection failed: ${(error as Error).message}`,
        'DETECTION_ERROR',
        { error }
      );
    }
  }

  protected async discoverComponents(): Promise<ComponentDiscovery> {
    const span = telemetry.createSpan('csharp-analyzer.discoverComponents');
    const components: ComponentNode[] = [];
    let totalFiles = 0;
    let analyzedFiles = 0;
    let skippedFiles = 0;

    try {
      const sourceFiles = await this.findFiles(
        ['**/*.cs', '**/*.fs', '**/*.vb'], 
        [...(this.options.excludePatterns || []), 'bin/**', 'obj/**', 'packages/**']
      );
      
      totalFiles = sourceFiles.length;
      console.log(`💎 Analyzing ${totalFiles} C#/.NET files...`);

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

      console.log(`✅ C# analysis complete: ${analyzedFiles} analyzed, ${skippedFiles} skipped`);

      span.end();
      return { totalFiles, analyzedFiles, skippedFiles, components };
    } catch (error) {
      span.end();
      throw new AnalyzerError(
        `C# component discovery failed: ${(error as Error).message}`,
        'DISCOVERY_ERROR',
        { error }
      );
    }
  }

  protected async analyzeConnections(components: ComponentNode[]): Promise<Connection[]> {
    const span = telemetry.createSpan('csharp-analyzer.analyzeConnections');
    const connections: Connection[] = [];

    try {
      console.log(`🔗 Analyzing C# connections between ${components.length} components...`);

      for (const component of components) {
        // Analyze using statements for connections
        for (const usingNamespace of component.metadata.imports) {
          const targetComponent = this.findComponentByNamespace(components, usingNamespace);
          if (targetComponent && targetComponent.id !== component.id) {
            connections.push({
              from: component.id,
              to: targetComponent.id,
              type: 'import',
              weight: 1,
              metadata: { callSites: 1, dataFlow: 'using' }
            });
          }
        }

        // Analyze method calls and dependency injection
        if (component.metadata.functions) {
          for (const method of component.metadata.functions) {
            for (const call of method.calls) {
              const targetComponent = this.findComponentByMethodCall(components, call.target);
              if (targetComponent && targetComponent.id !== component.id) {
                connections.push({
                  from: component.id,
                  to: targetComponent.id,
                  type: 'function_call',
                  weight: call.count,
                  metadata: {
                    callSites: call.count,
                    dataFlow: `${method.name} -> ${call.target}`
                  }
                });
              }
            }
          }
        }
      }

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
        `C# connection analysis failed: ${(error as Error).message}`,
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

      if (component.metadata.complexity >= 9) {
        reasons.push(`High complexity (${component.metadata.complexity})`);
        riskLevel = 'high';
      } else if (component.metadata.complexity >= 6) {
        reasons.push(`Medium complexity (${component.metadata.complexity})`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      if (component.metadata.lineCount > 1200) {
        reasons.push(`Large class (${component.metadata.lineCount} lines)`);
        riskLevel = 'high';
      } else if (component.metadata.lineCount > 600) {
        reasons.push(`Large class (${component.metadata.lineCount} lines)`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      const incomingConnections = connections.filter(c => c.to === component.id).length;
      if (incomingConnections > 10) {
        reasons.push(`High coupling (${incomingConnections} dependents)`);
        riskLevel = 'high';
      } else if (incomingConnections > 5) {
        reasons.push(`Medium coupling (${incomingConnections} dependents)`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
        reasons.push('Database operations detected');
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) {
        reasons.push(`External API calls (${component.metadata.externalCalls.length})`);
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
      depth: 0,
      critical: comp.metadata.complexity >= 8 || comp.dependents.length > 8 || comp.type === 'service'
    }));

    const edges = components.flatMap(comp => 
      comp.dependencies.map(dep => ({
        from: comp.id,
        to: dep,
        count: 1,
        type: 'direct' as const,
        async: this.hasAsyncMethods(comp),
        conditional: false
      }))
    );

    return {
      nodes,
      edges,
      entryPoints: components.filter(c => c.metadata.isEntry).map(c => c.id),
      cycles: [],
      layers: [],
      hotPaths: [],
      deadCode: components.filter(c => c.dependents.length === 0 && !c.metadata.isEntry && c.type !== 'utility').map(c => c.id)
    };
  }

  protected async analyzeDatabaseConnections(components: ComponentNode[]): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    const dbPatterns = [
      { type: 'mssql', patterns: ['SqlConnection', 'System.Data.SqlClient', 'Microsoft.Data.SqlClient'] },
      { type: 'postgresql', patterns: ['NpgsqlConnection', 'Npgsql'] },
      { type: 'mysql', patterns: ['MySqlConnection', 'MySql.Data'] },
      { type: 'oracle', patterns: ['OracleConnection', 'Oracle.ManagedDataAccess'] },
      { type: 'sqlite', patterns: ['SQLiteConnection', 'System.Data.SQLite'] }
    ];

    for (const component of components) {
      for (const pattern of dbPatterns) {
        const hasPattern = pattern.patterns.some(p => 
          component.metadata.imports.some(imp => imp.includes(p)) ||
          (component.metadata.dbQueries && component.metadata.dbQueries.some(query => 
            query.includes(p)
          ))
        );

        if (hasPattern) {
          connections.push({
            id: `db_${pattern.type}_${component.id}`,
            name: `${pattern.type} connection`,
            type: pattern.type as any,
            componentIds: [component.id],
            usage: [{
              componentId: component.id,
              operations: this.extractDbOperations(component),
              frequency: component.metadata.dbQueries?.length || 1,
              critical: component.type === 'service' || component.metadata.complexity >= 7
            }]
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
    const estimatedCoveredLines = Math.min(testFiles.length * 35, totalLines * 0.7);

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
        unit: testFiles.filter(f => f.path.includes('Test.cs') || f.path.includes('Tests.cs')).length,
        integration: testFiles.filter(f => f.path.includes('Integration')).length,
        e2e: testFiles.filter(f => f.path.includes('E2E') || f.path.includes('Selenium')).length
      },
      uncoveredFiles: sourceFiles.filter(c => !this.hasCorrespondingTest(c, testFiles)).map(c => c.path)
    };
  }

  // Private helper methods
  private async analyzeFile(filePath: string): Promise<ComponentNode | null> {
    try {
      const content = await this.readFile(filePath);
      const relativePath = path.relative(this.projectPath, filePath);
      
      if (content.length === 0 || content.length > (this.options.maxFileSize || 2 * 1024 * 1024)) {
        return null;
      }

      const component: ComponentNode = {
        id: this.generateComponentId(filePath),
        name: this.extractClassName(content, filePath),
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
          functions: await this.extractFunctions(content, 'csharp'),
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
        `Failed to analyze C# file ${filePath}: ${(error as Error).message}`,
        'FILE_ANALYSIS_ERROR',
        { filePath, error }
      );
    }
  }

  private extractClassName(content: string, filePath: string): string {
    const classMatch = content.match(/(?:public|internal|private)?\s*class\s+(\w+)/);
    if (classMatch) return classMatch[1];
    
    const interfaceMatch = content.match(/(?:public|internal)?\s*interface\s+(\w+)/);
    if (interfaceMatch) return interfaceMatch[1];
    
    const structMatch = content.match(/(?:public|internal|private)?\s*struct\s+(\w+)/);
    if (structMatch) return structMatch[1];
    
    return path.basename(filePath, path.extname(filePath));
  }

  private determineComponentType(filePath: string, content: string): ComponentType {
    const fileName = path.basename(filePath).toLowerCase();
    
    if (this.isTestFile(filePath)) return 'utility';
    
    // ASP.NET Core/MVC patterns
    if (content.includes('[ApiController]') || content.includes('[Controller]') || 
        fileName.includes('controller')) return 'controller';
    
    if (content.includes('[Route(') || content.includes('[HttpGet') || 
        content.includes('[HttpPost')) return 'route';
    
    if (fileName.includes('service') || content.includes('[Service]')) return 'service';
    
    if (fileName.includes('model') || fileName.includes('entity') || 
        content.includes('[Table(') || content.includes('[Entity]')) return 'model';
    
    if (fileName.includes('repository') || content.includes('Repository') ||
        content.includes('DbContext')) return 'database';
    
    if (fileName.includes('middleware') || content.includes('IMiddleware')) return 'middleware';
    
    if (fileName.includes('config') || content.includes('Configuration') ||
        fileName.includes('startup') || fileName.includes('program')) return 'config';

    return 'utility';
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const usingMatches = content.match(/using\s+([^;=]+);/g);
    
    if (usingMatches) {
      for (const match of usingMatches) {
        const namespace = match.replace(/using\s+/, '').replace(';', '').trim();
        if (!namespace.includes('=') && !namespace.startsWith('static')) {
          imports.push(namespace.split('.')[0]);
        }
      }
    }

    return [...new Set(imports)];
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    
    const publicClassMatches = content.match(/public\s+class\s+(\w+)/g);
    if (publicClassMatches) {
      exports.push(...publicClassMatches.map(match => match.split(/\s+/).pop() || ''));
    }
    
    const publicInterfaceMatches = content.match(/public\s+interface\s+(\w+)/g);
    if (publicInterfaceMatches) {
      exports.push(...publicInterfaceMatches.map(match => match.split(/\s+/).pop() || ''));
    }
    
    const publicMethodMatches = content.match(/public\s+(?:static\s+)?(?:async\s+)?(?:\w+\s+)*(\w+)\s*\(/g);
    if (publicMethodMatches) {
      exports.push(...publicMethodMatches.map(match => {
        const parts = match.replace('(', '').split(/\s+/);
        return parts[parts.length - 1];
      }));
    }

    return [...new Set(exports)];
  }

  private extractHttpMethods(content: string): string[] {
    const methods: string[] = [];
    
    const httpAttributeMatches = content.match(/\[(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch)\]/g);
    if (httpAttributeMatches) {
      methods.push(...httpAttributeMatches.map(attr => attr.replace(/[\[\]]/g, '').replace('Http', '').toUpperCase()));
    }
    
    return [...new Set(methods)];
  }

  private extractDatabaseQueries(content: string): string[] {
    const queries: string[] = [];
    
    // SQL strings
    const sqlMatches = content.match(/@"(SELECT.*?)"/gis) || 
                      content.match(/"(SELECT.*?)"/gis) ||
                      content.match(/@"(INSERT.*?)"/gis) ||
                      content.match(/"(INSERT.*?)"/gis);
    
    if (sqlMatches) {
      queries.push(...sqlMatches.map(match => match.replace(/^@?"/, '').replace(/"$/, '')));
    }
    
    // LINQ queries
    const linqMatches = content.match(/from\s+\w+\s+in\s+[\w.]+/g);
    if (linqMatches) {
      queries.push(...linqMatches);
    }

    return queries;
  }

  private extractExternalCalls(content: string): string[] {
    const calls: string[] = [];
    
    // HttpClient calls
    const httpClientCalls = content.match(/HttpClient\.\w+\s*\([^)]*"([^"]+)"/g);
    if (httpClientCalls) {
      calls.push(...httpClientCalls.map(call => `HTTP ${call.match(/"([^"]+)"/)?.[1]}`));
    }
    
    // RestSharp calls
    const restSharpCalls = content.match(/RestRequest\s*\(\s*"([^"]+)"/g);
    if (restSharpCalls) {
      calls.push(...restSharpCalls.map(call => `REST ${call.match(/"([^"]+)"/)?.[1]}`));
    }

    return calls.filter(c => c.length > 0);
  }

  private determineArchitecturalLayer(filePath: string, content: string): any {
    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();

    if (content.includes('[ApiController]') || content.includes('[Controller]') || 
        dirName.includes('controllers') || dirName.includes('api')) {
      return 'presentation';
    }

    if (fileName.includes('service') || dirName.includes('services') || 
        dirName.includes('business')) {
      return 'business';
    }

    if (content.includes('DbContext') || fileName.includes('repository') || 
        dirName.includes('data') || dirName.includes('repositories')) {
      return 'data';
    }

    if (fileName.includes('config') || dirName.includes('infrastructure') || 
        fileName.includes('util')) {
      return 'infrastructure';
    }

    if (content.includes('HttpClient') || content.includes('RestSharp')) {
      return 'external';
    }

    return 'infrastructure';
  }

  private extractResponsibilities(filePath: string, content: string): string[] {
    const responsibilities: string[] = [];
    
    if (content.includes('[ApiController]') || content.includes('[Controller]')) {
      responsibilities.push('API request handling');
    }
    if (content.includes('[Service]') || filePath.includes('Service')) {
      responsibilities.push('Business logic');
    }
    if (content.includes('DbContext') || content.includes('Repository')) {
      responsibilities.push('Data access');
    }
    if (content.includes('[Table(') || content.includes('[Entity]')) {
      responsibilities.push('Data modeling');
    }
    if (content.includes('HttpClient')) {
      responsibilities.push('External service communication');
    }
    if (this.isTestFile(filePath)) {
      responsibilities.push('Testing');
    }

    return responsibilities.length > 0 ? responsibilities : ['General utility'];
  }

  private isTestFile(filePath: string): boolean {
    const fileName = path.basename(filePath).toLowerCase();
    return fileName.includes('test.cs') || fileName.includes('tests.cs') ||
           filePath.includes('/test/') || filePath.includes('\\test\\') ||
           filePath.includes('/tests/') || filePath.includes('\\tests\\');
  }

  private isEntryPoint(filePath: string, content: string): boolean {
    return content.includes('static void Main') ||
           content.includes('public class Program') ||
           content.includes('public class Startup') ||
           path.basename(filePath) === 'Program.cs' ||
           path.basename(filePath) === 'Startup.cs';
  }

  private async detectDotNetVersion(): Promise<void> {
    // Implementation would analyze csproj files for TargetFramework
    this.dotnetVersion = 'unknown';
  }

  private async analyzeProjectFiles(): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const projectFiles = await this.findFiles(['*.csproj', '*.fsproj', '*.vbproj']);
    
    // Implementation would parse project files for PackageReference elements
    return frameworks;
  }

  private async analyzeCodeForFrameworks(files: string[]): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    // Implementation would analyze code for framework-specific patterns
    return frameworks;
  }

  private findComponentByNamespace(components: ComponentNode[], namespace: string): ComponentNode | undefined {
    return components.find(c => c.metadata.exports.some(exp => namespace.includes(exp)));
  }

  private findComponentByMethodCall(components: ComponentNode[], methodName: string): ComponentNode | undefined {
    return components.find(c => c.metadata.exports.includes(methodName));
  }

  private hasAsyncMethods(component: ComponentNode): boolean {
    return component.metadata.functions?.some(f => f.isAsync) || false;
  }

  private getCallGraphNodeType(componentType: ComponentType): 'function' | 'method' | 'class' | 'module' {
    return componentType === 'route' ? 'method' : 'class';
  }

  private extractDbOperations(component: ComponentNode): any[] {
    return (component.metadata.dbQueries || []).map(query => ({
      type: query.toUpperCase().includes('SELECT') ? 'read' : 'write',
      tables: [],
      complexity: 1,
      optimized: false
    }));
  }

  private calculateRiskImpact(riskLevel: 'low' | 'medium' | 'high', dependentCount: number): string {
    const baseImpact = riskLevel === 'high' ? 'High' : riskLevel === 'medium' ? 'Medium' : 'Low';
    const scopeImpact = dependentCount > 10 ? 'system-wide' : dependentCount > 5 ? 'module-wide' : 'localized';
    return `${baseImpact} impact, ${scopeImpact} scope`;
  }

  private hasCorrespondingTest(component: ComponentNode, testFiles: ComponentNode[]): boolean {
    const componentName = component.name;
    return testFiles.some(test => 
      test.path.includes(`${componentName}Test`) || 
      test.path.includes(`${componentName}Tests`) ||
      test.name.includes(componentName)
    );
  }

  protected async analyzeAPIEndpoints(components: ComponentNode[]): Promise<APIEndpoint[]> {
    const endpoints: APIEndpoint[] = [];
    
    for (const component of components) {
      if ((component.type === 'controller' || component.type === 'route') && component.metadata.httpMethods) {
        for (const method of component.metadata.httpMethods) {
          endpoints.push({
            id: `${component.id}_${method}`,
            method: method as any,
            path: this.extractEndpointPath(component.path),
            description: `${method} endpoint in ${component.name}`,
            parameters: [],
            requestSchema: null,
            responseSchema: null,
            statusCodes: [{ code: 200, description: 'Success', schema: null }],
            middleware: [],
            authentication: { type: 'none', required: false },
            componentId: component.id,
            handler: component.name,
            controller: component.name
          });
        }
      }
    }

    return endpoints;
  }

  private extractEndpointPath(filePath: string): string {
    const relativePath = path.relative(this.projectPath, filePath);
    return `/${relativePath.replace(/\\/g, '/').replace(/\.cs$/, '')}`;
  }
}