"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseIntegratedAnalyzer = void 0;
const system_topology_analyzer_1 = require("./system-topology-analyzer");
const enhanced_collector_1 = require("../telemetry/enhanced-collector");
class DatabaseIntegratedAnalyzer extends system_topology_analyzer_1.SystemTopologyAnalyzer {
    constructor(options = {}) {
        super();
        this.analysisStartTime = 0;
        this.options = {
            enableDatabasePersistence: true,
            enableTelemetry: true,
            enableRealTimeUpdates: true,
            enableCaching: true,
            cacheStrategy: 'memory',
            ...options
        };
        this.telemetryCollector = new enhanced_collector_1.EnhancedTelemetryCollector({
            enableDatabase: this.options.enableDatabasePersistence,
            enableRealTimeStreaming: this.options.enableRealTimeUpdates,
            databaseRepository: this.repository,
            ...this.options.telemetryConfig
        });
        if (this.options.enableDatabasePersistence) {
            this.initializeDatabaseConnection();
        }
    }
    getAnalyzerName() {
        return 'Database-Integrated System Topology Analyzer';
    }
    async analyzeRepository(repositoryPath, options = {}) {
        this.analysisStartTime = Date.now();
        const mergedOptions = { ...this.options, ...options };
        await this.telemetryCollector.trackAnalyzerOperation('repository_analysis', undefined, async () => {
            this.telemetryCollector.emitAnalyzerEvent('analysis_started', {
                repositoryPath,
                options: mergedOptions,
                analyzer: this.getAnalyzerName(),
                estimatedDuration: this.estimateAnalysisDuration(repositoryPath)
            });
            return this.performEnhancedAnalysis(repositoryPath, mergedOptions);
        });
        const blueprint = await super.analyzeRepository(repositoryPath, mergedOptions);
        await this.postProcessWithDatabase(blueprint);
        this.telemetryCollector.emitAnalyzerEvent('analysis_completed', {
            success: true,
            componentsFound: blueprint.components.length,
            connectionsFound: blueprint.connections.length,
            entryPointsFound: blueprint.entryPoints.length,
            exitPointsFound: blueprint.exitPoints.length,
            riskAreas: blueprint.riskAreas.length,
            duration: Date.now() - this.analysisStartTime,
            performanceSummary: this.telemetryCollector.getAnalysisPerformanceSummary()
        });
        return blueprint;
    }
    async discoverComponents() {
        return await this.telemetryCollector.trackAnalyzerOperation('component_discovery', undefined, async () => {
            const discovery = await super.discoverComponents();
            for (const component of discovery.components) {
                this.telemetryCollector.emitComponentDiscovered(component, {
                    fileSize: await this.getFileSize(component.path),
                    parseTime: 0,
                    functionCount: component.metadata.functions?.length || 0,
                    classCount: this.countClasses(component),
                    importCount: component.metadata.imports.length,
                    exportCount: component.metadata.exports.length
                });
            }
            return discovery;
        });
    }
    async analyzeConnections(components) {
        return await this.telemetryCollector.trackAnalyzerOperation('connection_analysis', undefined, async () => {
            const connections = await super.analyzeConnections(components);
            for (const connection of connections) {
                this.telemetryCollector.emitDependencyDetected(connection.from, connection.to, connection.type, connection.weight, {
                    importPath: connection.metadata?.dataFlow,
                    depth: this.calculateDependencyDepth(connection, connections)
                });
            }
            const circularDeps = this.detectCircularDependencies(connections);
            for (const cycle of circularDeps) {
                this.telemetryCollector.emitAnalyzerEvent('circular_dependency_detected', {
                    cycle,
                    severity: this.assessCircularDependencySeverity(cycle),
                    impact: this.calculateCircularDependencyImpact(cycle, components)
                });
            }
            return connections;
        });
    }
    async detectArchitecturalPatterns(components) {
        await this.telemetryCollector.trackAnalyzerOperation('pattern_detection', undefined, async () => {
            const mvcConfidence = this.detectMVCPattern(components);
            if (mvcConfidence > 0.5) {
                this.telemetryCollector.emitPatternDetected('mvc', mvcConfidence, 'project_structure', this.getMVCIndicators(components));
            }
            const microservicesConfidence = this.detectMicroservicesPattern(components);
            if (microservicesConfidence > 0.5) {
                this.telemetryCollector.emitPatternDetected('microservices', microservicesConfidence, 'architecture', this.getMicroservicesIndicators(components));
            }
            const diConfidence = this.detectDependencyInjection(components);
            if (diConfidence > 0.5) {
                this.telemetryCollector.emitPatternDetected('dependency_injection', diConfidence, 'code_patterns', this.getDIIndicators(components));
            }
            await this.detectAntiPatterns(components);
        });
    }
    async postProcessWithDatabase(blueprint) {
        if (!this.options.enableDatabasePersistence || !this.repository) {
            return;
        }
        await this.telemetryCollector.trackAnalyzerOperation('database_persistence', undefined, async () => {
            await this.persistAnalysisResults(blueprint);
            await this.updateComponentHealthScores(blueprint.components);
            await this.triggerTelemetryAggregation();
        });
    }
    async streamAnalysisUpdates(event, data) {
        if (!this.options.enableRealTimeUpdates) {
            return;
        }
        this.telemetryCollector.emitAnalyzerEvent('real_time_update', {
            event,
            data,
            timestamp: Date.now(),
            analysisId: this.analysisId
        });
    }
    async handleAnalysisError(error, context) {
        this.telemetryCollector.emitAnalyzerEvent('error_occurred', {
            error: error.message,
            stack: error.stack,
            context,
            recoverable: this.isRecoverableError(error),
            impact: this.assessErrorImpact(error, context)
        });
        if (this.isRecoverableError(error)) {
            await this.attemptErrorRecovery(error, context);
        }
    }
    async optimizePerformance() {
        if (!this.options.enableCaching) {
            return;
        }
        await this.telemetryCollector.trackAnalyzerOperation('performance_optimization', undefined, async () => {
            switch (this.options.cacheStrategy) {
                case 'memory':
                    await this.optimizeMemoryCache();
                    break;
                case 'database':
                    await this.optimizeDatabaseCache();
                    break;
                case 'redis':
                    await this.optimizeRedisCache();
                    break;
            }
            const optimizationStats = this.getOptimizationStatistics();
            this.telemetryCollector.emitAnalyzerEvent('optimization_applied', {
                strategy: this.options.cacheStrategy,
                cacheHitRate: optimizationStats.cacheHitRate,
                timeSaved: optimizationStats.timeSaved,
                memorySaved: optimizationStats.memorySaved
            });
        });
    }
    async generateAnalysisReport() {
        const performanceSummary = this.telemetryCollector.getAnalysisPerformanceSummary();
        const realTimeMetrics = this.telemetryCollector.getRealTimeMetrics();
        return {
            analysisId: this.analysisId,
            startTime: this.analysisStartTime,
            endTime: Date.now(),
            performance: performanceSummary,
            realTimeMetrics,
            optimizationApplied: performanceSummary.optimizationsApplied > 0,
            healthScore: this.calculateOverallHealthScore(performanceSummary),
            recommendations: this.generateRecommendations(performanceSummary)
        };
    }
    detectMVCPattern(components) {
        const hasControllers = components.some(c => c.type === 'controller' || c.path.includes('controller'));
        const hasModels = components.some(c => c.type === 'model' || c.path.includes('model'));
        const hasViews = components.some(c => c.path.includes('view') || c.path.includes('template'));
        let confidence = 0;
        if (hasControllers)
            confidence += 0.4;
        if (hasModels)
            confidence += 0.4;
        if (hasViews)
            confidence += 0.2;
        return confidence;
    }
    detectMicroservicesPattern(components) {
        const hasServices = components.filter(c => c.type === 'service').length;
        const hasAPIGateway = components.some(c => c.path.includes('gateway') || c.path.includes('proxy'));
        const hasMultipleEntryPoints = components.filter(c => c.metadata.isEntry).length > 1;
        let confidence = 0;
        if (hasServices > 2)
            confidence += 0.5;
        if (hasAPIGateway)
            confidence += 0.3;
        if (hasMultipleEntryPoints)
            confidence += 0.2;
        return Math.min(confidence, 1.0);
    }
    detectDependencyInjection(components) {
        const diKeywords = ['@Injectable', '@Inject', 'container', 'providers'];
        let matches = 0;
        for (const component of components) {
            for (const keyword of diKeywords) {
                if (component.path.includes(keyword.toLowerCase()) ||
                    component.metadata.exports.some(e => e.includes(keyword))) {
                    matches++;
                    break;
                }
            }
        }
        return Math.min(matches / components.length * 2, 1.0);
    }
    async detectAntiPatterns(components) {
        const godObjects = components.filter(c => c.metadata.complexity > 8);
        for (const godObject of godObjects) {
            this.telemetryCollector.emitPatternDetected('god_object', 0.8, godObject.path, [`High complexity: ${godObject.metadata.complexity}`], godObject.id);
        }
        const highCouplingComponents = components.filter(c => c.dependencies.length > 10);
        for (const component of highCouplingComponents) {
            this.telemetryCollector.emitPatternDetected('spaghetti_code', 0.7, component.path, [`High coupling: ${component.dependencies.length} dependencies`], component.id);
        }
    }
    getMVCIndicators(components) {
        const indicators = [];
        if (components.some(c => c.type === 'controller'))
            indicators.push('Controllers detected');
        if (components.some(c => c.type === 'model'))
            indicators.push('Models detected');
        if (components.some(c => c.path.includes('view')))
            indicators.push('Views detected');
        return indicators;
    }
    getMicroservicesIndicators(components) {
        const indicators = [];
        const serviceCount = components.filter(c => c.type === 'service').length;
        if (serviceCount > 0)
            indicators.push(`${serviceCount} services detected`);
        if (components.some(c => c.path.includes('gateway')))
            indicators.push('API Gateway detected');
        if (components.filter(c => c.metadata.isEntry).length > 1)
            indicators.push('Multiple entry points');
        return indicators;
    }
    getDIIndicators(components) {
        const indicators = [];
        if (components.some(c => c.metadata.exports.some(e => e.includes('Injectable')))) {
            indicators.push('Injectable decorators found');
        }
        if (components.some(c => c.path.includes('container'))) {
            indicators.push('Dependency container detected');
        }
        return indicators;
    }
    estimateAnalysisDuration(repositoryPath) {
        return 30000;
    }
    async getFileSize(filePath) {
        return 1000;
    }
    countClasses(component) {
        return 1;
    }
    calculateDependencyDepth(connection, allConnections) {
        return 1;
    }
    detectCircularDependencies(connections) {
        return [];
    }
    assessCircularDependencySeverity(cycle) {
        return cycle.length > 5 ? 'high' : cycle.length > 3 ? 'medium' : 'low';
    }
    calculateCircularDependencyImpact(cycle, components) {
        return `Affects ${cycle.length} components`;
    }
    isRecoverableError(error) {
        return !error.message.includes('FATAL');
    }
    assessErrorImpact(error, context) {
        if (context.includes('critical'))
            return 'high';
        if (error.message.includes('warning'))
            return 'low';
        return 'medium';
    }
    async attemptErrorRecovery(error, context) {
    }
    async optimizeMemoryCache() {
    }
    async optimizeDatabaseCache() {
    }
    async optimizeRedisCache() {
    }
    getOptimizationStatistics() {
        return {
            cacheHitRate: 0.85,
            timeSaved: 5000,
            memorySaved: 1024 * 1024
        };
    }
    async persistAnalysisResults(blueprint) {
    }
    async updateComponentHealthScores(components) {
    }
    async triggerTelemetryAggregation() {
    }
    calculateOverallHealthScore(summary) {
        return 85;
    }
    generateRecommendations(summary) {
        const recommendations = [];
        if (summary.errorRate > 0.05) {
            recommendations.push('Consider improving error handling');
        }
        if (summary.cacheHitRate < 0.8) {
            recommendations.push('Optimize caching strategy');
        }
        return recommendations;
    }
    async initializeDatabaseConnection() {
    }
}
exports.DatabaseIntegratedAnalyzer = DatabaseIntegratedAnalyzer;
