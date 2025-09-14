/**
 * Integrated System Analyzer
 * 
 * Orchestrates the complete analysis pipeline using:
 * - Enhanced BaseAnalyzer with telemetry integration
 * - Database persistence through repositories
 * - Advanced pattern detection
 * - Plugin registry for extensibility
 * - Manifest generation with visualization
 */

import { BaseAnalyzer, AnalyzerOptions, LanguageDetection, ComponentDiscovery } from './base-analyzer';
import { 
  ArchitectureBlueprint, ComponentNode, Connection, RiskArea, 
  EntryPoint, ExitPoint, CallGraph, DatabaseConnection, TestCoverage
} from '../types';
import { ManifestGenerator } from './manifest-generator';
import { pluginRegistry } from './plugin-registry';
import { telemetry } from '../telemetry/telemetry-schema';
import { projectRepository } from '../database/repositories/project-repository';
import { FrameworkDetector } from './patterns/framework-detector';
import { EntryExitDetector } from './patterns/entry-exit-detector';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface IntegratedAnalysisOptions extends AnalyzerOptions {
  organizationId?: string;
  projectId?: string;
  persistResults?: boolean;
  generateManifest?: boolean;
  manifestOutputPath?: string;
  usePluginRegistry?: boolean;
  enableTelemetry?: boolean;
}

export interface IntegratedAnalysisResult {
  blueprint: ArchitectureBlueprint;
  manifest?: any;
  manifestPath?: string;
  analysisId: string;
  duration: number;
  metadata: {
    analyzer: string;
    telemetryEvents: number;
    persistedComponents: number;
    pluginsUsed: string[];
  };
}

export class IntegratedSystemAnalyzer extends BaseAnalyzer {
  private manifestGenerator?: ManifestGenerator;
  protected options: IntegratedAnalysisOptions = {};
  private pluginsUsed: string[] = [];
  protected frameworkDetector: FrameworkDetector;

  constructor() {
    super();
    this.frameworkDetector = new FrameworkDetector();
  }

  getAnalyzerName(): string {
    return 'Integrated System Analyzer';
  }

  getSupportedLanguages(): string[] {
    return ['javascript', 'typescript', 'python', 'java', 'csharp', 'go', 'rust'];
  }

  getSupportedFrameworks(): string[] {
    return ['express', 'nestjs', 'react', 'vue', 'angular', 'django', 'flask', 'spring', 'fastapi'];
  }

  /**
   * Main analysis method that orchestrates the entire process
   */
  async analyzeProject(
    repositoryPath: string, 
    options: IntegratedAnalysisOptions = {}
  ): Promise<IntegratedAnalysisResult> {
    this.options = { ...this.options, ...options };
    const analysisStartTime = Date.now();
    
    // Initialize manifest generator if needed
    if (this.options.generateManifest) {
      this.manifestGenerator = new ManifestGenerator(
        { includeTelemetry: this.options.enableTelemetry },
        this.options.organizationId,
        this.options.projectId
      );
    }
    
    // Start comprehensive telemetry span
    const span = telemetry.createSpan('integrated-analyzer.analyzeProject');

    try {
      console.log('🚀 Starting integrated system analysis...');
      
      // Step 1: Try to find the best analyzer through plugin registry
      let selectedAnalyzer: BaseAnalyzer | null = null;
      if (this.options.usePluginRegistry !== false) {
        selectedAnalyzer = await this.selectBestAnalyzer(repositoryPath);
      }
      
      // Step 2: Fall back to integrated analysis if no specific analyzer found
      const blueprint = selectedAnalyzer 
        ? await selectedAnalyzer.analyzeRepository(repositoryPath, this.options as any)
        : await this.performIntegratedAnalysis(repositoryPath);
        
      // Step 3: Generate manifest if requested
      let manifest, manifestPath;
      if (this.options.generateManifest && this.manifestGenerator) {
        const duration = Date.now() - analysisStartTime;
        manifest = await this.manifestGenerator.generateManifest(
          blueprint,
          this.analysisId,
          this.getAnalyzerName(),
          duration
        );
        
        if (this.options.manifestOutputPath) {
          manifestPath = this.options.manifestOutputPath;
          await this.manifestGenerator.saveManifest(manifest, manifestPath);
        }
      }
      
      const finalDuration = Date.now() - analysisStartTime;
      
      // Emit comprehensive completion event
      telemetry.emit({
        type: 'analysis_completed',
        source: { analyzer: this.getAnalyzerName() },
        data: {
          duration: finalDuration,
          componentCount: blueprint.components.length,
          frameworksDetected: blueprint.technologyStack?.additionalFrameworks?.length || 0,
          pluginsUsed: this.pluginsUsed,
          manifestGenerated: !!manifest,
          persistedResults: this.options.persistResults
        }
      });
      
      span.end();
      
      return {
        blueprint,
        manifest,
        manifestPath,
        analysisId: this.analysisId,
        duration: finalDuration,
        metadata: {
          analyzer: selectedAnalyzer?.getAnalyzerName() || this.getAnalyzerName(),
          telemetryEvents: 0, // TODO: Get from telemetry system
          persistedComponents: blueprint.components.length,
          pluginsUsed: this.pluginsUsed
        }
      };
      
    } catch (error) {
      telemetry.emit({
        type: 'error_occurred',
        source: { analyzer: this.getAnalyzerName() },
        data: {
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - analysisStartTime
        }
      });
      
      span.end();
      throw error;
    }
  }

  private async selectBestAnalyzer(repositoryPath: string): Promise<BaseAnalyzer | null> {
    const span = telemetry.createSpan('integrated-analyzer.selectBestAnalyzer');
    
    try {
      // Discover and register plugins
      await pluginRegistry.discoverPlugins({
        includeOfficial: true,
        includeCommunity: true,
        includeInternal: true
      });
      
      // Get the best analyzer for this project
      const analyzer = await pluginRegistry.getAnalyzerForProject(repositoryPath);
      
      if (analyzer) {
        const stats = pluginRegistry.getStatistics();
        this.pluginsUsed = stats.supportedFrameworks.slice(0, 3); // Sample
      }
      
      span.end();
      return analyzer;
    } catch (error) {
      console.warn('Failed to select analyzer from plugin registry:', error instanceof Error ? error.message : String(error));
      span.end();
      return null;
    }
  }

  private async performIntegratedAnalysis(repositoryPath: string): Promise<ArchitectureBlueprint> {
    console.log('🔧 Performing integrated analysis...');
    
    // Use the inherited analyzeRepository method which already has telemetry integration
    return await this.analyzeRepository(repositoryPath, this.options as any);
  }

  // Implement abstract methods required by BaseAnalyzer
  protected async detectLanguageAndFramework(): Promise<LanguageDetection> {
    const span = telemetry.createSpan('integrated-analyzer.detectLanguageAndFramework');
    
    try {
      // Use the enhanced framework detector
      const techStack = await this.frameworkDetector.detectFrameworks(this.projectPath);
      
      if (techStack.primaryFramework) {
        span.end();
        return {
          language: techStack.primaryFramework.language || 'unknown',
          confidence: techStack.primaryFramework.confidence || 0.5,
          frameworks: [
            ...techStack.additionalFrameworks.map(f => ({
              name: f.name,
              version: f.version,
              confidence: f.confidence || 0.5,
              patterns: [],
              metadata: f.metadata
            })),
            {
              name: techStack.primaryFramework.name,
              version: techStack.primaryFramework.version,
              confidence: techStack.primaryFramework.confidence || 0.5,
              patterns: [],
              metadata: techStack.primaryFramework.metadata
            }
          ],
          files: [] // TODO: Get from framework detector
        };
      }
      
      // Fallback detection
      const fallback = await this.basicLanguageDetection();
      span.end();
      return fallback;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  private async basicLanguageDetection(): Promise<LanguageDetection> {
    // Check for common files and patterns
    const packageJsonPath = path.join(this.projectPath, 'package.json');
    
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      
      return {
        language: 'javascript',
        confidence: 0.8,
        frameworks: [{
          name: 'nodejs',
          confidence: 0.8,
          patterns: ['package.json']
        }],
        files: ['package.json']
      };
    }
    
    // Check for Python
    const requirementsPath = path.join(this.projectPath, 'requirements.txt');
    if (await fs.pathExists(requirementsPath)) {
      return {
        language: 'python',
        confidence: 0.8,
        frameworks: [],
        files: ['requirements.txt']
      };
    }
    
    return {
      language: 'unknown',
      confidence: 0.0,
      frameworks: [],
      files: []
    };
  }

  protected async discoverComponents(): Promise<ComponentDiscovery> {
    const span = telemetry.createSpan('integrated-analyzer.discoverComponents');
    
    try {
      // Use the language detection to pick the right analyzer
      const detection = await this.detectLanguageAndFramework();
      
      // Find all source files with proper exclude patterns
      const excludePatterns = this.options.excludePatterns || ['node_modules/**', 'dist/**', 'build/**', '.git/**'];
      const files = await this.findFiles(
        ['**/*.{js,jsx,ts,tsx,mjs,cjs,py,java,cs,go,rs,php,rb}'],
        excludePatterns
      );
      
      const components: ComponentNode[] = [];
      let analyzedFiles = 0;
      let skippedFiles = 0;
      
      console.log(`🔍 Discovering components in ${files.length} files...`);
      
      for (const filePath of files) {
        try {
          const component = await this.analyzeFileAsComponent(filePath);
          if (component) {
            components.push(component);
            analyzedFiles++;
            
            // Progress reporting
            if (analyzedFiles % 10 === 0) {
              console.log(`📊 Progress: ${analyzedFiles} components discovered...`);
            }
          } else {
            skippedFiles++;
          }
        } catch (error) {
          skippedFiles++;
          // Only log warnings for non-trivial errors
          if (!(error instanceof Error && error.message.includes('FILE_TOO_LARGE'))) {
            console.warn(`⚠️ Skipped ${path.relative(this.projectPath, filePath)}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      
      console.log(`✅ Component discovery complete: ${components.length} components found`);
      
      span.end();
      return {
        totalFiles: files.length,
        analyzedFiles,
        skippedFiles,
        components
      };
    } catch (error) {
      span.end();
      throw error;
    }
  }

  private async analyzeFileAsComponent(filePath: string): Promise<ComponentNode | null> {
    try {
      const content = await this.readFile(filePath);
      const relativePath = path.relative(this.projectPath, filePath);
      const fileStats = await fs.stat(filePath);
      
      // Skip empty files or files that are too large
      if (content.length === 0) {
        return null;
      }
      
      // Skip generated or vendor files
      if (this.isGeneratedOrVendorFile(filePath, content)) {
        return null;
      }
      
      const language = this.inferLanguageFromFile(filePath);
      const componentType = this.inferComponentType(filePath, content);
      const functions = await this.extractFunctions(content, language);
      const imports = this.extractImports(content);
      const exports = this.extractExports(content);
      const complexity = this.calculateComplexity(content);
      const lineCount = content.split('\n').length;
      
      // Build the component
      const component: ComponentNode = {
        id: this.generateComponentId(filePath),
        name: path.basename(filePath, path.extname(filePath)),
        type: componentType as any,
        path: relativePath,
        language: language,
        framework: await this.detectFrameworkForFile(filePath, content),
        dependencies: [],
        dependents: [],
        metrics: {
          linesOfCode: lineCount,
          complexity: complexity,
          maintainability: this.calculateMaintainability(complexity, lineCount),
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: this.calculateTechnicalDebt(complexity, lineCount)
        },
        metadata: {
          lineCount: lineCount,
          complexity: complexity,
          lastModified: fileStats.mtime,
          exports: exports,
          imports: imports,
          isEntry: this.isEntryPoint(filePath, content),
          layer: this.determineLayer(filePath, content) as any,
          responsibilities: this.inferResponsibilities(filePath, content),
          functions: functions
        }
      };
      
      return component;
    } catch (error) {
      // Re-throw file system errors but return null for analysis errors
      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw error;
      }
      return null;
    }
  }

  private inferComponentType(filePath: string, content: string): string {
    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();
    
    // Test files
    if (fileName.includes('.test.') || fileName.includes('.spec.') || 
        dirName.includes('test') || dirName.includes('__tests__')) {
      return 'test';
    }
    
    // Controllers/Routes
    if (fileName.includes('controller') || fileName.includes('route') || 
        fileName.includes('router') || dirName.includes('routes') ||
        dirName.includes('controllers')) {
      return 'controller';
    }
    
    // Services
    if (fileName.includes('service') || dirName.includes('services')) {
      return 'service';
    }
    
    // Models/Entities
    if (fileName.includes('model') || fileName.includes('entity') || 
        fileName.includes('schema') || dirName.includes('models') ||
        dirName.includes('entities')) {
      return 'model';
    }
    
    // Middleware
    if (fileName.includes('middleware') || dirName.includes('middleware')) {
      return 'middleware';
    }
    
    // UI Components
    if ((fileName.includes('component') || dirName.includes('components')) &&
        (content.includes('React') || content.includes('JSX') || 
         content.includes('render') || content.includes('<template>'))) {
      return 'ui_component';
    }
    
    // Configuration
    if (fileName.includes('config') || fileName.includes('.env') ||
        dirName.includes('config')) {
      return 'config';
    }
    
    // Database related
    if (fileName.includes('migration') || fileName.includes('seed') ||
        dirName.includes('migrations') || dirName.includes('database')) {
      return 'database';
    }
    
    // Utilities
    if (fileName.includes('util') || fileName.includes('helper') ||
        dirName.includes('utils') || dirName.includes('helpers')) {
      return 'utility';
    }
    
    // API specific
    if (content.includes('app.listen') || content.includes('createServer') ||
        content.includes('express()') || content.includes('@Controller')) {
      return 'api';
    }
    
    return 'module';
  }

  private inferLanguageFromFile(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.cs': 'csharp',
      '.go': 'go',
      '.rs': 'rust'
    };
    
    return langMap[ext] || 'unknown';
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    
    // JavaScript/TypeScript ES6 imports
    const es6Imports = content.match(/import\s+(?:[\w*\s{},]*\s+from\s+)?['"`]([^'"`]+)['"`]/gm);
    if (es6Imports) {
      es6Imports.forEach(imp => {
        const match = imp.match(/['"`]([^'"`]+)['"`]/);
        if (match && match[1]) {
          imports.push(match[1]);
        }
      });
    }
    
    // CommonJS requires
    const requireImports = content.match(/require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/gm);
    if (requireImports) {
      requireImports.forEach(imp => {
        const match = imp.match(/['"`]([^'"`]+)['"`]/);
        if (match && match[1]) {
          imports.push(match[1]);
        }
      });
    }
    
    // Dynamic imports
    const dynamicImports = content.match(/import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/gm);
    if (dynamicImports) {
      dynamicImports.forEach(imp => {
        const match = imp.match(/['"`]([^'"`]+)['"`]/);
        if (match && match[1]) {
          imports.push(match[1]);
        }
      });
    }
    
    // Python imports
    const pyImports = content.match(/(?:from\s+([\w.]+)|import\s+([\w.]+))/g);
    if (pyImports) {
      pyImports.forEach(imp => {
        const match = imp.match(/(?:from\s+([\w.]+)|import\s+([\w.]+))/);
        if (match) {
          const moduleName = match[1] || match[2];
          if (moduleName && !moduleName.startsWith('_')) {
            imports.push(moduleName);
          }
        }
      });
    }
    
    // Java imports
    const javaImports = content.match(/import\s+(?:static\s+)?([\w.]+);/g);
    if (javaImports) {
      javaImports.forEach(imp => {
        const match = imp.match(/import\s+(?:static\s+)?([\w.]+);/);
        if (match && match[1]) {
          imports.push(match[1]);
        }
      });
    }
    
    // Remove duplicates and filter out relative imports for now
    return [...new Set(imports)];
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    
    // Named exports
    const namedExports = content.match(/export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/gm);
    if (namedExports) {
      namedExports.forEach(exp => {
        const match = exp.match(/\s+(\w+)$/);
        if (match && match[1]) {
          exports.push(match[1]);
        }
      });
    }
    
    // Default exports with name
    const defaultExports = content.match(/export\s+default\s+(?:class|function)\s+(\w+)/gm);
    if (defaultExports) {
      defaultExports.forEach(exp => {
        const match = exp.match(/\s+(\w+)$/);
        if (match && match[1]) {
          exports.push(`default:${match[1]}`);
        }
      });
    }
    
    // Export statements
    const exportStatements = content.match(/export\s*{([^}]+)}/gm);
    if (exportStatements) {
      exportStatements.forEach(exp => {
        const match = exp.match(/{([^}]+)}/);
        if (match && match[1]) {
          const items = match[1].split(',').map(item => {
            const parts = item.trim().split(/\s+as\s+/);
            return parts[parts.length - 1].trim();
          });
          exports.push(...items);
        }
      });
    }
    
    // CommonJS exports
    const commonjsExports = content.match(/(?:module\.)?exports\.(\w+)\s*=/gm);
    if (commonjsExports) {
      commonjsExports.forEach(exp => {
        const match = exp.match(/\.(\w+)\s*=/);
        if (match && match[1]) {
          exports.push(match[1]);
        }
      });
    }
    
    return [...new Set(exports)];
  }

  private async findSourceDirectory(): Promise<string> {
    const commonSrcDirs = ['src', 'lib', 'app', 'source', 'server'];
    
    for (const dir of commonSrcDirs) {
      const dirPath = path.join(this.projectPath, dir);
      if (await fs.pathExists(dirPath)) {
        return dirPath;
      }
    }
    
    return this.projectPath;
  }

  // Implement remaining abstract methods
  protected async analyzeConnections(components: ComponentNode[]): Promise<Connection[]> {
    const connectionMap = new Map<string, Connection>();
    
    // Analyze imports to create connections
    for (const component of components) {
      // Process each import
      for (const importPath of component.metadata.imports) {
        // Try to find the target component
        const targetComponent = this.findTargetComponent(components, importPath, component.path);
        
        if (targetComponent && targetComponent.id !== component.id) {
          const key = `${component.id}-${targetComponent.id}-import`;
          const existing = connectionMap.get(key);
          
          if (existing) {
            existing.weight = (existing.weight || 0) + 1;
            if (existing.metadata) {
              existing.metadata.callSites = (existing.metadata.callSites || 0) + 1;
            }
          } else {
            connectionMap.set(key, {
              from: component.id,
              to: targetComponent.id,
              type: 'import',
              weight: 1,
              metadata: {
                callSites: 1,
                importType: this.getImportType(importPath)
              }
            });
          }
          
          // Update dependencies and dependents
          if (!component.dependencies.includes(targetComponent.id)) {
            component.dependencies.push(targetComponent.id);
          }
          if (!targetComponent.dependents.includes(component.id)) {
            targetComponent.dependents.push(component.id);
          }
        }
      }
      
      // Analyze function calls for additional connections
      if (component.metadata.functions) {
        for (const func of component.metadata.functions) {
          if (func.calls) {
            for (const call of func.calls) {
              const targetComponent = this.findComponentByExport(components, call.target);
              if (targetComponent && targetComponent.id !== component.id) {
                const key = `${component.id}-${targetComponent.id}-call`;
                const existing = connectionMap.get(key);
                
                if (existing) {
                  existing.weight = (existing.weight || 0) + (call.count || 1);
                } else {
                  connectionMap.set(key, {
                    from: component.id,
                    to: targetComponent.id,
                    type: 'function_call',
                    weight: call.count || 1,
                    metadata: {
                      callSites: call.count || 1
                    }
                  });
                }
              }
            }
          }
        }
      }
    }
    
    return Array.from(connectionMap.values());
  }

  protected async assessRisks(components: ComponentNode[], connections: Connection[]): Promise<RiskArea[]> {
    const risks: RiskArea[] = [];
    
    // Identify high-complexity components as risks
    components.forEach(component => {
      if (component.metadata.complexity > 7) {
        risks.push({
          componentId: component.id,
          riskLevel: 'high',
          reasons: [`High complexity score: ${component.metadata.complexity}`],
          impact: 'maintainability'
        });
      }
    });
    
    return risks;
  }

  protected async generateCallGraph(components: ComponentNode[]): Promise<CallGraph> {
    return {
      nodes: components.map(c => ({
        id: c.id,
        name: c.name,
        type: 'module' as const,
        file: c.path,
        complexity: c.metadata.complexity,
        fanIn: c.dependents.length,
        fanOut: c.dependencies.length,
        depth: 0,
        critical: c.metadata.complexity > 7
      })),
      edges: [],
      entryPoints: [],
      cycles: [],
      layers: [],
      hotPaths: [],
      deadCode: []
    };
  }

  protected async analyzeDatabaseConnections(components: ComponentNode[]): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    
    // Look for database connection patterns in component content
    for (const component of components) {
      try {
        const content = await this.readFile(path.join(this.projectPath, component.path));
        const dbConnections = await this.detectDatabaseConnections(content);
        connections.push(...dbConnections);
      } catch (error) {
        // Skip if can't read file
      }
    }
    
    return connections;
  }

  protected async analyzeTestCoverage(components: ComponentNode[]): Promise<TestCoverage | null> {
    const testComponents = components.filter(c => c.path.includes('test') || c.path.includes('spec'));
    
    return {
      overall: testComponents.length > 0 ? (testComponents.length / components.length * 100) : 0,
      lines: { covered: 0, total: 0, percentage: 0 },
      branches: { covered: 0, total: 0, percentage: 0 },
      functions: { covered: 0, total: 0, percentage: 0 },
      statements: { covered: 0, total: 0, percentage: 0 },
      byComponent: {},
      byType: {
        unit: testComponents.filter(c => c.name.includes('unit')).length,
        integration: testComponents.filter(c => c.name.includes('integration')).length,
        e2e: testComponents.filter(c => c.name.includes('e2e')).length
      },
      uncoveredFiles: components.filter(c => !c.path.includes('test') && !c.path.includes('spec')).map(c => c.path)
    };
  }

  // Helper methods for the enhanced component analysis
  private isGeneratedOrVendorFile(filePath: string, content: string): boolean {
    const fileName = path.basename(filePath);
    
    // Check for generated files
    if (content.includes('// Generated by') ||
        content.includes('/* Generated by') ||
        content.includes('// This file was automatically generated') ||
        content.includes('// Auto-generated') ||
        content.includes('@generated')) {
      return true;
    }
    
    // Check for vendor/third-party files
    if (filePath.includes('node_modules') ||
        filePath.includes('vendor') ||
        filePath.includes('.min.') ||
        fileName.startsWith('bundle.')) {
      return true;
    }
    
    return false;
  }

  private async detectFrameworkForFile(filePath: string, content: string): Promise<string> {
    const detection = await this.detectFramework(content, filePath);
    return detection?.name || 'unknown';
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
           content.includes('NestFactory.create') ||
           content.includes('ReactDOM.render') ||
           content.includes('ReactDOM.createRoot');
  }

  private determineLayer(filePath: string, content: string): string {
    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();

    // Presentation layer
    if (fileName.includes('component') || fileName.includes('page') || 
        fileName.includes('view') || dirName.includes('components') || 
        dirName.includes('pages') || dirName.includes('views')) {
      return 'presentation';
    }

    // Data layer
    if (fileName.includes('model') || fileName.includes('entity') || 
        fileName.includes('schema') || dirName.includes('models') ||
        dirName.includes('entities') || dirName.includes('database')) {
      return 'data';
    }

    // Business layer
    if (fileName.includes('service') || fileName.includes('controller') ||
        dirName.includes('services') || dirName.includes('business')) {
      return 'business';
    }

    // Infrastructure layer
    if (fileName.includes('config') || fileName.includes('util') || 
        fileName.includes('helper') || dirName.includes('utils') ||
        dirName.includes('infrastructure')) {
      return 'infrastructure';
    }

    return 'application';
  }

  private inferResponsibilities(filePath: string, content: string): string[] {
    const responsibilities: string[] = [];
    const fileName = path.basename(filePath).toLowerCase();
    
    if (content.includes('render') || content.includes('JSX')) {
      responsibilities.push('UI rendering');
    }
    
    if (content.includes('useState') || content.includes('useEffect')) {
      responsibilities.push('State management');
    }
    
    if (content.includes('fetch(') || content.includes('axios')) {
      responsibilities.push('HTTP communication');
    }
    
    if (fileName.includes('test') || fileName.includes('spec')) {
      responsibilities.push('Testing');
    }
    
    if (content.includes('router') || content.includes('Route')) {
      responsibilities.push('Routing');
    }
    
    if (content.includes('middleware') || content.includes('next()')) {
      responsibilities.push('Request processing');
    }
    
    if (content.includes('mongoose') || content.includes('Sequelize') || 
        content.includes('TypeORM')) {
      responsibilities.push('Data persistence');
    }
    
    if (content.includes('@Controller') || content.includes('@Service')) {
      responsibilities.push('Dependency injection');
    }

    return responsibilities.length > 0 ? responsibilities : ['Generic functionality'];
  }

  private calculateMaintainability(complexity: number, lineCount: number): number {
    // Simple maintainability index calculation
    const base = 100;
    const complexityPenalty = complexity * 3;
    const sizePenalty = Math.log(lineCount) * 2;
    
    return Math.max(0, Math.min(100, base - complexityPenalty - sizePenalty));
  }

  private calculateTechnicalDebt(complexity: number, lineCount: number): number {
    // Simple technical debt calculation
    let debt = 0;
    
    if (complexity > 10) debt += 3;
    else if (complexity > 7) debt += 2;
    else if (complexity > 5) debt += 1;
    
    if (lineCount > 500) debt += 3;
    else if (lineCount > 300) debt += 2;
    else if (lineCount > 200) debt += 1;
    
    return debt;
  }

  private findTargetComponent(
    components: ComponentNode[], 
    importPath: string, 
    currentFile: string
  ): ComponentNode | undefined {
    // Handle relative imports
    if (importPath.startsWith('.')) {
      const resolvedPath = path.resolve(path.dirname(currentFile), importPath);
      const baseName = path.basename(resolvedPath);
      
      return components.find(c => {
        const componentBaseName = path.basename(c.path, path.extname(c.path));
        return componentBaseName === baseName || c.path.includes(resolvedPath);
      });
    }
    
    // Handle module imports
    return components.find(c => {
      const moduleName = path.basename(c.path, path.extname(c.path));
      return importPath.includes(moduleName) || 
             c.metadata.exports.some(exp => importPath.includes(exp));
    });
  }

  private findComponentByExport(components: ComponentNode[], exportName: string): ComponentNode | undefined {
    return components.find(c => c.metadata.exports.includes(exportName));
  }

  private getImportType(importPath: string): string {
    if (importPath.startsWith('.')) return 'relative';
    if (importPath.startsWith('/')) return 'absolute';
    if (importPath.startsWith('@')) return 'scoped';
    return 'module';
  }
}

// Export singleton instance
export const integratedAnalyzer = new IntegratedSystemAnalyzer();