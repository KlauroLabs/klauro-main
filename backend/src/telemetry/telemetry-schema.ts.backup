/**
 * Telemetry Schema for Unravl Platform
 * Defines all telemetry events, metrics, and data structures
 * for real-time monitoring and analysis instrumentation
 */

import { ComponentNode, Connection, FunctionInfo, DatabaseOperation } from '../types';

// ===== Core Telemetry Types =====

export interface TelemetryEvent {
  id: string;
  timestamp: number;
  type: TelemetryEventType;
  source: TelemetrySource;
  sessionId: string;
  correlationId?: string;
  parentId?: string;
  data: any;
  metadata: TelemetryMetadata;
  performance?: PerformanceTiming;
  context?: ExecutionContext;
}

export type TelemetryEventType = 
  | 'analysis_started'
  | 'analysis_completed'
  | 'component_discovered'
  | 'dependency_detected'
  | 'entry_point_found'
  | 'exit_point_found'
  | 'pattern_detected'
  | 'ast_traversal'
  | 'file_processed'
  | 'error_occurred'
  | 'performance_metric'
  | 'memory_snapshot'
  | 'cache_hit'
  | 'cache_miss'
  | 'optimization_applied'
  | 'framework_detected'
  | 'database_connection_found'
  | 'api_endpoint_discovered'
  | 'test_coverage_calculated'
  | 'risk_identified'
  | 'call_graph_generated'
  | 'complexity_calculated';

export interface TelemetrySource {
  analyzer: string;
  component?: string;
  file?: string;
  function?: string;
  line?: number;
  column?: number;
}

export interface TelemetryMetadata {
  projectId: string;
  organizationId?: string;
  userId?: string;
  environment: 'development' | 'staging' | 'production';
  version: string;
  platform: string;
  tags?: Record<string, string>;
  labels?: string[];
}

export interface PerformanceTiming {
  startTime: number;
  endTime?: number;
  duration?: number;
  cpuTime?: number;
  memoryUsed?: number;
  memoryDelta?: number;
  fileIOTime?: number;
  networkTime?: number;
  parsingTime?: number;
  analysisTime?: number;
}

export interface ExecutionContext {
  threadId?: string;
  processId?: string;
  hostname?: string;
  stackDepth?: number;
  asyncOperations?: number;
  parallelOperations?: number;
}

// ===== Analysis Telemetry Events =====

export interface AnalysisStartedEvent extends TelemetryEvent {
  type: 'analysis_started';
  data: {
    repositoryPath: string;
    language: string;
    framework?: string;
    totalFiles: number;
    estimatedDuration?: number;
    options: Record<string, any>;
  };
}

export interface AnalysisCompletedEvent extends TelemetryEvent {
  type: 'analysis_completed';
  data: {
    success: boolean;
    componentsFound: number;
    connectionsFound: number;
    entryPointsFound: number;
    exitPointsFound: number;
    orphanedComponents: number;
    riskAreas: number;
    duration: number;
    errors?: string[];
  };
}

export interface ComponentDiscoveredEvent extends TelemetryEvent {
  type: 'component_discovered';
  data: {
    component: ComponentNode;
    fileSize: number;
    parseTime: number;
    functionCount: number;
    classCount: number;
    importCount: number;
    exportCount: number;
  };
}

export interface DependencyDetectedEvent extends TelemetryEvent {
  type: 'dependency_detected';
  data: {
    from: string;
    to: string;
    type: string;
    weight: number;
    circular?: boolean;
    depth?: number;
    importPath?: string;
  };
}

export interface PatternDetectedEvent extends TelemetryEvent {
  type: 'pattern_detected';
  data: {
    pattern: string;
    confidence: number;
    location: string;
    indicators: string[];
    implications: string[];
    category: 'architectural' | 'design' | 'anti-pattern' | 'security' | 'performance';
  };
}

// ===== AST Traversal Telemetry =====

export interface ASTTraversalEvent extends TelemetryEvent {
  type: 'ast_traversal';
  data: {
    file: string;
    nodeType: string;
    nodeCount: number;
    depth: number;
    traversalTime: number;
    memoryUsed: number;
    optimizationsApplied: string[];
  };
}

export interface ASTNode {
  type: string;
  start: number;
  end: number;
  children?: ASTNode[];
  metadata?: Record<string, any>;
}

export interface ASTOptimization {
  type: 'pruning' | 'caching' | 'parallel' | 'incremental' | 'lazy';
  description: string;
  nodesAffected: number;
  timeReduction: number;
  memoryReduction: number;
}

// ===== Performance Monitoring =====

export interface PerformanceMetricEvent extends TelemetryEvent {
  type: 'performance_metric';
  data: {
    metric: string;
    value: number;
    unit: 'ms' | 'bytes' | 'count' | 'percentage';
    threshold?: number;
    exceeded?: boolean;
    component?: string;
    operation?: string;
  };
}

export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  gcCollections?: number;
  largestObjects?: Array<{
    type: string;
    size: number;
    count: number;
  }>;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
  size: number;
  maxSize: number;
  ttl: number;
  keys: string[];
}

// ===== Instrumentation Points =====

export interface InstrumentationPoint {
  id: string;
  type: InstrumentationType;
  location: CodeLocation;
  active: boolean;
  configuration: InstrumentationConfig;
  metrics: InstrumentationMetrics;
}

export type InstrumentationType = 
  | 'function_entry'
  | 'function_exit'
  | 'loop_iteration'
  | 'conditional_branch'
  | 'exception_handler'
  | 'async_operation'
  | 'database_query'
  | 'api_call'
  | 'file_operation'
  | 'memory_allocation'
  | 'custom';

export interface CodeLocation {
  file: string;
  function?: string;
  line: number;
  column: number;
  astNodeId?: string;
}

export interface InstrumentationConfig {
  enabled: boolean;
  sampling: SamplingStrategy;
  conditions?: InstrumentationCondition[];
  dataCapture?: DataCaptureConfig;
  performance?: PerformanceConfig;
}

export interface SamplingStrategy {
  type: 'always' | 'random' | 'adaptive' | 'conditional';
  rate?: number;
  adaptiveThreshold?: number;
  condition?: string;
}

export interface InstrumentationCondition {
  type: 'expression' | 'threshold' | 'pattern';
  value: any;
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'matches';
}

export interface DataCaptureConfig {
  captureArguments: boolean;
  captureReturnValue: boolean;
  captureThis: boolean;
  captureStack: boolean;
  captureVariables?: string[];
  maxDepth?: number;
  maxStringLength?: number;
  sanitization?: SanitizationRule[];
}

export interface SanitizationRule {
  pattern: string;
  replacement: string;
  fields?: string[];
}

export interface PerformanceConfig {
  measureCPU: boolean;
  measureMemory: boolean;
  measureIO: boolean;
  measureNetwork: boolean;
  profileThreshold?: number;
  traceThreshold?: number;
}

export interface InstrumentationMetrics {
  invocations: number;
  totalTime: number;
  averageTime: number;
  minTime: number;
  maxTime: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
  lastInvocation?: number;
}

// ===== Telemetry Manifest =====

export interface TelemetryManifest {
  version: string;
  generatedAt: number;
  projectId: string;
  analyzers: AnalyzerTelemetry[];
  instrumentationPoints: InstrumentationPoint[];
  performanceProfile: PerformanceProfile;
  dataFlows: DataFlowTelemetry[];
  hotPaths: HotPathTelemetry[];
  bottlenecks: BottleneckTelemetry[];
  optimizations: OptimizationSuggestion[];
}

export interface AnalyzerTelemetry {
  name: string;
  version: string;
  startTime: number;
  endTime: number;
  filesProcessed: number;
  componentsAnalyzed: number;
  patternsDetected: number;
  performance: PerformanceTiming;
  errors: ErrorTelemetry[];
  warnings: string[];
}

export interface ErrorTelemetry {
  timestamp: number;
  type: string;
  message: string;
  stack?: string;
  file?: string;
  recoverable: boolean;
  impact?: 'low' | 'medium' | 'high';
}

export interface PerformanceProfile {
  totalAnalysisTime: number;
  fileParsingTime: number;
  astTraversalTime: number;
  patternDetectionTime: number;
  connectionAnalysisTime: number;
  memoryPeakUsage: number;
  cpuPeakUsage: number;
  parallelization: number;
  cacheHitRate: number;
}

export interface DataFlowTelemetry {
  id: string;
  source: string;
  destination: string;
  dataType: string;
  transformations: string[];
  frequency: number;
  latency?: number;
  volume?: number;
  critical: boolean;
}

export interface HotPathTelemetry {
  id: string;
  path: string[];
  frequency: number;
  averageLatency: number;
  maxLatency: number;
  throughput: number;
  bottlenecks?: string[];
  optimizable: boolean;
}

export interface BottleneckTelemetry {
  id: string;
  location: string;
  type: 'cpu' | 'memory' | 'io' | 'network' | 'database' | 'synchronization';
  severity: 'low' | 'medium' | 'high' | 'critical';
  impact: number;
  frequency: number;
  recommendations: string[];
}

export interface OptimizationSuggestion {
  id: string;
  type: 'caching' | 'parallelization' | 'batching' | 'indexing' | 'query' | 'algorithm' | 'architecture';
  location: string;
  currentPerformance: number;
  estimatedImprovement: number;
  effort: 'low' | 'medium' | 'high';
  description: string;
  implementation?: string;
}

// ===== Real-time Streaming =====

export interface TelemetryStream {
  id: string;
  type: 'websocket' | 'sse' | 'long-poll' | 'grpc';
  endpoint: string;
  protocol: string;
  filters?: StreamFilter[];
  transformations?: StreamTransformation[];
  bufferSize?: number;
  compression?: boolean;
  encryption?: boolean;
}

export interface StreamFilter {
  field: string;
  operator: string;
  value: any;
  combine?: 'and' | 'or';
}

export interface StreamTransformation {
  type: 'aggregate' | 'sample' | 'filter' | 'map' | 'reduce';
  configuration: Record<string, any>;
}

// ===== Telemetry Aggregation =====

export interface TelemetryAggregation {
  id: string;
  type: 'count' | 'sum' | 'average' | 'min' | 'max' | 'percentile' | 'histogram' | 'rate';
  field: string;
  window?: TimeWindow;
  groupBy?: string[];
  filters?: AggregationFilter[];
  result?: AggregationResult;
}

export interface TimeWindow {
  size: number;
  unit: 'seconds' | 'minutes' | 'hours' | 'days';
  sliding?: boolean;
}

export interface AggregationFilter {
  field: string;
  condition: string;
  value: any;
}

export interface AggregationResult {
  timestamp: number;
  value: number | number[] | Record<string, number>;
  metadata?: Record<string, any>;
}

// ===== Telemetry Storage =====

export interface TelemetryStorage {
  type: 'memory' | 'file' | 'database' | 'timeseries' | 'cloud';
  configuration: StorageConfig;
  retention: RetentionPolicy;
  indexing: IndexingStrategy;
  compression?: CompressionConfig;
}

export interface StorageConfig {
  location?: string;
  connectionString?: string;
  bucket?: string;
  table?: string;
  partitioning?: PartitionStrategy;
}

export interface RetentionPolicy {
  duration: number;
  unit: 'hours' | 'days' | 'weeks' | 'months';
  archival?: ArchivalConfig;
}

export interface ArchivalConfig {
  enabled: boolean;
  destination: string;
  compression: boolean;
  encryption: boolean;
}

export interface IndexingStrategy {
  fields: string[];
  type: 'btree' | 'hash' | 'inverted' | 'timeseries';
  unique?: boolean;
  sparse?: boolean;
}

export interface PartitionStrategy {
  type: 'time' | 'hash' | 'range' | 'list';
  field: string;
  interval?: string;
  buckets?: number;
}

export interface CompressionConfig {
  algorithm: 'gzip' | 'brotli' | 'lz4' | 'snappy';
  level: number;
  threshold?: number;
}

// ===== Telemetry Collection Service =====

export class TelemetryCollector {
  private events: TelemetryEvent[] = [];
  private buffer: TelemetryEvent[] = [];
  private flushInterval: number = 1000;
  private maxBufferSize: number = 1000;
  private storage?: TelemetryStorage;
  private stream?: TelemetryStream;
  private aggregations: Map<string, TelemetryAggregation> = new Map();
  private instrumentationPoints: Map<string, InstrumentationPoint> = new Map();
  
  constructor(config?: TelemetryConfig) {
    if (config) {
      this.configure(config);
    }
    this.startFlushTimer();
  }

  public emit(event: Partial<TelemetryEvent>): void {
    const fullEvent: TelemetryEvent = {
      id: this.generateId(),
      timestamp: Date.now(),
      sessionId: this.getSessionId(),
      ...event
    } as TelemetryEvent;

    this.buffer.push(fullEvent);
    
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush();
    }

    // Real-time streaming if configured
    if (this.stream) {
      this.streamEvent(fullEvent);
    }

    // Update aggregations
    this.updateAggregations(fullEvent);
  }

  public instrument(point: InstrumentationPoint): void {
    this.instrumentationPoints.set(point.id, point);
  }

  public measure<T>(name: string, fn: () => T): T {
    const startTime = performance.now();
    const startMemory = process.memoryUsage();
    
    try {
      const result = fn();
      
      const endTime = performance.now();
      const endMemory = process.memoryUsage();
      
      this.emit({
        type: 'performance_metric',
        source: { analyzer: 'telemetry', function: name },
        data: {
          metric: name,
          value: endTime - startTime,
          unit: 'ms',
          memoryDelta: endMemory.heapUsed - startMemory.heapUsed
        },
        performance: {
          startTime,
          endTime,
          duration: endTime - startTime,
          memoryUsed: endMemory.heapUsed,
          memoryDelta: endMemory.heapUsed - startMemory.heapUsed
        }
      } as PerformanceMetricEvent);
      
      return result;
    } catch (error) {
      this.emit({
        type: 'error_occurred',
        source: { analyzer: 'telemetry', function: name },
        data: {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }
      });
      throw error;
    }
  }

  public async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startTime = performance.now();
    const startMemory = process.memoryUsage();
    
    try {
      const result = await fn();
      
      const endTime = performance.now();
      const endMemory = process.memoryUsage();
      
      this.emit({
        type: 'performance_metric',
        source: { analyzer: 'telemetry', function: name },
        data: {
          metric: name,
          value: endTime - startTime,
          unit: 'ms',
          memoryDelta: endMemory.heapUsed - startMemory.heapUsed
        },
        performance: {
          startTime,
          endTime,
          duration: endTime - startTime,
          memoryUsed: endMemory.heapUsed,
          memoryDelta: endMemory.heapUsed - startMemory.heapUsed
        }
      } as PerformanceMetricEvent);
      
      return result;
    } catch (error) {
      this.emit({
        type: 'error_occurred',
        source: { analyzer: 'telemetry', function: name },
        data: {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }
      });
      throw error;
    }
  }

  public createSpan(name: string, parentId?: string): TelemetrySpan {
    const spanId = this.generateId();
    const startTime = performance.now();
    
    return {
      id: spanId,
      name,
      parentId,
      startTime,
      end: () => {
        const endTime = performance.now();
        this.emit({
          type: 'performance_metric',
          source: { analyzer: 'telemetry', function: name },
          parentId,
          data: {
            metric: `span.${name}`,
            value: endTime - startTime,
            unit: 'ms',
            spanId
          }
        });
      }
    };
  }

  public getMetrics(): TelemetryMetrics {
    return {
      eventsCollected: this.events.length,
      eventsBuffered: this.buffer.length,
      instrumentationPoints: this.instrumentationPoints.size,
      aggregations: this.aggregations.size,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime()
    };
  }

  public generateManifest(): TelemetryManifest {
    const analyzers = this.extractAnalyzerTelemetry();
    const performanceProfile = this.calculatePerformanceProfile();
    const dataFlows = this.extractDataFlows();
    const hotPaths = this.identifyHotPaths();
    const bottlenecks = this.detectBottlenecks();
    const optimizations = this.suggestOptimizations();

    return {
      version: '1.0.0',
      generatedAt: Date.now(),
      projectId: this.getProjectId(),
      analyzers,
      instrumentationPoints: Array.from(this.instrumentationPoints.values()),
      performanceProfile,
      dataFlows,
      hotPaths,
      bottlenecks,
      optimizations
    };
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    
    this.events.push(...this.buffer);
    
    if (this.storage) {
      this.persistEvents(this.buffer);
    }
    
    this.buffer = [];
  }

  private startFlushTimer(): void {
    setInterval(() => this.flush(), this.flushInterval);
  }

  private streamEvent(event: TelemetryEvent): void {
    // Implementation would stream to WebSocket/SSE
  }

  private updateAggregations(event: TelemetryEvent): void {
    for (const aggregation of this.aggregations.values()) {
      // Update aggregation based on event
    }
  }

  private persistEvents(events: TelemetryEvent[]): void {
    // Implementation would persist to configured storage
  }

  private extractAnalyzerTelemetry(): AnalyzerTelemetry[] {
    // Extract analyzer-specific telemetry from events
    return [];
  }

  private calculatePerformanceProfile(): PerformanceProfile {
    // Calculate overall performance profile
    return {} as PerformanceProfile;
  }

  private extractDataFlows(): DataFlowTelemetry[] {
    // Extract data flow patterns from events
    return [];
  }

  private identifyHotPaths(): HotPathTelemetry[] {
    // Identify frequently executed paths
    return [];
  }

  private detectBottlenecks(): BottleneckTelemetry[] {
    // Detect performance bottlenecks
    return [];
  }

  private suggestOptimizations(): OptimizationSuggestion[] {
    // Generate optimization suggestions
    return [];
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private getSessionId(): string {
    return process.env.TELEMETRY_SESSION_ID || 'default';
  }

  private getProjectId(): string {
    return process.env.PROJECT_ID || 'unknown';
  }

  private configure(config: TelemetryConfig): void {
    this.flushInterval = config.flushInterval || this.flushInterval;
    this.maxBufferSize = config.maxBufferSize || this.maxBufferSize;
    this.storage = config.storage;
    this.stream = config.stream;
  }
}

export interface TelemetryConfig {
  flushInterval?: number;
  maxBufferSize?: number;
  storage?: TelemetryStorage;
  stream?: TelemetryStream;
}

export interface TelemetrySpan {
  id: string;
  name: string;
  parentId?: string;
  startTime: number;
  end: () => void;
}

export interface TelemetryMetrics {
  eventsCollected: number;
  eventsBuffered: number;
  instrumentationPoints: number;
  aggregations: number;
  memoryUsage: NodeJS.MemoryUsage;
  uptime: number;
}

// Export singleton instance
export const telemetry = new TelemetryCollector();
