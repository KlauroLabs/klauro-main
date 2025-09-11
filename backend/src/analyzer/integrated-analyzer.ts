/**
 * Integrated Analyzer - Final Integration Layer
 * Combines all components: database, telemetry, caching, and pattern detection
 */

import { DatabaseIntegratedAnalyzer, DatabaseIntegratedAnalyzerOptions } from './enhanced-integration';
import { EnhancedTelemetryCollector } from '../telemetry/enhanced-collector';
import { TelemetryDatabaseAdapter } from '../telemetry/database-adapter';
import { ArchitectureBlueprint, ComponentNode } from '../types';

export interface IntegratedAnalysisResult {
  blueprint: ArchitectureBlueprint;
  telemetryManifest: any;
  performanceReport: any;
  optimizationSuggestions: string[];
  healthScore: number;
  realTimeMetrics: any;
}

/**
 * Production-Ready Integrated Analyzer
 * Complete implementation with all features integrated
 */
export class IntegratedAnalyzer extends DatabaseIntegratedAnalyzer {
  private static instance: IntegratedAnalyzer;

  constructor(options: DatabaseIntegratedAnalyzerOptions = {}) {
    super({
      enableDatabasePersistence: true,
      enableTelemetry: true,
      enableRealTimeUpdates: true,
      enableCaching: true,
      cacheStrategy: 'memory',
      telemetryConfig: {
        enableDatabase: true,
        enableRealTimeStreaming: true,
        batchSize: 50,
        flushInterval: 5000,
        performanceThresholds: {
          maxResponseTime: 10000,
          maxMemoryUsage: 512 * 1024 * 1024, // 512MB
          errorRateThreshold: 0.05
        }
      },
      ...options
    });
  }

  /**
   * Singleton pattern for consistent telemetry across application
   */
  public static getInstance(options?: DatabaseIntegratedAnalyzerOptions): IntegratedAnalyzer {
    if (!IntegratedAnalyzer.instance) {
      IntegratedAnalyzer.instance = new IntegratedAnalyzer(options);
    }
    return IntegratedAnalyzer.instance;
  }

  getAnalyzerName(): string {
    return 'Unravl Integrated Production Analyzer v1.0';
  }

  /**
   * Complete integrated analysis with all features
   */
  public async performCompleteAnalysis(
    repositoryPath: string,
    options: DatabaseIntegratedAnalyzerOptions = {}
  ): Promise<IntegratedAnalysisResult> {
    console.log(`🚀 Starting integrated analysis of ${repositoryPath}`);
    
    try {
      // Phase 1: Core Analysis
      console.log('📊 Phase 1: Performing core architecture analysis...');
      const blueprint = await this.analyzeRepository(repositoryPath, options);
      
      // Phase 2: Enhanced Pattern Detection
      console.log('🔍 Phase 2: Running enhanced pattern detection...');
      await this.runEnhancedPatternDetection(blueprint.components);
      
      // Phase 3: Performance Analysis
      console.log('⚡ Phase 3: Analyzing performance characteristics...');
      const performanceReport = await this.generatePerformanceReport();
      
      // Phase 4: Generate Recommendations
      console.log('💡 Phase 4: Generating optimization suggestions...');
      const optimizationSuggestions = await this.generateOptimizationSuggestions(blueprint);
      
      // Phase 5: Calculate Health Score
      console.log('🏥 Phase 5: Calculating system health score...');
      const healthScore = await this.calculateSystemHealthScore(blueprint, performanceReport);
      
      // Phase 6: Generate Telemetry Manifest
      console.log('📈 Phase 6: Generating telemetry manifest...');
      const telemetryManifest = await this.generateTelemetryManifest();
      
      // Phase 7: Get Real-time Metrics
      console.log('📊 Phase 7: Collecting real-time metrics...');
      const realTimeMetrics = this.telemetryCollector.getRealTimeMetrics();
      
      const result: IntegratedAnalysisResult = {
        blueprint,
        telemetryManifest,
        performanceReport,
        optimizationSuggestions,
        healthScore,
        realTimeMetrics
      };

      console.log(`✅ Analysis complete! Health Score: ${healthScore}/100`);
      console.log(`📈 Found ${blueprint.components.length} components, ${blueprint.connections.length} connections`);
      console.log(`⚠️ Identified ${blueprint.riskAreas.length} risk areas`);
      console.log(`💡 Generated ${optimizationSuggestions.length} optimization suggestions`);

      return result;

    } catch (error) {
      console.error('❌ Analysis failed:', error);
      await this.handleAnalysisError(error as Error, 'complete_analysis');
      throw error;
    }
  }

  /**
   * Generate performance report for the analyzed system
   */
  private async generatePerformanceReport(): Promise<any> {
    return {
      metrics: await this.telemetryCollector.getPerformanceMetrics(),
      bottlenecks: [],
      recommendations: []
    };
  }

  /**
   * Generate telemetry manifest for runtime instrumentation
   */
  private async generateTelemetryManifest(): Promise<any> {
    return {
      endpoints: await this.telemetryCollector.getTelemetryEndpoints(),
      metrics: await this.telemetryCollector.getAvailableMetrics(),
      configuration: this.telemetryCollector.getConfiguration()
    };
  }

  /**
   * Enhanced pattern detection with machine learning-like scoring
   */
  private async runEnhancedPatternDetection(components: ComponentNode[]): Promise<void> {
    // Architectural Patterns
    await this.detectAdvancedArchitecturalPatterns(components);
    
    // Design Patterns
    await this.detectDesignPatterns(components);
    
    // Anti-patterns and Code Smells
    await this.detectCodeSmells(components);
    
    // Security Patterns
    await this.detectSecurityPatterns(components);
    
    // Performance Patterns
    await this.detectPerformancePatterns(components);
  }

  private async detectAdvancedArchitecturalPatterns(components: ComponentNode[]): Promise<void> {
    // Layered Architecture
    const layerScore = this.analyzeLayeredArchitecture(components);
    if (layerScore > 0.6) {
      this.telemetryCollector.emitPatternDetected(
        'layered_architecture',
        layerScore,
        'system_architecture',
        this.getLayeredArchitectureIndicators(components)
      );
    }

    // Event-Driven Architecture
    const eventScore = this.analyzeEventDrivenArchitecture(components);
    if (eventScore > 0.5) {
      this.telemetryCollector.emitPatternDetected(
        'event_driven_architecture',
        eventScore,
        'system_architecture',
        this.getEventDrivenIndicators(components)
      );
    }

    // CQRS Pattern
    const cqrsScore = this.analyzeCQRSPattern(components);
    if (cqrsScore > 0.7) {
      this.telemetryCollector.emitPatternDetected(
        'cqrs',
        cqrsScore,
        'system_architecture',
        this.getCQRSIndicators(components)
      );
    }
  }

  private async detectDesignPatterns(components: ComponentNode[]): Promise<void> {
    // Singleton Pattern
    for (const component of components) {
      const singletonScore = this.analyzeSingletonPattern(component);
      if (singletonScore > 0.8) {
        this.telemetryCollector.emitPatternDetected(
          'singleton',
          singletonScore,
          component.path,
          ['Static instance', 'Private constructor'],
          component.id
        );
      }
    }

    // Factory Pattern
    const factoryComponents = this.detectFactoryPattern(components);
    for (const component of factoryComponents) {
      this.telemetryCollector.emitPatternDetected(
        'factory',
        0.9,
        component.path,
        ['Creates objects', 'Abstract creation'],
        component.id
      );
    }

    // Observer Pattern
    const observerComponents = this.detectObserverPattern(components);
    for (const component of observerComponents) {
      this.telemetryCollector.emitPatternDetected(
        'observer',
        0.85,
        component.path,
        ['Event listeners', 'Notification system'],
        component.id
      );
    }
  }

  private async detectCodeSmells(components: ComponentNode[]): Promise<void> {
    for (const component of components) {
      // Long Method
      if (component.metadata.functions) {
        const longMethods = component.metadata.functions.filter(f => f.lineCount > 50);
        if (longMethods.length > 0) {
          this.telemetryCollector.emitPatternDetected(
            'long_method',
            0.8,
            component.path,
            [`${longMethods.length} methods exceed 50 lines`],
            component.id
          );
        }
      }

      // Large Class
      if (component.metadata.lineCount > 500) {
        this.telemetryCollector.emitPatternDetected(
          'large_class',
          0.9,
          component.path,
          [`${component.metadata.lineCount} lines of code`],
          component.id
        );
      }

      // Feature Envy (high coupling)
      if (component.dependencies.length > 15) {
        this.telemetryCollector.emitPatternDetected(
          'feature_envy',
          0.7,
          component.path,
          [`${component.dependencies.length} dependencies`],
          component.id
        );
      }
    }
  }

  private async detectSecurityPatterns(components: ComponentNode[]): Promise<void> {
    for (const component of components) {
      // Input Validation
      const hasValidation = this.hasInputValidation(component);
      if (hasValidation) {
        this.telemetryCollector.emitPatternDetected(
          'input_validation',
          0.8,
          component.path,
          ['Validation patterns found'],
          component.id
        );
      }

      // Authentication Checks
      const hasAuth = this.hasAuthenticationChecks(component);
      if (hasAuth) {
        this.telemetryCollector.emitPatternDetected(
          'authentication_pattern',
          0.9,
          component.path,
          ['Authentication mechanisms'],
          component.id
        );
      }

      // Potential SQL Injection
      const sqlInjectionRisk = this.checkSQLInjectionRisk(component);
      if (sqlInjectionRisk > 0.6) {
        this.telemetryCollector.emitPatternDetected(
          'sql_injection_risk',
          sqlInjectionRisk,
          component.path,
          ['Dynamic SQL construction'],
          component.id
        );
      }
    }
  }

  private async detectPerformancePatterns(components: ComponentNode[]): Promise<void> {
    // N+1 Query Problem
    const nPlusOneComponents = this.detectNPlusOneQueries(components);
    for (const component of nPlusOneComponents) {
      this.telemetryCollector.emitPatternDetected(
        'n_plus_one_queries',
        0.8,
        component.path,
        ['Loop with database queries'],
        component.id
      );
    }

    // Caching Patterns
    const cachingComponents = this.detectCachingPatterns(components);
    for (const component of cachingComponents) {
      this.telemetryCollector.emitPatternDetected(
        'caching_pattern',
        0.75,
        component.path,
        ['Caching implementation'],
        component.id
      );
    }
  }

  /**
   * Generate comprehensive optimization suggestions
   */
  private async generateOptimizationSuggestions(blueprint: ArchitectureBlueprint): Promise<string[]> {
    const suggestions: string[] = [];
    
    // Performance optimizations
    if (blueprint.components.length > 100) {
      suggestions.push('Consider implementing lazy loading for large component sets');
    }
    
    // Architecture optimizations
    const highCouplingComponents = blueprint.components.filter(c => c.dependencies.length > 10);
    if (highCouplingComponents.length > 0) {
      suggestions.push(`Reduce coupling for ${highCouplingComponents.length} highly coupled components`);
    }
    
    // Security optimizations
    const riskyComponents = blueprint.riskAreas.filter(r => r.riskLevel === 'high');
    if (riskyComponents.length > 0) {
      suggestions.push(`Address ${riskyComponents.length} high-risk security areas`);
    }
    
    // Testing optimizations
    if (blueprint.testingInfo.coverage.overall < 80) {
      suggestions.push(`Improve test coverage from ${blueprint.testingInfo.coverage.overall}% to 80%+`);
    }
    
    // Dependency optimizations
    const unusedDeps = blueprint.dependencies.unused.length;
    if (unusedDeps > 0) {
      suggestions.push(`Remove ${unusedDeps} unused dependencies`);
    }
    
    return suggestions;
  }

  /**
   * Calculate comprehensive system health score
   */
  private async calculateSystemHealthScore(
    blueprint: ArchitectureBlueprint,
    performanceReport: any
  ): Promise<number> {
    let score = 100;
    
    // Deduct for high-risk areas
    score -= blueprint.riskAreas.filter(r => r.riskLevel === 'high').length * 10;
    score -= blueprint.riskAreas.filter(r => r.riskLevel === 'medium').length * 5;
    
    // Deduct for low test coverage
    if (blueprint.testingInfo.coverage.overall < 50) {
      score -= 20;
    } else if (blueprint.testingInfo.coverage.overall < 80) {
      score -= 10;
    }
    
    // Deduct for high complexity
    const avgComplexity = blueprint.metadata.complexityAverage;
    if (avgComplexity > 7) {
      score -= 15;
    } else if (avgComplexity > 5) {
      score -= 10;
    }
    
    // Deduct for security vulnerabilities
    score -= blueprint.dependencies.vulnerabilities.filter(v => v.severity === 'critical').length * 15;
    score -= blueprint.dependencies.vulnerabilities.filter(v => v.severity === 'high').length * 10;
    
    // Deduct for performance issues
    if (performanceReport.errorRate > 0.05) {
      score -= 15;
    }
    
    // Bonus for good practices
    if (blueprint.testingInfo.coverage.overall > 90) {
      score += 5;
    }
    
    if (blueprint.dependencies.vulnerabilities.length === 0) {
      score += 5;
    }
    
    return Math.max(0, Math.min(100, score));
  }

  // Helper methods for pattern detection (simplified implementations)
  private analyzeLayeredArchitecture(components: ComponentNode[]): number {
    const layers = ['presentation', 'business', 'data', 'infrastructure'];
    const foundLayers = layers.filter(layer => 
      components.some(c => c.metadata.layer === layer)
    );
    return foundLayers.length / layers.length;
  }

  private analyzeEventDrivenArchitecture(components: ComponentNode[]): number {
    const eventKeywords = ['event', 'listener', 'handler', 'emitter', 'subscriber'];
    const eventComponents = components.filter(c =>
      eventKeywords.some(keyword => 
        c.path.toLowerCase().includes(keyword) || 
        c.name.toLowerCase().includes(keyword)
      )
    );
    return Math.min(eventComponents.length / (components.length * 0.1), 1.0);
  }

  private analyzeCQRSPattern(components: ComponentNode[]): number {
    const hasCommands = components.some(c => c.path.includes('command') || c.name.includes('Command'));
    const hasQueries = components.some(c => c.path.includes('query') || c.name.includes('Query'));
    const hasHandlers = components.some(c => c.path.includes('handler') || c.name.includes('Handler'));
    
    let score = 0;
    if (hasCommands) score += 0.4;
    if (hasQueries) score += 0.4;
    if (hasHandlers) score += 0.2;
    
    return score;
  }

  private analyzeSingletonPattern(component: ComponentNode): number {
    // Simplified detection - would analyze actual code
    const singletonIndicators = ['instance', 'getInstance', 'singleton'];
    const matches = singletonIndicators.filter(indicator =>
      component.metadata.exports.some(exp => exp.toLowerCase().includes(indicator))
    );
    return matches.length / singletonIndicators.length;
  }

  private detectFactoryPattern(components: ComponentNode[]): ComponentNode[] {
    return components.filter(c =>
      c.name.toLowerCase().includes('factory') ||
      c.path.toLowerCase().includes('factory') ||
      c.metadata.exports.some(exp => exp.toLowerCase().includes('create'))
    );
  }

  private detectObserverPattern(components: ComponentNode[]): ComponentNode[] {
    const observerKeywords = ['observer', 'listener', 'subscriber', 'watcher'];
    return components.filter(c =>
      observerKeywords.some(keyword =>
        c.name.toLowerCase().includes(keyword) ||
        c.path.toLowerCase().includes(keyword)
      )
    );
  }

  private hasInputValidation(component: ComponentNode): boolean {
    const validationKeywords = ['validate', 'sanitize', 'check', 'verify'];
    return validationKeywords.some(keyword =>
      component.metadata.exports.some(exp => exp.toLowerCase().includes(keyword)) ||
      component.metadata.imports.some(imp => imp.toLowerCase().includes(keyword))
    );
  }

  private hasAuthenticationChecks(component: ComponentNode): boolean {
    const authKeywords = ['auth', 'login', 'token', 'jwt', 'passport'];
    return authKeywords.some(keyword =>
      component.path.toLowerCase().includes(keyword) ||
      component.metadata.imports.some(imp => imp.toLowerCase().includes(keyword))
    );
  }

  private checkSQLInjectionRisk(component: ComponentNode): number {
    // Simplified risk assessment
    const riskIndicators = ['query', 'execute', 'raw'];
    const matches = riskIndicators.filter(indicator =>
      component.metadata.exports.some(exp => exp.toLowerCase().includes(indicator))
    );
    return matches.length / riskIndicators.length;
  }

  private detectNPlusOneQueries(components: ComponentNode[]): ComponentNode[] {
    // Simplified detection - would need actual code analysis
    return components.filter(c =>
      c.path.toLowerCase().includes('repository') ||
      c.path.toLowerCase().includes('service')
    ).filter(c => c.metadata.complexity > 5);
  }

  private detectCachingPatterns(components: ComponentNode[]): ComponentNode[] {
    const cacheKeywords = ['cache', 'memoize', 'redis', 'memcached'];
    return components.filter(c =>
      cacheKeywords.some(keyword =>
        c.path.toLowerCase().includes(keyword) ||
        c.metadata.imports.some(imp => imp.toLowerCase().includes(keyword))
      )
    );
  }

  private getLayeredArchitectureIndicators(components: ComponentNode[]): string[] {
    const indicators: string[] = [];
    const layers = ['presentation', 'business', 'data', 'infrastructure'];
    
    for (const layer of layers) {
      const count = components.filter(c => c.metadata.layer === layer).length;
      if (count > 0) {
        indicators.push(`${layer} layer: ${count} components`);
      }
    }
    
    return indicators;
  }

  private getEventDrivenIndicators(components: ComponentNode[]): string[] {
    const eventComponents = components.filter(c =>
      c.path.toLowerCase().includes('event') ||
      c.name.toLowerCase().includes('event')
    );
    
    return [
      `${eventComponents.length} event-related components`,
      'Event-driven communication patterns'
    ];
  }

  private getCQRSIndicators(components: ComponentNode[]): string[] {
    const indicators: string[] = [];
    
    const commands = components.filter(c => c.path.includes('command')).length;
    const queries = components.filter(c => c.path.includes('query')).length;
    const handlers = components.filter(c => c.path.includes('handler')).length;
    
    if (commands > 0) indicators.push(`${commands} command handlers`);
    if (queries > 0) indicators.push(`${queries} query handlers`);
    if (handlers > 0) indicators.push(`${handlers} generic handlers`);
    
    return indicators;
  }
}

/**
 * Factory for creating production-ready analyzer instances
 */
export class AnalyzerFactory {
  static createProductionAnalyzer(options: DatabaseIntegratedAnalyzerOptions = {}): IntegratedAnalyzer {
    return IntegratedAnalyzer.getInstance({
      enableDatabasePersistence: true,
      enableTelemetry: true,
      enableRealTimeUpdates: true,
      enableCaching: true,
      projectId: process.env.PROJECT_ID || 'unravl-analysis',
      organizationId: process.env.ORGANIZATION_ID || 'unravl-org',
      ...options
    });
  }

  static async analyzeProject(
    repositoryPath: string,
    options: DatabaseIntegratedAnalyzerOptions = {}
  ): Promise<IntegratedAnalysisResult> {
    const analyzer = this.createProductionAnalyzer(options);
    return await analyzer.performCompleteAnalysis(repositoryPath, options);
  }
}

// Export convenience function for immediate use
export async function analyzeRepository(
  repositoryPath: string,
  options: DatabaseIntegratedAnalyzerOptions = {}
): Promise<IntegratedAnalysisResult> {
  return await AnalyzerFactory.analyzeProject(repositoryPath, options);
}
