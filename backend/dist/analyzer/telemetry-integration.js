"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptimizationUtils = exports.PatternAnalysisUtils = exports.TelemetryAnalyzerFactory = exports.TelemetryIntegratedAnalyzer = void 0;
exports.demonstrateTelemetryIntegration = demonstrateTelemetryIntegration;
const enhanced_base_analyzer_1 = require("./enhanced-base-analyzer");
const system_topology_analyzer_1 = require("./system-topology-analyzer");
const telemetry_schema_1 = require("../telemetry/telemetry-schema");
const entry_exit_detector_1 = require("./patterns/entry-exit-detector");
const dependency_mapper_1 = require("./patterns/dependency-mapper");
const framework_detector_1 = require("./patterns/framework-detector");
const ast_optimizer_1 = require("./ast/ast-optimizer");
class TelemetryIntegratedAnalyzer extends enhanced_base_analyzer_1.EnhancedBaseAnalyzer {
    constructor() {
        super();
        this.systemTopologyAnalyzer = new system_topology_analyzer_1.SystemTopologyAnalyzer();
    }
    getAnalyzerName() {
        return 'Telemetry Integrated System Analyzer';
    }
    getSupportedLanguages() {
        return ['typescript', 'javascript', 'python', 'java', 'csharp', 'go', 'rust', 'php'];
    }
    getSupportedFrameworks() {
        return ['any'];
    }
    async detectLanguageAndFramework() {
        return await telemetry_schema_1.telemetry.measureAsync('detectLanguageAndFramework', async () => {
            return await this.systemTopologyAnalyzer['detectLanguageAndFramework'].call(this.systemTopologyAnalyzer);
        });
    }
    async discoverComponents() {
        return await telemetry_schema_1.telemetry.measureAsync('discoverComponents', async () => {
            return await this.systemTopologyAnalyzer['discoverComponents'].call(this.systemTopologyAnalyzer);
        });
    }
    async analyzeConnections(components) {
        return await telemetry_schema_1.telemetry.measureAsync('analyzeConnections', async () => {
            return await this.systemTopologyAnalyzer['analyzeConnections'].call(this.systemTopologyAnalyzer, components);
        });
    }
    async identifyEntryPoints(components) {
        return await telemetry_schema_1.telemetry.measureAsync('identifyEntryPoints', async () => {
            return await this.systemTopologyAnalyzer['identifyEntryPoints'].call(this.systemTopologyAnalyzer, components);
        });
    }
    async identifyExitPoints(components) {
        return await telemetry_schema_1.telemetry.measureAsync('identifyExitPoints', async () => {
            return await this.systemTopologyAnalyzer['identifyExitPoints'].call(this.systemTopologyAnalyzer, components);
        });
    }
    async assessRisks(components, connections) {
        return await telemetry_schema_1.telemetry.measureAsync('assessRisks', async () => {
            return await this.systemTopologyAnalyzer['assessRisks'].call(this.systemTopologyAnalyzer, components, connections);
        });
    }
    async generateCallGraph(components) {
        return await telemetry_schema_1.telemetry.measureAsync('generateCallGraph', async () => {
            return await this.systemTopologyAnalyzer['generateCallGraph'].call(this.systemTopologyAnalyzer, components);
        });
    }
    async analyzeDatabaseConnections(components) {
        return await telemetry_schema_1.telemetry.measureAsync('analyzeDatabaseConnections', async () => {
            return await this.systemTopologyAnalyzer['analyzeDatabaseConnections'].call(this.systemTopologyAnalyzer, components);
        });
    }
    async analyzeTestCoverage(components) {
        return await telemetry_schema_1.telemetry.measureAsync('analyzeTestCoverage', async () => {
            return await this.systemTopologyAnalyzer['analyzeTestCoverage'].call(this.systemTopologyAnalyzer, components);
        });
    }
}
exports.TelemetryIntegratedAnalyzer = TelemetryIntegratedAnalyzer;
class TelemetryAnalyzerFactory {
    static createAnalyzer(type = 'enhanced', telemetryConfig) {
        if (telemetryConfig) {
        }
        switch (type) {
            case 'system-topology':
                return new TelemetryIntegratedAnalyzer();
            case 'enhanced':
            default:
                return new TelemetryIntegratedAnalyzer();
        }
    }
    static async analyzeWithTelemetry(repositoryPath, options = {}) {
        const analyzer = this.createAnalyzer('enhanced');
        const enhancedOptions = {
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
        const blueprint = await analyzer.analyzeRepository(repositoryPath, enhancedOptions);
        const telemetryManifest = analyzer.generateTelemetryManifest();
        const optimizationStats = analyzer.getOptimizationStatistics();
        return {
            blueprint,
            telemetryManifest,
            optimizationStats,
            metrics: telemetry_schema_1.telemetry.getMetrics()
        };
    }
}
exports.TelemetryAnalyzerFactory = TelemetryAnalyzerFactory;
class PatternAnalysisUtils {
    static async analyzeEntryExitPatterns(repositoryPath, components) {
        const detector = new entry_exit_detector_1.EntryExitDetector();
        const entryPoints = await detector.detectEntryPoints(components, repositoryPath);
        const exitPoints = await detector.detectExitPoints(components, repositoryPath);
        const statistics = detector.getStatistics();
        return {
            entryPoints,
            exitPoints,
            statistics
        };
    }
    static async analyzeDependencyPatterns(repositoryPath, components) {
        const mapper = new dependency_mapper_1.DependencyMapper();
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
    static async analyzeFrameworkPatterns(repositoryPath) {
        const detector = new framework_detector_1.FrameworkDetector();
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
exports.PatternAnalysisUtils = PatternAnalysisUtils;
class OptimizationUtils {
    static async optimizeASTAnalysis(files, options = {}) {
        const optimizer = new ast_optimizer_1.ASTOptimizer();
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
    static createOptimizedTraversalOptions(fileCount, complexityLevel = 'medium') {
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
exports.OptimizationUtils = OptimizationUtils;
async function demonstrateTelemetryIntegration(repositoryPath) {
    console.log('🚀 Starting Telemetry Integration Demonstration');
    console.log(`📁 Analyzing repository: ${repositoryPath}`);
    try {
        console.log('\n1️⃣ Running full analysis with telemetry...');
        const analysisResult = await TelemetryAnalyzerFactory.analyzeWithTelemetry(repositoryPath);
        console.log(`✅ Analysis complete:`);
        console.log(`   - Components found: ${analysisResult.blueprint.components.length}`);
        console.log(`   - Connections found: ${analysisResult.blueprint.connections.length}`);
        console.log(`   - Entry points: ${analysisResult.blueprint.entryPoints.length}`);
        console.log(`   - Exit points: ${analysisResult.blueprint.exitPoints.length}`);
        console.log(`   - Risk areas: ${analysisResult.blueprint.riskAreas.length}`);
        console.log('\n2️⃣ Running pattern analysis...');
        const patternResults = await PatternAnalysisUtils.analyzeEntryExitPatterns(repositoryPath, analysisResult.blueprint.components);
        console.log(`✅ Pattern analysis complete:`);
        console.log(`   - Entry patterns: ${patternResults.statistics.totalEntry}`);
        console.log(`   - Exit patterns: ${patternResults.statistics.totalExit}`);
        console.log('\n3️⃣ Running dependency analysis...');
        const dependencyResults = await PatternAnalysisUtils.analyzeDependencyPatterns(repositoryPath, analysisResult.blueprint.components);
        console.log(`✅ Dependency analysis complete:`);
        console.log(`   - Nodes in dependency graph: ${dependencyResults.dependencyGraph.nodes.size}`);
        console.log(`   - Circular dependencies: ${dependencyResults.cycles.length}`);
        console.log(`   - Critical paths: ${dependencyResults.criticalPaths.length}`);
        console.log(`   - Clusters found: ${dependencyResults.clusters.length}`);
        console.log('\n4️⃣ Running framework detection...');
        const frameworkResults = await PatternAnalysisUtils.analyzeFrameworkPatterns(repositoryPath);
        console.log(`✅ Framework detection complete:`);
        console.log(`   - Primary framework: ${frameworkResults.primaryFramework?.name || 'None'}`);
        console.log(`   - Additional frameworks: ${frameworkResults.additionalFrameworks.length}`);
        console.log(`   - Languages detected: ${frameworkResults.languages.length}`);
        console.log('\n5️⃣ Telemetry metrics:');
        console.log(`   - Events collected: ${analysisResult.metrics.eventsCollected}`);
        console.log(`   - Cache hit rate: ${analysisResult.optimizationStats.cacheHitRate * 100}%`);
        console.log(`   - Average parsing time: ${analysisResult.optimizationStats.averageParsingTime.toFixed(2)}ms`);
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
    }
    catch (error) {
        console.error('❌ Analysis failed:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
