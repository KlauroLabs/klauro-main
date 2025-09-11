// Universal base analyzer interface - framework and language agnostic
// This defines the contract that all specific analyzers must implement

import { ArchitectureBlueprint, ComponentNode, Connection, RiskArea, ProjectMetadata } from '../types';

export interface AnalyzerOptions {
  includeTests?: boolean;
  maxDepth?: number;
  excludePatterns?: string[];
  customPatterns?: Record<string, string[]>;
}

export interface LanguageDetection {
  language: string;
  confidence: number;
  frameworks: FrameworkDetection[];
  files: string[];
}

export interface FrameworkDetection {
  name: string;
  version?: string;
  confidence: number;
  patterns: string[];
}

export interface ComponentDiscovery {
  totalFiles: number;
  analyzedFiles: number;
  skippedFiles: number;
  components: ComponentNode[];
}

// Base abstract class that all language/framework analyzers extend
export abstract class BaseAnalyzer {
  protected projectPath: string = '';
  protected options: AnalyzerOptions = {};

  constructor() {}

  // Main entry point - orchestrates the entire analysis process
  async analyzeRepository(repositoryPath: string, options: AnalyzerOptions = {}): Promise<ArchitectureBlueprint> {
    this.projectPath = repositoryPath;
    this.options = options;

    console.log(`🔍 Starting ${this.getAnalyzerName()} analysis of: ${repositoryPath}`);

    // Step 1: Detect if this analyzer can handle this project
    const detection = await this.detectLanguageAndFramework();
    if (detection.confidence < 0.5) {
      throw new Error(`${this.getAnalyzerName()} analyzer not suitable for this project`);
    }

    // Step 2: Discover and classify all files
    const discovery = await this.discoverComponents();
    console.log(`📁 Discovered ${discovery.totalFiles} files, analyzed ${discovery.analyzedFiles}, found ${discovery.components.length} components`);

    // Step 3: Analyze relationships and dependencies
    const connections = await this.analyzeConnections(discovery.components);
    console.log(`🔗 Found ${connections.length} connections`);

    // Step 4: Identify architecture patterns and entry points
    const entryPoints = await this.identifyEntryPoints(discovery.components);
    console.log(`🚪 Identified ${entryPoints.length} entry points`);

    // Step 5: Assess risks and complexity
    const riskAreas = await this.assessRisks(discovery.components, connections);

    // Step 6: Generate final blueprint
    const blueprint: ArchitectureBlueprint = {
      projectName: await this.getProjectName(),
      framework: detection.frameworks[0]?.name || detection.language,
      components: discovery.components,
      connections,
      entryPoints,
      orphanedComponents: this.identifyOrphanedComponents(discovery.components),
      riskAreas,
      metadata: await this.generateProjectMetadata(discovery, detection)
    };

    console.log(`✅ ${this.getAnalyzerName()} analysis complete: ${blueprint.components.length} components, ${blueprint.connections.length} connections`);
    return blueprint;
  }

  // Abstract methods that each analyzer must implement
  abstract getAnalyzerName(): string;
  abstract getSupportedLanguages(): string[];
  abstract getSupportedFrameworks(): string[];
  
  protected abstract detectLanguageAndFramework(): Promise<LanguageDetection>;
  protected abstract discoverComponents(): Promise<ComponentDiscovery>;
  protected abstract analyzeConnections(components: ComponentNode[]): Promise<Connection[]>;
  protected abstract identifyEntryPoints(components: ComponentNode[]): Promise<string[]>;
  protected abstract assessRisks(components: ComponentNode[], connections: Connection[]): Promise<RiskArea[]>;

  // Common helper methods that can be overridden by specific analyzers
  protected async getProjectName(): Promise<string> {
    const packageJsonPath = `${this.projectPath}/package.json`;
    try {
      const fs = await import('fs-extra');
      const packageJson = await fs.readJSON(packageJsonPath);
      return packageJson.name || this.getDefaultProjectName();
    } catch {
      return this.getDefaultProjectName();
    }
  }

  private getDefaultProjectName(): string {
    const path = require('path');
    return path.basename(this.projectPath);
  }

  protected identifyOrphanedComponents(components: ComponentNode[]): string[] {
    return components
      .filter(comp => 
        comp.dependencies.length === 0 && 
        comp.dependents.length === 0 && 
        !comp.metadata.isEntry
      )
      .map(comp => comp.id);
  }

  protected async generateProjectMetadata(
    discovery: ComponentDiscovery, 
    detection: LanguageDetection
  ): Promise<ProjectMetadata> {
    const avgComplexity = discovery.components.length > 0
      ? discovery.components.reduce((sum, c) => sum + c.metadata.complexity, 0) / discovery.components.length
      : 0;

    return {
      totalComponents: discovery.components.length,
      frameworkVersion: detection.frameworks[0]?.version || 'unknown',
      analysisDate: new Date(),
      repositoryPath: this.projectPath,
      entryPointsCount: 0, // Will be set after entry point analysis
      orphanedCount: 0,   // Will be set after orphan analysis  
      complexityAverage: avgComplexity
    };
  }

  // Utility methods for file system operations
  protected async findFiles(patterns: string[], excludePatterns: string[] = []): Promise<string[]> {
    const { glob } = await import('glob');
    const allFiles: string[] = [];

    for (const pattern of patterns) {
      const files = await glob(pattern, {
        cwd: this.projectPath,
        ignore: excludePatterns,
        absolute: true
      });
      allFiles.push(...files);
    }

    return [...new Set(allFiles)]; // Remove duplicates
  }

  protected async readFile(filePath: string): Promise<string> {
    const fs = await import('fs-extra');
    return fs.readFile(filePath, 'utf-8');
  }

  protected generateComponentId(filePath: string): string {
    const path = require('path');
    const relativePath = path.relative(this.projectPath, filePath);
    return relativePath.replace(/[^a-zA-Z0-9]/g, '_');
  }

  protected calculateComplexity(content: string): number {
    // Universal complexity calculation based on control flow
    const complexityPatterns = [
      /\bif\b/g, /\belse\b/g, /\bwhile\b/g, /\bfor\b/g,
      /\bswitch\b/g, /\bcase\b/g, /\btry\b/g, /\bcatch\b/g,
      /\bthrow\b/g, /\breturn\b/g, /\b&&\b/g, /\b\|\|\b/g,
      /\?\s*:/g, // Ternary operators
    ];

    let complexity = 1; // Base complexity
    for (const pattern of complexityPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return Math.min(complexity, 10); // Cap at 10
  }
}

// Factory for creating the appropriate analyzer based on project detection
export class AnalyzerFactory {
  private static analyzers: BaseAnalyzer[] = [];

  static registerAnalyzer(analyzer: BaseAnalyzer): void {
    this.analyzers.push(analyzer);
  }

  static async createAnalyzer(repositoryPath: string): Promise<BaseAnalyzer> {
    // Try each analyzer to see which one can handle this project
    for (const analyzer of this.analyzers) {
      try {
        const detection = await analyzer['detectLanguageAndFramework'].call(analyzer);
        if (detection.confidence > 0.5) {
          return analyzer;
        }
      } catch (error) {
        // This analyzer can't handle the project, try the next one
        continue;
      }
    }

    throw new Error('No suitable analyzer found for this project type');
  }

  static getAvailableAnalyzers(): string[] {
    return this.analyzers.map(analyzer => analyzer.getAnalyzerName());
  }
}