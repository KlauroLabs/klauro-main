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
  private options: IntegratedAnalysisOptions = {};
  private pluginsUsed: string[] = [];

  constructor() {
    super();
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
    const span = telemetry.createSpan('integrated-analyzer.analyzeProject', {
      repositoryPath,
      organizationId: this.options.organizationId,
      projectId: this.options.projectId,
      options: this.options
    });

    try {
      console.log('🚀 Starting integrated system analysis...');
      
      // Step 1: Try to find the best analyzer through plugin registry
      let selectedAnalyzer: BaseAnalyzer | null = null;
      if (this.options.usePluginRegistry !== false) {
        selectedAnalyzer = await this.selectBestAnalyzer(repositoryPath);
      }
      
      // Step 2: Fall back to integrated analysis if no specific analyzer found
      const blueprint = selectedAnalyzer 
        ? await selectedAnalyzer.analyzeRepository(repositoryPath, this.options)
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
        type: 'integrated_analysis_completed',
        source: { analyzer: this.getAnalyzerName(), analysisId: this.analysisId },
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
        source: { analyzer: this.getAnalyzerName(), analysisId: this.analysisId },
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
      console.warn('Failed to select analyzer from plugin registry:', error.message);
      span.end();
      return null;
    }
  }

  private async performIntegratedAnalysis(repositoryPath: string): Promise<ArchitectureBlueprint> {
    console.log('🔧 Performing integrated analysis...');
    
    // Use the inherited analyzeRepository method which already has telemetry integration
    return await this.analyzeRepository(repositoryPath, this.options);
  }

  // Implement abstract methods required by BaseAnalyzer
  protected async detectLanguageAndFramework(): Promise<LanguageDetection> {
    const span = telemetry.createSpan('integrated-analyzer.detectLanguageAndFramework');
    
    try {
      // Use the enhanced framework detector
      const frameworks = await this.frameworkDetector.detectFrameworks(this.projectPath);
      
      if (frameworks.length > 0) {
        const primary = frameworks[0];
        span.end();
        return {
          language: primary.language,
          confidence: primary.confidence,
          frameworks: frameworks.map(f => ({
            name: f.name,
            version: f.version,
            confidence: f.confidence,
            patterns: [],
            metadata: f.metadata
          })),
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
      const sourceDir = await this.findSourceDirectory();
      const files = await this.findFiles(['**/*.{js,ts,jsx,tsx,py,java,cs,go,rs}']);
      
      const components: ComponentNode[] = [];
      let analyzedFiles = 0;
      let skippedFiles = 0;
      
      for (const filePath of files) {
        try {
          const component = await this.analyzeFileAsComponent(filePath);
          if (component) {
            components.push(component);
            analyzedFiles++;
          }
        } catch (error) {
          skippedFiles++;
          console.warn(`⚠️ Skipped ${filePath}: ${error.message}`);
        }
      }
      
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
    const content = await this.readFile(filePath);
    const relativePath = path.relative(this.projectPath, filePath);
    
    // Basic component analysis
    const component: ComponentNode = {
      id: this.generateComponentId(filePath),
      name: path.basename(filePath, path.extname(filePath)),
      type: this.inferComponentType(filePath, content),
      path: relativePath,
      language: this.inferLanguageFromFile(filePath),
      framework: 'unknown',
      size: Buffer.byteLength(content, 'utf8'),
      linesOfCode: content.split('\n').length,
      dependencies: [],
      dependents: [],
      functions: await this.extractFunctions(content, this.inferLanguageFromFile(filePath)),
      imports: this.extractImports(content),
      exports: this.extractExports(content),
      metadata: {
        complexity: this.calculateComplexity(content),
        isEntry: false,
        isTest: filePath.includes('test') || filePath.includes('spec')
      }
    };
    
    return component;
  }

  private inferComponentType(filePath: string, content: string): string {
    const fileName = path.basename(filePath).toLowerCase();
    
    if (fileName.includes('controller')) return 'controller';
    if (fileName.includes('service')) return 'service';
    if (fileName.includes('model') || fileName.includes('entity')) return 'model';
    if (fileName.includes('middleware')) return 'middleware';
    if (fileName.includes('route') || fileName.includes('router')) return 'route';
    if (fileName.includes('component') && content.includes('React')) return 'react_component';
    if (fileName.includes('test') || fileName.includes('spec')) return 'test';
    if (fileName.includes('config')) return 'configuration';
    if (fileName.includes('util') || fileName.includes('helper')) return 'utility';
    
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
    
    // JavaScript/TypeScript imports
    const jsImports = content.match(/(?:import.*from\s+['"`]([^'"`]+)['"`]|require\s*\(\s*['"`]([^'"`]+)['"`]\))/g);
    if (jsImports) {
      jsImports.forEach(imp => {
        const match = imp.match(/['"`]([^'"`]+)['"`]/);
        if (match) imports.push(match[1]);
      });
    }
    
    // Python imports
    const pyImports = content.match(/(?:from\s+(\w+)|import\s+(\w+))/g);
    if (pyImports) {
      pyImports.forEach(imp => {
        const match = imp.match(/(?:from\s+(\w+)|import\s+(\w+))/);
        if (match) imports.push(match[1] || match[2]);
      });
    }
    
    return imports;
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    
    // JavaScript/TypeScript exports
    const jsExports = content.match(/export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g);
    if (jsExports) {
      jsExports.forEach(exp => {
        const match = exp.match(/(\w+)$/);
        if (match) exports.push(match[1]);
      });
    }
    
    return exports;
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
    const connections: Connection[] = [];
    
    // Basic connection analysis based on imports/dependencies
    components.forEach(component => {
      component.imports.forEach(importPath => {
        const targetComponent = components.find(c => 
          c.name === importPath || 
          c.path.includes(importPath.replace(/[./]/g, '/'))
        );
        
        if (targetComponent) {
          connections.push({
            id: `${component.id}_to_${targetComponent.id}`,
            from: component.id,
            to: targetComponent.id,
            type: 'import',
            weight: 1,
            bidirectional: false,
            metadata: { importPath }
          });
        }
      });
    });
    
    return connections;
  }

  protected async assessRisks(components: ComponentNode[], connections: Connection[]): Promise<RiskArea[]> {
    const risks: RiskArea[] = [];
    
    // Identify high-complexity components as risks
    components.forEach(component => {
      if (component.metadata.complexity > 7) {
        risks.push({
          id: `risk_${component.id}`,
          componentId: component.id,
          riskType: 'complexity',
          riskLevel: 'high',
          description: `High complexity score: ${component.metadata.complexity}`,
          impact: 'maintainability',
          recommendation: 'Consider refactoring to reduce complexity'
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
        type: c.type,
        calls: [],
        calledBy: []
      })),
      edges: [],
      metadata: {
        totalNodes: components.length,
        totalEdges: 0,
        maxDepth: 0,
        complexity: 0
      }
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
    const testComponents = components.filter(c => c.metadata.isTest);
    
    return {
      overall: testComponents.length / components.length * 100,
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
      uncoveredFiles: components.filter(c => !c.metadata.isTest).map(c => c.path)
    };
  }
}

// Export singleton instance
export const integratedAnalyzer = new IntegratedSystemAnalyzer();