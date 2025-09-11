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
exports.RustAnalyzer = void 0;
const base_analyzer_1 = require("../base-analyzer");
const telemetry_schema_1 = require("../../telemetry/telemetry-schema");
const errors_1 = require("../errors");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class RustAnalyzer extends base_analyzer_1.BaseAnalyzer {
    constructor() {
        super(...arguments);
        this.rustVersion = '';
        this.hasCargoToml = false;
    }
    getAnalyzerName() {
        return 'Rust Analyzer';
    }
    getSupportedLanguages() {
        return ['rust'];
    }
    getSupportedFrameworks() {
        return ['actix-web', 'rocket', 'warp', 'axum', 'tide', 'tokio', 'async-std', 'diesel', 'sqlx', 'serde', 'clap', 'hyper'];
    }
    async detectLanguageAndFramework() {
        const span = telemetry_schema_1.telemetry.createSpan('rust-analyzer.detectLanguageAndFramework');
        let confidence = 0;
        const frameworks = [];
        const files = [];
        try {
            const rustFiles = await this.findFiles(['**/*.rs'], this.options.excludePatterns);
            files.push(...rustFiles);
            if (rustFiles.length > 0)
                confidence += 0.5;
            const rustSpecificFiles = ['Cargo.toml', 'Cargo.lock', 'main.rs', 'lib.rs', 'build.rs'];
            for (const file of rustSpecificFiles) {
                const filePath = path.join(this.projectPath, file);
                if (await fs.pathExists(filePath)) {
                    confidence += 0.1;
                    files.push(filePath);
                    if (file === 'Cargo.toml')
                        this.hasCargoToml = true;
                }
            }
            if (this.hasCargoToml) {
                const cargoFrameworks = await this.analyzeCargoToml();
                frameworks.push(...cargoFrameworks);
            }
            if (rustFiles.length > 0) {
                const codeFrameworks = await this.analyzeCodeForFrameworks(rustFiles.slice(0, 15));
                frameworks.push(...codeFrameworks);
            }
            confidence = Math.min(confidence, 1.0);
            telemetry_schema_1.telemetry.emit({
                type: 'analysis_started',
                source: { analyzer: this.getAnalyzerName() },
                data: { language: 'rust', confidence, filesCount: files.length, frameworksFound: frameworks.length, hasCargoToml: this.hasCargoToml }
            });
            span.end();
            return { language: 'rust', confidence, frameworks: frameworks.sort((a, b) => b.confidence - a.confidence), files };
        }
        catch (error) {
            span.end();
            throw new errors_1.AnalyzerError(`Rust language detection failed: ${error.message}`, 'DETECTION_ERROR', { error });
        }
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('rust-analyzer.discoverComponents');
        const components = [];
        let totalFiles = 0, analyzedFiles = 0, skippedFiles = 0;
        try {
            const sourceFiles = await this.findFiles(['**/*.rs'], [...(this.options.excludePatterns || []), 'target/**']);
            totalFiles = sourceFiles.length;
            console.log(`🦀 Analyzing ${totalFiles} Rust files...`);
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
            console.log(`✅ Rust analysis complete: ${analyzedFiles} analyzed, ${skippedFiles} skipped`);
            span.end();
            return { totalFiles, analyzedFiles, skippedFiles, components };
        }
        catch (error) {
            span.end();
            throw new errors_1.AnalyzerError(`Rust component discovery failed: ${error.message}`, 'DISCOVERY_ERROR', { error });
        }
    }
    async analyzeConnections(components) {
        const span = telemetry_schema_1.telemetry.createSpan('rust-analyzer.analyzeConnections');
        const connections = [];
        try {
            console.log(`🔗 Analyzing Rust connections between ${components.length} components...`);
            for (const component of components) {
                for (const usePath of component.metadata.imports) {
                    const targetComponent = this.findComponentByUsePath(components, usePath);
                    if (targetComponent && targetComponent.id !== component.id) {
                        connections.push({
                            from: component.id,
                            to: targetComponent.id,
                            type: 'import',
                            weight: 1,
                            metadata: { callSites: 1, dataFlow: 'use' }
                        });
                    }
                }
            }
            const connectionMap = new Map();
            for (const conn of connections) {
                const key = `${conn.from}-${conn.to}-${conn.type}`;
                const existing = connectionMap.get(key);
                if (existing) {
                    existing.weight += conn.weight;
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
            throw new errors_1.AnalyzerError(`Rust connection analysis failed: ${error.message}`, 'CONNECTION_ERROR', { error });
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
            if (component.metadata.lineCount > 800) {
                reasons.push(`Large file (${component.metadata.lineCount} lines)`);
                riskLevel = 'high';
            }
            const incomingConnections = connections.filter(c => c.to === component.id).length;
            if (incomingConnections > 6) {
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
            critical: comp.metadata.complexity >= 7 || comp.dependents.length > 5
        }));
        const edges = components.flatMap(comp => comp.dependencies.map(dep => ({ from: comp.id, to: dep, count: 1, type: 'direct', async: this.hasAsyncCode(comp), conditional: false })));
        return { nodes, edges, entryPoints: components.filter(c => c.metadata.isEntry).map(c => c.id), cycles: [], layers: [], hotPaths: [], deadCode: [] };
    }
    async analyzeDatabaseConnections(components) {
        const connections = [];
        const dbPatterns = [
            { type: 'postgresql', patterns: ['diesel', 'sqlx', 'postgres'] },
            { type: 'mysql', patterns: ['mysql', 'sqlx'] },
            { type: 'sqlite', patterns: ['sqlite', 'rusqlite', 'sqlx'] },
            { type: 'redis', patterns: ['redis'] }
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
        const estimatedCoveredLines = Math.min(testFiles.length * 25, totalLines * 0.6);
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
                id: this.generateComponentId(filePath), name: path.basename(filePath, path.extname(filePath)),
                type: this.determineComponentType(filePath, content), path: relativePath,
                dependencies: [], dependents: [],
                metadata: {
                    lineCount: content.split('\n').length, complexity: this.calculateComplexity(content),
                    lastModified: (await fs.stat(filePath)).mtime, exports: this.extractExports(content),
                    imports: this.extractImports(content), layer: this.determineArchitecturalLayer(filePath, content),
                    responsibilities: this.extractResponsibilities(filePath, content), functions: await this.extractFunctions(content, 'rust'),
                    testCoverage: this.isTestFile(filePath) ? 100 : undefined, isEntry: this.isEntryPoint(filePath, content),
                    httpMethods: this.extractHttpMethods(content), dbQueries: this.extractDatabaseQueries(content),
                    externalCalls: this.extractExternalCalls(content)
                }
            };
        }
        catch (error) {
            throw new errors_1.AnalyzerError(`Failed to analyze Rust file ${filePath}: ${error.message}`, 'FILE_ANALYSIS_ERROR', { filePath, error });
        }
    }
    determineComponentType(filePath, content) {
        const fileName = path.basename(filePath).toLowerCase();
        if (this.isTestFile(filePath))
            return 'utility';
        if (content.includes('fn main()') || fileName === 'main.rs')
            return 'route';
        if (content.includes('#[get(') || content.includes('#[post(') || content.includes('HttpServer::new'))
            return 'route';
        if (fileName.includes('service') || fileName.includes('handler'))
            return 'service';
        if (fileName.includes('model') || fileName.includes('entity'))
            return 'model';
        if (fileName.includes('repository') || fileName.includes('db'))
            return 'database';
        if (fileName === 'lib.rs')
            return 'config';
        return 'utility';
    }
    extractImports(content) {
        const imports = [];
        const useStatements = content.match(/use\s+([^;]+);/g) || [];
        for (const statement of useStatements) {
            const usePath = statement.replace(/use\s+/, '').replace(';', '').trim();
            const parts = usePath.split('::');
            if (parts.length > 0) {
                imports.push(parts[0]);
            }
        }
        return [...new Set(imports)];
    }
    extractExports(content) {
        const exports = [];
        const publicFunctions = content.match(/pub\s+fn\s+(\w+)/g);
        if (publicFunctions)
            exports.push(...publicFunctions.map(f => f.split(/\s+/).pop() || ''));
        const publicStructs = content.match(/pub\s+struct\s+(\w+)/g);
        if (publicStructs)
            exports.push(...publicStructs.map(s => s.split(/\s+/).pop() || ''));
        const publicEnums = content.match(/pub\s+enum\s+(\w+)/g);
        if (publicEnums)
            exports.push(...publicEnums.map(e => e.split(/\s+/).pop() || ''));
        return [...new Set(exports)];
    }
    extractHttpMethods(content) {
        const methods = [];
        const actixMethods = content.match(/#\[(get|post|put|delete|patch)\(/g);
        if (actixMethods)
            methods.push(...actixMethods.map(m => m.match(/#\[(get|post|put|delete|patch)\(/)?.[1]?.toUpperCase() || ''));
        const rocketMethods = content.match(/#\[(get|post|put|delete|patch)\(/g);
        if (rocketMethods)
            methods.push(...rocketMethods.map(m => m.match(/#\[(get|post|put|delete|patch)\(/)?.[1]?.toUpperCase() || ''));
        return [...new Set(methods)];
    }
    extractDatabaseQueries(content) {
        const queries = [];
        const sqlQueries = content.match(/r#"(SELECT.*?)"#/gis) || content.match(/"(SELECT.*?)"/gis);
        if (sqlQueries)
            queries.push(...sqlQueries.map(q => q.replace(/^r#"/, '').replace(/"#?$/, '')));
        return queries;
    }
    extractExternalCalls(content) {
        const calls = [];
        const httpCalls = content.match(/reqwest::get\s*\(\s*"([^"]+)"/g);
        if (httpCalls)
            calls.push(...httpCalls.map(call => `GET ${call.match(/"([^"]+)"/)?.[1]}`));
        return calls;
    }
    determineArchitecturalLayer(filePath, content) {
        const fileName = path.basename(filePath).toLowerCase();
        if (fileName.includes('handler') || fileName.includes('controller') || content.includes('HttpServer::new'))
            return 'presentation';
        if (fileName.includes('service'))
            return 'business';
        if (fileName.includes('model') || fileName.includes('repository'))
            return 'data';
        if (content.includes('reqwest::') || content.includes('hyper::'))
            return 'external';
        return 'infrastructure';
    }
    extractResponsibilities(filePath, content) {
        const responsibilities = [];
        if (content.includes('fn main()'))
            responsibilities.push('Application entry point');
        if (content.includes('HttpServer::new') || content.includes('#[get('))
            responsibilities.push('HTTP request handling');
        if (content.includes('diesel::') || content.includes('sqlx::'))
            responsibilities.push('Database operations');
        if (this.isTestFile(filePath))
            responsibilities.push('Testing');
        return responsibilities.length > 0 ? responsibilities : ['General utility'];
    }
    isTestFile(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8').slice(0, 1000);
        return content.includes('#[cfg(test)]') || content.includes('#[test]') || filePath.includes('/tests/');
    }
    isEntryPoint(filePath, content) {
        return content.includes('fn main()') || path.basename(filePath) === 'main.rs';
    }
    hasAsyncCode(component) {
        return component.metadata.functions?.some(f => f.isAsync) || false;
    }
    async analyzeCargoToml() {
        const frameworks = [];
        const cargoTomlPath = path.join(this.projectPath, 'Cargo.toml');
        if (await fs.pathExists(cargoTomlPath)) {
            const content = await fs.readFile(cargoTomlPath, 'utf-8');
            const frameworkPatterns = {
                'actix-web': /actix-web\s*=/,
                'rocket': /rocket\s*=/,
                'warp': /warp\s*=/,
                'tokio': /tokio\s*=/,
                'diesel': /diesel\s*=/
            };
            for (const [name, pattern] of Object.entries(frameworkPatterns)) {
                if (pattern.test(content)) {
                    frameworks.push({ name, confidence: 0.9, patterns: ['Found in Cargo.toml'], configFiles: ['Cargo.toml'], dependencies: [name] });
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
                if (content.includes('use actix_web::')) {
                    this.updateFrameworkIndicator(indicators, 'actix-web', filePath);
                }
                if (content.includes('use rocket::')) {
                    this.updateFrameworkIndicator(indicators, 'rocket', filePath);
                }
            }
            catch (error) {
            }
        }
        for (const [name, info] of indicators) {
            frameworks.push({ name, confidence: Math.min(0.8, info.count * 0.15), patterns: [`Found in ${info.files.size} files`], configFiles: Array.from(info.files), dependencies: [name] });
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
        const scopeImpact = dependentCount > 6 ? 'system-wide' : dependentCount > 3 ? 'module-wide' : 'localized';
        return `${baseImpact} impact, ${scopeImpact} scope`;
    }
    hasCorrespondingTest(component, testFiles) {
        const componentName = path.basename(component.path, '.rs');
        return testFiles.some(test => test.path.includes(`${componentName}_test`) || test.path.includes('tests'));
    }
    async analyzeAPIEndpoints(components) {
        const endpoints = [];
        for (const component of components) {
            if (component.type === 'route' && component.metadata.httpMethods) {
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
exports.RustAnalyzer = RustAnalyzer;
