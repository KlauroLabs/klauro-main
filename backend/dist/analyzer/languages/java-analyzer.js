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
exports.JavaAnalyzer = void 0;
const base_analyzer_1 = require("../base-analyzer");
const telemetry_schema_1 = require("../../telemetry/telemetry-schema");
const errors_1 = require("../errors");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class JavaAnalyzer extends base_analyzer_1.BaseAnalyzer {
    constructor() {
        super(...arguments);
        this.javaVersion = '';
        this.buildTool = 'unknown';
        this.isSpringProject = false;
        this.hasTests = false;
    }
    getAnalyzerName() {
        return 'Java Analyzer';
    }
    getSupportedLanguages() {
        return ['java', 'kotlin', 'scala'];
    }
    getSupportedFrameworks() {
        return [
            'spring-boot', 'spring-mvc', 'spring-data', 'spring-security',
            'hibernate', 'jpa', 'mybatis', 'jdbi',
            'junit', 'testng', 'mockito', 'spock',
            'servlet-api', 'jax-rs', 'jax-ws', 'jersey',
            'apache-kafka', 'apache-camel', 'apache-cxf',
            'maven', 'gradle', 'ant',
            'tomcat', 'jetty', 'undertow',
            'jackson', 'gson', 'lombok'
        ];
    }
    async detectLanguageAndFramework() {
        const span = telemetry_schema_1.telemetry.createSpan('java-analyzer.detectLanguageAndFramework');
        let confidence = 0;
        const frameworks = [];
        const files = [];
        try {
            const javaFiles = await this.findFiles(['**/*.java'], this.options.excludePatterns);
            const kotlinFiles = await this.findFiles(['**/*.kt', '**/*.kts'], this.options.excludePatterns);
            const scalaFiles = await this.findFiles(['**/*.scala'], this.options.excludePatterns);
            files.push(...javaFiles, ...kotlinFiles, ...scalaFiles);
            if (javaFiles.length > 0) {
                confidence += 0.5;
            }
            if (kotlinFiles.length > 0) {
                confidence += 0.3;
            }
            if (scalaFiles.length > 0) {
                confidence += 0.2;
            }
            const javaSpecificFiles = [
                'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
                'build.xml', 'ivy.xml', 'gradle.properties', 'gradlew',
                'application.properties', 'application.yml', 'application.yaml',
                'web.xml', 'beans.xml', 'persistence.xml'
            ];
            for (const file of javaSpecificFiles) {
                const filePath = path.join(this.projectPath, file);
                if (await fs.pathExists(filePath)) {
                    confidence += 0.1;
                    files.push(filePath);
                    if (file === 'pom.xml') {
                        this.buildTool = 'maven';
                    }
                    else if (file.includes('gradle')) {
                        this.buildTool = 'gradle';
                    }
                    else if (file === 'build.xml') {
                        this.buildTool = 'ant';
                    }
                }
            }
            const buildFrameworks = await this.analyzeBuildFiles();
            frameworks.push(...buildFrameworks);
            if (javaFiles.length > 0) {
                const sampleFiles = javaFiles.slice(0, 25);
                const codeFrameworks = await this.analyzeCodeForFrameworks(sampleFiles);
                frameworks.push(...codeFrameworks);
            }
            this.isSpringProject = frameworks.some(f => f.name.toLowerCase().includes('spring'));
            await this.detectJavaVersion();
            confidence = Math.min(confidence, 1.0);
            telemetry_schema_1.telemetry.emit({
                type: 'analysis_started',
                source: { analyzer: this.getAnalyzerName() },
                data: {
                    language: 'java',
                    confidence,
                    filesCount: files.length,
                    frameworksFound: frameworks.length,
                    buildTool: this.buildTool,
                    isSpringProject: this.isSpringProject
                }
            });
            span.end();
            return {
                language: javaFiles.length > 0 ? 'java' : kotlinFiles.length > 0 ? 'kotlin' : 'scala',
                confidence,
                frameworks: frameworks.sort((a, b) => b.confidence - a.confidence),
                files
            };
        }
        catch (error) {
            span.end();
            throw new errors_1.AnalyzerError(`Java language detection failed: ${error.message}`, 'DETECTION_ERROR', { error });
        }
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('java-analyzer.discoverComponents');
        const components = [];
        let totalFiles = 0;
        let analyzedFiles = 0;
        let skippedFiles = 0;
        try {
            const sourceFiles = await this.findFiles(['**/*.java', '**/*.kt', '**/*.scala'], [...(this.options.excludePatterns || []), 'target/**', 'build/**', '.gradle/**']);
            totalFiles = sourceFiles.length;
            console.log(`☕ Analyzing ${totalFiles} Java/Kotlin/Scala files...`);
            for (const filePath of sourceFiles) {
                try {
                    const component = await this.analyzeFile(filePath);
                    if (component) {
                        components.push(component);
                        analyzedFiles++;
                    }
                    else {
                        skippedFiles++;
                    }
                }
                catch (error) {
                    console.warn(`⚠️ Failed to analyze ${filePath}: ${error.message}`);
                    skippedFiles++;
                }
                if ((analyzedFiles + skippedFiles) % 50 === 0) {
                    const progress = ((analyzedFiles + skippedFiles) / totalFiles) * 100;
                    console.log(`📊 Progress: ${progress.toFixed(1)}% (${analyzedFiles + skippedFiles}/${totalFiles})`);
                }
            }
            console.log(`✅ Java analysis complete: ${analyzedFiles} analyzed, ${skippedFiles} skipped`);
            span.end();
            return {
                totalFiles,
                analyzedFiles,
                skippedFiles,
                components
            };
        }
        catch (error) {
            span.end();
            throw new errors_1.AnalyzerError(`Java component discovery failed: ${error.message}`, 'DISCOVERY_ERROR', { error });
        }
    }
    async analyzeConnections(components) {
        const span = telemetry_schema_1.telemetry.createSpan('java-analyzer.analyzeConnections');
        const connections = [];
        try {
            console.log(`🔗 Analyzing Java connections between ${components.length} components...`);
            for (const component of components) {
                for (const importPath of component.metadata.imports) {
                    const targetComponent = this.findComponentByImportPath(components, importPath);
                    if (targetComponent && targetComponent.id !== component.id) {
                        connections.push({
                            from: component.id,
                            to: targetComponent.id,
                            type: 'import',
                            weight: 1,
                            metadata: {
                                callSites: 1,
                                dataFlow: 'import'
                            }
                        });
                    }
                }
                if (component.metadata.functions) {
                    for (const method of component.metadata.functions) {
                        for (const call of method.calls) {
                            const targetComponent = this.findComponentByMethodCall(components, call.target);
                            if (targetComponent && targetComponent.id !== component.id) {
                                connections.push({
                                    from: component.id,
                                    to: targetComponent.id,
                                    type: 'function_call',
                                    weight: call.count,
                                    metadata: {
                                        callSites: call.count,
                                        dataFlow: `${method.name} -> ${call.target}`
                                    }
                                });
                            }
                        }
                    }
                }
                if (this.isSpringProject) {
                    const injectionConnections = this.analyzeSpringDependencyInjection(component, components);
                    connections.push(...injectionConnections);
                }
            }
            const connectionMap = new Map();
            for (const conn of connections) {
                const key = `${conn.from}-${conn.to}-${conn.type}`;
                const existing = connectionMap.get(key);
                if (existing) {
                    existing.weight = (existing.weight || 0) + (conn.weight || 0);
                    existing.metadata.callSites += conn.metadata?.callSites || 0;
                }
                else {
                    connectionMap.set(key, conn);
                }
            }
            const uniqueConnections = Array.from(connectionMap.values());
            console.log(`🔗 Found ${uniqueConnections.length} unique connections`);
            span.end();
            return uniqueConnections;
        }
        catch (error) {
            span.end();
            throw new errors_1.AnalyzerError(`Java connection analysis failed: ${error.message}`, 'CONNECTION_ERROR', { error });
        }
    }
    async assessRisks(components, connections) {
        const risks = [];
        for (const component of components) {
            const reasons = [];
            let riskLevel = 'low';
            if (component.metadata.complexity >= 9) {
                reasons.push(`High complexity (${component.metadata.complexity})`);
                riskLevel = 'high';
            }
            else if (component.metadata.complexity >= 6) {
                reasons.push(`Medium complexity (${component.metadata.complexity})`);
                riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
            }
            if (component.metadata.lineCount > 1500) {
                reasons.push(`Large class (${component.metadata.lineCount} lines)`);
                riskLevel = 'high';
            }
            else if (component.metadata.lineCount > 800) {
                reasons.push(`Large class (${component.metadata.lineCount} lines)`);
                riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
            }
            const incomingConnections = connections.filter(c => c.to === component.id).length;
            if (incomingConnections > 12) {
                reasons.push(`High coupling (${incomingConnections} dependents)`);
                riskLevel = 'high';
            }
            else if (incomingConnections > 6) {
                reasons.push(`Medium coupling (${incomingConnections} dependents)`);
                riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
            }
            if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
                if (!this.hasTransactionManagement(component)) {
                    reasons.push('Database operations without transaction management');
                    riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
                }
            }
            if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) {
                reasons.push(`External API calls (${component.metadata.externalCalls.length})`);
                riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
            }
            if (component.type === 'service' && !this.hasCorrespondingTest(component, components)) {
                reasons.push('Critical service without test coverage');
                riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
            }
            if (reasons.length > 0) {
                risks.push({
                    componentId: component.id,
                    riskLevel,
                    reasons,
                    impact: this.calculateRiskImpact(riskLevel, incomingConnections)
                });
            }
        }
        return risks;
    }
    async generateCallGraph(components) {
        const nodes = components.map(comp => ({
            id: comp.id,
            name: comp.name,
            type: this.getCallGraphNodeType(comp.type),
            file: comp.path,
            complexity: comp.metadata.complexity,
            fanIn: comp.dependents.length,
            fanOut: comp.dependencies.length,
            depth: 0,
            critical: comp.metadata.complexity >= 8 || comp.dependents.length > 10 || comp.type === 'service'
        }));
        const edges = components.flatMap(comp => comp.dependencies.map(dep => ({
            from: comp.id,
            to: dep,
            count: 1,
            type: 'direct',
            async: this.hasAsyncOperations(comp),
            conditional: false
        })));
        return {
            nodes,
            edges,
            entryPoints: components.filter(c => c.metadata.isEntry).map(c => c.id),
            cycles: [],
            layers: [],
            hotPaths: [],
            deadCode: components.filter(c => c.dependents.length === 0 && !c.metadata.isEntry && c.type !== 'utility').map(c => c.id)
        };
    }
    async analyzeDatabaseConnections(components) {
        const connections = [];
        const dbPatterns = [
            { type: 'postgresql', patterns: ['postgresql', 'org.postgresql', 'PGSimpleDataSource'] },
            { type: 'mysql', patterns: ['mysql', 'com.mysql', 'MysqlDataSource'] },
            { type: 'oracle', patterns: ['oracle', 'ojdbc', 'OracleDataSource'] },
            { type: 'mongodb', patterns: ['mongodb', 'mongo-java-driver', 'MongoClient'] },
            { type: 'redis', patterns: ['redis', 'jedis', 'lettuce'] },
            { type: 'sqlite', patterns: ['sqlite', 'org.sqlite'] }
        ];
        for (const component of components) {
            for (const pattern of dbPatterns) {
                const hasPattern = pattern.patterns.some(p => component.metadata.imports.some(imp => imp.toLowerCase().includes(p.toLowerCase())) ||
                    (component.metadata.dbQueries && component.metadata.dbQueries.some(query => query.toLowerCase().includes(p.toLowerCase()))));
                if (hasPattern) {
                    connections.push({
                        id: `db_${pattern.type}_${component.id}`,
                        name: `${pattern.type} connection`,
                        type: pattern.type,
                        componentIds: [component.id],
                        usage: [{
                                componentId: component.id,
                                operations: this.extractDbOperations(component),
                                frequency: component.metadata.dbQueries?.length || 1,
                                critical: component.type === 'service' || component.metadata.complexity >= 7
                            }]
                    });
                }
            }
        }
        return connections;
    }
    async analyzeTestCoverage(components) {
        const testFiles = components.filter(c => this.isTestFile(c.path));
        const sourceFiles = components.filter(c => !this.isTestFile(c.path));
        if (testFiles.length === 0) {
            return null;
        }
        this.hasTests = true;
        const totalLines = sourceFiles.reduce((sum, c) => sum + c.metadata.lineCount, 0);
        const estimatedCoveredLines = Math.min(testFiles.length * 40, totalLines * 0.7);
        return {
            overall: totalLines > 0 ? (estimatedCoveredLines / totalLines) * 100 : 0,
            lines: {
                covered: estimatedCoveredLines,
                total: totalLines,
                percentage: totalLines > 0 ? (estimatedCoveredLines / totalLines) * 100 : 0
            },
            branches: { covered: 0, total: 0, percentage: 0 },
            functions: { covered: 0, total: 0, percentage: 0 },
            statements: { covered: 0, total: 0, percentage: 0 },
            byComponent: {},
            byType: {
                unit: testFiles.filter(f => f.path.includes('Test.java') || f.path.includes('test/java')).length,
                integration: testFiles.filter(f => f.path.includes('IT.java') || f.path.includes('integration')).length,
                e2e: testFiles.filter(f => f.path.includes('e2e') || f.path.includes('selenium')).length
            },
            uncoveredFiles: sourceFiles.filter(c => !this.hasCorrespondingTest(c, testFiles)).map(c => c.path)
        };
    }
    async analyzeFile(filePath) {
        try {
            const content = await this.readFile(filePath);
            const relativePath = path.relative(this.projectPath, filePath);
            if (content.length === 0 || content.length > (this.options.maxFileSize || 2 * 1024 * 1024)) {
                return null;
            }
            const component = {
                id: this.generateComponentId(filePath),
                name: this.extractClassName(content, filePath),
                type: this.determineComponentType(filePath, content),
                path: relativePath,
                dependencies: [],
                dependents: [],
                metadata: {
                    lineCount: content.split('\n').length,
                    complexity: this.calculateComplexity(content),
                    lastModified: (await fs.stat(filePath)).mtime,
                    exports: this.extractExports(content),
                    imports: this.extractImports(content),
                    layer: this.determineArchitecturalLayer(filePath, content),
                    responsibilities: this.extractResponsibilities(filePath, content),
                    functions: await this.extractFunctions(content, 'java'),
                    testCoverage: this.isTestFile(filePath) ? 100 : undefined,
                    isEntry: this.isEntryPoint(filePath, content),
                    httpMethods: this.extractHttpMethods(content),
                    dbQueries: this.extractDatabaseQueries(content),
                    externalCalls: this.extractExternalCalls(content)
                }
            };
            return component;
        }
        catch (error) {
            throw new errors_1.AnalyzerError(`Failed to analyze Java file ${filePath}: ${error.message}`, 'FILE_ANALYSIS_ERROR', { filePath, error });
        }
    }
    extractClassName(content, filePath) {
        const classMatch = content.match(/public\s+class\s+(\w+)/);
        if (classMatch) {
            return classMatch[1];
        }
        const interfaceMatch = content.match(/public\s+interface\s+(\w+)/);
        if (interfaceMatch) {
            return interfaceMatch[1];
        }
        const enumMatch = content.match(/public\s+enum\s+(\w+)/);
        if (enumMatch) {
            return enumMatch[1];
        }
        return path.basename(filePath, path.extname(filePath));
    }
    determineComponentType(filePath, content) {
        const fileName = path.basename(filePath).toLowerCase();
        if (this.isTestFile(filePath)) {
            return 'utility';
        }
        if (content.includes('@RestController') || content.includes('@Controller')) {
            return 'controller';
        }
        if (content.includes('@Service') || content.includes('@Component')) {
            return 'service';
        }
        if (content.includes('@Repository') || content.includes('@Entity')) {
            return 'model';
        }
        if (content.includes('@Configuration') || fileName.includes('config')) {
            return 'config';
        }
        if (content.includes('HttpServlet') || content.includes('@WebServlet')) {
            return 'controller';
        }
        if (content.includes('@Path') || content.includes('@GET') || content.includes('@POST')) {
            return 'route';
        }
        if (fileName.includes('controller') || fileName.includes('servlet')) {
            return 'controller';
        }
        if (fileName.includes('service') || fileName.includes('business')) {
            return 'service';
        }
        if (fileName.includes('model') || fileName.includes('entity') || fileName.includes('dto')) {
            return 'model';
        }
        if (fileName.includes('dao') || fileName.includes('repository')) {
            return 'database';
        }
        if (fileName.includes('util') || fileName.includes('helper')) {
            return 'utility';
        }
        return 'utility';
    }
    extractImports(content) {
        const imports = [];
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            const importMatch = trimmed.match(/^import\s+(static\s+)?([^;]+);/);
            if (importMatch) {
                const importPath = importMatch[2];
                if (!importPath.startsWith('java.lang.')) {
                    imports.push(importPath.split('.')[0]);
                }
            }
        }
        return [...new Set(imports)];
    }
    extractExports(content) {
        const exports = [];
        const classMatches = content.match(/public\s+class\s+(\w+)/g);
        if (classMatches) {
            exports.push(...classMatches.map(match => match.split(/\s+/).pop() || ''));
        }
        const interfaceMatches = content.match(/public\s+interface\s+(\w+)/g);
        if (interfaceMatches) {
            exports.push(...interfaceMatches.map(match => match.split(/\s+/).pop() || ''));
        }
        const enumMatches = content.match(/public\s+enum\s+(\w+)/g);
        if (enumMatches) {
            exports.push(...enumMatches.map(match => match.split(/\s+/).pop() || ''));
        }
        const methodMatches = content.match(/public\s+(?:static\s+)?(?:\w+\s+)*(\w+)\s*\(/g);
        if (methodMatches) {
            exports.push(...methodMatches.map(match => {
                const parts = match.replace('(', '').split(/\s+/);
                return parts[parts.length - 1];
            }));
        }
        return [...new Set(exports)];
    }
    extractHttpMethods(content) {
        const methods = [];
        const springMethods = content.match(/@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)/g);
        if (springMethods) {
            methods.push(...springMethods.map(method => method.substring(1).replace('Mapping', '').toUpperCase()));
        }
        const jaxrsMethods = content.match(/@(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)/g);
        if (jaxrsMethods) {
            methods.push(...jaxrsMethods.map(method => method.substring(1)));
        }
        const servletMethods = content.match(/do(Get|Post|Put|Delete|Head|Options)/g);
        if (servletMethods) {
            methods.push(...servletMethods.map(method => method.substring(2).toUpperCase()));
        }
        return [...new Set(methods)];
    }
    extractDatabaseQueries(content) {
        const queries = [];
        const sqlPatterns = [
            /"(SELECT.*?)"/gis,
            /"(INSERT.*?)"/gis,
            /"(UPDATE.*?)"/gis,
            /"(DELETE.*?)"/gis,
            /"(CREATE.*?)"/gis
        ];
        for (const pattern of sqlPatterns) {
            const matches = content.match(pattern);
            if (matches) {
                queries.push(...matches.map(match => match.slice(1, -1)));
            }
        }
        const jpaQueries = content.match(/@Query\s*\(\s*"([^"]+)"/g);
        if (jpaQueries) {
            queries.push(...jpaQueries.map(query => query.match(/"([^"]+)"/)?.[1] || ''));
        }
        const namedQueries = content.match(/@NamedQuery\s*\([^)]*query\s*=\s*"([^"]+)"/g);
        if (namedQueries) {
            queries.push(...namedQueries.map(query => query.match(/query\s*=\s*"([^"]+)"/)?.[1] || ''));
        }
        return queries.filter(q => q.length > 0);
    }
    extractExternalCalls(content) {
        const calls = [];
        const restTemplateCalls = content.match(/restTemplate\.(get|post|put|delete|exchange)\s*\([^)]*"([^"]+)"/g);
        if (restTemplateCalls) {
            calls.push(...restTemplateCalls.map(call => {
                const matches = call.match(/(\w+)\s*\([^)]*"([^"]+)"/);
                return matches ? `${matches[1].toUpperCase()} ${matches[2]}` : call;
            }));
        }
        const webClientCalls = content.match(/WebClient\.create\(\s*"([^"]+)"/g);
        if (webClientCalls) {
            calls.push(...webClientCalls.map(call => `WebClient ${call.match(/"([^"]+)"/)?.[1]}`));
        }
        const okHttpCalls = content.match(/new Request\.Builder\(\)\.url\s*\(\s*"([^"]+)"/g);
        if (okHttpCalls) {
            calls.push(...okHttpCalls.map(call => `HTTP ${call.match(/"([^"]+)"/)?.[1]}`));
        }
        return calls.filter(c => c.length > 0);
    }
    determineArchitecturalLayer(filePath, content) {
        const fileName = path.basename(filePath).toLowerCase();
        const dirName = path.dirname(filePath).toLowerCase();
        if (content.includes('@Controller') || content.includes('@RestController') ||
            content.includes('HttpServlet') || dirName.includes('controller') ||
            dirName.includes('web') || dirName.includes('api')) {
            return 'presentation';
        }
        if (content.includes('@Service') || content.includes('@Component') ||
            dirName.includes('service') || dirName.includes('business') ||
            fileName.includes('service')) {
            return 'business';
        }
        if (content.includes('@Entity') || content.includes('@Repository') ||
            content.includes('CrudRepository') || dirName.includes('repository') ||
            dirName.includes('dao') || dirName.includes('entity') ||
            fileName.includes('model') || fileName.includes('entity')) {
            return 'data';
        }
        if (content.includes('@Configuration') || fileName.includes('config') ||
            fileName.includes('util') || dirName.includes('config') ||
            dirName.includes('util')) {
            return 'infrastructure';
        }
        if (content.includes('RestTemplate') || content.includes('WebClient') ||
            content.includes('HttpClient')) {
            return 'external';
        }
        return 'infrastructure';
    }
    extractResponsibilities(filePath, content) {
        const responsibilities = [];
        if (content.includes('@RestController') || content.includes('@Controller')) {
            responsibilities.push('HTTP request handling');
        }
        if (content.includes('@Service')) {
            responsibilities.push('Business logic');
        }
        if (content.includes('@Repository') || content.includes('CrudRepository')) {
            responsibilities.push('Data access');
        }
        if (content.includes('@Entity') || content.includes('@Table')) {
            responsibilities.push('Data modeling');
        }
        if (content.includes('RestTemplate') || content.includes('WebClient')) {
            responsibilities.push('External service communication');
        }
        if (this.isTestFile(filePath)) {
            responsibilities.push('Testing');
        }
        if (content.includes('@Configuration')) {
            responsibilities.push('Configuration management');
        }
        return responsibilities.length > 0 ? responsibilities : ['General utility'];
    }
    isTestFile(filePath) {
        const fileName = path.basename(filePath).toLowerCase();
        return fileName.endsWith('test.java') ||
            fileName.endsWith('tests.java') ||
            fileName.endsWith('it.java') ||
            filePath.includes('/test/') ||
            filePath.includes('\\test\\') ||
            filePath.includes('src/test');
    }
    isEntryPoint(filePath, content) {
        const fileName = path.basename(filePath);
        return content.includes('@SpringBootApplication') ||
            content.includes('public static void main') ||
            content.includes('ServletContextListener') ||
            fileName.includes('Application.java') ||
            fileName.includes('Main.java');
    }
    async detectJavaVersion() {
        try {
            if (this.buildTool === 'maven') {
                const pomPath = path.join(this.projectPath, 'pom.xml');
                if (await fs.pathExists(pomPath)) {
                    const pomContent = await fs.readFile(pomPath, 'utf-8');
                    const versionMatch = pomContent.match(/<maven\.compiler\.target>(\d+)<\/maven\.compiler\.target>/) ||
                        pomContent.match(/<java\.version>(\d+)<\/java\.version>/);
                    if (versionMatch) {
                        this.javaVersion = versionMatch[1];
                    }
                }
            }
            else if (this.buildTool === 'gradle') {
                const gradleFiles = ['build.gradle', 'build.gradle.kts'];
                for (const file of gradleFiles) {
                    const gradlePath = path.join(this.projectPath, file);
                    if (await fs.pathExists(gradlePath)) {
                        const gradleContent = await fs.readFile(gradlePath, 'utf-8');
                        const versionMatch = gradleContent.match(/targetCompatibility\s*=\s*['"]*(\d+)['"]*/) ||
                            gradleContent.match(/sourceCompatibility\s*=\s*['"]*(\d+)['"]*/) ||
                            gradleContent.match(/JavaVersion\.VERSION_(\d+)/);
                        if (versionMatch) {
                            this.javaVersion = versionMatch[1];
                            break;
                        }
                    }
                }
            }
        }
        catch (error) {
        }
    }
    async analyzeBuildFiles() {
        const frameworks = [];
        if (this.buildTool === 'maven') {
            const pomFrameworks = await this.analyzePomXml();
            frameworks.push(...pomFrameworks);
        }
        else if (this.buildTool === 'gradle') {
            const gradleFrameworks = await this.analyzeGradleBuild();
            frameworks.push(...gradleFrameworks);
        }
        return frameworks;
    }
    async analyzePomXml() {
        const frameworks = [];
        const pomPath = path.join(this.projectPath, 'pom.xml');
        if (await fs.pathExists(pomPath)) {
            const pomContent = await fs.readFile(pomPath, 'utf-8');
            const dependencyPatterns = {
                'spring-boot': /<artifactId>spring-boot-starter/g,
                'spring': /<groupId>org\.springframework<\/groupId>/g,
                'hibernate': /<artifactId>hibernate/g,
                'junit': /<artifactId>junit/g,
                'mockito': /<artifactId>mockito/g,
                'jackson': /<artifactId>jackson/g,
                'lombok': /<artifactId>lombok<\/artifactId>/g
            };
            for (const [name, pattern] of Object.entries(dependencyPatterns)) {
                const matches = pomContent.match(pattern);
                if (matches) {
                    const version = this.extractVersionFromPom(pomContent, name);
                    frameworks.push({
                        name,
                        version,
                        confidence: 0.9,
                        patterns: [`Found in pom.xml (${matches.length} dependencies)`],
                        configFiles: ['pom.xml'],
                        dependencies: [name]
                    });
                }
            }
        }
        return frameworks;
    }
    extractVersionFromPom(pomContent, artifactId) {
        const versionPattern = new RegExp(`<artifactId>${artifactId}[^<]*</artifactId>\\s*<version>([^<]+)</version>`, 'i');
        const match = pomContent.match(versionPattern);
        return match ? match[1] : undefined;
    }
    async analyzeGradleBuild() {
        const frameworks = [];
        const gradleFiles = ['build.gradle', 'build.gradle.kts'];
        for (const file of gradleFiles) {
            const gradlePath = path.join(this.projectPath, file);
            if (await fs.pathExists(gradlePath)) {
                const gradleContent = await fs.readFile(gradlePath, 'utf-8');
                const dependencyPatterns = {
                    'spring-boot': /spring-boot-starter/g,
                    'spring': /org\.springframework/g,
                    'hibernate': /hibernate/g,
                    'junit': /junit/g,
                    'mockito': /mockito/g
                };
                for (const [name, pattern] of Object.entries(dependencyPatterns)) {
                    const matches = gradleContent.match(pattern);
                    if (matches) {
                        frameworks.push({
                            name,
                            confidence: 0.9,
                            patterns: [`Found in ${file} (${matches.length} dependencies)`],
                            configFiles: [file],
                            dependencies: [name]
                        });
                    }
                }
                break;
            }
        }
        return frameworks;
    }
    async analyzeCodeForFrameworks(files) {
        const frameworks = [];
        const frameworkIndicators = new Map();
        for (const filePath of files) {
            try {
                const content = await this.readFile(filePath);
                if (content.includes('@SpringBootApplication') || content.includes('@RestController') ||
                    content.includes('@Service') || content.includes('@Repository')) {
                    this.updateFrameworkIndicator(frameworkIndicators, 'spring', filePath);
                }
                if (content.includes('@Entity') || content.includes('@Table') ||
                    content.includes('SessionFactory') || content.includes('EntityManager')) {
                    this.updateFrameworkIndicator(frameworkIndicators, 'jpa', filePath);
                }
                if (content.includes('@Test') || content.includes('import org.junit')) {
                    this.updateFrameworkIndicator(frameworkIndicators, 'junit', filePath);
                }
            }
            catch (error) {
            }
        }
        for (const [name, info] of frameworkIndicators) {
            frameworks.push({
                name,
                confidence: Math.min(0.8, info.count * 0.1),
                patterns: [`Found in ${info.files.size} files`],
                configFiles: Array.from(info.files),
                dependencies: [name]
            });
        }
        return frameworks;
    }
    updateFrameworkIndicator(indicators, framework, filePath) {
        const existing = indicators.get(framework);
        if (existing) {
            existing.count++;
            existing.files.add(filePath);
        }
        else {
            indicators.set(framework, { count: 1, files: new Set([filePath]) });
        }
    }
    findComponentByImportPath(components, importPath) {
        return components.find(c => {
            const className = this.extractClassName('', c.path);
            return importPath.includes(className) || c.metadata.exports.some(exp => importPath.includes(exp));
        });
    }
    findComponentByMethodCall(components, methodName) {
        return components.find(c => c.metadata.exports.includes(methodName));
    }
    analyzeSpringDependencyInjection(component, components) {
        const connections = [];
        return connections;
    }
    hasTransactionManagement(component) {
        return component.metadata.imports.some(imp => imp.includes('Transactional') || imp.includes('Transaction'));
    }
    hasAsyncOperations(component) {
        return component.metadata.functions?.some(f => f.isAsync || f.name.includes('Async') || f.returnType.includes('Future')) || false;
    }
    getCallGraphNodeType(componentType) {
        switch (componentType) {
            case 'controller':
            case 'service':
            case 'model':
                return 'class';
            case 'route':
                return 'method';
            default:
                return 'module';
        }
    }
    extractDbOperations(component) {
        const operations = [];
        if (component.metadata.dbQueries) {
            for (const query of component.metadata.dbQueries) {
                operations.push({
                    type: this.getQueryType(query),
                    tables: this.extractTables(query),
                    complexity: this.calculateQueryComplexity(query),
                    optimized: false
                });
            }
        }
        return operations;
    }
    getQueryType(query) {
        const upperQuery = query.toUpperCase();
        if (upperQuery.includes('SELECT'))
            return 'read';
        if (upperQuery.includes('INSERT') || upperQuery.includes('UPDATE') || upperQuery.includes('DELETE'))
            return 'write';
        if (upperQuery.includes('BEGIN') || upperQuery.includes('COMMIT'))
            return 'transaction';
        return 'read';
    }
    extractTables(query) {
        const tables = [];
        const upperQuery = query.toUpperCase();
        const fromMatch = upperQuery.match(/FROM\s+(\w+)/);
        if (fromMatch)
            tables.push(fromMatch[1]);
        const joinMatches = upperQuery.match(/JOIN\s+(\w+)/g);
        if (joinMatches) {
            tables.push(...joinMatches.map(match => match.split(' ')[1]));
        }
        return [...new Set(tables)];
    }
    calculateQueryComplexity(query) {
        let complexity = 1;
        const upperQuery = query.toUpperCase();
        if (upperQuery.includes('JOIN'))
            complexity += 2;
        if (upperQuery.includes('SUBQUERY') || query.includes('(SELECT'))
            complexity += 3;
        if (upperQuery.includes('GROUP BY'))
            complexity += 1;
        if (upperQuery.includes('ORDER BY'))
            complexity += 1;
        if (upperQuery.includes('HAVING'))
            complexity += 2;
        return Math.min(complexity, 10);
    }
    calculateRiskImpact(riskLevel, dependentCount) {
        const baseImpact = riskLevel === 'high' ? 'High' : riskLevel === 'medium' ? 'Medium' : 'Low';
        const scopeImpact = dependentCount > 12 ? 'system-wide' : dependentCount > 6 ? 'module-wide' : 'localized';
        return `${baseImpact} impact, ${scopeImpact} scope`;
    }
    hasCorrespondingTest(component, components) {
        const componentName = component.name;
        const testFiles = components.filter(c => this.isTestFile(c.path));
        return testFiles.some(test => test.path.includes(`${componentName}Test`) ||
            test.path.includes(`${componentName}IT`) ||
            test.name.includes(componentName));
    }
    async analyzeAPIEndpoints(components) {
        const endpoints = [];
        for (const component of components) {
            if ((component.type === 'controller' || component.type === 'route') && component.metadata.httpMethods) {
                for (const method of component.metadata.httpMethods) {
                    endpoints.push({
                        id: `${component.id}_${method}`,
                        method: method,
                        path: this.extractEndpointPath(component.path),
                        description: `${method} endpoint in ${component.name}`,
                        parameters: [],
                        requestSchema: null,
                        responseSchema: null,
                        statusCodes: [{ code: 200, description: 'Success', schema: null }],
                        middleware: [],
                        authentication: { type: 'none', required: false },
                        componentId: component.id,
                        handler: component.name,
                        controller: component.name
                    });
                }
            }
        }
        return endpoints;
    }
    extractEndpointPath(filePath) {
        const relativePath = path.relative(this.projectPath, filePath);
        return `/${relativePath.replace(/\\/g, '/').replace(/\.java$/, '')}`;
    }
}
exports.JavaAnalyzer = JavaAnalyzer;
