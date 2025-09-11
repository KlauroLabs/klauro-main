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
exports.NestJSAnalyzer = void 0;
const typescript_javascript_analyzer_1 = require("../../languages/typescript-javascript-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class NestJSAnalyzer extends typescript_javascript_analyzer_1.TypeScriptJavaScriptAnalyzer {
    constructor() {
        super(...arguments);
        this.nestVersion = '';
        this.modules = new Map();
        this.controllers = new Map();
        this.providers = new Map();
        this.guards = new Map();
        this.interceptors = new Map();
        this.pipes = new Map();
        this.filters = new Map();
        this.entities = new Map();
        this.hasTypeORM = false;
        this.hasMikroORM = false;
        this.hasPrisma = false;
        this.hasMongoose = false;
        this.hasGraphQL = false;
        this.hasMicroservices = false;
        this.hasWebSockets = false;
        this.hasSwagger = false;
    }
    getAnalyzerName() {
        return 'NestJS Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['@nestjs/core', '@nestjs/common', '@nestjs/platform-express', '@nestjs/typeorm', '@nestjs/graphql'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        await this.detectNestVersion();
        await this.detectNestPackages();
        return {
            ...baseDetection,
            frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('nest')), {
                    name: 'nestjs',
                    version: this.nestVersion,
                    confidence: 0.98,
                    patterns: ['NestJS application detected'],
                    configFiles: ['nest-cli.json', 'tsconfig.json', 'main.ts', 'app.module.ts'],
                    dependencies: ['@nestjs/core', '@nestjs/common']
                }]
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('nestjs-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverModules();
        await this.discoverControllers();
        await this.discoverProviders();
        await this.discoverGuards();
        await this.discoverInterceptors();
        await this.discoverPipes();
        await this.discoverFilters();
        await this.discoverEntities();
        const components = new Map();
        for (const [id, module] of this.modules) {
            const node = {
                id,
                name: module.name,
                type: 'utility',
                path: module.filePath,
                language: 'typescript',
                framework: 'nestjs',
                dependencies: module.imports,
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(module.filePath),
                    complexity: module.controllers.length + module.providers.length,
                    maintainability: 100 - (module.controllers.length + module.providers.length) * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: module.controllers.length + module.providers.length,
                    lastModified: new Date(),
                    exports: module.exports,
                    imports: module.imports,
                    layer: 'infrastructure',
                    responsibilities: ['Module organization and dependency injection'],
                    frameworkType: 'module',
                    controllers: module.controllers,
                    isGlobal: module.isGlobal,
                    isDynamic: module.isDynamic
                }
            };
            components.set(id, node);
        }
        for (const [id, controller] of this.controllers) {
            const node = {
                id,
                name: controller.name,
                type: 'controller',
                path: controller.filePath,
                language: 'typescript',
                framework: 'nestjs',
                dependencies: [],
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(controller.filePath),
                    complexity: controller.methods.length + controller.guards.length,
                    maintainability: 100 - controller.methods.length * 3,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: controller.methods.length + controller.guards.length,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'presentation',
                    responsibilities: ['Handle HTTP requests and responses'],
                    frameworkType: 'controller',
                    path: controller.path,
                    methods: controller.methods.map(m => m.name),
                    guards: controller.guards
                }
            };
            components.set(id, node);
        }
        for (const [id, provider] of this.providers) {
            const node = {
                id,
                name: provider.name,
                type: provider.type === 'service' ? 'service' : 'utility',
                path: provider.filePath,
                language: 'typescript',
                framework: 'nestjs',
                dependencies: provider.dependencies,
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(provider.filePath),
                    complexity: provider.dependencies.length + 2,
                    maintainability: 100 - provider.dependencies.length * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: provider.dependencies.length + 2,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'business',
                    responsibilities: ['Service provider and business logic'],
                    frameworkType: provider.type,
                    scope: provider.scope
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
                language: 'typescript',
                framework: 'nestjs',
                dependencies: entity.relations.map(r => r.to),
                dependents: [],
                metrics: {
                    linesOfCode: await this.countLinesOfCode(entity.filePath),
                    complexity: entity.columns.length + entity.relations.length,
                    maintainability: 100 - (entity.columns.length + entity.relations.length) * 1.5,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: entity.columns.length + entity.relations.length,
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    layer: 'data',
                    responsibilities: ['Data entity and database mapping'],
                    frameworkType: 'entity',
                    tableName: entity.tableName,
                    columns: entity.columns.map(c => c.name),
                    relations: entity.relations.map(r => r.name)
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildNestConnections();
        const apiEndpoints = this.extractNestEndpoints();
        const databaseConnections = await this.extractDatabaseConnections();
        telemetry_schema_1.telemetry.emit({
            type: 'component_discovery_completed',
            source: { analyzer: this.getAnalyzerName() },
            data: {
                totalComponents: components.size,
                modules: this.modules.size,
                controllers: this.controllers.size,
                providers: this.providers.size,
                guards: this.guards.size,
                interceptors: this.interceptors.size,
                pipes: this.pipes.size,
                filters: this.filters.size,
                entities: this.entities.size,
                hasTypeORM: this.hasTypeORM,
                hasGraphQL: this.hasGraphQL
            }
        });
        span.end();
        return {
            components: Array.from(components.values()),
            entryPoints: this.findNestEntryPoints(),
            connections,
            layers: this.buildNestLayers(),
            apiEndpoints,
            databaseConnections
        };
    }
    async detectNestVersion() {
        const packageJsonPath = path.join(this.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            const packageJson = await fs.readJson(packageJsonPath);
            const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
            if (dependencies['@nestjs/core']) {
                this.nestVersion = dependencies['@nestjs/core'].replace(/[\^~]/, '');
            }
        }
    }
    async detectNestPackages() {
        const packageJsonPath = path.join(this.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            const packageJson = await fs.readJson(packageJsonPath);
            const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
            this.hasTypeORM = '@nestjs/typeorm' in dependencies;
            this.hasMikroORM = '@mikro-orm/nestjs' in dependencies;
            this.hasPrisma = '@prisma/client' in dependencies;
            this.hasMongoose = '@nestjs/mongoose' in dependencies;
            this.hasGraphQL = '@nestjs/graphql' in dependencies;
            this.hasMicroservices = '@nestjs/microservices' in dependencies;
            this.hasWebSockets = '@nestjs/websockets' in dependencies || '@nestjs/platform-socket.io' in dependencies;
            this.hasSwagger = '@nestjs/swagger' in dependencies;
        }
    }
    async discoverModules() {
        const tsFiles = await this.findFiles(['**/*.module.ts'], this.options.excludePatterns);
        for (const file of tsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const module = this.parseModule(content, file);
            if (module) {
                this.modules.set(module.name, module);
            }
        }
    }
    parseModule(content, filePath) {
        const moduleMatch = content.match(/@Module\s*\(\s*{([^}]+)}\s*\)/s);
        if (!moduleMatch)
            return null;
        const moduleConfig = moduleMatch[1];
        const classMatch = content.match(/@Module[^}]+}\s*\)\s*export\s+class\s+(\w+)/s);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        return {
            name,
            filePath,
            imports: this.extractArrayProperty(moduleConfig, 'imports'),
            controllers: this.extractArrayProperty(moduleConfig, 'controllers'),
            providers: this.extractArrayProperty(moduleConfig, 'providers'),
            exports: this.extractArrayProperty(moduleConfig, 'exports'),
            isGlobal: content.includes('@Global()'),
            isDynamic: content.includes('forRoot') || content.includes('forRootAsync')
        };
    }
    extractArrayProperty(content, property) {
        const regex = new RegExp(`${property}\\s*:\\s*\\[([^\\]]+)\\]`, 's');
        const match = content.match(regex);
        if (!match)
            return [];
        const items = match[1];
        const identifiers = [];
        const identifierRegex = /(\w+)(?:\s*,|\s*$)/g;
        let identifierMatch;
        while ((identifierMatch = identifierRegex.exec(items)) !== null) {
            identifiers.push(identifierMatch[1]);
        }
        return identifiers;
    }
    async discoverControllers() {
        const tsFiles = await this.findFiles(['**/*.controller.ts'], this.options.excludePatterns);
        for (const file of tsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const controller = this.parseController(content, file);
            if (controller) {
                this.controllers.set(controller.name, controller);
            }
        }
    }
    parseController(content, filePath) {
        const controllerMatch = content.match(/@Controller\s*\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)/);
        if (!controllerMatch)
            return null;
        const path = controllerMatch[1] || '';
        const classMatch = content.match(/@Controller[^)]*\)\s*export\s+class\s+(\w+)/s);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const methods = this.parseControllerMethods(content);
        const guards = this.extractDecorators(content, 'UseGuards');
        const interceptors = this.extractDecorators(content, 'UseInterceptors');
        const filters = this.extractDecorators(content, 'UseFilters');
        const pipes = this.extractDecorators(content, 'UsePipes');
        return {
            name,
            filePath,
            path,
            methods,
            guards,
            interceptors,
            filters,
            pipes
        };
    }
    parseControllerMethods(content) {
        const methods = [];
        const httpMethods = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options', 'All'];
        for (const httpMethod of httpMethods) {
            const regex = new RegExp(`@${httpMethod}\\s*\\(\\s*(?:['"\`]([^'"\`]+)['"\`])?[^)]*\\)[^{]*(?:async\\s+)?(\\ w+)\\s*\\([^)]*\\)`, 'g');
            let match;
            while ((match = regex.exec(content)) !== null) {
                const path = match[1] || '';
                const name = match[2];
                const methodRegex = new RegExp(`${name}\\s*\\(([^)]*)\\)`);
                const methodMatch = content.match(methodRegex);
                const params = methodMatch ? this.parseMethodParams(methodMatch[1]) : [];
                methods.push({
                    name,
                    httpMethod: httpMethod.toUpperCase(),
                    path,
                    guards: [],
                    interceptors: [],
                    pipes: [],
                    params
                });
            }
        }
        return methods;
    }
    parseMethodParams(paramsString) {
        const params = [];
        const decoratorTypes = [
            { decorator: '@Body', type: 'body' },
            { decorator: '@Query', type: 'query' },
            { decorator: '@Param', type: 'param' },
            { decorator: '@Headers', type: 'headers' },
            { decorator: '@Req', type: 'request' },
            { decorator: '@Res', type: 'response' }
        ];
        for (const { decorator, type } of decoratorTypes) {
            const regex = new RegExp(`${decorator}\\(\\)\\s*(\\w+)`, 'g');
            let match;
            while ((match = regex.exec(paramsString)) !== null) {
                params.push({
                    name: match[1],
                    type,
                    required: type !== 'query',
                    decorators: [decorator]
                });
            }
        }
        return params;
    }
    extractDecorators(content, decorator) {
        const decorators = [];
        const regex = new RegExp(`@${decorator}\\s*\\(([^)]*)\\)`, 'g');
        let match;
        while ((match = regex.exec(content)) !== null) {
            const args = match[1];
            const identifierRegex = /(\w+)/g;
            let identifierMatch;
            while ((identifierMatch = identifierRegex.exec(args)) !== null) {
                decorators.push(identifierMatch[1]);
            }
        }
        return decorators;
    }
    async discoverProviders() {
        const tsFiles = await this.findFiles(['**/*.service.ts', '**/*.repository.ts', '**/*.provider.ts'], this.options.excludePatterns);
        for (const file of tsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const provider = this.parseProvider(content, file);
            if (provider) {
                this.providers.set(provider.name, provider);
            }
        }
    }
    parseProvider(content, filePath) {
        if (!content.includes('@Injectable'))
            return null;
        const classMatch = content.match(/@Injectable[^)]*\)\s*export\s+class\s+(\w+)/s);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        let type = 'service';
        if (filePath.includes('.repository.'))
            type = 'repository';
        else if (filePath.includes('.guard.'))
            type = 'guard';
        else if (filePath.includes('.interceptor.'))
            type = 'interceptor';
        else if (filePath.includes('.pipe.'))
            type = 'pipe';
        else if (filePath.includes('.filter.'))
            type = 'filter';
        const constructorMatch = content.match(/constructor\s*\(([^)]*)\)/s);
        const dependencies = constructorMatch ? this.parseConstructorDependencies(constructorMatch[1]) : [];
        const scopeMatch = content.match(/@Injectable\s*\(\s*{\s*scope:\s*Scope\.(\w+)/);
        const scope = scopeMatch ? scopeMatch[1].toLowerCase() : 'singleton';
        return {
            name,
            filePath,
            type,
            scope,
            injectable: true,
            dependencies
        };
    }
    parseConstructorDependencies(constructorParams) {
        const dependencies = [];
        const paramRegex = /(?:private|protected|public|readonly)?\s*(\w+)\s*:\s*(\w+)/g;
        let match;
        while ((match = paramRegex.exec(constructorParams)) !== null) {
            dependencies.push(match[2]);
        }
        return dependencies;
    }
    async discoverGuards() {
        const tsFiles = await this.findFiles(['**/*.guard.ts'], this.options.excludePatterns);
        for (const file of tsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const guard = this.parseGuard(content, file);
            if (guard) {
                this.guards.set(guard.name, guard);
            }
        }
    }
    parseGuard(content, filePath) {
        const classMatch = content.match(/export\s+class\s+(\w+)\s+implements\s+CanActivate/);
        if (!classMatch)
            return null;
        return {
            name: classMatch[1],
            filePath,
            canActivate: true,
            global: content.includes('APP_GUARD')
        };
    }
    async discoverInterceptors() {
        const tsFiles = await this.findFiles(['**/*.interceptor.ts'], this.options.excludePatterns);
        for (const file of tsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const interceptor = this.parseInterceptor(content, file);
            if (interceptor) {
                this.interceptors.set(interceptor.name, interceptor);
            }
        }
    }
    parseInterceptor(content, filePath) {
        const classMatch = content.match(/export\s+class\s+(\w+)\s+implements\s+NestInterceptor/);
        if (!classMatch)
            return null;
        return {
            name: classMatch[1],
            filePath,
            global: content.includes('APP_INTERCEPTOR')
        };
    }
    async discoverPipes() {
        const tsFiles = await this.findFiles(['**/*.pipe.ts'], this.options.excludePatterns);
        for (const file of tsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const pipe = this.parsePipe(content, file);
            if (pipe) {
                this.pipes.set(pipe.name, pipe);
            }
        }
    }
    parsePipe(content, filePath) {
        const classMatch = content.match(/export\s+class\s+(\w+)\s+implements\s+PipeTransform/);
        if (!classMatch)
            return null;
        return {
            name: classMatch[1],
            filePath,
            global: content.includes('APP_PIPE'),
            transform: true
        };
    }
    async discoverFilters() {
        const tsFiles = await this.findFiles(['**/*.filter.ts'], this.options.excludePatterns);
        for (const file of tsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const filter = this.parseFilter(content, file);
            if (filter) {
                this.filters.set(filter.name, filter);
            }
        }
    }
    parseFilter(content, filePath) {
        const classMatch = content.match(/export\s+class\s+(\w+)\s+implements\s+ExceptionFilter/);
        if (!classMatch)
            return null;
        const catchMatch = content.match(/@Catch\s*\(([^)]*)\)/);
        const exceptionTypes = catchMatch ? this.extractIdentifiers(catchMatch[1]) : [];
        return {
            name: classMatch[1],
            filePath,
            exceptionTypes,
            global: content.includes('APP_FILTER')
        };
    }
    extractIdentifiers(content) {
        const identifiers = [];
        const regex = /(\w+)/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            identifiers.push(match[1]);
        }
        return identifiers;
    }
    async discoverEntities() {
        if (!this.hasTypeORM && !this.hasMikroORM && !this.hasMongoose)
            return;
        const tsFiles = await this.findFiles(['**/*.entity.ts', '**/*.schema.ts'], this.options.excludePatterns);
        for (const file of tsFiles) {
            const content = await fs.readFile(file, 'utf-8');
            const entity = this.parseEntity(content, file);
            if (entity) {
                this.entities.set(entity.name, entity);
            }
        }
    }
    parseEntity(content, filePath) {
        if (content.includes('@Entity')) {
            return this.parseTypeORMEntity(content, filePath);
        }
        if (content.includes('@Schema')) {
            return this.parseMongooseSchema(content, filePath);
        }
        return null;
    }
    parseTypeORMEntity(content, filePath) {
        const entityMatch = content.match(/@Entity\s*\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)/);
        const classMatch = content.match(/@Entity[^}]*export\s+class\s+(\w+)/s);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const tableName = entityMatch?.[1];
        const columns = this.parseTypeORMColumns(content);
        const relations = this.parseTypeORMRelations(content);
        const indexes = this.parseTypeORMIndexes(content);
        return {
            name,
            filePath,
            tableName,
            columns,
            relations,
            indexes
        };
    }
    parseTypeORMColumns(content) {
        const columns = [];
        const columnRegex = /@(Column|PrimaryColumn|PrimaryGeneratedColumn)\s*\([^)]*\)\s*(\w+)\s*:\s*(\w+)/g;
        let match;
        while ((match = columnRegex.exec(content)) !== null) {
            const decorator = match[1];
            const name = match[2];
            const type = match[3];
            columns.push({
                name,
                type,
                nullable: content.includes(`${name}?:`),
                unique: content.includes(`unique: true`),
                primary: decorator.includes('Primary'),
                generated: decorator.includes('Generated')
            });
        }
        return columns;
    }
    parseTypeORMRelations(content) {
        const relations = [];
        const relationTypes = [
            { decorator: 'OneToOne', type: 'one-to-one' },
            { decorator: 'OneToMany', type: 'one-to-many' },
            { decorator: 'ManyToOne', type: 'many-to-one' },
            { decorator: 'ManyToMany', type: 'many-to-many' }
        ];
        for (const { decorator, type } of relationTypes) {
            const regex = new RegExp(`@${decorator}\\s*\\([^)]*\\)\\s*(\\w+)`, 'g');
            let match;
            while ((match = regex.exec(content)) !== null) {
                relations.push({
                    name: match[1],
                    type,
                    to: '',
                    cascade: content.includes('cascade: true')
                });
            }
        }
        return relations;
    }
    parseTypeORMIndexes(content) {
        const indexes = [];
        const indexRegex = /@Index\s*\(\s*['"`]([^'"`]+)['"`]/g;
        let match;
        while ((match = indexRegex.exec(content)) !== null) {
            indexes.push(match[1]);
        }
        return indexes;
    }
    parseMongooseSchema(content, filePath) {
        const classMatch = content.match(/@Schema[^}]*export\s+class\s+(\w+)/s);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const columns = [];
        const propRegex = /@Prop\s*\([^)]*\)\s*(\w+)\s*:\s*(\w+)/g;
        let match;
        while ((match = propRegex.exec(content)) !== null) {
            columns.push({
                name: match[1],
                type: match[2],
                nullable: content.includes(`${match[1]}?:`),
                unique: false,
                primary: false,
                generated: false
            });
        }
        return {
            name,
            filePath,
            columns,
            relations: [],
            indexes: []
        };
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
    async buildNestConnections() {
        const connections = [];
        for (const [moduleId, module] of this.modules) {
            for (const importedModule of module.imports) {
                connections.push({
                    from: moduleId,
                    to: importedModule,
                    type: 'module-import',
                    protocol: 'nestjs',
                    metadata: {
                        callSites: 1,
                        importType: 'module'
                    }
                });
            }
            for (const controller of module.controllers) {
                connections.push({
                    from: moduleId,
                    to: controller,
                    type: 'module-controller',
                    protocol: 'nestjs',
                    metadata: { callSites: 1, relationship: 'contains' }
                });
            }
            for (const provider of module.providers) {
                connections.push({
                    from: moduleId,
                    to: provider,
                    type: 'module-provider',
                    protocol: 'nestjs',
                    metadata: { callSites: 1, relationship: 'provides' }
                });
            }
        }
        for (const [providerId, provider] of this.providers) {
            for (const dep of provider.dependencies) {
                connections.push({
                    from: providerId,
                    to: dep,
                    type: 'dependency-injection',
                    protocol: 'nestjs',
                    metadata: {
                        callSites: 1,
                        scope: provider.scope
                    }
                });
            }
        }
        for (const [entityId, entity] of this.entities) {
            for (const relation of entity.relations) {
                if (relation.to) {
                    connections.push({
                        from: entityId,
                        to: relation.to,
                        type: 'data-relationship',
                        protocol: 'typeorm',
                        metadata: {
                            callSites: 1,
                            relationType: relation.type
                        }
                    });
                }
            }
        }
        return connections;
    }
    extractNestEndpoints() {
        const endpoints = [];
        for (const [controllerId, controller] of this.controllers) {
            const basePath = controller.path || '';
            for (const method of controller.methods) {
                const fullPath = `${basePath}/${method.path}`.replace(/\/+/g, '/');
                const endpointId = `${controllerId}_${method.name}`;
                endpoints.push({
                    id: endpointId,
                    path: fullPath,
                    method: method.httpMethod,
                    description: `${method.httpMethod} ${fullPath}`,
                    handler: `${controller.name}.${method.name}`,
                    parameters: method.params.map(p => ({
                        name: p.name,
                        type: p.type,
                        required: p.required,
                        dataType: p.dataType || 'string'
                    })),
                    statusCodes: [{ code: 200, description: 'Success' }],
                    middleware: [...controller.guards, ...controller.interceptors, ...controller.pipes],
                    authentication: { type: 'jwt', required: true },
                    rateLimit: undefined,
                    deprecated: false,
                    componentId: controllerId
                });
            }
        }
        return endpoints;
    }
    async extractDatabaseConnections() {
        const connections = [];
        if (this.hasTypeORM) {
            connections.push({
                id: 'typeorm-connection',
                name: 'TypeORM',
                type: 'postgresql',
                host: 'localhost',
                port: 5432,
                database: 'nestjs',
                schema: 'public',
                tables: Array.from(this.entities.keys()),
                usage: [],
                componentIds: []
            });
        }
        if (this.hasMikroORM) {
            connections.push({
                id: 'mikroorm-connection',
                name: 'MikroORM',
                type: 'postgresql',
                host: 'localhost',
                port: 5432,
                database: 'nestjs',
                schema: 'public',
                tables: Array.from(this.entities.keys()),
                usage: [],
                componentIds: []
            });
        }
        if (this.hasMongoose) {
            connections.push({
                id: 'mongoose-connection',
                name: 'MongoDB (Mongoose)',
                type: 'mongodb',
                host: 'localhost',
                port: 27017,
                database: 'nestjs',
                schema: '',
                tables: Array.from(this.entities.keys()),
                usage: [],
                componentIds: []
            });
        }
        if (this.hasPrisma) {
            connections.push({
                id: 'prisma-connection',
                name: 'Prisma ORM',
                type: 'postgresql',
                host: 'localhost',
                port: 5432,
                database: 'nestjs',
                schema: 'public',
                tables: [],
                usage: [],
                componentIds: []
            });
        }
        return connections;
    }
    findNestEntryPoints() {
        return ['main.ts', 'src/main.ts', 'app.module.ts', 'src/app.module.ts'];
    }
    buildNestLayers() {
        return {
            'modules': Array.from(this.modules.keys()),
            'controllers': Array.from(this.controllers.keys()),
            'providers': Array.from(this.providers.keys()),
            'guards': Array.from(this.guards.keys()),
            'interceptors': Array.from(this.interceptors.keys()),
            'pipes': Array.from(this.pipes.keys()),
            'filters': Array.from(this.filters.keys()),
            'entities': Array.from(this.entities.keys())
        };
    }
    async analyzePerformance() {
        return {
            nestjs: {
                modulesCount: this.modules.size,
                controllersCount: this.controllers.size,
                providersCount: this.providers.size,
                guardsCount: this.guards.size,
                interceptorsCount: this.interceptors.size,
                pipesCount: this.pipes.size,
                filtersCount: this.filters.size,
                entitiesCount: this.entities.size,
                averageMethodsPerController: this.calculateAverageMethodsPerController(),
                averageDependenciesPerProvider: this.calculateAverageDependencies(),
                features: {
                    hasTypeORM: this.hasTypeORM,
                    hasMikroORM: this.hasMikroORM,
                    hasPrisma: this.hasPrisma,
                    hasMongoose: this.hasMongoose,
                    hasGraphQL: this.hasGraphQL,
                    hasMicroservices: this.hasMicroservices,
                    hasWebSockets: this.hasWebSockets,
                    hasSwagger: this.hasSwagger
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
    calculateAverageDependencies() {
        const providers = Array.from(this.providers.values());
        if (providers.length === 0)
            return 0;
        const totalDeps = providers.reduce((sum, p) => sum + p.dependencies.length, 0);
        return totalDeps / providers.length;
    }
}
exports.NestJSAnalyzer = NestJSAnalyzer;
