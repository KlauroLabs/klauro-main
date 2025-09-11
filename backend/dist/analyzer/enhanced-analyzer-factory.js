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
exports.analyzerFactory = exports.EnhancedAnalyzerFactory = void 0;
const plugin_registry_1 = require("./plugin-registry");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class EnhancedAnalyzerFactory {
    constructor() {
        this.selectionCache = new Map();
        this.selectionHistory = [];
        this.statistics = {
            totalSelections: 0,
            averageSelectionTime: 0,
            successRate: 0,
            popularAnalyzers: [],
            averageConfidence: 0,
            cacheHitRate: 0
        };
        this.initializeBuiltInAnalyzers();
    }
    async initializeBuiltInAnalyzers() {
        try {
            await plugin_registry_1.pluginRegistry.discoverPlugins({
                includeOfficial: true,
                includeCommunity: true,
                includeInternal: true
            });
            try {
                const { SystemTopologyAnalyzer } = await Promise.resolve().then(() => __importStar(require('./system-topology-analyzer')));
                if (!plugin_registry_1.pluginRegistry.getPlugin('system-topology')) {
                    plugin_registry_1.pluginRegistry.registerPlugin({
                        id: 'system-topology',
                        name: 'System Topology Analyzer',
                        version: '1.0.0',
                        description: 'Universal system architecture analyzer',
                        author: 'Unravl Team',
                        analyzer: SystemTopologyAnalyzer,
                        supportedLanguages: ['typescript', 'javascript', 'python', 'java', 'csharp', 'go', 'rust', 'php'],
                        supportedFrameworks: ['any'],
                        type: 'official',
                        category: 'specialized',
                        priority: 100,
                        metadata: {
                            minEngineVersion: '1.0.0',
                            license: 'MIT',
                            keywords: ['architecture', 'topology', 'universal'],
                            maintainers: ['Unravl Team'],
                            lastUpdated: new Date(),
                            verified: true
                        },
                        dependencies: []
                    });
                }
            }
            catch (error) {
                console.warn('⚠️ Failed to register SystemTopologyAnalyzer:', error instanceof Error ? error.message : String(error));
            }
            console.log('🚀 Enhanced Analyzer Factory initialized with plugin system');
        }
        catch (error) {
            console.error('❌ Failed to initialize Enhanced Analyzer Factory:', error instanceof Error ? error.message : String(error));
        }
    }
    async createAnalyzer(context) {
        const startTime = Date.now();
        this.statistics.totalSelections++;
        try {
            const cacheKey = this.generateCacheKey(context);
            if (this.selectionCache.has(cacheKey)) {
                this.statistics.cacheHitRate = (this.statistics.cacheHitRate * (this.statistics.totalSelections - 1) + 1) / this.statistics.totalSelections;
                return this.selectionCache.get(cacheKey);
            }
            const projectAnalysis = await this.analyzeProject(context);
            const candidates = await this.getCandidateAnalyzers(projectAnalysis, context);
            const selection = await this.selectBestAnalyzer(candidates, projectAnalysis, context);
            const detectionTime = Date.now() - startTime;
            selection.detectionTime = detectionTime;
            this.updateStatistics(selection, detectionTime);
            this.selectionCache.set(cacheKey, selection);
            this.selectionHistory.push(selection);
            console.log(`🎯 Selected ${selection.plugin.name} analyzer (confidence: ${(selection.confidence * 100).toFixed(0)}%, ${detectionTime}ms)`);
            return selection;
        }
        catch (error) {
            console.error('❌ Failed to create analyzer:', error instanceof Error ? error.message : String(error));
            const fallback = await this.createFallbackAnalyzer(context);
            if (fallback) {
                fallback.detectionTime = Date.now() - startTime;
                fallback.metadata.warnings = [`Using fallback analyzer due to: ${error instanceof Error ? error.message : String(error)}`];
                return fallback;
            }
            throw new Error(`No suitable analyzer found for project: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async analyzeProject(context) {
        const analysis = {
            repositoryPath: context.repositoryPath,
            projectName: context.projectName || path.basename(context.repositoryPath),
            languages: new Map(),
            frameworks: new Set(),
            fileTypes: new Map(),
            directoryStructure: new Set(),
            configFiles: new Set(),
            complexityIndicators: [],
            projectType: 'unknown',
            stack: 'unknown'
        };
        try {
            const files = await this.scanProjectFiles(context.repositoryPath);
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                const language = this.mapExtensionToLanguage(ext);
                if (language) {
                    analysis.languages.set(language, (analysis.languages.get(language) || 0) + 1);
                }
                analysis.fileTypes.set(ext, (analysis.fileTypes.get(ext) || 0) + 1);
            }
            for (const file of files) {
                const dirs = file.split('/');
                dirs.forEach(dir => {
                    if (dir && !dir.startsWith('.')) {
                        analysis.directoryStructure.add(dir.toLowerCase());
                    }
                });
            }
            const configFiles = files.filter(f => this.isConfigFile(f));
            for (const config of configFiles) {
                analysis.configFiles.add(path.basename(config));
                const frameworks = await this.detectFrameworksFromConfig(config);
                frameworks.forEach(fw => analysis.frameworks.add(fw));
            }
            analysis.projectType = this.determineProjectType(analysis);
            analysis.stack = this.determineStack(analysis);
            return analysis;
        }
        catch (error) {
            console.warn(`⚠️ Project analysis failed: ${error instanceof Error ? error.message : String(error)}`);
            return analysis;
        }
    }
    async scanProjectFiles(repositoryPath) {
        const files = [];
        const maxFiles = 200;
        try {
            const entries = await fs.readdir(repositoryPath, { recursive: true });
            for (const entry of entries.slice(0, maxFiles)) {
                const fullPath = path.join(repositoryPath, entry.toString());
                try {
                    const stat = await fs.stat(fullPath);
                    if (stat.isFile()) {
                        files.push(path.relative(repositoryPath, fullPath));
                    }
                }
                catch {
                }
            }
        }
        catch (error) {
            console.warn(`⚠️ Failed to scan project files: ${error instanceof Error ? error.message : String(error)}`);
        }
        return files;
    }
    mapExtensionToLanguage(ext) {
        const mapping = {
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.py': 'python',
            '.java': 'java',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust',
            '.php': 'php',
            '.rb': 'ruby',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.clj': 'clojure',
            '.cpp': 'cpp',
            '.c': 'c',
            '.h': 'c',
            '.hpp': 'cpp'
        };
        return mapping[ext] || null;
    }
    isConfigFile(filePath) {
        const configPatterns = [
            'package.json', 'package-lock.json', 'yarn.lock',
            'requirements.txt', 'setup.py', 'Pipfile',
            'pom.xml', 'build.gradle', 'gradle.properties',
            'Cargo.toml', 'Cargo.lock',
            'go.mod', 'go.sum',
            'composer.json', 'composer.lock',
            'Gemfile', 'Gemfile.lock',
            'tsconfig.json', 'jsconfig.json',
            'webpack.config.js', 'vite.config.js',
            'angular.json', 'vue.config.js',
            'next.config.js', 'nuxt.config.js',
            'tailwind.config.js', 'postcss.config.js',
            'jest.config.js', 'vitest.config.js',
            'eslint.config.js', '.eslintrc.json',
            'prettier.config.js', '.prettierrc',
            'docker-compose.yml', 'Dockerfile',
            '.env', '.env.example',
            'appsettings.json', 'web.config'
        ];
        const fileName = path.basename(filePath);
        return configPatterns.some(pattern => fileName.includes(pattern));
    }
    async detectFrameworksFromConfig(configFile) {
        const frameworks = [];
        try {
            const content = await fs.readFile(configFile, 'utf-8');
            const fileName = path.basename(configFile);
            if (fileName === 'package.json') {
                const pkg = JSON.parse(content);
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                Object.keys(deps).forEach(dep => {
                    if (dep === 'react')
                        frameworks.push('React');
                    if (dep === 'vue')
                        frameworks.push('Vue');
                    if (dep === '@angular/core')
                        frameworks.push('Angular');
                    if (dep === 'express')
                        frameworks.push('Express');
                    if (dep === '@nestjs/core')
                        frameworks.push('NestJS');
                    if (dep === 'next')
                        frameworks.push('Next.js');
                    if (dep === 'nuxt')
                        frameworks.push('Nuxt.js');
                    if (dep === 'svelte')
                        frameworks.push('Svelte');
                });
            }
            else if (fileName === 'requirements.txt') {
                if (content.includes('django'))
                    frameworks.push('Django');
                if (content.includes('flask'))
                    frameworks.push('Flask');
                if (content.includes('fastapi'))
                    frameworks.push('FastAPI');
                if (content.includes('tornado'))
                    frameworks.push('Tornado');
            }
        }
        catch (error) {
        }
        return frameworks;
    }
    determineProjectType(analysis) {
        if (analysis.frameworks.has('React') || analysis.frameworks.has('Vue') || analysis.frameworks.has('Angular')) {
            return 'web-frontend';
        }
        if (analysis.frameworks.has('Express') || analysis.frameworks.has('NestJS') || analysis.frameworks.has('Django')) {
            return 'web-backend';
        }
        if (analysis.frameworks.has('Next.js') || analysis.frameworks.has('Nuxt.js')) {
            return 'web-fullstack';
        }
        if (analysis.directoryStructure.has('api') || analysis.directoryStructure.has('routes')) {
            return 'api';
        }
        if (analysis.directoryStructure.has('tests') && analysis.languages.size === 1) {
            return 'library';
        }
        return 'application';
    }
    determineStack(analysis) {
        const hasWebFramework = Array.from(analysis.frameworks).some(fw => ['React', 'Vue', 'Angular', 'Svelte'].includes(fw));
        const hasBackendFramework = Array.from(analysis.frameworks).some(fw => ['Express', 'NestJS', 'Django', 'Flask', 'FastAPI'].includes(fw));
        if (hasWebFramework && hasBackendFramework)
            return 'fullstack';
        if (hasWebFramework)
            return 'frontend';
        if (hasBackendFramework)
            return 'backend';
        return 'unknown';
    }
    async getCandidateAnalyzers(projectAnalysis, context) {
        const candidates = [];
        const plugins = plugin_registry_1.pluginRegistry.getPlugins();
        for (const plugin of plugins) {
            if (context.constraints?.excludeAnalyzers?.includes(plugin.id)) {
                continue;
            }
            if (context.constraints?.requireOfficial && plugin.type !== 'official') {
                continue;
            }
            const compatibility = this.calculateCompatibilityScore(plugin, projectAnalysis, context);
            if (compatibility.score > 0) {
                candidates.push({
                    plugin,
                    compatibility,
                    priority: plugin.priority + compatibility.score * 10
                });
            }
        }
        candidates.sort((a, b) => b.priority - a.priority);
        return candidates.slice(0, 5);
    }
    calculateCompatibilityScore(plugin, projectAnalysis, context) {
        let score = 0;
        const reasons = [];
        const penalties = [];
        const projectLanguages = Array.from(projectAnalysis.languages.keys());
        const supportedLanguages = plugin.supportedLanguages;
        const languageMatch = projectLanguages.some(lang => supportedLanguages.includes(lang));
        if (languageMatch) {
            score += 40;
            reasons.push('Language compatibility');
        }
        else if (supportedLanguages.includes('any') || plugin.category === 'specialized') {
            score += 20;
            reasons.push('Universal analyzer');
        }
        const projectFrameworks = Array.from(projectAnalysis.frameworks);
        const supportedFrameworks = plugin.supportedFrameworks;
        const frameworkMatch = projectFrameworks.some(fw => supportedFrameworks.includes(fw));
        if (frameworkMatch) {
            score += 30;
            reasons.push('Framework compatibility');
        }
        else if (supportedFrameworks.includes('any')) {
            score += 15;
            reasons.push('Generic framework support');
        }
        if (context.hint?.language && supportedLanguages.includes(context.hint.language)) {
            score += 20;
            reasons.push('Matches language hint');
        }
        if (context.hint?.framework && supportedFrameworks.includes(context.hint.framework)) {
            score += 20;
            reasons.push('Matches framework hint');
        }
        if (context.preferences?.preferredAnalyzers?.includes(plugin.id)) {
            score += 25;
            reasons.push('User preference');
        }
        if (context.preferences?.preferCommunity && plugin.type === 'community') {
            score += 10;
            reasons.push('Community preference');
        }
        if (plugin.metadata.verified) {
            score += 10;
            reasons.push('Verified plugin');
        }
        if (plugin.type === 'official') {
            score += 15;
            reasons.push('Official plugin');
        }
        if (!plugin.metadata.verified && plugin.type === 'community') {
            score -= 10;
            penalties.push('Unverified community plugin');
        }
        return {
            score: Math.max(0, score),
            reasons,
            penalties,
            languageMatch,
            frameworkMatch
        };
    }
    async selectBestAnalyzer(candidates, projectAnalysis, context) {
        if (candidates.length === 0) {
            throw new Error('No compatible analyzers found');
        }
        for (const candidate of candidates.slice(0, 3)) {
            try {
                const AnalyzerClass = candidate.plugin.analyzer;
                if (!AnalyzerClass || typeof AnalyzerClass !== 'function') {
                    continue;
                }
                const analyzer = new AnalyzerClass();
                analyzer['projectPath'] = context.repositoryPath;
                const detection = await analyzer['detectLanguageAndFramework']?.();
                if (detection && detection.confidence >= (context.constraints?.minConfidence || 0.3)) {
                    return {
                        analyzer,
                        plugin: candidate.plugin,
                        confidence: detection.confidence,
                        detectionTime: 0,
                        metadata: {
                            projectType: projectAnalysis.projectType,
                            primaryLanguage: Array.from(projectAnalysis.languages.keys())[0] || 'unknown',
                            frameworks: Array.from(projectAnalysis.frameworks),
                            complexityScore: this.calculateComplexityScore(projectAnalysis),
                            alternativeAnalyzers: candidates.slice(1, 4).map(c => c.plugin.name),
                            selectionReason: `Best match: ${candidate.compatibility.reasons.join(', ')}`
                        }
                    };
                }
            }
            catch (error) {
                console.warn(`⚠️ Analyzer ${candidate.plugin.name} failed detection: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        throw new Error('No analyzer successfully detected the project');
    }
    async createFallbackAnalyzer(context) {
        const systemTopologyPlugin = plugin_registry_1.pluginRegistry.getPlugin('system-topology');
        if (systemTopologyPlugin) {
            try {
                const AnalyzerClass = systemTopologyPlugin.analyzer;
                const analyzer = new AnalyzerClass();
                return {
                    analyzer,
                    plugin: systemTopologyPlugin,
                    confidence: 0.5,
                    detectionTime: 0,
                    metadata: {
                        projectType: 'unknown',
                        primaryLanguage: 'unknown',
                        frameworks: [],
                        complexityScore: 0,
                        alternativeAnalyzers: [],
                        selectionReason: 'Fallback to universal analyzer',
                        warnings: ['Using fallback analyzer - may have limited capabilities']
                    }
                };
            }
            catch (error) {
                console.error('❌ Fallback analyzer failed:', error instanceof Error ? error.message : String(error));
            }
        }
        return null;
    }
    calculateComplexityScore(analysis) {
        let score = 0;
        score += analysis.languages.size * 10;
        score += analysis.frameworks.size * 15;
        score += Math.min(analysis.directoryStructure.size * 2, 50);
        score += Math.min(analysis.configFiles.size * 5, 30);
        return Math.min(score, 100);
    }
    generateCacheKey(context) {
        const key = [
            context.repositoryPath,
            context.hint?.language || '',
            context.hint?.framework || '',
            context.constraints?.requireOfficial || false,
            context.preferences?.preferredAnalyzers?.join(',') || ''
        ].join('|');
        return Buffer.from(key).toString('base64');
    }
    updateStatistics(selection, detectionTime) {
        this.statistics.averageSelectionTime =
            (this.statistics.averageSelectionTime * (this.statistics.totalSelections - 1) + detectionTime) /
                this.statistics.totalSelections;
        this.statistics.averageConfidence =
            (this.statistics.averageConfidence * (this.statistics.totalSelections - 1) + selection.confidence) /
                this.statistics.totalSelections;
        this.statistics.successRate = this.statistics.totalSelections > 0 ?
            this.selectionHistory.length / this.statistics.totalSelections : 0;
        const existing = this.statistics.popularAnalyzers.find(p => p.name === selection.plugin.name);
        if (existing) {
            existing.usage++;
        }
        else {
            this.statistics.popularAnalyzers.push({ name: selection.plugin.name, usage: 1 });
        }
        this.statistics.popularAnalyzers.sort((a, b) => b.usage - a.usage);
        this.statistics.popularAnalyzers = this.statistics.popularAnalyzers.slice(0, 10);
    }
    getStatistics() {
        return { ...this.statistics };
    }
    clearCaches() {
        this.selectionCache.clear();
        plugin_registry_1.pluginRegistry.clearCaches();
        console.log('🧹 Cleared analyzer factory caches');
    }
    getSelectionHistory() {
        return [...this.selectionHistory];
    }
}
exports.EnhancedAnalyzerFactory = EnhancedAnalyzerFactory;
exports.analyzerFactory = new EnhancedAnalyzerFactory();
