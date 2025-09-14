// Python Base Analyzer - Comprehensive AST-based analysis for Python projects
// Phase 2: Language Base Analyzers - Production-ready Python analyzer

import { BaseAnalyzer, LanguageDetection, ComponentDiscovery, FrameworkDetection } from '../base-analyzer';
import { ComponentNode, ComponentType, Connection, RiskArea, CallGraph, DatabaseConnection, TestCoverage, APIEndpoint } from '../../types';
import { telemetry } from '../../telemetry/telemetry-schema';
import { AnalyzerError } from '../errors';
import * as path from 'path';
import * as fs from 'fs-extra';

export class PythonAnalyzer extends BaseAnalyzer {
  private pythonVersion: string = '';
  
  getAnalyzerName(): string {
    return 'Python Analyzer';
  }

  getSupportedLanguages(): string[] {
    return ['python'];
  }

  getSupportedFrameworks(): string[] {
    return [
      'django', 'flask', 'fastapi', 'pyramid', 'tornado', 'bottle',
      'celery', 'airflow', 'scrapy', 'django-rest-framework',
      'pytest', 'unittest', 'nose2', 'doctest',
      'pandas', 'numpy', 'scipy', 'matplotlib', 'sklearn',
      'tensorflow', 'pytorch', 'keras', 'transformers',
      'requests', 'aiohttp', 'httpx', 'urllib3',
      'sqlalchemy', 'django-orm', 'peewee', 'tortoise-orm',
      'pydantic', 'marshmallow', 'cerberus'
    ];
  }

  protected async detectLanguageAndFramework(): Promise<LanguageDetection> {
    const span = telemetry.createSpan('python-analyzer.detectLanguageAndFramework');
    let confidence = 0;
    const frameworks: FrameworkDetection[] = [];
    const files: string[] = [];

    try {
      // Check for Python files
      const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
      files.push(...pythonFiles);
      
      if (pythonFiles.length > 0) {
        confidence += 0.4;
      }

      // Check for Python-specific files
      const pythonSpecificFiles = [
        'requirements.txt', 'setup.py', 'setup.cfg', 'pyproject.toml', 
        'Pipfile', 'poetry.lock', 'environment.yml', 'manage.py',
        '__init__.py', 'wsgi.py', 'asgi.py'
      ];

      for (const file of pythonSpecificFiles) {
        const filePath = path.join(this.projectPath, file);
        if (await fs.pathExists(filePath)) {
          confidence += 0.1;
          files.push(filePath);
          
          // Special handling for Django
          if (file === 'manage.py') {
            frameworks.push({
              name: 'django',
              version: await this.detectDjangoVersion(),
              confidence: 0.9,
              patterns: ['manage.py found'],
              configFiles: ['settings.py', 'urls.py', 'wsgi.py'],
              dependencies: ['django']
            });
          }
        }
      }

      // Analyze requirements and dependencies
      const detectedFrameworks = await this.analyzeRequirementsFiles();
      frameworks.push(...detectedFrameworks);

      // Analyze Python files for framework patterns
      if (pythonFiles.length > 0) {
        const codeFrameworks = await this.analyzeCodeForFrameworks(pythonFiles.slice(0, 20)); // Sample first 20 files
        frameworks.push(...codeFrameworks);
      }

      // Detect Python version and environment
      await this.detectPythonEnvironment();

      confidence = Math.min(confidence, 1.0);
      
      telemetry.emit({
        type: 'analysis_started',
        source: { analyzer: this.getAnalyzerName() },
        data: {
          language: 'python',
          confidence,
          filesCount: files.length,
          frameworksFound: frameworks.length,
          pythonVersion: this.pythonVersion
        }
      });

      span.end();
      return {
        language: 'python',
        confidence,
        frameworks: frameworks.sort((a, b) => b.confidence - a.confidence),
        files
      };
    } catch (error) {
      span.end();
      throw new AnalyzerError(
        `Python language detection failed: ${(error as Error).message}`,
        'DETECTION_ERROR',
        { error }
      );
    }
  }

  protected async discoverComponents(): Promise<ComponentDiscovery> {
    const span = telemetry.createSpan('python-analyzer.discoverComponents');
    const components: ComponentNode[] = [];
    let totalFiles = 0;
    let analyzedFiles = 0;
    let skippedFiles = 0;

    try {
      const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
      totalFiles = pythonFiles.length;

      console.log(`🐍 Analyzing ${totalFiles} Python files...`);

      for (const filePath of pythonFiles) {
        try {
          const component = await this.analyzeFile(filePath);
          if (component) {
            components.push(component);
            analyzedFiles++;
          } else {
            skippedFiles++;
          }
        } catch (error) {
          console.warn(`⚠️ Failed to analyze ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
          skippedFiles++;
        }

        // Progress reporting
        if ((analyzedFiles + skippedFiles) % 100 === 0) {
          const progress = ((analyzedFiles + skippedFiles) / totalFiles) * 100;
          console.log(`📊 Progress: ${progress.toFixed(1)}% (${analyzedFiles + skippedFiles}/${totalFiles})`);
        }
      }

      console.log(`✅ Python analysis complete: ${analyzedFiles} analyzed, ${skippedFiles} skipped`);

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
        `Python component discovery failed: ${(error as Error).message}`,
        'DISCOVERY_ERROR',
        { error }
      );
    }
  }

  protected async analyzeConnections(components: ComponentNode[]): Promise<Connection[]> {
    const span = telemetry.createSpan('python-analyzer.analyzeConnections');
    const connections: Connection[] = [];

    try {
      console.log(`🔗 Analyzing Python connections between ${components.length} components...`);

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
      }

      // Remove duplicate connections and aggregate weights
      const connectionMap = new Map<string, Connection>();
      for (const conn of connections) {
        const key = `${conn.from}-${conn.to}-${conn.type}`;
        const existing = connectionMap.get(key);
        if (existing) {
          existing.weight = (existing.weight || 0) + (conn.weight || 0);
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
        `Python connection analysis failed: ${(error as Error).message}`,
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
      if (component.metadata.lineCount > 1000) {
        reasons.push(`Large file (${component.metadata.lineCount} lines)`);
        riskLevel = 'high';
      } else if (component.metadata.lineCount > 500) {
        reasons.push(`Large file (${component.metadata.lineCount} lines)`);
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // Many dependencies
      const incomingConnections = connections.filter(c => c.to === component.id).length;
      if (incomingConnections > 10) {
        reasons.push(`High fan-in (${incomingConnections} dependents)`);
        riskLevel = 'high';
      }

      // Database connections without error handling
      if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
        reasons.push('Database operations detected');
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }

      // External API calls
      if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) {
        reasons.push('External API calls detected');
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
      critical: comp.metadata.complexity >= 7 || comp.dependents.length > 8
    }));

    const edges = components.flatMap(comp => 
      comp.dependencies.map(dep => ({
        from: comp.id,
        to: dep,
        count: 1,
        type: 'direct' as const,
        async: false,
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
    const connectionPatterns = [
      { type: 'postgresql', patterns: ['psycopg2', 'asyncpg', 'postgresql://'] },
      { type: 'mysql', patterns: ['pymysql', 'mysql.connector', 'mysql://'] },
      { type: 'mongodb', patterns: ['pymongo', 'motor', 'mongodb://'] },
      { type: 'redis', patterns: ['redis-py', 'aioredis', 'redis://'] },
      { type: 'sqlite', patterns: ['sqlite3', 'aiosqlite', 'sqlite://'] }
    ];

    for (const component of components) {
      if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
        for (const pattern of connectionPatterns) {
          const hasPattern = pattern.patterns.some(p => 
            component.metadata.imports.some(imp => imp.includes(p)) ||
            component.metadata.dbQueries!.some(query => query.includes(p))
          );

          if (hasPattern) {
            connections.push({
              id: `db_${pattern.type}_${component.id}`,
              name: `${pattern.type} connection`,
              type: pattern.type as any,
              componentIds: [component.id],
              usage: [{
                componentId: component.id,
                operations: component.metadata.dbQueries!.map(query => ({
                  type: this.getQueryType(query),
                  tables: this.extractTables(query),
                  complexity: this.calculateQueryComplexity(query),
                  optimized: false
                })),
                frequency: component.metadata.dbQueries!.length,
                critical: component.metadata.complexity >= 6
              }]
            });
          }
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

    const totalLines = sourceFiles.reduce((sum, c) => sum + c.metadata.lineCount, 0);
    const estimatedCoveredLines = Math.min(testFiles.length * 50, totalLines * 0.8);

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
        unit: testFiles.filter(f => f.path.includes('test_')).length,
        integration: testFiles.filter(f => f.path.includes('integration')).length,
        e2e: testFiles.filter(f => f.path.includes('e2e')).length
      },
      uncoveredFiles: sourceFiles.filter(c => !this.hasCorrespondingTest(c, testFiles)).map(c => c.path)
    };
  }

  // Private helper methods
  private async analyzeFile(filePath: string): Promise<ComponentNode | null> {
    try {
      const content = await this.readFile(filePath);
      const relativePath = path.relative(this.projectPath, filePath);
      
      // Skip empty files or files that are too large
      if (content.length === 0 || content.length > (this.options.maxFileSize || 1024 * 1024)) {
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
          functions: await this.extractFunctions(content, 'python'),
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
        `Failed to analyze Python file ${filePath}: ${(error as Error).message}`,
        'FILE_ANALYSIS_ERROR',
        { filePath, error }
      );
    }
  }

  private determineComponentType(filePath: string, content: string): ComponentType {
    const fileName = path.basename(filePath).toLowerCase();
    
    // Test files
    if (this.isTestFile(filePath)) {
      return 'utility';
    }
    
    // Django specific
    if (fileName === 'models.py' || content.includes('class Meta:') || content.includes('models.Model')) {
      return 'model';
    }
    
    if (fileName === 'views.py' || content.includes('def view') || content.includes('class.*View')) {
      return 'controller';
    }
    
    if (fileName === 'urls.py' || content.includes('urlpatterns') || content.includes('path(')) {
      return 'route';
    }
    
    if (fileName === 'settings.py' || fileName === 'config.py') {
      return 'config';
    }
    
    if (fileName === 'middleware.py' || content.includes('MiddlewareMixin')) {
      return 'middleware';
    }

    // Flask specific
    if (content.includes('@app.route') || content.includes('@bp.route')) {
      return 'route';
    }

    // FastAPI specific
    if (content.includes('@app.get') || content.includes('@app.post') || content.includes('APIRouter')) {
      return 'route';
    }

    // Service classes
    if (content.includes('class.*Service') || fileName.includes('service')) {
      return 'service';
    }

    // Utility or helper files
    if (fileName.includes('util') || fileName.includes('helper') || fileName.includes('tool')) {
      return 'utility';
    }

    // Database related
    if (content.includes('CREATE TABLE') || content.includes('SELECT') || content.includes('engine') && content.includes('database')) {
      return 'database';
    }

    return 'utility';
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Standard imports: import module, from module import item
      const importMatch = trimmed.match(/^(?:from\s+(\S+)\s+import|import\s+(\S+))/);
      if (importMatch) {
        const module = importMatch[1] || importMatch[2];
        if (module && !module.startsWith('.')) {
          imports.push(module.split('.')[0]);
        }
      }
    }

    return [...new Set(imports)];
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    
    // Find class definitions
    const classMatches = content.match(/^class\s+(\w+)/gm);
    if (classMatches) {
      exports.push(...classMatches.map(match => match.split(/\s+/)[1]));
    }

    // Find function definitions
    const functionMatches = content.match(/^def\s+(\w+)/gm);
    if (functionMatches) {
      exports.push(...functionMatches.map(match => match.split(/\s+/)[1]));
    }

    // Find __all__ definitions
    const allMatch = content.match(/__all__\s*=\s*\[(.*?)\]/s);
    if (allMatch) {
      const items = allMatch[1].match(/"([^"]+)"|'([^']+)'/g);
      if (items) {
        exports.push(...items.map(item => item.slice(1, -1)));
      }
    }

    return [...new Set(exports)];
  }

  private extractHttpMethods(content: string): string[] {
    const methods: string[] = [];
    
    // Django patterns
    const djangoMatches = content.match(/@.*route.*\(['"].*['"],?\s*methods=\[([^\]]+)\]/g);
    if (djangoMatches) {
      for (const match of djangoMatches) {
        const methodsMatch = match.match(/methods=\[([^\]]+)\]/);
        if (methodsMatch) {
          const methodList = methodsMatch[1].split(',').map(m => m.trim().replace(/['"]/g, ''));
          methods.push(...methodList);
        }
      }
    }

    // Flask/FastAPI patterns
    const decoratorMethods = content.match(/@\w*\.(get|post|put|delete|patch|head|options)/g);
    if (decoratorMethods) {
      methods.push(...decoratorMethods.map(match => match.split('.')[1].toUpperCase()));
    }

    return [...new Set(methods)];
  }

  private extractDatabaseQueries(content: string): string[] {
    const queries: string[] = [];
    
    // SQL patterns
    const sqlPatterns = [
      /['"`](SELECT.*?)['"`]/gis,
      /['"`](INSERT.*?)['"`]/gis,
      /['"`](UPDATE.*?)['"`]/gis,
      /['"`](DELETE.*?)['"`]/gis,
      /['"`](CREATE.*?)['"`]/gis,
      /['"`](DROP.*?)['"`]/gis
    ];

    for (const pattern of sqlPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        queries.push(...matches.map(match => match.slice(1, -1)));
      }
    }

    // Django ORM patterns
    const ormMatterns = content.match(/\w+\.objects\.\w+\([^)]*\)/g);
    if (ormMatterns) {
      queries.push(...ormMatterns);
    }

    return queries;
  }

  private extractExternalCalls(content: string): string[] {
    const calls: string[] = [];
    
    // HTTP requests
    const httpPatterns = [
      /requests\.(get|post|put|delete|patch)\s*\(['"]([^'"]+)['"]/g,
      /httpx\.(get|post|put|delete|patch)\s*\(['"]([^'"]+)['"]/g,
      /urllib\.request\.urlopen\s*\(['"]([^'"]+)['"]/g
    ];

    for (const pattern of httpPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        calls.push(`${match[1].toUpperCase()} ${match[2]}`);
      }
    }

    return calls;
  }

  private determineArchitecturalLayer(filePath: string, content: string): any {
    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();

    if (fileName.includes('view') || fileName.includes('controller') || content.includes('@app.route')) {
      return 'presentation';
    }

    if (fileName.includes('model') || fileName.includes('entity') || content.includes('models.Model')) {
      return 'data';
    }

    if (fileName.includes('service') || fileName.includes('business') || dirName.includes('business')) {
      return 'business';
    }

    if (fileName.includes('util') || fileName.includes('helper') || fileName.includes('config')) {
      return 'infrastructure';
    }

    if (content.includes('requests.') || content.includes('httpx.')) {
      return 'external';
    }

    return 'infrastructure';
  }

  private extractResponsibilities(filePath: string, content: string): string[] {
    const responsibilities: string[] = [];
    
    if (content.includes('@app.route') || content.includes('@bp.route')) {
      responsibilities.push('HTTP request handling');
    }
    
    if (content.includes('models.Model') || content.includes('CREATE TABLE')) {
      responsibilities.push('Data modeling');
    }
    
    if (content.includes('requests.') || content.includes('httpx.')) {
      responsibilities.push('External API communication');
    }
    
    if (this.isTestFile(filePath)) {
      responsibilities.push('Testing');
    }
    
    if (content.includes('class.*Service')) {
      responsibilities.push('Business logic');
    }

    return responsibilities.length > 0 ? responsibilities : ['General utility'];
  }

  private isTestFile(filePath: string): boolean {
    const fileName = path.basename(filePath).toLowerCase();
    return fileName.startsWith('test_') || 
           fileName.endsWith('_test.py') ||
           filePath.includes('/tests/') ||
           filePath.includes('/test/');
  }

  private isEntryPoint(filePath: string, content: string): boolean {
    const fileName = path.basename(filePath);
    
    return fileName === 'main.py' ||
           fileName === 'app.py' ||
           fileName === 'manage.py' ||
           fileName === 'wsgi.py' ||
           fileName === 'asgi.py' ||
           content.includes('if __name__ == "__main__"') ||
           content.includes('app = FastAPI()') ||
           content.includes('app = Flask(__name__)');
  }

  private async detectPythonEnvironment(): Promise<void> {
    try {
      // Basic environment detection for version info
      const hasVirtualEnv = await fs.pathExists(path.join(this.projectPath, 'venv')) ||
                           await fs.pathExists(path.join(this.projectPath, 'env')) ||
                           await fs.pathExists(path.join(this.projectPath, '.venv'));
      
      if (hasVirtualEnv) {
        this.pythonVersion = 'virtual-env-detected';
      }
    } catch (error) {
      // Ignore errors in environment detection
    }
  }

  private async analyzeRequirementsFiles(): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const requirementsFiles = ['requirements.txt', 'requirements-dev.txt', 'Pipfile', 'pyproject.toml', 'setup.py'];

    for (const file of requirementsFiles) {
      const filePath = path.join(this.projectPath, file);
      if (await fs.pathExists(filePath)) {
        const content = await fs.readFile(filePath, 'utf-8');
        const detected = this.detectFrameworksFromDependencies(content, file);
        frameworks.push(...detected);
      }
    }

    return frameworks;
  }

  private detectFrameworksFromDependencies(content: string, fileName: string): FrameworkDetection[] {
    const frameworks: FrameworkDetection[] = [];
    const lines = content.toLowerCase().split('\n');
    
    const frameworkPatterns = {
      django: { patterns: ['django==', 'django>=', 'django~='], confidence: 0.9 },
      flask: { patterns: ['flask==', 'flask>=', 'flask~='], confidence: 0.9 },
      fastapi: { patterns: ['fastapi==', 'fastapi>=', 'fastapi~='], confidence: 0.9 },
      pyramid: { patterns: ['pyramid==', 'pyramid>=', 'pyramid~='], confidence: 0.9 },
      tornado: { patterns: ['tornado==', 'tornado>=', 'tornado~='], confidence: 0.8 },
      celery: { patterns: ['celery==', 'celery>=', 'celery~='], confidence: 0.8 },
      pytest: { patterns: ['pytest==', 'pytest>=', 'pytest~='], confidence: 0.7 },
      pandas: { patterns: ['pandas==', 'pandas>=', 'pandas~='], confidence: 0.8 },
      numpy: { patterns: ['numpy==', 'numpy>=', 'numpy~='], confidence: 0.8 },
      tensorflow: { patterns: ['tensorflow==', 'tensorflow>=', 'tensorflow~='], confidence: 0.9 },
      pytorch: { patterns: ['torch==', 'torch>=', 'torch~='], confidence: 0.9 }
    };

    for (const [name, config] of Object.entries(frameworkPatterns)) {
      for (const pattern of config.patterns) {
        const matchingLines = lines.filter(line => line.includes(pattern));
        if (matchingLines.length > 0) {
          const version = this.extractVersionFromDependency(matchingLines[0]);
          frameworks.push({
            name,
            version,
            confidence: config.confidence,
            patterns: [`Found in ${fileName}`],
            configFiles: [fileName],
            dependencies: [name]
          });
          break; // Only add once per framework
        }
      }
    }

    return frameworks;
  }

  private extractVersionFromDependency(line: string): string | undefined {
    const versionMatch = line.match(/[>=~]+([0-9.]+)/);
    return versionMatch ? versionMatch[1] : undefined;
  }

  private async analyzeCodeForFrameworks(files: string[]): Promise<FrameworkDetection[]> {
    const frameworks: FrameworkDetection[] = [];
    const frameworkIndicators = new Map<string, { count: number, files: Set<string> }>();

    for (const filePath of files) {
      try {
        const content = await this.readFile(filePath);
        
        // Django indicators
        if (content.includes('from django') || content.includes('import django')) {
          this.updateFrameworkIndicator(frameworkIndicators, 'django', filePath);
        }
        
        // Flask indicators
        if (content.includes('from flask') || content.includes('@app.route')) {
          this.updateFrameworkIndicator(frameworkIndicators, 'flask', filePath);
        }
        
        // FastAPI indicators
        if (content.includes('from fastapi') || content.includes('APIRouter')) {
          this.updateFrameworkIndicator(frameworkIndicators, 'fastapi', filePath);
        }

        // Add more framework detection patterns as needed
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

  protected async detectDjangoVersion(): Promise<string | undefined> {
    try {
      // Try to find Django version in requirements or setup files
      const requirementsPath = path.join(this.projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const content = await fs.readFile(requirementsPath, 'utf-8');
        const versionMatch = content.match(/django[>=~]+([0-9.]+)/i);
        if (versionMatch) {
          return versionMatch[1];
        }
      }
    } catch (error) {
      // Ignore errors
    }
    return undefined;
  }

  private findComponentByImportPath(components: ComponentNode[], importPath: string): ComponentNode | undefined {
    return components.find(c => {
      const moduleName = path.basename(c.path, path.extname(c.path));
      return importPath.includes(moduleName) || c.metadata.exports.some(exp => importPath.includes(exp));
    });
  }

  private findComponentByFunctionCall(components: ComponentNode[], functionName: string): ComponentNode | undefined {
    return components.find(c => c.metadata.exports.includes(functionName));
  }

  private getCallGraphNodeType(componentType: ComponentType): 'function' | 'method' | 'class' | 'module' {
    switch (componentType) {
      case 'route':
      case 'controller':
        return 'method';
      case 'model':
        return 'class';
      case 'service':
        return 'class';
      default:
        return 'module';
    }
  }

  private calculateRiskImpact(riskLevel: 'low' | 'medium' | 'high', dependentCount: number): string {
    const baseImpact = riskLevel === 'high' ? 'High' : riskLevel === 'medium' ? 'Medium' : 'Low';
    const scopeImpact = dependentCount > 10 ? 'system-wide' : dependentCount > 5 ? 'module-wide' : 'localized';
    return `${baseImpact} impact, ${scopeImpact} scope`;
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
    if (upperQuery.includes('SUBQUERY') || upperQuery.includes('(SELECT')) complexity += 3;
    if (upperQuery.includes('GROUP BY')) complexity += 1;
    if (upperQuery.includes('ORDER BY')) complexity += 1;
    if (upperQuery.includes('HAVING')) complexity += 2;
    
    return Math.min(complexity, 10);
  }

  private hasCorrespondingTest(component: ComponentNode, testFiles: ComponentNode[]): boolean {
    const componentName = path.basename(component.path, path.extname(component.path));
    return testFiles.some(test => 
      test.path.includes(`test_${componentName}`) || 
      test.path.includes(`${componentName}_test`)
    );
  }

  protected async analyzeAPIEndpoints(components: ComponentNode[]): Promise<APIEndpoint[]> {
    const endpoints: APIEndpoint[] = [];
    
    for (const component of components) {
      if (component.type === 'route' || component.metadata.httpMethods) {
        const methods = component.metadata.httpMethods || ['GET'];
        for (const method of methods) {
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
    return `/${relativePath.replace(/\\/g, '/').replace('.py', '')}`;
  }
}