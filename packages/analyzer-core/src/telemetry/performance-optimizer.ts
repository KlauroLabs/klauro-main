/**
 * Performance Optimizer for Integrated Telemetry System
 * Handles caching, batching, and real-time optimization
 */

import { TelemetryEvent } from './telemetry-schema';
import { EnhancedTelemetryCollector } from './enhanced-collector';

export interface PerformanceOptimizationConfig {
  enableAdaptiveBatching?: boolean;
  enableCompressionForLargeEvents?: boolean;
  enableEventDeduplication?: boolean;
  enableSmartSampling?: boolean;
  maxMemoryUsage?: number; // bytes
  compressionThreshold?: number; // bytes
  samplingStrategy?: 'adaptive' | 'fixed' | 'intelligent';
  cacheEvictionPolicy?: 'lru' | 'lfu' | 'ttl';
}

/**
 * Performance Optimization Engine
 */
export class TelemetryPerformanceOptimizer {
  private config: PerformanceOptimizationConfig;
  private eventCache = new Map<string, TelemetryEvent>();
  private compressionEnabled = false;
  private samplingRate = 1.0;
  private memoryMonitor!: NodeJS.Timer;

  constructor(config: PerformanceOptimizationConfig = {}) {
    this.config = {
      enableAdaptiveBatching: true,
      enableCompressionForLargeEvents: true,
      enableEventDeduplication: true,
      enableSmartSampling: true,
      maxMemoryUsage: 256 * 1024 * 1024, // 256MB
      compressionThreshold: 1024, // 1KB
      samplingStrategy: 'adaptive',
      cacheEvictionPolicy: 'lru',
      ...config
    };

    this.startMemoryMonitoring();
  }

  /**
   * Optimize event before processing
   */
  public optimizeEvent(event: TelemetryEvent): TelemetryEvent | null {
    // Smart sampling
    if (this.config.enableSmartSampling && !this.shouldSampleEvent(event)) {
      return null;
    }

    // Event deduplication
    if (this.config.enableEventDeduplication && this.isDuplicateEvent(event)) {
      return null;
    }

    // Compression for large events
    if (this.config.enableCompressionForLargeEvents) {
      event = this.compressEventIfNeeded(event);
    }

    // Cache for potential deduplication
    this.cacheEvent(event);

    return event;
  }

  /**
   * Adaptive batching optimization
   */
  public optimizeBatchSize(currentBatchSize: number, systemLoad: number): number {
    if (!this.config.enableAdaptiveBatching) {
      return currentBatchSize;
    }

    // Adjust batch size based on system load
    if (systemLoad > 0.8) {
      return Math.max(10, Math.floor(currentBatchSize * 0.5));
    } else if (systemLoad < 0.3) {
      return Math.min(500, Math.floor(currentBatchSize * 1.5));
    }

    return currentBatchSize;
  }

  /**
   * Smart sampling based on event importance and system state
   */
  private shouldSampleEvent(event: TelemetryEvent): boolean {
    // Always sample error events
    if (event.type === 'error_occurred') {
      return true;
    }

    // Always sample analysis lifecycle events
    if (event.type.includes('analysis_')) {
      return true;
    }

    // Adaptive sampling based on system load
    if (this.config.samplingStrategy === 'adaptive') {
      const memoryUsage = process.memoryUsage().heapUsed;
      const memoryPressure = memoryUsage / (this.config.maxMemoryUsage || 256 * 1024 * 1024);
      
      if (memoryPressure > 0.8) {
        this.samplingRate = 0.1; // Sample only 10% under high memory pressure
      } else if (memoryPressure > 0.6) {
        this.samplingRate = 0.5; // Sample 50% under medium pressure
      } else {
        this.samplingRate = 1.0; // Sample everything under low pressure
      }
    }

    return Math.random() <= this.samplingRate;
  }

  /**
   * Event deduplication check
   */
  private isDuplicateEvent(event: TelemetryEvent): boolean {
    const key = this.generateEventKey(event);
    const existing = this.eventCache.get(key);
    
    if (!existing) {
      return false;
    }

    // Check if events are too similar (within 1 second and same data)
    const timeDiff = Math.abs(event.timestamp - existing.timestamp);
    const dataMatch = JSON.stringify(event.data) === JSON.stringify(existing.data);
    
    return timeDiff < 1000 && dataMatch;
  }

  /**
   * Compress large events
   */
  private compressEventIfNeeded(event: TelemetryEvent): TelemetryEvent {
    const eventSize = JSON.stringify(event).length;
    
    if (eventSize > (this.config.compressionThreshold || 1024)) {
      // Simplified compression - in production would use actual compression
      if (event.data && typeof event.data === 'object') {
        event.data = this.compressObject(event.data);
      }
    }

    return event;
  }

  /**
   * Cache event for deduplication
   */
  private cacheEvent(event: TelemetryEvent): void {
    const key = this.generateEventKey(event);
    
    // Apply cache eviction policy
    if (this.eventCache.size > 1000) {
      this.evictCacheEntries();
    }
    
    this.eventCache.set(key, event);
  }

  /**
   * Generate unique key for event
   */
  private generateEventKey(event: TelemetryEvent): string {
    return `${event.type}_${event.source.component || 'global'}_${Math.floor(event.timestamp / 10000)}`;
  }

  /**
   * Compress object by removing unnecessary fields
   */
  private compressObject(obj: any): any {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    const compressed: any = {};
    
    for (const [key, value] of Object.entries(obj)) {
      // Skip large arrays or objects that aren't critical
      if (Array.isArray(value) && value.length > 100) {
        compressed[key] = `[Array of ${value.length} items]`;
      } else if (typeof value === 'string' && value.length > 1000) {
        compressed[key] = value.substring(0, 1000) + '... (truncated)';
      } else if (typeof value === 'object' && value !== null) {
        compressed[key] = this.compressObject(value);
      } else {
        compressed[key] = value;
      }
    }

    return compressed;
  }

  /**
   * Cache eviction based on policy
   */
  private evictCacheEntries(): void {
    const evictionCount = Math.floor(this.eventCache.size * 0.3); // Evict 30%
    
    switch (this.config.cacheEvictionPolicy) {
      case 'lru':
        this.evictLRU(evictionCount);
        break;
      case 'lfu':
        this.evictLFU(evictionCount);
        break;
      case 'ttl':
        this.evictTTL(evictionCount);
        break;
      default:
        this.evictLRU(evictionCount);
    }
  }

  private evictLRU(count: number): void {
    // Simple LRU eviction - remove oldest entries
    const entries = Array.from(this.eventCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    for (let i = 0; i < count && i < entries.length; i++) {
      this.eventCache.delete(entries[i][0]);
    }
  }

  private evictLFU(count: number): void {
    // Simplified LFU - for production would track access frequency
    this.evictLRU(count);
  }

  private evictTTL(count: number): void {
    // TTL-based eviction - remove entries older than 10 minutes
    const cutoff = Date.now() - (10 * 60 * 1000);
    let evicted = 0;
    
    for (const [key, event] of this.eventCache.entries()) {
      if (event.timestamp < cutoff && evicted < count) {
        this.eventCache.delete(key);
        evicted++;
      }
    }
  }

  /**
   * Memory monitoring
   */
  private startMemoryMonitoring(): void {
    this.memoryMonitor = setInterval(() => {
      const memoryUsage = process.memoryUsage();
      const pressure = memoryUsage.heapUsed / (this.config.maxMemoryUsage || 256 * 1024 * 1024);
      
      if (pressure > 0.9) {
        console.warn('High memory pressure detected, triggering cache cleanup');
        this.eventCache.clear();
      } else if (pressure > 0.7) {
        this.evictCacheEntries();
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Get optimization statistics
   */
  public getOptimizationStats(): OptimizationStats {
    const memoryUsage = process.memoryUsage();
    
    return {
      cacheSize: this.eventCache.size,
      samplingRate: this.samplingRate,
      memoryUsage: memoryUsage.heapUsed,
      memoryPressure: memoryUsage.heapUsed / (this.config.maxMemoryUsage || 256 * 1024 * 1024),
      compressionEnabled: this.compressionEnabled,
      optimizationsApplied: {
        adaptiveBatching: this.config.enableAdaptiveBatching || false,
        compression: this.config.enableCompressionForLargeEvents || false,
        deduplication: this.config.enableEventDeduplication || false,
        smartSampling: this.config.enableSmartSampling || false
      }
    };
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    if (this.memoryMonitor) {
      clearInterval(this.memoryMonitor as any);
    }
    this.eventCache.clear();
  }
}

export interface OptimizationStats {
  cacheSize: number;
  samplingRate: number;
  memoryUsage: number;
  memoryPressure: number;
  compressionEnabled: boolean;
  optimizationsApplied: {
    adaptiveBatching: boolean;
    compression: boolean;
    deduplication: boolean;
    smartSampling: boolean;
  };
}

/**
 * Integration with Enhanced Telemetry Collector
 */
export class OptimizedTelemetryCollector extends EnhancedTelemetryCollector {
  private optimizer: TelemetryPerformanceOptimizer;
  
  constructor(config: any = {}) {
    super(config);
    this.optimizer = new TelemetryPerformanceOptimizer(config.optimizationConfig);
  }

  public emit(event: Partial<TelemetryEvent>): void {
    const fullEvent = this.createFullEvent(event);
    const optimizedEvent = this.optimizer.optimizeEvent(fullEvent);
    
    // Only emit if event passes optimization filters
    if (optimizedEvent) {
      super.emit(optimizedEvent);
    }
  }

  private createFullEvent(event: Partial<TelemetryEvent>): TelemetryEvent {
    return {
      id: this.generateId(),
      timestamp: Date.now(),
      sessionId: this.getSessionId(),
      ...event
    } as TelemetryEvent;
  }

  protected generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  protected getSessionId(): string {
    return process.env.TELEMETRY_SESSION_ID || 'default';
  }

  public getOptimizationStats(): OptimizationStats {
    return this.optimizer.getOptimizationStats();
  }

  public destroy(): void {
    this.optimizer.destroy();
    super.destroy();
  }
}
