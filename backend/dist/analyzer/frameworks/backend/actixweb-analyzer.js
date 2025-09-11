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
exports.ActixWebAnalyzer = void 0;
const rust_analyzer_1 = require("../../languages/rust-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class ActixWebAnalyzer extends rust_analyzer_1.RustAnalyzer {
    constructor() {
        super(...arguments);
        this.actixVersion = '';
        this.routes = new Map();
        this.handlers = new Map();
        this.middleware = new Map();
        this.appStates = new Map();
        this.hasDiesel = false;
        this.hasSQLx = false;
        this.hasWebSocket = false;
    }
    getAnalyzerName() {
        return 'Actix-web Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['actix-web', 'actix-rt', 'diesel', 'sqlx', 'tokio'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        await this.detectActixVersion();
        return {
            ...baseDetection,
            frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('actix')), {
                    name: 'actix-web',
                    version: this.actixVersion,
                    confidence: 0.95,
                    patterns: ['Actix-web framework detected'],
                    configFiles: ['Cargo.toml', 'Cargo.lock', 'main.rs'],
                    dependencies: ['actix-web']
                }]
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('actixweb-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverRoutes();
        await this.discoverHandlers();
        await this.discoverMiddleware();
        await this.discoverAppStates();
        const components = new Map();
        for (const [id, route] of this.routes) {
            const node = {
                id,
                name: `${route.method} ${route.path}`,
                type: 'route',
                path: route.handler,
                language: 'rust',
                framework: 'actix-web',
                dependencies: [...route.guards, ...route.extractors],
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: route.guards.length + route.extractors.length,
                    maintainability: 100 - (route.guards.length + route.extractors.length) * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: route.guards.length + route.extractors.length,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    httpMethods: [route.method],
                    layer: 'presentation',
                    responsibilities: [`Handle ${route.method} requests to ${route.path}`]
                }
            };
            components.set(id, node);
        }
        for (const [id, handler] of this.handlers) {
            const node = {
                id,
                name: handler.name,
                type: 'service',
                path: handler.filePath,
                language: 'rust',
                framework: 'actix-web',
                dependencies: handler.extractors,
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: handler.extractors.length + 1,
                    maintainability: 100 - handler.extractors.length * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: handler.extractors.length,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'business',
                    responsibilities: ['Handle request processing']
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
                language: 'rust',
                framework: 'actix-web',
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
                    complexity: 1,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'infrastructure',
                    responsibilities: ['Middleware processing']
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildActixConnections();
        const apiEndpoints = this.extractActixEndpoints();
        telemetry_schema_1.telemetry.emit({
            type: 'component_discovered',
            source: { analyzer: this.getAnalyzerName() },
            data: {
                totalComponents: components.size,
                routes: this.routes.size,
                handlers: this.handlers.size,
                middleware: this.middleware.size,
                appStates: this.appStates.size
            }
        });
        span.end();
        return {
            components: Array.from(components.values()),
            entryPoints: ['main.rs', 'src/main.rs', 'lib.rs', 'src/lib.rs'],
            connections,
            layers: this.buildActixLayers(),
            apiEndpoints,
            databaseConnections: []
        };
    }
    async detectActixVersion() {
        const cargoPath = path.join(this.projectPath, 'Cargo.toml');
        if (await fs.pathExists(cargoPath)) {
            const content = await fs.readFile(cargoPath, 'utf-8');
            const versionMatch = content.match(/actix-web\s*=\s*"([\d.]+)"/);
            if (versionMatch) {
                this.actixVersion = versionMatch[1];
            }
            this.hasDiesel = content.includes('diesel');
            this.hasSQLx = content.includes('sqlx');
            this.hasWebSocket = content.includes('actix-ws') || content.includes('actix-web-actors');
        }
    }
    async discoverRoutes() {
        const rustFiles = await this.findFiles(['**/*.rs'], this.options.excludePatterns);
        for (const file of rustFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const routes = this.parseActixRoutes(content, file);
            for (const route of routes) {
                const id = `${route.method}_${route.path.replace(/[/{}/]/g, '_')}`;
                this.routes.set(id, route);
            }
        }
    }
    parseActixRoutes(content, filePath) {
        const routes = [];
        const macroRegex = /#\[(get|post|put|delete|patch|head)\("([^"]+)"\)\]/g;
        let match;
        while ((match = macroRegex.exec(content)) !== null) {
            const method = match[1].toUpperCase();
            const path = match[2];
            const handlerRegex = new RegExp(`#\\[${match[1]}[^\\n]*\\n(?:pub\\s+)?(?:async\\s+)?fn\\s+(\\w+)`);
            const handlerMatch = content.match(handlerRegex);
            routes.push({
                path,
                method,
                handler: handlerMatch ? `${filePath}::${handlerMatch[1]}` : `${filePath}::handler`,
                guards: [],
                extractors: []
            });
        }
        const routeRegex = /web::route\(\)\.to\((\w+)\)/g;
        while ((match = routeRegex.exec(content)) !== null) {
            routes.push({
                path: '/',
                method: '*',
                handler: `${filePath}::${match[1]}`,
                guards: [],
                extractors: []
            });
        }
        return routes;
    }
    async discoverHandlers() {
        const rustFiles = await this.findFiles(['**/*.rs'], this.options.excludePatterns);
        for (const file of rustFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const handlers = this.parseHandlers(content, file);
            for (const handler of handlers) {
                this.handlers.set(handler.name, handler);
            }
        }
    }
    parseHandlers(content, filePath) {
        const handlers = [];
        const handlerRegex = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\s*\{/g;
        let match;
        while ((match = handlerRegex.exec(content)) !== null) {
            const name = match[1];
            const params = match[2];
            const returnType = match[3]?.trim();
            if (params.includes('HttpRequest') || params.includes('HttpResponse') ||
                params.includes('web::') || params.includes('Json<') || params.includes('Path<')) {
                const extractors = this.parseExtractors(params);
                handlers.push({
                    name,
                    filePath,
                    async: content.includes(`async fn ${name}`),
                    returnType,
                    extractors
                });
            }
        }
        return handlers;
    }
    parseExtractors(params) {
        const extractors = [];
        const extractorTypes = ['HttpRequest', 'HttpResponse', 'web::Path', 'web::Query',
            'web::Json', 'web::Data', 'web::Header', 'web::Form'];
        for (const extractor of extractorTypes) {
            if (params.includes(extractor)) {
                extractors.push(extractor);
            }
        }
        return extractors;
    }
    async discoverMiddleware() {
        const rustFiles = await this.findFiles(['**/*.rs'], this.options.excludePatterns);
        let order = 0;
        for (const file of rustFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('impl Transform') || content.includes('.wrap(')) {
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
        const structRegex = /struct\s+(\w+Middleware|\w+Guard)/g;
        let match;
        while ((match = structRegex.exec(content)) !== null) {
            middleware.push({
                name: match[1],
                filePath,
                wrapsApp: content.includes(`.wrap(${match[1]}`),
                order: order++
            });
        }
        const wrapRegex = /\.wrap\((\w+)/g;
        while ((match = wrapRegex.exec(content)) !== null) {
            if (match?.[1] && !middleware.find(m => m.name === match?.[1])) {
                middleware.push({
                    name: match[1],
                    filePath,
                    wrapsApp: true,
                    order: order++
                });
            }
        }
        return middleware;
    }
    async discoverAppStates() {
        const rustFiles = await this.findFiles(['**/*.rs'], this.options.excludePatterns);
        for (const file of rustFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('web::Data<') || content.includes('app_data(')) {
                const states = this.parseAppStates(content);
                for (const state of states) {
                    this.appStates.set(state.name, state);
                }
            }
        }
    }
    parseAppStates(content) {
        const states = [];
        const dataRegex = /web::Data<(\w+)>/g;
        let match;
        while ((match = dataRegex.exec(content)) !== null) {
            states.push({
                name: match[1],
                type: match[1],
                shared: true
            });
        }
        return states;
    }
    async buildActixConnections() {
        const connections = [];
        for (const [routeId, route] of this.routes) {
            const handlerName = route.handler.split('::').pop() || '';
            if (this.handlers.has(handlerName)) {
                connections.push({
                    from: routeId,
                    to: handlerName,
                    type: 'function_call',
                    weight: 1,
                    metadata: {
                        callSites: 1,
                        httpMethod: route.method
                    }
                });
            }
        }
        for (const [mwId, mw] of this.middleware) {
            if (mw.wrapsApp) {
                connections.push({
                    from: 'actix-app',
                    to: mwId,
                    type: 'middleware_chain',
                    weight: 1,
                    metadata: {
                        callSites: 1
                    }
                });
            }
        }
        return connections;
    }
    extractActixEndpoints() {
        const endpoints = [];
        for (const [id, route] of this.routes) {
            endpoints.push({
                id,
                path: route.path,
                method: route.method === '*' ? 'ALL' : route.method,
                description: `${route.method} ${route.path}`,
                handler: route.handler,
                parameters: [],
                statusCodes: [{ code: 200, description: 'Success' }],
                middleware: route.guards,
                authentication: {
                    type: route.guards.length > 0 ? 'jwt' : 'none',
                    required: route.guards.length > 0
                },
                rateLimit: undefined,
                deprecated: false,
                componentId: id
            });
        }
        return endpoints;
    }
    buildActixLayers() {
        return {
            'routes': Array.from(this.routes.keys()),
            'handlers': Array.from(this.handlers.keys()),
            'middleware': Array.from(this.middleware.keys()),
            'appStates': Array.from(this.appStates.keys())
        };
    }
    async analyzePerformance() {
        return {
            actixweb: {
                routesCount: this.routes.size,
                handlersCount: this.handlers.size,
                middlewareCount: this.middleware.size,
                appStatesCount: this.appStates.size,
                features: {
                    hasDiesel: this.hasDiesel,
                    hasSQLx: this.hasSQLx,
                    hasWebSocket: this.hasWebSocket
                }
            }
        };
    }
}
exports.ActixWebAnalyzer = ActixWebAnalyzer;
