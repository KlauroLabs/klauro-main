"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptimizedTelemetryCollector = exports.TelemetryPerformanceOptimizer = void 0;
const enhanced_collector_1 = require("./enhanced-collector");
class TelemetryPerformanceOptimizer {
    constructor(config = {}) {
        this.eventCache = new Map();
        this.compressionEnabled = false;
        this.samplingRate = 1.0;
        this.config = {
            enableAdaptiveBatching: true,
            enableCompressionForLargeEvents: true,
            enableEventDeduplication: true,
            enableSmartSampling: true,
            maxMemoryUsage: 256 * 1024 * 1024,
            compressionThreshold: 1024,
            samplingStrategy: 'adaptive',
            cacheEvictionPolicy: 'lru',
            ...config
        };
        this.startMemoryMonitoring();
    }
    optimizeEvent(event) {
        if (this.config.enableSmartSampling && !this.shouldSampleEvent(event)) {
            return null;
        }
        if (this.config.enableEventDeduplication && this.isDuplicateEvent(event)) {
            return null;
        }
        if (this.config.enableCompressionForLargeEvents) {
            event = this.compressEventIfNeeded(event);
        }
        this.cacheEvent(event);
        return event;
    }
    optimizeBatchSize(currentBatchSize, systemLoad) {
        if (!this.config.enableAdaptiveBatching) {
            return currentBatchSize;
        }
        if (systemLoad > 0.8) {
            return Math.max(10, Math.floor(currentBatchSize * 0.5));
        }
        else if (systemLoad < 0.3) {
            return Math.min(500, Math.floor(currentBatchSize * 1.5));
        }
        return currentBatchSize;
    }
    shouldSampleEvent(event) {
        if (event.type === 'error_occurred') {
            return true;
        }
        if (event.type.includes('analysis_')) {
            return true;
        }
        if (this.config.samplingStrategy === 'adaptive') {
            const memoryUsage = process.memoryUsage().heapUsed;
            const memoryPressure = memoryUsage / (this.config.maxMemoryUsage || 256 * 1024 * 1024);
            if (memoryPressure > 0.8) {
                this.samplingRate = 0.1;
            }
            else if (memoryPressure > 0.6) {
                this.samplingRate = 0.5;
            }
            else {
                this.samplingRate = 1.0;
            }
        }
        return Math.random() <= this.samplingRate;
    }
    isDuplicateEvent(event) {
        const key = this.generateEventKey(event);
        const existing = this.eventCache.get(key);
        if (!existing) {
            return false;
        }
        const timeDiff = Math.abs(event.timestamp - existing.timestamp);
        const dataMatch = JSON.stringify(event.data) === JSON.stringify(existing.data);
        return timeDiff < 1000 && dataMatch;
    }
    compressEventIfNeeded(event) {
        const eventSize = JSON.stringify(event).length;
        if (eventSize > (this.config.compressionThreshold || 1024)) {
            if (event.data && typeof event.data === 'object') {
                event.data = this.compressObject(event.data);
            }
        }
        return event;
    }
    cacheEvent(event) {
        const key = this.generateEventKey(event);
        if (this.eventCache.size > 1000) {
            this.evictCacheEntries();
        }
        this.eventCache.set(key, event);
    }
    generateEventKey(event) {
        return `${event.type}_${event.source.component || 'global'}_${Math.floor(event.timestamp / 10000)}`;
    }
    compressObject(obj) {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }
        const compressed = {};
        for (const [key, value] of Object.entries(obj)) {
            if (Array.isArray(value) && value.length > 100) {
                compressed[key] = `[Array of ${value.length} items]`;
            }
            else if (typeof value === 'string' && value.length > 1000) {
                compressed[key] = value.substring(0, 1000) + '... (truncated)';
            }
            else if (typeof value === 'object' && value !== null) {
                compressed[key] = this.compressObject(value);
            }
            else {
                compressed[key] = value;
            }
        }
        return compressed;
    }
    evictCacheEntries() {
        const evictionCount = Math.floor(this.eventCache.size * 0.3);
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
    evictLRU(count) {
        const entries = Array.from(this.eventCache.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        for (let i = 0; i < count && i < entries.length; i++) {
            this.eventCache.delete(entries[i][0]);
        }
    }
    evictLFU(count) {
        this.evictLRU(count);
    }
    evictTTL(count) {
        const cutoff = Date.now() - (10 * 60 * 1000);
        let evicted = 0;
        for (const [key, event] of this.eventCache.entries()) {
            if (event.timestamp < cutoff && evicted < count) {
                this.eventCache.delete(key);
                evicted++;
            }
        }
    }
    startMemoryMonitoring() {
        this.memoryMonitor = setInterval(() => {
            const memoryUsage = process.memoryUsage();
            const pressure = memoryUsage.heapUsed / (this.config.maxMemoryUsage || 256 * 1024 * 1024);
            if (pressure > 0.9) {
                console.warn('High memory pressure detected, triggering cache cleanup');
                this.eventCache.clear();
            }
            else if (pressure > 0.7) {
                this.evictCacheEntries();
            }
        }, 30000);
    }
    getOptimizationStats() {
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
    destroy() {
        if (this.memoryMonitor) {
            clearInterval(this.memoryMonitor);
        }
        this.eventCache.clear();
    }
}
exports.TelemetryPerformanceOptimizer = TelemetryPerformanceOptimizer;
class OptimizedTelemetryCollector extends enhanced_collector_1.EnhancedTelemetryCollector {
    constructor(config = {}) {
        super(config);
        this.optimizer = new TelemetryPerformanceOptimizer(config.optimizationConfig);
    }
    emit(event) {
        const fullEvent = this.createFullEvent(event);
        const optimizedEvent = this.optimizer.optimizeEvent(fullEvent);
        if (optimizedEvent) {
            super.emit(optimizedEvent);
        }
    }
    createFullEvent(event) {
        return {
            id: this.generateId(),
            timestamp: Date.now(),
            sessionId: this.getSessionId(),
            ...event
        };
    }
    generateId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    getSessionId() {
        return process.env.TELEMETRY_SESSION_ID || 'default';
    }
    getOptimizationStats() {
        return this.optimizer.getOptimizationStats();
    }
    destroy() {
        this.optimizer.destroy();
        super.destroy();
    }
}
exports.OptimizedTelemetryCollector = OptimizedTelemetryCollector;
