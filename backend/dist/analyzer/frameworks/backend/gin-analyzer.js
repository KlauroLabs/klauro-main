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
exports.GinAnalyzer = void 0;
const go_analyzer_1 = require("../../languages/go-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class GinAnalyzer extends go_analyzer_1.GoAnalyzer {
    constructor() {
        super(...arguments);
        this.ginVersion = '';
        this.routes = new Map();
        this.middleware = new Map();
        this.routerGroups = new Map();
        this.hasGORM = false;
        this.hasRedis = false;
    }
    getAnalyzerName() {
        return 'Gin Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['gin', 'gin-gonic', 'gorm', 'go-redis'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        await this.detectGinVersion();
        return {
            ...baseDetection,
            frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('gin')), {
                    name: 'gin',
                    version: this.ginVersion,
                    confidence: 0.95,
                    patterns: ['Gin framework detected'],
                    configFiles: ['go.mod', 'go.sum', 'main.go'],
                    dependencies: ['github.com/gin-gonic/gin']
                }]
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('gin-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverRoutes();
        await this.discoverMiddleware();
        await this.discoverRouterGroups();
        const components = new Map();
        for (const [id, route] of this.routes) {
            const node = {
                id,
                name: `${route.method} ${route.path}`,
                type: 'controller',
                path: route.handler,
                language: 'go',
                framework: 'gin',
                dependencies: route.middleware,
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: route.middleware.length + 1,
                    maintainability: 100 - route.middleware.length * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: route.middleware.length + 1,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    httpMethods: [route.method],
                    layer: 'presentation',
                    responsibilities: [`Handle ${route.method} requests to ${route.path}`],
                    frameworkType: 'route',
                    method: route.method,
                    path: route.path
                }
            };
            components.set(id, node);
        }
        for (const [id, mw] of this.middleware) {
            const node = {
                id,
                name: mw.name,
                type: 'middleware',
                path: mw.filePath,
                language: 'go',
                framework: 'gin',
                dependencies: [],
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: 2,
                    maintainability: 95,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: 2,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'infrastructure',
                    responsibilities: ['Middleware processing'],
                    frameworkType: 'middleware',
                    global: mw.global,
                    order: mw.order
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildGinConnections();
        const apiEndpoints = this.extractGinEndpoints();
        telemetry_schema_1.telemetry.emit({
            type: 'component_discovery_completed',
            source: { analyzer: this.getAnalyzerName() },
            data: {
                totalComponents: components.size,
                routes: this.routes.size,
                middleware: this.middleware.size,
                routerGroups: this.routerGroups.size
            }
        });
        span.end();
        return {
            components: Array.from(components.values()),
            entryPoints: ['main.go'],
            connections,
            layers: this.buildGinLayers(),
            apiEndpoints,
            databaseConnections: []
        };
    }
    async detectGinVersion() {
        const goModPath = path.join(this.projectPath, 'go.mod');
        if (await fs.pathExists(goModPath)) {
            const content = await fs.readFile(goModPath, 'utf-8');
            const versionMatch = content.match(/github\.com\/gin-gonic\/gin\s+v([\d.]+)/);
            if (versionMatch) {
                this.ginVersion = versionMatch[1];
            }
            this.hasGORM = content.includes('gorm.io/gorm');
            this.hasRedis = content.includes('github.com/go-redis/redis');
        }
    }
    async discoverRoutes() {
        const goFiles = await this.findFiles(['**/*.go'], this.options.excludePatterns);
        for (const file of goFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const routes = this.parseGinRoutes(content, file);
            for (const route of routes) {
                const id = `${route.method}_${route.path.replace(/[/:]/g, '_')}`;
                this.routes.set(id, route);
            }
        }
    }
    parseGinRoutes(content, filePath) {
        const routes = [];
        const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
        for (const method of methods) {
            const regex = new RegExp(`\\w+\\.${method}\\("([^"]+)"\\s*,\\s*(\\w+)`, 'g');
            let match;
            while ((match = regex.exec(content)) !== null) {
                routes.push({
                    path: match[1],
                    method,
                    handler: `${filePath}::${match[2]}`,
                    middleware: []
                });
            }
        }
        const anyRegex = /\w+\.Any\("([^"]+)"\s*,\s*(\w+)/g;
        let match;
        while ((match = anyRegex.exec(content)) !== null) {
            routes.push({
                path: match[1],
                method: '*',
                handler: `${filePath}::${match[2]}`,
                middleware: []
            });
        }
        return routes;
    }
    async discoverMiddleware() {
        const goFiles = await this.findFiles(['**/*.go'], this.options.excludePatterns);
        let order = 0;
        for (const file of goFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('.Use(') || content.includes('gin.HandlerFunc')) {
                const middlewares = this.parseMiddleware(content, file, order);
                for (const mw of middlewares) {
                    this.middleware.set(mw.name, mw);
                    order++;
                }
            }
        }
    }
    parseMiddleware(content, filePath, startOrder) {
        const middleware = [];
        let order = startOrder;
        const useRegex = /\.Use\((\w+)\)/g;
        let match;
        while ((match = useRegex.exec(content)) !== null) {
            middleware.push({
                name: match[1],
                filePath,
                global: content.includes('r.Use(') || content.includes('router.Use('),
                order: order++
            });
        }
        return middleware;
    }
    async discoverRouterGroups() {
        const goFiles = await this.findFiles(['**/*.go'], this.options.excludePatterns);
        for (const file of goFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const groups = this.parseRouterGroups(content);
            for (const group of groups) {
                this.routerGroups.set(group.name, group);
            }
        }
    }
    parseRouterGroups(content) {
        const groups = [];
        const groupRegex = /(\w+)\s*:=\s*\w+\.Group\("([^"]+)"/g;
        let match;
        let index = 0;
        while ((match = groupRegex.exec(content)) !== null) {
            groups.push({
                name: match[1],
                basePath: match[2],
                routes: [],
                middleware: []
            });
            index++;
        }
        return groups;
    }
    async buildGinConnections() {
        const connections = [];
        for (const [routeId, route] of this.routes) {
            for (const mw of route.middleware) {
                connections.push({
                    from: routeId,
                    to: mw,
                    type: 'uses-middleware',
                    protocol: 'gin',
                    metadata: {
                        callSites: 1,
                        middlewareName: mw
                    }
                });
            }
        }
        for (const [groupId, group] of this.routerGroups) {
            for (const route of group.routes) {
                connections.push({
                    from: groupId,
                    to: `${route.method}_${route.path}`,
                    type: 'contains',
                    protocol: 'gin',
                    metadata: {
                        callSites: 1,
                        basePath: group.basePath
                    }
                });
            }
        }
        return connections;
    }
    extractGinEndpoints() {
        const endpoints = [];
        for (const [id, route] of this.routes) {
            endpoints.push({
                id: `gin-${id}`,
                path: route.path,
                method: route.method === '*' ? 'GET' : route.method,
                description: `Gin ${route.method} endpoint for ${route.path}`,
                handler: route.handler,
                parameters: [],
                statusCodes: [{ code: 200, description: 'Success' }],
                middleware: route.middleware,
                authentication: {
                    type: route.middleware.some(m => m.toLowerCase().includes('auth')) ? 'jwt' : 'none',
                    required: route.middleware.some(m => m.toLowerCase().includes('auth'))
                },
                rateLimit: undefined,
                deprecated: false,
                componentId: id
            });
        }
        return endpoints;
    }
    buildGinLayers() {
        return {
            'routes': Array.from(this.routes.keys()),
            'middleware': Array.from(this.middleware.keys()),
            'routerGroups': Array.from(this.routerGroups.keys())
        };
    }
    async analyzePerformance() {
        return {
            gin: {
                routesCount: this.routes.size,
                middlewareCount: this.middleware.size,
                routerGroupsCount: this.routerGroups.size,
                features: {
                    hasGORM: this.hasGORM,
                    hasRedis: this.hasRedis
                }
            }
        };
    }
}
exports.GinAnalyzer = GinAnalyzer;
