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
exports.FastAPIAnalyzer = void 0;
const python_analyzer_1 = require("../../languages/python-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class FastAPIAnalyzer extends python_analyzer_1.PythonAnalyzer {
    constructor() {
        super(...arguments);
        this.fastAPIVersion = '';
        this.routes = new Map();
        this.models = new Map();
        this.dependencies = new Map();
        this.middleware = [];
        this.websockets = [];
        this.routers = new Map();
        this.hasUvicorn = false;
        this.hasGunicorn = false;
        this.hasSQLAlchemy = false;
        this.hasTortoise = false;
        this.hasRedis = false;
        this.appInstances = [];
    }
    getAnalyzerName() {
        return 'FastAPI Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['fastapi', 'starlette', 'pydantic', 'uvicorn'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        await this.detectFastAPIVersion();
        this.hasUvicorn = await this.detectPackage('uvicorn');
        this.hasGunicorn = await this.detectPackage('gunicorn');
        this.hasSQLAlchemy = await this.detectPackage('sqlalchemy');
        this.hasTortoise = await this.detectPackage('tortoise-orm');
        this.hasRedis = await this.detectPackage('redis');
        await this.findAppInstances();
        return {
            ...baseDetection,
            frameworks: [...baseDetection.frameworks.filter(f => f.name !== 'fastapi'), {
                    name: 'fastapi',
                    version: this.fastAPIVersion,
                    confidence: 0.98,
                    patterns: ['FastAPI application detected'],
                    configFiles: ['main.py', 'app.py', 'api.py'],
                    dependencies: ['fastapi', 'pydantic', 'starlette']
                }]
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('fastapi-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverRoutes();
        await this.discoverPydanticModels();
        await this.discoverDependencies();
        await this.discoverMiddleware();
        await this.discoverWebSockets();
        await this.discoverRouters();
        const components = new Map();
        for (const [id, route] of this.routes) {
            const node = {
                id,
                name: `${route.method} ${route.path}`,
                type: 'route',
                path: route.handler,
                dependencies: route.dependencies,
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: route.parameters.length + (route.requestBody ? 2 : 0),
                    maintainability: 100 - route.parameters.length * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: route.deprecated ? 5 : 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: route.parameters.length + (route.requestBody ? 2 : 0),
                    lastModified: new Date(),
                    exports: [route.method],
                    imports: route.dependencies,
                    layer: 'presentation',
                    responsibilities: ['HTTP request handling', 'API endpoint'],
                    httpMethods: [route.method],
                    externalCalls: [],
                    tags: route.tags,
                    deprecated: route.deprecated,
                    requestBody: route.requestBody,
                    responses: route.responses,
                    security: route.security
                }
            };
            components.set(id, node);
        }
        for (const [id, model] of this.models) {
            const node = {
                id,
                name: model.name,
                type: 'model',
                path: model.filePath,
                dependencies: [],
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(model.filePath),
                    complexity: model.fields.length + model.validators.length,
                    maintainability: 100 - model.fields.length * 1.5,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: await this.countLinesOfCode(model.filePath),
                    complexity: model.fields.length + model.validators.length,
                    lastModified: new Date(),
                    exports: model.fields.map(f => f.name),
                    imports: [],
                    layer: 'data',
                    responsibilities: ['Data validation', 'Serialization/deserialization'],
                    validators: model.validators,
                    config: model.config
                }
            };
            components.set(id, node);
        }
        for (const [id, dep] of this.dependencies) {
            const node = {
                id,
                name: dep.name,
                type: 'service',
                path: dep.function,
                dependencies: [],
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: 2,
                    maintainability: 90,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: 2,
                    lastModified: new Date(),
                    exports: [dep.name],
                    imports: [],
                    layer: 'business',
                    responsibilities: ['Dependency injection', 'Service provision'],
                    cacheable: dep.cacheable
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildFastAPIConnections();
        const apiEndpoints = this.extractFastAPIEndpoints();
        const databaseConnections = await this.extractDatabaseConnections();
        telemetry_schema_1.telemetry.emit({
            type: 'component_discovered',
            source: { analyzer: this.getAnalyzerName() },
            data: {
                totalComponents: components.size,
                routes: this.routes.size,
                models: this.models.size,
                dependencies: this.dependencies.size,
                middleware: this.middleware.length,
                websockets: this.websockets.length,
                hasUvicorn: this.hasUvicorn,
                hasSQLAlchemy: this.hasSQLAlchemy
            }
        });
        span.end();
        return {
            components: Array.from(components.values()),
            entryPoints: this.findFastAPIEntryPoints(),
            connections,
            layers: this.buildFastAPILayers(),
            apiEndpoints,
            databaseConnections
        };
    }
    async detectFastAPIVersion() {
        const requirementsPaths = [
            'requirements.txt',
            'requirements/base.txt',
            'Pipfile',
            'pyproject.toml'
        ];
        for (const reqPath of requirementsPaths) {
            const fullPath = path.join(this.projectPath, reqPath);
            if (await fs.pathExists(fullPath)) {
                const content = await fs.readFile(fullPath, 'utf-8');
                const versionMatch = content.match(/fastapi(?:==|>=|~=|>)?([\d.]+)/i);
                if (versionMatch) {
                    this.fastAPIVersion = versionMatch[1];
                    break;
                }
            }
        }
    }
    async detectPackage(packageName) {
        const requirementsPaths = [
            'requirements.txt',
            'requirements/base.txt',
            'Pipfile',
            'pyproject.toml'
        ];
        for (const reqPath of requirementsPaths) {
            const fullPath = path.join(this.projectPath, reqPath);
            if (await fs.pathExists(fullPath)) {
                const content = await fs.readFile(fullPath, 'utf-8');
                if (content.toLowerCase().includes(packageName.toLowerCase())) {
                    return true;
                }
            }
        }
        return false;
    }
    async findAppInstances() {
        const appFiles = ['main.py', 'app.py', 'api.py', 'server.py'];
        for (const appFile of appFiles) {
            const fullPath = path.join(this.projectPath, appFile);
            if (await fs.pathExists(fullPath)) {
                const content = await fs.readFile(fullPath, 'utf-8');
                if (content.includes('FastAPI()')) {
                    this.appInstances.push(appFile);
                }
            }
        }
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles.slice(0, 50)) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('FastAPI()') && !this.appInstances.includes(file)) {
                this.appInstances.push(file);
            }
        }
    }
    async discoverRoutes() {
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const routes = this.parseFastAPIRoutes(content, file);
            for (const route of routes) {
                const id = `${route.method}_${route.path.replace(/[/{}/]/g, '_')}`;
                this.routes.set(id, route);
            }
        }
    }
    parseFastAPIRoutes(content, filePath) {
        const routes = [];
        const routeRegex = /@(?:app|router)\.(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']/g;
        const lines = content.split('\n');
        let match;
        while ((match = routeRegex.exec(content)) !== null) {
            const method = match[1].toUpperCase();
            const path = match[2];
            const decoratorIndex = content.substring(0, match.index).split('\n').length;
            let handler = '';
            let summary = '';
            let tags = [];
            let deprecated = false;
            for (let i = decoratorIndex; i < Math.min(decoratorIndex + 10, lines.length); i++) {
                const line = lines[i];
                const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/);
                if (funcMatch) {
                    handler = funcMatch[1];
                    break;
                }
            }
            const decoratorEndIndex = content.indexOf(')', match.index) + 1;
            const decoratorContent = content.substring(match.index, decoratorEndIndex);
            const tagsMatch = decoratorContent.match(/tags\s*=\s*\[([^\]]+)\]/);
            if (tagsMatch) {
                tags = this.parseStringList(tagsMatch[1]);
            }
            const summaryMatch = decoratorContent.match(/summary\s*=\s*["']([^"']+)["']/);
            if (summaryMatch) {
                summary = summaryMatch[1];
            }
            deprecated = decoratorContent.includes('deprecated=True');
            const parameters = this.extractRouteParameters(content, handler);
            const requestBody = this.extractRequestBody(content, handler);
            const dependencies = this.extractRouteDependencies(decoratorContent);
            routes.push({
                path,
                method,
                handler: `${filePath}::${handler}`,
                tags,
                summary,
                deprecated,
                responses: {},
                parameters,
                requestBody,
                dependencies,
                security: []
            });
        }
        return routes;
    }
    extractRouteParameters(content, handler) {
        const parameters = [];
        const funcRegex = new RegExp(`(?:async\\s+)?def\\s+${handler}\\s*\\(([^)]+)\\)`);
        const funcMatch = content.match(funcRegex);
        if (funcMatch) {
            const params = funcMatch[1];
            const paramRegex = /(\w+)\s*:\s*([^=,]+)(?:\s*=\s*([^,]+))?/g;
            let match;
            while ((match = paramRegex.exec(params)) !== null) {
                const name = match[1];
                const type = match[2].trim();
                const defaultValue = match[3]?.trim();
                if (name === 'request' || name === 'response' || name === 'db')
                    continue;
                let location = 'query';
                if (type.includes('Path'))
                    location = 'path';
                if (type.includes('Query'))
                    location = 'query';
                if (type.includes('Header'))
                    location = 'header';
                if (type.includes('Cookie'))
                    location = 'cookie';
                parameters.push({
                    name,
                    location,
                    type: type.replace(/.*\[(.+)\].*/, '$1'),
                    required: !defaultValue || defaultValue === '...',
                    default: defaultValue && defaultValue !== '...' ? defaultValue : undefined,
                    validators: []
                });
            }
        }
        return parameters;
    }
    extractRequestBody(content, handler) {
        const funcRegex = new RegExp(`(?:async\\s+)?def\\s+${handler}\\s*\\(([^)]+)\\)`);
        const funcMatch = content.match(funcRegex);
        if (funcMatch) {
            const params = funcMatch[1];
            const modelRegex = /(\w+)\s*:\s*([A-Z]\w+)(?:\s*=|,|\))/;
            const match = params.match(modelRegex);
            if (match && !['Request', 'Response', 'Session'].includes(match[2])) {
                return {
                    model: match[2],
                    required: true,
                    mediaType: 'application/json'
                };
            }
        }
        return undefined;
    }
    extractRouteDependencies(decoratorContent) {
        const dependencies = [];
        const dependsMatch = decoratorContent.match(/dependencies\s*=\s*\[([^\]]+)\]/);
        if (dependsMatch) {
            const depList = dependsMatch[1];
            const depRegex = /Depends\s*\(\s*(\w+)/g;
            let match;
            while ((match = depRegex.exec(depList)) !== null) {
                dependencies.push(match[1]);
            }
        }
        return dependencies;
    }
    async discoverPydanticModels() {
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('from pydantic') || content.includes('import pydantic')) {
                const models = this.parsePydanticModels(content, file);
                for (const model of models) {
                    this.models.set(model.name, model);
                }
            }
        }
    }
    parsePydanticModels(content, filePath) {
        const models = [];
        const modelRegex = /class\s+(\w+)\s*\(([^)]*BaseModel[^)]*)\)\s*:/g;
        let match;
        while ((match = modelRegex.exec(content)) !== null) {
            const name = match[1];
            const baseModel = match[2].trim();
            const model = {
                name,
                filePath,
                baseModel,
                fields: this.parsePydanticFields(content, name),
                validators: this.parsePydanticValidators(content, name),
                config: this.parsePydanticConfig(content, name),
                examples: []
            };
            models.push(model);
        }
        return models;
    }
    parsePydanticFields(content, className) {
        const fields = [];
        const classRegex = new RegExp(`class\\s+${className}\\s*\\([^)]+\\)\\s*:([^\\n]*(?:\\n(?!class)[^\\n]*)*)`, 's');
        const classMatch = content.match(classRegex);
        if (classMatch) {
            const classContent = classMatch[1];
            const fieldRegex = /(\w+)\s*:\s*([^=\n]+)(?:\s*=\s*([^\n]+))?/g;
            let match;
            while ((match = fieldRegex.exec(classContent)) !== null) {
                const name = match[1];
                const type = match[2].trim();
                const defaultValue = match[3]?.trim();
                if (name.startsWith('_') || name === 'Config')
                    continue;
                fields.push({
                    name,
                    type,
                    required: !defaultValue || defaultValue === '...',
                    default: defaultValue && defaultValue !== '...' ? defaultValue : undefined,
                    validators: [],
                    constraints: this.extractFieldConstraints(defaultValue)
                });
            }
        }
        return fields;
    }
    extractFieldConstraints(defaultValue) {
        const constraints = {};
        if (!defaultValue)
            return constraints;
        if (defaultValue.includes('Field(')) {
            const gtMatch = defaultValue.match(/gt\s*=\s*(\d+)/);
            if (gtMatch)
                constraints.gt = parseInt(gtMatch[1]);
            const geMatch = defaultValue.match(/ge\s*=\s*(\d+)/);
            if (geMatch)
                constraints.ge = parseInt(geMatch[1]);
            const ltMatch = defaultValue.match(/lt\s*=\s*(\d+)/);
            if (ltMatch)
                constraints.lt = parseInt(ltMatch[1]);
            const leMatch = defaultValue.match(/le\s*=\s*(\d+)/);
            if (leMatch)
                constraints.le = parseInt(leMatch[1]);
            const minLengthMatch = defaultValue.match(/min_length\s*=\s*(\d+)/);
            if (minLengthMatch)
                constraints.minLength = parseInt(minLengthMatch[1]);
            const maxLengthMatch = defaultValue.match(/max_length\s*=\s*(\d+)/);
            if (maxLengthMatch)
                constraints.maxLength = parseInt(maxLengthMatch[1]);
            const regexMatch = defaultValue.match(/regex\s*=\s*["']([^"']+)["']/);
            if (regexMatch)
                constraints.regex = regexMatch[1];
        }
        return constraints;
    }
    parsePydanticValidators(content, className) {
        const validators = [];
        const validatorRegex = new RegExp(`@validator\\(['"]?(\\w+)['"]?`, 'g');
        let match;
        while ((match = validatorRegex.exec(content)) !== null) {
            validators.push(match[1]);
        }
        if (content.includes('@root_validator')) {
            validators.push('root_validator');
        }
        return validators;
    }
    parsePydanticConfig(content, className) {
        const config = {};
        const configRegex = new RegExp(`class\\s+${className}[^}]+class\\s+Config\\s*:([^\\n]*(?:\\n(?!\\s*class)[^\\n]*)*)`, 's');
        const configMatch = content.match(configRegex);
        if (configMatch) {
            const configContent = configMatch[1];
            if (configContent.includes('orm_mode = True')) {
                config.orm_mode = true;
            }
            if (configContent.includes('use_enum_values = True')) {
                config.use_enum_values = true;
            }
            if (configContent.includes('validate_assignment = True')) {
                config.validate_assignment = true;
            }
            const schemaExtraMatch = configContent.match(/schema_extra\s*=\s*({[^}]+})/);
            if (schemaExtraMatch) {
                config.schema_extra = schemaExtraMatch[1];
            }
        }
        return config;
    }
    async discoverDependencies() {
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles.slice(0, 50)) {
            const content = await fs.readFile(file, 'utf-8');
            const deps = this.parseDependencies(content, file);
            for (const dep of deps) {
                this.dependencies.set(dep.name, dep);
            }
        }
    }
    parseDependencies(content, filePath) {
        const dependencies = [];
        const depRegex = /(?:async\s+)?def\s+(\w+)\s*\([^)]*\)\s*(?:->\s*[^:]+)?:/g;
        let match;
        while ((match = depRegex.exec(content)) !== null) {
            const name = match[1];
            if (content.includes(`Depends(${name})`) || content.includes(`Depends(${name},`)) {
                dependencies.push({
                    name,
                    function: `${filePath}::${name}`,
                    scope: 'request',
                    cacheable: content.includes(`Depends(${name}, use_cache=True)`)
                });
            }
        }
        return dependencies;
    }
    async discoverMiddleware() {
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('@app.middleware') || content.includes('app.add_middleware')) {
                const middlewares = this.parseMiddleware(content, file);
                this.middleware.push(...middlewares);
            }
        }
    }
    parseMiddleware(content, filePath) {
        const middleware = [];
        const funcMiddlewareRegex = /@app\.middleware\(["'](\w+)["']\)\s*(?:async\s+)?def\s+(\w+)/g;
        let match;
        while ((match = funcMiddlewareRegex.exec(content)) !== null) {
            middleware.push({
                name: match[2],
                type: 'function',
                path: filePath,
                priority: 50,
                async: content.includes(`async def ${match[2]}`)
            });
        }
        const classMiddlewareRegex = /app\.add_middleware\((\w+)/g;
        while ((match = classMiddlewareRegex.exec(content)) !== null) {
            middleware.push({
                name: match[1],
                type: 'class',
                path: filePath,
                priority: 50,
                async: true
            });
        }
        return middleware;
    }
    async discoverWebSockets() {
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('@app.websocket') || content.includes('@router.websocket')) {
                const websockets = this.parseWebSockets(content, file);
                this.websockets.push(...websockets);
            }
        }
    }
    parseWebSockets(content, filePath) {
        const websockets = [];
        const wsRegex = /@(?:app|router)\.websocket\(["']([^"']+)["']\)\s*(?:async\s+)?def\s+(\w+)/g;
        let match;
        while ((match = wsRegex.exec(content)) !== null) {
            websockets.push({
                path: match[1],
                handler: `${filePath}::${match[2]}`,
                accepts: ['json', 'text', 'bytes'],
                events: []
            });
        }
        return websockets;
    }
    async discoverRouters() {
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('APIRouter()')) {
                const routerName = this.extractRouterName(content);
                if (routerName) {
                    this.routers.set(routerName, {
                        file: file,
                        prefix: this.extractRouterPrefix(content),
                        tags: this.extractRouterTags(content)
                    });
                }
            }
        }
    }
    extractRouterName(content) {
        const match = content.match(/(\w+)\s*=\s*APIRouter\(/);
        return match ? match[1] : null;
    }
    extractRouterPrefix(content) {
        const match = content.match(/prefix\s*=\s*["']([^"']+)["']/);
        return match ? match[1] : '';
    }
    extractRouterTags(content) {
        const match = content.match(/tags\s*=\s*\[([^\]]+)\]/);
        return match ? this.parseStringList(match[1]) : [];
    }
    parseStringList(content) {
        const items = [];
        const regex = /["']([^"']+)["']/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            items.push(match[1]);
        }
        return items;
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
    async buildFastAPIConnections() {
        const connections = [];
        for (const [routeId, route] of this.routes) {
            if (route.requestBody) {
                connections.push({
                    from: routeId,
                    to: route.requestBody.model,
                    type: 'data_flow',
                    weight: 1,
                    metadata: {
                        callSites: 1
                    }
                });
            }
            for (const dep of route.dependencies) {
                connections.push({
                    from: routeId,
                    to: dep,
                    type: 'function_call',
                    weight: 1,
                    metadata: {
                        callSites: 1
                    }
                });
            }
        }
        for (const [modelId, model] of this.models) {
            for (const field of model.fields) {
                const fieldType = field.type.replace('Optional[', '').replace(']', '').replace('List[', '').trim();
                if (this.models.has(fieldType)) {
                    connections.push({
                        from: modelId,
                        to: fieldType,
                        type: 'data_flow',
                        weight: 1,
                        metadata: {
                            callSites: 1,
                            dataFlow: field.name
                        }
                    });
                }
            }
        }
        return connections;
    }
    extractFastAPIEndpoints() {
        const endpoints = [];
        for (const [id, route] of this.routes) {
            endpoints.push({
                id,
                path: route.path,
                method: route.method,
                description: route.summary || `${route.method} ${route.path}`,
                handler: route.handler,
                parameters: route.parameters.map(p => ({
                    name: p.name,
                    type: p.location === 'cookie' ? 'header' : p.location,
                    dataType: p.type,
                    required: p.required,
                    description: p.description
                })),
                statusCodes: Object.entries(route.responses).map(([code, desc]) => ({
                    code: parseInt(code),
                    description: desc
                })),
                middleware: this.middleware.map(m => m.name),
                authentication: route.security.length > 0 ? { type: 'bearer', required: true } : { type: 'none', required: false },
                rateLimit: undefined,
                deprecated: route.deprecated,
                componentId: id
            });
        }
        for (const ws of this.websockets) {
            endpoints.push({
                id: `ws-${ws.path.replace(/\//g, '_')}`,
                path: ws.path,
                method: 'GET',
                description: `WebSocket endpoint at ${ws.path}`,
                handler: ws.handler,
                parameters: [],
                statusCodes: [{ code: 101, description: 'Switching Protocols' }],
                middleware: [],
                authentication: { type: 'none', required: false },
                rateLimit: undefined,
                deprecated: false,
                componentId: `fastapi-${ws.handler}`
            });
        }
        return endpoints;
    }
    async extractDatabaseConnections() {
        const connections = [];
        if (this.hasSQLAlchemy) {
            connections.push({
                id: 'sqlalchemy-connection',
                name: 'SQLAlchemy',
                type: 'postgresql',
                host: 'localhost',
                port: 5432,
                database: 'app',
                schema: 'public',
                tables: [],
                usage: [],
                componentIds: []
            });
        }
        if (this.hasTortoise) {
            connections.push({
                id: 'tortoise-connection',
                name: 'Tortoise ORM',
                type: 'postgresql',
                host: 'localhost',
                port: 5432,
                database: 'app',
                schema: 'public',
                tables: [],
                usage: [],
                componentIds: []
            });
        }
        if (this.hasRedis) {
            connections.push({
                id: 'redis-connection',
                name: 'Redis',
                type: 'redis',
                host: 'localhost',
                port: 6379,
                database: '0',
                schema: '',
                tables: [],
                usage: [],
                componentIds: []
            });
        }
        return connections;
    }
    findFastAPIEntryPoints() {
        const entryPoints = [];
        entryPoints.push(...this.appInstances);
        if (this.hasUvicorn) {
            entryPoints.push('uvicorn:app');
        }
        if (this.hasGunicorn) {
            entryPoints.push('gunicorn:app');
        }
        return entryPoints;
    }
    buildFastAPILayers() {
        return {
            'routes': Array.from(this.routes.keys()),
            'models': Array.from(this.models.keys()),
            'dependencies': Array.from(this.dependencies.keys()),
            'middleware': this.middleware.map(m => m.name),
            'websockets': this.websockets.map(ws => ws.path),
            'routers': Array.from(this.routers.keys())
        };
    }
    async analyzePerformance() {
        return {
            fastapi: {
                routesCount: this.routes.size,
                modelsCount: this.models.size,
                dependenciesCount: this.dependencies.size,
                middlewareCount: this.middleware.length,
                websocketsCount: this.websockets.length,
                averageParametersPerRoute: this.calculateAverageParameters(),
                averageFieldsPerModel: this.calculateAverageFields(),
                features: {
                    hasUvicorn: this.hasUvicorn,
                    hasGunicorn: this.hasGunicorn,
                    hasSQLAlchemy: this.hasSQLAlchemy,
                    hasTortoise: this.hasTortoise,
                    hasRedis: this.hasRedis
                }
            }
        };
    }
    calculateAverageParameters() {
        const routes = Array.from(this.routes.values());
        if (routes.length === 0)
            return 0;
        const totalParams = routes.reduce((sum, r) => sum + r.parameters.length, 0);
        return totalParams / routes.length;
    }
    calculateAverageFields() {
        const models = Array.from(this.models.values());
        if (models.length === 0)
            return 0;
        const totalFields = models.reduce((sum, m) => sum + m.fields.length, 0);
        return totalFields / models.length;
    }
}
exports.FastAPIAnalyzer = FastAPIAnalyzer;
