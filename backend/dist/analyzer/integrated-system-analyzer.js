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
exports.integratedAnalyzer = exports.IntegratedSystemAnalyzer = void 0;
const base_analyzer_1 = require("./base-analyzer");
const manifest_generator_1 = require("./manifest-generator");
const plugin_registry_1 = require("./plugin-registry");
const telemetry_schema_1 = require("../telemetry/telemetry-schema");
const framework_detector_1 = require("./patterns/framework-detector");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class IntegratedSystemAnalyzer extends base_analyzer_1.BaseAnalyzer {
    constructor() {
        super();
        this.options = {};
        this.pluginsUsed = [];
        this.frameworkDetector = new framework_detector_1.FrameworkDetector();
    }
    getAnalyzerName() {
        return 'Integrated System Analyzer';
    }
    getSupportedLanguages() {
        return ['javascript', 'typescript', 'python', 'java', 'csharp', 'go', 'rust'];
    }
    getSupportedFrameworks() {
        return ['express', 'nestjs', 'react', 'vue', 'angular', 'django', 'flask', 'spring', 'fastapi'];
    }
    async analyzeProject(repositoryPath, options = {}) {
        this.options = { ...this.options, ...options };
        const analysisStartTime = Date.now();
        if (this.options.generateManifest) {
            this.manifestGenerator = new manifest_generator_1.ManifestGenerator({ includeTelemetry: this.options.enableTelemetry }, this.options.organizationId, this.options.projectId);
        }
        const span = telemetry_schema_1.telemetry.createSpan('integrated-analyzer.analyzeProject');
        try {
            console.log('🚀 Starting integrated system analysis...');
            let selectedAnalyzer = null;
            if (this.options.usePluginRegistry !== false) {
                selectedAnalyzer = await this.selectBestAnalyzer(repositoryPath);
            }
            const blueprint = selectedAnalyzer
                ? await selectedAnalyzer.analyzeRepository(repositoryPath, this.options)
                : await this.performIntegratedAnalysis(repositoryPath);
            let manifest, manifestPath;
            if (this.options.generateManifest && this.manifestGenerator) {
                const duration = Date.now() - analysisStartTime;
                manifest = await this.manifestGenerator.generateManifest(blueprint, this.analysisId, this.getAnalyzerName(), duration);
                if (this.options.manifestOutputPath) {
                    manifestPath = this.options.manifestOutputPath;
                    await this.manifestGenerator.saveManifest(manifest, manifestPath);
                }
            }
            const finalDuration = Date.now() - analysisStartTime;
            telemetry_schema_1.telemetry.emit({
                type: 'analysis_completed',
                source: { analyzer: this.getAnalyzerName() },
                data: {
                    duration: finalDuration,
                    componentCount: blueprint.components.length,
                    frameworksDetected: blueprint.technologyStack?.additionalFrameworks?.length || 0,
                    pluginsUsed: this.pluginsUsed,
                    manifestGenerated: !!manifest,
                    persistedResults: this.options.persistResults
                }
            });
            span.end();
            return {
                blueprint,
                manifest,
                manifestPath,
                analysisId: this.analysisId,
                duration: finalDuration,
                metadata: {
                    analyzer: selectedAnalyzer?.getAnalyzerName() || this.getAnalyzerName(),
                    telemetryEvents: 0,
                    persistedComponents: blueprint.components.length,
                    pluginsUsed: this.pluginsUsed
                }
            };
        }
        catch (error) {
            telemetry_schema_1.telemetry.emit({
                type: 'error_occurred',
                source: { analyzer: this.getAnalyzerName() },
                data: {
                    error: error instanceof Error ? error.message : String(error),
                    duration: Date.now() - analysisStartTime
                }
            });
            span.end();
            throw error;
        }
    }
    async selectBestAnalyzer(repositoryPath) {
        const span = telemetry_schema_1.telemetry.createSpan('integrated-analyzer.selectBestAnalyzer');
        try {
            await plugin_registry_1.pluginRegistry.discoverPlugins({
                includeOfficial: true,
                includeCommunity: true,
                includeInternal: true
            });
            const analyzer = await plugin_registry_1.pluginRegistry.getAnalyzerForProject(repositoryPath);
            if (analyzer) {
                const stats = plugin_registry_1.pluginRegistry.getStatistics();
                this.pluginsUsed = stats.supportedFrameworks.slice(0, 3);
            }
            span.end();
            return analyzer;
        }
        catch (error) {
            console.warn('Failed to select analyzer from plugin registry:', error instanceof Error ? error.message : String(error));
            span.end();
            return null;
        }
    }
    async performIntegratedAnalysis(repositoryPath) {
        console.log('🔧 Performing integrated analysis...');
        return await this.analyzeRepository(repositoryPath, this.options);
    }
    async detectLanguageAndFramework() {
        const span = telemetry_schema_1.telemetry.createSpan('integrated-analyzer.detectLanguageAndFramework');
        try {
            const techStack = await this.frameworkDetector.detectFrameworks(this.projectPath);
            if (techStack.primaryFramework) {
                span.end();
                return {
                    language: techStack.primaryFramework.language || 'unknown',
                    confidence: techStack.primaryFramework.confidence || 0.5,
                    frameworks: [
                        ...techStack.additionalFrameworks.map(f => ({
                            name: f.name,
                            version: f.version,
                            confidence: f.confidence || 0.5,
                            patterns: [],
                            metadata: f.metadata
                        })),
                        {
                            name: techStack.primaryFramework.name,
                            version: techStack.primaryFramework.version,
                            confidence: techStack.primaryFramework.confidence || 0.5,
                            patterns: [],
                            metadata: techStack.primaryFramework.metadata
                        }
                    ],
                    files: []
                };
            }
            const fallback = await this.basicLanguageDetection();
            span.end();
            return fallback;
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async basicLanguageDetection() {
        const packageJsonPath = path.join(this.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            const packageJson = await fs.readJson(packageJsonPath);
            return {
                language: 'javascript',
                confidence: 0.8,
                frameworks: [{
                        name: 'nodejs',
                        confidence: 0.8,
                        patterns: ['package.json']
                    }],
                files: ['package.json']
            };
        }
        const requirementsPath = path.join(this.projectPath, 'requirements.txt');
        if (await fs.pathExists(requirementsPath)) {
            return {
                language: 'python',
                confidence: 0.8,
                frameworks: [],
                files: ['requirements.txt']
            };
        }
        return {
            language: 'unknown',
            confidence: 0.0,
            frameworks: [],
            files: []
        };
    }
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('integrated-analyzer.discoverComponents');
        try {
            const sourceDir = await this.findSourceDirectory();
            const files = await this.findFiles(['**/*.{js,ts,jsx,tsx,py,java,cs,go,rs}']);
            const components = [];
            let analyzedFiles = 0;
            let skippedFiles = 0;
            for (const filePath of files) {
                try {
                    const component = await this.analyzeFileAsComponent(filePath);
                    if (component) {
                        components.push(component);
                        analyzedFiles++;
                    }
                }
                catch (error) {
                    skippedFiles++;
                    console.warn(`⚠️ Skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            span.end();
            return {
                totalFiles: files.length,
                analyzedFiles,
                skippedFiles,
                components
            };
        }
        catch (error) {
            span.end();
            throw error;
        }
    }
    async analyzeFileAsComponent(filePath) {
        const content = await this.readFile(filePath);
        const relativePath = path.relative(this.projectPath, filePath);
        const component = {
            id: this.generateComponentId(filePath),
            name: path.basename(filePath, path.extname(filePath)),
            type: this.inferComponentType(filePath, content),
            path: relativePath,
            language: this.inferLanguageFromFile(filePath),
            framework: 'unknown',
            dependencies: [],
            dependents: [],
            metrics: {
                linesOfCode: content.split('\n').length,
                complexity: 1,
                maintainability: 80,
                testCoverage: 0,
                duplicateCode: 0,
                technicalDebt: 0
            },
            metadata: {
                lineCount: content.split('\n').length,
                complexity: this.calculateComplexity(content),
                lastModified: new Date(),
                exports: this.extractExports(content),
                imports: this.extractImports(content),
                isEntry: false,
                layer: 'application',
                responsibilities: ['Generic component'],
                functions: await this.extractFunctions(content, this.inferLanguageFromFile(filePath))
            }
        };
        return component;
    }
    inferComponentType(filePath, content) {
        const fileName = path.basename(filePath).toLowerCase();
        if (fileName.includes('controller'))
            return 'controller';
        if (fileName.includes('service'))
            return 'service';
        if (fileName.includes('model') || fileName.includes('entity'))
            return 'model';
        if (fileName.includes('middleware'))
            return 'middleware';
        if (fileName.includes('route') || fileName.includes('router'))
            return 'route';
        if (fileName.includes('component') && content.includes('React'))
            return 'react_component';
        if (fileName.includes('test') || fileName.includes('spec'))
            return 'test';
        if (fileName.includes('config'))
            return 'configuration';
        if (fileName.includes('util') || fileName.includes('helper'))
            return 'utility';
        return 'module';
    }
    inferLanguageFromFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const langMap = {
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust'
        };
        return langMap[ext] || 'unknown';
    }
    extractImports(content) {
        const imports = [];
        const jsImports = content.match(/(?:import.*from\s+['"`]([^'"`]+)['"`]|require\s*\(\s*['"`]([^'"`]+)['"`]\))/g);
        if (jsImports) {
            jsImports.forEach(imp => {
                const match = imp.match(/['"`]([^'"`]+)['"`]/);
                if (match)
                    imports.push(match[1]);
            });
        }
        const pyImports = content.match(/(?:from\s+(\w+)|import\s+(\w+))/g);
        if (pyImports) {
            pyImports.forEach(imp => {
                const match = imp.match(/(?:from\s+(\w+)|import\s+(\w+))/);
                if (match)
                    imports.push(match[1] || match[2]);
            });
        }
        return imports;
    }
    extractExports(content) {
        const exports = [];
        const jsExports = content.match(/export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g);
        if (jsExports) {
            jsExports.forEach(exp => {
                const match = exp.match(/(\w+)$/);
                if (match)
                    exports.push(match[1]);
            });
        }
        return exports;
    }
    async findSourceDirectory() {
        const commonSrcDirs = ['src', 'lib', 'app', 'source', 'server'];
        for (const dir of commonSrcDirs) {
            const dirPath = path.join(this.projectPath, dir);
            if (await fs.pathExists(dirPath)) {
                return dirPath;
            }
        }
        return this.projectPath;
    }
    async analyzeConnections(components) {
        const connections = [];
        components.forEach(component => {
            component.metadata.imports.forEach(importPath => {
                const targetComponent = components.find(c => c.name === importPath ||
                    c.path.includes(importPath.replace(/[./]/g, '/')));
                if (targetComponent) {
                    connections.push({
                        from: component.id,
                        to: targetComponent.id,
                        type: 'import',
                        weight: 1,
                        metadata: {
                            callSites: 1,
                            importType: importPath
                        }
                    });
                }
            });
        });
        return connections;
    }
    async assessRisks(components, connections) {
        const risks = [];
        components.forEach(component => {
            if (component.metadata.complexity > 7) {
                risks.push({
                    componentId: component.id,
                    riskLevel: 'high',
                    reasons: [`High complexity score: ${component.metadata.complexity}`],
                    impact: 'maintainability'
                });
            }
        });
        return risks;
    }
    async generateCallGraph(components) {
        return {
            nodes: components.map(c => ({
                id: c.id,
                name: c.name,
                type: 'module',
                file: c.path,
                complexity: c.metadata.complexity,
                fanIn: c.dependents.length,
                fanOut: c.dependencies.length,
                depth: 0,
                critical: c.metadata.complexity > 7
            })),
            edges: [],
            entryPoints: [],
            cycles: [],
            layers: [],
            hotPaths: [],
            deadCode: []
        };
    }
    async analyzeDatabaseConnections(components) {
        const connections = [];
        for (const component of components) {
            try {
                const content = await this.readFile(path.join(this.projectPath, component.path));
                const dbConnections = await this.detectDatabaseConnections(content);
                connections.push(...dbConnections);
            }
            catch (error) {
            }
        }
        return connections;
    }
    async analyzeTestCoverage(components) {
        const testComponents = components.filter(c => c.metadata.isTest);
        return {
            overall: testComponents.length / components.length * 100,
            lines: { covered: 0, total: 0, percentage: 0 },
            branches: { covered: 0, total: 0, percentage: 0 },
            functions: { covered: 0, total: 0, percentage: 0 },
            statements: { covered: 0, total: 0, percentage: 0 },
            byComponent: {},
            byType: {
                unit: testComponents.filter(c => c.name.includes('unit')).length,
                integration: testComponents.filter(c => c.name.includes('integration')).length,
                e2e: testComponents.filter(c => c.name.includes('e2e')).length
            },
            uncoveredFiles: components.filter(c => !c.metadata.isTest).map(c => c.path)
        };
    }
}
exports.IntegratedSystemAnalyzer = IntegratedSystemAnalyzer;
exports.integratedAnalyzer = new IntegratedSystemAnalyzer();
