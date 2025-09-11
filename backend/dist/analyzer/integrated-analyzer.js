"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalyzerFactory = exports.IntegratedAnalyzer = void 0;
exports.analyzeRepository = analyzeRepository;
const enhanced_integration_1 = require("./enhanced-integration");
class IntegratedAnalyzer extends enhanced_integration_1.DatabaseIntegratedAnalyzer {
    constructor(options = {}) {
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
                    maxMemoryUsage: 512 * 1024 * 1024,
                    errorRateThreshold: 0.05
                }
            },
            ...options
        });
    }
    static getInstance(options) {
        if (!IntegratedAnalyzer.instance) {
            IntegratedAnalyzer.instance = new IntegratedAnalyzer(options);
        }
        return IntegratedAnalyzer.instance;
    }
    getAnalyzerName() {
        return 'Unravl Integrated Production Analyzer v1.0';
    }
    async performCompleteAnalysis(repositoryPath, options = {}) {
        console.log(`🚀 Starting integrated analysis of ${repositoryPath}`);
        try {
            console.log('📊 Phase 1: Performing core architecture analysis...');
            const blueprint = await this.analyzeRepository(repositoryPath, options);
            console.log('🔍 Phase 2: Running enhanced pattern detection...');
            await this.runEnhancedPatternDetection(blueprint.components);
            console.log('⚡ Phase 3: Analyzing performance characteristics...');
            const performanceReport = await this.generatePerformanceReport();
            console.log('💡 Phase 4: Generating optimization suggestions...');
            const optimizationSuggestions = await this.generateOptimizationSuggestions(blueprint);
            console.log('🏥 Phase 5: Calculating system health score...');
            const healthScore = await this.calculateSystemHealthScore(blueprint, performanceReport);
            console.log('📈 Phase 6: Generating telemetry manifest...');
            const telemetryManifest = await this.generateTelemetryManifest();
            console.log('📊 Phase 7: Collecting real-time metrics...');
            const realTimeMetrics = this.telemetryCollector.getRealTimeMetrics();
            const result = {
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
        }
        catch (error) {
            console.error('❌ Analysis failed:', error);
            await this.handleAnalysisError(error, 'complete_analysis');
            throw error;
        }
    }
    async runEnhancedPatternDetection(components) {
        await this.detectAdvancedArchitecturalPatterns(components);
        await this.detectDesignPatterns(components);
        await this.detectCodeSmells(components);
        await this.detectSecurityPatterns(components);
        await this.detectPerformancePatterns(components);
    }
    async detectAdvancedArchitecturalPatterns(components) {
        const layerScore = this.analyzeLayeredArchitecture(components);
        if (layerScore > 0.6) {
            this.telemetryCollector.emitPatternDetected('layered_architecture', layerScore, 'system_architecture', this.getLayeredArchitectureIndicators(components));
        }
        const eventScore = this.analyzeEventDrivenArchitecture(components);
        if (eventScore > 0.5) {
            this.telemetryCollector.emitPatternDetected('event_driven_architecture', eventScore, 'system_architecture', this.getEventDrivenIndicators(components));
        }
        const cqrsScore = this.analyzeCQRSPattern(components);
        if (cqrsScore > 0.7) {
            this.telemetryCollector.emitPatternDetected('cqrs', cqrsScore, 'system_architecture', this.getCQRSIndicators(components));
        }
    }
    async detectDesignPatterns(components) {
        for (const component of components) {
            const singletonScore = this.analyzeSingletonPattern(component);
            if (singletonScore > 0.8) {
                this.telemetryCollector.emitPatternDetected('singleton', singletonScore, component.path, ['Static instance', 'Private constructor'], component.id);
            }
        }
        const factoryComponents = this.detectFactoryPattern(components);
        for (const component of factoryComponents) {
            this.telemetryCollector.emitPatternDetected('factory', 0.9, component.path, ['Creates objects', 'Abstract creation'], component.id);
        }
        const observerComponents = this.detectObserverPattern(components);
        for (const component of observerComponents) {
            this.telemetryCollector.emitPatternDetected('observer', 0.85, component.path, ['Event listeners', 'Notification system'], component.id);
        }
    }
    async detectCodeSmells(components) {
        for (const component of components) {
            if (component.metadata.functions) {
                const longMethods = component.metadata.functions.filter(f => f.lineCount > 50);
                if (longMethods.length > 0) {
                    this.telemetryCollector.emitPatternDetected('long_method', 0.8, component.path, [`${longMethods.length} methods exceed 50 lines`], component.id);
                }
            }
            if (component.metadata.lineCount > 500) {
                this.telemetryCollector.emitPatternDetected('large_class', 0.9, component.path, [`${component.metadata.lineCount} lines of code`], component.id);
            }
            if (component.dependencies.length > 15) {
                this.telemetryCollector.emitPatternDetected('feature_envy', 0.7, component.path, [`${component.dependencies.length} dependencies`], component.id);
            }
        }
    }
    async detectSecurityPatterns(components) {
        for (const component of components) {
            const hasValidation = this.hasInputValidation(component);
            if (hasValidation) {
                this.telemetryCollector.emitPatternDetected('input_validation', 0.8, component.path, ['Validation patterns found'], component.id);
            }
            const hasAuth = this.hasAuthenticationChecks(component);
            if (hasAuth) {
                this.telemetryCollector.emitPatternDetected('authentication_pattern', 0.9, component.path, ['Authentication mechanisms'], component.id);
            }
            const sqlInjectionRisk = this.checkSQLInjectionRisk(component);
            if (sqlInjectionRisk > 0.6) {
                this.telemetryCollector.emitPatternDetected('sql_injection_risk', sqlInjectionRisk, component.path, ['Dynamic SQL construction'], component.id);
            }
        }
    }
    async detectPerformancePatterns(components) {
        const nPlusOneComponents = this.detectNPlusOneQueries(components);
        for (const component of nPlusOneComponents) {
            this.telemetryCollector.emitPatternDetected('n_plus_one_queries', 0.8, component.path, ['Loop with database queries'], component.id);
        }
        const cachingComponents = this.detectCachingPatterns(components);
        for (const component of cachingComponents) {
            this.telemetryCollector.emitPatternDetected('caching_pattern', 0.75, component.path, ['Caching implementation'], component.id);
        }
    }
    async generateOptimizationSuggestions(blueprint) {
        const suggestions = [];
        if (blueprint.components.length > 100) {
            suggestions.push('Consider implementing lazy loading for large component sets');
        }
        const highCouplingComponents = blueprint.components.filter(c => c.dependencies.length > 10);
        if (highCouplingComponents.length > 0) {
            suggestions.push(`Reduce coupling for ${highCouplingComponents.length} highly coupled components`);
        }
        const riskyComponents = blueprint.riskAreas.filter(r => r.riskLevel === 'high');
        if (riskyComponents.length > 0) {
            suggestions.push(`Address ${riskyComponents.length} high-risk security areas`);
        }
        if (blueprint.testingInfo.coverage.overall < 80) {
            suggestions.push(`Improve test coverage from ${blueprint.testingInfo.coverage.overall}% to 80%+`);
        }
        const unusedDeps = blueprint.dependencies.unused.length;
        if (unusedDeps > 0) {
            suggestions.push(`Remove ${unusedDeps} unused dependencies`);
        }
        return suggestions;
    }
    async calculateSystemHealthScore(blueprint, performanceReport) {
        let score = 100;
        score -= blueprint.riskAreas.filter(r => r.riskLevel === 'high').length * 10;
        score -= blueprint.riskAreas.filter(r => r.riskLevel === 'medium').length * 5;
        if (blueprint.testingInfo.coverage.overall < 50) {
            score -= 20;
        }
        else if (blueprint.testingInfo.coverage.overall < 80) {
            score -= 10;
        }
        const avgComplexity = blueprint.metadata.complexityAverage;
        if (avgComplexity > 7) {
            score -= 15;
        }
        else if (avgComplexity > 5) {
            score -= 10;
        }
        score -= blueprint.dependencies.vulnerabilities.filter(v => v.severity === 'critical').length * 15;
        score -= blueprint.dependencies.vulnerabilities.filter(v => v.severity === 'high').length * 10;
        if (performanceReport.errorRate > 0.05) {
            score -= 15;
        }
        if (blueprint.testingInfo.coverage.overall > 90) {
            score += 5;
        }
        if (blueprint.dependencies.vulnerabilities.length === 0) {
            score += 5;
        }
        return Math.max(0, Math.min(100, score));
    }
    analyzeLayeredArchitecture(components) {
        const layers = ['presentation', 'business', 'data', 'infrastructure'];
        const foundLayers = layers.filter(layer => components.some(c => c.metadata.layer === layer));
        return foundLayers.length / layers.length;
    }
    analyzeEventDrivenArchitecture(components) {
        const eventKeywords = ['event', 'listener', 'handler', 'emitter', 'subscriber'];
        const eventComponents = components.filter(c => eventKeywords.some(keyword => c.path.toLowerCase().includes(keyword) ||
            c.name.toLowerCase().includes(keyword)));
        return Math.min(eventComponents.length / (components.length * 0.1), 1.0);
    }
    analyzeCQRSPattern(components) {
        const hasCommands = components.some(c => c.path.includes('command') || c.name.includes('Command'));
        const hasQueries = components.some(c => c.path.includes('query') || c.name.includes('Query'));
        const hasHandlers = components.some(c => c.path.includes('handler') || c.name.includes('Handler'));
        let score = 0;
        if (hasCommands)
            score += 0.4;
        if (hasQueries)
            score += 0.4;
        if (hasHandlers)
            score += 0.2;
        return score;
    }
    analyzeSingletonPattern(component) {
        const singletonIndicators = ['instance', 'getInstance', 'singleton'];
        const matches = singletonIndicators.filter(indicator => component.metadata.exports.some(exp => exp.toLowerCase().includes(indicator)));
        return matches.length / singletonIndicators.length;
    }
    detectFactoryPattern(components) {
        return components.filter(c => c.name.toLowerCase().includes('factory') ||
            c.path.toLowerCase().includes('factory') ||
            c.metadata.exports.some(exp => exp.toLowerCase().includes('create')));
    }
    detectObserverPattern(components) {
        const observerKeywords = ['observer', 'listener', 'subscriber', 'watcher'];
        return components.filter(c => observerKeywords.some(keyword => c.name.toLowerCase().includes(keyword) ||
            c.path.toLowerCase().includes(keyword)));
    }
    hasInputValidation(component) {
        const validationKeywords = ['validate', 'sanitize', 'check', 'verify'];
        return validationKeywords.some(keyword => component.metadata.exports.some(exp => exp.toLowerCase().includes(keyword)) ||
            component.metadata.imports.some(imp => imp.toLowerCase().includes(keyword)));
    }
    hasAuthenticationChecks(component) {
        const authKeywords = ['auth', 'login', 'token', 'jwt', 'passport'];
        return authKeywords.some(keyword => component.path.toLowerCase().includes(keyword) ||
            component.metadata.imports.some(imp => imp.toLowerCase().includes(keyword)));
    }
    checkSQLInjectionRisk(component) {
        const riskIndicators = ['query', 'execute', 'raw'];
        const matches = riskIndicators.filter(indicator => component.metadata.exports.some(exp => exp.toLowerCase().includes(indicator)));
        return matches.length / riskIndicators.length;
    }
    detectNPlusOneQueries(components) {
        return components.filter(c => c.path.toLowerCase().includes('repository') ||
            c.path.toLowerCase().includes('service')).filter(c => c.metadata.complexity > 5);
    }
    detectCachingPatterns(components) {
        const cacheKeywords = ['cache', 'memoize', 'redis', 'memcached'];
        return components.filter(c => cacheKeywords.some(keyword => c.path.toLowerCase().includes(keyword) ||
            c.metadata.imports.some(imp => imp.toLowerCase().includes(keyword))));
    }
    getLayeredArchitectureIndicators(components) {
        const indicators = [];
        const layers = ['presentation', 'business', 'data', 'infrastructure'];
        for (const layer of layers) {
            const count = components.filter(c => c.metadata.layer === layer).length;
            if (count > 0) {
                indicators.push(`${layer} layer: ${count} components`);
            }
        }
        return indicators;
    }
    getEventDrivenIndicators(components) {
        const eventComponents = components.filter(c => c.path.toLowerCase().includes('event') ||
            c.name.toLowerCase().includes('event'));
        return [
            `${eventComponents.length} event-related components`,
            'Event-driven communication patterns'
        ];
    }
    getCQRSIndicators(components) {
        const indicators = [];
        const commands = components.filter(c => c.path.includes('command')).length;
        const queries = components.filter(c => c.path.includes('query')).length;
        const handlers = components.filter(c => c.path.includes('handler')).length;
        if (commands > 0)
            indicators.push(`${commands} command handlers`);
        if (queries > 0)
            indicators.push(`${queries} query handlers`);
        if (handlers > 0)
            indicators.push(`${handlers} generic handlers`);
        return indicators;
    }
}
exports.IntegratedAnalyzer = IntegratedAnalyzer;
class AnalyzerFactory {
    static createProductionAnalyzer(options = {}) {
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
    static async analyzeProject(repositoryPath, options = {}) {
        const analyzer = this.createProductionAnalyzer(options);
        return await analyzer.performCompleteAnalysis(repositoryPath, options);
    }
}
exports.AnalyzerFactory = AnalyzerFactory;
async function analyzeRepository(repositoryPath, options = {}) {
    return await AnalyzerFactory.analyzeProject(repositoryPath, options);
}
