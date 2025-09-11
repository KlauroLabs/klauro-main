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
exports.LaravelAnalyzer = void 0;
const php_analyzer_1 = require("../../languages/php-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class LaravelAnalyzer extends php_analyzer_1.PHPAnalyzer {
    constructor() {
        super(...arguments);
        this.laravelVersion = '';
        this.controllers = new Map();
        this.models = new Map();
        this.routes = new Map();
        this.migrations = new Map();
        this.services = new Map();
        this.commands = new Map();
        this.hasEloquent = true;
        this.hasHorizon = false;
        this.hasSanctum = false;
        this.hasPassport = false;
        this.hasBroadcasting = false;
    }
    getAnalyzerName() {
        return 'Laravel Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['laravel', 'eloquent', 'blade', 'horizon', 'sanctum', 'passport'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        await this.detectLaravelVersion();
        return {
            ...baseDetection,
            frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('laravel')), {
                    name: 'laravel',
                    version: this.laravelVersion,
                    confidence: 0.95,
                    patterns: ['Laravel application detected'],
                    configFiles: ['composer.json', 'artisan', 'config/app.php', '.env'],
                    dependencies: ['laravel/framework']
                }]
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('laravel-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverControllers();
        await this.discoverModels();
        await this.discoverRoutes();
        await this.discoverMigrations();
        await this.discoverServices();
        await this.discoverCommands();
        const components = new Map();
        for (const [id, controller] of this.controllers) {
            const node = {
                id,
                name: controller.name,
                type: 'controller',
                path: controller.filePath,
                language: 'php',
                framework: 'laravel',
                dependencies: controller.middleware,
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: controller.methods.length + controller.middleware.length,
                    maintainability: 100 - controller.methods.length * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: controller.methods.length,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'presentation',
                    responsibilities: ['Handle HTTP requests and return responses'],
                    frameworkType: 'controller',
                    namespace: controller.namespace,
                    methods: controller.methods.map(m => m.name),
                    resourceful: controller.resourceful
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
                language: 'php',
                framework: 'laravel',
                dependencies: model.relationships.map(r => r.relatedModel),
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: model.fillable.length + model.relationships.length,
                    maintainability: 100 - (model.fillable.length + model.relationships.length) * 1.5,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: model.fillable.length + model.relationships.length,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'data',
                    responsibilities: ['Data model and database interactions'],
                    frameworkType: 'model',
                    table: model.table
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
                language: 'php',
                framework: 'laravel',
                dependencies: service.bindings,
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: service.bindings.length + service.provides.length,
                    maintainability: 100 - service.bindings.length * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: service.bindings.length + service.provides.length,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'business',
                    responsibilities: ['Service provider configuration and bindings'],
                    frameworkType: 'service-provider'
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildLaravelConnections();
        const apiEndpoints = this.extractLaravelEndpoints();
        const databaseConnections = await this.extractDatabaseConnections();
        telemetry_schema_1.telemetry.emit({
            type: 'component_discovery_completed',
            source: { analyzer: this.getAnalyzerName() },
            data: {
                totalComponents: components.size,
                controllers: this.controllers.size,
                models: this.models.size,
                routes: this.routes.size,
                migrations: this.migrations.size,
                services: this.services.size,
                commands: this.commands.size
            }
        });
        span.end();
        return {
            components: Array.from(components.values()),
            entryPoints: ['public/index.php', 'artisan'],
            connections,
            layers: this.buildLaravelLayers(),
            apiEndpoints,
            databaseConnections
        };
    }
    async detectLaravelVersion() {
        const composerPath = path.join(this.projectPath, 'composer.json');
        if (await fs.pathExists(composerPath)) {
            const content = await fs.readFile(composerPath, 'utf-8');
            try {
                const composer = JSON.parse(content);
                const laravelPackage = composer.require?.['laravel/framework'];
                if (laravelPackage) {
                    this.laravelVersion = laravelPackage.replace(/[\^~]/, '');
                }
                this.hasHorizon = 'laravel/horizon' in (composer.require || {});
                this.hasSanctum = 'laravel/sanctum' in (composer.require || {});
                this.hasPassport = 'laravel/passport' in (composer.require || {});
            }
            catch (e) {
            }
        }
    }
    async discoverControllers() {
        const controllerPath = path.join(this.projectPath, 'app/Http/Controllers');
        if (await fs.pathExists(controllerPath)) {
            const phpFiles = await this.findFiles(['app/Http/Controllers/**/*.php'], []);
            for (const file of phpFiles) {
                const content = await fs.readFile(file, 'utf-8');
                const controller = this.parseController(content, file);
                if (controller) {
                    this.controllers.set(controller.name, controller);
                }
            }
        }
    }
    parseController(content, filePath) {
        const classMatch = content.match(/class\s+(\w+)\s+extends\s+Controller/);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const namespaceMatch = content.match(/namespace\s+([^;]+);/);
        return {
            name,
            filePath,
            namespace: namespaceMatch?.[1],
            methods: this.parseControllerMethods(content),
            middleware: this.parseControllerMiddleware(content),
            resourceful: this.isResourceController(content)
        };
    }
    parseControllerMethods(content) {
        const methods = [];
        const methodRegex = /public\s+function\s+(\w+)\s*\(([^)]*)\)/g;
        let match;
        while ((match = methodRegex.exec(content)) !== null) {
            const name = match[1];
            const params = match[2];
            methods.push({
                name,
                parameters: this.parseMethodParameters(params),
                middleware: []
            });
        }
        return methods;
    }
    parseMethodParameters(params) {
        if (!params.trim())
            return [];
        return params.split(',').map(p => {
            const paramMatch = p.match(/\$(\w+)/);
            return paramMatch ? paramMatch[1] : '';
        }).filter(Boolean);
    }
    parseControllerMiddleware(content) {
        const middleware = [];
        const constructorMatch = content.match(/public\s+function\s+__construct[^{]*\{([^}]+)\}/s);
        if (constructorMatch) {
            const constructorBody = constructorMatch[1];
            const middlewareRegex = /\$this->middleware\(['"]([^'"]+)['"]/g;
            let match;
            while ((match = middlewareRegex.exec(constructorBody)) !== null) {
                middleware.push(match[1]);
            }
        }
        return middleware;
    }
    isResourceController(content) {
        const resourceMethods = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
        let count = 0;
        for (const method of resourceMethods) {
            if (content.includes(`public function ${method}(`)) {
                count++;
            }
        }
        return count >= 5;
    }
    async discoverModels() {
        const modelsPath = path.join(this.projectPath, 'app/Models');
        const legacyModelsPath = path.join(this.projectPath, 'app');
        let phpFiles = [];
        if (await fs.pathExists(modelsPath)) {
            phpFiles = await this.findFiles(['app/Models/**/*.php'], []);
        }
        else if (await fs.pathExists(legacyModelsPath)) {
            phpFiles = await this.findFiles(['app/*.php'], []);
        }
        for (const file of phpFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('extends Model')) {
                const model = this.parseModel(content, file);
                if (model) {
                    this.models.set(model.name, model);
                }
            }
        }
    }
    parseModel(content, filePath) {
        const classMatch = content.match(/class\s+(\w+)\s+extends\s+Model/);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const tableMatch = content.match(/protected\s+\$table\s*=\s*['"]([^'"]+)['"]/);
        return {
            name,
            filePath,
            table: tableMatch?.[1],
            fillable: this.parseArrayProperty(content, 'fillable'),
            guarded: this.parseArrayProperty(content, 'guarded'),
            hidden: this.parseArrayProperty(content, 'hidden'),
            casts: this.parseCastsProperty(content),
            relationships: this.parseModelRelationships(content)
        };
    }
    parseArrayProperty(content, propertyName) {
        const regex = new RegExp(`protected\\s+\\$${propertyName}\\s*=\\s*\\[([^\\]]+)\\]`, 's');
        const match = content.match(regex);
        if (!match)
            return [];
        const items = match[1];
        const itemRegex = /['"]([^'"]+)['"]/g;
        const result = [];
        let itemMatch;
        while ((itemMatch = itemRegex.exec(items)) !== null) {
            result.push(itemMatch[1]);
        }
        return result;
    }
    parseCastsProperty(content) {
        const casts = {};
        const castsMatch = content.match(/protected\s+\$casts\s*=\s*\[([^\]]+)\]/s);
        if (castsMatch) {
            const castsContent = castsMatch[1];
            const castRegex = /['"](\w+)['"]\s*=>\s*['"]([^'"]+)['"]/g;
            let match;
            while ((match = castRegex.exec(castsContent)) !== null) {
                casts[match[1]] = match[2];
            }
        }
        return casts;
    }
    parseModelRelationships(content) {
        const relationships = [];
        const relationTypes = ['hasOne', 'hasMany', 'belongsTo', 'belongsToMany', 'morphTo', 'morphMany'];
        for (const relationType of relationTypes) {
            const regex = new RegExp(`public\\s+function\\s+(\\w+)\\s*\\([^)]*\\)[^{]*\\{[^}]*return\\s+\\$this->${relationType}\\(([^)]+)\\)`, 'g');
            let match;
            while ((match = regex.exec(content)) !== null) {
                const name = match[1];
                const params = match[2];
                const modelMatch = params.match(/(\w+)::class/);
                relationships.push({
                    name,
                    type: relationType,
                    relatedModel: modelMatch ? modelMatch[1] : ''
                });
            }
        }
        return relationships;
    }
    async discoverRoutes() {
        const routeFiles = [
            'routes/web.php',
            'routes/api.php',
            'routes/channels.php',
            'routes/console.php'
        ];
        for (const routeFile of routeFiles) {
            const fullPath = path.join(this.projectPath, routeFile);
            if (await fs.pathExists(fullPath)) {
                const content = await fs.readFile(fullPath, 'utf-8');
                const routes = this.parseRoutes(content, routeFile);
                for (const route of routes) {
                    const id = `${route.methods.join('_')}_${route.uri.replace(/[/{}/]/g, '_')}`;
                    this.routes.set(id, route);
                }
            }
        }
    }
    parseRoutes(content, filePath) {
        const routes = [];
        const routeRegex = /Route::(get|post|put|patch|delete|any|match)\s*\(\s*['"]([^'"]+)['"]/g;
        let match;
        while ((match = routeRegex.exec(content)) !== null) {
            const method = match[1];
            const uri = match[2];
            routes.push({
                uri,
                methods: method === 'any' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [method.toUpperCase()],
                middleware: []
            });
        }
        const resourceRegex = /Route::resource\s*\(\s*['"]([^'"]+)['"],\s*['"]?(\w+)/g;
        while ((match = resourceRegex.exec(content)) !== null) {
            const uri = match[1];
            const controller = match[2];
            routes.push({
                uri,
                methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
                controller,
                middleware: []
            });
        }
        return routes;
    }
    async discoverMigrations() {
        const migrationsPath = path.join(this.projectPath, 'database/migrations');
        if (await fs.pathExists(migrationsPath)) {
            const phpFiles = await this.findFiles(['database/migrations/**/*.php'], []);
            for (const file of phpFiles) {
                const content = await fs.readFile(file, 'utf-8');
                const migration = this.parseMigration(content, file);
                if (migration) {
                    this.migrations.set(migration.name, migration);
                }
            }
        }
    }
    parseMigration(content, filePath) {
        const classMatch = content.match(/class\s+(\w+)\s+extends\s+Migration/);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const fileName = path.basename(filePath);
        const timestampMatch = fileName.match(/^(\d{4}_\d{2}_\d{2}_\d{6})/);
        return {
            name,
            filePath,
            operations: this.parseMigrationOperations(content),
            timestamp: timestampMatch ? timestampMatch[1] : ''
        };
    }
    parseMigrationOperations(content) {
        const operations = [];
        const operationTypes = ['create', 'table', 'dropIfExists', 'drop', 'rename', 'addColumn', 'dropColumn'];
        for (const op of operationTypes) {
            if (content.includes(`Schema::${op}`)) {
                operations.push(op);
            }
        }
        return operations;
    }
    async discoverServices() {
        const providersPath = path.join(this.projectPath, 'app/Providers');
        if (await fs.pathExists(providersPath)) {
            const phpFiles = await this.findFiles(['app/Providers/**/*.php'], []);
            for (const file of phpFiles) {
                const content = await fs.readFile(file, 'utf-8');
                const service = this.parseServiceProvider(content, file);
                if (service) {
                    this.services.set(service.name, service);
                }
            }
        }
    }
    parseServiceProvider(content, filePath) {
        const classMatch = content.match(/class\s+(\w+)\s+extends\s+ServiceProvider/);
        if (!classMatch)
            return null;
        return {
            name: classMatch[1],
            filePath,
            bindings: [],
            provides: []
        };
    }
    async discoverCommands() {
        const commandsPath = path.join(this.projectPath, 'app/Console/Commands');
        if (await fs.pathExists(commandsPath)) {
            const phpFiles = await this.findFiles(['app/Console/Commands/**/*.php'], []);
            for (const file of phpFiles) {
                const content = await fs.readFile(file, 'utf-8');
                const command = this.parseCommand(content, file);
                if (command) {
                    this.commands.set(command.name, command);
                }
            }
        }
    }
    parseCommand(content, filePath) {
        const classMatch = content.match(/class\s+(\w+)\s+extends\s+Command/);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const signatureMatch = content.match(/protected\s+\$signature\s*=\s*['"]([^'"]+)['"]/);
        const descriptionMatch = content.match(/protected\s+\$description\s*=\s*['"]([^'"]+)['"]/);
        return {
            name,
            signature: signatureMatch?.[1] || '',
            description: descriptionMatch?.[1],
            filePath
        };
    }
    async buildLaravelConnections() {
        const connections = [];
        for (const [controllerId] of this.controllers) {
            for (const [modelId] of this.models) {
                connections.push({
                    from: controllerId,
                    to: modelId,
                    type: 'uses-model',
                    protocol: 'laravel',
                    metadata: { callSites: 1, relationship: 'controller-model' }
                });
            }
        }
        for (const [modelId, model] of this.models) {
            for (const rel of model.relationships) {
                if (rel.relatedModel) {
                    connections.push({
                        from: modelId,
                        to: rel.relatedModel,
                        type: 'data-relationship',
                        protocol: 'eloquent',
                        metadata: { callSites: 1, relationType: rel.type }
                    });
                }
            }
        }
        for (const [routeId, route] of this.routes) {
            if (route.controller) {
                connections.push({
                    from: routeId,
                    to: route.controller,
                    type: 'route-controller',
                    protocol: 'laravel',
                    metadata: {
                        callSites: 1,
                        methods: route.methods
                    }
                });
            }
        }
        return connections;
    }
    extractLaravelEndpoints() {
        const endpoints = [];
        for (const [id, route] of this.routes) {
            for (const method of route.methods) {
                endpoints.push({
                    id: `${id}-${method.toLowerCase()}`,
                    path: route.uri,
                    method: method,
                    description: `Laravel ${method} endpoint for ${route.uri}`,
                    handler: route.controller || route.action || 'Closure',
                    parameters: [],
                    statusCodes: [{ code: 200, description: 'Success' }],
                    middleware: route.middleware,
                    authentication: {
                        type: (route.middleware.includes('auth') || this.hasSanctum || this.hasPassport) ? 'jwt' : 'none',
                        required: route.middleware.includes('auth') || this.hasSanctum || this.hasPassport
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
                id: 'laravel-eloquent',
                name: 'Laravel Eloquent ORM',
                type: 'mysql',
                host: 'localhost',
                port: 3306,
                database: 'laravel',
                schema: '',
                tables: Array.from(this.models.keys()),
                usage: [],
                componentIds: []
            }];
    }
    buildLaravelLayers() {
        return {
            'controllers': Array.from(this.controllers.keys()),
            'models': Array.from(this.models.keys()),
            'routes': Array.from(this.routes.keys()),
            'migrations': Array.from(this.migrations.keys()),
            'services': Array.from(this.services.keys()),
            'commands': Array.from(this.commands.keys())
        };
    }
    async analyzePerformance() {
        return {
            laravel: {
                controllersCount: this.controllers.size,
                modelsCount: this.models.size,
                routesCount: this.routes.size,
                migrationsCount: this.migrations.size,
                servicesCount: this.services.size,
                commandsCount: this.commands.size,
                averageMethodsPerController: this.calculateAverageMethodsPerController(),
                averageRelationshipsPerModel: this.calculateAverageRelationshipsPerModel(),
                features: {
                    hasEloquent: this.hasEloquent,
                    hasHorizon: this.hasHorizon,
                    hasSanctum: this.hasSanctum,
                    hasPassport: this.hasPassport,
                    hasBroadcasting: this.hasBroadcasting
                }
            }
        };
    }
    calculateAverageMethodsPerController() {
        const controllers = Array.from(this.controllers.values());
        if (controllers.length === 0)
            return 0;
        const totalMethods = controllers.reduce((sum, c) => sum + c.methods.length, 0);
        return totalMethods / controllers.length;
    }
    calculateAverageRelationshipsPerModel() {
        const models = Array.from(this.models.values());
        if (models.length === 0)
            return 0;
        const totalRelationships = models.reduce((sum, m) => sum + m.relationships.length, 0);
        return totalRelationships / models.length;
    }
}
exports.LaravelAnalyzer = LaravelAnalyzer;
