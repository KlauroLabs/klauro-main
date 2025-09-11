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
exports.AspNetCoreAnalyzer = void 0;
const csharp_analyzer_1 = require("../../languages/csharp-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const fs = __importStar(require("fs-extra"));
class AspNetCoreAnalyzer extends csharp_analyzer_1.CSharpAnalyzer {
    constructor() {
        super(...arguments);
        this.aspNetVersion = '';
        this.controllers = new Map();
        this.services = new Map();
        this.entities = new Map();
        this.hasEntityFramework = false;
        this.hasIdentity = false;
        this.hasSignalR = false;
    }
    getAnalyzerName() {
        return 'ASP.NET Core Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['aspnetcore', 'entityframework', 'signalr', 'identity'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        await this.detectAspNetCoreVersion();
        return {
            ...baseDetection,
            frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('aspnet')), {
                    name: 'aspnetcore',
                    version: this.aspNetVersion,
                    confidence: 0.95,
                    patterns: ['ASP.NET Core application detected'],
                    configFiles: ['appsettings.json', 'Program.cs', 'Startup.cs', '*.csproj'],
                    dependencies: ['Microsoft.AspNetCore']
                }]
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('aspnetcore-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverControllers();
        await this.discoverServices();
        await this.discoverEntities();
        const components = new Map();
        for (const [id, controller] of this.controllers) {
            const node = {
                id,
                name: controller.name,
                type: 'controller',
                path: controller.filePath,
                language: 'csharp',
                framework: 'aspnetcore',
                dependencies: [],
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: controller.actions.length,
                    maintainability: 100 - controller.actions.length * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: controller.actions.length,
                    lastModified: new Date(),
                    exports: controller.actions.map(a => a.name),
                    imports: [],
                    layer: 'presentation',
                    responsibilities: ['HTTP request handling', 'Business logic orchestration'],
                    frameworkType: 'controller',
                    routePrefix: controller.routePrefix,
                    filters: controller.filters,
                    authorization: controller.authorization
                }
            };
            components.set(id, node);
        }
        for (const [id, service] of this.services) {
            const node = {
                id,
                name: service.name,
                type: 'service',
                path: service.filePath,
                language: 'csharp',
                framework: 'aspnetcore',
                dependencies: service.dependencies,
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: service.dependencies.length + 2,
                    maintainability: 100 - service.dependencies.length * 3,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: service.dependencies.length + 2,
                    lastModified: new Date(),
                    exports: service.interface ? [service.interface] : [],
                    imports: service.dependencies,
                    layer: 'business',
                    responsibilities: ['Business logic', 'Service operations'],
                    frameworkType: 'service',
                    lifetime: service.lifetime,
                    interface: service.interface
                }
            };
            components.set(id, node);
        }
        for (const [id, entity] of this.entities) {
            const node = {
                id,
                name: entity.name,
                type: 'model',
                path: entity.filePath,
                language: 'csharp',
                framework: 'aspnetcore',
                dependencies: entity.navigationProperties.map(np => np.targetEntity),
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: entity.properties.length + entity.navigationProperties.length,
                    maintainability: 100 - (entity.properties.length + entity.navigationProperties.length) * 1.5,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: entity.properties.length + entity.navigationProperties.length,
                    lastModified: new Date(),
                    exports: entity.properties.map(p => p.name),
                    imports: entity.navigationProperties.map(np => np.targetEntity),
                    layer: 'data',
                    responsibilities: ['Data modeling', 'Entity relations'],
                    frameworkType: 'entity',
                    tableName: entity.tableName
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildAspNetConnections();
        const apiEndpoints = this.extractAspNetEndpoints();
        const databaseConnections = await this.extractDatabaseConnections();
        telemetry_schema_1.telemetry.emit({
            type: 'component_discovery_completed',
            source: { analyzer: this.getAnalyzerName() },
            data: {
                totalComponents: components.size,
                controllers: this.controllers.size,
                services: this.services.size,
                entities: this.entities.size
            }
        });
        span.end();
        return {
            components: Array.from(components.values()),
            entryPoints: ['Program.cs', 'Startup.cs'],
            connections,
            layers: this.buildAspNetLayers(),
            apiEndpoints,
            databaseConnections
        };
    }
    async detectAspNetCoreVersion() {
        const csprojFiles = await this.findFiles(['**/*.csproj'], []);
        for (const csprojFile of csprojFiles) {
            const content = await fs.readFile(csprojFile, 'utf-8');
            const versionMatch = content.match(/<TargetFramework>net(\d+\.\d+)<\/TargetFramework>/);
            if (versionMatch) {
                this.aspNetVersion = versionMatch[1];
                break;
            }
        }
    }
    async discoverControllers() {
        const csFiles = await this.findFiles(['**/*Controller.cs'], this.options.excludePatterns);
        for (const file of csFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const controller = this.parseController(content, file);
            if (controller) {
                this.controllers.set(controller.name, controller);
            }
        }
    }
    parseController(content, filePath) {
        const classMatch = content.match(/public\s+class\s+(\w+Controller)/);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const routeMatch = content.match(/\[Route\("([^"]+)"\)\]/);
        return {
            name,
            filePath,
            routePrefix: routeMatch?.[1],
            actions: this.parseControllerActions(content),
            filters: [],
            authorization: []
        };
    }
    parseControllerActions(content) {
        const actions = [];
        const httpMethods = ['HttpGet', 'HttpPost', 'HttpPut', 'HttpDelete', 'HttpPatch'];
        for (const method of httpMethods) {
            const regex = new RegExp(`\\[${method}(?:\\("([^"]+)"\\))?\\][^}]*public\\s+\\w+\\s+(\\w+)`, 'g');
            let match;
            while ((match = regex.exec(content)) !== null) {
                actions.push({
                    name: match[2],
                    httpMethod: method.replace('Http', '').toUpperCase(),
                    route: match[1] || '',
                    parameters: []
                });
            }
        }
        return actions;
    }
    async discoverServices() {
        const csFiles = await this.findFiles(['**/*Service.cs', '**/*Repository.cs'], this.options.excludePatterns);
        for (const file of csFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const service = this.parseService(content, file);
            if (service) {
                this.services.set(service.name, service);
            }
        }
    }
    parseService(content, filePath) {
        const classMatch = content.match(/public\s+class\s+(\w+)/);
        if (!classMatch)
            return null;
        const interfaceMatch = content.match(/:\s*I(\w+)/);
        return {
            name: classMatch[1],
            filePath,
            lifetime: 'Scoped',
            dependencies: [],
            interface: interfaceMatch ? `I${interfaceMatch[1]}` : undefined
        };
    }
    async discoverEntities() {
        const csFiles = await this.findFiles(['**/*.cs'], this.options.excludePatterns);
        for (const file of csFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('DbContext') || content.includes('DbSet')) {
                const entity = this.parseEntity(content, file);
                if (entity) {
                    this.entities.set(entity.name, entity);
                }
            }
        }
    }
    parseEntity(content, filePath) {
        const classMatch = content.match(/public\s+class\s+(\w+)/);
        if (!classMatch)
            return null;
        return {
            name: classMatch[1],
            filePath,
            properties: this.parseEntityProperties(content),
            navigationProperties: this.parseNavigationProperties(content)
        };
    }
    parseEntityProperties(content) {
        const properties = [];
        const propRegex = /public\s+(\w+\??)\s+(\w+)\s*\{\s*get;\s*set;\s*\}/g;
        let match;
        while ((match = propRegex.exec(content)) !== null) {
            properties.push({
                name: match[2],
                type: match[1],
                isKey: match[2] === 'Id' || match[2].endsWith('Id'),
                isRequired: !match[1].includes('?')
            });
        }
        return properties;
    }
    parseNavigationProperties(content) {
        const navProps = [];
        const collectionRegex = /public\s+(?:virtual\s+)?ICollection<(\w+)>\s+(\w+)/g;
        let match;
        while ((match = collectionRegex.exec(content)) !== null) {
            navProps.push({
                name: match[2],
                targetEntity: match[1],
                relationship: 'OneToMany'
            });
        }
        return navProps;
    }
    async buildAspNetConnections() {
        const connections = [];
        for (const [controllerId] of this.controllers) {
            for (const [serviceId] of this.services) {
                connections.push({
                    from: controllerId,
                    to: serviceId,
                    type: 'dependency-injection',
                    protocol: 'aspnetcore',
                    metadata: { callSites: 1, injectionType: 'constructor' }
                });
            }
        }
        for (const [entityId, entity] of this.entities) {
            for (const navProp of entity.navigationProperties) {
                connections.push({
                    from: entityId,
                    to: navProp.targetEntity,
                    type: 'data-relationship',
                    protocol: 'entityframework',
                    metadata: { callSites: 1, relationship: navProp.relationship }
                });
            }
        }
        return connections;
    }
    extractAspNetEndpoints() {
        const endpoints = [];
        for (const [id, controller] of this.controllers) {
            const basePath = controller.routePrefix || `api/${controller.name.replace('Controller', '')}`;
            for (const action of controller.actions) {
                const endpointId = `${id}_${action.name}`;
                endpoints.push({
                    id: endpointId,
                    path: `/${basePath}/${action.route}`.replace(/\/+/g, '/'),
                    method: action.httpMethod,
                    description: `${action.httpMethod} ${action.name}`,
                    handler: `${controller.name}.${action.name}`,
                    parameters: action.parameters.map(p => ({
                        name: p.name,
                        type: (p.source === 'FromRoute' ? 'path' : p.source === 'FromQuery' ? 'query' : 'body'),
                        required: p.required,
                        dataType: p.type
                    })),
                    statusCodes: [{ code: 200, description: 'Success' }],
                    middleware: controller.filters,
                    authentication: {
                        type: controller.authorization.length > 0 ? 'jwt' : 'none',
                        required: controller.authorization.length > 0
                    },
                    rateLimit: undefined,
                    deprecated: false,
                    componentId: id
                });
            }
        }
        return endpoints;
    }
    async extractDatabaseConnections() {
        return [{
                id: 'entityframework-core',
                name: 'Entity Framework Core',
                type: 'sqlserver',
                host: 'localhost',
                port: 1433,
                database: 'aspnetcore',
                schema: 'dbo',
                tables: Array.from(this.entities.keys()),
                usage: [],
                componentIds: []
            }];
    }
    buildAspNetLayers() {
        return {
            'controllers': Array.from(this.controllers.keys()),
            'services': Array.from(this.services.keys()),
            'entities': Array.from(this.entities.keys())
        };
    }
    async analyzePerformance() {
        return {
            aspnetcore: {
                controllersCount: this.controllers.size,
                servicesCount: this.services.size,
                entitiesCount: this.entities.size,
                averageActionsPerController: this.calculateAverageActionsPerController(),
                features: {
                    hasEntityFramework: this.hasEntityFramework,
                    hasIdentity: this.hasIdentity,
                    hasSignalR: this.hasSignalR
                }
            }
        };
    }
    calculateAverageActionsPerController() {
        const controllers = Array.from(this.controllers.values());
        if (controllers.length === 0)
            return 0;
        const totalActions = controllers.reduce((sum, c) => sum + c.actions.length, 0);
        return totalActions / controllers.length;
    }
}
exports.AspNetCoreAnalyzer = AspNetCoreAnalyzer;
