"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enhancedTelemetry = exports.EnhancedTelemetryCollector = void 0;
const telemetry_schema_1 = require("./telemetry-schema");
const database_adapter_1 = require("./database-adapter");
class EnhancedTelemetryCollector extends telemetry_schema_1.TelemetryCollector {
    constructor(config = {}) {
        super(config);
        this.batchBuffer = [];
        this.lastFlushTime = Date.now();
        this.config = {
            enableDatabase: true,
            batchSize: 100,
            flushOnError: true,
            enableRealTimeStreaming: true,
            enableAggregation: true,
            aggregationInterval: 60000,
            ...config
        };
        this.repository = config.databaseRepository;
        this.performanceThresholds = config.performanceThresholds || {};
        if (this.config.enableAggregation) {
            this.startAggregationTimer();
        }
    }
    emit(event) {
        super.emit(event);
        const fullEvent = this.getLastEvent();
        if (!fullEvent)
            return;
        if (this.config.enableDatabase && this.repository) {
            this.batchBuffer.push(fullEvent);
            if (this.shouldFlushImmediately(fullEvent)) {
                this.flushToDatabaseImmediate();
            }
        }
        this.checkPerformanceThresholds(fullEvent);
        if (this.config.enableRealTimeStreaming) {
            this.streamEventRealTime(fullEvent);
        }
    }
    emitAnalyzerEvent(eventType, data, componentId, performance) {
        const event = {
            type: eventType,
            source: {
                analyzer: 'system-topology-analyzer',
                component: componentId
            },
            data,
            metadata: {
                projectId: process.env.PROJECT_ID || 'unknown',
                environment: process.env.NODE_ENV || 'development',
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
    async trackAnalyzerOperation(operationName, componentId, operation) {
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
        }
        catch (error) {
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
    emitPatternDetected(pattern, confidence, location, indicators, componentId) {
        this.emitAnalyzerEvent('pattern_detected', {
            pattern,
            confidence,
            location,
            indicators,
            implications: this.generatePatternImplications(pattern),
            category: this.categorizePattern(pattern)
        }, componentId);
    }
    emitComponentDiscovered(component, parseMetrics) {
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
    emitDependencyDetected(from, to, type, weight, metadata = {}) {
        this.emitAnalyzerEvent('dependency_detected', {
            from,
            to,
            type,
            weight,
            ...metadata
        });
    }
    async flushToDatabaseImmediate() {
        if (!this.repository || this.batchBuffer.length === 0) {
            return;
        }
        try {
            await this.repository.insertEvents([...this.batchBuffer]);
            this.batchBuffer = [];
            this.lastFlushTime = Date.now();
        }
        catch (error) {
            console.error('Failed to flush telemetry to database:', error);
            if (this.batchBuffer.length > this.config.batchSize * 2) {
                this.batchBuffer = this.batchBuffer.slice(-this.config.batchSize);
            }
        }
    }
    getAnalysisPerformanceSummary() {
        const events = this.getEvents();
        const analysisEvents = events.filter(e => e.type.includes('analysis') ||
            e.type.includes('component') ||
            e.type.includes('dependency'));
        const performanceEvents = events.filter(e => e.type === 'performance_metric');
        const totalDuration = analysisEvents.reduce((sum, event) => sum + (event.performance?.duration || 0), 0);
        const averageMemoryUsage = performanceEvents.length > 0
            ? performanceEvents.reduce((sum, event) => sum + (event.performance?.memoryUsed || 0), 0) / performanceEvents.length
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
    getRealTimeMetrics() {
        const recentEvents = this.getRecentEvents(60000);
        const currentMemory = process.memoryUsage();
        return {
            eventsPerMinute: recentEvents.length,
            currentMemoryUsage: currentMemory.heapUsed,
            currentCpuUsage: process.cpuUsage(),
            activeOperations: recentEvents.filter(e => e.type.includes('started') &&
                !recentEvents.some(e2 => e2.type.includes('completed') &&
                    e2.correlationId === e.correlationId)).length,
            errorRate: this.calculateRecentErrorRate(recentEvents),
            averageResponseTime: this.calculateAverageResponseTime(recentEvents),
            throughput: this.calculateThroughput(recentEvents)
        };
    }
    shouldFlushImmediately(event) {
        return (event.type === 'error_occurred' ||
            this.batchBuffer.length >= this.config.batchSize ||
            (Date.now() - this.lastFlushTime) > this.config.flushInterval);
    }
    checkPerformanceThresholds(event) {
        if (!this.performanceThresholds)
            return;
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
            });
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
            });
        }
    }
    streamEventRealTime(event) {
        if (process.env.NODE_ENV === 'development') {
            console.log(`[TELEMETRY] ${event.type}:`, {
                component: event.source.component,
                duration: event.performance?.duration,
                data: event.data
            });
        }
    }
    generatePatternImplications(pattern) {
        const implications = {
            'mvc': ['Three-layer architecture', 'Separation of concerns', 'Web application'],
            'microservices': ['Distributed system', 'Service-oriented', 'Scalable architecture'],
            'dependency_injection': ['Inversion of control', 'Testable code', 'Loose coupling'],
            'singleton': ['Global state', 'Potential testing issues', 'Resource management'],
            'observer': ['Event-driven design', 'Loose coupling', 'Reactive system']
        };
        return implications[pattern] || ['Unknown pattern implications'];
    }
    categorizePattern(pattern) {
        const categories = {
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
    calculateCacheHitRate(events) {
        const cacheEvents = events.filter(e => e.type === 'cache_hit' || e.type === 'cache_miss');
        const hits = events.filter(e => e.type === 'cache_hit').length;
        return cacheEvents.length > 0 ? hits / cacheEvents.length : 0;
    }
    getRecentEvents(timeWindowMs) {
        const cutoff = Date.now() - timeWindowMs;
        return this.getEvents().filter(e => e.timestamp >= cutoff);
    }
    calculateRecentErrorRate(events) {
        const errors = events.filter(e => e.type === 'error_occurred').length;
        return events.length > 0 ? errors / events.length : 0;
    }
    calculateAverageResponseTime(events) {
        const performanceEvents = events.filter(e => e.performance?.duration);
        if (performanceEvents.length === 0)
            return 0;
        const totalTime = performanceEvents.reduce((sum, e) => sum + (e.performance?.duration || 0), 0);
        return totalTime / performanceEvents.length;
    }
    calculateThroughput(events) {
        const completedEvents = events.filter(e => e.type.includes('completed') || e.type.includes('discovered'));
        return completedEvents.length;
    }
    startAggregationTimer() {
        this.aggregationTimer = setInterval(() => {
            this.performAggregation();
        }, this.config.aggregationInterval);
    }
    async performAggregation() {
        if (!this.repository)
            return;
        try {
            const projectId = process.env.PROJECT_ID || 'unknown';
            const perfQuery = database_adapter_1.TelemetryDatabaseAdapter.createPerformanceAggregationQuery(projectId);
            const errorQuery = database_adapter_1.TelemetryDatabaseAdapter.createErrorTrackingQuery(projectId);
        }
        catch (error) {
            console.error('Failed to perform telemetry aggregation:', error);
        }
    }
    getLastEvent() {
        const events = this.getEvents();
        return events[events.length - 1];
    }
    getEvents() {
        return this.events || [];
    }
    async getPerformanceMetrics() {
        const summary = this.getAnalysisPerformanceSummary();
        const realtimeMetrics = this.getRealTimeMetrics();
        return {
            analysis: summary,
            realtime: realtimeMetrics,
            aggregated: {
                totalOperations: summary.totalEvents,
                averageResponseTime: realtimeMetrics.averageResponseTime,
                errorRate: summary.errorRate,
                memoryEfficiency: summary.averageMemoryUsage,
                throughput: realtimeMetrics.throughput
            }
        };
    }
    async getTelemetryEndpoints() {
        return [
            '/api/telemetry/events',
            '/api/telemetry/metrics',
            '/api/telemetry/performance',
            '/api/telemetry/errors',
            '/api/telemetry/real-time'
        ];
    }
    async getAvailableMetrics() {
        return [
            'component_discovery_rate',
            'dependency_detection_rate',
            'pattern_recognition_accuracy',
            'memory_usage',
            'cpu_utilization',
            'analysis_duration',
            'error_frequency',
            'cache_hit_ratio',
            'throughput_rate'
        ];
    }
    getConfiguration() {
        return {
            enableDatabase: this.config.enableDatabase,
            batchSize: this.config.batchSize,
            flushInterval: this.config.flushInterval,
            enableRealTimeStreaming: this.config.enableRealTimeStreaming,
            performanceThresholds: this.performanceThresholds,
            enableAggregation: this.config.enableAggregation,
            aggregationInterval: this.config.aggregationInterval
        };
    }
    destroy() {
        if (this.aggregationTimer) {
            clearInterval(this.aggregationTimer);
        }
        this.flushToDatabaseImmediate();
    }
}
exports.EnhancedTelemetryCollector = EnhancedTelemetryCollector;
exports.enhancedTelemetry = new EnhancedTelemetryCollector();
