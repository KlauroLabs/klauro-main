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
exports.ExpressAnalyzer = void 0;
const typescript_javascript_analyzer_1 = require("../../languages/typescript-javascript-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class ExpressAnalyzer extends typescript_javascript_analyzer_1.TypeScriptJavaScriptAnalyzer {
    constructor() {
        super(...arguments);
        this.expressVersion = '';
        this.routes = new Map();
        this.routers = new Map();
        this.middleware = new Map();
        this.staticServes = [];
        this.errorHandlers = new Map();
        this.websockets = new Map();
        this.appInstances = [];
        this.hasBodyParser = false;
        this.hasCors = false;
        this.hasHelmet = false;
        this.hasCompression = false;
        this.hasSession = false;
        this.hasPassport = false;
        this.hasSocketIO = false;
        this.hasMongoose = false;
        this.hasSequelize = false;
        this.hasPrisma = false;
    }
    getAnalyzerName() {
        return 'Express Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['express', 'body-parser', 'cors', 'helmet', 'compression', 'express-session', 'passport', 'socket.io'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        await this.detectExpressVersion();
        await this.detectExpressPackages();
        await this.findAppInstances();
        return {
            ...baseDetection,
            frameworks: [...baseDetection.frameworks.filter(f => f.name !== 'express'), {
                    name: 'express',
                    version: this.expressVersion,
                    confidence: 0.95,
                    patterns: ['Express application detected'],
                    configFiles: ['app.js', 'server.js', 'index.js', 'app.ts', 'server.ts'],
                    dependencies: ['express']
                }]
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('express-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverRoutes();
        await this.discoverRouters();
        await this.discoverMiddleware();
        await this.discoverStaticServes();
        await this.discoverErrorHandlers();
        await this.discoverWebSockets();
        const components = new Map();
        for (const [id, route] of this.routes) {
            const node = {
                id,
                name: `${route.method} ${route.path}`,
                type: 'route',
                path: route.handler,
                dependencies: route.middleware,
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: route.middleware.length + (route.params.length * 2),
                    maintainability: 100 - route.middleware.length * 3,
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
                    path: route.path
                }
            };
            components.set(id, node);
        }
        for (const [id, router] of this.routers) {
            const node = {
                id,
                name: router.name,
                type: 'service',
                path: router.filePath,
                dependencies: router.subRouters,
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(router.filePath),
                    complexity: router.routes.length + router.middleware.length,
                    maintainability: 100 - router.routes.length * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: router.routes.length + router.middleware.length,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'infrastructure',
                    responsibilities: ['Route handling and middleware management'],
                    basePath: router.basePath
                }
            };
            components.set(id, node);
        }
        for (const [id, mw] of this.middleware) {
            const node = {
                id,
                name: mw.name,
                type: 'middleware',
                path: mw.path || '',
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
                    exports: [mw.name],
                    imports: [],
                    layer: 'infrastructure',
                    responsibilities: ['Express middleware processing'],
                    order: mw.order,
                    global: mw.global
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildExpressConnections();
        const apiEndpoints = this.extractExpressEndpoints();
        const databaseConnections = await this.extractDatabaseConnections();
        telemetry_schema_1.telemetry.emit({
            type: 'component_discovered',
            source: { analyzer: this.getAnalyzerName() },
            data: {
                totalComponents: components.size,
                routes: this.routes.size,
                routers: this.routers.size,
                middleware: this.middleware.size,
                staticServes: this.staticServes.length,
                errorHandlers: this.errorHandlers.size,
                websockets: this.websockets.size,
                hasBodyParser: this.hasBodyParser,
                hasCors: this.hasCors
            }
        });
        span.end();
        return {
            components: Array.from(components.values()),
            entryPoints: this.findExpressEntryPoints(),
            connections,
            layers: this.buildExpressLayers(),
            apiEndpoints,
            databaseConnections
        };
    }
    async detectExpressVersion() {
        const packageJsonPath = path.join(this.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            const packageJson = await fs.readJson(packageJsonPath);
            const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
            if (dependencies.express) {
                this.expressVersion = dependencies.express.replace(/[\^~]/, '');
            }
        }
    }
    async detectExpressPackages() {
        const packageJsonPath = path.join(this.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            const packageJson = await fs.readJson(packageJsonPath);
            const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
            this.hasBodyParser = 'body-parser' in dependencies || 'express' in dependencies;
            this.hasCors = 'cors' in dependencies;
            this.hasHelmet = 'helmet' in dependencies;
            this.hasCompression = 'compression' in dependencies;
            this.hasSession = 'express-session' in dependencies;
            this.hasPassport = 'passport' in dependencies;
            this.hasSocketIO = 'socket.io' in dependencies;
            this.hasMongoose = 'mongoose' in dependencies;
            this.hasSequelize = 'sequelize' in dependencies;
            this.hasPrisma = '@prisma/client' in dependencies;
        }
    }
    async findAppInstances() {
        const appFiles = ['app.js', 'app.ts', 'server.js', 'server.ts', 'index.js', 'index.ts', 'main.js', 'main.ts'];
        for (const appFile of appFiles) {
            const fullPath = path.join(this.projectPath, appFile);
            if (await fs.pathExists(fullPath)) {
                const content = await fs.readFile(fullPath, 'utf-8');
                if (content.includes('express()') || content.includes('require("express")') || content.includes("require('express')") || content.includes('from "express"') || content.includes("from 'express'")) {
                    this.appInstances.push(appFile);
                }
            }
        }
        const srcFiles = await this.findFiles(['src/**/*.{js,ts}', 'lib/**/*.{js,ts}'], this.options.excludePatterns);
        for (const file of srcFiles.slice(0, 30)) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('express()') && !this.appInstances.includes(file)) {
                this.appInstances.push(file);
            }
        }
    }
    async discoverRoutes() {
        const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
        for (const file of jsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const routes = this.parseExpressRoutes(content, file);
            for (const route of routes) {
                const id = `${route.method}_${route.path.replace(/[/:]/g, '_')}`;
                this.routes.set(id, route);
            }
        }
    }
    parseExpressRoutes(content, filePath) {
        const routes = [];
        const routeRegex = /(?:app|router)\.(get|post|put|delete|patch|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
        let match;
        while ((match = routeRegex.exec(content)) !== null) {
            const method = match[1].toUpperCase();
            const path = match[2];
            const routeEndIndex = this.findClosingParen(content, match.index);
            const routeContent = content.substring(match.index, routeEndIndex);
            const middleware = this.extractMiddleware(routeContent);
            const params = this.extractPathParams(path);
            routes.push({
                path,
                method: method === 'ALL' ? '*' : method,
                handler: `${filePath}::route_${method}_${path}`,
                middleware,
                params,
                query: []
            });
        }
        const useRegex = /(?:app|router)\.use\s*\(\s*['"`]([^'"`]+)['"`]/g;
        while ((match = useRegex.exec(content)) !== null) {
            const path = match[1];
            routes.push({
                path,
                method: '*',
                handler: `${filePath}::use_${path}`,
                middleware: [],
                params: this.extractPathParams(path),
                query: []
            });
        }
        return routes;
    }
    findClosingParen(content, startIndex) {
        let depth = 0;
        let inString = false;
        let stringChar = '';
        for (let i = startIndex; i < content.length; i++) {
            const char = content[i];
            if (!inString) {
                if (char === '"' || char === "'" || char === '`') {
                    inString = true;
                    stringChar = char;
                }
                else if (char === '(') {
                    depth++;
                }
                else if (char === ')') {
                    depth--;
                    if (depth === 0) {
                        return i + 1;
                    }
                }
            }
            else {
                if (char === stringChar && content[i - 1] !== '\\') {
                    inString = false;
                }
            }
        }
        return startIndex + 100;
    }
    extractMiddleware(routeContent) {
        const middleware = [];
        const funcRegex = /,\s*(\w+)\s*[,)]/g;
        let match;
        while ((match = funcRegex.exec(routeContent)) !== null) {
            middleware.push(match[1]);
        }
        return middleware;
    }
    extractPathParams(path) {
        const params = [];
        const paramRegex = /:(\w+)/g;
        let match;
        while ((match = paramRegex.exec(path)) !== null) {
            params.push(match[1]);
        }
        return params;
    }
    async discoverRouters() {
        const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
        for (const file of jsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('express.Router()') || content.includes('Router()')) {
                const routers = this.parseRouters(content, file);
                for (const router of routers) {
                    this.routers.set(router.name, router);
                }
            }
        }
    }
    parseRouters(content, filePath) {
        const routers = [];
        const routerRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.)?Router\s*\(/g;
        let match;
        while ((match = routerRegex.exec(content)) !== null) {
            const name = match[1];
            const router = {
                name,
                filePath,
                routes: [],
                middleware: [],
                subRouters: []
            };
            const routerRouteRegex = new RegExp(`${name}\\.(get|post|put|delete|patch|head|options|all)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
            let routeMatch;
            while ((routeMatch = routerRouteRegex.exec(content)) !== null) {
                router.routes.push({
                    path: routeMatch[2],
                    method: routeMatch[1].toUpperCase(),
                    handler: `${filePath}::${name}_${routeMatch[1]}_${routeMatch[2]}`,
                    middleware: [],
                    router: name,
                    params: this.extractPathParams(routeMatch[2]),
                    query: []
                });
            }
            routers.push(router);
        }
        return routers;
    }
    async discoverMiddleware() {
        const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
        let order = 0;
        for (const file of jsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const middlewares = this.parseMiddleware(content, file, order);
            for (const mw of middlewares) {
                this.middleware.set(mw.name, mw);
                order++;
            }
        }
    }
    parseMiddleware(content, filePath, startOrder) {
        const middleware = [];
        let order = startOrder;
        const useRegex = /app\.use\s*\(\s*([^)]+)\s*\)/g;
        let match;
        while ((match = useRegex.exec(content)) !== null) {
            const middlewareContent = match[1];
            if (middlewareContent.includes('bodyParser') || middlewareContent.includes('express.json')) {
                middleware.push({
                    name: 'body-parser',
                    type: 'application',
                    path: filePath,
                    order: order++,
                    global: true,
                    errorHandler: false
                });
            }
            if (middlewareContent.includes('cors')) {
                middleware.push({
                    name: 'cors',
                    type: 'application',
                    path: filePath,
                    order: order++,
                    global: true,
                    errorHandler: false
                });
            }
            if (middlewareContent.includes('helmet')) {
                middleware.push({
                    name: 'helmet',
                    type: 'application',
                    path: filePath,
                    order: order++,
                    global: true,
                    errorHandler: false
                });
            }
            if (middlewareContent.includes('compression')) {
                middleware.push({
                    name: 'compression',
                    type: 'application',
                    path: filePath,
                    order: order++,
                    global: true,
                    errorHandler: false
                });
            }
            if (middlewareContent.includes('err,') || middlewareContent.includes('error,')) {
                middleware.push({
                    name: 'error-handler',
                    type: 'error',
                    path: filePath,
                    order: order++,
                    global: true,
                    errorHandler: true
                });
            }
        }
        return middleware;
    }
    async discoverStaticServes() {
        const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
        for (const file of jsFiles.slice(0, 20)) {
            const content = await fs.readFile(file, 'utf-8');
            const statics = this.parseStaticServes(content);
            this.staticServes.push(...statics);
        }
    }
    parseStaticServes(content) {
        const statics = [];
        const staticRegex = /app\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*express\.static\s*\(\s*['"`]([^'"`]+)['"`]/g;
        let match;
        while ((match = staticRegex.exec(content)) !== null) {
            statics.push({
                path: match[1],
                directory: match[2],
                options: {}
            });
        }
        const staticNoPrefixRegex = /app\.use\s*\(\s*express\.static\s*\(\s*['"`]([^'"`]+)['"`]/g;
        while ((match = staticNoPrefixRegex.exec(content)) !== null) {
            statics.push({
                path: '/',
                directory: match[1],
                options: {}
            });
        }
        return statics;
    }
    async discoverErrorHandlers() {
        const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
        for (const file of jsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const handlers = this.parseErrorHandlers(content, file);
            for (const handler of handlers) {
                this.errorHandlers.set(handler.name, handler);
            }
        }
    }
    parseErrorHandlers(content, filePath) {
        const handlers = [];
        const errorHandlerRegex = /(?:app|router)\.use\s*\(\s*(?:async\s+)?(?:function\s*)?\s*\(\s*err/g;
        let match;
        let index = 0;
        while ((match = errorHandlerRegex.exec(content)) !== null) {
            handlers.push({
                name: `error_handler_${index++}`,
                filePath,
                statusCodes: [500],
                global: content.includes('app.use')
            });
        }
        const specificErrorRegex = /app\.use\s*\(\s*\(\s*err[^)]+\)\s*=>\s*{[^}]*res\.status\s*\(\s*(\d+)\s*\)/g;
        while ((match = specificErrorRegex.exec(content)) !== null) {
            handlers.push({
                name: `error_handler_${match[1]}`,
                filePath,
                statusCodes: [parseInt(match[1])],
                global: true
            });
        }
        return handlers;
    }
    async discoverWebSockets() {
        if (!this.hasSocketIO)
            return;
        const jsFiles = await this.findFiles(['**/*.{js,jsx,ts,tsx}'], this.options.excludePatterns);
        for (const file of jsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('socket.io') || content.includes('io.on')) {
                const websockets = this.parseWebSockets(content, file);
                for (const ws of websockets) {
                    this.websockets.set(ws.path, ws);
                }
            }
        }
    }
    parseWebSockets(content, filePath) {
        const websockets = [];
        const eventRegex = /(?:io|socket)\.on\s*\(\s*['"`]([^'"`]+)['"`]/g;
        const events = [];
        let match;
        while ((match = eventRegex.exec(content)) !== null) {
            events.push(match[1]);
        }
        if (events.length > 0) {
            websockets.push({
                path: '/socket.io',
                handler: filePath,
                events,
                namespace: '/'
            });
        }
        const namespaceRegex = /io\.of\s*\(\s*['"`]([^'"`]+)['"`]\)/g;
        while ((match = namespaceRegex.exec(content)) !== null) {
            websockets.push({
                path: match[1],
                handler: filePath,
                events: [],
                namespace: match[1]
            });
        }
        return websockets;
    }
    async countLinesOfCode(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return content.split('\n').length;
        }
        catch {
            return 0;
        }
    }
    async buildExpressConnections() {
        const connections = [];
        for (const [routeId, route] of this.routes) {
            if (route.router) {
                connections.push({
                    from: route.router,
                    to: routeId,
                    type: 'middleware_chain',
                    weight: 1,
                    metadata: {
                        callSites: 1,
                        httpMethod: route.method
                    }
                });
            }
            for (const mw of route.middleware) {
                connections.push({
                    from: routeId,
                    to: mw,
                    type: 'middleware_chain',
                    weight: 1,
                    metadata: {
                        callSites: 1
                    }
                });
            }
        }
        for (const staticServe of this.staticServes) {
            connections.push({
                from: 'express-app',
                to: staticServe.directory,
                type: 'http_call',
                weight: 1,
                metadata: {
                    callSites: 1
                }
            });
        }
        for (const [wsId, ws] of this.websockets) {
            connections.push({
                from: 'express-app',
                to: wsId,
                type: 'http_call',
                weight: 1,
                metadata: {
                    callSites: 1
                }
            });
        }
        return connections;
    }
    extractExpressEndpoints() {
        const endpoints = [];
        for (const [id, route] of this.routes) {
            endpoints.push({
                id,
                path: route.path,
                method: route.method === '*' ? 'GET' : route.method,
                description: `${route.method} ${route.path}`,
                handler: route.handler,
                parameters: route.params.map(p => ({
                    name: p,
                    type: 'path',
                    dataType: 'string',
                    required: true
                })),
                statusCodes: [{ code: 200, description: 'Success' }],
                middleware: route.middleware,
                authentication: (route.middleware.includes('authenticate') || route.middleware.includes('auth') || this.hasPassport) ? { type: 'bearer', required: true } : { type: 'none', required: false },
                rateLimit: route.middleware.includes('rateLimit') ? { requests: 100, window: '1m', strategy: 'fixed-window' } : undefined,
                deprecated: false,
                componentId: id
            });
        }
        for (const [wsId, ws] of this.websockets) {
            endpoints.push({
                id: wsId,
                path: ws.path,
                method: 'WS',
                description: `WebSocket ${ws.path}`,
                handler: ws.handler,
                parameters: [],
                statusCodes: [{ code: 101, description: 'Switching Protocols' }],
                middleware: [],
                authentication: { type: 'none', required: false },
                rateLimit: undefined,
                deprecated: false,
                componentId: wsId
            });
        }
        return endpoints;
    }
    async extractDatabaseConnections() {
        const connections = [];
        if (this.hasMongoose) {
            connections.push({
                id: 'mongoose',
                name: 'MongoDB (Mongoose)',
                type: 'mongodb',
                host: 'localhost',
                port: 27017,
                database: 'app',
                usage: [{ componentId: 'express-models', operations: [{ type: 'read', tables: [], complexity: 1, optimized: true }], frequency: 1, critical: true }],
                componentIds: ['express-models']
            });
        }
        if (this.hasSequelize) {
            connections.push({
                id: 'sequelize',
                name: 'SQL (Sequelize)',
                type: 'postgresql',
                host: 'localhost',
                port: 5432,
                database: 'app',
                usage: [{ componentId: 'express-models', operations: [{ type: 'read', tables: [], complexity: 1, optimized: true }], frequency: 1, critical: true }],
                componentIds: ['express-models']
            });
        }
        if (this.hasPrisma) {
            connections.push({
                id: 'prisma',
                name: 'Prisma ORM',
                type: 'postgresql',
                host: 'localhost',
                port: 5432,
                database: 'app',
                usage: [{ componentId: 'express-models', operations: [{ type: 'read', tables: [], complexity: 1, optimized: true }], frequency: 1, critical: true }],
                componentIds: ['express-models']
            });
        }
        return connections;
    }
    findExpressEntryPoints() {
        const entryPoints = [];
        entryPoints.push(...this.appInstances);
        entryPoints.push('bin/www', 'server.js', 'app.js', 'index.js');
        return [...new Set(entryPoints)];
    }
    buildExpressLayers() {
        return {
            'routes': Array.from(this.routes.keys()),
            'routers': Array.from(this.routers.keys()),
            'middleware': Array.from(this.middleware.keys()),
            'errorHandlers': Array.from(this.errorHandlers.keys()),
            'staticServes': this.staticServes.map(s => s.path),
            'websockets': Array.from(this.websockets.keys())
        };
    }
    async analyzePerformance() {
        return {
            express: {
                routesCount: this.routes.size,
                routersCount: this.routers.size,
                middlewareCount: this.middleware.size,
                staticServesCount: this.staticServes.length,
                errorHandlersCount: this.errorHandlers.size,
                websocketsCount: this.websockets.size,
                averageMiddlewarePerRoute: this.calculateAverageMiddleware(),
                features: {
                    hasBodyParser: this.hasBodyParser,
                    hasCors: this.hasCors,
                    hasHelmet: this.hasHelmet,
                    hasCompression: this.hasCompression,
                    hasSession: this.hasSession,
                    hasPassport: this.hasPassport,
                    hasSocketIO: this.hasSocketIO,
                    hasMongoose: this.hasMongoose,
                    hasSequelize: this.hasSequelize,
                    hasPrisma: this.hasPrisma
                }
            }
        };
    }
    calculateAverageMiddleware() {
        const routes = Array.from(this.routes.values());
        if (routes.length === 0)
            return 0;
        const totalMiddleware = routes.reduce((sum, r) => sum + r.middleware.length, 0);
        return totalMiddleware / routes.length;
    }
}
exports.ExpressAnalyzer = ExpressAnalyzer;
