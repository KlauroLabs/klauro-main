/**
 * Telemetry Integration Example
 * Shows how to use the enhanced analyzer architecture with telemetry
 */

import { EnhancedBaseAnalyzer, EnhancedAnalyzerOptions } from './enhanced-base-analyzer';
import { SystemTopologyAnalyzer } from './system-topology-analyzer';
import { telemetry, TelemetryConfig } from '../telemetry/telemetry-schema';
import { EntryExitDetector } from './patterns/entry-exit-detector';
import { DependencyMapper } from './patterns/dependency-mapper';
import { FrameworkDetector } from './patterns/framework-detector';
import { ASTOptimizer } from './ast/ast-optimizer';
import * as path from 'path';

/**
 * Enhanced System Topology Analyzer with full telemetry integration
 */
export class TelemetryIntegratedAnalyzer extends EnhancedBaseAnalyzer {
  private systemTopologyAnalyzer: SystemTopologyAnalyzer;

  constructor() {
    super();
    this.systemTopologyAnalyzer = new SystemTopologyAnalyzer();
  }

  getAnalyzerName(): string {
    return 'Telemetry Integrated System Analyzer';
  }

  getSupportedLanguages(): string[] {
    return ['typescript', 'javascript', 'python', 'java', 'csharp', 'go', 'rust', 'php'];
  }

  getSupportedFrameworks(): string[] {
    return ['any']; // Universal analyzer
  }

  // Delegate to system topology analyzer with telemetry enhancement
  protected async detectLanguageAndFramework() {
    return await telemetry.measureAsync('detectLanguageAndFramework', async () => {
      return await this.systemTopologyAnalyzer['detectLanguageAndFramework'].call(this.systemTopologyAnalyzer);
    });
  }

  protected async discoverComponents() {
    return await telemetry.measureAsync('discoverComponents', async () => {
      return await this.systemTopologyAnalyzer['discoverComponents'].call(this.systemTopologyAnalyzer);
    });
  }

  protected async analyzeConnections(components: any[]) {
    return await telemetry.measureAsync('analyzeConnections', async () => {
      return await this.systemTopologyAnalyzer['analyzeConnections'].call(this.systemTopologyAnalyzer, components);
    });
  }

  protected async identifyEntryPoints(components: any[]) {
    return await telemetry.measureAsync('identifyEntryPoints', async () => {
      return await this.systemTopologyAnalyzer['identifyEntryPoints'].call(this.systemTopologyAnalyzer, components);
    });
  }

  protected async identifyExitPoints(components: any[]) {
    return await telemetry.measureAsync('identifyExitPoints', async () => {
      return await this.systemTopologyAnalyzer['identifyExitPoints'].call(this.systemTopologyAnalyzer, components);
    });
  }

  protected async assessRisks(components: any[], connections: any[]) {
    return await telemetry.measureAsync('assessRisks', async () => {
      return await this.systemTopologyAnalyzer['assessRisks'].call(this.systemTopologyAnalyzer, components, connections);
    });
  }

  protected async generateCallGraph(components: any[]) {
    return await telemetry.measureAsync('generateCallGraph', async () => {
      return await this.systemTopologyAnalyzer['generateCallGraph'].call(this.systemTopologyAnalyzer, components);
    });
  }

  protected async analyzeDatabaseConnections(components: any[]) {
    return await telemetry.measureAsync('analyzeDatabaseConnections', async () => {
      return await this.systemTopologyAnalyzer['analyzeDatabaseConnections'].call(this.systemTopologyAnalyzer, components);
    });
  }

  protected async analyzeTestCoverage(components: any[]) {
    return await telemetry.measureAsync('analyzeTestCoverage', async () => {
      return await this.systemTopologyAnalyzer['analyzeTestCoverage'].call(this.systemTopologyAnalyzer, components);
    });
  }
}

/**
 * Factory for creating telemetry-enabled analyzers
 */
export class TelemetryAnalyzerFactory {
  static createAnalyzer(
    type: 'system-topology' | 'enhanced' = 'enhanced',
    telemetryConfig?: TelemetryConfig
  ): EnhancedBaseAnalyzer {
    // Configure telemetry if provided
    if (telemetryConfig) {
      // Configure the global telemetry instance
      // This would be done in the telemetry schema constructor
    }

    switch (type) {
      case 'system-topology':
        return new TelemetryIntegratedAnalyzer();
      case 'enhanced':
      default:
        return new TelemetryIntegratedAnalyzer();
    }
  }

  static async analyzeWithTelemetry(
    repositoryPath: string,
    options: EnhancedAnalyzerOptions = {}
  ) {
    const analyzer = this.createAnalyzer('enhanced');

    // Enable all telemetry features by default
    const enhancedOptions: EnhancedAnalyzerOptions = {
      enableTelemetry: true,
      enableOptimization: true,
      enablePatternDetection: true,
      telemetryConfig: {
        flushInterval: 1000,
        maxBufferSize: 100,
        enableRealTime: true
      },
      optimizationConfig: {
        caching: true,
        pruning: true,
        parallel: true,
        maxDepth: 10
      },
      ...options
    };

    // Start analysis
    const blueprint = await analyzer.analyzeRepository(repositoryPath, enhancedOptions);

    // Generate telemetry manifest
    const telemetryManifest = analyzer.generateTelemetryManifest();

    // Get optimization statistics
    const optimizationStats = analyzer.getOptimizationStatistics();

    return {
      blueprint,
      telemetryManifest,
      optimizationStats,
      metrics: telemetry.getMetrics()
    };
  }
}

/**
 * Pattern-based analysis utilities
 */
export class PatternAnalysisUtils {
  static async analyzeEntryExitPatterns(
    repositoryPath: string,
    components: any[]
  ) {
    const detector = new EntryExitDetector();
    
    const entryPoints = await detector.detectEntryPoints(components, repositoryPath);
    const exitPoints = await detector.detectExitPoints(components, repositoryPath);
    const statistics = detector.getStatistics();

    return {
      entryPoints,
      exitPoints,
      statistics
    };
  }

  static async analyzeDependencyPatterns(
    repositoryPath: string,
    components: any[]
  ) {
    const mapper = new DependencyMapper();
    
    const dependencyGraph = await mapper.mapDependencies(components, repositoryPath);
    const callGraph = mapper.generateCallGraph(components);

    return {
      dependencyGraph,
      callGraph,
      cycles: dependencyGraph.cycles,
      criticalPaths: dependencyGraph.criticalPaths,
      clusters: dependencyGraph.clusters
    };
  }

  static async analyzeFrameworkPatterns(repositoryPath: string) {
    const detector = new FrameworkDetector();
    
    const technologyStack = await detector.detectFrameworks(repositoryPath);

    return {
      technologyStack,
      primaryFramework: technologyStack.primaryFramework,
      additionalFrameworks: technologyStack.additionalFrameworks,
      languages: technologyStack.languages,
      buildTools: technologyStack.buildTools
    };
  }
}

/**
 * Performance optimization utilities
 */
export class OptimizationUtils {
  static async optimizeASTAnalysis(
    files: string[],
    options: {
      parallel?: boolean;
      caching?: boolean;
      pruning?: boolean;
      maxDepth?: number;
    } = {}
  ) {
    const optimizer = new ASTOptimizer();
    
    const results = await optimizer.batchParseFiles(files, {
      parallel: options.parallel !== false,
      caching: options.caching !== false,
      pruning: options.pruning !== false,
      maxDepth: options.maxDepth || 10
    });

    const statistics = optimizer.getOptimizationStatistics();

    return {
      results,
      statistics,
      filesProcessed: results.size,
      optimizationsApplied: Array.from(results.values())
        .flatMap(r => r.optimizations)
    };
  }

  static createOptimizedTraversalOptions(
    fileCount: number,
    complexityLevel: 'low' | 'medium' | 'high' = 'medium'
  ) {
    const baseOptions = {
      caching: true,
      pruning: fileCount > 100,
      parallel: fileCount > 50,
      timeout: 30000
    };

    switch (complexityLevel) {
      case 'low':
        return {
          ...baseOptions,
          maxDepth: 5,
          parallel: false
        };
      
      case 'high':
        return {
          ...baseOptions,
          maxDepth: 20,
          parallel: true,
          incremental: true
        };
      
      case 'medium':
      default:
        return {
          ...baseOptions,
          maxDepth: 10
        };
    }
  }
}

/**
 * Example usage and demonstration
 */
export async function demonstrateTelemetryIntegration(repositoryPath: string) {
  console.log('🚀 Starting Telemetry Integration Demonstration');
  console.log(`📁 Analyzing repository: ${repositoryPath}`);

  try {
    // 1. Analyze with full telemetry
    console.log('\n1️⃣ Running full analysis with telemetry...');
    const analysisResult = await TelemetryAnalyzerFactory.analyzeWithTelemetry(repositoryPath);
    
    console.log(`✅ Analysis complete:`);
    console.log(`   - Components found: ${analysisResult.blueprint.components.length}`);
    console.log(`   - Connections found: ${analysisResult.blueprint.connections.length}`);
    console.log(`   - Entry points: ${analysisResult.blueprint.entryPoints.length}`);
    console.log(`   - Exit points: ${analysisResult.blueprint.exitPoints.length}`);
    console.log(`   - Risk areas: ${analysisResult.blueprint.riskAreas.length}`);

    // 2. Pattern analysis
    console.log('\n2️⃣ Running pattern analysis...');
    const patternResults = await PatternAnalysisUtils.analyzeEntryExitPatterns(
      repositoryPath, 
      analysisResult.blueprint.components
    );
    
    console.log(`✅ Pattern analysis complete:`);
    console.log(`   - Entry patterns: ${patternResults.statistics.totalEntry}`);
    console.log(`   - Exit patterns: ${patternResults.statistics.totalExit}`);

    // 3. Dependency analysis
    console.log('\n3️⃣ Running dependency analysis...');
    const dependencyResults = await PatternAnalysisUtils.analyzeDependencyPatterns(
      repositoryPath,
      analysisResult.blueprint.components
    );
    
    console.log(`✅ Dependency analysis complete:`);
    console.log(`   - Nodes in dependency graph: ${dependencyResults.dependencyGraph.nodes.size}`);
    console.log(`   - Circular dependencies: ${dependencyResults.cycles.length}`);
    console.log(`   - Critical paths: ${dependencyResults.criticalPaths.length}`);
    console.log(`   - Clusters found: ${dependencyResults.clusters.length}`);

    // 4. Framework detection
    console.log('\n4️⃣ Running framework detection...');
    const frameworkResults = await PatternAnalysisUtils.analyzeFrameworkPatterns(repositoryPath);
    
    console.log(`✅ Framework detection complete:`);
    console.log(`   - Primary framework: ${frameworkResults.primaryFramework?.name || 'None'}`);
    console.log(`   - Additional frameworks: ${frameworkResults.additionalFrameworks.length}`);
    console.log(`   - Languages detected: ${frameworkResults.languages.length}`);

    // 5. Telemetry metrics
    console.log('\n5️⃣ Telemetry metrics:');
    console.log(`   - Events collected: ${analysisResult.metrics.eventsCollected}`);
    console.log(`   - Cache hit rate: ${analysisResult.optimizationStats.cacheHitRate * 100}%`);
    console.log(`   - Average parsing time: ${analysisResult.optimizationStats.averageParsingTime.toFixed(2)}ms`);

    // 6. Generate manifest
    console.log('\n6️⃣ Generating telemetry manifest...');
    const manifest = analysisResult.telemetryManifest;
    console.log(`✅ Manifest generated with ${manifest.instrumentationPoints.length} instrumentation points`);

    return {
      success: true,
      analysisResult,
      patternResults,
      dependencyResults,
      frameworkResults,
      manifest
    };

  } catch (error) {
    console.error('❌ Analysis failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
