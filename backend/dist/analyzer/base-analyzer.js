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
exports.AnalyzerFactory = exports.BaseAnalyzer = void 0;
const errors_1 = require("./errors");
const metrics_1 = require("./metrics");
const cache_1 = require("./cache");
const telemetry_schema_1 = require("../telemetry/telemetry-schema");
const framework_detector_1 = require("./patterns/framework-detector");
const entry_exit_detector_1 = require("./patterns/entry-exit-detector");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class BaseAnalyzer {
    constructor() {
        this.projectPath = '';
        this.options = {};
        this.frameworkPatterns = new Map();
        this.callGraph = null;
        this.databaseConnections = [];
        this.testCoverage = null;
        this.startTime = 0;
        this.analysisId = '';
        this.errors = [];
        this.warnings = [];
        this.initializeFrameworkPatterns();
        this.metrics = new metrics_1.MetricsCollector();
        this.cache = new cache_1.CacheManager();
        this.analysisId = this.generateAnalysisId();
        this.frameworkDetector = new framework_detector_1.FrameworkDetector();
        this.entryExitDetector = new entry_exit_detector_1.EntryExitDetector();
    }
    generateAnalysisId() {
        return `analysis_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }
    async analyzeRepository(repositoryPath, options = {}) {
        this.startTime = Date.now();
        this.projectPath = repositoryPath;
        this.options = this.validateOptions(options);
        this.errors = [];
        this.warnings = [];
        await this.validateRepositoryPath(repositoryPath);
        if (this.options.enableCache) {
            await this.cache.initialize(this.options.cacheDirectory || path.join(repositoryPath, '.unravl-cache'));
        }
        console.log(`🔍 Starting ${this.getAnalyzerName()} analysis of: ${repositoryPath}`);
        this.metrics.startAnalysis(this.analysisId, repositoryPath);
        const span = telemetry_schema_1.telemetry.createSpan('analyzer.analyzeRepository', {
            analyzer: this.getAnalyzerName(),
            repositoryPath,
            analysisId: this.analysisId
        });
        telemetry_schema_1.telemetry.emit({
            type: 'analysis_started',
            source: {
                analyzer: this.getAnalyzerName(),
                analysisId: this.analysisId
            },
            data: {
                repositoryPath,
                timestamp: new Date().toISOString()
            }
        });
        try {
            const detection = await this.wrapWithMetrics('language_detection', () => this.detectLanguageAndFramework());
            if (detection.confidence < 0.5) {
                throw new errors_1.ValidationError(`${this.getAnalyzerName()} analyzer not suitable for this project`, { confidence: detection.confidence, requiredConfidence: 0.5 });
            }
            const discovery = await this.wrapWithMetrics('component_discovery', () => this.discoverComponents());
            console.log(`📁 Discovered ${discovery.totalFiles} files, analyzed ${discovery.analyzedFiles}, found ${discovery.components.length} components`);
            const connections = await this.wrapWithMetrics('connection_analysis', () => this.analyzeConnections(discovery.components));
            console.log(`🔗 Found ${connections.length} connections`);
            const entryPoints = await this.wrapWithMetrics('entry_point_identification', () => this.identifyEntryPoints(discovery.components));
            console.log(`🚪 Identified ${entryPoints.length} entry points`);
            const riskAreas = await this.wrapWithMetrics('risk_assessment', () => this.assessRisks(discovery.components, connections));
            const exitPoints = await this.wrapWithMetrics('exit_point_identification', () => this.identifyExitPoints(discovery.components));
            console.log(`🚪 Identified ${exitPoints.length} exit points`);
            this.callGraph = await this.wrapWithMetrics('call_graph_generation', () => this.generateCallGraph(discovery.components));
            console.log(`📊 Generated call graph with ${this.callGraph?.nodes.length || 0} nodes`);
            this.databaseConnections = await this.wrapWithMetrics('database_analysis', () => this.analyzeDatabaseConnections(discovery.components));
            console.log(`🗄️ Found ${this.databaseConnections.length} database connections`);
            this.testCoverage = await this.wrapWithMetrics('test_coverage_analysis', () => this.analyzeTestCoverage(discovery.components));
            console.log(`✅ Test coverage: ${this.testCoverage?.overall || 0}%`);
            const blueprint = {
                projectName: await this.getProjectName(),
                framework: detection.frameworks[0]?.name || detection.language,
                components: discovery.components,
                connections,
                entryPoints,
                exitPoints,
                orphanedComponents: this.identifyOrphanedComponents(discovery.components),
                riskAreas,
                metadata: await this.generateProjectMetadata(discovery, detection),
                technologyStack: await this.analyzeTechnologyStack(detection),
                dependencies: await this.analyzeDependencies(),
                databaseInfo: await this.analyzeDatabaseInfo(),
                apiEndpoints: await this.analyzeAPIEndpoints(discovery.components),
                securityAnalysis: await this.analyzeSecurityInfo(),
                testingInfo: await this.analyzeTestingInfo(),
                deploymentInfo: await this.analyzeDeploymentInfo()
            };
            const analysisTime = Date.now() - this.startTime;
            this.metrics.completeAnalysis(this.analysisId, analysisTime, blueprint);
            telemetry_schema_1.telemetry.emit({
                type: 'analysis_completed',
                source: {
                    analyzer: this.getAnalyzerName(),
                    analysisId: this.analysisId
                },
                data: {
                    duration: analysisTime,
                    componentCount: blueprint.components.length,
                    connectionCount: blueprint.connections.length,
                    entryPointCount: blueprint.entryPoints.length,
                    exitPointCount: blueprint.exitPoints.length,
                    riskCount: blueprint.riskAreas.length
                }
            });
            if (this.options.enableCache) {
                await this.cache.saveBlueprint(this.analysisId, blueprint);
            }
            console.log(`✅ ${this.getAnalyzerName()} analysis complete: ${blueprint.components.length} components, ${blueprint.connections.length} connections`);
            console.log(`⏱️ Analysis took ${(analysisTime / 1000).toFixed(2)} seconds`);
            if (this.warnings.length > 0) {
                console.log(`⚠️ ${this.warnings.length} warnings encountered during analysis`);
            }
            span.end();
            return blueprint;
        }
        catch (error) {
            const analysisTime = Date.now() - this.startTime;
            this.metrics.failAnalysis(this.analysisId, error, analysisTime);
            telemetry_schema_1.telemetry.emit({
                type: 'error_occurred',
                source: {
                    analyzer: this.getAnalyzerName(),
                    analysisId: this.analysisId
                },
                data: {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    duration: analysisTime
                }
            });
            span.end();
            if (error instanceof errors_1.AnalyzerError) {
                throw error;
            }
            throw new errors_1.AnalyzerError(`Analysis failed: ${error.message}`, 'ANALYSIS_FAILED', { analysisId: this.analysisId, projectPath: repositoryPath, error });
        }
    }
    async identifyEntryPoints(components) {
        const span = telemetry_schema_1.telemetry.createSpan('analyzer.identifyEntryPoints');
        try {
            const entryPoints = await this.entryExitDetector.detectEntryPoints(components, this.projectPath);
            span.end();
            return entryPoints;
        }
        catch (error) {
            telemetry_schema_1.telemetry.emit({
                type: 'error_occurred',
                source: {
                    analyzer: this.getAnalyzerName(),
                    component: 'entry-point-detection'
                },
                data: {
                    error: error instanceof Error ? error.message : String(error)
                }
            });
            span.end();
            return [];
        }
    }
    async identifyExitPoints(components) {
        const span = telemetry_schema_1.telemetry.createSpan('analyzer.identifyExitPoints');
        try {
            const exitPoints = await this.entryExitDetector.detectExitPoints(components, this.projectPath);
            span.end();
            return exitPoints;
        }
        catch (error) {
            telemetry_schema_1.telemetry.emit({
                type: 'error_occurred',
                source: {
                    analyzer: this.getAnalyzerName(),
                    component: 'exit-point-detection'
                },
                data: {
                    error: error instanceof Error ? error.message : String(error)
                }
            });
            span.end();
            return [];
        }
    }
    async getProjectName() {
        const packageJsonPath = `${this.projectPath}/package.json`;
        try {
            const fs = await Promise.resolve().then(() => __importStar(require('fs-extra')));
            const packageJson = await fs.readJSON(packageJsonPath);
            return packageJson.name || this.getDefaultProjectName();
        }
        catch {
            return this.getDefaultProjectName();
        }
    }
    getDefaultProjectName() {
        const path = require('path');
        return path.basename(this.projectPath);
    }
    identifyOrphanedComponents(components) {
        return components
            .filter(comp => comp.dependencies.length === 0 &&
            comp.dependents.length === 0 &&
            !comp.metadata.isEntry)
            .map(comp => comp.id);
    }
    async generateProjectMetadata(discovery, detection) {
        const avgComplexity = discovery.components.length > 0
            ? discovery.components.reduce((sum, c) => sum + c.metadata.complexity, 0) / discovery.components.length
            : 0;
        return {
            totalComponents: discovery.components.length,
            frameworkVersion: detection.frameworks[0]?.version || 'unknown',
            analysisDate: new Date(),
            repositoryPath: this.projectPath,
            entryPointsCount: 0,
            orphanedCount: 0,
            complexityAverage: avgComplexity,
            primaryLanguage: detection.language,
            languageDistribution: await this.calculateLanguageDistribution(),
            codebaseSize: await this.calculateCodebaseSize(),
            aiGeneratedSummary: undefined
        };
    }
    validateOptions(options) {
        const defaults = {
            includeTests: true,
            maxDepth: 10,
            excludePatterns: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
            enableCache: true,
            metricsEnabled: true,
            maxFileSize: 10 * 1024 * 1024,
            timeout: 5 * 60 * 1000,
            parallel: false,
            maxWorkers: 4
        };
        const merged = { ...defaults, ...options };
        if (merged.maxDepth < 1 || merged.maxDepth > 100) {
            throw new errors_1.ValidationError('maxDepth must be between 1 and 100', { maxDepth: merged.maxDepth });
        }
        if (merged.maxFileSize < 0) {
            throw new errors_1.ValidationError('maxFileSize must be non-negative', { maxFileSize: merged.maxFileSize });
        }
        if (merged.timeout < 1000) {
            throw new errors_1.ValidationError('timeout must be at least 1000ms', { timeout: merged.timeout });
        }
        if (merged.maxWorkers < 1 || merged.maxWorkers > 16) {
            throw new errors_1.ValidationError('maxWorkers must be between 1 and 16', { maxWorkers: merged.maxWorkers });
        }
        return merged;
    }
    async validateRepositoryPath(repositoryPath) {
        try {
            const stats = await fs.stat(repositoryPath);
            if (!stats.isDirectory()) {
                throw new errors_1.FileSystemError(`Repository path is not a directory: ${repositoryPath}`, 'NOT_DIRECTORY');
            }
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                throw new errors_1.FileSystemError(`Repository path does not exist: ${repositoryPath}`, 'PATH_NOT_FOUND');
            }
            throw error;
        }
        try {
            await fs.access(repositoryPath, fs.constants.R_OK);
        }
        catch (error) {
            throw new errors_1.FileSystemError(`No read permission for repository: ${repositoryPath}`, 'PERMISSION_DENIED');
        }
    }
    async wrapWithMetrics(operationName, operation) {
        const startTime = Date.now();
        try {
            const result = await operation();
            const duration = Date.now() - startTime;
            if (this.options.metricsEnabled) {
                this.metrics.recordOperation(operationName, duration, true);
            }
            return result;
        }
        catch (error) {
            const duration = Date.now() - startTime;
            if (this.options.metricsEnabled) {
                this.metrics.recordOperation(operationName, duration, false, error);
            }
            throw error;
        }
    }
    async findFiles(patterns, excludePatterns = []) {
        const { glob } = await Promise.resolve().then(() => __importStar(require('glob')));
        const allFiles = [];
        for (const pattern of patterns) {
            const files = await glob(pattern, {
                cwd: this.projectPath,
                ignore: excludePatterns,
                absolute: true
            });
            allFiles.push(...files);
        }
        return [...new Set(allFiles)];
    }
    async readFile(filePath) {
        try {
            const stats = await fs.stat(filePath);
            if (this.options.maxFileSize && stats.size > this.options.maxFileSize) {
                this.warnings.push(`File ${filePath} exceeds maximum size (${stats.size} bytes), skipping`);
                throw new errors_1.FileSystemError(`File exceeds maximum size: ${filePath}`, 'FILE_TOO_LARGE', { filePath, size: stats.size, maxSize: this.options.maxFileSize });
            }
            if (this.options.enableCache) {
                const cachedContent = await this.cache.getFileContent(filePath, stats.mtime);
                if (cachedContent) {
                    return cachedContent;
                }
            }
            const content = await fs.readFile(filePath, 'utf-8');
            if (this.options.enableCache) {
                await this.cache.saveFileContent(filePath, content, stats.mtime);
            }
            return content;
        }
        catch (error) {
            if (error instanceof errors_1.FileSystemError) {
                throw error;
            }
            throw new errors_1.FileSystemError(`Failed to read file: ${filePath}`, 'READ_ERROR', { filePath, error });
        }
    }
    generateComponentId(filePath) {
        const path = require('path');
        const relativePath = path.relative(this.projectPath, filePath);
        return relativePath.replace(/[^a-zA-Z0-9]/g, '_');
    }
    calculateComplexity(content) {
        const complexityPatterns = [
            /\bif\b/g, /\belse\b/g, /\bwhile\b/g, /\bfor\b/g,
            /\bswitch\b/g, /\bcase\b/g, /\btry\b/g, /\bcatch\b/g,
            /\bthrow\b/g, /\breturn\b/g, /\b&&\b/g, /\b\|\|\b/g,
            /\?\s*:/g,
        ];
        let complexity = 1;
        for (const pattern of complexityPatterns) {
            const matches = content.match(pattern);
            if (matches) {
                complexity += matches.length;
            }
        }
        return Math.min(complexity, 10);
    }
    initializeFrameworkPatterns() {
        this.frameworkPatterns.set('express', {
            name: 'Express',
            files: ['app.js', 'server.js', 'index.js'],
            dependencies: ['express'],
            patterns: [
                /app\.use\(/,
                /app\.get\(/,
                /app\.post\(/,
                /express\(\)/,
                /Router\(\)/
            ],
            configPatterns: [
                'app.set(',
                'app.engine(',
                'express.static('
            ]
        });
        this.frameworkPatterns.set('react', {
            name: 'React',
            files: ['App.jsx', 'App.tsx', 'index.jsx', 'index.tsx'],
            dependencies: ['react', 'react-dom'],
            patterns: [
                /import.*React/,
                /from ['"]react['"]/,
                /useState\(/,
                /useEffect\(/,
                /\.jsx$/,
                /<[A-Z][a-zA-Z]*.*\/>/
            ],
            configPatterns: [
                'ReactDOM.render(',
                'ReactDOM.createRoot(',
                'createElement('
            ]
        });
        this.frameworkPatterns.set('nestjs', {
            name: 'NestJS',
            files: ['main.ts', 'app.module.ts'],
            dependencies: ['@nestjs/core', '@nestjs/common'],
            patterns: [
                /@Module\(/,
                /@Controller\(/,
                /@Injectable\(/,
                /@Get\(/,
                /@Post\(/,
                /NestFactory\.create/
            ],
            configPatterns: [
                'imports:',
                'providers:',
                'controllers:',
                'exports:'
            ]
        });
        this.frameworkPatterns.set('django', {
            name: 'Django',
            files: ['manage.py', 'settings.py', 'urls.py', 'wsgi.py'],
            dependencies: ['django'],
            patterns: [
                /from django/,
                /import django/,
                /django\.contrib/,
                /path\(/,
                /urlpatterns/
            ],
            configPatterns: [
                'INSTALLED_APPS',
                'MIDDLEWARE',
                'DATABASES',
                'DEBUG ='
            ]
        });
        this.frameworkPatterns.set('spring', {
            name: 'Spring Boot',
            files: ['pom.xml', 'build.gradle', 'application.properties', 'application.yml'],
            dependencies: ['spring-boot-starter'],
            patterns: [
                /@SpringBootApplication/,
                /@RestController/,
                /@Service/,
                /@Repository/,
                /@Component/,
                /@Autowired/
            ],
            configPatterns: [
                'spring.datasource',
                'server.port',
                'spring.jpa'
            ]
        });
    }
    async detectFramework(content, filePath) {
        let bestMatch = null;
        let highestConfidence = 0;
        for (const [key, pattern] of this.frameworkPatterns) {
            let confidence = 0;
            const matches = [];
            const fileName = require('path').basename(filePath);
            if (pattern.files?.includes(fileName)) {
                confidence += 0.3;
                matches.push(`File: ${fileName}`);
            }
            for (const regex of pattern.patterns || []) {
                if (regex.test(content)) {
                    confidence += 0.2;
                    matches.push(`Pattern: ${regex.source}`);
                }
            }
            for (const configPattern of pattern.configPatterns || []) {
                if (content.includes(configPattern)) {
                    confidence += 0.15;
                    matches.push(`Config: ${configPattern}`);
                }
            }
            if (confidence > highestConfidence) {
                highestConfidence = confidence;
                bestMatch = {
                    name: pattern.name,
                    version: await this.detectFrameworkVersion(pattern.name, content),
                    confidence,
                    patterns: matches,
                    configFiles: pattern.files,
                    dependencies: pattern.dependencies
                };
            }
        }
        return bestMatch;
    }
    async detectFrameworkVersion(framework, content) {
        const versionPatterns = {
            'Express': /"express":\s*"[~^]?([0-9.]+)"/,
            'React': /"react":\s*"[~^]?([0-9.]+)"/,
            'NestJS': /"@nestjs\/core":\s*"[~^]?([0-9.]+)"/,
            'Django': /Django==([0-9.]+)/,
            'Spring Boot': /<version>([0-9.]+)<\/version>/
        };
        const pattern = versionPatterns[framework];
        if (pattern) {
            const match = content.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }
        return undefined;
    }
    async extractFunctions(content, language) {
        const functions = [];
        const patterns = {
            javascript: /(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function))/g,
            typescript: /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\s*\{)/g,
            python: /(?:def\s+(\w+)\s*\([^)]*\)|async\s+def\s+(\w+)\s*\([^)]*\))/g,
            java: /(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g
        };
        const pattern = patterns[language.toLowerCase()];
        if (!pattern)
            return functions;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const functionName = match[1] || match[2];
            if (functionName) {
                const functionInfo = {
                    name: functionName,
                    signature: match[0],
                    parameters: this.extractParameters(match[0]),
                    returnType: this.extractReturnType(match[0], language),
                    complexity: this.calculateFunctionComplexity(content, match.index),
                    lineCount: this.calculateFunctionLineCount(content, match.index),
                    isPublic: /public/.test(match[0]),
                    isAsync: /async/.test(match[0]),
                    isStatic: /static/.test(match[0]),
                    calls: [],
                    calledBy: []
                };
                functions.push(functionInfo);
            }
        }
        return functions;
    }
    extractParameters(signature) {
        const paramMatch = signature.match(/\(([^)]*)\)/);
        if (!paramMatch || !paramMatch[1])
            return [];
        const params = paramMatch[1].split(',').map(p => p.trim()).filter(p => p);
        return params.map(param => {
            const parts = param.split(/[:\s=]/);
            return {
                name: parts[0].replace(/[^\w]/g, ''),
                type: parts[1] || 'any',
                isOptional: param.includes('?') || param.includes('='),
                defaultValue: param.includes('=') ? param.split('=')[1]?.trim() : undefined
            };
        });
    }
    extractReturnType(signature, language) {
        if (language === 'typescript' || language === 'java') {
            const match = signature.match(/\)\s*:\s*([^{]+)/);
            return match ? match[1].trim() : 'void';
        }
        if (language === 'python') {
            const match = signature.match(/->\s*([^:]+)/);
            return match ? match[1].trim() : 'Any';
        }
        return 'unknown';
    }
    calculateFunctionComplexity(content, startIndex) {
        let braceCount = 0;
        let inFunction = false;
        let functionContent = '';
        for (let i = startIndex; i < content.length; i++) {
            if (content[i] === '{') {
                braceCount++;
                inFunction = true;
            }
            else if (content[i] === '}') {
                braceCount--;
                if (braceCount === 0 && inFunction) {
                    break;
                }
            }
            if (inFunction) {
                functionContent += content[i];
            }
        }
        return this.calculateComplexity(functionContent);
    }
    calculateFunctionLineCount(content, startIndex) {
        let braceCount = 0;
        let inFunction = false;
        let lineCount = 0;
        for (let i = startIndex; i < content.length; i++) {
            if (content[i] === '{') {
                braceCount++;
                inFunction = true;
            }
            else if (content[i] === '}') {
                braceCount--;
                if (braceCount === 0 && inFunction) {
                    break;
                }
            }
            if (inFunction && content[i] === '\n') {
                lineCount++;
            }
        }
        return lineCount;
    }
    async detectDatabaseConnections(content) {
        const connections = [];
        const patterns = [
            {
                type: 'postgresql',
                regex: /(?:postgres(?:ql)?:\/\/|DATABASE_URL.*postgres)/i,
                extract: /(?:host[=:]\s*['"]?([^'"\s,;]+)|postgres:\/\/[^:]+:[^@]+@([^:\/]+))/
            },
            {
                type: 'mysql',
                regex: /(?:mysql:\/\/|mysql\.createConnection)/i,
                extract: /(?:host[=:]\s*['"]?([^'"\s,;]+)|mysql:\/\/[^:]+:[^@]+@([^:\/]+))/
            },
            {
                type: 'mongodb',
                regex: /(?:mongodb(?:\+srv)?:\/\/|MongoClient)/i,
                extract: /mongodb(?:\+srv)?:\/\/([^:\/]+)/
            },
            {
                type: 'redis',
                regex: /(?:redis:\/\/|createClient.*redis)/i,
                extract: /(?:host[=:]\s*['"]?([^'"\s,;]+)|redis:\/\/([^:\/]+))/
            },
            {
                type: 'sqlite',
                regex: /(?:sqlite3?:\/\/|sqlite3\.connect)/i,
                extract: /(?:sqlite3?:\/\/([^'"\s]+)|database[=:]\s*['"]?([^'"\s,;]+))/
            }
        ];
        for (const pattern of patterns) {
            if (pattern.regex.test(content)) {
                const match = content.match(pattern.extract);
                const connection = {
                    id: `db_${pattern.type}_${connections.length}`,
                    name: pattern.type,
                    type: pattern.type,
                    host: match ? match[1] || match[2] : undefined,
                    componentIds: [],
                    usage: []
                };
                connections.push(connection);
            }
        }
        return connections;
    }
    async analyzeEndpointControllers(content, framework) {
        const endpoints = [];
        const patterns = {
            'Express': [
                /app\.(get|post|put|delete|patch)\(['"]([^'"]+)['"].*?(?:,\s*(?:async\s*)?(?:function\s*)?(\w+)|,\s*(?:async\s*)?\()/g,
                /router\.(get|post|put|delete|patch)\(['"]([^'"]+)['"].*?(?:,\s*(?:async\s*)?(?:function\s*)?(\w+)|,\s*(?:async\s*)?\()/g
            ],
            'NestJS': [
                /@(Get|Post|Put|Delete|Patch)\(['"]?([^'"\)]*)['"]?\)\s*(?:async\s+)?(\w+)/g,
                /@Controller\(['"]([^'"]+)['"]\)/g
            ],
            'Django': [
                /path\(['"]([^'"]+)['"],\s*([\w.]+)/g,
                /url\(r?['"]([^'"]+)['"],\s*([\w.]+)/g
            ],
            'Spring Boot': [
                /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\(['"]([^'"]+)['"]\)\s*public\s+\w+\s+(\w+)/g,
                /@RequestMapping\(['"]([^'"]+)['"]\)/g
            ]
        };
        const frameworkPatterns = patterns[framework];
        if (!frameworkPatterns)
            return endpoints;
        for (const pattern of frameworkPatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                endpoints.push({
                    method: match[1]?.toUpperCase() || 'GET',
                    path: match[2] || match[1],
                    handler: match[3] || 'anonymous',
                    controller: this.extractControllerName(content, match.index)
                });
            }
        }
        return endpoints;
    }
    extractControllerName(content, position) {
        const before = content.substring(0, position);
        const classMatch = before.match(/(?:class|controller)\s+(\w+)/i);
        return classMatch ? classMatch[1] : 'UnknownController';
    }
    async calculateTestCoverageMetrics(testFiles) {
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
        return coverage;
    }
    async calculateLanguageDistribution() {
        const distribution = {};
        const extensions = {
            '.js': 'JavaScript',
            '.ts': 'TypeScript',
            '.jsx': 'JavaScript',
            '.tsx': 'TypeScript',
            '.py': 'Python',
            '.java': 'Java',
            '.cs': 'C#',
            '.go': 'Go',
            '.rb': 'Ruby',
            '.php': 'PHP'
        };
        const files = await this.findFiles(['**/*'], ['node_modules/**', '**/dist/**', '**/build/**']);
        for (const file of files) {
            const ext = require('path').extname(file).toLowerCase();
            if (extensions[ext]) {
                distribution[extensions[ext]] = (distribution[extensions[ext]] || 0) + 1;
            }
        }
        return distribution;
    }
    async calculateCodebaseSize() {
        let totalLines = 0;
        let codeLines = 0;
        let commentLines = 0;
        let blankLines = 0;
        const files = await this.findFiles(['**/*.{js,ts,jsx,tsx,py,java,cs,go,rb,php}'], ['node_modules/**', '**/dist/**', '**/build/**']);
        for (const file of files) {
            try {
                const content = await this.readFile(file);
                const lines = content.split('\n');
                totalLines += lines.length;
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        blankLines++;
                    }
                    else if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
                        commentLines++;
                    }
                    else {
                        codeLines++;
                    }
                }
            }
            catch (error) {
            }
        }
        return { totalLines, codeLines, commentLines, blankLines };
    }
    async analyzeTechnologyStack(detection) {
        const frameworks = detection.frameworks.map(f => ({
            name: f.name,
            version: f.version || 'unknown',
            type: 'web',
            usage: 'primary',
            conventions: [],
            patterns: f.patterns,
            configFiles: f.configFiles,
            detectionConfidence: f.confidence,
            metadata: f.metadata
        }));
        return {
            primaryFramework: frameworks[0] || null,
            additionalFrameworks: frameworks.slice(1),
            languages: [{
                    name: detection.language,
                    fileCount: detection.files.length,
                    lineCount: 0,
                    percentage: 100
                }],
            buildTools: [],
            testingFrameworks: [],
            databases: [],
            messageQueues: [],
            caching: [],
            authentication: [],
            deployment: []
        };
    }
    async analyzeDependencies() {
        return {
            totalCount: 0,
            directDependencies: [],
            devDependencies: [],
            peerDependencies: [],
            vulnerabilities: [],
            outdated: [],
            unused: [],
            licenseCompliance: []
        };
    }
    async analyzeDatabaseInfo() {
        if (this.databaseConnections.length === 0) {
            return undefined;
        }
        const firstConnection = this.databaseConnections[0];
        return {
            type: firstConnection.type,
            connectionMethod: 'driver',
            host: firstConnection.host,
            port: firstConnection.port,
            database: firstConnection.database,
            connections: this.databaseConnections,
            schema: undefined,
            migrations: [],
            queries: [],
            performance: {
                avgQueryTime: 0,
                slowQueries: [],
                nPlusOneProblems: [],
                indexUsage: {}
            }
        };
    }
    async analyzeAPIEndpoints(components) {
        return [];
    }
    async analyzeSecurityInfo() {
        return {
            vulnerabilities: [],
            authenticationMethods: [],
            authorizationPatterns: [],
            dataEncryption: [],
            inputValidation: [],
            securityHeaders: [],
            secrets: []
        };
    }
    async analyzeTestingInfo() {
        return {
            frameworks: [],
            coverage: this.testCoverage || {
                overall: 0,
                lines: { covered: 0, total: 0, percentage: 0 },
                branches: { covered: 0, total: 0, percentage: 0 },
                functions: { covered: 0, total: 0, percentage: 0 },
                statements: { covered: 0, total: 0, percentage: 0 },
                byComponent: {},
                byType: {},
                uncoveredFiles: []
            },
            testTypes: [],
            testFiles: [],
            totalTests: 0,
            passingTests: 0,
            failingTests: 0,
            skippedTests: 0,
            testSuites: []
        };
    }
    async analyzeDeploymentInfo() {
        return {
            platform: 'unknown',
            containerization: { type: 'none' },
            cicd: {
                platform: 'unknown',
                configFile: '',
                stages: [],
                deploymentStrategy: 'unknown',
                automated: false
            },
            monitoring: {
                tools: [],
                metrics: [],
                logging: {
                    level: 'info',
                    destination: 'unknown',
                    structured: false,
                    aggregation: false
                },
                alerting: {
                    platform: 'unknown',
                    rules: [],
                    channels: []
                }
            },
            scaling: {
                type: 'horizontal',
                automatic: false,
                metrics: [],
                limits: {
                    minInstances: 1,
                    maxInstances: 1,
                    cpu: '100%',
                    memory: '100%'
                }
            }
        };
    }
}
exports.BaseAnalyzer = BaseAnalyzer;
class AnalyzerFactory {
    static registerAnalyzer(analyzer) {
        this.analyzers.push(analyzer);
    }
    static async createAnalyzer(repositoryPath) {
        const detections = [];
        for (const analyzer of this.analyzers) {
            try {
                analyzer['projectPath'] = repositoryPath;
                const detection = await analyzer['detectLanguageAndFramework'].call(analyzer);
                detections.push({ analyzer, confidence: detection.confidence });
            }
            catch (error) {
                continue;
            }
        }
        detections.sort((a, b) => b.confidence - a.confidence);
        if (detections.length > 0 && detections[0].confidence > 0.3) {
            console.log(`Selected ${detections[0].analyzer.getAnalyzerName()} analyzer with ${(detections[0].confidence * 100).toFixed(0)}% confidence`);
            return detections[0].analyzer;
        }
        throw new Error('No suitable analyzer found for this project type');
    }
    static getAvailableAnalyzers() {
        return this.analyzers.map(analyzer => analyzer.getAnalyzerName());
    }
    static async detectProjectStack(repositoryPath) {
        const stack = {
            languages: [],
            frameworks: [],
            databases: [],
            tools: []
        };
        const fs = await Promise.resolve().then(() => __importStar(require('fs-extra')));
        const path = require('path');
        try {
            const packageJson = await fs.readJSON(path.join(repositoryPath, 'package.json'));
            stack.languages.push('JavaScript/TypeScript');
            const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
            if (deps.express)
                stack.frameworks.push('Express');
            if (deps.react)
                stack.frameworks.push('React');
            if (deps['@nestjs/core'])
                stack.frameworks.push('NestJS');
            if (deps.vue)
                stack.frameworks.push('Vue');
            if (deps['@angular/core'])
                stack.frameworks.push('Angular');
            if (deps.next)
                stack.frameworks.push('Next.js');
            if (deps.jest || deps.mocha)
                stack.tools.push(deps.jest ? 'Jest' : 'Mocha');
            if (deps.webpack || deps.vite || deps.parcel) {
                stack.tools.push(deps.webpack ? 'Webpack' : deps.vite ? 'Vite' : 'Parcel');
            }
        }
        catch { }
        try {
            const requirements = await fs.readFile(path.join(repositoryPath, 'requirements.txt'), 'utf-8');
            stack.languages.push('Python');
            if (requirements.includes('django'))
                stack.frameworks.push('Django');
            if (requirements.includes('flask'))
                stack.frameworks.push('Flask');
            if (requirements.includes('fastapi'))
                stack.frameworks.push('FastAPI');
            if (requirements.includes('pytest'))
                stack.tools.push('Pytest');
        }
        catch { }
        try {
            const pomExists = await fs.pathExists(path.join(repositoryPath, 'pom.xml'));
            const gradleExists = await fs.pathExists(path.join(repositoryPath, 'build.gradle'));
            if (pomExists || gradleExists) {
                stack.languages.push('Java');
                stack.tools.push(pomExists ? 'Maven' : 'Gradle');
            }
        }
        catch { }
        try {
            const dockerCompose = await fs.readFile(path.join(repositoryPath, 'docker-compose.yml'), 'utf-8');
            if (dockerCompose.includes('postgres'))
                stack.databases.push('PostgreSQL');
            if (dockerCompose.includes('mysql'))
                stack.databases.push('MySQL');
            if (dockerCompose.includes('mongo'))
                stack.databases.push('MongoDB');
            if (dockerCompose.includes('redis'))
                stack.databases.push('Redis');
        }
        catch { }
        return stack;
    }
}
exports.AnalyzerFactory = AnalyzerFactory;
AnalyzerFactory.analyzers = [];
