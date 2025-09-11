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
exports.PythonAnalyzer = void 0;
const base_analyzer_1 = require("../base-analyzer");
const telemetry_schema_1 = require("../../telemetry/telemetry-schema");
const errors_1 = require("../errors");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class PythonAnalyzer extends base_analyzer_1.BaseAnalyzer {
    constructor() {
        super(...arguments);
        this.pythonVersion = '';
    }
    getAnalyzerName() {
        return 'Python Analyzer';
    }
    getSupportedLanguages() {
        return ['python'];
    }
    getSupportedFrameworks() {
        return [
            'django', 'flask', 'fastapi', 'pyramid', 'tornado', 'bottle',
            'celery', 'airflow', 'scrapy', 'django-rest-framework',
            'pytest', 'unittest', 'nose2', 'doctest',
            'pandas', 'numpy', 'scipy', 'matplotlib', 'sklearn',
            'tensorflow', 'pytorch', 'keras', 'transformers',
            'requests', 'aiohttp', 'httpx', 'urllib3',
            'sqlalchemy', 'django-orm', 'peewee', 'tortoise-orm',
            'pydantic', 'marshmallow', 'cerberus'
        ];
    }
    async detectLanguageAndFramework() {
        const span = telemetry_schema_1.telemetry.createSpan('python-analyzer.detectLanguageAndFramework');
        let confidence = 0;
        const frameworks = [];
        const files = [];
        try {
            const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
            files.push(...pythonFiles);
            if (pythonFiles.length > 0) {
                confidence += 0.4;
            }
            const pythonSpecificFiles = [
                'requirements.txt', 'setup.py', 'setup.cfg', 'pyproject.toml',
                'Pipfile', 'poetry.lock', 'environment.yml', 'manage.py',
                '__init__.py', 'wsgi.py', 'asgi.py'
            ];
            for (const file of pythonSpecificFiles) {
                const filePath = path.join(this.projectPath, file);
                if (await fs.pathExists(filePath)) {
                    confidence += 0.1;
                    files.push(filePath);
                    if (file === 'manage.py') {
                        frameworks.push({
                            name: 'django',
                            version: await this.detectDjangoVersion(),
                            confidence: 0.9,
                            patterns: ['manage.py found'],
                            configFiles: ['settings.py', 'urls.py', 'wsgi.py'],
                            dependencies: ['django']
                        });
                    }
                }
            }
            const detectedFrameworks = await this.analyzeRequirementsFiles();
            frameworks.push(...detectedFrameworks);
            if (pythonFiles.length > 0) {
                const codeFrameworks = await this.analyzeCodeForFrameworks(pythonFiles.slice(0, 20));
                frameworks.push(...codeFrameworks);
            }
            await this.detectPythonEnvironment();
            confidence = Math.min(confidence, 1.0);
            telemetry_schema_1.telemetry.emit({
                type: 'analysis_started',
                source: { analyzer: this.getAnalyzerName() },
                data: {
                    language: 'python',
                    confidence,
                    filesCount: files.length,
                    frameworksFound: frameworks.length,
                    pythonVersion: this.pythonVersion
                }
            });
            span.end();
            return {
                language: 'python',
                confidence,
                frameworks: frameworks.sort((a, b) => b.confidence - a.confidence),
                files
            };
        }
        catch (error) {
            span.end();
            throw new errors_1.AnalyzerError(`Python language detection failed: ${error.message}`, 'DETECTION_ERROR', { error });
        }
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('python-analyzer.discoverComponents');
        const components = [];
        let totalFiles = 0;
        let analyzedFiles = 0;
        let skippedFiles = 0;
        try {
            const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
            totalFiles = pythonFiles.length;
            console.log(`🐍 Analyzing ${totalFiles} Python files...`);
            for (const filePath of pythonFiles) {
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
                    console.warn(`⚠️ Failed to analyze ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
                    skippedFiles++;
                }
                if ((analyzedFiles + skippedFiles) % 100 === 0) {
                    const progress = ((analyzedFiles + skippedFiles) / totalFiles) * 100;
                    console.log(`📊 Progress: ${progress.toFixed(1)}% (${analyzedFiles + skippedFiles}/${totalFiles})`);
                }
            }
            console.log(`✅ Python analysis complete: ${analyzedFiles} analyzed, ${skippedFiles} skipped`);
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
            throw new errors_1.AnalyzerError(`Python component discovery failed: ${error.message}`, 'DISCOVERY_ERROR', { error });
        }
    }
    async analyzeConnections(components) {
        const span = telemetry_schema_1.telemetry.createSpan('python-analyzer.analyzeConnections');
        const connections = [];
        try {
            console.log(`🔗 Analyzing Python connections between ${components.length} components...`);
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
                    for (const func of component.metadata.functions) {
                        for (const call of func.calls) {
                            const targetComponent = this.findComponentByFunctionCall(components, call.target);
                            if (targetComponent && targetComponent.id !== component.id) {
                                connections.push({
                                    from: component.id,
                                    to: targetComponent.id,
                                    type: 'function_call',
                                    weight: call.count,
                                    metadata: {
                                        callSites: call.count,
                                        dataFlow: `${func.name} -> ${call.target}`
                                    }
                                });
                            }
                        }
                    }
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
            throw new errors_1.AnalyzerError(`Python connection analysis failed: ${error.message}`, 'CONNECTION_ERROR', { error });
        }
    }
    async assessRisks(components, connections) {
        const risks = [];
        for (const component of components) {
            const reasons = [];
            let riskLevel = 'low';
            if (component.metadata.complexity >= 8) {
                reasons.push(`High complexity (${component.metadata.complexity})`);
                riskLevel = 'high';
            }
            else if (component.metadata.complexity >= 5) {
                reasons.push(`Medium complexity (${component.metadata.complexity})`);
                riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
            }
            if (component.metadata.lineCount > 1000) {
                reasons.push(`Large file (${component.metadata.lineCount} lines)`);
                riskLevel = 'high';
            }
            else if (component.metadata.lineCount > 500) {
                reasons.push(`Large file (${component.metadata.lineCount} lines)`);
                riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
            }
            const incomingConnections = connections.filter(c => c.to === component.id).length;
            if (incomingConnections > 10) {
                reasons.push(`High fan-in (${incomingConnections} dependents)`);
                riskLevel = 'high';
            }
            if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
                reasons.push('Database operations detected');
                riskLevel = riskLevel === 'low' ? 'medium' : riskLevel;
            }
            if (component.metadata.externalCalls && component.metadata.externalCalls.length > 0) {
                reasons.push('External API calls detected');
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
            critical: comp.metadata.complexity >= 7 || comp.dependents.length > 8
        }));
        const edges = components.flatMap(comp => comp.dependencies.map(dep => ({
            from: comp.id,
            to: dep,
            count: 1,
            type: 'direct',
            async: false,
            conditional: false
        })));
        return {
            nodes,
            edges,
            entryPoints: components.filter(c => c.metadata.isEntry).map(c => c.id),
            cycles: [],
            layers: [],
            hotPaths: [],
            deadCode: components.filter(c => c.dependents.length === 0 && !c.metadata.isEntry).map(c => c.id)
        };
    }
    async analyzeDatabaseConnections(components) {
        const connections = [];
        const connectionPatterns = [
            { type: 'postgresql', patterns: ['psycopg2', 'asyncpg', 'postgresql://'] },
            { type: 'mysql', patterns: ['pymysql', 'mysql.connector', 'mysql://'] },
            { type: 'mongodb', patterns: ['pymongo', 'motor', 'mongodb://'] },
            { type: 'redis', patterns: ['redis-py', 'aioredis', 'redis://'] },
            { type: 'sqlite', patterns: ['sqlite3', 'aiosqlite', 'sqlite://'] }
        ];
        for (const component of components) {
            if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
                for (const pattern of connectionPatterns) {
                    const hasPattern = pattern.patterns.some(p => component.metadata.imports.some(imp => imp.includes(p)) ||
                        component.metadata.dbQueries.some(query => query.includes(p)));
                    if (hasPattern) {
                        connections.push({
                            id: `db_${pattern.type}_${component.id}`,
                            name: `${pattern.type} connection`,
                            type: pattern.type,
                            componentIds: [component.id],
                            usage: [{
                                    componentId: component.id,
                                    operations: component.metadata.dbQueries.map(query => ({
                                        type: this.getQueryType(query),
                                        tables: this.extractTables(query),
                                        complexity: this.calculateQueryComplexity(query),
                                        optimized: false
                                    })),
                                    frequency: component.metadata.dbQueries.length,
                                    critical: component.metadata.complexity >= 6
                                }]
                        });
                    }
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
        const totalLines = sourceFiles.reduce((sum, c) => sum + c.metadata.lineCount, 0);
        const estimatedCoveredLines = Math.min(testFiles.length * 50, totalLines * 0.8);
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
                unit: testFiles.filter(f => f.path.includes('test_')).length,
                integration: testFiles.filter(f => f.path.includes('integration')).length,
                e2e: testFiles.filter(f => f.path.includes('e2e')).length
            },
            uncoveredFiles: sourceFiles.filter(c => !this.hasCorrespondingTest(c, testFiles)).map(c => c.path)
        };
    }
    async analyzeFile(filePath) {
        try {
            const content = await this.readFile(filePath);
            const relativePath = path.relative(this.projectPath, filePath);
            if (content.length === 0 || content.length > (this.options.maxFileSize || 1024 * 1024)) {
                return null;
            }
            const component = {
                id: this.generateComponentId(filePath),
                name: path.basename(filePath, path.extname(filePath)),
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
                    functions: await this.extractFunctions(content, 'python'),
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
            throw new errors_1.AnalyzerError(`Failed to analyze Python file ${filePath}: ${error.message}`, 'FILE_ANALYSIS_ERROR', { filePath, error });
        }
    }
    determineComponentType(filePath, content) {
        const fileName = path.basename(filePath).toLowerCase();
        if (this.isTestFile(filePath)) {
            return 'utility';
        }
        if (fileName === 'models.py' || content.includes('class Meta:') || content.includes('models.Model')) {
            return 'model';
        }
        if (fileName === 'views.py' || content.includes('def view') || content.includes('class.*View')) {
            return 'controller';
        }
        if (fileName === 'urls.py' || content.includes('urlpatterns') || content.includes('path(')) {
            return 'route';
        }
        if (fileName === 'settings.py' || fileName === 'config.py') {
            return 'config';
        }
        if (fileName === 'middleware.py' || content.includes('MiddlewareMixin')) {
            return 'middleware';
        }
        if (content.includes('@app.route') || content.includes('@bp.route')) {
            return 'route';
        }
        if (content.includes('@app.get') || content.includes('@app.post') || content.includes('APIRouter')) {
            return 'route';
        }
        if (content.includes('class.*Service') || fileName.includes('service')) {
            return 'service';
        }
        if (fileName.includes('util') || fileName.includes('helper') || fileName.includes('tool')) {
            return 'utility';
        }
        if (content.includes('CREATE TABLE') || content.includes('SELECT') || content.includes('engine') && content.includes('database')) {
            return 'database';
        }
        return 'utility';
    }
    extractImports(content) {
        const imports = [];
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            const importMatch = trimmed.match(/^(?:from\s+(\S+)\s+import|import\s+(\S+))/);
            if (importMatch) {
                const module = importMatch[1] || importMatch[2];
                if (module && !module.startsWith('.')) {
                    imports.push(module.split('.')[0]);
                }
            }
        }
        return [...new Set(imports)];
    }
    extractExports(content) {
        const exports = [];
        const classMatches = content.match(/^class\s+(\w+)/gm);
        if (classMatches) {
            exports.push(...classMatches.map(match => match.split(/\s+/)[1]));
        }
        const functionMatches = content.match(/^def\s+(\w+)/gm);
        if (functionMatches) {
            exports.push(...functionMatches.map(match => match.split(/\s+/)[1]));
        }
        const allMatch = content.match(/__all__\s*=\s*\[(.*?)\]/s);
        if (allMatch) {
            const items = allMatch[1].match(/"([^"]+)"|'([^']+)'/g);
            if (items) {
                exports.push(...items.map(item => item.slice(1, -1)));
            }
        }
        return [...new Set(exports)];
    }
    extractHttpMethods(content) {
        const methods = [];
        const djangoMatches = content.match(/@.*route.*\(['"].*['"],?\s*methods=\[([^\]]+)\]/g);
        if (djangoMatches) {
            for (const match of djangoMatches) {
                const methodsMatch = match.match(/methods=\[([^\]]+)\]/);
                if (methodsMatch) {
                    const methodList = methodsMatch[1].split(',').map(m => m.trim().replace(/['"]/g, ''));
                    methods.push(...methodList);
                }
            }
        }
        const decoratorMethods = content.match(/@\w*\.(get|post|put|delete|patch|head|options)/g);
        if (decoratorMethods) {
            methods.push(...decoratorMethods.map(match => match.split('.')[1].toUpperCase()));
        }
        return [...new Set(methods)];
    }
    extractDatabaseQueries(content) {
        const queries = [];
        const sqlPatterns = [
            /['"`](SELECT.*?)['"`]/gis,
            /['"`](INSERT.*?)['"`]/gis,
            /['"`](UPDATE.*?)['"`]/gis,
            /['"`](DELETE.*?)['"`]/gis,
            /['"`](CREATE.*?)['"`]/gis,
            /['"`](DROP.*?)['"`]/gis
        ];
        for (const pattern of sqlPatterns) {
            const matches = content.match(pattern);
            if (matches) {
                queries.push(...matches.map(match => match.slice(1, -1)));
            }
        }
        const ormMatterns = content.match(/\w+\.objects\.\w+\([^)]*\)/g);
        if (ormMatterns) {
            queries.push(...ormMatterns);
        }
        return queries;
    }
    extractExternalCalls(content) {
        const calls = [];
        const httpPatterns = [
            /requests\.(get|post|put|delete|patch)\s*\(['"]([^'"]+)['"]/g,
            /httpx\.(get|post|put|delete|patch)\s*\(['"]([^'"]+)['"]/g,
            /urllib\.request\.urlopen\s*\(['"]([^'"]+)['"]/g
        ];
        for (const pattern of httpPatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                calls.push(`${match[1].toUpperCase()} ${match[2]}`);
            }
        }
        return calls;
    }
    determineArchitecturalLayer(filePath, content) {
        const fileName = path.basename(filePath).toLowerCase();
        const dirName = path.dirname(filePath).toLowerCase();
        if (fileName.includes('view') || fileName.includes('controller') || content.includes('@app.route')) {
            return 'presentation';
        }
        if (fileName.includes('model') || fileName.includes('entity') || content.includes('models.Model')) {
            return 'data';
        }
        if (fileName.includes('service') || fileName.includes('business') || dirName.includes('business')) {
            return 'business';
        }
        if (fileName.includes('util') || fileName.includes('helper') || fileName.includes('config')) {
            return 'infrastructure';
        }
        if (content.includes('requests.') || content.includes('httpx.')) {
            return 'external';
        }
        return 'infrastructure';
    }
    extractResponsibilities(filePath, content) {
        const responsibilities = [];
        if (content.includes('@app.route') || content.includes('@bp.route')) {
            responsibilities.push('HTTP request handling');
        }
        if (content.includes('models.Model') || content.includes('CREATE TABLE')) {
            responsibilities.push('Data modeling');
        }
        if (content.includes('requests.') || content.includes('httpx.')) {
            responsibilities.push('External API communication');
        }
        if (this.isTestFile(filePath)) {
            responsibilities.push('Testing');
        }
        if (content.includes('class.*Service')) {
            responsibilities.push('Business logic');
        }
        return responsibilities.length > 0 ? responsibilities : ['General utility'];
    }
    isTestFile(filePath) {
        const fileName = path.basename(filePath).toLowerCase();
        return fileName.startsWith('test_') ||
            fileName.endsWith('_test.py') ||
            filePath.includes('/tests/') ||
            filePath.includes('/test/');
    }
    isEntryPoint(filePath, content) {
        const fileName = path.basename(filePath);
        return fileName === 'main.py' ||
            fileName === 'app.py' ||
            fileName === 'manage.py' ||
            fileName === 'wsgi.py' ||
            fileName === 'asgi.py' ||
            content.includes('if __name__ == "__main__"') ||
            content.includes('app = FastAPI()') ||
            content.includes('app = Flask(__name__)');
    }
    async detectPythonEnvironment() {
        try {
            const hasVirtualEnv = await fs.pathExists(path.join(this.projectPath, 'venv')) ||
                await fs.pathExists(path.join(this.projectPath, 'env')) ||
                await fs.pathExists(path.join(this.projectPath, '.venv'));
            if (hasVirtualEnv) {
                this.pythonVersion = 'virtual-env-detected';
            }
        }
        catch (error) {
        }
    }
    async analyzeRequirementsFiles() {
        const frameworks = [];
        const requirementsFiles = ['requirements.txt', 'requirements-dev.txt', 'Pipfile', 'pyproject.toml', 'setup.py'];
        for (const file of requirementsFiles) {
            const filePath = path.join(this.projectPath, file);
            if (await fs.pathExists(filePath)) {
                const content = await fs.readFile(filePath, 'utf-8');
                const detected = this.detectFrameworksFromDependencies(content, file);
                frameworks.push(...detected);
            }
        }
        return frameworks;
    }
    detectFrameworksFromDependencies(content, fileName) {
        const frameworks = [];
        const lines = content.toLowerCase().split('\n');
        const frameworkPatterns = {
            django: { patterns: ['django==', 'django>=', 'django~='], confidence: 0.9 },
            flask: { patterns: ['flask==', 'flask>=', 'flask~='], confidence: 0.9 },
            fastapi: { patterns: ['fastapi==', 'fastapi>=', 'fastapi~='], confidence: 0.9 },
            pyramid: { patterns: ['pyramid==', 'pyramid>=', 'pyramid~='], confidence: 0.9 },
            tornado: { patterns: ['tornado==', 'tornado>=', 'tornado~='], confidence: 0.8 },
            celery: { patterns: ['celery==', 'celery>=', 'celery~='], confidence: 0.8 },
            pytest: { patterns: ['pytest==', 'pytest>=', 'pytest~='], confidence: 0.7 },
            pandas: { patterns: ['pandas==', 'pandas>=', 'pandas~='], confidence: 0.8 },
            numpy: { patterns: ['numpy==', 'numpy>=', 'numpy~='], confidence: 0.8 },
            tensorflow: { patterns: ['tensorflow==', 'tensorflow>=', 'tensorflow~='], confidence: 0.9 },
            pytorch: { patterns: ['torch==', 'torch>=', 'torch~='], confidence: 0.9 }
        };
        for (const [name, config] of Object.entries(frameworkPatterns)) {
            for (const pattern of config.patterns) {
                const matchingLines = lines.filter(line => line.includes(pattern));
                if (matchingLines.length > 0) {
                    const version = this.extractVersionFromDependency(matchingLines[0]);
                    frameworks.push({
                        name,
                        version,
                        confidence: config.confidence,
                        patterns: [`Found in ${fileName}`],
                        configFiles: [fileName],
                        dependencies: [name]
                    });
                    break;
                }
            }
        }
        return frameworks;
    }
    extractVersionFromDependency(line) {
        const versionMatch = line.match(/[>=~]+([0-9.]+)/);
        return versionMatch ? versionMatch[1] : undefined;
    }
    async analyzeCodeForFrameworks(files) {
        const frameworks = [];
        const frameworkIndicators = new Map();
        for (const filePath of files) {
            try {
                const content = await this.readFile(filePath);
                if (content.includes('from django') || content.includes('import django')) {
                    this.updateFrameworkIndicator(frameworkIndicators, 'django', filePath);
                }
                if (content.includes('from flask') || content.includes('@app.route')) {
                    this.updateFrameworkIndicator(frameworkIndicators, 'flask', filePath);
                }
                if (content.includes('from fastapi') || content.includes('APIRouter')) {
                    this.updateFrameworkIndicator(frameworkIndicators, 'fastapi', filePath);
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
    async detectDjangoVersion() {
        try {
            const requirementsPath = path.join(this.projectPath, 'requirements.txt');
            if (await fs.pathExists(requirementsPath)) {
                const content = await fs.readFile(requirementsPath, 'utf-8');
                const versionMatch = content.match(/django[>=~]+([0-9.]+)/i);
                if (versionMatch) {
                    return versionMatch[1];
                }
            }
        }
        catch (error) {
        }
        return undefined;
    }
    findComponentByImportPath(components, importPath) {
        return components.find(c => {
            const moduleName = path.basename(c.path, path.extname(c.path));
            return importPath.includes(moduleName) || c.metadata.exports.some(exp => importPath.includes(exp));
        });
    }
    findComponentByFunctionCall(components, functionName) {
        return components.find(c => c.metadata.exports.includes(functionName));
    }
    getCallGraphNodeType(componentType) {
        switch (componentType) {
            case 'route':
            case 'controller':
                return 'method';
            case 'model':
                return 'class';
            case 'service':
                return 'class';
            default:
                return 'module';
        }
    }
    calculateRiskImpact(riskLevel, dependentCount) {
        const baseImpact = riskLevel === 'high' ? 'High' : riskLevel === 'medium' ? 'Medium' : 'Low';
        const scopeImpact = dependentCount > 10 ? 'system-wide' : dependentCount > 5 ? 'module-wide' : 'localized';
        return `${baseImpact} impact, ${scopeImpact} scope`;
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
        if (upperQuery.includes('SUBQUERY') || upperQuery.includes('(SELECT'))
            complexity += 3;
        if (upperQuery.includes('GROUP BY'))
            complexity += 1;
        if (upperQuery.includes('ORDER BY'))
            complexity += 1;
        if (upperQuery.includes('HAVING'))
            complexity += 2;
        return Math.min(complexity, 10);
    }
    hasCorrespondingTest(component, testFiles) {
        const componentName = path.basename(component.path, path.extname(component.path));
        return testFiles.some(test => test.path.includes(`test_${componentName}`) ||
            test.path.includes(`${componentName}_test`));
    }
    async analyzeAPIEndpoints(components) {
        const endpoints = [];
        for (const component of components) {
            if (component.type === 'route' || component.metadata.httpMethods) {
                const methods = component.metadata.httpMethods || ['GET'];
                for (const method of methods) {
                    endpoints.push({
                        id: `${component.id}_${method}`,
                        method: method,
                        path: this.extractRoutePath(component.path),
                        description: `${method} endpoint in ${component.name}`,
                        parameters: [],
                        requestSchema: null,
                        responseSchema: null,
                        statusCodes: [{ code: 200, description: 'Success', schema: null }],
                        middleware: [],
                        authentication: { type: 'none', required: false },
                        componentId: component.id,
                        handler: component.name
                    });
                }
            }
        }
        return endpoints;
    }
    extractRoutePath(filePath) {
        const relativePath = path.relative(this.projectPath, filePath);
        return `/${relativePath.replace(/\\/g, '/').replace('.py', '')}`;
    }
}
exports.PythonAnalyzer = PythonAnalyzer;
