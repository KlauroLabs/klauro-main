/**
 * Enhanced Base Analyzer with Telemetry and Pattern Integration
 * Integrates all the new telemetry, optimization, and pattern detection capabilities
 */

import { BaseAnalyzer, AnalyzerOptions, LanguageDetection, ComponentDiscovery } from './base-analyzer';
import { 
  ArchitectureBlueprint, ComponentNode, Connection, RiskArea, EntryPoint, ExitPoint,
  CallGraph, DatabaseConnection, TestCoverage, TechnologyStack, ProjectMetadata
} from '../types';
import { telemetry, AnalysisStartedEvent, AnalysisCompletedEvent, TelemetryManifest } from '../telemetry/telemetry-schema';
import { EntryExitDetector } from './patterns/entry-exit-detector';
import { DependencyMapper } from './patterns/dependency-mapper';
import { FrameworkDetector } from './patterns/framework-detector';
import { ASTOptimizer, TraversalOptions } from './ast/ast-optimizer';
import * as path from 'path';

export interface EnhancedAnalyzerOptions extends AnalyzerOptions {
  enableTelemetry?: boolean;
  enableOptimization?: boolean;
  enablePatternDetection?: boolean;
  telemetryConfig?: {
    flushInterval?: number;
    maxBufferSize?: number;
    enableRealTime?: boolean;
  };
  optimizationConfig?: TraversalOptions;
}

export abstract class EnhancedBaseAnalyzer extends BaseAnalyzer {
  protected entryExitDetector: EntryExitDetector;
  protected dependencyMapper: DependencyMapper;
  protected frameworkDetector: FrameworkDetector;
  protected astOptimizer: ASTOptimizer;
  protected analysisStartTime: number = 0;
  protected enhancedOptions: EnhancedAnalyzerOptions = {};

  constructor() {
    super();
    this.entryExitDetector = new EntryExitDetector();
    this.dependencyMapper = new DependencyMapper();
    this.frameworkDetector = new FrameworkDetector();
    this.astOptimizer = new ASTOptimizer();
  }

  // Override the main analysis method to include telemetry and optimizations
  async analyzeRepository(repositoryPath: string, options: EnhancedAnalyzerOptions = {}): Promise<ArchitectureBlueprint> {
    this.projectPath = repositoryPath;
    this.enhancedOptions = { ...this.options, ...options };
    this.analysisStartTime = Date.now();

    // Emit analysis started event
    if (options.enableTelemetry !== false) {
      telemetry.emit({
        type: 'analysis_started',
        source: { analyzer: this.getAnalyzerName() },
        data: {
          repositoryPath,
          language: 'detecting...',
          framework: 'detecting...',
          totalFiles: 0,
          estimatedDuration: undefined,
          options
        }
      } as AnalysisStartedEvent);
    }

    console.log(`🔍 Starting enhanced ${this.getAnalyzerName()} analysis of: ${repositoryPath}`);

    try {
      // Step 1: Enhanced language and framework detection
      const detection = await this.enhancedDetectLanguageAndFramework();
      
      if (detection.confidence < 0.5) {
        throw new Error(`${this.getAnalyzerName()} analyzer not suitable for this project`);
      }

      // Step 2: Enhanced component discovery with optimization
      const discovery = await this.enhancedDiscoverComponents();
      console.log(`📁 Discovered ${discovery.totalFiles} files, analyzed ${discovery.analyzedFiles}, found ${discovery.components.length} components`);

      // Step 3: Enhanced connection analysis with dependency mapping
      const connections = await this.enhancedAnalyzeConnections(discovery.components);
      console.log(`🔗 Found ${connections.length} connections`);

      // Step 4: Enhanced entry/exit point detection
      const entryPoints = await this.enhancedIdentifyEntryPoints(discovery.components);
      const exitPoints = await this.enhancedIdentifyExitPoints(discovery.components);
      console.log(`🚪 Identified ${entryPoints.length} entry points and ${exitPoints.length} exit points`);

      // Step 5: Enhanced risk assessment
      const riskAreas = await this.enhancedAssessRisks(discovery.components, connections);

      // Step 6: Generate enhanced call graph
      this.callGraph = await this.enhancedGenerateCallGraph(discovery.components);
      console.log(`📊 Generated enhanced call graph with ${this.callGraph?.nodes.length || 0} nodes`);

      // Step 7: Enhanced database connection analysis
      this.databaseConnections = await this.enhancedAnalyzeDatabaseConnections(discovery.components);
      console.log(`🗄️ Found ${this.databaseConnections.length} database connections`);

      // Step 8: Enhanced test coverage analysis
      this.testCoverage = await this.enhancedAnalyzeTestCoverage(discovery.components);
      console.log(`✅ Test coverage: ${this.testCoverage?.overall || 0}%`);

      // Step 9: Enhanced technology stack analysis
      const technologyStack = await this.enhancedAnalyzeTechnologyStack();

      // Step 10: Generate final enhanced blueprint
      const blueprint: ArchitectureBlueprint = {
        projectName: await this.getProjectName(),
        framework: detection.frameworks[0]?.name || detection.language,
        components: discovery.components,
        connections,
        entryPoints,
        exitPoints,
        orphanedComponents: this.identifyOrphanedComponents(discovery.components),
        riskAreas,
        metadata: await this.generateEnhancedProjectMetadata(discovery, detection),
        technologyStack,
        dependencies: await this.analyzeDependencies(),
        databaseInfo: await this.analyzeDatabaseInfo(),
        apiEndpoints: await this.analyzeAPIEndpoints(discovery.components),
        securityAnalysis: await this.analyzeSecurityInfo(),
        testingInfo: await this.analyzeTestingInfo(),
        deploymentInfo: await this.analyzeDeploymentInfo()
      };

      // Emit analysis completed event
      const duration = Date.now() - this.analysisStartTime;
      if (options.enableTelemetry !== false) {
        telemetry.emit({
          type: 'analysis_completed',
          source: { analyzer: this.getAnalyzerName() },
          data: {
            success: true,
            componentsFound: blueprint.components.length,
            connectionsFound: blueprint.connections.length,
            entryPointsFound: blueprint.entryPoints.length,
            exitPointsFound: blueprint.exitPoints.length,
            orphanedComponents: blueprint.orphanedComponents.length,
            riskAreas: blueprint.riskAreas.length,
            duration,
            errors: []
          }
        });
      }

      console.log(`✅ Enhanced ${this.getAnalyzerName()} analysis complete: ${blueprint.components.length} components, ${blueprint.connections.length} connections`);
      return blueprint;

    } catch (error) {
      const duration = Date.now() - this.analysisStartTime;
      
      // Emit error event
      if (options.enableTelemetry !== false) {
        telemetry.emit({
          type: 'analysis_completed',
          source: { analyzer: this.getAnalyzerName() },
          data: {
            success: false,
            componentsFound: 0,
            connectionsFound: 0,
            entryPointsFound: 0,
            exitPointsFound: 0,
            orphanedComponents: 0,
            riskAreas: 0,
            duration,
            errors: [error instanceof Error ? error.message : String(error)]
          }
        } as AnalysisCompletedEvent);
      }

      throw error;
    }
  }

  // Enhanced language and framework detection
  protected async enhancedDetectLanguageAndFramework(): Promise<LanguageDetection> {
    const span = telemetry.createSpan('enhancedDetectLanguageAndFramework');

    try {
      // Use both base detection and enhanced framework detector
      const baseDetection = await this.detectLanguageAndFramework();
      
      if (this.enhancedOptions.enablePatternDetection !== false) {
        const technologyStack = await this.frameworkDetector.detectFrameworks(this.projectPath);
        
        // Merge results
        if (technologyStack.primaryFramework) {
          baseDetection.frameworks.unshift({
            name: technologyStack.primaryFramework.name,
            version: technologyStack.primaryFramework.version,
            confidence: technologyStack.primaryFramework.detectionConfidence || 0.9,
            patterns: technologyStack.primaryFramework.patterns || [],
            configFiles: technologyStack.primaryFramework.configFiles,
            metadata: technologyStack.primaryFramework.metadata
          });
        }
        
        // Add additional frameworks
        for (const framework of technologyStack.additionalFrameworks) {
          baseDetection.frameworks.push({
            name: framework.name,
            version: framework.version,
            confidence: framework.detectionConfidence || 0.7,
            patterns: framework.patterns || [],
            configFiles: framework.configFiles,
            metadata: framework.metadata
          });
        }
      }

      span.end();
      return baseDetection;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced component discovery
  protected async enhancedDiscoverComponents(): Promise<ComponentDiscovery> {
    const span = telemetry.createSpan('enhancedDiscoverComponents');

    try {
      // Use base discovery enhanced with optimization
      const baseDiscovery = await this.discoverComponents();

      // If optimization is enabled, optimize file parsing
      if (this.enhancedOptions.enableOptimization !== false) {
        const files = await this.findFiles(
          ['**/*.{js,ts,jsx,tsx,py,java,cs,go,rs,php}'],
          this.enhancedOptions.excludePatterns || []
        );

        // Batch parse files with optimization
        const parseResults = await this.astOptimizer.batchParseFiles(
          files.slice(0, 100), // Limit for demo
          this.enhancedOptions.optimizationConfig || {}
        );

        console.log(`🚀 Optimized parsing: ${parseResults.size} files processed with AST optimization`);
      }

      span.end();
      return baseDiscovery;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced connection analysis
  protected async enhancedAnalyzeConnections(components: ComponentNode[]): Promise<Connection[]> {
    const span = telemetry.createSpan('enhancedAnalyzeConnections');

    try {
      // Use base connection analysis
      const baseConnections = await this.analyzeConnections(components);

      // Enhanced dependency mapping if pattern detection is enabled
      if (this.enhancedOptions.enablePatternDetection !== false) {
        const dependencyGraph = await this.dependencyMapper.mapDependencies(
          components, 
          this.projectPath
        );

        console.log(`📊 Enhanced dependency analysis: ${dependencyGraph.nodes.size} nodes, ${dependencyGraph.cycles.length} cycles`);
        
        // Convert dependency edges to connections and merge with base
        const enhancedConnections = this.convertDependencyGraphToConnections(dependencyGraph);
        
        // Merge and deduplicate connections
        const allConnections = this.mergeConnections(baseConnections, enhancedConnections);
        
        span.end();
        return allConnections;
      }

      span.end();
      return baseConnections;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced entry/exit point detection
  protected async enhancedIdentifyEntryPoints(components: ComponentNode[]): Promise<EntryPoint[]> {
    const span = telemetry.createSpan('enhancedIdentifyEntryPoints');

    try {
      // Use base entry point detection
      const baseEntryPoints = await this.identifyEntryPoints(components);

      // Enhanced pattern-based detection if enabled
      if (this.enhancedOptions.enablePatternDetection !== false) {
        const patternEntryPoints = await this.entryExitDetector.detectEntryPoints(
          components, 
          this.projectPath
        );

        // Merge and deduplicate
        const allEntryPoints = this.mergeEntryPoints(baseEntryPoints, patternEntryPoints);
        
        span.end();
        return allEntryPoints;
      }

      span.end();
      return baseEntryPoints;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced exit point detection
  protected async enhancedIdentifyExitPoints(components: ComponentNode[]): Promise<ExitPoint[]> {
    const span = telemetry.createSpan('enhancedIdentifyExitPoints');

    try {
      // Use base exit point detection
      const baseExitPoints = await this.identifyExitPoints(components);

      // Enhanced pattern-based detection if enabled
      if (this.enhancedOptions.enablePatternDetection !== false) {
        const patternExitPoints = await this.entryExitDetector.detectExitPoints(
          components, 
          this.projectPath
        );

        // Merge and deduplicate
        const allExitPoints = this.mergeExitPoints(baseExitPoints, patternExitPoints);
        
        span.end();
        return allExitPoints;
      }

      span.end();
      return baseExitPoints;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced risk assessment
  protected async enhancedAssessRisks(components: ComponentNode[], connections: Connection[]): Promise<RiskArea[]> {
    const span = telemetry.createSpan('enhancedAssessRisks');

    try {
      // Use base risk assessment
      const baseRisks = await this.assessRisks(components, connections);

      // Add enhanced risk analysis based on dependency graph
      const enhancedRisks: RiskArea[] = [...baseRisks];

      // Add risks from circular dependencies
      if (this.dependencyMapper) {
        const dependencyGraph = await this.dependencyMapper.mapDependencies(components, this.projectPath);
        
        for (const cycle of dependencyGraph.cycles) {
          for (const nodeId of cycle) {
            const existingRisk = enhancedRisks.find(r => r.componentId === nodeId);
            if (existingRisk) {
              existingRisk.reasons.push('Part of circular dependency');
              if (existingRisk.riskLevel === 'low') {
                existingRisk.riskLevel = 'medium';
              }
            } else {
              enhancedRisks.push({
                componentId: nodeId,
                riskLevel: 'medium',
                reasons: ['Part of circular dependency'],
                impact: `Circular dependency affects ${cycle.length} components`
              });
            }
          }
        }
      }

      span.end();
      return enhancedRisks;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced call graph generation
  protected async enhancedGenerateCallGraph(components: ComponentNode[]): Promise<CallGraph> {
    const span = telemetry.createSpan('enhancedGenerateCallGraph');

    try {
      // Use dependency mapper to generate enhanced call graph
      if (this.enhancedOptions.enablePatternDetection !== false) {
        const dependencyGraph = await this.dependencyMapper.mapDependencies(components, this.projectPath);
        const callGraph = this.dependencyMapper.generateCallGraph(components);
        
        span.end();
        return callGraph;
      }

      // Fall back to base call graph
      const baseCallGraph = await this.generateCallGraph(components);
      span.end();
      return baseCallGraph;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced database connection analysis
  protected async enhancedAnalyzeDatabaseConnections(components: ComponentNode[]): Promise<DatabaseConnection[]> {
    const span = telemetry.createSpan('enhancedAnalyzeDatabaseConnections');

    try {
      // Use base analysis enhanced with pattern detection
      const baseConnections = await this.analyzeDatabaseConnections(components);

      // TODO: Add enhanced database pattern detection
      
      span.end();
      return baseConnections;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced test coverage analysis
  protected async enhancedAnalyzeTestCoverage(components: ComponentNode[]): Promise<TestCoverage | null> {
    const span = telemetry.createSpan('enhancedAnalyzeTestCoverage');

    try {
      // Use base test coverage analysis
      const baseCoverage = await this.analyzeTestCoverage(components);
      
      // TODO: Add enhanced test pattern detection and coverage calculation
      
      span.end();
      return baseCoverage;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced technology stack analysis
  protected async enhancedAnalyzeTechnologyStack(): Promise<TechnologyStack> {
    const span = telemetry.createSpan('enhancedAnalyzeTechnologyStack');

    try {
      if (this.enhancedOptions.enablePatternDetection !== false) {
        const technologyStack = await this.frameworkDetector.detectFrameworks(this.projectPath);
        
        span.end();
        return technologyStack;
      }

      // Fall back to base technology stack analysis
      const detection = await this.detectLanguageAndFramework();
      const baseTechStack = await this.analyzeTechnologyStack(detection);
      
      span.end();
      return baseTechStack;
    } catch (error) {
      span.end();
      throw error;
    }
  }

  // Enhanced project metadata generation
  protected async generateEnhancedProjectMetadata(
    discovery: ComponentDiscovery, 
    detection: LanguageDetection
  ): Promise<ProjectMetadata> {
    const baseMetadata = await this.generateProjectMetadata(discovery, detection);
    
    // Add telemetry-specific metadata
    return {
      ...baseMetadata,
      aiGeneratedSummary: this.generateAISummary(discovery, detection)
    };
  }

  // Generate AI summary
  private generateAISummary(discovery: ComponentDiscovery, detection: LanguageDetection): string {
    return `This is a ${detection.language} project with ${discovery.components.length} components. ` +
           `Primary framework: ${detection.frameworks[0]?.name || 'None detected'}. ` +
           `The codebase shows ${detection.confidence > 0.8 ? 'strong' : 'moderate'} adherence to ${detection.language} patterns.`;
  }

  // Generate telemetry manifest
  public generateTelemetryManifest(): TelemetryManifest {
    return telemetry.generateManifest();
  }

  // Get optimization statistics
  public getOptimizationStatistics(): any {
    return this.astOptimizer.getOptimizationStatistics();
  }

  // Helper methods

  private convertDependencyGraphToConnections(dependencyGraph: any): Connection[] {
    const connections: Connection[] = [];
    
    for (const [nodeId, edges] of dependencyGraph.edges) {
      for (const edge of edges) {
        connections.push({
          from: nodeId,
          to: edge.to,
          type: edge.type,
          weight: edge.weight,
          metadata: {
            callSites: edge.metadata.usageCount,
            dataFlow: edge.importPath
          }
        });
      }
    }
    
    return connections;
  }

  private mergeConnections(base: Connection[], enhanced: Connection[]): Connection[] {
    const connectionMap = new Map<string, Connection>();
    
    // Add base connections
    for (const conn of base) {
      const key = `${conn.from}-${conn.to}-${conn.type}`;
      connectionMap.set(key, conn);
    }
    
    // Merge enhanced connections
    for (const conn of enhanced) {
      const key = `${conn.from}-${conn.to}-${conn.type}`;
      const existing = connectionMap.get(key);
      
      if (existing) {
        // Merge metadata
        existing.weight = Math.max(existing.weight || 0, conn.weight || 0);
        existing.metadata = { 
          callSites: (existing.metadata?.callSites || 0) + (conn.metadata?.callSites || 0),
          dataFlow: conn.metadata?.dataFlow || existing.metadata?.dataFlow,
          httpMethod: conn.metadata?.httpMethod || existing.metadata?.httpMethod
        };
      } else {
        connectionMap.set(key, conn);
      }
    }
    
    return Array.from(connectionMap.values());
  }

  private mergeEntryPoints(base: EntryPoint[], enhanced: EntryPoint[]): EntryPoint[] {
    const entryMap = new Map<string, EntryPoint>();
    
    // Add base entry points
    for (const entry of base) {
      entryMap.set(entry.path, entry);
    }
    
    // Merge enhanced entry points
    for (const entry of enhanced) {
      const existing = entryMap.get(entry.path);
      if (existing) {
        // Merge data
        existing.methods = [...(existing.methods || []), ...(entry.methods || [])];
        existing.middleware = [...(existing.middleware || []), ...(entry.middleware || [])];
      } else {
        entryMap.set(entry.path, entry);
      }
    }
    
    return Array.from(entryMap.values());
  }

  private mergeExitPoints(base: ExitPoint[], enhanced: ExitPoint[]): ExitPoint[] {
    const exitMap = new Map<string, ExitPoint>();
    
    // Add base exit points
    for (const exit of base) {
      exitMap.set(`${exit.destination}-${exit.type}`, exit);
    }
    
    // Merge enhanced exit points
    for (const exit of enhanced) {
      const key = `${exit.destination}-${exit.type}`;
      if (!exitMap.has(key)) {
        exitMap.set(key, exit);
      }
    }
    
    return Array.from(exitMap.values());
  }
}
