"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManifestGenerator = void 0;
const errors_1 = require("./errors");
const telemetry_schema_1 = require("../telemetry/telemetry-schema");
const project_repository_1 = require("../database/repositories/project-repository");
const analysis_repository_1 = require("../database/repositories/analysis-repository");
const component_repository_1 = require("../database/repositories/component-repository");
const fs = __importStar(require("fs-extra"));
const path = __importStar(require("path"));
class ManifestGenerator {
    constructor(schema, organizationId, projectId) {
        this.schema = {
            version: '1.0.0',
            format: 'json',
            compression: 'none',
            includeMetadata: true,
            includeVisualization: true,
            includeTelemetry: false
        };
        if (schema) {
            this.schema = { ...this.schema, ...schema };
        }
        this.organizationId = organizationId;
        this.projectId = projectId;
    }
    async generateManifest(blueprint, analysisId, analyzer, duration) {
        const span = telemetry_schema_1.telemetry.createSpan('manifest.generate', {
            analysisId,
            analyzer,
            organizationId: this.organizationId,
            projectId: this.projectId
        });
        try {
            telemetry_schema_1.telemetry.emit({
                type: 'manifest_generation_started',
                source: {
                    analyzer: 'manifest-generator',
                    analysisId
                },
                data: {
                    schema: this.schema,
                    projectId: this.projectId,
                    organizationId: this.organizationId
                }
            });
            const manifest = {
                version: this.schema.version,
                generated: new Date(),
                generator: 'Unravl Analyzer Platform',
                project: await this.createProjectInfo(blueprint),
                architecture: this.createArchitectureSection(blueprint),
                flows: this.createFlowSection(blueprint),
                instrumentation: this.createInstrumentationSection(blueprint),
                visualization: this.createVisualizationSection(blueprint),
                metadata: this.createMetadata(blueprint, analysisId, analyzer, duration)
            };
            if (this.schema.includeTelemetry) {
                manifest.telemetry = this.createTelemetrySection(blueprint);
            }
            this.validateManifest(manifest);
            if (this.organizationId && this.projectId) {
                await this.persistAnalysisResults(blueprint, analysisId, analyzer, duration);
            }
            telemetry_schema_1.telemetry.emit({
                type: 'manifest_generation_completed',
                source: {
                    analyzer: 'manifest-generator',
                    analysisId
                },
                data: {
                    componentCount: blueprint.components.length,
                    connectionCount: blueprint.connections.length,
                    entryPointCount: blueprint.entryPoints.length,
                    exitPointCount: blueprint.exitPoints.length
                }
            });
            span.end();
            return manifest;
        }
        catch (error) {
            telemetry_schema_1.telemetry.emit({
                type: 'error_occurred',
                source: {
                    analyzer: 'manifest-generator',
                    analysisId
                },
                data: {
                    error: error instanceof Error ? error.message : String(error)
                }
            });
            span.end();
            throw error;
        }
    }
    async createProjectInfo(blueprint) {
        let projectInfo = {
            name: blueprint.projectName,
            path: blueprint.metadata.repositoryPath,
            framework: blueprint.framework,
            language: blueprint.metadata.primaryLanguage,
            version: blueprint.metadata.frameworkVersion,
            description: blueprint.metadata.aiGeneratedSummary,
            tags: this.generateProjectTags(blueprint)
        };
        if (this.organizationId && this.projectId) {
            try {
                const dbProject = await project_repository_1.projectRepository.findWithStats(this.projectId, this.organizationId);
                if (dbProject) {
                    projectInfo = {
                        ...projectInfo,
                        name: dbProject.name,
                        description: dbProject.description || projectInfo.description,
                        repository: dbProject.repository_url,
                        team: dbProject.team_id,
                        tags: [...(projectInfo.tags || []), dbProject.status]
                    };
                }
            }
            catch (error) {
                console.warn('Failed to enhance project info from database:', error.message);
            }
        }
        return projectInfo;
    }
    generateProjectTags(blueprint) {
        const tags = [];
        tags.push(blueprint.framework.toLowerCase());
        tags.push(blueprint.metadata.primaryLanguage.toLowerCase());
        if (blueprint.apiEndpoints.length > 0)
            tags.push('api');
        if (blueprint.databaseInfo)
            tags.push('database');
        if (blueprint.testingInfo.frameworks.length > 0)
            tags.push('tested');
        if (blueprint.components.length < 20)
            tags.push('small');
        else if (blueprint.components.length < 100)
            tags.push('medium');
        else
            tags.push('large');
        return tags;
    }
    createArchitectureSection(blueprint) {
        return {
            blueprint,
            layers: this.identifyLayers(blueprint),
            patterns: this.identifyPatterns(blueprint),
            zones: this.identifyZones(blueprint),
            boundaries: this.identifyBoundaries(blueprint)
        };
    }
    identifyLayers(blueprint) {
        const layers = [];
        const layerMap = new Map();
        blueprint.components.forEach(component => {
            const layer = component.metadata.layer || 'business';
            if (!layerMap.has(layer)) {
                layerMap.set(layer, []);
            }
            layerMap.get(layer).push(component.id);
        });
        const layerOrder = {
            'presentation': 0,
            'business': 1,
            'data': 2,
            'infrastructure': 3,
            'external': 4
        };
        let index = 0;
        for (const [name, components] of layerMap) {
            layers.push({
                id: `layer_${index++}`,
                name,
                type: name,
                components,
                responsibilities: this.getLayerResponsibilities(name),
                order: layerOrder[name] || 99
            });
        }
        return layers.sort((a, b) => a.order - b.order);
    }
    getLayerResponsibilities(layer) {
        const responsibilities = {
            'presentation': ['User interface', 'Request handling', 'Response formatting'],
            'business': ['Business logic', 'Workflow orchestration', 'Rule enforcement'],
            'data': ['Data persistence', 'Query optimization', 'Transaction management'],
            'infrastructure': ['Cross-cutting concerns', 'Security', 'Configuration'],
            'external': ['Third-party integration', 'External APIs', 'Messaging']
        };
        return responsibilities[layer] || ['General processing'];
    }
    identifyPatterns(blueprint) {
        const patterns = [];
        const hasControllers = blueprint.components.some(c => c.type === 'controller');
        const hasModels = blueprint.components.some(c => c.type === 'model');
        if (hasControllers && hasModels) {
            patterns.push({
                name: 'MVC',
                type: 'architectural',
                components: blueprint.components
                    .filter(c => ['controller', 'model', 'route'].includes(c.type))
                    .map(c => c.id),
                confidence: 0.9,
                description: 'Model-View-Controller architecture pattern'
            });
        }
        const serviceCount = blueprint.components.filter(c => c.type === 'service').length;
        if (serviceCount > 5 && blueprint.apiEndpoints.length > 10) {
            patterns.push({
                name: 'Microservices',
                type: 'architectural',
                components: blueprint.components
                    .filter(c => c.type === 'service')
                    .map(c => c.id),
                confidence: 0.7,
                description: 'Microservices architecture with multiple services'
            });
        }
        return patterns;
    }
    identifyZones(blueprint) {
        const zones = [];
        const authComponents = blueprint.components.filter(c => c.path.includes('auth') || c.path.includes('security'));
        if (authComponents.length > 0) {
            zones.push({
                id: 'security_zone',
                name: 'Security Zone',
                type: 'security',
                components: authComponents.map(c => c.id),
                rules: [{
                        type: 'authentication',
                        description: 'All requests must be authenticated',
                        enforcement: 'strict'
                    }]
            });
        }
        return zones;
    }
    identifyBoundaries(blueprint) {
        const boundaries = [];
        const moduleMap = new Map();
        blueprint.components.forEach(component => {
            const modulePath = path.dirname(component.path).split('/')[0];
            if (!moduleMap.has(modulePath)) {
                moduleMap.set(modulePath, []);
            }
            moduleMap.get(modulePath).push(component);
        });
        let index = 0;
        for (const [moduleName, components] of moduleMap) {
            if (components.length > 2) {
                boundaries.push({
                    id: `boundary_${index++}`,
                    name: moduleName,
                    type: 'module',
                    components: components.map(c => c.id),
                    interfaces: this.identifyInterfaces(components, blueprint),
                    dependencies: []
                });
            }
        }
        return boundaries;
    }
    identifyInterfaces(components, blueprint) {
        const interfaces = [];
        const componentIds = new Set(components.map(c => c.id));
        const relevantEndpoints = blueprint.apiEndpoints.filter(ep => componentIds.has(ep.componentId));
        if (relevantEndpoints.length > 0) {
            interfaces.push({
                id: `interface_rest`,
                type: 'rest',
                endpoints: relevantEndpoints.map(ep => ep.id)
            });
        }
        return interfaces;
    }
    createFlowSection(blueprint) {
        return {
            dataFlows: this.identifyDataFlows(blueprint),
            controlFlows: this.identifyControlFlows(blueprint),
            eventFlows: this.identifyEventFlows(blueprint),
            userJourneys: this.identifyUserJourneys(blueprint),
            criticalPaths: this.identifyCriticalPaths(blueprint)
        };
    }
    identifyDataFlows(blueprint) {
        const flows = [];
        blueprint.connections.forEach((connection, index) => {
            if (connection.type === 'database' || connection.type === 'data_flow') {
                flows.push({
                    id: `data_flow_${index}`,
                    name: `Data flow ${index}`,
                    source: connection.from,
                    destination: connection.to,
                    dataType: 'unknown',
                    volume: connection.weight > 3 ? 'high' : connection.weight > 1 ? 'medium' : 'low',
                    sensitivity: 'internal',
                    transformations: []
                });
            }
        });
        return flows;
    }
    identifyControlFlows(blueprint) {
        return [];
    }
    identifyEventFlows(blueprint) {
        return [];
    }
    identifyUserJourneys(blueprint) {
        const journeys = [];
        blueprint.entryPoints.slice(0, 5).forEach((entryPoint, index) => {
            journeys.push({
                id: `journey_${index}`,
                name: `User Journey ${index + 1}`,
                persona: 'User',
                steps: [{
                        component: entryPoint.componentId,
                        action: entryPoint.path
                    }],
                entryPoint: entryPoint.id,
                exitPoints: []
            });
        });
        return journeys;
    }
    identifyCriticalPaths(blueprint) {
        const paths = [];
        blueprint.riskAreas
            .filter(risk => risk.riskLevel === 'high')
            .forEach((risk, index) => {
            const component = blueprint.components.find(c => c.id === risk.componentId);
            if (component) {
                paths.push({
                    id: `critical_path_${index}`,
                    name: `Critical Path: ${component.name}`,
                    components: [component.id, ...component.dependencies],
                    importance: 'critical'
                });
            }
        });
        return paths;
    }
    createInstrumentationSection(blueprint) {
        return {
            points: this.createInstrumentationPoints(blueprint),
            metrics: this.createMetricDefinitions(blueprint),
            traces: this.createTraceDefinitions(blueprint),
            logs: this.createLogDefinitions(blueprint),
            health: this.createHealthCheckDefinitions(blueprint)
        };
    }
    createInstrumentationPoints(blueprint) {
        const points = [];
        blueprint.entryPoints.forEach(entry => {
            points.push({
                id: `instrument_${entry.id}`,
                componentId: entry.componentId,
                type: 'entry',
                path: entry.path,
                telemetry: {
                    metrics: true,
                    traces: true,
                    logs: true,
                    sampling: 1.0
                }
            });
        });
        blueprint.exitPoints.forEach(exit => {
            points.push({
                id: `instrument_${exit.id}`,
                componentId: exit.componentId,
                type: 'exit',
                telemetry: {
                    metrics: true,
                    traces: true,
                    logs: exit.critical,
                    sampling: exit.critical ? 1.0 : 0.1
                }
            });
        });
        return points;
    }
    createMetricDefinitions(blueprint) {
        return [
            {
                name: 'request_count',
                type: 'counter',
                unit: 'requests',
                description: 'Total number of requests',
                components: blueprint.entryPoints.map(ep => ep.componentId),
                alerts: [{
                        condition: 'rate > threshold',
                        threshold: 1000,
                        duration: 60,
                        severity: 'warning',
                        action: 'notify'
                    }]
            },
            {
                name: 'response_time',
                type: 'histogram',
                unit: 'milliseconds',
                description: 'Response time distribution',
                components: blueprint.components.map(c => c.id),
                aggregation: 'p95'
            },
            {
                name: 'error_rate',
                type: 'gauge',
                unit: 'percentage',
                description: 'Error rate',
                components: blueprint.components.map(c => c.id),
                alerts: [{
                        condition: 'value > threshold',
                        threshold: 5,
                        severity: 'critical',
                        action: 'page'
                    }]
            }
        ];
    }
    createTraceDefinitions(blueprint) {
        const traces = [];
        blueprint.entryPoints.forEach(entry => {
            traces.push({
                name: `trace_${entry.id}`,
                startPoint: entry.componentId,
                endPoints: blueprint.exitPoints.map(exit => exit.componentId),
                includeAsync: true,
                includeDatabase: true,
                includeHttp: true
            });
        });
        return traces;
    }
    createLogDefinitions(blueprint) {
        return [
            {
                level: 'error',
                components: blueprint.components.map(c => c.id),
                format: 'json',
                fields: ['timestamp', 'level', 'message', 'component', 'trace_id', 'error'],
                filters: [{
                        field: 'level',
                        operator: 'equals',
                        value: 'error'
                    }]
            },
            {
                level: 'info',
                components: blueprint.entryPoints.map(ep => ep.componentId),
                format: 'json',
                fields: ['timestamp', 'level', 'message', 'component', 'trace_id']
            }
        ];
    }
    createHealthCheckDefinitions(blueprint) {
        const healthChecks = [];
        blueprint.entryPoints.slice(0, 3).forEach(entry => {
            healthChecks.push({
                name: `health_${entry.id}`,
                type: 'readiness',
                componentId: entry.componentId,
                endpoint: '/health',
                interval: 30000,
                timeout: 5000,
                successThreshold: 1,
                failureThreshold: 3
            });
        });
        return healthChecks;
    }
    createVisualizationSection(blueprint) {
        return {
            layout: {
                type: 'hierarchical',
                algorithm: 'dagre',
                parameters: {
                    rankDir: 'TB',
                    nodeSpacing: 50,
                    rankSpacing: 100
                }
            },
            style: {
                theme: 'light',
                colors: {
                    'controller': '#4CAF50',
                    'service': '#2196F3',
                    'model': '#FF9800',
                    'middleware': '#9C27B0',
                    'external_api': '#F44336'
                }
            },
            interactions: [
                {
                    trigger: 'click',
                    target: 'all',
                    action: 'showDetails'
                },
                {
                    trigger: 'hover',
                    target: 'all',
                    action: 'highlight'
                }
            ],
            animations: [
                {
                    name: 'data_flow',
                    type: 'flow',
                    targets: blueprint.connections.map(c => `${c.from}_${c.to}`),
                    duration: 2000,
                    loop: true
                }
            ],
            overlays: [
                {
                    id: 'performance_overlay',
                    type: 'heatmap',
                    dataSource: 'telemetry',
                    visualization: 'gradient',
                    opacity: 0.5,
                    colors: ['#00FF00', '#FFFF00', '#FF0000']
                }
            ]
        };
    }
    createTelemetrySection(blueprint) {
        return {
            streams: [
                {
                    id: 'metrics_stream',
                    name: 'Metrics Stream',
                    source: 'application',
                    protocol: 'http',
                    format: 'json',
                    endpoint: '/metrics'
                },
                {
                    id: 'traces_stream',
                    name: 'Traces Stream',
                    source: 'application',
                    protocol: 'grpc',
                    format: 'protobuf',
                    endpoint: 'localhost:4317'
                }
            ],
            aggregations: [
                {
                    metric: 'request_count',
                    window: 60,
                    function: 'sum',
                    groupBy: ['component', 'endpoint']
                },
                {
                    metric: 'response_time',
                    window: 60,
                    function: 'percentile',
                    groupBy: ['component']
                }
            ],
            retention: {
                raw: 7,
                aggregated: 30,
                archived: 365
            }
        };
    }
    createMetadata(blueprint, analysisId, analyzer, duration) {
        return {
            analysisId,
            analyzedAt: new Date(),
            analyzer,
            version: this.schema.version,
            duration,
            fileCount: blueprint.metadata.totalComponents,
            componentCount: blueprint.components.length,
            connectionCount: blueprint.connections.length
        };
    }
    validateManifest(manifest) {
        if (!manifest.version) {
            throw new errors_1.ManifestError('Manifest version is required');
        }
        if (!manifest.project || !manifest.project.name) {
            throw new errors_1.ManifestError('Project information is required');
        }
        if (!manifest.architecture || !manifest.architecture.blueprint) {
            throw new errors_1.ManifestError('Architecture blueprint is required');
        }
        const componentIds = new Set(manifest.architecture.blueprint.components.map(c => c.id));
        manifest.architecture.layers.forEach(layer => {
            layer.components.forEach(compId => {
                if (!componentIds.has(compId)) {
                    throw new errors_1.ManifestError(`Layer references non-existent component: ${compId}`);
                }
            });
        });
        manifest.instrumentation.points.forEach(point => {
            if (!componentIds.has(point.componentId)) {
                throw new errors_1.ManifestError(`Instrumentation point references non-existent component: ${point.componentId}`);
            }
        });
    }
    async saveManifest(manifest, outputPath) {
        const span = telemetry_schema_1.telemetry.createSpan('manifest.save');
        try {
            const outputDir = path.dirname(outputPath);
            await fs.ensureDir(outputDir);
            switch (this.schema.format) {
                case 'json':
                    await this.saveAsJSON(manifest, outputPath);
                    break;
                case 'yaml':
                    await this.saveAsYAML(manifest, outputPath);
                    break;
                default:
                    throw new errors_1.ManifestError(`Unsupported format: ${this.schema.format}`);
            }
            telemetry_schema_1.telemetry.emit({
                type: 'manifest_saved',
                source: { analyzer: 'manifest-generator' },
                data: {
                    outputPath,
                    format: this.schema.format,
                    size: (await fs.stat(outputPath)).size
                }
            });
            console.log(`✅ Manifest saved to: ${outputPath}`);
            span.end();
        }
        catch (error) {
            telemetry_schema_1.telemetry.emit({
                type: 'error_occurred',
                source: { analyzer: 'manifest-generator' },
                data: {
                    error: error instanceof Error ? error.message : String(error),
                    outputPath
                }
            });
            span.end();
            throw error;
        }
    }
    async persistAnalysisResults(blueprint, analysisId, analyzer, duration) {
        if (!this.organizationId || !this.projectId) {
            return;
        }
        try {
            const analysisRun = await analysis_repository_1.analysisRepository.create({
                id: analysisId,
                project_id: this.projectId,
                analyzer_name: analyzer,
                status: 'completed',
                started_at: new Date(Date.now() - duration),
                completed_at: new Date(),
                processing_time_ms: duration,
                commit_sha: undefined,
                branch: 'main',
                configuration: {},
                results: {
                    componentCount: blueprint.components.length,
                    connectionCount: blueprint.connections.length,
                    entryPointCount: blueprint.entryPoints.length,
                    exitPointCount: blueprint.exitPoints.length,
                    riskCount: blueprint.riskAreas.length
                }
            }, this.organizationId);
            for (const component of blueprint.components) {
                await component_repository_1.componentRepository.create({
                    analysis_run_id: analysisRun.id,
                    name: component.name,
                    type: component.type,
                    path: component.path,
                    language: component.language,
                    framework: component.framework,
                    size_bytes: component.size,
                    lines_of_code: component.linesOfCode,
                    complexity_score: component.metadata.complexity,
                    dependencies: component.dependencies,
                    dependents: component.dependents,
                    metadata: {
                        ...component.metadata,
                        functions: component.functions,
                        imports: component.imports,
                        exports: component.exports
                    }
                }, this.organizationId);
            }
            await project_repository_1.projectRepository.updateAnalysisStatus(this.projectId, 'active', this.organizationId, new Date());
            console.log(`💾 Persisted analysis results for ${blueprint.components.length} components`);
        }
        catch (error) {
            console.warn('Failed to persist analysis results to database:', error.message);
        }
    }
    async saveAsJSON(manifest, outputPath) {
        const content = JSON.stringify(manifest, null, 2);
        if (this.schema.compression === 'gzip') {
            const zlib = await Promise.resolve().then(() => __importStar(require('zlib')));
            const compressed = zlib.gzipSync(content);
            await fs.writeFile(outputPath + '.gz', compressed);
        }
        else {
            await fs.writeFile(outputPath, content);
        }
    }
    async saveAsYAML(manifest, outputPath) {
        throw new errors_1.ManifestError('YAML format not yet implemented');
    }
}
exports.ManifestGenerator = ManifestGenerator;
