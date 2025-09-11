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
exports.pluginRegistry = exports.PluginRegistry = void 0;
const telemetry_schema_1 = require("../telemetry/telemetry-schema");
const database_1 = require("../database");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class PluginRegistry {
    constructor(organizationId) {
        this.plugins = new Map();
        this.loadedAnalyzers = new Map();
        this.pluginDirectories = [];
        this.configurationCache = new Map();
        this.organizationId = organizationId;
        this.initializeDefaultPaths();
    }
    initializeDefaultPaths() {
        const defaultPaths = [
            path.join(__dirname, 'plugins'),
            path.join(process.cwd(), 'plugins'),
            path.join(process.cwd(), 'node_modules', '@unravl', 'analyzers'),
            path.join(require('os').homedir(), '.unravl', 'plugins'),
        ];
        this.pluginDirectories = defaultPaths.filter(dir => {
            try {
                return fs.existsSync(dir);
            }
            catch {
                return false;
            }
        });
    }
    async registerPlugin(plugin) {
        if (this.plugins.has(plugin.id)) {
            throw new Error(`Plugin ${plugin.id} is already registered`);
        }
        this.validatePlugin(plugin);
        this.plugins.set(plugin.id, plugin);
        if (this.organizationId) {
            await this.persistPluginMetadata(plugin);
        }
        telemetry_schema_1.telemetry.emit({
            type: 'plugin_registered',
            source: { analyzer: 'plugin-registry' },
            data: {
                pluginId: plugin.id,
                pluginName: plugin.name,
                version: plugin.version,
                type: plugin.type,
                organizationId: this.organizationId
            }
        });
        console.log(`✅ Registered plugin: ${plugin.name} v${plugin.version} (${plugin.type})`);
    }
    async discoverPlugins(options = {}) {
        const span = telemetry_schema_1.telemetry.createSpan('plugin-registry.discoverPlugins');
        const results = [];
        console.log('🔍 Discovering analyzer plugins...');
        telemetry_schema_1.telemetry.emit({
            type: 'plugin_discovery_started',
            source: { analyzer: 'plugin-registry' },
            data: {
                directoryCount: this.pluginDirectories.length,
                options
            }
        });
        for (const directory of this.pluginDirectories) {
            try {
                const dirResults = await this.discoverPluginsInDirectory(directory, options);
                results.push(...dirResults);
            }
            catch (error) {
                console.warn(`⚠️ Failed to scan plugin directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
                telemetry_schema_1.telemetry.emit({
                    type: 'error_occurred',
                    source: { analyzer: 'plugin-registry' },
                    data: {
                        error: error instanceof Error ? error.message : String(error),
                        directory
                    }
                });
            }
        }
        const validPlugins = results.filter(r => r.success && r.plugin);
        validPlugins.sort((a, b) => (b.plugin?.priority || 0) - (a.plugin?.priority || 0));
        if (this.organizationId) {
            await this.syncDiscoveredPluginsToDatabase(validPlugins.map(r => r.plugin));
        }
        telemetry_schema_1.telemetry.emit({
            type: 'plugin_discovery_completed',
            source: { analyzer: 'plugin-registry' },
            data: {
                totalPlugins: validPlugins.length,
                byType: this.groupPluginsByType(validPlugins.map(r => r.plugin))
            }
        });
        console.log(`📦 Discovered ${validPlugins.length} plugins from ${this.pluginDirectories.length} directories`);
        span.end();
        return results;
    }
    async discoverPluginsInDirectory(directory, options) {
        const results = [];
        if (!await fs.pathExists(directory)) {
            return results;
        }
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const pluginPath = path.join(directory, entry.name);
                const manifestPath = path.join(pluginPath, 'plugin.json');
                if (await fs.pathExists(manifestPath)) {
                    const result = await this.loadPluginFromManifest(pluginPath, manifestPath, options);
                    results.push(result);
                }
            }
            else if (entry.name.endsWith('.analyzer.js') || entry.name.endsWith('.analyzer.ts')) {
                const pluginPath = path.join(directory, entry.name);
                const result = await this.loadPluginFromFile(pluginPath, options);
                results.push(result);
            }
        }
        return results;
    }
    async loadPluginFromManifest(pluginPath, manifestPath, options) {
        try {
            const manifestContent = await fs.readJson(manifestPath);
            const manifest = this.parsePluginManifest(manifestContent);
            if (!this.matchesDiscoveryOptions(manifest, options)) {
                return {
                    success: false,
                    error: 'Plugin filtered out by discovery options'
                };
            }
            const analyzerPath = path.join(pluginPath, manifest.entry || 'index.js');
            const analyzerModule = await this.loadAnalyzerModule(analyzerPath);
            const plugin = {
                ...manifest,
                analyzer: analyzerModule.default || analyzerModule.analyzer || analyzerModule
            };
            this.validatePlugin(plugin);
            this.plugins.set(plugin.id, plugin);
            return {
                success: true,
                plugin,
                warnings: manifest.deprecated ? [`Plugin ${plugin.name} is deprecated`] : undefined
            };
        }
        catch (error) {
            return {
                success: false,
                error: `Failed to load plugin from ${pluginPath}: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    async loadPluginFromFile(filePath, options) {
        try {
            const analyzerModule = await this.loadAnalyzerModule(filePath);
            const AnalyzerClass = analyzerModule.default || analyzerModule;
            if (!AnalyzerClass || typeof AnalyzerClass !== 'function') {
                throw new Error('Invalid analyzer export');
            }
            const instance = new AnalyzerClass();
            const plugin = {
                id: path.basename(filePath, path.extname(filePath)),
                name: instance.getAnalyzerName?.() || path.basename(filePath),
                version: '1.0.0',
                description: `Analyzer for ${instance.getSupportedLanguages?.()[0] || 'unknown'}`,
                author: 'Unknown',
                analyzer: AnalyzerClass,
                supportedLanguages: instance.getSupportedLanguages?.() || [],
                supportedFrameworks: instance.getSupportedFrameworks?.() || [],
                type: 'internal',
                category: 'language',
                priority: 50,
                metadata: {
                    minEngineVersion: '1.0.0',
                    license: 'MIT',
                    keywords: [],
                    maintainers: [],
                    lastUpdated: new Date(),
                    verified: false
                },
                dependencies: []
            };
            if (this.matchesDiscoveryOptions(plugin, options)) {
                this.plugins.set(plugin.id, plugin);
                return { success: true, plugin };
            }
            else {
                return {
                    success: false,
                    error: 'Plugin filtered out by discovery options'
                };
            }
        }
        catch (error) {
            return {
                success: false,
                error: `Failed to load analyzer from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    async loadAnalyzerModule(modulePath) {
        try {
            delete require.cache[require.resolve(modulePath)];
            const module = require(modulePath);
            return module;
        }
        catch (error) {
            throw new Error(`Failed to require analyzer module: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    parsePluginManifest(manifest) {
        const required = ['id', 'name', 'version', 'entry'];
        for (const field of required) {
            if (!manifest[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }
        return {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description || '',
            author: manifest.author || 'Unknown',
            analyzer: null,
            supportedLanguages: manifest.supportedLanguages || [],
            supportedFrameworks: manifest.supportedFrameworks || [],
            type: manifest.type || 'community',
            category: manifest.category || 'language',
            priority: manifest.priority || 50,
            metadata: {
                minEngineVersion: manifest.minEngineVersion || '1.0.0',
                maxEngineVersion: manifest.maxEngineVersion,
                homepage: manifest.homepage,
                repository: manifest.repository,
                documentation: manifest.documentation,
                license: manifest.license || 'MIT',
                keywords: manifest.keywords || [],
                maintainers: manifest.maintainers || [],
                lastUpdated: new Date(manifest.lastUpdated || Date.now()),
                verified: manifest.verified || false,
                ...manifest.metadata
            },
            dependencies: manifest.dependencies || [],
            configuration: manifest.configuration
        };
    }
    matchesDiscoveryOptions(plugin, options) {
        if (options.includeOfficial === false && plugin.type === 'official')
            return false;
        if (options.includeCommunity === false && plugin.type === 'community')
            return false;
        if (options.includeInternal === false && plugin.type === 'internal')
            return false;
        if (options.categories && !options.categories.includes(plugin.category))
            return false;
        return true;
    }
    validatePlugin(plugin) {
        if (!plugin.id || !plugin.name || !plugin.version) {
            throw new Error('Plugin missing required fields: id, name, version');
        }
        if (!plugin.analyzer || typeof plugin.analyzer !== 'function') {
            throw new Error('Plugin analyzer must be a constructor function');
        }
        const currentVersion = '1.0.0';
        if (!this.isVersionCompatible(currentVersion, plugin.metadata.minEngineVersion, plugin.metadata.maxEngineVersion)) {
            throw new Error(`Plugin ${plugin.id} requires engine version ${plugin.metadata.minEngineVersion}${plugin.metadata.maxEngineVersion ? `-${plugin.metadata.maxEngineVersion}` : '+'}, current: ${currentVersion}`);
        }
    }
    isVersionCompatible(current, min, max) {
        const parseVersion = (v) => v.split('.').map(Number);
        const currentParts = parseVersion(current);
        const minParts = parseVersion(min);
        for (let i = 0; i < 3; i++) {
            if (currentParts[i] > minParts[i])
                return true;
            if (currentParts[i] < minParts[i])
                return false;
        }
        if (max) {
            const maxParts = parseVersion(max);
            for (let i = 0; i < 3; i++) {
                if (currentParts[i] < maxParts[i])
                    return true;
                if (currentParts[i] > maxParts[i])
                    return false;
            }
        }
        return true;
    }
    async getAnalyzerForProject(repositoryPath) {
        const span = telemetry_schema_1.telemetry.createSpan('plugin-registry.getAnalyzerForProject');
        const plugins = Array.from(this.plugins.values());
        plugins.sort((a, b) => b.priority - a.priority);
        for (const plugin of plugins) {
            try {
                const AnalyzerClass = plugin.analyzer;
                const analyzer = new AnalyzerClass();
                const cacheKey = `${plugin.id}:${repositoryPath}`;
                if (this.loadedAnalyzers.has(cacheKey)) {
                    telemetry_schema_1.telemetry.emit({
                        type: 'analyzer_selected_from_cache',
                        source: { analyzer: 'plugin-registry' },
                        data: {
                            pluginId: plugin.id,
                            pluginName: plugin.name,
                            repositoryPath
                        }
                    });
                    span.end();
                    return this.loadedAnalyzers.get(cacheKey);
                }
                analyzer['projectPath'] = repositoryPath;
                const detection = await analyzer['detectLanguageAndFramework']?.();
                if (detection && detection.confidence > 0.3) {
                    this.loadedAnalyzers.set(cacheKey, analyzer);
                    telemetry_schema_1.telemetry.emit({
                        type: 'analyzer_selected',
                        source: { analyzer: 'plugin-registry' },
                        data: {
                            pluginId: plugin.id,
                            pluginName: plugin.name,
                            confidence: detection.confidence,
                            language: detection.language,
                            frameworks: detection.frameworks,
                            repositoryPath
                        }
                    });
                    console.log(`🎯 Selected ${plugin.name} analyzer (confidence: ${(detection.confidence * 100).toFixed(0)}%)`);
                    span.end();
                    return analyzer;
                }
            }
            catch (error) {
                console.warn(`⚠️ Plugin ${plugin.name} failed project detection: ${error instanceof Error ? error.message : String(error)}`);
                telemetry_schema_1.telemetry.emit({
                    type: 'analyzer_selection_failed',
                    source: { analyzer: 'plugin-registry' },
                    data: {
                        pluginId: plugin.id,
                        pluginName: plugin.name,
                        error: error instanceof Error ? error.message : String(error),
                        repositoryPath
                    }
                });
            }
        }
        span.end();
        return null;
    }
    getPlugins(category) {
        const plugins = Array.from(this.plugins.values());
        if (category) {
            return plugins.filter(p => p.category === category);
        }
        return plugins.sort((a, b) => b.priority - a.priority);
    }
    getPlugin(id) {
        return this.plugins.get(id);
    }
    getPluginConfiguration(pluginId) {
        const plugin = this.plugins.get(pluginId);
        if (!plugin)
            return null;
        const cacheKey = `config:${pluginId}`;
        if (this.configurationCache.has(cacheKey)) {
            return this.configurationCache.get(cacheKey);
        }
        const config = {
            ...plugin.configuration?.defaults,
        };
        this.configurationCache.set(cacheKey, config);
        return config;
    }
    unregisterPlugin(id) {
        const success = this.plugins.delete(id);
        for (const [key, analyzer] of this.loadedAnalyzers) {
            if (key.startsWith(`${id}:`)) {
                this.loadedAnalyzers.delete(key);
            }
        }
        this.configurationCache.delete(`config:${id}`);
        if (success) {
            console.log(`🗑️ Unregistered plugin: ${id}`);
        }
        return success;
    }
    getStatistics() {
        const plugins = Array.from(this.plugins.values());
        return {
            totalPlugins: plugins.length,
            officialPlugins: plugins.filter(p => p.type === 'official').length,
            communityPlugins: plugins.filter(p => p.type === 'community').length,
            internalPlugins: plugins.filter(p => p.type === 'internal').length,
            languageAnalyzers: plugins.filter(p => p.category === 'language').length,
            frameworkAnalyzers: plugins.filter(p => p.category === 'framework').length,
            specializedAnalyzers: plugins.filter(p => p.category === 'specialized').length,
            supportedLanguages: [...new Set(plugins.flatMap(p => p.supportedLanguages))],
            supportedFrameworks: [...new Set(plugins.flatMap(p => p.supportedFrameworks))],
            loadedAnalyzers: this.loadedAnalyzers.size,
            discoveryPaths: this.pluginDirectories
        };
    }
    clearCaches() {
        this.loadedAnalyzers.clear();
        this.configurationCache.clear();
        telemetry_schema_1.telemetry.emit({
            type: 'plugin_cache_cleared',
            source: { analyzer: 'plugin-registry' },
            data: {
                organizationId: this.organizationId
            }
        });
        console.log('🧹 Cleared plugin registry caches');
    }
    async persistPluginMetadata(plugin) {
        if (!this.organizationId)
            return;
        try {
            const client = await database_1.db.getClient();
            const query = `
        INSERT INTO analyzer_plugins (
          organization_id, plugin_id, name, version, author, type, category,
          priority, supported_languages, supported_frameworks, metadata,
          dependencies, configuration, last_used_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (organization_id, plugin_id) 
        DO UPDATE SET
          name = EXCLUDED.name,
          version = EXCLUDED.version,
          author = EXCLUDED.author,
          type = EXCLUDED.type,
          category = EXCLUDED.category,
          priority = EXCLUDED.priority,
          supported_languages = EXCLUDED.supported_languages,
          supported_frameworks = EXCLUDED.supported_frameworks,
          metadata = EXCLUDED.metadata,
          dependencies = EXCLUDED.dependencies,
          configuration = EXCLUDED.configuration,
          updated_at = NOW()
      `;
            const values = [
                this.organizationId,
                plugin.id,
                plugin.name,
                plugin.version,
                plugin.author,
                plugin.type,
                plugin.category,
                plugin.priority,
                JSON.stringify(plugin.supportedLanguages),
                JSON.stringify(plugin.supportedFrameworks),
                JSON.stringify(plugin.metadata),
                JSON.stringify(plugin.dependencies),
                JSON.stringify(plugin.configuration),
                new Date()
            ];
            await client.query(query, values);
        }
        catch (error) {
            console.warn(`Failed to persist plugin ${plugin.id} to database:`, error instanceof Error ? error.message : String(error));
        }
    }
    async syncDiscoveredPluginsToDatabase(plugins) {
        if (!this.organizationId)
            return;
        try {
            for (const plugin of plugins) {
                await this.persistPluginMetadata(plugin);
            }
        }
        catch (error) {
            console.warn('Failed to sync plugins to database:', error instanceof Error ? error.message : String(error));
        }
    }
    groupPluginsByType(plugins) {
        return plugins.reduce((groups, plugin) => {
            groups[plugin.type] = (groups[plugin.type] || 0) + 1;
            return groups;
        }, {});
    }
}
exports.PluginRegistry = PluginRegistry;
exports.pluginRegistry = new PluginRegistry();
