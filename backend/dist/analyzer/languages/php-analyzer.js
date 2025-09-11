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
exports.PHPAnalyzer = void 0;
const base_analyzer_1 = require("../base-analyzer");
const telemetry_schema_1 = require("../../telemetry/telemetry-schema");
const errors_1 = require("../errors");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class PHPAnalyzer extends base_analyzer_1.BaseAnalyzer {
    constructor() {
        super(...arguments);
        this.phpVersion = '';
        this.hasComposer = false;
    }
    getAnalyzerName() {
        return 'PHP Analyzer';
    }
    getSupportedLanguages() {
        return ['php'];
    }
    getSupportedFrameworks() {
        return ['laravel', 'symfony', 'codeigniter', 'slim', 'phalcon', 'yii', 'zend', 'cakephp', 'wordpress', 'drupal', 'magento', 'phpunit', 'composer'];
    }
    async detectLanguageAndFramework() {
        const span = telemetry_schema_1.telemetry.createSpan('php-analyzer.detectLanguageAndFramework');
        let confidence = 0;
        const frameworks = [];
        const files = [];
        try {
            const phpFiles = await this.findFiles(['**/*.php'], this.options.excludePatterns);
            files.push(...phpFiles);
            if (phpFiles.length > 0)
                confidence += 0.5;
            const phpSpecificFiles = ['composer.json', 'composer.lock', 'index.php', 'app.php', 'wp-config.php', 'artisan'];
            for (const file of phpSpecificFiles) {
                const filePath = path.join(this.projectPath, file);
                if (await fs.pathExists(filePath)) {
                    confidence += 0.1;
                    files.push(filePath);
                    if (file === 'composer.json')
                        this.hasComposer = true;
                }
            }
            if (this.hasComposer) {
                const composerFrameworks = await this.analyzeComposerJson();
                frameworks.push(...composerFrameworks);
            }
            if (phpFiles.length > 0) {
                const codeFrameworks = await this.analyzeCodeForFrameworks(phpFiles.slice(0, 20));
                frameworks.push(...codeFrameworks);
            }
            confidence = Math.min(confidence, 1.0);
            telemetry_schema_1.telemetry.emit({
                type: 'analysis_started',
                source: { analyzer: this.getAnalyzerName() },
                data: { language: 'php', confidence, filesCount: files.length, frameworksFound: frameworks.length, hasComposer: this.hasComposer }
            });
            span.end();
            return { language: 'php', confidence, frameworks: frameworks.sort((a, b) => b.confidence - a.confidence), files };
        }
        catch (error) {
            span.end();
            throw new errors_1.AnalyzerError(`PHP language detection failed: ${error.message}`, 'DETECTION_ERROR', { error });
        }
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('php-analyzer.discoverComponents');
        const components = [];
        let totalFiles = 0, analyzedFiles = 0, skippedFiles = 0;
        try {
            const sourceFiles = await this.findFiles(['**/*.php'], [...(this.options.excludePatterns || []), 'vendor/**', 'storage/**']);
            totalFiles = sourceFiles.length;
            console.log(`🐘 Analyzing ${totalFiles} PHP files...`);
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
            console.log(`✅ PHP analysis complete: ${analyzedFiles} analyzed, ${skippedFiles} skipped`);
            span.end();
            return { totalFiles, analyzedFiles, skippedFiles, components };
        }
        catch (error) {
            span.end();
            throw new errors_1.AnalyzerError(`PHP component discovery failed: ${error.message}`, 'DISCOVERY_ERROR', { error });
        }
    }
    async analyzeConnections(components) {
        const span = telemetry_schema_1.telemetry.createSpan('php-analyzer.analyzeConnections');
        const connections = [];
        try {
            console.log(`🔗 Analyzing PHP connections between ${components.length} components...`);
            for (const component of components) {
                for (const usePath of component.metadata.imports) {
                    const targetComponent = this.findComponentByUsePath(components, usePath);
                    if (targetComponent && targetComponent.id !== component.id) {
                        connections.push({
                            from: component.id,
                            to: targetComponent.id,
                            type: 'import',
                            weight: 1,
                            metadata: { callSites: 1, dataFlow: 'use/require' }
                        });
                    }
                }
            }
            const connectionMap = new Map();
            for (const conn of connections) {
                const key = `${conn.from}-${conn.to}-${conn.type}`;
                const existing = connectionMap.get(key);
                if (existing)
                    existing.weight = (existing.weight || 0) + (conn.weight || 0);
                else
                    connectionMap.set(key, conn);
            }
            const uniqueConnections = Array.from(connectionMap.values());
            console.log(`🔗 Found ${uniqueConnections.length} unique connections`);
            span.end();
            return uniqueConnections;
        }
        catch (error) {
            span.end();
            throw new errors_1.AnalyzerError(`PHP connection analysis failed: ${error.message}`, 'CONNECTION_ERROR', { error });
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
            if (component.metadata.lineCount > 1200) {
                reasons.push(`Large file (${component.metadata.lineCount} lines)`);
                riskLevel = 'high';
            }
            const incomingConnections = connections.filter(c => c.to === component.id).length;
            if (incomingConnections > 8) {
                reasons.push(`High coupling (${incomingConnections} dependents)`);
                riskLevel = 'high';
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
            id: comp.id, name: comp.name, type: 'module', file: comp.path,
            complexity: comp.metadata.complexity, fanIn: comp.dependents.length,
            fanOut: comp.dependencies.length, depth: 0,
            critical: comp.metadata.complexity >= 8 || comp.dependents.length > 6
        }));
        const edges = components.flatMap(comp => comp.dependencies.map(dep => ({ from: comp.id, to: dep, count: 1, type: 'direct', async: false, conditional: false })));
        return { nodes, edges, entryPoints: components.filter(c => c.metadata.isEntry).map(c => c.id), cycles: [], layers: [], hotPaths: [], deadCode: [] };
    }
    async analyzeDatabaseConnections(components) {
        const connections = [];
        const dbPatterns = [
            { type: 'mysql', patterns: ['mysql', 'mysqli', 'pdo_mysql'] },
            { type: 'postgresql', patterns: ['pgsql', 'pdo_pgsql'] },
            { type: 'sqlite', patterns: ['sqlite', 'pdo_sqlite'] },
            { type: 'mongodb', patterns: ['mongodb', 'mongo'] }
        ];
        for (const component of components) {
            for (const pattern of dbPatterns) {
                const hasPattern = pattern.patterns.some(p => component.metadata.imports.some(imp => imp.includes(p)));
                if (hasPattern) {
                    connections.push({
                        id: `db_${pattern.type}_${component.id}`, name: `${pattern.type} connection`,
                        type: pattern.type, componentIds: [component.id],
                        usage: [{ componentId: component.id, operations: [], frequency: 1, critical: false }]
                    });
                }
            }
        }
        return connections;
    }
    async analyzeTestCoverage(components) {
        const testFiles = components.filter(c => this.isTestFile(c.path));
        const sourceFiles = components.filter(c => !this.isTestFile(c.path));
        if (testFiles.length === 0)
            return null;
        const totalLines = sourceFiles.reduce((sum, c) => sum + c.metadata.lineCount, 0);
        const estimatedCoveredLines = Math.min(testFiles.length * 35, totalLines * 0.65);
        return {
            overall: totalLines > 0 ? (estimatedCoveredLines / totalLines) * 100 : 0,
            lines: { covered: estimatedCoveredLines, total: totalLines, percentage: totalLines > 0 ? (estimatedCoveredLines / totalLines) * 100 : 0 },
            branches: { covered: 0, total: 0, percentage: 0 }, functions: { covered: 0, total: 0, percentage: 0 },
            statements: { covered: 0, total: 0, percentage: 0 }, byComponent: {}, byType: { unit: testFiles.length, integration: 0, e2e: 0 },
            uncoveredFiles: sourceFiles.filter(c => !this.hasCorrespondingTest(c, testFiles)).map(c => c.path)
        };
    }
    async analyzeFile(filePath) {
        try {
            const content = await this.readFile(filePath);
            const relativePath = path.relative(this.projectPath, filePath);
            if (content.length === 0)
                return null;
            return {
                id: this.generateComponentId(filePath), name: this.extractClassName(content, filePath),
                type: this.determineComponentType(filePath, content), path: relativePath,
                dependencies: [], dependents: [],
                metadata: {
                    lineCount: content.split('\n').length, complexity: this.calculateComplexity(content),
                    lastModified: (await fs.stat(filePath)).mtime, exports: this.extractExports(content),
                    imports: this.extractImports(content), layer: this.determineArchitecturalLayer(filePath, content),
                    responsibilities: this.extractResponsibilities(filePath, content), functions: await this.extractFunctions(content, 'php'),
                    testCoverage: this.isTestFile(filePath) ? 100 : undefined, isEntry: this.isEntryPoint(filePath, content),
                    httpMethods: this.extractHttpMethods(content), dbQueries: this.extractDatabaseQueries(content),
                    externalCalls: this.extractExternalCalls(content)
                }
            };
        }
        catch (error) {
            throw new errors_1.AnalyzerError(`Failed to analyze PHP file ${filePath}: ${error.message}`, 'FILE_ANALYSIS_ERROR', { filePath, error });
        }
    }
    extractClassName(content, filePath) {
        const classMatch = content.match(/class\s+(\w+)/);
        if (classMatch)
            return classMatch[1];
        const interfaceMatch = content.match(/interface\s+(\w+)/);
        if (interfaceMatch)
            return interfaceMatch[1];
        return path.basename(filePath, path.extname(filePath));
    }
    determineComponentType(filePath, content) {
        const fileName = path.basename(filePath).toLowerCase();
        if (this.isTestFile(filePath))
            return 'utility';
        if (fileName.includes('controller') || content.includes('Controller extends'))
            return 'controller';
        if (fileName.includes('model') || content.includes('Model extends') || content.includes('Eloquent'))
            return 'model';
        if (fileName.includes('service'))
            return 'service';
        if (fileName.includes('repository'))
            return 'database';
        if (fileName.includes('middleware') || content.includes('Middleware'))
            return 'middleware';
        if (fileName === 'index.php' || content.includes('$_GET') || content.includes('$_POST'))
            return 'route';
        if (fileName.includes('config') || fileName.includes('bootstrap'))
            return 'config';
        return 'utility';
    }
    extractImports(content) {
        const imports = [];
        const useStatements = content.match(/use\s+([^;]+);/g) || [];
        const requireStatements = content.match(/(?:require|include)(?:_once)?\s*\(?['"]([^'"]+)['"]\)?;/g) || [];
        for (const statement of useStatements) {
            const usePath = statement.replace(/use\s+/, '').replace(';', '').trim();
            const parts = usePath.split('\\');
            if (parts.length > 0)
                imports.push(parts[parts.length - 1]);
        }
        for (const statement of requireStatements) {
            const match = statement.match(/['"]([^'"]+)['"]/);
            if (match)
                imports.push(path.basename(match[1], '.php'));
        }
        return [...new Set(imports)];
    }
    extractExports(content) {
        const exports = [];
        const publicClasses = content.match(/(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/g);
        if (publicClasses)
            exports.push(...publicClasses.map(c => c.split(/\s+/).pop() || ''));
        const interfaces = content.match(/interface\s+(\w+)/g);
        if (interfaces)
            exports.push(...interfaces.map(i => i.split(/\s+/).pop() || ''));
        const publicMethods = content.match(/public\s+function\s+(\w+)/g);
        if (publicMethods)
            exports.push(...publicMethods.map(m => m.split(/\s+/).pop() || ''));
        return [...new Set(exports)];
    }
    extractHttpMethods(content) {
        const methods = [];
        if (content.includes('$_GET'))
            methods.push('GET');
        if (content.includes('$_POST'))
            methods.push('POST');
        if (content.includes('$_PUT'))
            methods.push('PUT');
        if (content.includes('$_DELETE'))
            methods.push('DELETE');
        const laravelRoutes = content.match(/Route::(get|post|put|delete|patch)\(/g);
        if (laravelRoutes)
            methods.push(...laravelRoutes.map(r => r.match(/::(get|post|put|delete|patch)\(/)?.[1]?.toUpperCase() || ''));
        return [...new Set(methods)];
    }
    extractDatabaseQueries(content) {
        const queries = [];
        const sqlQueries = content.match(/["'](SELECT.*?)["']/gis) || content.match(/["'](INSERT.*?)["']/gis);
        if (sqlQueries)
            queries.push(...sqlQueries.map(q => q.slice(1, -1)));
        const eloquentCalls = content.match(/\$\w+->(?:find|where|get|all|first|create|update|delete)\(/g);
        if (eloquentCalls)
            queries.push(...eloquentCalls);
        return queries;
    }
    extractExternalCalls(content) {
        const calls = [];
        const curlCalls = content.match(/curl_setopt\s*\([^,]+,\s*CURLOPT_URL,\s*["']([^"']+)["']\)/g);
        if (curlCalls)
            calls.push(...curlCalls.map(call => call.match(/["']([^"']+)["']/)?.[1] || ''));
        const fileGetContents = content.match(/file_get_contents\s*\(\s*["']([^"']+)["']\)/g);
        if (fileGetContents)
            calls.push(...fileGetContents.map(call => call.match(/["']([^"']+)["']/)?.[1] || ''));
        return calls;
    }
    determineArchitecturalLayer(filePath, content) {
        const fileName = path.basename(filePath).toLowerCase();
        if (fileName.includes('controller') || content.includes('Controller extends'))
            return 'presentation';
        if (fileName.includes('service') || fileName.includes('business'))
            return 'business';
        if (fileName.includes('model') || fileName.includes('repository'))
            return 'data';
        if (fileName.includes('config') || fileName.includes('helper'))
            return 'infrastructure';
        if (content.includes('curl_') || content.includes('file_get_contents'))
            return 'external';
        return 'infrastructure';
    }
    extractResponsibilities(filePath, content) {
        const responsibilities = [];
        if (content.includes('Controller extends'))
            responsibilities.push('HTTP request handling');
        if (content.includes('Model extends') || content.includes('Eloquent'))
            responsibilities.push('Data modeling');
        if (content.includes('$_GET') || content.includes('$_POST'))
            responsibilities.push('Request processing');
        if (content.includes('curl_') || content.includes('file_get_contents'))
            responsibilities.push('External service communication');
        if (this.isTestFile(filePath))
            responsibilities.push('Testing');
        return responsibilities.length > 0 ? responsibilities : ['General utility'];
    }
    isTestFile(filePath) {
        const fileName = path.basename(filePath).toLowerCase();
        return fileName.includes('test.php') || fileName.includes('tests.php') ||
            filePath.includes('/test/') || filePath.includes('/tests/') ||
            filePath.includes('\\test\\') || filePath.includes('\\tests\\');
    }
    isEntryPoint(filePath, content) {
        const fileName = path.basename(filePath);
        return fileName === 'index.php' || fileName === 'app.php' || content.includes('$_SERVER[\'REQUEST_METHOD\']');
    }
    async analyzeComposerJson() {
        const frameworks = [];
        const composerJsonPath = path.join(this.projectPath, 'composer.json');
        if (await fs.pathExists(composerJsonPath)) {
            const content = await fs.readFile(composerJsonPath, 'utf-8');
            const packageJson = JSON.parse(content);
            const deps = { ...packageJson.require, ...packageJson['require-dev'] };
            const frameworkMappings = {
                'laravel/framework': 'laravel',
                'symfony/symfony': 'symfony',
                'codeigniter4/framework': 'codeigniter',
                'slim/slim': 'slim',
                'phpunit/phpunit': 'phpunit'
            };
            for (const [dep, name] of Object.entries(frameworkMappings)) {
                if (deps[dep]) {
                    frameworks.push({ name, version: deps[dep], confidence: 0.9, patterns: ['Found in composer.json'], configFiles: ['composer.json'], dependencies: [name] });
                }
            }
        }
        return frameworks;
    }
    async analyzeCodeForFrameworks(files) {
        const frameworks = [];
        const indicators = new Map();
        for (const filePath of files) {
            try {
                const content = await this.readFile(filePath);
                if (content.includes('use Illuminate\\') || content.includes('Artisan::')) {
                    this.updateFrameworkIndicator(indicators, 'laravel', filePath);
                }
                if (content.includes('use Symfony\\')) {
                    this.updateFrameworkIndicator(indicators, 'symfony', filePath);
                }
            }
            catch (error) {
            }
        }
        for (const [name, info] of indicators) {
            frameworks.push({ name, confidence: Math.min(0.8, info.count * 0.1), patterns: [`Found in ${info.files.size} files`], configFiles: Array.from(info.files), dependencies: [name] });
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
    findComponentByUsePath(components, usePath) {
        return components.find(c => c.metadata.exports.some(exp => usePath.includes(exp)));
    }
    calculateRiskImpact(riskLevel, dependentCount) {
        const baseImpact = riskLevel === 'high' ? 'High' : riskLevel === 'medium' ? 'Medium' : 'Low';
        const scopeImpact = dependentCount > 8 ? 'system-wide' : dependentCount > 4 ? 'module-wide' : 'localized';
        return `${baseImpact} impact, ${scopeImpact} scope`;
    }
    hasCorrespondingTest(component, testFiles) {
        const componentName = path.basename(component.path, '.php');
        return testFiles.some(test => test.path.includes(`${componentName}Test`) || test.path.includes(`test_${componentName}`));
    }
    async analyzeAPIEndpoints(components) {
        const endpoints = [];
        for (const component of components) {
            if ((component.type === 'controller' || component.type === 'route') && component.metadata.httpMethods) {
                for (const method of component.metadata.httpMethods) {
                    endpoints.push({
                        id: `${component.id}_${method}`, method: method, path: `/${component.name}`,
                        description: `${method} endpoint`, parameters: [], requestSchema: null, responseSchema: null,
                        statusCodes: [{ code: 200, description: 'Success', schema: null }], middleware: [],
                        authentication: { type: 'none', required: false }, componentId: component.id, handler: component.name
                    });
                }
            }
        }
        return endpoints;
    }
}
exports.PHPAnalyzer = PHPAnalyzer;
