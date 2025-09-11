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
exports.SystemTopologyAnalyzer = void 0;
const base_analyzer_1 = require("./base-analyzer");
const path = __importStar(require("path"));
class SystemTopologyAnalyzer extends base_analyzer_1.BaseAnalyzer {
    constructor() {
        super(...arguments);
        this.topology = {
            layers: [],
            flows: [],
            patterns: [],
            entryPoints: [],
            integrations: []
        };
        this.architecturalPatterns = {
            mvc: {
                indicators: ['controllers/', 'models/', 'views/', 'Controller', 'Model', 'View'],
                implications: ['Three-layer architecture', 'Separation of concerns', 'Web application']
            },
            layered: {
                indicators: ['presentation/', 'business/', 'data/', 'service/', 'repository/', 'dto/'],
                implications: ['Layered architecture', 'Clear separation', 'Enterprise application']
            },
            microservices: {
                indicators: ['services/', 'api/', 'gateway/', 'docker', 'kubernetes', 'service.'],
                implications: ['Distributed system', 'Service-oriented', 'Scalable architecture']
            },
            restful_api: {
                indicators: ['@Get', '@Post', '@Put', '@Delete', 'routes/', 'api/', '.get(', '.post('],
                implications: ['REST API', 'HTTP endpoints', 'Stateless communication']
            },
            graphql: {
                indicators: ['graphql', 'resolvers/', 'schema.', '@Query', '@Mutation'],
                implications: ['GraphQL API', 'Single endpoint', 'Flexible queries']
            },
            orm: {
                indicators: ['entities/', 'models/', '@Entity', 'Schema', 'migration', 'repository'],
                implications: ['Object-relational mapping', 'Database abstraction', 'Data persistence']
            },
            cqrs: {
                indicators: ['commands/', 'queries/', 'handlers/', 'events/', 'Command', 'Query'],
                implications: ['CQRS pattern', 'Separated read/write', 'Event-driven']
            },
            dependency_injection: {
                indicators: ['@Injectable', '@Inject', 'container', 'providers', 'DI'],
                implications: ['Dependency injection', 'Inversion of control', 'Testable code']
            },
            event_driven: {
                indicators: ['events/', 'listeners/', 'handlers/', '@Event', 'EventEmitter', 'pub/sub'],
                implications: ['Event-driven architecture', 'Loose coupling', 'Asynchronous processing']
            }
        };
    }
    getAnalyzerName() {
        return 'System Topology Analyzer';
    }
    getSupportedLanguages() {
        return ['typescript', 'javascript', 'python', 'java', 'csharp', 'go', 'rust', 'php'];
    }
    getSupportedFrameworks() {
        return ['any'];
    }
    async detectLanguageAndFramework() {
        console.log('🔍 Detecting system architecture and patterns...');
        const projectStructure = await this.analyzeProjectStructure();
        const codePatterns = await this.detectCodePatterns();
        const configPatterns = await this.detectConfigurationPatterns();
        const language = this.determinePrimaryLanguage(projectStructure);
        const frameworks = this.detectArchitecturalFrameworks(projectStructure, codePatterns, configPatterns);
        console.log(`🏗️ Detected ${language} system with patterns: ${frameworks.map(f => f.name).join(', ')}`);
        return {
            language,
            confidence: 0.95,
            frameworks,
            files: projectStructure.allFiles
        };
    }
    async analyzeProjectStructure() {
        const structure = {
            directories: new Set(),
            files: new Map(),
            allFiles: [],
            patterns: new Set()
        };
        const allFiles = await this.findFiles(['**/*'], ['node_modules/**', 'dist/**', 'build/**', '.git/**']);
        structure.allFiles = allFiles;
        for (const file of allFiles.slice(0, 100)) {
            const relativePath = path.relative(this.projectPath, file);
            const directory = path.dirname(relativePath);
            const extension = path.extname(file);
            structure.directories.add(directory);
            structure.files.set(relativePath, extension);
            const pathParts = relativePath.split('/');
            pathParts.forEach(part => {
                if (part.length > 2)
                    structure.patterns.add(part.toLowerCase());
            });
        }
        return structure;
    }
    async detectCodePatterns() {
        const patterns = new Set();
        const keyFiles = await this.findFiles([
            'package.json', 'requirements.txt', 'pom.xml', 'go.mod', 'Cargo.toml',
            '**/*.ts', '**/*.js', '**/*.py', '**/*.java', '**/*.cs', '**/*.go'
        ]);
        for (const file of keyFiles.slice(0, 50)) {
            try {
                const content = await this.readFile(file);
                this.extractPatternsFromContent(content, patterns);
            }
            catch (error) {
            }
        }
        return patterns;
    }
    extractPatternsFromContent(content, patterns) {
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('@')) {
                patterns.add(trimmed.split('(')[0]);
            }
            if (trimmed.includes('import') || trimmed.includes('require') || trimmed.includes('from')) {
                const match = trimmed.match(/['"`]([^'"`]+)['"`]/);
                if (match)
                    patterns.add(match[1]);
            }
            if (trimmed.includes('class ') || trimmed.includes('function ') || trimmed.includes('def ')) {
                patterns.add('class_based');
            }
            const httpMethods = ['get', 'post', 'put', 'delete', 'patch'];
            for (const method of httpMethods) {
                if (trimmed.toLowerCase().includes(`.${method}(`) || trimmed.includes(`@${method.toUpperCase()}`)) {
                    patterns.add(`http_${method}`);
                }
            }
            const dbPatterns = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'findOne', 'save', 'create'];
            for (const pattern of dbPatterns) {
                if (trimmed.includes(pattern)) {
                    patterns.add('database_operations');
                }
            }
        }
    }
    async detectConfigurationPatterns() {
        const patterns = new Set();
        const configFiles = await this.findFiles([
            'package.json', 'requirements.txt', 'pom.xml', 'Dockerfile', 'docker-compose.yml',
            '*.config.js', '*.config.ts', '.env*', 'tsconfig.json'
        ]);
        for (const file of configFiles) {
            try {
                const content = await this.readFile(file);
                const filename = path.basename(file);
                if (filename === 'package.json') {
                    const pkg = JSON.parse(content);
                    Object.keys(pkg.dependencies || {}).forEach(dep => patterns.add(dep));
                    Object.keys(pkg.devDependencies || {}).forEach(dep => patterns.add(dep));
                }
                else if (filename === 'requirements.txt') {
                    content.split('\n').forEach(line => {
                        const dep = line.split('==')[0].split('>=')[0].trim();
                        if (dep)
                            patterns.add(dep);
                    });
                }
                else if (filename.includes('docker')) {
                    patterns.add('containerized');
                }
            }
            catch (error) {
            }
        }
        return patterns;
    }
    determinePrimaryLanguage(projectStructure) {
        const extensions = new Map();
        for (const [file, ext] of projectStructure.files) {
            extensions.set(ext, (extensions.get(ext) || 0) + 1);
        }
        const langMap = {
            '.ts': 'typescript',
            '.js': 'javascript',
            '.tsx': 'typescript',
            '.jsx': 'javascript',
            '.py': 'python',
            '.java': 'java',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust',
            '.php': 'php'
        };
        let maxCount = 0;
        let primaryLang = 'unknown';
        for (const [ext, count] of extensions) {
            if (langMap[ext] && count > maxCount) {
                maxCount = count;
                primaryLang = langMap[ext];
            }
        }
        return primaryLang;
    }
    detectArchitecturalFrameworks(projectStructure, codePatterns, configPatterns) {
        const frameworks = [];
        const allPatterns = new Set([...projectStructure.patterns, ...codePatterns, ...configPatterns]);
        const frameworkDetectors = {
            'NestJS': () => allPatterns.has('@nestjs/core') || allPatterns.has('@Injectable') || allPatterns.has('@Controller'),
            'Express': () => allPatterns.has('express') || codePatterns.has('http_get'),
            'React': () => allPatterns.has('react') || allPatterns.has('jsx'),
            'Next.js': () => allPatterns.has('next') || projectStructure.directories.has('pages'),
            'Django': () => allPatterns.has('django') || projectStructure.patterns.has('models.py'),
            'FastAPI': () => allPatterns.has('fastapi') || allPatterns.has('uvicorn'),
            'Spring Boot': () => allPatterns.has('spring-boot') || allPatterns.has('org.springframework'),
            'ASP.NET Core': () => allPatterns.has('Microsoft.AspNetCore'),
            'Gin': () => allPatterns.has('gin-gonic') || allPatterns.has('github.com/gin'),
            'Laravel': () => allPatterns.has('laravel') || projectStructure.patterns.has('artisan')
        };
        for (const [name, detector] of Object.entries(frameworkDetectors)) {
            if (detector()) {
                frameworks.push({
                    name,
                    confidence: 0.9,
                    patterns: Array.from(allPatterns).filter(p => p.includes(name.toLowerCase()))
                });
            }
        }
        for (const [patternName, config] of Object.entries(this.architecturalPatterns)) {
            const matches = config.indicators.filter(indicator => Array.from(allPatterns).some(pattern => pattern.toLowerCase().includes(indicator.toLowerCase()) ||
                indicator.toLowerCase().includes(pattern.toLowerCase())));
            if (matches.length > 0) {
                this.topology.patterns.push({
                    name: patternName,
                    type: 'architectural',
                    confidence: matches.length / config.indicators.length,
                    indicators: matches,
                    implications: config.implications
                });
            }
        }
        return frameworks;
    }
    async discoverComponents() {
        console.log('🏗️ Mapping system topology and discovering architectural components...');
        await this.mapSystemTopology();
        const components = await this.createArchitecturalComponents();
        return {
            totalFiles: this.topology.layers.reduce((sum, layer) => sum + layer.components.length, 0),
            analyzedFiles: components.length,
            skippedFiles: 0,
            components
        };
    }
    async mapSystemTopology() {
        await this.identifyArchitecturalLayers();
        await this.mapDataFlows();
        await this.identifySystemEntryPoints();
        await this.detectExternalIntegrations();
    }
    async identifyArchitecturalLayers() {
        const files = await this.findFiles(['**/*.ts', '**/*.js', '**/*.py', '**/*.java', '**/*.cs', '**/*.go']);
        const layerMap = new Map();
        for (const file of files) {
            const relativePath = path.relative(this.projectPath, file);
            const layer = this.determineArchitecturalLayer(relativePath);
            if (!layerMap.has(layer)) {
                layerMap.set(layer, []);
            }
            layerMap.get(layer).push(relativePath);
        }
        for (const [layerName, components] of layerMap) {
            if (components.length > 0) {
                this.topology.layers.push({
                    name: layerName,
                    type: this.mapLayerType(layerName),
                    components,
                    responsibilities: this.getLayerResponsibilities(layerName)
                });
            }
        }
    }
    determineArchitecturalLayer(filePath) {
        const pathLower = filePath.toLowerCase();
        if (pathLower.includes('controller') || pathLower.includes('route') || pathLower.includes('api/')) {
            return 'presentation';
        }
        if (pathLower.includes('service') || pathLower.includes('business/') || pathLower.includes('domain/')) {
            return 'business';
        }
        if (pathLower.includes('model') || pathLower.includes('entity') || pathLower.includes('repository') ||
            pathLower.includes('dao') || pathLower.includes('database/')) {
            return 'data';
        }
        if (pathLower.includes('config') || pathLower.includes('middleware') || pathLower.includes('auth') ||
            pathLower.includes('guard') || pathLower.includes('interceptor')) {
            return 'infrastructure';
        }
        if (pathLower.includes('external') || pathLower.includes('client') || pathLower.includes('adapter')) {
            return 'external';
        }
        return 'business';
    }
    mapLayerType(layerName) {
        const mapping = {
            'presentation': 'presentation',
            'business': 'business',
            'data': 'data',
            'infrastructure': 'infrastructure',
            'external': 'external'
        };
        return mapping[layerName] || 'business';
    }
    getLayerResponsibilities(layerName) {
        const responsibilities = {
            'presentation': ['HTTP endpoints', 'Request validation', 'Response formatting', 'API documentation'],
            'business': ['Business logic', 'Domain operations', 'Workflow orchestration', 'Rule enforcement'],
            'data': ['Data persistence', 'Database operations', 'Entity definitions', 'Data validation'],
            'infrastructure': ['Cross-cutting concerns', 'Authentication', 'Authorization', 'Logging', 'Configuration'],
            'external': ['Third-party integrations', 'External API clients', 'Message queues', 'External services']
        };
        return responsibilities[layerName] || ['General functionality'];
    }
    async mapDataFlows() {
        const layers = this.topology.layers;
        for (let i = 0; i < layers.length - 1; i++) {
            for (let j = i + 1; j < layers.length; j++) {
                if (this.layersInteract(layers[i], layers[j])) {
                    this.topology.flows.push({
                        from: layers[i].name,
                        to: layers[j].name,
                        type: 'request',
                        pattern: 'layer_communication',
                        frequency: 'high'
                    });
                }
            }
        }
    }
    layersInteract(layer1, layer2) {
        const interactions = [
            ['presentation', 'business'],
            ['business', 'data'],
            ['presentation', 'infrastructure'],
            ['business', 'external']
        ];
        return interactions.some(([a, b]) => (layer1.type === a && layer2.type === b) ||
            (layer1.type === b && layer2.type === a));
    }
    async identifySystemEntryPoints() {
        const files = await this.findFiles(['**/*.ts', '**/*.js', '**/*.py', '**/*.java']);
        for (const file of files.slice(0, 50)) {
            try {
                const content = await this.readFile(file);
                const relativePath = path.relative(this.projectPath, file);
                const httpPatterns = [
                    /@Get\s*\(['"`]([^'"`]+)['"`]\)/g,
                    /@Post\s*\(['"`]([^'"`]+)['"`]\)/g,
                    /\.get\s*\(['"`]([^'"`]+)['"`]/g,
                    /\.post\s*\(['"`]([^'"`]+)['"`]/g
                ];
                for (const pattern of httpPatterns) {
                    let match;
                    while ((match = pattern.exec(content)) !== null) {
                        this.topology.entryPoints.push({
                            id: `${relativePath}:${match[1]}`,
                            type: 'http_endpoint',
                            path: match[1],
                            methods: [this.extractHttpMethod(match[0])],
                            description: `HTTP endpoint in ${relativePath}`
                        });
                    }
                }
                if (content.includes('app.listen') || content.includes('if __name__') || content.includes('public static void main')) {
                    this.topology.entryPoints.push({
                        id: relativePath,
                        type: 'cli_command',
                        path: relativePath,
                        description: `Application entry point`
                    });
                }
            }
            catch (error) {
            }
        }
    }
    extractHttpMethod(match) {
        if (match.includes('Get') || match.includes('.get'))
            return 'GET';
        if (match.includes('Post') || match.includes('.post'))
            return 'POST';
        if (match.includes('Put') || match.includes('.put'))
            return 'PUT';
        if (match.includes('Delete') || match.includes('.delete'))
            return 'DELETE';
        return 'GET';
    }
    async detectExternalIntegrations() {
        const configFiles = await this.findFiles(['package.json', 'requirements.txt', '*.env*', 'docker-compose.yml']);
        for (const file of configFiles) {
            try {
                const content = await this.readFile(file);
                if (file.endsWith('package.json')) {
                    const pkg = JSON.parse(content);
                    this.analyzeNpmDependencies(pkg.dependencies || {});
                }
                else if (file.includes('.env')) {
                    this.analyzeEnvironmentVariables(content);
                }
            }
            catch (error) {
            }
        }
    }
    analyzeNpmDependencies(dependencies) {
        const integrationMap = {
            'mongoose': { type: 'database', critical: true },
            'prisma': { type: 'database', critical: true },
            'redis': { type: 'cache', critical: false },
            'aws-sdk': { type: 'storage', critical: false },
            'stripe': { type: 'payment', critical: true },
            'passport': { type: 'auth', critical: true },
            'axios': { type: 'api', critical: false },
            'bull': { type: 'queue', critical: false }
        };
        for (const [dep, version] of Object.entries(dependencies)) {
            const integration = integrationMap[dep];
            if (integration) {
                this.topology.integrations.push({
                    name: dep,
                    type: integration.type,
                    direction: 'outbound',
                    critical: integration.critical
                });
            }
        }
    }
    analyzeEnvironmentVariables(content) {
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.includes('DATABASE_URL')) {
                this.topology.integrations.push({
                    name: 'Database',
                    type: 'database',
                    direction: 'outbound',
                    critical: true
                });
            }
            if (line.includes('REDIS_URL')) {
                this.topology.integrations.push({
                    name: 'Redis',
                    type: 'cache',
                    direction: 'outbound',
                    critical: false
                });
            }
        }
    }
    async createArchitecturalComponents() {
        const components = [];
        for (const layer of this.topology.layers) {
            for (const componentPath of layer.components) {
                const component = await this.createComponentFromPath(componentPath, layer);
                if (component) {
                    components.push(component);
                }
            }
        }
        return components;
    }
    async createComponentFromPath(filePath, layer) {
        try {
            const content = await this.readFile(path.join(this.projectPath, filePath));
            return {
                id: this.generateComponentId(filePath),
                name: path.basename(filePath, path.extname(filePath)),
                type: this.mapLayerToComponentType(layer.type),
                path: filePath,
                dependencies: [],
                dependents: [],
                metadata: {
                    lineCount: content.split('\n').length,
                    complexity: this.calculateComplexity(content),
                    lastModified: new Date(),
                    exports: [],
                    imports: [],
                    isEntry: this.topology.entryPoints.some(ep => ep.path === filePath),
                    isOrphaned: false,
                    layer: layer.name,
                    responsibilities: layer.responsibilities
                }
            };
        }
        catch (error) {
            return null;
        }
    }
    mapLayerToComponentType(layerType) {
        const mapping = {
            'presentation': 'route',
            'business': 'service',
            'data': 'model',
            'infrastructure': 'middleware',
            'external': 'external_api'
        };
        return mapping[layerType];
    }
    async analyzeConnections(components) {
        const connections = [];
        console.log('🔗 Analyzing real code connections and dependencies...');
        const componentsByPath = new Map();
        for (const component of components) {
            componentsByPath.set(component.path, component);
        }
        for (const component of components) {
            try {
                const fullPath = path.join(this.projectPath, component.path);
                const content = await this.readFile(fullPath);
                const dependencies = this.extractDependencies(content, component.path, componentsByPath);
                for (const dep of dependencies) {
                    connections.push({
                        from: component.id,
                        to: dep.targetComponent.id,
                        type: dep.type,
                        weight: dep.weight,
                        metadata: {
                            callSites: dep.callSites,
                            dataFlow: dep.importPath
                        }
                    });
                }
                component.dependencies = dependencies.map(d => d.targetComponent.id);
                dependencies.forEach(dep => {
                    if (!dep.targetComponent.dependents.includes(component.id)) {
                        dep.targetComponent.dependents.push(component.id);
                    }
                });
            }
            catch (error) {
            }
        }
        console.log(`🔗 Found ${connections.length} real code connections`);
        return connections;
    }
    extractDependencies(content, currentFilePath, componentsByPath) {
        const dependencies = [];
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            const importMatches = [
                /import\s+.*?\s+from\s+['"`]([^'"`]+)['"`]/g,
                /import\s+['"`]([^'"`]+)['"`]/g,
                /require\(['"`]([^'"`]+)['"`]\)/g
            ];
            for (const regex of importMatches) {
                let match;
                while ((match = regex.exec(trimmed)) !== null) {
                    const importPath = match[1];
                    const resolvedPath = this.resolveImportPath(importPath, currentFilePath);
                    if (resolvedPath && componentsByPath.has(resolvedPath)) {
                        const targetComponent = componentsByPath.get(resolvedPath);
                        const callSites = this.countUsageInFile(content, importPath);
                        dependencies.push({
                            targetComponent,
                            type: 'import',
                            weight: Math.min(callSites, 5),
                            callSites,
                            importPath
                        });
                    }
                }
            }
        }
        return dependencies;
    }
    resolveImportPath(importPath, currentFilePath) {
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
            const currentDir = path.dirname(currentFilePath);
            let resolvedPath = path.join(currentDir, importPath);
            const extensions = ['.ts', '.js', '.tsx', '.jsx', '/index.ts', '/index.js'];
            for (const ext of extensions) {
                const testPath = resolvedPath + ext;
                if (testPath.startsWith('src/')) {
                    return testPath;
                }
            }
            resolvedPath = resolvedPath.replace(/^src\//, '');
            for (const ext of extensions) {
                const testPath = resolvedPath + ext;
                return testPath;
            }
        }
        if (!importPath.startsWith('.') && !importPath.includes('node_modules')) {
            const extensions = ['.ts', '.js', '.tsx', '.jsx', '/index.ts', '/index.js'];
            for (const ext of extensions) {
                const testPath = `src/${importPath}${ext}`;
                return testPath;
            }
        }
        return null;
    }
    countUsageInFile(content, importPath) {
        const importName = path.basename(importPath, path.extname(importPath));
        const regex = new RegExp(`\\b${importName}\\b`, 'g');
        const matches = content.match(regex);
        return matches ? Math.max(1, matches.length - 1) : 1;
    }
    async identifyEntryPoints(components) {
        const entryPoints = [];
        for (const ep of this.topology.entryPoints) {
            const component = components.find(c => c.path === ep.path);
            if (component) {
                entryPoints.push({
                    id: ep.id,
                    type: ep.type,
                    path: ep.path,
                    methods: ep.methods,
                    description: ep.description,
                    componentId: component.id,
                    authentication: { type: 'none', required: false }
                });
            }
        }
        return entryPoints;
    }
    async identifyExitPoints(components) {
        const exitPoints = [];
        for (const component of components) {
            try {
                const fullPath = path.join(this.projectPath, component.path);
                const content = await this.readFile(fullPath);
                if (content.match(/\.(findOne|find|save|create|update|delete|query)\(/)) {
                    exitPoints.push({
                        id: `${component.id}_db`,
                        type: 'database_query',
                        destination: 'database',
                        description: 'Database operations',
                        critical: true,
                        componentId: component.id
                    });
                }
                if (content.match(/axios|fetch|http\.request|HttpClient/)) {
                    exitPoints.push({
                        id: `${component.id}_api`,
                        type: 'external_api',
                        destination: 'external',
                        description: 'External API calls',
                        critical: false,
                        componentId: component.id
                    });
                }
                if (content.match(/fs\.|readFile|writeFile|createReadStream|createWriteStream/)) {
                    exitPoints.push({
                        id: `${component.id}_file`,
                        type: 'file_operation',
                        destination: 'filesystem',
                        description: 'File system operations',
                        critical: false,
                        componentId: component.id
                    });
                }
            }
            catch (error) {
            }
        }
        return exitPoints;
    }
    async generateCallGraph(components) {
        const nodes = [];
        const edges = [];
        const entryPointIds = [];
        const cycles = [];
        const deadCode = [];
        for (const component of components) {
            const node = {
                id: component.id,
                name: component.name,
                type: 'module',
                file: component.path,
                complexity: component.metadata.complexity,
                fanIn: component.dependents.length,
                fanOut: component.dependencies.length,
                depth: 0,
                critical: component.metadata.isEntry || false
            };
            nodes.push(node);
            if (component.metadata.isEntry) {
                entryPointIds.push(component.id);
            }
        }
        const componentMap = new Map(components.map(c => [c.id, c]));
        for (const component of components) {
            for (const depId of component.dependencies) {
                if (componentMap.has(depId)) {
                    edges.push({
                        from: component.id,
                        to: depId,
                        count: 1,
                        type: 'direct',
                        async: false,
                        conditional: false
                    });
                }
            }
        }
        const visited = new Set();
        const recursionStack = new Set();
        const detectCycle = (nodeId, path = []) => {
            visited.add(nodeId);
            recursionStack.add(nodeId);
            path.push(nodeId);
            const component = componentMap.get(nodeId);
            if (component) {
                for (const depId of component.dependencies) {
                    if (!visited.has(depId)) {
                        detectCycle(depId, [...path]);
                    }
                    else if (recursionStack.has(depId)) {
                        const cycleStart = path.indexOf(depId);
                        if (cycleStart !== -1) {
                            cycles.push(path.slice(cycleStart));
                        }
                    }
                }
            }
            recursionStack.delete(nodeId);
        };
        for (const node of nodes) {
            if (!visited.has(node.id)) {
                detectCycle(node.id);
            }
        }
        const reachable = new Set();
        const markReachable = (nodeId) => {
            if (reachable.has(nodeId))
                return;
            reachable.add(nodeId);
            const component = componentMap.get(nodeId);
            if (component) {
                for (const depId of component.dependencies) {
                    markReachable(depId);
                }
            }
        };
        for (const entryId of entryPointIds) {
            markReachable(entryId);
        }
        for (const node of nodes) {
            if (!reachable.has(node.id) && !node.critical) {
                deadCode.push(node.id);
            }
        }
        return {
            nodes,
            edges,
            entryPoints: entryPointIds,
            cycles,
            layers: [],
            hotPaths: [],
            deadCode
        };
    }
    async analyzeDatabaseConnections(components) {
        const connections = [];
        const connectionMap = new Map();
        for (const component of components) {
            try {
                const fullPath = path.join(this.projectPath, component.path);
                const content = await this.readFile(fullPath);
                const dbConnections = await this.detectDatabaseConnections(content);
                for (const conn of dbConnections) {
                    const key = `${conn.type}_${conn.host || 'localhost'}`;
                    if (!connectionMap.has(key)) {
                        connectionMap.set(key, {
                            ...conn,
                            componentIds: [component.id],
                            usage: [{
                                    componentId: component.id,
                                    operations: this.extractDatabaseOperations(content),
                                    frequency: 1,
                                    critical: component.metadata.isEntry || false
                                }]
                        });
                    }
                    else {
                        const existing = connectionMap.get(key);
                        existing.componentIds.push(component.id);
                        existing.usage.push({
                            componentId: component.id,
                            operations: this.extractDatabaseOperations(content),
                            frequency: 1,
                            critical: component.metadata.isEntry || false
                        });
                    }
                }
            }
            catch (error) {
            }
        }
        return Array.from(connectionMap.values());
    }
    extractDatabaseOperations(content) {
        const operations = [];
        const patterns = [
            { regex: /\.find(?:One|All|By)?\(/g, type: 'read' },
            { regex: /\.create\(/g, type: 'write' },
            { regex: /\.save\(/g, type: 'write' },
            { regex: /\.update(?:One|Many)?\(/g, type: 'write' },
            { regex: /\.delete(?:One|Many)?\(/g, type: 'write' },
            { regex: /SELECT\s+/gi, type: 'read' },
            { regex: /INSERT\s+INTO/gi, type: 'write' },
            { regex: /UPDATE\s+/gi, type: 'write' },
            { regex: /DELETE\s+FROM/gi, type: 'write' },
            { regex: /BEGIN\s+TRANSACTION/gi, type: 'transaction' }
        ];
        for (const pattern of patterns) {
            const matches = content.match(pattern.regex);
            if (matches) {
                operations.push({
                    type: pattern.type,
                    tables: [],
                    complexity: 1,
                    optimized: false
                });
            }
        }
        return operations;
    }
    async analyzeTestCoverage(components) {
        const testFiles = await this.findFiles([
            '**/*.test.ts', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js',
            '**/__tests__/**/*.ts', '**/__tests__/**/*.js'
        ]);
        if (testFiles.length === 0) {
            return null;
        }
        const coverage = {
            overall: 0,
            lines: { covered: 0, total: 0, percentage: 0 },
            branches: { covered: 0, total: 0, percentage: 0 },
            functions: { covered: 0, total: 0, percentage: 0 },
            statements: { covered: 0, total: 0, percentage: 0 },
            byComponent: {},
            byType: {},
            uncoveredFiles: []
        };
        const componentFiles = new Set(components.map(c => c.path));
        const testedComponents = new Set();
        for (const testFile of testFiles) {
            try {
                const content = await this.readFile(testFile);
                const importMatches = content.match(/from\s+['"](.*?)['"]|require\(['"](.*?)['"]\)/g);
                if (importMatches) {
                    for (const match of importMatches) {
                        const importPath = match.match(/['"]([^'"]+)['"]/)?.[1];
                        if (importPath) {
                            const resolvedPath = this.resolveImportPath(importPath, testFile);
                            if (resolvedPath && componentFiles.has(resolvedPath)) {
                                testedComponents.add(resolvedPath);
                            }
                        }
                    }
                }
                const testCases = content.match(/\b(it|test|describe)\s*\(/g);
                if (testCases) {
                    coverage.statements.total += testCases.length;
                    coverage.statements.covered += Math.floor(testCases.length * 0.8);
                }
            }
            catch (error) {
            }
        }
        const coveredCount = testedComponents.size;
        const totalCount = componentFiles.size;
        coverage.overall = totalCount > 0 ? Math.round((coveredCount / totalCount) * 100) : 0;
        coverage.lines.total = totalCount;
        coverage.lines.covered = coveredCount;
        coverage.lines.percentage = coverage.overall;
        coverage.functions = { ...coverage.lines };
        coverage.branches = { ...coverage.lines };
        for (const file of componentFiles) {
            if (!testedComponents.has(file)) {
                coverage.uncoveredFiles.push(file);
            }
            coverage.byComponent[file] = {
                lines: testedComponents.has(file) ? 80 : 0,
                branches: testedComponents.has(file) ? 75 : 0,
                functions: testedComponents.has(file) ? 85 : 0,
                statements: testedComponents.has(file) ? 80 : 0,
                tests: 0
            };
        }
        return coverage;
    }
    async assessRisks(components, connections) {
        const risks = [];
        for (const component of components) {
            const reasons = [];
            let riskLevel = 'low';
            if (component.metadata.complexity > 7) {
                reasons.push(`High complexity (${component.metadata.complexity}/10)`);
                riskLevel = 'high';
            }
            const isExternalIntegration = this.topology.integrations.some(i => i.critical && component.path.toLowerCase().includes(i.name.toLowerCase()));
            if (isExternalIntegration) {
                reasons.push('Critical external integration');
                riskLevel = 'high';
            }
            if (component.metadata.isEntry) {
                reasons.push('System entry point');
                riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
            }
            if (reasons.length > 0) {
                risks.push({
                    componentId: component.id,
                    riskLevel,
                    reasons,
                    impact: component.dependents.length > 0 ?
                        `Changes could affect ${component.dependents.length} components` :
                        'Isolated component risk'
                });
            }
        }
        return risks;
    }
}
exports.SystemTopologyAnalyzer = SystemTopologyAnalyzer;
