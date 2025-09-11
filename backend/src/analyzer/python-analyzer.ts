import { BaseAnalyzer, AnalyzerOptions, LanguageDetection, FrameworkDetection, ComponentDiscovery } from './base-analyzer';
import { 
  ComponentNode, ComponentType, Connection, ConnectionType, RiskArea,
  EntryPoint, ExitPoint, CallGraph, DatabaseConnection, TestCoverage, CallGraphNode,
  CallGraphEdge, FunctionInfo, APIEndpoint
} from '../types';
import * as path from 'path';
import * as fs from 'fs-extra';

export class PythonAnalyzer extends BaseAnalyzer {
  private pythonFrameworks = {
    django: {
      files: ['manage.py', 'settings.py', 'urls.py', 'wsgi.py', 'asgi.py'],
      imports: ['django', 'django.conf', 'django.urls', 'django.http'],
      patterns: [
        /from django/,
        /import django/,
        /django\.contrib/,
        /path\(/,
        /urlpatterns/,
        /@login_required/,
        /class.*\(Model\)/,
        /class.*\(View\)/
      ]
    },
    flask: {
      files: ['app.py', 'application.py', 'run.py'],
      imports: ['flask', 'Flask'],
      patterns: [
        /from flask/,
        /import flask/,
        /Flask\(__name__\)/,
        /@app\.route/,
        /app\.run/
      ]
    },
    fastapi: {
      files: ['main.py', 'app.py'],
      imports: ['fastapi', 'FastAPI'],
      patterns: [
        /from fastapi/,
        /import fastapi/,
        /FastAPI\(/,
        /@app\.(get|post|put|delete)/,
        /async def/
      ]
    },
    pytest: {
      files: ['conftest.py', 'pytest.ini'],
      imports: ['pytest'],
      patterns: [
        /import pytest/,
        /def test_/,
        /@pytest\./,
        /assert /
      ]
    }
  };

  getAnalyzerName(): string {
    return 'Python Analyzer';
  }

  getSupportedLanguages(): string[] {
    return ['python'];
  }

  getSupportedFrameworks(): string[] {
    return ['django', 'flask', 'fastapi', 'pytest'];
  }

  protected async detectLanguageAndFramework(): Promise<LanguageDetection> {
    const pythonFiles = await this.findFiles(['**/*.py'], ['**/venv/**', '**/env/**', '**/__pycache__/**']);
    
    if (pythonFiles.length === 0) {
      throw new Error('No Python files found in project');
    }

    const frameworks: FrameworkDetection[] = [];
    let totalConfidence = 0;

    // Check for framework indicators
    for (const [frameworkName, config] of Object.entries(this.pythonFrameworks)) {
      let confidence = 0;
      const indicators: string[] = [];

      // Check for framework-specific files
      for (const file of config.files) {
        const exists = await fs.pathExists(path.join(this.projectPath, file));
        if (exists) {
          confidence += 0.4;
          indicators.push(`File: ${file}`);
        }
      }

      // Check requirements.txt for dependencies
      try {
        const requirementsPath = path.join(this.projectPath, 'requirements.txt');
        const requirements = await this.readFile(requirementsPath);
        for (const imp of config.imports) {
          if (requirements.includes(imp)) {
            confidence += 0.3;
            indicators.push(`Dependency: ${imp}`);
          }
        }
      } catch {}

      // Check pyproject.toml
      try {
        const pyprojectPath = path.join(this.projectPath, 'pyproject.toml');
        const pyproject = await this.readFile(pyprojectPath);
        for (const imp of config.imports) {
          if (pyproject.includes(imp)) {
            confidence += 0.3;
            indicators.push(`Dependency: ${imp}`);
          }
        }
      } catch {}

      // Sample files for code patterns
      for (const file of pythonFiles.slice(0, 20)) {
        try {
          const content = await this.readFile(file);
          for (const pattern of config.patterns) {
            if (pattern.test(content)) {
              confidence += 0.1;
              indicators.push(`Pattern: ${pattern.source}`);
            }
          }
        } catch {}
      }

      if (confidence > 0.3) {
        frameworks.push({
          name: frameworkName,
          confidence: Math.min(confidence, 1.0),
          patterns: indicators,
          configFiles: config.files
        });
        totalConfidence = Math.max(totalConfidence, confidence);
      }
    }

    return {
      language: 'python',
      confidence: totalConfidence > 0 ? totalConfidence : 0.8,
      frameworks,
      files: pythonFiles
    };
  }

  protected async discoverComponents(): Promise<ComponentDiscovery> {
    const pythonFiles = await this.findFiles(['**/*.py'], ['**/venv/**', '**/env/**', '**/__pycache__/**']);
    const components: ComponentNode[] = [];

    for (const file of pythonFiles) {
      try {
        const content = await this.readFile(file);
        const component = await this.analyzeFile(file, content);
        if (component) {
          components.push(component);
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }

    return {
      totalFiles: pythonFiles.length,
      analyzedFiles: components.length,
      skippedFiles: pythonFiles.length - components.length,
      components
    };
  }

  private async analyzeFile(filePath: string, content: string): Promise<ComponentNode | null> {
    const relativePath = path.relative(this.projectPath, filePath);
    const fileName = path.basename(filePath, '.py');

    // Determine component type based on patterns
    const componentType = this.determineComponentType(content, relativePath);
    const functions = await this.extractPythonFunctions(content);
    const imports = this.extractImports(content);
    const exports = this.extractExports(content);

    return {
      id: this.generateComponentId(filePath),
      name: fileName,
      type: componentType,
      path: relativePath,
      dependencies: [], // Will be populated during connection analysis
      dependents: [],
      metadata: {
        lineCount: content.split('\n').length,
        complexity: this.calculateComplexity(content),
        lastModified: new Date(),
        exports,
        imports,
        isEntry: this.isEntryPoint(content, relativePath),
        isOrphaned: false,
        layer: this.determineLayer(componentType, relativePath),
        responsibilities: this.getResponsibilities(componentType, content),
        functions,
        testCoverage: this.calculateTestCoverage(content, filePath)
      }
    };
  }

  private determineComponentType(content: string, filePath: string): ComponentType {
    const pathLower = filePath.toLowerCase();
    
    // Django patterns
    if (content.includes('class') && content.includes('(Model)')) return 'model';
    if (content.includes('class') && content.includes('(View)')) return 'route';
    if (pathLower.includes('urls.py') || content.includes('urlpatterns')) return 'route';
    if (pathLower.includes('models.py')) return 'model';
    if (pathLower.includes('views.py')) return 'route';
    if (pathLower.includes('serializers.py')) return 'middleware';
    
    // Flask patterns
    if (content.includes('@app.route') || content.includes('@blueprint.route')) return 'route';
    
    // FastAPI patterns
    if (content.includes('@app.get') || content.includes('@app.post') || 
        content.includes('@router.get') || content.includes('@router.post')) return 'route';
    
    // General patterns
    if (pathLower.includes('test_') || pathLower.includes('_test.py')) return 'utility';
    if (pathLower.includes('config') || pathLower.includes('settings')) return 'config';
    if (pathLower.includes('database') || pathLower.includes('db')) return 'database';
    if (pathLower.includes('service') || pathLower.includes('business')) return 'service';
    if (pathLower.includes('util') || pathLower.includes('helper')) return 'utility';
    if (pathLower.includes('middleware')) return 'middleware';
    
    return 'service';
  }

  private determineLayer(componentType: ComponentType, filePath: string): any {
    const pathLower = filePath.toLowerCase();
    
    if (componentType === 'route' || pathLower.includes('view') || pathLower.includes('controller')) {
      return 'presentation';
    }
    if (componentType === 'model' || pathLower.includes('model') || pathLower.includes('entity')) {
      return 'data';
    }
    if (componentType === 'service' || pathLower.includes('service') || pathLower.includes('business')) {
      return 'business';
    }
    if (componentType === 'middleware' || componentType === 'config') {
      return 'infrastructure';
    }
    
    return 'business';
  }

  private getResponsibilities(componentType: ComponentType, content: string): string[] {
    const responsibilities: string[] = [];
    
    switch (componentType) {
      case 'route':
        if (content.includes('GET') || content.includes('@app.route')) responsibilities.push('HTTP endpoints');
        if (content.includes('POST')) responsibilities.push('Data submission');
        if (content.includes('authentication') || content.includes('login')) responsibilities.push('Authentication');
        break;
      case 'model':
        responsibilities.push('Data persistence');
        if (content.includes('def save')) responsibilities.push('Data validation');
        if (content.includes('ForeignKey') || content.includes('relationship')) responsibilities.push('Data relationships');
        break;
      case 'service':
        responsibilities.push('Business logic');
        if (content.includes('def process') || content.includes('def handle')) responsibilities.push('Data processing');
        break;
      case 'middleware':
        responsibilities.push('Cross-cutting concerns');
        if (content.includes('auth') || content.includes('permission')) responsibilities.push('Authorization');
        break;
    }
    
    return responsibilities.length > 0 ? responsibilities : ['General functionality'];
  }

  private isEntryPoint(content: string, filePath: string): boolean {
    return content.includes('if __name__ == "__main__"') ||
           content.includes('@app.route') ||
           content.includes('@router.') ||
           content.includes('urlpatterns') ||
           filePath.includes('main.py') ||
           filePath.includes('manage.py') ||
           filePath.includes('app.py');
  }

  private async extractPythonFunctions(content: string): Promise<FunctionInfo[]> {
    const functions: FunctionInfo[] = [];
    const lines = content.split('\n');
    
    // Function definition pattern
    const funcPattern = /^(\s*)(async\s+)?def\s+(\w+)\s*\([^)]*\)(\s*->\s*[^:]+)?:/;
    const classPattern = /^(\s*)class\s+(\w+)/;
    
    let currentClass = '';
    let currentIndent = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const classMatch = line.match(classPattern);
      const funcMatch = line.match(funcPattern);
      
      if (classMatch) {
        currentClass = classMatch[2];
        currentIndent = classMatch[1].length;
      } else if (funcMatch) {
        const indent = funcMatch[1].length;
        const isAsync = !!funcMatch[2];
        const funcName = funcMatch[3];
        const returnType = funcMatch[4] ? funcMatch[4].replace('->', '').trim() : 'None';
        
        // Reset class context if function is at same or lower indent level
        if (indent <= currentIndent) {
          currentClass = '';
        }
        
        const fullName = currentClass ? `${currentClass}.${funcName}` : funcName;
        const signature = line.trim();
        
        // Extract function body to analyze complexity
        const functionLines = this.extractFunctionBody(lines, i);
        const complexity = this.calculateFunctionComplexity(functionLines.join('\n'));
        
        functions.push({
          name: fullName,
          signature,
          parameters: this.extractPythonParameters(signature),
          returnType,
          complexity,
          lineCount: functionLines.length,
          isPublic: !funcName.startsWith('_'),
          isAsync,
          isStatic: signature.includes('@staticmethod'),
          calls: [],
          calledBy: []
        });
      }
    }
    
    return functions;
  }

  private extractFunctionBody(lines: string[], startIndex: number): string[] {
    const functionLines: string[] = [lines[startIndex]];
    const defLine = lines[startIndex];
    const baseIndent = defLine.length - defLine.trimLeft().length;
    
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        functionLines.push(line);
        continue;
      }
      
      const currentIndent = line.length - line.trimLeft().length;
      if (currentIndent <= baseIndent && line.trim().length > 0) {
        break; // End of function
      }
      
      functionLines.push(line);
    }
    
    return functionLines;
  }

  protected calculateFunctionComplexity(functionContent: string): number {
    const complexityPatterns = [
      /\bif\b/g, /\belif\b/g, /\belse\b/g, /\bwhile\b/g, /\bfor\b/g,
      /\btry\b/g, /\bexcept\b/g, /\bfinally\b/g, /\braise\b/g,
      /\breturn\b/g, /\band\b/g, /\bor\b/g, /\bnot\b/g,
      /\?\s*:/g // Ternary operators
    ];

    let complexity = 1; // Base complexity
    for (const pattern of complexityPatterns) {
      const matches = functionContent.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return Math.min(complexity, 10);
  }

  private extractPythonParameters(signature: string): any[] {
    const paramMatch = signature.match(/def\s+\w+\s*\(([^)]*)\)/);
    if (!paramMatch || !paramMatch[1]) return [];

    const params = paramMatch[1].split(',').map(p => p.trim()).filter(p => p && p !== 'self');
    return params.map(param => {
      const parts = param.split(':');
      const name = parts[0].trim().replace(/^\*+/, '');
      const type = parts[1] ? parts[1].split('=')[0].trim() : 'Any';
      const hasDefault = param.includes('=');
      
      return {
        name,
        type,
        isOptional: hasDefault || param.includes('*'),
        defaultValue: hasDefault ? param.split('=')[1]?.trim() : undefined
      };
    });
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // import module
      const importMatch = trimmed.match(/^import\s+([\w.]+)/);
      if (importMatch) {
        imports.push(importMatch[1]);
        continue;
      }
      
      // from module import item
      const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import/);
      if (fromMatch) {
        imports.push(fromMatch[1]);
        continue;
      }
    }
    
    return imports;
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    
    // Python doesn't have explicit exports, so we look for public functions/classes
    const publicFunctions = content.match(/^def\s+([a-zA-Z][a-zA-Z0-9_]*)/gm);
    const publicClasses = content.match(/^class\s+([a-zA-Z][a-zA-Z0-9_]*)/gm);
    
    if (publicFunctions) {
      exports.push(...publicFunctions.map(f => f.replace('def ', '')));
    }
    
    if (publicClasses) {
      exports.push(...publicClasses.map(c => c.replace('class ', '')));
    }
    
    // Check for __all__ declaration
    const allMatch = content.match(/__all__\s*=\s*\[(.*?)\]/s);
    if (allMatch) {
      const allItems = allMatch[1].match(/'([^']+)'|"([^"]+)"/g);
      if (allItems) {
        exports.push(...allItems.map(item => item.slice(1, -1)));
      }
    }
    
    return [...new Set(exports)];
  }

  private calculateTestCoverage(content: string, filePath: string): number {
    // Basic heuristic for test coverage
    if (filePath.includes('test_') || filePath.includes('_test.py')) {
      return 100; // Test files have 100% "coverage" themselves
    }
    
    const hasTests = content.includes('def test_') || content.includes('class Test');
    return hasTests ? 80 : 0;
  }

  protected async analyzeConnections(components: ComponentNode[]): Promise<Connection[]> {
    const connections: Connection[] = [];
    const componentsByPath = new Map<string, ComponentNode>();
    
    // Build path lookup
    for (const component of components) {
      componentsByPath.set(component.path, component);
    }
    
    for (const component of components) {
      try {
        const fullPath = path.join(this.projectPath, component.path);
        const content = await this.readFile(fullPath);
        
        // Extract imports and create connections
        const imports = this.extractImports(content);
        
        for (const importPath of imports) {
          const resolvedPath = this.resolvePythonImport(importPath, component.path);
          const targetComponent = componentsByPath.get(resolvedPath);
          
          if (targetComponent) {
            const weight = this.calculateImportWeight(content, importPath);
            
            connections.push({
              from: component.id,
              to: targetComponent.id,
              type: 'import',
              weight,
              metadata: {
                callSites: weight,
                dataFlow: importPath
              }
            });
            
            // Update component dependencies
            if (!component.dependencies.includes(targetComponent.id)) {
              component.dependencies.push(targetComponent.id);
            }
            if (!targetComponent.dependents.includes(component.id)) {
              targetComponent.dependents.push(component.id);
            }
          }
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }
    
    return connections;
  }

  private resolvePythonImport(importPath: string, currentFile: string): string {
    // Handle relative imports
    if (importPath.startsWith('.')) {
      const currentDir = path.dirname(currentFile);
      const levels = importPath.match(/^\.*/)![0].length - 1;
      const targetDir = levels > 0 ? 
        path.join(currentDir, '../'.repeat(levels - 1)) : 
        currentDir;
      const moduleName = importPath.replace(/^\.+/, '');
      return path.join(targetDir, moduleName.replace(/\./g, '/') + '.py');
    }
    
    // Handle absolute imports (try to resolve from project root)
    const modulePath = importPath.replace(/\./g, '/') + '.py';
    return modulePath;
  }

  private calculateImportWeight(content: string, importPath: string): number {
    const module = importPath.split('.').pop() || importPath;
    const regex = new RegExp(`\\b${module}\\b`, 'g');
    const matches = content.match(regex);
    return matches ? Math.min(matches.length, 5) : 1;
  }

  protected async identifyEntryPoints(components: ComponentNode[]): Promise<EntryPoint[]> {
    const entryPoints: EntryPoint[] = [];
    
    for (const component of components) {
      try {
        const fullPath = path.join(this.projectPath, component.path);
        const content = await this.readFile(fullPath);
        
        // Django URL patterns
        if (component.path.includes('urls.py')) {
          const urlPatterns = this.extractDjangoUrls(content);
          entryPoints.push(...urlPatterns.map(url => ({
            id: `${component.id}_${url.pattern}`,
            type: 'http_endpoint' as const,
            path: url.pattern,
            methods: ['GET', 'POST'],
            description: `Django URL pattern`,
            componentId: component.id,
            authentication: { type: 'none' as const, required: false }
          })));
        }
        
        // Flask routes
        const flaskRoutes = this.extractFlaskRoutes(content);
        entryPoints.push(...flaskRoutes.map(route => ({
          id: `${component.id}_${route.path}`,
          type: 'http_endpoint' as const,
          path: route.path,
          methods: route.methods,
          description: `Flask route`,
          componentId: component.id,
          authentication: { type: 'none' as const, required: false }
        })));
        
        // FastAPI routes
        const fastApiRoutes = this.extractFastApiRoutes(content);
        entryPoints.push(...fastApiRoutes.map(route => ({
          id: `${component.id}_${route.path}`,
          type: 'http_endpoint' as const,
          path: route.path,
          methods: [route.method],
          description: `FastAPI endpoint`,
          componentId: component.id,
          authentication: { type: 'none' as const, required: false }
        })));
        
        // CLI entry points
        if (content.includes('if __name__ == "__main__"')) {
          entryPoints.push({
            id: `${component.id}_main`,
            type: 'cli_command',
            path: component.path,
            description: `Python script entry point`,
            componentId: component.id,
            authentication: { type: 'none' as const, required: false }
          });
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }
    
    return entryPoints;
  }

  private extractDjangoUrls(content: string): Array<{pattern: string, name?: string}> {
    const urls: Array<{pattern: string, name?: string}> = [];
    const urlPatterns = content.match(/path\s*\(\s*['"`]([^'"`]+)['"`]/g);
    
    if (urlPatterns) {
      for (const pattern of urlPatterns) {
        const match = pattern.match(/path\s*\(\s*['"`]([^'"`]+)['"`]/);
        if (match) {
          urls.push({ pattern: match[1] });
        }
      }
    }
    
    return urls;
  }

  private extractFlaskRoutes(content: string): Array<{path: string, methods: string[]}> {
    const routes: Array<{path: string, methods: string[]}> = [];
    const routePatterns = content.match(/@\w*\.route\s*\(\s*['"`]([^'"`]+)['"`][^)]*\)/g);
    
    if (routePatterns) {
      for (const pattern of routePatterns) {
        const pathMatch = pattern.match(/['"`]([^'"`]+)['"`]/);
        const methodsMatch = pattern.match(/methods\s*=\s*\[(.*?)\]/);
        
        if (pathMatch) {
          const methods = methodsMatch ? 
            methodsMatch[1].split(',').map(m => m.trim().replace(/['"]/g, '')) :
            ['GET'];
          
          routes.push({
            path: pathMatch[1],
            methods
          });
        }
      }
    }
    
    return routes;
  }

  private extractFastApiRoutes(content: string): Array<{path: string, method: string}> {
    const routes: Array<{path: string, method: string}> = [];
    const routePatterns = content.match(/@\w*\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g);
    
    if (routePatterns) {
      for (const pattern of routePatterns) {
        const match = pattern.match(/@\w*\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/);
        if (match) {
          routes.push({
            method: match[1].toUpperCase(),
            path: match[2]
          });
        }
      }
    }
    
    return routes;
  }

  protected async identifyExitPoints(components: ComponentNode[]): Promise<ExitPoint[]> {
    const exitPoints: ExitPoint[] = [];
    
    for (const component of components) {
      try {
        const fullPath = path.join(this.projectPath, component.path);
        const content = await this.readFile(fullPath);
        
        // Database operations (Django ORM, SQLAlchemy, etc.)
        if (content.match(/\.objects\.|\.query\.|\.session\.|SELECT|INSERT|UPDATE|DELETE/i)) {
          exitPoints.push({
            id: `${component.id}_db`,
            type: 'database_query',
            destination: 'database',
            description: 'Database operations',
            critical: true,
            componentId: component.id
          });
        }
        
        // HTTP requests
        if (content.match(/requests\.|urllib\.|httpx\.|aiohttp\./)) {
          exitPoints.push({
            id: `${component.id}_http`,
            type: 'external_api',
            destination: 'external_api',
            description: 'HTTP API calls',
            critical: false,
            componentId: component.id
          });
        }
        
        // File operations
        if (content.match(/open\(|with open|\.read\(|\.write\(/)) {
          exitPoints.push({
            id: `${component.id}_file`,
            type: 'file_operation',
            destination: 'filesystem',
            description: 'File system operations',
            critical: false,
            componentId: component.id
          });
        }
        
        // Cache operations
        if (content.match(/cache\.|redis\.|memcache/)) {
          exitPoints.push({
            id: `${component.id}_cache`,
            type: 'cache_operation',
            destination: 'cache',
            description: 'Cache operations',
            critical: false,
            componentId: component.id
          });
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }
    
    return exitPoints;
  }

  protected async generateCallGraph(components: ComponentNode[]): Promise<CallGraph> {
    const nodes: CallGraphNode[] = [];
    const edges: CallGraphEdge[] = [];
    const entryPointIds: string[] = [];
    
    // Create nodes for each function in each component
    for (const component of components) {
      if (component.metadata.functions) {
        for (const func of component.metadata.functions) {
          nodes.push({
            id: `${component.id}.${func.name}`,
            name: func.name,
            type: 'function',
            file: component.path,
            complexity: func.complexity,
            fanIn: 0, // Will be calculated
            fanOut: 0, // Will be calculated
            depth: 0,
            critical: component.metadata.isEntry || false
          });
          
          if (component.metadata.isEntry) {
            entryPointIds.push(`${component.id}.${func.name}`);
          }
        }
      }
    }
    
    // Simple call graph - in a real implementation, this would require AST parsing
    return {
      nodes,
      edges,
      entryPoints: entryPointIds,
      cycles: [],
      layers: [],
      hotPaths: [],
      deadCode: []
    };
  }

  protected async analyzeDatabaseConnections(components: ComponentNode[]): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    const connectionMap = new Map<string, DatabaseConnection>();
    
    for (const component of components) {
      try {
        const fullPath = path.join(this.projectPath, component.path);
        const content = await this.readFile(fullPath);
        
        // Django database settings
        if (component.path.includes('settings.py')) {
          const dbConfig = this.extractDjangoDatabase(content);
          if (dbConfig) {
            const key = `${dbConfig.type}_${dbConfig.host}`;
            connectionMap.set(key, {
              id: key,
              name: dbConfig.name || 'default',
              type: dbConfig.type,
              host: dbConfig.host,
              port: dbConfig.port,
              database: dbConfig.database,
              componentIds: [component.id],
              usage: [{
                componentId: component.id,
                operations: [],
                frequency: 1,
                critical: true
              }]
            });
          }
        }
        
        // SQLAlchemy connections
        const sqlAlchemyConnections = this.extractSQLAlchemyConnections(content);
        for (const conn of sqlAlchemyConnections) {
          const key = `${conn.type}_${conn.host}`;
          if (!connectionMap.has(key)) {
            connectionMap.set(key, {
              ...conn,
              componentIds: [component.id],
              usage: [{
                componentId: component.id,
                operations: [],
                frequency: 1,
                critical: false
              }]
            });
          }
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }
    
    return Array.from(connectionMap.values());
  }

  private extractDjangoDatabase(content: string): any {
    const dbMatch = content.match(/DATABASES\s*=\s*{[^}]*'default':\s*{([^}]*)}/s);
    if (!dbMatch) return null;
    
    const config = dbMatch[1];
    const engine = config.match(/'ENGINE':\s*'([^']+)'/)?.[1];
    const name = config.match(/'NAME':\s*'([^']+)'/)?.[1];
    const host = config.match(/'HOST':\s*'([^']+)'/)?.[1];
    const port = config.match(/'PORT':\s*'([^']+)'/)?.[1];
    
    let type: any = 'postgresql';
    if (engine?.includes('mysql')) type = 'mysql';
    else if (engine?.includes('sqlite')) type = 'sqlite';
    
    return {
      type,
      name,
      host: host || 'localhost',
      port: port ? parseInt(port) : (type === 'mysql' ? 3306 : 5432),
      database: name
    };
  }

  private extractSQLAlchemyConnections(content: string): DatabaseConnection[] {
    const connections: DatabaseConnection[] = [];
    const urlPattern = /(['"`])([a-z]+:\/\/[^'"`]+)\1/g;
    
    let match;
    while ((match = urlPattern.exec(content)) !== null) {
      const url = match[2];
      const parsed = this.parseDatabaseUrl(url);
      if (parsed) {
        connections.push({
          id: `sqlalchemy_${connections.length}`,
          name: parsed.database || 'unknown',
          type: parsed.type,
          host: parsed.host,
          port: parsed.port,
          database: parsed.database,
          componentIds: [],
          usage: []
        });
      }
    }
    
    return connections;
  }

  private parseDatabaseUrl(url: string): any {
    try {
      const parsed = new URL(url);
      let type: any = 'postgresql';
      
      if (parsed.protocol === 'mysql:') type = 'mysql';
      else if (parsed.protocol === 'sqlite:') type = 'sqlite';
      else if (parsed.protocol === 'mongodb:') type = 'mongodb';
      
      return {
        type,
        host: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : undefined,
        database: parsed.pathname.slice(1)
      };
    } catch {
      return null;
    }
  }

  protected async analyzeTestCoverage(components: ComponentNode[]): Promise<TestCoverage | null> {
    const testFiles = await this.findFiles(['**/test_*.py', '**/*_test.py', '**/tests/**/*.py']);
    
    if (testFiles.length === 0) return null;
    
    const coverage: TestCoverage = {
      overall: 0,
      lines: { covered: 0, total: 0, percentage: 0 },
      branches: { covered: 0, total: 0, percentage: 0 },
      functions: { covered: 0, total: 0, percentage: 0 },
      statements: { covered: 0, total: 0, percentage: 0 },
      byComponent: {},
      byType: {},
      uncoveredFiles: []
    };
    
    const sourceFiles = new Set(components.filter(c => !c.path.includes('test')).map(c => c.path));
    const testedFiles = new Set<string>();
    
    // Analyze test files to determine coverage
    for (const testFile of testFiles) {
      try {
        const content = await this.readFile(testFile);
        const imports = this.extractImports(content);
        
        for (const imp of imports) {
          const resolved = this.resolvePythonImport(imp, testFile);
          if (sourceFiles.has(resolved)) {
            testedFiles.add(resolved);
          }
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }
    
    // Calculate coverage metrics
    const totalFiles = sourceFiles.size;
    const coveredFiles = testedFiles.size;
    coverage.overall = totalFiles > 0 ? Math.round((coveredFiles / totalFiles) * 100) : 0;
    
    coverage.lines = {
      covered: coveredFiles,
      total: totalFiles,
      percentage: coverage.overall
    };
    
    coverage.functions = { ...coverage.lines };
    coverage.branches = { ...coverage.lines };
    coverage.statements = { ...coverage.lines };
    
    // Mark uncovered files
    for (const file of sourceFiles) {
      if (!testedFiles.has(file)) {
        coverage.uncoveredFiles.push(file);
      }
    }
    
    return coverage;
  }

  protected async assessRisks(components: ComponentNode[], connections: Connection[]): Promise<RiskArea[]> {
    const risks: RiskArea[] = [];
    
    for (const component of components) {
      const reasons: string[] = [];
      let riskLevel: 'low' | 'medium' | 'high' = 'low';
      
      // High complexity
      if (component.metadata.complexity > 7) {
        reasons.push(`High complexity (${component.metadata.complexity}/10)`);
        riskLevel = 'high';
      }
      
      // Django security risks
      if (component.path.includes('settings.py')) {
        try {
          const content = await this.readFile(path.join(this.projectPath, component.path));
          if (content.includes('DEBUG = True')) {
            reasons.push('Debug mode enabled in production');
            riskLevel = 'high';
          }
          if (!content.includes('ALLOWED_HOSTS')) {
            reasons.push('Missing ALLOWED_HOSTS configuration');
            riskLevel = 'medium';
          }
        } catch {}
      }
      
      // No test coverage
      if (component.metadata.testCoverage === 0) {
        reasons.push('No test coverage');
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }
      
      // Entry point without authentication
      if (component.metadata.isEntry && component.type === 'route') {
        reasons.push('Public entry point');
        riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
      }
      
      if (reasons.length > 0) {
        risks.push({
          componentId: component.id,
          riskLevel,
          reasons,
          impact: component.dependents.length > 0 ? 
            `Changes could affect ${component.dependents.length} components` :
            'Isolated component risk'
        });
      }
    }
    
    return risks;
  }

  protected async analyzeAPIEndpoints(components: ComponentNode[]): Promise<APIEndpoint[]> {
    const endpoints: APIEndpoint[] = [];
    
    for (const component of components) {
      if (component.type === 'route') {
        try {
          const fullPath = path.join(this.projectPath, component.path);
          const content = await this.readFile(fullPath);
          
          // Extract Django REST framework endpoints
          const drf = this.extractDRFEndpoints(content, component);
          endpoints.push(...drf);
          
          // Extract Flask endpoints
          const flask = this.extractFlaskEndpoints(content, component);
          endpoints.push(...flask);
          
          // Extract FastAPI endpoints
          const fastapi = this.extractFastAPIEndpoints(content, component);
          endpoints.push(...fastapi);
        } catch (error) {
          // Skip files that can't be read
        }
      }
    }
    
    return endpoints;
  }

  private extractDRFEndpoints(content: string, component: ComponentNode): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    
    // This is a simplified implementation
    // In practice, you'd need to parse Django URL routing more comprehensively
    if (content.includes('APIView') || content.includes('ViewSet')) {
      endpoints.push({
        id: `${component.id}_api`,
        method: 'GET',
        path: '/api/' + component.name.toLowerCase(),
        description: `Django REST API endpoint`,
        parameters: [],
        statusCodes: [
          { code: 200, description: 'Success' },
          { code: 404, description: 'Not found' }
        ],
        middleware: [],
        authentication: { type: 'none', required: false },
        componentId: component.id
      });
    }
    
    return endpoints;
  }

  private extractFlaskEndpoints(content: string, component: ComponentNode): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    const routes = this.extractFlaskRoutes(content);
    
    for (const route of routes) {
      endpoints.push({
        id: `${component.id}_${route.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        method: route.methods[0] as any,
        path: route.path,
        description: `Flask endpoint`,
        parameters: [],
        statusCodes: [
          { code: 200, description: 'Success' }
        ],
        middleware: [],
        authentication: { type: 'none', required: false },
        componentId: component.id
      });
    }
    
    return endpoints;
  }

  private extractFastAPIEndpoints(content: string, component: ComponentNode): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    const routes = this.extractFastApiRoutes(content);
    
    for (const route of routes) {
      endpoints.push({
        id: `${component.id}_${route.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        method: route.method as any,
        path: route.path,
        description: `FastAPI endpoint`,
        parameters: [],
        statusCodes: [
          { code: 200, description: 'Success' }
        ],
        middleware: [],
        authentication: { type: 'none', required: false },
        componentId: component.id
      });
    }
    
    return endpoints;
  }
}