// System Topology Analyzer - Focuses on architectural patterns and system understanding
// Instead of just parsing code, this understands how systems are actually structured

import { BaseAnalyzer, AnalyzerOptions, LanguageDetection, FrameworkDetection, ComponentDiscovery } from './base-analyzer';
import { 
  ComponentNode, ComponentType, Connection, ConnectionType, RiskArea, ComponentMetadata,
  EntryPoint, ExitPoint, CallGraph, DatabaseConnection, TestCoverage, CallGraphNode,
  CallGraphEdge
} from '../types';
import * as path from 'path';
import * as fs from 'fs-extra';

interface SystemPattern {
  name: string;
  type: 'architectural' | 'behavioral' | 'structural';
  confidence: number;
  indicators: string[];
  implications: string[];
}

interface TopologyMap {
  layers: ArchitecturalLayer[];
  flows: DataFlow[];
  patterns: SystemPattern[];
  entryPoints: SystemEntryPoint[];
  integrations: ExternalIntegration[];
}

interface ArchitecturalLayer {
  name: string;
  type: 'presentation' | 'business' | 'data' | 'infrastructure' | 'external';
  components: string[];
  responsibilities: string[];
}

interface DataFlow {
  from: string;
  to: string;
  type: 'request' | 'response' | 'event' | 'data' | 'command';
  pattern: string;
  frequency: 'high' | 'medium' | 'low';
}

interface SystemEntryPoint {
  id: string;
  type: 'http_endpoint' | 'cli_command' | 'event_handler' | 'scheduler' | 'websocket';
  path: string;
  methods?: string[];
  description: string;
}

interface ExternalIntegration {
  name: string;
  type: 'database' | 'api' | 'queue' | 'cache' | 'storage' | 'auth' | 'payment';
  direction: 'inbound' | 'outbound' | 'bidirectional';
  critical: boolean;
}

export class SystemTopologyAnalyzer extends BaseAnalyzer {
  private topology: TopologyMap = {
    layers: [],
    flows: [],
    patterns: [],
    entryPoints: [],
    integrations: []
  };

  // Architectural patterns we can recognize across any language/framework
  private architecturalPatterns = {
    // Web Application Patterns
    mvc: {
      indicators: ['controllers/', 'models/', 'views/', 'Controller', 'Model', 'View'],
      implications: ['Three-layer architecture', 'Separation of concerns', 'Web application']
    },
    layered: {
      indicators: ['presentation/', 'business/', 'data/', 'service/', 'repository/', 'dto/'],
      implications: ['Layered architecture', 'Clear separation', 'Enterprise application']
    },
    microservices: {
      indicators: ['services/', 'api/', 'gateway/', 'docker', 'kubernetes', 'service.'],
      implications: ['Distributed system', 'Service-oriented', 'Scalable architecture']
    },
    
    // Backend Patterns
    restful_api: {
      indicators: ['@Get', '@Post', '@Put', '@Delete', 'routes/', 'api/', '.get(', '.post('],
      implications: ['REST API', 'HTTP endpoints', 'Stateless communication']
    },
    graphql: {
      indicators: ['graphql', 'resolvers/', 'schema.', '@Query', '@Mutation'],
      implications: ['GraphQL API', 'Single endpoint', 'Flexible queries']
    },
    
    // Data Patterns
    orm: {
      indicators: ['entities/', 'models/', '@Entity', 'Schema', 'migration', 'repository'],
      implications: ['Object-relational mapping', 'Database abstraction', 'Data persistence']
    },
    cqrs: {
      indicators: ['commands/', 'queries/', 'handlers/', 'events/', 'Command', 'Query'],
      implications: ['CQRS pattern', 'Separated read/write', 'Event-driven']
    },
    
    // Infrastructure Patterns
    dependency_injection: {
      indicators: ['@Injectable', '@Inject', 'container', 'providers', 'DI'],
      implications: ['Dependency injection', 'Inversion of control', 'Testable code']
    },
    event_driven: {
      indicators: ['events/', 'listeners/', 'handlers/', '@Event', 'EventEmitter', 'pub/sub'],
      implications: ['Event-driven architecture', 'Loose coupling', 'Asynchronous processing']
    }
  };

  getAnalyzerName(): string {
    return 'System Topology Analyzer';
  }

  getSupportedLanguages(): string[] {
    return ['typescript', 'javascript', 'python', 'java', 'csharp', 'go', 'rust', 'php'];
  }

  getSupportedFrameworks(): string[] {
    return ['any']; // This analyzer works with any framework by recognizing patterns
  }

  protected async detectLanguageAndFramework(): Promise<LanguageDetection> {
    console.log('🔍 Detecting system architecture and patterns...');

    // Analyze project structure and files to understand the system
    const projectStructure = await this.analyzeProjectStructure();
    const codePatterns = await this.detectCodePatterns();
    const configPatterns = await this.detectConfigurationPatterns();

    // Determine primary language
    const language = this.determinePrimaryLanguage(projectStructure);
    
    // Detect architectural frameworks and patterns
    const frameworks = this.detectArchitecturalFrameworks(projectStructure, codePatterns, configPatterns);

    console.log(`🏗️ Detected ${language} system with patterns: ${frameworks.map(f => f.name).join(', ')}`);

    return {
      language,
      confidence: 0.95,
      frameworks,
      files: projectStructure.allFiles
    };
  }

  private async analyzeProjectStructure(): Promise<any> {
    const structure = {
      directories: new Set<string>(),
      files: new Map<string, string>(),
      allFiles: [] as string[],
      patterns: new Set<string>()
    };

    // Get all files and directories
    const allFiles = await this.findFiles(['**/*'], ['node_modules/**', 'dist/**', 'build/**', '.git/**']);
    structure.allFiles = allFiles;

    for (const file of allFiles.slice(0, 100)) { // Sample for performance
      const relativePath = path.relative(this.projectPath, file);
      const directory = path.dirname(relativePath);
      const extension = path.extname(file);
      
      structure.directories.add(directory);
      structure.files.set(relativePath, extension);
      
      // Extract patterns from paths
      const pathParts = relativePath.split('/');
      pathParts.forEach(part => {
        if (part.length > 2) structure.patterns.add(part.toLowerCase());
      });
    }

    return structure;
  }

  private async detectCodePatterns(): Promise<Set<string>> {
    const patterns = new Set<string>();
    
    // Sample key files to detect patterns
    const keyFiles = await this.findFiles([
      'package.json', 'requirements.txt', 'pom.xml', 'go.mod', 'Cargo.toml',
      '**/*.ts', '**/*.js', '**/*.py', '**/*.java', '**/*.cs', '**/*.go'
    ]);

    for (const file of keyFiles.slice(0, 50)) {
      try {
        const content = await this.readFile(file);
        
        // Extract patterns from content
        this.extractPatternsFromContent(content, patterns);
      } catch (error) {
        // Skip files that can't be read
      }
    }

    return patterns;
  }

  private extractPatternsFromContent(content: string, patterns: Set<string>): void {
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Detect decorators
      if (trimmed.startsWith('@')) {
        patterns.add(trimmed.split('(')[0]);
      }
      
      // Detect imports/requires
      if (trimmed.includes('import') || trimmed.includes('require') || trimmed.includes('from')) {
        const match = trimmed.match(/['"`]([^'"`]+)['"`]/);
        if (match) patterns.add(match[1]);
      }
      
      // Detect class/function patterns
      if (trimmed.includes('class ') || trimmed.includes('function ') || trimmed.includes('def ')) {
        patterns.add('class_based');
      }
      
      // Detect HTTP methods
      const httpMethods = ['get', 'post', 'put', 'delete', 'patch'];
      for (const method of httpMethods) {
        if (trimmed.toLowerCase().includes(`.${method}(`) || trimmed.includes(`@${method.toUpperCase()}`)) {
          patterns.add(`http_${method}`);
        }
      }
      
      // Detect database patterns
      const dbPatterns = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'findOne', 'save', 'create'];
      for (const pattern of dbPatterns) {
        if (trimmed.includes(pattern)) {
          patterns.add('database_operations');
        }
      }
    }
  }

  private async detectConfigurationPatterns(): Promise<Set<string>> {
    const patterns = new Set<string>();
    
    const configFiles = await this.findFiles([
      'package.json', 'requirements.txt', 'pom.xml', 'Dockerfile', 'docker-compose.yml',
      '*.config.js', '*.config.ts', '.env*', 'tsconfig.json'
    ]);

    for (const file of configFiles) {
      try {
        const content = await this.readFile(file);
        const filename = path.basename(file);
        
        if (filename === 'package.json') {
          const pkg = JSON.parse(content);
          Object.keys(pkg.dependencies || {}).forEach(dep => patterns.add(dep));
          Object.keys(pkg.devDependencies || {}).forEach(dep => patterns.add(dep));
        } else if (filename === 'requirements.txt') {
          content.split('\n').forEach(line => {
            const dep = line.split('==')[0].split('>=')[0].trim();
            if (dep) patterns.add(dep);
          });
        } else if (filename.includes('docker')) {
          patterns.add('containerized');
        }
      } catch (error) {
        // Skip invalid files
      }
    }

    return patterns;
  }

  private determinePrimaryLanguage(projectStructure: any): string {
    const extensions = new Map<string, number>();
    
    for (const [file, ext] of projectStructure.files) {
      extensions.set(ext, (extensions.get(ext) || 0) + 1);
    }

    // Map extensions to languages
    const langMap: Record<string, string> = {
      '.ts': 'typescript',
      '.js': 'javascript',
      '.tsx': 'typescript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.java': 'java',
      '.cs': 'csharp',
      '.go': 'go',
      '.rs': 'rust',
      '.php': 'php'
    };

    let maxCount = 0;
    let primaryLang = 'unknown';

    for (const [ext, count] of extensions) {
      if (langMap[ext] && count > maxCount) {
        maxCount = count;
        primaryLang = langMap[ext];
      }
    }

    return primaryLang;
  }

  private detectArchitecturalFrameworks(projectStructure: any, codePatterns: Set<string>, configPatterns: Set<string>): FrameworkDetection[] {
    const frameworks: FrameworkDetection[] = [];
    const allPatterns = new Set([...projectStructure.patterns, ...codePatterns, ...configPatterns]);

    // Detect specific frameworks
    const frameworkDetectors = {
      'NestJS': () => allPatterns.has('@nestjs/core') || allPatterns.has('@Injectable') || allPatterns.has('@Controller'),
      'Express': () => allPatterns.has('express') || codePatterns.has('http_get'),
      'React': () => allPatterns.has('react') || allPatterns.has('jsx'),
      'Next.js': () => allPatterns.has('next') || projectStructure.directories.has('pages'),
      'Django': () => allPatterns.has('django') || projectStructure.patterns.has('models.py'),
      'FastAPI': () => allPatterns.has('fastapi') || allPatterns.has('uvicorn'),
      'Spring Boot': () => allPatterns.has('spring-boot') || allPatterns.has('org.springframework'),
      'ASP.NET Core': () => allPatterns.has('Microsoft.AspNetCore'),
      'Gin': () => allPatterns.has('gin-gonic') || allPatterns.has('github.com/gin'),
      'Laravel': () => allPatterns.has('laravel') || projectStructure.patterns.has('artisan')
    };

    for (const [name, detector] of Object.entries(frameworkDetectors)) {
      if (detector()) {
        frameworks.push({
          name,
          confidence: 0.9,
          patterns: Array.from(allPatterns).filter(p => p.includes(name.toLowerCase()))
        });
      }
    }

    // Detect architectural patterns
    for (const [patternName, config] of Object.entries(this.architecturalPatterns)) {
      const matches = config.indicators.filter(indicator => 
        Array.from(allPatterns).some(pattern => 
          pattern.toLowerCase().includes(indicator.toLowerCase()) ||
          indicator.toLowerCase().includes(pattern.toLowerCase())
        )
      );

      if (matches.length > 0) {
        this.topology.patterns.push({
          name: patternName,
          type: 'architectural',
          confidence: matches.length / config.indicators.length,
          indicators: matches,
          implications: config.implications
        });
      }
    }

    return frameworks;
  }

  protected async discoverComponents(): Promise<ComponentDiscovery> {
    console.log('🏗️ Mapping system topology and discovering architectural components...');

    // Instead of just parsing files, understand the system architecture
    await this.mapSystemTopology();
    
    // Create components based on architectural understanding
    const components = await this.createArchitecturalComponents();

    return {
      totalFiles: this.topology.layers.reduce((sum, layer) => sum + layer.components.length, 0),
      analyzedFiles: components.length,
      skippedFiles: 0,
      components
    };
  }

  private async mapSystemTopology(): Promise<void> {
    // Identify architectural layers
    await this.identifyArchitecturalLayers();
    
    // Map data flows
    await this.mapDataFlows();
    
    // Identify entry points
    await this.identifySystemEntryPoints();
    
    // Detect external integrations
    await this.detectExternalIntegrations();
  }

  private async identifyArchitecturalLayers(): Promise<void> {
    const files = await this.findFiles(['**/*.ts', '**/*.js', '**/*.py', '**/*.java', '**/*.cs', '**/*.go']);
    
    // Group files by architectural patterns
    const layerMap = new Map<string, string[]>();
    
    for (const file of files) {
      const relativePath = path.relative(this.projectPath, file);
      const layer = this.determineArchitecturalLayer(relativePath);
      
      if (!layerMap.has(layer)) {
        layerMap.set(layer, []);
      }
      layerMap.get(layer)!.push(relativePath);
    }

    // Create layer definitions
    for (const [layerName, components] of layerMap) {
      if (components.length > 0) {
        this.topology.layers.push({
          name: layerName,
          type: this.mapLayerType(layerName),
          components,
          responsibilities: this.getLayerResponsibilities(layerName)
        });
      }
    }
  }

  private determineArchitecturalLayer(filePath: string): string {
    const pathLower = filePath.toLowerCase();
    
    // API/Presentation Layer
    if (pathLower.includes('controller') || pathLower.includes('route') || pathLower.includes('api/')) {
      return 'presentation';
    }
    
    // Business Logic Layer
    if (pathLower.includes('service') || pathLower.includes('business/') || pathLower.includes('domain/')) {
      return 'business';
    }
    
    // Data Layer
    if (pathLower.includes('model') || pathLower.includes('entity') || pathLower.includes('repository') || 
        pathLower.includes('dao') || pathLower.includes('database/')) {
      return 'data';
    }
    
    // Infrastructure Layer
    if (pathLower.includes('config') || pathLower.includes('middleware') || pathLower.includes('auth') ||
        pathLower.includes('guard') || pathLower.includes('interceptor')) {
      return 'infrastructure';
    }
    
    // External Integration
    if (pathLower.includes('external') || pathLower.includes('client') || pathLower.includes('adapter')) {
      return 'external';
    }
    
    return 'business'; // Default
  }

  private mapLayerType(layerName: string): 'presentation' | 'business' | 'data' | 'infrastructure' | 'external' {
    const mapping: Record<string, any> = {
      'presentation': 'presentation',
      'business': 'business', 
      'data': 'data',
      'infrastructure': 'infrastructure',
      'external': 'external'
    };
    return mapping[layerName] || 'business';
  }

  private getLayerResponsibilities(layerName: string): string[] {
    const responsibilities: Record<string, string[]> = {
      'presentation': ['HTTP endpoints', 'Request validation', 'Response formatting', 'API documentation'],
      'business': ['Business logic', 'Domain operations', 'Workflow orchestration', 'Rule enforcement'],
      'data': ['Data persistence', 'Database operations', 'Entity definitions', 'Data validation'],
      'infrastructure': ['Cross-cutting concerns', 'Authentication', 'Authorization', 'Logging', 'Configuration'],
      'external': ['Third-party integrations', 'External API clients', 'Message queues', 'External services']
    };
    return responsibilities[layerName] || ['General functionality'];
  }

  private async mapDataFlows(): Promise<void> {
    // This would analyze actual data flow patterns
    // For now, create basic flows based on layer dependencies
    const layers = this.topology.layers;
    
    for (let i = 0; i < layers.length - 1; i++) {
      for (let j = i + 1; j < layers.length; j++) {
        if (this.layersInteract(layers[i], layers[j])) {
          this.topology.flows.push({
            from: layers[i].name,
            to: layers[j].name,
            type: 'request',
            pattern: 'layer_communication',
            frequency: 'high'
          });
        }
      }
    }
  }

  private layersInteract(layer1: ArchitecturalLayer, layer2: ArchitecturalLayer): boolean {
    // Define which layers typically interact
    const interactions = [
      ['presentation', 'business'],
      ['business', 'data'],
      ['presentation', 'infrastructure'],
      ['business', 'external']
    ];
    
    return interactions.some(([a, b]) => 
      (layer1.type === a && layer2.type === b) || 
      (layer1.type === b && layer2.type === a)
    );
  }

  private async identifySystemEntryPoints(): Promise<void> {
    const files = await this.findFiles(['**/*.ts', '**/*.js', '**/*.py', '**/*.java']);
    
    for (const file of files.slice(0, 50)) { // Sample for performance
      try {
        const content = await this.readFile(file);
        const relativePath = path.relative(this.projectPath, file);
        
        // Look for HTTP endpoints
        const httpPatterns = [
          /@Get\s*\(['"`]([^'"`]+)['"`]\)/g,
          /@Post\s*\(['"`]([^'"`]+)['"`]\)/g,
          /\.get\s*\(['"`]([^'"`]+)['"`]/g,
          /\.post\s*\(['"`]([^'"`]+)['"`]/g
        ];

        for (const pattern of httpPatterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            this.topology.entryPoints.push({
              id: `${relativePath}:${match[1]}`,
              type: 'http_endpoint',
              path: match[1],
              methods: [this.extractHttpMethod(match[0])],
              description: `HTTP endpoint in ${relativePath}`
            });
          }
        }

        // Look for main functions/entry points
        if (content.includes('app.listen') || content.includes('if __name__') || content.includes('public static void main')) {
          this.topology.entryPoints.push({
            id: relativePath,
            type: 'cli_command',
            path: relativePath,
            description: `Application entry point`
          });
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }
  }

  private extractHttpMethod(match: string): string {
    if (match.includes('Get') || match.includes('.get')) return 'GET';
    if (match.includes('Post') || match.includes('.post')) return 'POST';
    if (match.includes('Put') || match.includes('.put')) return 'PUT';
    if (match.includes('Delete') || match.includes('.delete')) return 'DELETE';
    return 'GET';
  }

  private async detectExternalIntegrations(): Promise<void> {
    // Analyze configuration files and code for external integrations
    const configFiles = await this.findFiles(['package.json', 'requirements.txt', '*.env*', 'docker-compose.yml']);
    
    for (const file of configFiles) {
      try {
        const content = await this.readFile(file);
        
        if (file.endsWith('package.json')) {
          const pkg = JSON.parse(content);
          this.analyzeNpmDependencies(pkg.dependencies || {});
        } else if (file.includes('.env')) {
          this.analyzeEnvironmentVariables(content);
        }
      } catch (error) {
        // Skip invalid files
      }
    }
  }

  private analyzeNpmDependencies(dependencies: Record<string, string>): void {
    const integrationMap: Record<string, { type: ExternalIntegration['type'], critical: boolean }> = {
      'mongoose': { type: 'database', critical: true },
      'prisma': { type: 'database', critical: true },
      'redis': { type: 'cache', critical: false },
      'aws-sdk': { type: 'storage', critical: false },
      'stripe': { type: 'payment', critical: true },
      'passport': { type: 'auth', critical: true },
      'axios': { type: 'api', critical: false },
      'bull': { type: 'queue', critical: false }
    };

    for (const [dep, version] of Object.entries(dependencies)) {
      const integration = integrationMap[dep];
      if (integration) {
        this.topology.integrations.push({
          name: dep,
          type: integration.type,
          direction: 'outbound',
          critical: integration.critical
        });
      }
    }
  }

  private analyzeEnvironmentVariables(content: string): void {
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.includes('DATABASE_URL')) {
        this.topology.integrations.push({
          name: 'Database',
          type: 'database',
          direction: 'outbound',
          critical: true
        });
      }
      if (line.includes('REDIS_URL')) {
        this.topology.integrations.push({
          name: 'Redis',
          type: 'cache',
          direction: 'outbound',
          critical: false
        });
      }
      // Add more patterns as needed
    }
  }

  private async createArchitecturalComponents(): Promise<ComponentNode[]> {
    const components: ComponentNode[] = [];
    
    // Create components for each layer and pattern
    for (const layer of this.topology.layers) {
      for (const componentPath of layer.components) {
        const component = await this.createComponentFromPath(componentPath, layer);
        if (component) {
          components.push(component);
        }
      }
    }

    return components;
  }

  private async createComponentFromPath(filePath: string, layer: ArchitecturalLayer): Promise<ComponentNode | null> {
    try {
      const content = await this.readFile(path.join(this.projectPath, filePath));
      
      return {
        id: this.generateComponentId(filePath),
        name: path.basename(filePath, path.extname(filePath)),
        type: this.mapLayerToComponentType(layer.type),
        path: filePath,
        dependencies: [], // Will be populated during connection analysis
        dependents: [],
        metadata: {
          lineCount: content.split('\n').length,
          complexity: this.calculateComplexity(content),
          lastModified: new Date(),
          exports: [],
          imports: [],
          isEntry: this.topology.entryPoints.some(ep => ep.path === filePath),
          isOrphaned: false,
          layer: layer.name,
          responsibilities: layer.responsibilities
        } as ComponentMetadata & { layer?: string, responsibilities?: string[] }
      };
    } catch (error) {
      return null;
    }
  }

  private mapLayerToComponentType(layerType: ArchitecturalLayer['type']): ComponentType {
    const mapping: Record<ArchitecturalLayer['type'], ComponentType> = {
      'presentation': 'route',
      'business': 'service',
      'data': 'model',
      'infrastructure': 'middleware',
      'external': 'external_api'
    };
    return mapping[layerType];
  }

  protected async analyzeConnections(components: ComponentNode[]): Promise<Connection[]> {
    const connections: Connection[] = [];
    console.log('🔗 Analyzing real code connections and dependencies...');
    
    // Create a map for quick component lookup by file path
    const componentsByPath = new Map<string, ComponentNode>();
    for (const component of components) {
      componentsByPath.set(component.path, component);
    }

    // Analyze each component's imports and dependencies
    for (const component of components) {
      try {
        const fullPath = path.join(this.projectPath, component.path);
        const content = await this.readFile(fullPath);
        
        // Extract imports and dependencies from the file content
        const dependencies = this.extractDependencies(content, component.path, componentsByPath);
        
        // Create connections for each dependency
        for (const dep of dependencies) {
          connections.push({
            from: component.id,
            to: dep.targetComponent.id,
            type: dep.type,
            weight: dep.weight,
            metadata: {
              callSites: dep.callSites,
              dataFlow: dep.importPath
            }
          });
        }
        
        // Update component metadata with dependencies
        component.dependencies = dependencies.map(d => d.targetComponent.id);
        dependencies.forEach(dep => {
          if (!dep.targetComponent.dependents.includes(component.id)) {
            dep.targetComponent.dependents.push(component.id);
          }
        });
        
      } catch (error) {
        // Skip files that can't be read, but don't log errors for cleaner output
      }
    }

    console.log(`🔗 Found ${connections.length} real code connections`);
    return connections;
  }

  private extractDependencies(content: string, currentFilePath: string, componentsByPath: Map<string, ComponentNode>): Array<{
    targetComponent: ComponentNode;
    type: ConnectionType;
    weight: number;
    callSites: number;
    importPath: string;
  }> {
    const dependencies: Array<{
      targetComponent: ComponentNode;
      type: ConnectionType;
      weight: number;
      callSites: number;
      importPath: string;
    }> = [];

    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Match import statements
      const importMatches = [
        /import\s+.*?\s+from\s+['"`]([^'"`]+)['"`]/g,
        /import\s+['"`]([^'"`]+)['"`]/g,
        /require\(['"`]([^'"`]+)['"`]\)/g
      ];

      for (const regex of importMatches) {
        let match;
        while ((match = regex.exec(trimmed)) !== null) {
          const importPath = match[1];
          
          // Resolve relative imports to actual file paths
          const resolvedPath = this.resolveImportPath(importPath, currentFilePath);
          if (resolvedPath && componentsByPath.has(resolvedPath)) {
            const targetComponent = componentsByPath.get(resolvedPath)!;
            
            // Count how many times this import is used in the file
            const callSites = this.countUsageInFile(content, importPath);
            
            dependencies.push({
              targetComponent,
              type: 'import',
              weight: Math.min(callSites, 5), // Cap at 5 for visualization
              callSites,
              importPath
            });
          }
        }
      }
    }

    return dependencies;
  }

  private resolveImportPath(importPath: string, currentFilePath: string): string | null {
    // Handle relative imports
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      const currentDir = path.dirname(currentFilePath);
      let resolvedPath = path.join(currentDir, importPath);
      
      // Try different extensions
      const extensions = ['.ts', '.js', '.tsx', '.jsx', '/index.ts', '/index.js'];
      for (const ext of extensions) {
        const testPath = resolvedPath + ext;
        if (testPath.startsWith('src/')) {
          return testPath;
        }
      }
      
      // Try without src/ prefix
      resolvedPath = resolvedPath.replace(/^src\//, '');
      for (const ext of extensions) {
        const testPath = resolvedPath + ext;
        return testPath;
      }
    }
    
    // Handle absolute imports from src/
    if (!importPath.startsWith('.') && !importPath.includes('node_modules')) {
      const extensions = ['.ts', '.js', '.tsx', '.jsx', '/index.ts', '/index.js'];
      for (const ext of extensions) {
        const testPath = `src/${importPath}${ext}`;
        return testPath;
      }
    }
    
    return null;
  }

  private countUsageInFile(content: string, importPath: string): number {
    // Extract the imported identifiers and count their usage
    const importName = path.basename(importPath, path.extname(importPath));
    const regex = new RegExp(`\\b${importName}\\b`, 'g');
    const matches = content.match(regex);
    return matches ? Math.max(1, matches.length - 1) : 1; // Subtract 1 for the import statement itself
  }

  protected async identifyEntryPoints(components: ComponentNode[]): Promise<EntryPoint[]> {
    const entryPoints: EntryPoint[] = [];
    
    for (const ep of this.topology.entryPoints) {
      const component = components.find(c => c.path === ep.path);
      if (component) {
        entryPoints.push({
          id: ep.id,
          type: ep.type as any,
          path: ep.path,
          methods: ep.methods,
          description: ep.description,
          componentId: component.id,
          authentication: { type: 'none', required: false }
        });
      }
    }
    
    return entryPoints;
  }

  protected async identifyExitPoints(components: ComponentNode[]): Promise<ExitPoint[]> {
    const exitPoints: ExitPoint[] = [];
    
    // Identify database connections, external APIs, file operations
    for (const component of components) {
      try {
        const fullPath = path.join(this.projectPath, component.path);
        const content = await this.readFile(fullPath);
        
        // Database operations
        if (content.match(/\.(findOne|find|save|create|update|delete|query)\(/)) {
          exitPoints.push({
            id: `${component.id}_db`,
            type: 'database_query',
            destination: 'database',
            description: 'Database operations',
            critical: true,
            componentId: component.id
          });
        }
        
        // External API calls
        if (content.match(/axios|fetch|http\.request|HttpClient/)) {
          exitPoints.push({
            id: `${component.id}_api`,
            type: 'external_api',
            destination: 'external',
            description: 'External API calls',
            critical: false,
            componentId: component.id
          });
        }
        
        // File operations
        if (content.match(/fs\.|readFile|writeFile|createReadStream|createWriteStream/)) {
          exitPoints.push({
            id: `${component.id}_file`,
            type: 'file_operation',
            destination: 'filesystem',
            description: 'File system operations',
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
    const cycles: string[][] = [];
    const deadCode: string[] = [];
    
    // Create nodes for each component
    for (const component of components) {
      const node: CallGraphNode = {
        id: component.id,
        name: component.name,
        type: 'module',
        file: component.path,
        complexity: component.metadata.complexity,
        fanIn: component.dependents.length,
        fanOut: component.dependencies.length,
        depth: 0, // Will be calculated
        critical: component.metadata.isEntry || false
      };
      nodes.push(node);
      
      if (component.metadata.isEntry) {
        entryPointIds.push(component.id);
      }
    }
    
    // Create edges based on connections
    const componentMap = new Map(components.map(c => [c.id, c]));
    for (const component of components) {
      for (const depId of component.dependencies) {
        if (componentMap.has(depId)) {
          edges.push({
            from: component.id,
            to: depId,
            count: 1,
            type: 'direct',
            async: false,
            conditional: false
          });
        }
      }
    }
    
    // Detect cycles using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    const detectCycle = (nodeId: string, path: string[] = []): void => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);
      
      const component = componentMap.get(nodeId);
      if (component) {
        for (const depId of component.dependencies) {
          if (!visited.has(depId)) {
            detectCycle(depId, [...path]);
          } else if (recursionStack.has(depId)) {
            // Found a cycle
            const cycleStart = path.indexOf(depId);
            if (cycleStart !== -1) {
              cycles.push(path.slice(cycleStart));
            }
          }
        }
      }
      
      recursionStack.delete(nodeId);
    };
    
    // Run cycle detection from each unvisited node
    for (const node of nodes) {
      if (!visited.has(node.id)) {
        detectCycle(node.id);
      }
    }
    
    // Find dead code (components with no entry path)
    const reachable = new Set<string>();
    const markReachable = (nodeId: string): void => {
      if (reachable.has(nodeId)) return;
      reachable.add(nodeId);
      
      const component = componentMap.get(nodeId);
      if (component) {
        for (const depId of component.dependencies) {
          markReachable(depId);
        }
      }
    };
    
    for (const entryId of entryPointIds) {
      markReachable(entryId);
    }
    
    for (const node of nodes) {
      if (!reachable.has(node.id) && !node.critical) {
        deadCode.push(node.id);
      }
    }
    
    return {
      nodes,
      edges,
      entryPoints: entryPointIds,
      cycles,
      layers: [],
      hotPaths: [],
      deadCode
    };
  }

  protected async analyzeDatabaseConnections(components: ComponentNode[]): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    const connectionMap = new Map<string, DatabaseConnection>();
    
    // Analyze each component for database connections
    for (const component of components) {
      try {
        const fullPath = path.join(this.projectPath, component.path);
        const content = await this.readFile(fullPath);
        
        const dbConnections = await this.detectDatabaseConnections(content);
        
        for (const conn of dbConnections) {
          const key = `${conn.type}_${conn.host || 'localhost'}`;
          
          if (!connectionMap.has(key)) {
            connectionMap.set(key, {
              ...conn,
              componentIds: [component.id],
              usage: [{
                componentId: component.id,
                operations: this.extractDatabaseOperations(content),
                frequency: 1,
                critical: component.metadata.isEntry || false
              }]
            });
          } else {
            const existing = connectionMap.get(key)!;
            existing.componentIds.push(component.id);
            existing.usage.push({
              componentId: component.id,
              operations: this.extractDatabaseOperations(content),
              frequency: 1,
              critical: component.metadata.isEntry || false
            });
          }
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }
    
    return Array.from(connectionMap.values());
  }

  private extractDatabaseOperations(content: string): any[] {
    const operations: any[] = [];
    
    // Common ORM/database patterns
    const patterns = [
      { regex: /\.find(?:One|All|By)?\(/g, type: 'read' },
      { regex: /\.create\(/g, type: 'write' },
      { regex: /\.save\(/g, type: 'write' },
      { regex: /\.update(?:One|Many)?\(/g, type: 'write' },
      { regex: /\.delete(?:One|Many)?\(/g, type: 'write' },
      { regex: /SELECT\s+/gi, type: 'read' },
      { regex: /INSERT\s+INTO/gi, type: 'write' },
      { regex: /UPDATE\s+/gi, type: 'write' },
      { regex: /DELETE\s+FROM/gi, type: 'write' },
      { regex: /BEGIN\s+TRANSACTION/gi, type: 'transaction' }
    ];
    
    for (const pattern of patterns) {
      const matches = content.match(pattern.regex);
      if (matches) {
        operations.push({
          type: pattern.type,
          tables: [], // Would need more analysis to extract table names
          complexity: 1,
          optimized: false
        });
      }
    }
    
    return operations;
  }

  protected async analyzeTestCoverage(components: ComponentNode[]): Promise<TestCoverage | null> {
    // Look for test files
    const testFiles = await this.findFiles([
      '**/*.test.ts', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js',
      '**/__tests__/**/*.ts', '**/__tests__/**/*.js'
    ]);
    
    if (testFiles.length === 0) {
      return null;
    }
    
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
    
    // Basic coverage estimation based on test file presence
    const componentFiles = new Set(components.map(c => c.path));
    const testedComponents = new Set<string>();
    
    for (const testFile of testFiles) {
      try {
        const content = await this.readFile(testFile);
        
        // Look for import statements to determine what's being tested
        const importMatches = content.match(/from\s+['"](.*?)['"]|require\(['"](.*?)['"]\)/g);
        if (importMatches) {
          for (const match of importMatches) {
            const importPath = match.match(/['"]([^'"]+)['"]/)?.[1];
            if (importPath) {
              const resolvedPath = this.resolveImportPath(importPath, testFile);
              if (resolvedPath && componentFiles.has(resolvedPath)) {
                testedComponents.add(resolvedPath);
              }
            }
          }
        }
        
        // Count test cases
        const testCases = content.match(/\b(it|test|describe)\s*\(/g);
        if (testCases) {
          coverage.statements.total += testCases.length;
          coverage.statements.covered += Math.floor(testCases.length * 0.8); // Estimate 80% pass rate
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }
    
    // Calculate coverage percentages
    const coveredCount = testedComponents.size;
    const totalCount = componentFiles.size;
    coverage.overall = totalCount > 0 ? Math.round((coveredCount / totalCount) * 100) : 0;
    
    coverage.lines.total = totalCount;
    coverage.lines.covered = coveredCount;
    coverage.lines.percentage = coverage.overall;
    
    coverage.functions = { ...coverage.lines };
    coverage.branches = { ...coverage.lines };
    
    // Mark uncovered files
    for (const file of componentFiles) {
      if (!testedComponents.has(file)) {
        coverage.uncoveredFiles.push(file);
      }
      coverage.byComponent[file] = {
        lines: testedComponents.has(file) ? 80 : 0,
        branches: testedComponents.has(file) ? 75 : 0,
        functions: testedComponents.has(file) ? 85 : 0,
        statements: testedComponents.has(file) ? 80 : 0,
        tests: 0
      };
    }
    
    return coverage;
  }

  protected async assessRisks(components: ComponentNode[], connections: Connection[]): Promise<RiskArea[]> {
    const risks: RiskArea[] = [];

    // Assess risks based on architectural patterns and topology
    for (const component of components) {
      const reasons: string[] = [];
      let riskLevel: 'low' | 'medium' | 'high' = 'low';

      // High complexity
      if (component.metadata.complexity > 7) {
        reasons.push(`High complexity (${component.metadata.complexity}/10)`);
        riskLevel = 'high';
      }

      // Critical integrations
      const isExternalIntegration = this.topology.integrations.some(i => 
        i.critical && component.path.toLowerCase().includes(i.name.toLowerCase())
      );
      if (isExternalIntegration) {
        reasons.push('Critical external integration');
        riskLevel = 'high';
      }

      // Entry point risks
      if (component.metadata.isEntry) {
        reasons.push('System entry point');
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
}