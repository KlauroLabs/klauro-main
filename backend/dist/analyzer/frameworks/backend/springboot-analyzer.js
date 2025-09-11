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
exports.SpringBootAnalyzer = void 0;
const java_analyzer_1 = require("../../languages/java-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class SpringBootAnalyzer extends java_analyzer_1.JavaAnalyzer {
    constructor() {
        super(...arguments);
        this.springVersion = '';
        this.controllers = new Map();
        this.services = new Map();
        this.entities = new Map();
        this.hasSpringData = false;
        this.hasSpringSecurity = false;
        this.hasSpringCloud = false;
    }
    getAnalyzerName() {
        return 'Spring Boot Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['spring-boot', 'spring-mvc', 'spring-data', 'spring-security', 'spring-cloud'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        await this.detectSpringBootVersion();
        return {
            ...baseDetection,
            frameworks: [...baseDetection.frameworks.filter(f => !f.name.includes('spring')), {
                    name: 'spring-boot',
                    version: this.springVersion,
                    confidence: 0.95,
                    patterns: ['Spring Boot application detected'],
                    configFiles: ['application.properties', 'application.yml', 'pom.xml', 'build.gradle'],
                    dependencies: ['spring-boot-starter']
                }]
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('springboot-analyzer.discoverComponents');
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
                language: 'java',
                framework: 'spring-boot',
                dependencies: controller.beans,
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: controller.methods.length,
                    maintainability: 100 - controller.methods.length * 2,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: controller.methods.length,
                    lastModified: new Date(),
                    exports: [controller.name],
                    imports: [],
                    layer: 'presentation',
                    responsibilities: [`Handle HTTP requests for ${controller.requestMapping}`],
                    frameworkType: 'controller',
                    requestMapping: controller.requestMapping,
                    methods: controller.methods.map(m => m.name)
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
                language: 'java',
                framework: 'spring-boot',
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
                    complexity: 5,
                    lastModified: new Date(),
                    exports: [service.name],
                    imports: [],
                    layer: 'business',
                    responsibilities: [`Provide ${service.stereotype} functionality`],
                    frameworkType: 'service',
                    stereotype: service.stereotype
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
                language: 'java',
                framework: 'spring-boot',
                dependencies: entity.relationships.map(r => r.targetEntity),
                dependents: [],
                metrics: {
                    linesOfCode: 0,
                    complexity: entity.fields.length + entity.relationships.length,
                    maintainability: 100 - (entity.fields.length + entity.relationships.length) * 1.5,
                    testCoverage: 0,
                    duplicateCode: 0,
                    technicalDebt: 0
                },
                metadata: {
                    lineCount: 0,
                    complexity: entity.fields.length + entity.relationships.length,
                    lastModified: new Date(),
                    exports: [entity.name],
                    imports: [],
                    layer: 'data',
                    responsibilities: [`Represent ${entity.tableName || entity.name} data entity`],
                    frameworkType: 'entity',
                    tableName: entity.tableName,
                    fields: entity.fields.map(f => f.name)
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildSpringConnections();
        const apiEndpoints = this.extractSpringEndpoints();
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
            entryPoints: ['Application.java', 'Main.java'],
            connections,
            layers: this.buildSpringLayers(),
            apiEndpoints,
            databaseConnections
        };
    }
    async detectSpringBootVersion() {
        const pomPath = path.join(this.projectPath, 'pom.xml');
        if (await fs.pathExists(pomPath)) {
            const content = await fs.readFile(pomPath, 'utf-8');
            const versionMatch = content.match(/<spring-boot.version>([^<]+)<\/spring-boot.version>/);
            if (versionMatch) {
                this.springVersion = versionMatch[1];
            }
        }
        const gradlePath = path.join(this.projectPath, 'build.gradle');
        if (await fs.pathExists(gradlePath)) {
            const content = await fs.readFile(gradlePath, 'utf-8');
            const versionMatch = content.match(/springBootVersion\s*=\s*['"]([^'"]+)['"]/);
            if (versionMatch) {
                this.springVersion = versionMatch[1];
            }
        }
    }
    async discoverControllers() {
        const javaFiles = await this.findFiles(['**/*.java'], this.options.excludePatterns);
        for (const file of javaFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('@RestController') || content.includes('@Controller')) {
                const controller = this.parseController(content, file);
                if (controller) {
                    this.controllers.set(controller.name, controller);
                }
            }
        }
    }
    parseController(content, filePath) {
        const classMatch = content.match(/(?:@RestController|@Controller)[^}]*class\s+(\w+)/);
        if (!classMatch)
            return null;
        const name = classMatch[1];
        const requestMappingMatch = content.match(/@RequestMapping\s*\(["']([^"']+)["']\)/);
        return {
            name,
            filePath,
            requestMapping: requestMappingMatch?.[1],
            methods: this.parseControllerMethods(content),
            beans: []
        };
    }
    parseControllerMethods(content) {
        const methods = [];
        const mappings = ['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping'];
        for (const mapping of mappings) {
            const regex = new RegExp(`@${mapping}\\s*\\(["']([^"']+)["']\\)[^{]*(?:public|private|protected)\\s+\\w+\\s+(\\w+)`, 'g');
            let match;
            while ((match = regex.exec(content)) !== null) {
                methods.push({
                    name: match[2],
                    httpMethod: mapping.replace('Mapping', '').toUpperCase(),
                    path: match[1],
                    parameters: []
                });
            }
        }
        return methods;
    }
    async discoverServices() {
        const javaFiles = await this.findFiles(['**/*.java'], this.options.excludePatterns);
        for (const file of javaFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('@Service') || content.includes('@Component') || content.includes('@Repository')) {
                const service = this.parseService(content, file);
                if (service) {
                    this.services.set(service.name, service);
                }
            }
        }
    }
    parseService(content, filePath) {
        const stereotypeMatch = content.match(/(@Service|@Component|@Repository)/);
        if (!stereotypeMatch)
            return null;
        const classMatch = content.match(/class\s+(\w+)/);
        if (!classMatch)
            return null;
        return {
            name: classMatch[1],
            filePath,
            stereotype: stereotypeMatch[1],
            dependencies: [],
            transactional: content.includes('@Transactional')
        };
    }
    async discoverEntities() {
        const javaFiles = await this.findFiles(['**/*.java'], this.options.excludePatterns);
        for (const file of javaFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('@Entity')) {
                const entity = this.parseEntity(content, file);
                if (entity) {
                    this.entities.set(entity.name, entity);
                }
            }
        }
    }
    parseEntity(content, filePath) {
        const classMatch = content.match(/@Entity[^}]*class\s+(\w+)/);
        if (!classMatch)
            return null;
        const tableMatch = content.match(/@Table\s*\(\s*name\s*=\s*["']([^"']+)["']/);
        return {
            name: classMatch[1],
            filePath,
            tableName: tableMatch?.[1],
            fields: this.parseEntityFields(content),
            relationships: this.parseEntityRelationships(content)
        };
    }
    parseEntityFields(content) {
        const fields = [];
        const fieldRegex = /(?:@Column[^\n]*\n)?\s*private\s+(\w+)\s+(\w+);/g;
        let match;
        while ((match = fieldRegex.exec(content)) !== null) {
            fields.push({
                name: match[2],
                type: match[1],
                nullable: !content.includes(`@NotNull`),
                unique: content.includes(`@Column(unique = true)`)
            });
        }
        return fields;
    }
    parseEntityRelationships(content) {
        const relationships = [];
        const relationTypes = ['@OneToMany', '@ManyToOne', '@OneToOne', '@ManyToMany'];
        for (const relationType of relationTypes) {
            const regex = new RegExp(`${relationType.replace('@', '')}[^\\n]*\\n\\s*private\\s+\\w+<?(\\w+)>?\\s+(\\w+)`, 'g');
            let match;
            while ((match = regex.exec(content)) !== null) {
                relationships.push({
                    name: match[2],
                    type: relationType,
                    targetEntity: match[1]
                });
            }
        }
        return relationships;
    }
    async buildSpringConnections() {
        const connections = [];
        for (const [controllerId, controller] of this.controllers) {
            for (const bean of controller.beans) {
                connections.push({
                    from: controllerId,
                    to: bean,
                    type: 'dependency-injection',
                    protocol: 'spring',
                    metadata: { callSites: 1, injectionType: 'autowired' }
                });
            }
        }
        for (const [serviceId, service] of this.services) {
            for (const dep of service.dependencies) {
                connections.push({
                    from: serviceId,
                    to: dep,
                    type: 'dependency-injection',
                    protocol: 'spring',
                    metadata: { callSites: 1, injectionType: 'autowired' }
                });
            }
        }
        for (const [entityId, entity] of this.entities) {
            for (const rel of entity.relationships) {
                connections.push({
                    from: entityId,
                    to: rel.targetEntity,
                    type: 'data-relationship',
                    protocol: 'jpa',
                    metadata: {
                        callSites: 1,
                        relationType: rel.type
                    }
                });
            }
        }
        return connections;
    }
    extractSpringEndpoints() {
        const endpoints = [];
        for (const [id, controller] of this.controllers) {
            const basePath = controller.requestMapping || '';
            for (const method of controller.methods) {
                const endpointId = `${controller.name}.${method.name}`;
                endpoints.push({
                    id: endpointId,
                    path: `${basePath}/${method.path}`.replace(/\/+/g, '/'),
                    method: method.httpMethod,
                    description: `${method.httpMethod} ${method.path}`,
                    handler: `${controller.name}.${method.name}`,
                    parameters: method.parameters.map(p => ({
                        name: p.name,
                        type: (p.annotation === '@PathVariable' ? 'path' : p.annotation === '@RequestParam' ? 'query' : 'body'),
                        required: p.required,
                        dataType: p.type
                    })),
                    statusCodes: [
                        { code: 200, description: 'Success' },
                        { code: 400, description: 'Bad Request' },
                        { code: 500, description: 'Internal Server Error' }
                    ],
                    responses: [],
                    middleware: [],
                    authentication: {
                        type: this.hasSpringSecurity ? 'jwt' : 'none',
                        required: this.hasSpringSecurity
                    },
                    rateLimit: undefined,
                    deprecated: false,
                    componentId: `controller-${controller.name}`
                });
            }
        }
        return endpoints;
    }
    async extractDatabaseConnections() {
        return [{
                id: 'spring-data-jpa',
                name: 'Spring Data JPA',
                type: 'postgresql',
                host: 'localhost',
                port: 5432,
                database: 'springboot',
                schema: 'public',
                tables: Array.from(this.entities.keys()),
                usage: [],
                componentIds: Array.from(this.entities.keys())
            }];
    }
    buildSpringLayers() {
        return {
            'controllers': Array.from(this.controllers.keys()),
            'services': Array.from(this.services.keys()),
            'entities': Array.from(this.entities.keys())
        };
    }
    async analyzePerformance() {
        return {
            springboot: {
                controllersCount: this.controllers.size,
                servicesCount: this.services.size,
                entitiesCount: this.entities.size,
                averageMethodsPerController: this.calculateAverageMethodsPerController(),
                features: {
                    hasSpringData: this.hasSpringData,
                    hasSpringSecurity: this.hasSpringSecurity,
                    hasSpringCloud: this.hasSpringCloud
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
}
exports.SpringBootAnalyzer = SpringBootAnalyzer;
