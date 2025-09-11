/**
 * Enhanced Telemetry Collector with Database Integration
 * Extends the original collector with database persistence and analyzer integration
 */

import { TelemetryCollector, TelemetryEvent, TelemetryConfig } from './telemetry-schema';
import { TelemetryDatabaseAdapter, TelemetryRepository, DatabaseTelemetryEvent } from './database-adapter';

export interface EnhancedTelemetryConfig extends TelemetryConfig {
  enableDatabase?: boolean;
  databaseRepository?: TelemetryRepository;
  batchSize?: number;
  flushOnError?: boolean;
  enableRealTimeStreaming?: boolean;
  performanceThresholds?: PerformanceThresholds;
  enableAggregation?: boolean;
  aggregationInterval?: number;
}

export interface PerformanceThresholds {
  maxResponseTime?: number;
  maxMemoryUsage?: number;
  maxCpuUsage?: number;
  errorRateThreshold?: number;
}

/**
 * Enhanced Telemetry Collector with Database and Analyzer Integration
 */
export class EnhancedTelemetryCollector extends TelemetryCollector {
  private config: EnhancedTelemetryConfig;
  private repository?: TelemetryRepository;
  private batchBuffer: TelemetryEvent[] = [];
  private lastFlushTime: number = Date.now();
  private performanceThresholds: PerformanceThresholds;
  private aggregationTimer?: NodeJS.Timer;

  constructor(config: EnhancedTelemetryConfig = {}) {
    super(config);
    this.config = {
      enableDatabase: true,
      batchSize: 100,
      flushOnError: true,
      enableRealTimeStreaming: true,
      enableAggregation: true,
      aggregationInterval: 60000, // 1 minute
      ...config
    };
    
    this.repository = config.databaseRepository;
    this.performanceThresholds = config.performanceThresholds || {};
    
    if (this.config.enableAggregation) {
      this.startAggregationTimer();
    }
  }

  /**
   * Enhanced emit with database persistence and real-time features
   */
  public emit(event: Partial<TelemetryEvent>): void {
    // Call parent emit for in-memory processing
    super.emit(event);

    const fullEvent = this.getLastEvent();
    if (!fullEvent) return;

    // Add to batch buffer for database persistence
    if (this.config.enableDatabase && this.repository) {
      this.batchBuffer.push(fullEvent);
      
      // Flush immediately on errors or when batch is full
      if (this.shouldFlushImmediately(fullEvent)) {
        this.flushToDatabaseImmediate();
      }
    }

    // Check performance thresholds and emit alerts
    this.checkPerformanceThresholds(fullEvent);

    // Real-time streaming
    if (this.config.enableRealTimeStreaming) {
      this.streamEventRealTime(fullEvent);
    }
  }

  /**
   * Emit analyzer-specific events with enhanced context
   */
  public emitAnalyzerEvent(
    eventType: string,
    data: any,
    componentId?: string,
    performance?: {
      startTime: number;
      endTime?: number;
      memoryUsage?: NodeJS.MemoryUsage;
    }
  ): void {
    const event: Partial<TelemetryEvent> = {
      type: eventType as any,
      source: {
        analyzer: 'system-topology-analyzer',
        component: componentId
      },
      data,
      metadata: {
        projectId: process.env.PROJECT_ID || 'unknown',
        environment: (process.env.NODE_ENV as any) || 'development',
        version: process.env.ANALYZER_VERSION || '1.0.0',
        platform: process.platform
      }
    };

    if (performance) {
      event.performance = {
        startTime: performance.startTime,
        endTime: performance.endTime || Date.now(),
        duration: (performance.endTime || Date.now()) - performance.startTime,
        memoryUsed: performance.memoryUsage?.heapUsed,
        memoryDelta: performance.memoryUsage?.heapUsed
      };
    }

    this.emit(event);
  }

  /**
   * Track analyzer operation with automatic timing
   */
  public async trackAnalyzerOperation<T>(
    operationName: string,
    componentId: string | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();
    const startMemory = process.memoryUsage();

    this.emitAnalyzerEvent('operation_started', {
      operation: operationName,
      componentId
    }, componentId, { startTime, memoryUsage: startMemory });

    try {
      const result = await operation();
      const endTime = Date.now();
      const endMemory = process.memoryUsage();

      this.emitAnalyzerEvent('operation_completed', {
        operation: operationName,
        componentId,
        success: true,
        duration: endTime - startTime,
        memoryDelta: endMemory.heapUsed - startMemory.heapUsed
      }, componentId, { startTime, endTime, memoryUsage: endMemory });

      return result;
    } catch (error) {
      const endTime = Date.now();
      const endMemory = process.memoryUsage();

      this.emitAnalyzerEvent('operation_failed', {
        operation: operationName,
        componentId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        duration: endTime - startTime
      }, componentId, { startTime, endTime, memoryUsage: endMemory });

      throw error;
    }
  }

  /**
   * Track pattern detection with confidence scoring
   */
  public emitPatternDetected(
    pattern: string,
    confidence: number,
    location: string,
    indicators: string[],
    componentId?: string
  ): void {
    this.emitAnalyzerEvent('pattern_detected', {
      pattern,
      confidence,
      location,
      indicators,
      implications: this.generatePatternImplications(pattern),
      category: this.categorizePattern(pattern)
    }, componentId);
  }

  /**
   * Track component discovery with detailed metrics
   */
  public emitComponentDiscovered(
    component: any,
    parseMetrics: {
      fileSize: number;
      parseTime: number;
      functionCount: number;
      classCount: number;
      importCount: number;
      exportCount: number;
    }
  ): void {
    this.emitAnalyzerEvent('component_discovered', {
      component: {
        id: component.id,
        name: component.name,
        type: component.type,
        path: component.path,
        complexity: component.metadata.complexity
      },
      ...parseMetrics
    }, component.id);
  }

  /**
   * Track dependency detection with relationship data
   */
  public emitDependencyDetected(
    from: string,
    to: string,
    type: string,
    weight: number,
    metadata: {
      circular?: boolean;
      depth?: number;
      importPath?: string;
    } = {}
  ): void {
    this.emitAnalyzerEvent('dependency_detected', {
      from,
      to,
      type,
      weight,
      ...metadata
    });
  }

  /**
   * Enhanced flush with database persistence
   */
  public async flushToDatabaseImmediate(): Promise<void> {
    if (!this.repository || this.batchBuffer.length === 0) {
      return;
    }

    try {
      await this.repository.insertEvents([...this.batchBuffer]);
      this.batchBuffer = [];
      this.lastFlushTime = Date.now();
    } catch (error) {
      console.error('Failed to flush telemetry to database:', error);
      
      // Optionally keep events in buffer for retry
      if (this.batchBuffer.length > this.config.batchSize! * 2) {
        // Drop old events to prevent memory issues
        this.batchBuffer = this.batchBuffer.slice(-this.config.batchSize!);
      }
    }
  }

  /**
   * Get performance summary for current analysis session
   */
  public getAnalysisPerformanceSummary(): AnalysisPerformanceSummary {
    const events = this.getEvents();
    const analysisEvents = events.filter(e => 
      e.type.includes('analysis') || 
      e.type.includes('component') || 
      e.type.includes('dependency')
    );

    const performanceEvents = events.filter(e => e.type === 'performance_metric');
    
    const totalDuration = analysisEvents.reduce((sum, event) => 
      sum + (event.performance?.duration || 0), 0
    );

    const averageMemoryUsage = performanceEvents.length > 0 
      ? performanceEvents.reduce((sum, event) => 
          sum + (event.performance?.memoryUsed || 0), 0
        ) / performanceEvents.length
      : 0;

    const errorCount = events.filter(e => e.type === 'error_occurred').length;

    return {
      totalEvents: analysisEvents.length,
      totalDuration,
      averageMemoryUsage,
      errorCount,
      errorRate: analysisEvents.length > 0 ? errorCount / analysisEvents.length : 0,
      cacheHitRate: this.calculateCacheHitRate(events),
      optimizationsApplied: events.filter(e => e.type === 'optimization_applied').length,
      patternsDetected: events.filter(e => e.type === 'pattern_detected').length,
      componentsAnalyzed: events.filter(e => e.type === 'component_discovered').length
    };
  }

  /**
   * Get real-time metrics for dashboard
   */
  public getRealTimeMetrics(): RealTimeMetrics {
    const recentEvents = this.getRecentEvents(60000); // Last minute
    const currentMemory = process.memoryUsage();
    
    return {
      eventsPerMinute: recentEvents.length,
      currentMemoryUsage: currentMemory.heapUsed,
      currentCpuUsage: process.cpuUsage(),
      activeOperations: recentEvents.filter(e => 
        e.type.includes('started') && 
        !recentEvents.some(e2 => 
          e2.type.includes('completed') && 
          e2.correlationId === e.correlationId
        )
      ).length,
      errorRate: this.calculateRecentErrorRate(recentEvents),
      averageResponseTime: this.calculateAverageResponseTime(recentEvents),
      throughput: this.calculateThroughput(recentEvents)
    };
  }

  /**
   * Private helper methods
   */
  private shouldFlushImmediately(event: TelemetryEvent): boolean {
    return (
      event.type === 'error_occurred' ||
      this.batchBuffer.length >= this.config.batchSize! ||
      (Date.now() - this.lastFlushTime) > this.config.flushInterval!
    );
  }

  private checkPerformanceThresholds(event: TelemetryEvent): void {
    if (!this.performanceThresholds) return;

    const thresholds = this.performanceThresholds;
    
    if (thresholds.maxResponseTime && 
        event.performance?.duration && 
        event.performance.duration > thresholds.maxResponseTime) {
      this.emit({
        type: 'performance_threshold_exceeded',
        data: {
          threshold: 'response_time',
          value: event.performance.duration,
          limit: thresholds.maxResponseTime,
          originalEvent: event.id
        }
      } as any);
    }

    if (thresholds.maxMemoryUsage && 
        event.performance?.memoryUsed && 
        event.performance.memoryUsed > thresholds.maxMemoryUsage) {
      this.emit({
        type: 'performance_threshold_exceeded',
        data: {
          threshold: 'memory_usage',
          value: event.performance.memoryUsed,
          limit: thresholds.maxMemoryUsage,
          originalEvent: event.id
        }
      } as any);
    }
  }

  private streamEventRealTime(event: TelemetryEvent): void {
    // Implementation would stream to WebSocket/SSE
    // For now, we could emit to event emitter or log
    if (process.env.NODE_ENV === 'development') {
      console.log(`[TELEMETRY] ${event.type}:`, {
        component: event.source.component,
        duration: event.performance?.duration,
        data: event.data
      });
    }
  }

  private generatePatternImplications(pattern: string): string[] {
    const implications: Record<string, string[]> = {
      'mvc': ['Three-layer architecture', 'Separation of concerns', 'Web application'],
      'microservices': ['Distributed system', 'Service-oriented', 'Scalable architecture'],
      'dependency_injection': ['Inversion of control', 'Testable code', 'Loose coupling'],
      'singleton': ['Global state', 'Potential testing issues', 'Resource management'],
      'observer': ['Event-driven design', 'Loose coupling', 'Reactive system']
    };
    
    return implications[pattern] || ['Unknown pattern implications'];
  }

  private categorizePattern(pattern: string): string {
    const categories: Record<string, string> = {
      'mvc': 'architectural',
      'mvvm': 'architectural', 
      'microservices': 'architectural',
      'singleton': 'design',
      'factory': 'design',
      'observer': 'design',
      'sql_injection': 'security',
      'xss': 'security',
      'n_plus_one': 'performance',
      'memory_leak': 'performance'
    };
    
    return categories[pattern] || 'architectural';
  }

  private calculateCacheHitRate(events: TelemetryEvent[]): number {
    const cacheEvents = events.filter(e => e.type === 'cache_hit' || e.type === 'cache_miss');
    const hits = events.filter(e => e.type === 'cache_hit').length;
    
    return cacheEvents.length > 0 ? hits / cacheEvents.length : 0;
  }

  private getRecentEvents(timeWindowMs: number): TelemetryEvent[] {
    const cutoff = Date.now() - timeWindowMs;
    return this.getEvents().filter(e => e.timestamp >= cutoff);
  }

  private calculateRecentErrorRate(events: TelemetryEvent[]): number {
    const errors = events.filter(e => e.type === 'error_occurred').length;
    return events.length > 0 ? errors / events.length : 0;
  }

  private calculateAverageResponseTime(events: TelemetryEvent[]): number {
    const performanceEvents = events.filter(e => e.performance?.duration);
    if (performanceEvents.length === 0) return 0;
    
    const totalTime = performanceEvents.reduce((sum, e) => sum + (e.performance?.duration || 0), 0);
    return totalTime / performanceEvents.length;
  }

  private calculateThroughput(events: TelemetryEvent[]): number {
    const completedEvents = events.filter(e => 
      e.type.includes('completed') || e.type.includes('discovered')
    );
    return completedEvents.length; // Events per minute
  }

  private startAggregationTimer(): void {
    this.aggregationTimer = setInterval(() => {
      this.performAggregation();
    }, this.config.aggregationInterval);
  }

  private async performAggregation(): Promise<void> {
    if (!this.repository) return;

    try {
      const projectId = process.env.PROJECT_ID || 'unknown';
      
      // Create performance metrics aggregation
      const perfQuery = TelemetryDatabaseAdapter.createPerformanceAggregationQuery(projectId);
      // Would execute this against database
      
      // Create error tracking aggregation  
      const errorQuery = TelemetryDatabaseAdapter.createErrorTrackingQuery(projectId);
      // Would execute this against database
      
    } catch (error) {
      console.error('Failed to perform telemetry aggregation:', error);
    }
  }

  private getLastEvent(): TelemetryEvent | undefined {
    const events = this.getEvents();
    return events[events.length - 1];
  }

  private getEvents(): TelemetryEvent[] {
    // Access parent class events - this would need to be exposed or use a different approach
    return (this as any).events || [];
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
    }
    
    // Flush any remaining events
    this.flushToDatabaseImmediate();
  }
}

export interface AnalysisPerformanceSummary {
  totalEvents: number;
  totalDuration: number;
  averageMemoryUsage: number;
  errorCount: number;
  errorRate: number;
  cacheHitRate: number;
  optimizationsApplied: number;
  patternsDetected: number;
  componentsAnalyzed: number;
}

export interface RealTimeMetrics {
  eventsPerMinute: number;
  currentMemoryUsage: number;
  currentCpuUsage: NodeJS.CpuUsage;
  activeOperations: number;
  errorRate: number;
  averageResponseTime: number;
  throughput: number;
}

// Export enhanced singleton instance
export const enhancedTelemetry = new EnhancedTelemetryCollector();
