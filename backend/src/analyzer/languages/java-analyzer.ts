// Java Base Analyzer - Comprehensive analysis for Java projects
// Phase 2: Language Base Analyzers - Production-ready Java analyzer

import { BaseAnalyzer, LanguageDetection, ComponentDiscovery, FrameworkDetection } from '../base-analyzer';
import { ComponentNode, ComponentType, Connection, RiskArea, CallGraph, DatabaseConnection, TestCoverage, APIEndpoint } from '../../types';
import { telemetry } from '../../telemetry/telemetry-schema';
import { AnalyzerError } from '../errors';
import * as path from 'path';
import * as fs from 'fs-extra';

export class JavaAnalyzer extends BaseAnalyzer {
  private javaVersion: string = '';
  private buildTool: 'maven' | 'gradle' | 'ant' | 'unknown' = 'unknown';
  private isSpringProject: boolean = false;
  private hasTests: boolean = false;
  
  getAnalyzerName(): string {
    return 'Java Analyzer';
  }

  getSupportedLanguages(): string[] {
    return ['java', 'kotlin', 'scala'];
  }

  getSupportedFrameworks(): string[] {
    return [
      'spring-boot', 'spring-mvc', 'spring-data', 'spring-security',
      'hibernate', 'jpa', 'mybatis', 'jdbi',
      'junit', 'testng', 'mockito', 'spock',
      'servlet-api', 'jax-rs', 'jax-ws', 'jersey',
      'apache-kafka', 'apache-camel', 'apache-cxf',
      'maven', 'gradle', 'ant',
      'tomcat', 'jetty', 'undertow',
      'jackson', 'gson', 'lombok'
    ];
  }

  protected async detectLanguageAndFramework(): Promise<LanguageDetection> {
    const span = telemetry.createSpan('java-analyzer.detectLanguageAndFramework');
    let confidence = 0;
    const frameworks: FrameworkDetection[] = [];
    const files: string[] = [];

    try {
      // Check for Java files
      const javaFiles = await this.findFiles(['**/*.java'], this.options.excludePatterns);
      const kotlinFiles = await this.findFiles(['**/*.kt', '**/*.kts'], this.options.excludePatterns);
      const scalaFiles = await this.findFiles(['**/*.scala'], this.options.excludePatterns);
      
      files.push(...javaFiles, ...kotlinFiles, ...scalaFiles);
      
      if (javaFiles.length > 0) {
        confidence += 0.5;
      }
      if (kotlinFiles.length > 0) {
        confidence += 0.3;
      }
      if (scalaFiles.length > 0) {
        confidence += 0.2;
      }

      // Check for Java-specific files
      const javaSpecificFiles = [
        'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
        'build.xml', 'ivy.xml', 'gradle.properties', 'gradlew',
        'application.properties', 'application.yml', 'application.yaml',
        'web.xml', 'beans.xml', 'persistence.xml'
      ];

      for (const file of javaSpecificFiles) {
        const filePath = path.join(this.projectPath, file);
        if (await fs.pathExists(filePath)) {
          confidence += 0.1;
          files.push(filePath);
          
          // Detect build tool
          if (file === 'pom.xml') {
            this.buildTool = 'maven';
          } else if (file.includes('gradle')) {
            this.buildTool = 'gradle';
          } else if (file === 'build.xml') {
            this.buildTool = 'ant';
          }
        }
      }

      // Analyze build files for framework dependencies
      const buildFrameworks = await this.analyzeBuildFiles();
      frameworks.push(...buildFrameworks);

      // Analyze Java source files for framework patterns
      if (javaFiles.length > 0) {
        const sampleFiles = javaFiles.slice(0, 25); // Sample first 25 files
        const codeFrameworks = await this.analyzeCodeForFrameworks(sampleFiles);
        frameworks.push(...codeFrameworks);
      }

      // Detect if it's a Spring project
      this.isSpringProject = frameworks.some(f => f.name.toLowerCase().includes('spring'));

      // Detect Java version
      await this.detectJavaVersion();

      confidence = Math.min(confidence, 1.0);
      
      telemetry.emit({
        type: 'analysis_started',
        source: { analyzer: this.getAnalyzerName() },
        data: {
          language: 'java',
          confidence,
          filesCount: files.length,
          frameworksFound: frameworks.length,
          buildTool: this.buildTool,
          isSpringProject: this.isSpringProject
        }
      });

      span.end();
      return {
        language: javaFiles.length > 0 ? 'java' : kotlinFiles.length > 0 ? 'kotlin' : 'scala',
        confidence,
        frameworks: frameworks.sort((a, b) => b.confidence - a.confidence),
        files
      };
    } catch (error) {
      span.end();
      throw new AnalyzerError(
        `Java language detection failed: ${(error as Error).message}`,
        'DETECTION_ERROR',
        { error }
      );
    }
  }

  protected async discoverComponents(): Promise<ComponentDiscovery> {
    const span = telemetry.createSpan('java-analyzer.discoverComponents');
    const components: ComponentNode[] = [];
    let totalFiles = 0;
    let analyzedFiles = 0;
    let skippedFiles = 0;

    try {
      const sourceFiles = await this.findFiles(
        ['**/*.java', '**/*.kt', '**/*.scala'], 
        [...(this.options.excludePatterns || []), 'target/**', 'build/**', '.gradle/**']
      );
      
      totalFiles = sourceFiles.length;

      console.log(`☕ Analyzing ${totalFiles} Java/Kotlin/Scala files...`);

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

      console.log(`✅ Java analysis complete: ${analyzedFiles} analyzed, ${skippedFiles} skipped`);

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
        `Java component discovery failed: ${(error as Error).message}`,
        'DISCOVERY_ERROR',
        { error }
      );
    }
  }

  protected async analyzeConnections(components: ComponentNode[]): Promise<Connection[]> {
    const span = telemetry.createSpan('java-analyzer.analyzeConnections');
    const connections: Connection[] = [];

    try {
      console.log(`🔗 Analyzing Java connections between ${components.length} components...`);

      for (const component of components) {
        // Analyze imports to create connections
        for (const importPath of component.metadata.imports) {
          const targetComponent = this.findComponentByImportPath(components, importPath);
          if (targetComponent && targetComponent.id !== component.id) {
            connections.push({
              from: component.id,
              to: targetComponent.id,
              type: 'import',
              weight: 1,
              metadata: {
                callSites: 1,
                dataFlow: 'import'
              }
            });
          }
        }

        // Analyze method calls within the component
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

        // Spring-specific dependency injection connections
        if (this.isSpringProject) {
          const injectionConnections = this.analyzeSpringDependencyInjection(component, components);
          connections.push(...injectionConnections);
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
        `Java connection analysis failed: ${(error as Error).message}`,
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
      if (component.metadata.complexity >= 9) {
        reasons.push(`High complexity (${component.metadata.complexity})`);
        riskLevel = 'high';
      } else if (component.metadata.complexity >= 6) {
        reasons.push(`Medium complexity (${component.metadata.complexity})`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // Large classes
      if (component.metadata.lineCount > 1500) {
        reasons.push(`Large class (${component.metadata.lineCount} lines)`);
        riskLevel = 'high';
      } else if (component.metadata.lineCount > 800) {
        reasons.push(`Large class (${component.metadata.lineCount} lines)`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // High coupling (many dependencies)
      const incomingConnections = connections.filter(c => c.to === component.id).length;
      if (incomingConnections > 12) {
        reasons.push(`High coupling (${incomingConnections} dependents)`);
        riskLevel = 'high';
      } else if (incomingConnections > 6) {
        reasons.push(`Medium coupling (${incomingConnections} dependents)`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // Database operations without transaction management
      if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
        if (!this.hasTransactionManagement(component)) {
          reasons.push('Database operations without transaction management');
          riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
        }
      }

      // External API calls without circuit breakers
      if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) {
        reasons.push(`External API calls (${component.metadata.externalCalls.length})`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // Missing test coverage for critical components
      if (component.type === 'service' && !this.hasCorrespondingTest(component, components)) {
        reasons.push('Critical service without test coverage');
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
      critical: comp.metadata.complexity >= 8 || comp.dependents.length > 10 || comp.type === 'service'
    }));

    const edges = components.flatMap(comp => 
      comp.dependencies.map(dep => ({
        from: comp.id,
        to: dep,
        count: 1,
        type: 'direct' as const,
        async: this.hasAsyncOperations(comp),
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
      deadCode: components.filter(c => c.dependents.length === 0 && !c.metadata.isEntry && c.type !== 'utility').map(c => c.id)
    };
  }

  protected async analyzeDatabaseConnections(components: ComponentNode[]): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    const dbPatterns = [
      { type: 'postgresql', patterns: ['postgresql', 'org.postgresql', 'PGSimpleDataSource'] },
      { type: 'mysql', patterns: ['mysql', 'com.mysql', 'MysqlDataSource'] },
      { type: 'oracle', patterns: ['oracle', 'ojdbc', 'OracleDataSource'] },
      { type: 'mongodb', patterns: ['mongodb', 'mongo-java-driver', 'MongoClient'] },
      { type: 'redis', patterns: ['redis', 'jedis', 'lettuce'] },
      { type: 'sqlite', patterns: ['sqlite', 'org.sqlite'] }
    ];

    for (const component of components) {
      for (const pattern of dbPatterns) {
        const hasPattern = pattern.patterns.some(p => 
          component.metadata.imports.some(imp => imp.toLowerCase().includes(p.toLowerCase())) ||
          (component.metadata.dbQueries && component.metadata.dbQueries.some(query => 
            query.toLowerCase().includes(p.toLowerCase())
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
    
    if (testFiles.length === 0) {
      return null;
    }

    this.hasTests = true;
    const totalLines = sourceFiles.reduce((sum, c) => sum + c.metadata.lineCount, 0);
    const estimatedCoveredLines = Math.min(testFiles.length * 40, totalLines * 0.7);

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
        unit: testFiles.filter(f => f.path.includes('Test.java') || f.path.includes('test/java')).length,
        integration: testFiles.filter(f => f.path.includes('IT.java') || f.path.includes('integration')).length,
        e2e: testFiles.filter(f => f.path.includes('e2e') || f.path.includes('selenium')).length
      },
      uncoveredFiles: sourceFiles.filter(c => !this.hasCorrespondingTest(c, testFiles)).map(c => c.path)
    };
  }

  // Private helper methods
  private async analyzeFile(filePath: string): Promise<ComponentNode | null> {
    try {
      const content = await this.readFile(filePath);
      const relativePath = path.relative(this.projectPath, filePath);
      
      // Skip empty files or very large files
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
          functions: await this.extractFunctions(content, 'java'),
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
        `Failed to analyze Java file ${filePath}: ${(error as Error).message}`,
        'FILE_ANALYSIS_ERROR',
        { filePath, error }
      );
    }
  }

  private extractClassName(content: string, filePath: string): string {
    // Try to extract class name from content
    const classMatch = content.match(/public\s+class\s+(\w+)/);
    if (classMatch) {
      return classMatch[1];
    }
    
    // Try interface
    const interfaceMatch = content.match(/public\s+interface\s+(\w+)/);
    if (interfaceMatch) {
      return interfaceMatch[1];
    }
    
    // Try enum
    const enumMatch = content.match(/public\s+enum\s+(\w+)/);
    if (enumMatch) {
      return enumMatch[1];
    }
    
    // Fallback to filename
    return path.basename(filePath, path.extname(filePath));
  }

  private determineComponentType(filePath: string, content: string): ComponentType {
    const fileName = path.basename(filePath).toLowerCase();
    
    // Test files
    if (this.isTestFile(filePath)) {
      return 'utility';
    }
    
    // Spring Boot specific
    if (content.includes('@RestController') || content.includes('@Controller')) {
      return 'controller';
    }
    
    if (content.includes('@Service') || content.includes('@Component')) {
      return 'service';
    }
    
    if (content.includes('@Repository') || content.includes('@Entity')) {
      return 'model';
    }
    
    if (content.includes('@Configuration') || fileName.includes('config')) {
      return 'config';
    }

    // Servlet API
    if (content.includes('HttpServlet') || content.includes('@WebServlet')) {
      return 'controller';
    }

    // JAX-RS
    if (content.includes('@Path') || content.includes('@GET') || content.includes('@POST')) {
      return 'route';
    }

    // General patterns
    if (fileName.includes('controller') || fileName.includes('servlet')) {
      return 'controller';
    }
    
    if (fileName.includes('service') || fileName.includes('business')) {
      return 'service';
    }
    
    if (fileName.includes('model') || fileName.includes('entity') || fileName.includes('dto')) {
      return 'model';
    }
    
    if (fileName.includes('dao') || fileName.includes('repository')) {
      return 'database';
    }
    
    if (fileName.includes('util') || fileName.includes('helper')) {
      return 'utility';
    }

    return 'utility';
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Standard imports
      const importMatch = trimmed.match(/^import\s+(static\s+)?([^;]+);/);
      if (importMatch) {
        const importPath = importMatch[2];
        if (!importPath.startsWith('java.lang.')) {
          imports.push(importPath.split('.')[0]);
        }
      }
    }

    return [...new Set(imports)];
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    
    // Public classes
    const classMatches = content.match(/public\s+class\s+(\w+)/g);
    if (classMatches) {
      exports.push(...classMatches.map(match => match.split(/\s+/).pop() || ''));
    }
    
    // Public interfaces
    const interfaceMatches = content.match(/public\s+interface\s+(\w+)/g);
    if (interfaceMatches) {
      exports.push(...interfaceMatches.map(match => match.split(/\s+/).pop() || ''));
    }
    
    // Public enums
    const enumMatches = content.match(/public\s+enum\s+(\w+)/g);
    if (enumMatches) {
      exports.push(...enumMatches.map(match => match.split(/\s+/).pop() || ''));
    }
    
    // Public methods
    const methodMatches = content.match(/public\s+(?:static\s+)?(?:\w+\s+)*(\w+)\s*\(/g);
    if (methodMatches) {
      exports.push(...methodMatches.map(match => {
        const parts = match.replace('(', '').split(/\s+/);
        return parts[parts.length - 1];
      }));
    }

    return [...new Set(exports)];
  }

  private extractHttpMethods(content: string): string[] {
    const methods: string[] = [];
    
    // Spring annotations
    const springMethods = content.match(/@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)/g);
    if (springMethods) {
      methods.push(...springMethods.map(method => method.substring(1).replace('Mapping', '').toUpperCase()));
    }
    
    // JAX-RS annotations
    const jaxrsMethods = content.match(/@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/g);
    if (jaxrsMethods) {
      methods.push(...jaxrsMethods.map(method => method.substring(1)));
    }
    
    // Servlet doXXX methods
    const servletMethods = content.match(/do(Get|Post|Put|Delete|Head|Options)/g);
    if (servletMethods) {
      methods.push(...servletMethods.map(method => method.substring(2).toUpperCase()));
    }

    return [...new Set(methods)];
  }

  private extractDatabaseQueries(content: string): string[] {
    const queries: string[] = [];
    
    // SQL strings
    const sqlPatterns = [
      /"(SELECT.*?)"/gis,
      /"(INSERT.*?)"/gis,
      /"(UPDATE.*?)"/gis,
      /"(DELETE.*?)"/gis,
      /"(CREATE.*?)"/gis
    ];

    for (const pattern of sqlPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        queries.push(...matches.map(match => match.slice(1, -1)));
      }
    }
    
    // JPA/Hibernate queries
    const jpaQueries = content.match(/@Query\s*\(\s*"([^"]+)"/g);
    if (jpaQueries) {
      queries.push(...jpaQueries.map(query => query.match(/"([^"]+)"/)?.[1] || ''));
    }
    
    // Named queries
    const namedQueries = content.match(/@NamedQuery\s*\([^)]*query\s*=\s*"([^"]+)"/g);
    if (namedQueries) {
      queries.push(...namedQueries.map(query => query.match(/query\s*=\s*"([^"]+)"/)?.[1] || ''));
    }

    return queries.filter(q => q.length > 0);
  }

  private extractExternalCalls(content: string): string[] {
    const calls: string[] = [];
    
    // RestTemplate calls
    const restTemplateCalls = content.match(/restTemplate\.(get|post|put|delete|exchange)\s*\([^)]*"([^"]+)"/g);
    if (restTemplateCalls) {
      calls.push(...restTemplateCalls.map(call => {
        const matches = call.match(/(\w+)\s*\([^)]*"([^"]+)"/);
        return matches ? `${matches[1].toUpperCase()} ${matches[2]}` : call;
      }));
    }
    
    // WebClient calls (Spring WebFlux)
    const webClientCalls = content.match(/WebClient\.create\(\s*"([^"]+)"/g);
    if (webClientCalls) {
      calls.push(...webClientCalls.map(call => `WebClient ${call.match(/"([^"]+)"/)?.[1]}`));
    }
    
    // OkHttp calls
    const okHttpCalls = content.match(/new Request\.Builder\(\)\.url\s*\(\s*"([^"]+)"/g);
    if (okHttpCalls) {
      calls.push(...okHttpCalls.map(call => `HTTP ${call.match(/"([^"]+)"/)?.[1]}`));
    }

    return calls.filter(c => c.length > 0);
  }

  private determineArchitecturalLayer(filePath: string, content: string): any {
    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();

    // Presentation layer
    if (content.includes('@Controller') || content.includes('@RestController') ||
        content.includes('HttpServlet') || dirName.includes('controller') ||
        dirName.includes('web') || dirName.includes('api')) {
      return 'presentation';
    }

    // Business layer
    if (content.includes('@Service') || content.includes('@Component') ||
        dirName.includes('service') || dirName.includes('business') ||
        fileName.includes('service')) {
      return 'business';
    }

    // Data layer
    if (content.includes('@Entity') || content.includes('@Repository') ||
        content.includes('CrudRepository') || dirName.includes('repository') ||
        dirName.includes('dao') || dirName.includes('entity') ||
        fileName.includes('model') || fileName.includes('entity')) {
      return 'data';
    }

    // Infrastructure layer
    if (content.includes('@Configuration') || fileName.includes('config') ||
        fileName.includes('util') || dirName.includes('config') ||
        dirName.includes('util')) {
      return 'infrastructure';
    }

    // External layer
    if (content.includes('RestTemplate') || content.includes('WebClient') ||
        content.includes('HttpClient')) {
      return 'external';
    }

    return 'infrastructure';
  }

  private extractResponsibilities(filePath: string, content: string): string[] {
    const responsibilities: string[] = [];
    
    if (content.includes('@RestController') || content.includes('@Controller')) {
      responsibilities.push('HTTP request handling');
    }
    
    if (content.includes('@Service')) {
      responsibilities.push('Business logic');
    }
    
    if (content.includes('@Repository') || content.includes('CrudRepository')) {
      responsibilities.push('Data access');
    }
    
    if (content.includes('@Entity') || content.includes('@Table')) {
      responsibilities.push('Data modeling');
    }
    
    if (content.includes('RestTemplate') || content.includes('WebClient')) {
      responsibilities.push('External service communication');
    }
    
    if (this.isTestFile(filePath)) {
      responsibilities.push('Testing');
    }
    
    if (content.includes('@Configuration')) {
      responsibilities.push('Configuration management');
    }

    return responsibilities.length > 0 ? responsibilities : ['General utility'];
  }

  private isTestFile(filePath: string): boolean {
    const fileName = path.basename(filePath).toLowerCase();
    return fileName.endsWith('test.java') ||
           fileName.endsWith('tests.java') ||
           fileName.endsWith('it.java') ||
           filePath.includes('/test/') ||
           filePath.includes('\\test\\') ||
           filePath.includes('src/test');
  }

  private isEntryPoint(filePath: string, content: string): boolean {
    const fileName = path.basename(filePath);
    
    return content.includes('@SpringBootApplication') ||
           content.includes('public static void main') ||
           content.includes('ServletContextListener') ||
           fileName.includes('Application.java') ||
           fileName.includes('Main.java');
  }

  private async detectJavaVersion(): Promise<void> {
    try {
      // Try to detect from build files
      if (this.buildTool === 'maven') {
        const pomPath = path.join(this.projectPath, 'pom.xml');
        if (await fs.pathExists(pomPath)) {
          const pomContent = await fs.readFile(pomPath, 'utf-8');
          const versionMatch = pomContent.match(/<maven\.compiler\.target>(\d+)<\/maven\.compiler\.target>/) ||
                              pomContent.match(/<java\.version>(\d+)<\/java\.version>/);
          if (versionMatch) {
            this.javaVersion = versionMatch[1];
          }
        }
      } else if (this.buildTool === 'gradle') {
        const gradleFiles = ['build.gradle', 'build.gradle.kts'];
        for (const file of gradleFiles) {
          const gradlePath = path.join(this.projectPath, file);
          if (await fs.pathExists(gradlePath)) {
            const gradleContent = await fs.readFile(gradlePath, 'utf-8');
            const versionMatch = gradleContent.match(/targetCompatibility\s*=\s*['"]*(\d+)['"]*/) ||
                                gradleContent.match(/sourceCompatibility\s*=\s*['"]*(\d+)['"]*/) ||
                                gradleContent.match(/JavaVersion\.VERSION_(\d+)/);
            if (versionMatch) {
              this.javaVersion = versionMatch[1];
              break;
            }
          }
        }
      }
    } catch (error) {
      // Ignore errors in version detection
    }
  }

  private async analyzeBuildFiles(): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    
    if (this.buildTool === 'maven') {
      const pomFrameworks = await this.analyzePomXml();
      frameworks.push(...pomFrameworks);
    } else if (this.buildTool === 'gradle') {
      const gradleFrameworks = await this.analyzeGradleBuild();
      frameworks.push(...gradleFrameworks);
    }

    return frameworks;
  }

  private async analyzePomXml(): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const pomPath = path.join(this.projectPath, 'pom.xml');
    
    if (await fs.pathExists(pomPath)) {
      const pomContent = await fs.readFile(pomPath, 'utf-8');
      
      const dependencyPatterns = {
        'spring-boot': /<artifactId>spring-boot-starter/g,
        'spring': /<groupId>org\.springframework<\/groupId>/g,
        'hibernate': /<artifactId>hibernate/g,
        'junit': /<artifactId>junit/g,
        'mockito': /<artifactId>mockito/g,
        'jackson': /<artifactId>jackson/g,
        'lombok': /<artifactId>lombok<\/artifactId>/g
      };

      for (const [name, pattern] of Object.entries(dependencyPatterns)) {
        const matches = pomContent.match(pattern);
        if (matches) {
          const version = this.extractVersionFromPom(pomContent, name);
          frameworks.push({
            name,
            version,
            confidence: 0.9,
            patterns: [`Found in pom.xml (${matches.length} dependencies)`],
            configFiles: ['pom.xml'],
            dependencies: [name]
          });
        }
      }
    }

    return frameworks;
  }

  private extractVersionFromPom(pomContent: string, artifactId: string): string | undefined {
    const versionPattern = new RegExp(`<artifactId>${artifactId}[^<]*</artifactId>\\s*<version>([^<]+)</version>`, 'i');
    const match = pomContent.match(versionPattern);
    return match ? match[1] : undefined;
  }

  private async analyzeGradleBuild(): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const gradleFiles = ['build.gradle', 'build.gradle.kts'];
    
    for (const file of gradleFiles) {
      const gradlePath = path.join(this.projectPath, file);
      if (await fs.pathExists(gradlePath)) {
        const gradleContent = await fs.readFile(gradlePath, 'utf-8');
        
        const dependencyPatterns = {
          'spring-boot': /spring-boot-starter/g,
          'spring': /org\.springframework/g,
          'hibernate': /hibernate/g,
          'junit': /junit/g,
          'mockito': /mockito/g
        };

        for (const [name, pattern] of Object.entries(dependencyPatterns)) {
          const matches = gradleContent.match(pattern);
          if (matches) {
            frameworks.push({
              name,
              confidence: 0.9,
              patterns: [`Found in ${file} (${matches.length} dependencies)`],
              configFiles: [file],
              dependencies: [name]
            });
          }
        }
        break; // Only analyze the first found file
      }
    }

    return frameworks;
  }

  private async analyzeCodeForFrameworks(files: string[]): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const frameworkIndicators = new Map<string, { count: number, files: Set<string> }>();

    for (const filePath of files) {
      try {
        const content = await this.readFile(filePath);
        
        // Spring annotations
        if (content.includes('@SpringBootApplication') || content.includes('@RestController') ||
            content.includes('@Service') || content.includes('@Repository')) {
          this.updateFrameworkIndicator(frameworkIndicators, 'spring', filePath);
        }
        
        // JPA/Hibernate
        if (content.includes('@Entity') || content.includes('@Table') ||
            content.includes('SessionFactory') || content.includes('EntityManager')) {
          this.updateFrameworkIndicator(frameworkIndicators, 'jpa', filePath);
        }
        
        // JUnit
        if (content.includes('@Test') || content.includes('import org.junit')) {
          this.updateFrameworkIndicator(frameworkIndicators, 'junit', filePath);
        }

      } catch (error) {
        // Skip files that can't be read
      }
    }

    // Convert indicators to framework detections
    for (const [name, info] of frameworkIndicators) {
      frameworks.push({
        name,
        confidence: Math.min(0.8, info.count * 0.1),
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

  private findComponentByImportPath(components: ComponentNode[], importPath: string): ComponentNode | undefined {
    return components.find(c => {
      const className = this.extractClassName('', c.path);
      return importPath.includes(className) || c.metadata.exports.some(exp => importPath.includes(exp));
    });
  }

  private findComponentByMethodCall(components: ComponentNode[], methodName: string): ComponentNode | undefined {
    return components.find(c => c.metadata.exports.includes(methodName));
  }

  private analyzeSpringDependencyInjection(component: ComponentNode, components: ComponentNode[]): Connection[] {
    const connections: Connection[] = [];
    
    // This would require more sophisticated analysis of Spring annotations
    // For now, we'll return empty array
    return connections;
  }

  private hasTransactionManagement(component: ComponentNode): boolean {
    return component.metadata.imports.some(imp => 
      imp.includes('Transactional') || imp.includes('Transaction')
    );
  }

  private hasAsyncOperations(component: ComponentNode): boolean {
    return component.metadata.functions?.some(f => 
      f.isAsync || f.name.includes('Async') || f.returnType.includes('Future')
    ) || false;
  }

  private getCallGraphNodeType(componentType: ComponentType): 'function' | 'method' | 'class' | 'module' {
    switch (componentType) {
      case 'controller':
      case 'service':
      case 'model':
        return 'class';
      case 'route':
        return 'method';
      default:
        return 'module';
    }
  }

  private extractDbOperations(component: ComponentNode): any[] {
    const operations: any[] = [];
    
    if (component.metadata.dbQueries) {
      for (const query of component.metadata.dbQueries) {
        operations.push({
          type: this.getQueryType(query),
          tables: this.extractTables(query),
          complexity: this.calculateQueryComplexity(query),
          optimized: false
        });
      }
    }

    return operations;
  }

  private getQueryType(query: string): 'read' | 'write' | 'transaction' | 'batch' {
    const upperQuery = query.toUpperCase();
    if (upperQuery.includes('SELECT')) return 'read';
    if (upperQuery.includes('INSERT') || upperQuery.includes('UPDATE') || upperQuery.includes('DELETE')) return 'write';
    if (upperQuery.includes('BEGIN') || upperQuery.includes('COMMIT')) return 'transaction';
    return 'read';
  }

  private extractTables(query: string): string[] {
    const tables: string[] = [];
    const upperQuery = query.toUpperCase();
    
    const fromMatch = upperQuery.match(/FROM\s+(\w+)/);
    if (fromMatch) tables.push(fromMatch[1]);
    
    const joinMatches = upperQuery.match(/JOIN\s+(\w+)/g);
    if (joinMatches) {
      tables.push(...joinMatches.map(match => match.split(' ')[1]));
    }
    
    return [...new Set(tables)];
  }

  private calculateQueryComplexity(query: string): number {
    let complexity = 1;
    const upperQuery = query.toUpperCase();
    
    if (upperQuery.includes('JOIN')) complexity += 2;
    if (upperQuery.includes('SUBQUERY') || query.includes('(SELECT')) complexity += 3;
    if (upperQuery.includes('GROUP BY')) complexity += 1;
    if (upperQuery.includes('ORDER BY')) complexity += 1;
    if (upperQuery.includes('HAVING')) complexity += 2;
    
    return Math.min(complexity, 10);
  }

  private calculateRiskImpact(riskLevel: 'low' | 'medium' | 'high', dependentCount: number): string {
    const baseImpact = riskLevel === 'high' ? 'High' : riskLevel === 'medium' ? 'Medium' : 'Low';
    const scopeImpact = dependentCount > 12 ? 'system-wide' : dependentCount > 6 ? 'module-wide' : 'localized';
    return `${baseImpact} impact, ${scopeImpact} scope`;
  }

  private hasCorrespondingTest(component: ComponentNode, components: ComponentNode[]): boolean {
    const componentName = component.name;
    const testFiles = components.filter(c => this.isTestFile(c.path));
    
    return testFiles.some(test => 
      test.path.includes(`${componentName}Test`) || 
      test.path.includes(`${componentName}IT`) ||
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
    return `/${relativePath.replace(/\\/g, '/').replace(/\.java$/, '')}`;
  }
}