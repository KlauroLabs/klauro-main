"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnhancedBaseAnalyzer = void 0;
const base_analyzer_1 = require("./base-analyzer");
const telemetry_schema_1 = require("../telemetry/telemetry-schema");
const entry_exit_detector_1 = require("./patterns/entry-exit-detector");
const dependency_mapper_1 = require("./patterns/dependency-mapper");
const framework_detector_1 = require("./patterns/framework-detector");
const ast_optimizer_1 = require("./ast/ast-optimizer");
class EnhancedBaseAnalyzer extends base_analyzer_1.BaseAnalyzer {
    constructor() {
        super();
        this.analysisStartTime = 0;
        this.enhancedOptions = {};
        this.entryExitDetector = new entry_exit_detector_1.EntryExitDetector();
        this.dependencyMapper = new dependency_mapper_1.DependencyMapper();
        this.frameworkDetector = new framework_detector_1.FrameworkDetector();
        this.astOptimizer = new ast_optimizer_1.ASTOptimizer();
    }
    async analyzeRepository(repositoryPath, options = {}) {
        this.projectPath = repositoryPath;
        this.enhancedOptions = { ...this.options, ...options };
        this.analysisStartTime = Date.now();
        if (options.enableTelemetry !== false) {
            telemetry_schema_1.telemetry.emit({
                type: 'analysis_started',
                source: { analyzer: this.getAnalyzerName() },
                data: {
                    repositoryPath,
                    language: 'detecting...',
                    framework: 'detecting...',
                    totalFiles: 0,
                    estimatedDuration: undefined,
                    options
                }
            });
        }
        console.log(`🔍 Starting enhanced ${this.getAnalyzerName()} analysis of: ${repositoryPath}`);
        try {
            const detection = await this.enhancedDetectLanguageAndFramework();
            if (detection.confidence < 0.5) {
                throw new Error(`${this.getAnalyzerName()} analyzer not suitable for this project`);
            }
            const discovery = await this.enhancedDiscoverComponents();
            console.log(`📁 Discovered ${discovery.totalFiles} files, analyzed ${discovery.analyzedFiles}, found ${discovery.components.length} components`);
            const connections = await this.enhancedAnalyzeConnections(discovery.components);
            console.log(`🔗 Found ${connections.length} connections`);
            const entryPoints = await this.enhancedIdentifyEntryPoints(discovery.components);
            const exitPoints = await this.enhancedIdentifyExitPoints(discovery.components);
            console.log(`🚪 Identified ${entryPoints.length} entry points and ${exitPoints.length} exit points`);
            const riskAreas = await this.enhancedAssessRisks(discovery.components, connections);
            this.callGraph = await this.enhancedGenerateCallGraph(discovery.components);
            console.log(`📊 Generated enhanced call graph with ${this.callGraph?.nodes.length || 0} nodes`);
            this.databaseConnections = await this.enhancedAnalyzeDatabaseConnections(discovery.components);
            console.log(`🗄️ Found ${this.databaseConnections.length} database connections`);
            this.testCoverage = await this.enhancedAnalyzeTestCoverage(discovery.components);
            console.log(`✅ Test coverage: ${this.testCoverage?.overall || 0}%`);
            const technologyStack = await this.enhancedAnalyzeTechnologyStack();
            const blueprint = {
                projectName: await this.getProjectName(),
                framework: detection.frameworks[0]?.name || detection.language,
                components: discovery.components,
                connections,
                entryPoints,
                exitPoints,
                orphanedComponents: this.identifyOrphanedComponents(discovery.components),
                riskAreas,
                metadata: await this.generateEnhancedProjectMetadata(discovery, detection),
                technologyStack,
                dependencies: await this.analyzeDependencies(),
                databaseInfo: await this.analyzeDatabaseInfo(),
                apiEndpoints: await this.analyzeAPIEndpoints(discovery.components),
                securityAnalysis: await this.analyzeSecurityInfo(),
                testingInfo: await this.analyzeTestingInfo(),
                deploymentInfo: await this.analyzeDeploymentInfo()
            };
            const duration = Date.now() - this.analysisStartTime;
            if (options.enableTelemetry !== false) {
                telemetry_schema_1.telemetry.emit({
                    type: 'analysis_completed',
                    source: { analyzer: this.getAnalyzerName() },
                    data: {
                        success: true,
                        componentsFound: blueprint.components.length,
                        connectionsFound: blueprint.connections.length,
                        entryPointsFound: blueprint.entryPoints.length,
                        exitPointsFound: blueprint.exitPoints.length,
                        orphanedComponents: blueprint.orphanedComponents.length,
                        riskAreas: blueprint.riskAreas.length,
                        duration,
                        errors: []
                    }
                });
            }
            console.log(`✅ Enhanced ${this.getAnalyzerName()} analysis complete: ${blueprint.components.length} components, ${blueprint.connections.length} connections`);
            return blueprint;
        }
        catch (error) {
            const duration = Date.now() - this.analysisStartTime;
            if (options.enableTelemetry !== false) {
                telemetry_schema_1.telemetry.emit({
                    type: 'analysis_completed',
                    source: { analyzer: this.getAnalyzerName() },
                    data: {
                        success: false,
                        componentsFound: 0,
                        connectionsFound: 0,
                        entryPointsFound: 0,
                        exitPointsFound: 0,
                        orphanedComponents: 0,
                        riskAreas: 0,
                        duration,
                        errors: [error instanceof Error ? error.message : String(error)]
                    }
                });
            }
            throw error;
        }
    }
    async enhancedDetectLanguageAndFramework() {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedDetectLanguageAndFramework');
        try {
            const baseDetection = await this.detectLanguageAndFramework();
            if (this.enhancedOptions.enablePatternDetection !== false) {
                const technologyStack = await this.frameworkDetector.detectFrameworks(this.projectPath);
                if (technologyStack.primaryFramework) {
                    baseDetection.frameworks.unshift({
                        name: technologyStack.primaryFramework.name,
                        version: technologyStack.primaryFramework.version,
                        confidence: technologyStack.primaryFramework.detectionConfidence || 0.9,
                        patterns: technologyStack.primaryFramework.patterns || [],
                        configFiles: technologyStack.primaryFramework.configFiles,
                        metadata: technologyStack.primaryFramework.metadata
                    });
                }
                for (const framework of technologyStack.additionalFrameworks) {
                    baseDetection.frameworks.push({
                        name: framework.name,
                        version: framework.version,
                        confidence: framework.detectionConfidence || 0.7,
                        patterns: framework.patterns || [],
                        configFiles: framework.configFiles,
                        metadata: framework.metadata
                    });
                }
            }
            span.end();
            return baseDetection;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async enhancedDiscoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedDiscoverComponents');
        try {
            const baseDiscovery = await this.discoverComponents();
            if (this.enhancedOptions.enableOptimization !== false) {
                const files = await this.findFiles(['**/*.{js,ts,jsx,tsx,py,java,cs,go,rs,php}'], this.enhancedOptions.excludePatterns || []);
                const parseResults = await this.astOptimizer.batchParseFiles(files.slice(0, 100), this.enhancedOptions.optimizationConfig || {});
                console.log(`🚀 Optimized parsing: ${parseResults.size} files processed with AST optimization`);
            }
            span.end();
            return baseDiscovery;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async enhancedAnalyzeConnections(components) {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedAnalyzeConnections');
        try {
            const baseConnections = await this.analyzeConnections(components);
            if (this.enhancedOptions.enablePatternDetection !== false) {
                const dependencyGraph = await this.dependencyMapper.mapDependencies(components, this.projectPath);
                console.log(`📊 Enhanced dependency analysis: ${dependencyGraph.nodes.size} nodes, ${dependencyGraph.cycles.length} cycles`);
                const enhancedConnections = this.convertDependencyGraphToConnections(dependencyGraph);
                const allConnections = this.mergeConnections(baseConnections, enhancedConnections);
                span.end();
                return allConnections;
            }
            span.end();
            return baseConnections;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async enhancedIdentifyEntryPoints(components) {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedIdentifyEntryPoints');
        try {
            const baseEntryPoints = await this.identifyEntryPoints(components);
            if (this.enhancedOptions.enablePatternDetection !== false) {
                const patternEntryPoints = await this.entryExitDetector.detectEntryPoints(components, this.projectPath);
                const allEntryPoints = this.mergeEntryPoints(baseEntryPoints, patternEntryPoints);
                span.end();
                return allEntryPoints;
            }
            span.end();
            return baseEntryPoints;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async enhancedIdentifyExitPoints(components) {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedIdentifyExitPoints');
        try {
            const baseExitPoints = await this.identifyExitPoints(components);
            if (this.enhancedOptions.enablePatternDetection !== false) {
                const patternExitPoints = await this.entryExitDetector.detectExitPoints(components, this.projectPath);
                const allExitPoints = this.mergeExitPoints(baseExitPoints, patternExitPoints);
                span.end();
                return allExitPoints;
            }
            span.end();
            return baseExitPoints;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async enhancedAssessRisks(components, connections) {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedAssessRisks');
        try {
            const baseRisks = await this.assessRisks(components, connections);
            const enhancedRisks = [...baseRisks];
            if (this.dependencyMapper) {
                const dependencyGraph = await this.dependencyMapper.mapDependencies(components, this.projectPath);
                for (const cycle of dependencyGraph.cycles) {
                    for (const nodeId of cycle) {
                        const existingRisk = enhancedRisks.find(r => r.componentId === nodeId);
                        if (existingRisk) {
                            existingRisk.reasons.push('Part of circular dependency');
                            if (existingRisk.riskLevel === 'low') {
                                existingRisk.riskLevel = 'medium';
                            }
                        }
                        else {
                            enhancedRisks.push({
                                componentId: nodeId,
                                riskLevel: 'medium',
                                reasons: ['Part of circular dependency'],
                                impact: `Circular dependency affects ${cycle.length} components`
                            });
                        }
                    }
                }
            }
            span.end();
            return enhancedRisks;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async enhancedGenerateCallGraph(components) {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedGenerateCallGraph');
        try {
            if (this.enhancedOptions.enablePatternDetection !== false) {
                const dependencyGraph = await this.dependencyMapper.mapDependencies(components, this.projectPath);
                const callGraph = this.dependencyMapper.generateCallGraph(components);
                span.end();
                return callGraph;
            }
            const baseCallGraph = await this.generateCallGraph(components);
            span.end();
            return baseCallGraph;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async enhancedAnalyzeDatabaseConnections(components) {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedAnalyzeDatabaseConnections');
        try {
            const baseConnections = await this.analyzeDatabaseConnections(components);
            span.end();
            return baseConnections;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async enhancedAnalyzeTestCoverage(components) {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedAnalyzeTestCoverage');
        try {
            const baseCoverage = await this.analyzeTestCoverage(components);
            span.end();
            return baseCoverage;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async enhancedAnalyzeTechnologyStack() {
        const span = telemetry_schema_1.telemetry.createSpan('enhancedAnalyzeTechnologyStack');
        try {
            if (this.enhancedOptions.enablePatternDetection !== false) {
                const technologyStack = await this.frameworkDetector.detectFrameworks(this.projectPath);
                span.end();
                return technologyStack;
            }
            const detection = await this.detectLanguageAndFramework();
            const baseTechStack = await this.analyzeTechnologyStack(detection);
            span.end();
            return baseTechStack;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async generateEnhancedProjectMetadata(discovery, detection) {
        const baseMetadata = await this.generateProjectMetadata(discovery, detection);
        return {
            ...baseMetadata,
            aiGeneratedSummary: this.generateAISummary(discovery, detection)
        };
    }
    generateAISummary(discovery, detection) {
        return `This is a ${detection.language} project with ${discovery.components.length} components. ` +
            `Primary framework: ${detection.frameworks[0]?.name || 'None detected'}. ` +
            `The codebase shows ${detection.confidence > 0.8 ? 'strong' : 'moderate'} adherence to ${detection.language} patterns.`;
    }
    generateTelemetryManifest() {
        return telemetry_schema_1.telemetry.generateManifest();
    }
    getOptimizationStatistics() {
        return this.astOptimizer.getOptimizationStatistics();
    }
    convertDependencyGraphToConnections(dependencyGraph) {
        const connections = [];
        for (const [nodeId, edges] of dependencyGraph.edges) {
            for (const edge of edges) {
                connections.push({
                    from: nodeId,
                    to: edge.to,
                    type: edge.type,
                    weight: edge.weight,
                    metadata: {
                        callSites: edge.metadata.usageCount,
                        dataFlow: edge.importPath
                    }
                });
            }
        }
        return connections;
    }
    mergeConnections(base, enhanced) {
        const connectionMap = new Map();
        for (const conn of base) {
            const key = `${conn.from}-${conn.to}-${conn.type}`;
            connectionMap.set(key, conn);
        }
        for (const conn of enhanced) {
            const key = `${conn.from}-${conn.to}-${conn.type}`;
            const existing = connectionMap.get(key);
            if (existing) {
                existing.weight = Math.max(existing.weight, conn.weight);
                existing.metadata = { ...existing.metadata, ...conn.metadata };
            }
            else {
                connectionMap.set(key, conn);
            }
        }
        return Array.from(connectionMap.values());
    }
    mergeEntryPoints(base, enhanced) {
        const entryMap = new Map();
        for (const entry of base) {
            entryMap.set(entry.path, entry);
        }
        for (const entry of enhanced) {
            const existing = entryMap.get(entry.path);
            if (existing) {
                existing.methods = [...(existing.methods || []), ...(entry.methods || [])];
                existing.middleware = [...(existing.middleware || []), ...(entry.middleware || [])];
            }
            else {
                entryMap.set(entry.path, entry);
            }
        }
        return Array.from(entryMap.values());
    }
    mergeExitPoints(base, enhanced) {
        const exitMap = new Map();
        for (const exit of base) {
            exitMap.set(`${exit.destination}-${exit.type}`, exit);
        }
        for (const exit of enhanced) {
            const key = `${exit.destination}-${exit.type}`;
            if (!exitMap.has(key)) {
                exitMap.set(key, exit);
            }
        }
        return Array.from(exitMap.values());
    }
}
exports.EnhancedBaseAnalyzer = EnhancedBaseAnalyzer;
