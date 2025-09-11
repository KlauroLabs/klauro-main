// Plugin Registry - Manages analyzer plugins and discovery
// Production-ready plugin system for community and official analyzers

import { BaseAnalyzer } from './base-analyzer';
import { telemetry } from '../telemetry/telemetry-schema';
import { dbConnection } from '../database';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface AnalyzerPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  analyzer: typeof BaseAnalyzer;
  supportedLanguages: string[];
  supportedFrameworks: string[];
  type: 'official' | 'community' | 'internal';
  category: 'language' | 'framework' | 'specialized' | 'integration';
  priority: number; // Higher number = higher priority for conflicts
  metadata: PluginMetadata;
  dependencies: PluginDependency[];
  configuration?: PluginConfiguration;
}

export interface PluginMetadata {
  minEngineVersion: string;
  maxEngineVersion?: string;
  homepage?: string;
  repository?: string;
  documentation?: string;
  license: string;
  keywords: string[];
  maintainers: string[];
  lastUpdated: Date;
  downloadCount?: number;
  rating?: number;
  verified: boolean;
  securityScan?: SecurityScanResult;
}

export interface PluginDependency {
  name: string;
  version: string;
  type: 'required' | 'optional' | 'peer';
  description?: string;
}

export interface PluginConfiguration {
  schema: any; // JSON Schema for configuration validation
  defaults: Record<string, any>;
  required: string[];
}

export interface SecurityScanResult {
  scannedAt: Date;
  tool: string;
  version: string;
  vulnerabilities: SecurityVulnerability[];
  riskScore: number;
  approved: boolean;
}

export interface SecurityVulnerability {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  cve?: string;
  fixedInVersion?: string;
}

export interface PluginLoadResult {
  success: boolean;
  plugin?: AnalyzerPlugin;
  error?: string;
  warnings?: string[];
}

export interface PluginDiscoveryOptions {
  includeOfficial?: boolean;
  includeCommunity?: boolean;
  includeInternal?: boolean;
  categories?: string[];
  maxResults?: number;
  sortBy?: 'priority' | 'popularity' | 'rating' | 'updated';
}

export class PluginRegistry {
  private plugins = new Map<string, AnalyzerPlugin>();
  private loadedAnalyzers = new Map<string, BaseAnalyzer>();
  private pluginDirectories: string[] = [];
  private configurationCache = new Map<string, any>();
  private organizationId?: string;

  constructor(organizationId?: string) {
    this.organizationId = organizationId;
    this.initializeDefaultPaths();
  }

  /**
   * Initialize default plugin discovery paths
   */
  private initializeDefaultPaths(): void {
    const defaultPaths = [
      path.join(__dirname, 'plugins'), // Built-in plugins
      path.join(process.cwd(), 'plugins'), // Project plugins
      path.join(process.cwd(), 'node_modules', '@unravl', 'analyzers'), // NPM plugins
      path.join(require.os?.homedir?.() || '', '.unravl', 'plugins'), // User plugins
    ];

    this.pluginDirectories = defaultPaths.filter(dir => {
      try {
        return fs.existsSync(dir);
      } catch {
        return false;
      }
    });
  }

  /**
   * Register a plugin programmatically
   */
  async registerPlugin(plugin: AnalyzerPlugin): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin ${plugin.id} is already registered`);
    }

    // Validate plugin
    this.validatePlugin(plugin);

    this.plugins.set(plugin.id, plugin);
    
    // Persist to database if organization context available
    if (this.organizationId) {
      await this.persistPluginMetadata(plugin);
    }
    
    telemetry.emit({
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

  /**
   * Discover and load plugins from configured directories
   */
  async discoverPlugins(options: PluginDiscoveryOptions = {}): Promise<PluginLoadResult[]> {
    const span = telemetry.createSpan('plugin-registry.discoverPlugins');
    const results: PluginLoadResult[] = [];
    
    console.log('🔍 Discovering analyzer plugins...');
    
    telemetry.emit({
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
      } catch (error) {
        console.warn(`⚠️ Failed to scan plugin directory ${directory}: ${error.message}`);
        
        telemetry.emit({
          type: 'error_occurred',
          source: { analyzer: 'plugin-registry' },
          data: {
            error: error instanceof Error ? error.message : String(error),
            directory
          }
        });
      }
    }

    // Sort by priority
    const validPlugins = results.filter(r => r.success && r.plugin);
    validPlugins.sort((a, b) => (b.plugin?.priority || 0) - (a.plugin?.priority || 0));
    
    // Sync discovered plugins to database
    if (this.organizationId) {
      await this.syncDiscoveredPluginsToDatabase(validPlugins.map(r => r.plugin!));
    }
    
    telemetry.emit({
      type: 'plugin_discovery_completed',
      source: { analyzer: 'plugin-registry' },
      data: {
        totalPlugins: validPlugins.length,
        byType: this.groupPluginsByType(validPlugins.map(r => r.plugin!))
      }
    });

    console.log(`📦 Discovered ${validPlugins.length} plugins from ${this.pluginDirectories.length} directories`);
    span.end();
    return results;
  }

  /**
   * Discover plugins in a specific directory
   */
  private async discoverPluginsInDirectory(
    directory: string, 
    options: PluginDiscoveryOptions
  ): Promise<PluginLoadResult[]> {
    const results: PluginLoadResult[] = [];
    
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
      } else if (entry.name.endsWith('.analyzer.js') || entry.name.endsWith('.analyzer.ts')) {
        // Single-file plugin
        const pluginPath = path.join(directory, entry.name);
        const result = await this.loadPluginFromFile(pluginPath, options);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Load plugin from manifest file
   */
  private async loadPluginFromManifest(
    pluginPath: string,
    manifestPath: string,
    options: PluginDiscoveryOptions
  ): Promise<PluginLoadResult> {
    try {
      const manifestContent = await fs.readJson(manifestPath);
      const manifest = this.parsePluginManifest(manifestContent);

      // Check if plugin matches discovery options
      if (!this.matchesDiscoveryOptions(manifest, options)) {
        return {
          success: false,
          error: 'Plugin filtered out by discovery options'
        };
      }

      // Load the analyzer class
      const analyzerPath = path.join(pluginPath, manifest.entry || 'index.js');
      const analyzerModule = await this.loadAnalyzerModule(analyzerPath);

      const plugin: AnalyzerPlugin = {
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

    } catch (error) {
      return {
        success: false,
        error: `Failed to load plugin from ${pluginPath}: ${error.message}`
      };
    }
  }

  /**
   * Load plugin from single file
   */
  private async loadPluginFromFile(
    filePath: string,
    options: PluginDiscoveryOptions
  ): Promise<PluginLoadResult> {
    try {
      const analyzerModule = await this.loadAnalyzerModule(filePath);
      const AnalyzerClass = analyzerModule.default || analyzerModule;
      
      if (!AnalyzerClass || typeof AnalyzerClass !== 'function') {
        throw new Error('Invalid analyzer export');
      }

      // Create temporary instance to get metadata
      const instance = new AnalyzerClass();
      
      const plugin: AnalyzerPlugin = {
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
      } else {
        return {
          success: false,
          error: 'Plugin filtered out by discovery options'
        };
      }

    } catch (error) {
      return {
        success: false,
        error: `Failed to load analyzer from ${filePath}: ${error.message}`
      };
    }
  }

  /**
   * Dynamically load analyzer module
   */
  private async loadAnalyzerModule(modulePath: string): Promise<any> {
    try {
      // Clear require cache for dynamic reloading
      delete require.cache[require.resolve(modulePath)];
      
      const module = require(modulePath);
      return module;
    } catch (error) {
      throw new Error(`Failed to require analyzer module: ${error.message}`);
    }
  }

  /**
   * Parse and validate plugin manifest
   */
  private parsePluginManifest(manifest: any): AnalyzerPlugin {
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
      analyzer: null as any, // Will be loaded separately
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

  /**
   * Check if plugin matches discovery options
   */
  private matchesDiscoveryOptions(plugin: AnalyzerPlugin, options: PluginDiscoveryOptions): boolean {
    // Type filtering
    if (options.includeOfficial === false && plugin.type === 'official') return false;
    if (options.includeCommunity === false && plugin.type === 'community') return false;
    if (options.includeInternal === false && plugin.type === 'internal') return false;

    // Category filtering
    if (options.categories && !options.categories.includes(plugin.category)) return false;

    return true;
  }

  /**
   * Validate plugin structure and compatibility
   */
  private validatePlugin(plugin: AnalyzerPlugin): void {
    if (!plugin.id || !plugin.name || !plugin.version) {
      throw new Error('Plugin missing required fields: id, name, version');
    }

    if (!plugin.analyzer || typeof plugin.analyzer !== 'function') {
      throw new Error('Plugin analyzer must be a constructor function');
    }

    // Check engine compatibility
    const currentVersion = '1.0.0'; // Would come from package.json
    if (!this.isVersionCompatible(currentVersion, plugin.metadata.minEngineVersion, plugin.metadata.maxEngineVersion)) {
      throw new Error(`Plugin ${plugin.id} requires engine version ${plugin.metadata.minEngineVersion}${plugin.metadata.maxEngineVersion ? `-${plugin.metadata.maxEngineVersion}` : '+'}, current: ${currentVersion}`);
    }
  }

  /**
   * Check version compatibility
   */
  private isVersionCompatible(current: string, min: string, max?: string): boolean {
    // Simplified version comparison - would use semver in production
    const parseVersion = (v: string) => v.split('.').map(Number);
    const currentParts = parseVersion(current);
    const minParts = parseVersion(min);
    
    // Check minimum version
    for (let i = 0; i < 3; i++) {
      if (currentParts[i] > minParts[i]) return true;
      if (currentParts[i] < minParts[i]) return false;
    }

    // Check maximum version if specified
    if (max) {
      const maxParts = parseVersion(max);
      for (let i = 0; i < 3; i++) {
        if (currentParts[i] < maxParts[i]) return true;
        if (currentParts[i] > maxParts[i]) return false;
      }
    }

    return true;
  }

  /**
   * Get analyzer instance for a project
   */
  async getAnalyzerForProject(repositoryPath: string): Promise<BaseAnalyzer | null> {
    const span = telemetry.createSpan('plugin-registry.getAnalyzerForProject', {
      repositoryPath
    });
    
    const plugins = Array.from(this.plugins.values());
    
    // Sort by priority (higher first)
    plugins.sort((a, b) => b.priority - a.priority);

    for (const plugin of plugins) {
      try {
        const analyzer = new plugin.analyzer();
        
        // Test if this analyzer can handle the project
        const cacheKey = `${plugin.id}:${repositoryPath}`;
        if (this.loadedAnalyzers.has(cacheKey)) {
          telemetry.emit({
            type: 'analyzer_selected_from_cache',
            source: { analyzer: 'plugin-registry' },
            data: {
              pluginId: plugin.id,
              pluginName: plugin.name,
              repositoryPath
            }
          });
          
          span.end();
          return this.loadedAnalyzers.get(cacheKey)!;
        }

        // Quick capability check
        analyzer['projectPath'] = repositoryPath;
        const detection = await analyzer['detectLanguageAndFramework']?.();
        
        if (detection && detection.confidence > 0.3) {
          this.loadedAnalyzers.set(cacheKey, analyzer);
          
          telemetry.emit({
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
      } catch (error) {
        console.warn(`⚠️ Plugin ${plugin.name} failed project detection: ${error.message}`);
        
        telemetry.emit({
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

  /**
   * Get all registered plugins
   */
  getPlugins(category?: string): AnalyzerPlugin[] {
    const plugins = Array.from(this.plugins.values());
    
    if (category) {
      return plugins.filter(p => p.category === category);
    }
    
    return plugins.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get plugin by ID
   */
  getPlugin(id: string): AnalyzerPlugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * Get plugin configuration
   */
  getPluginConfiguration(pluginId: string): any {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return null;

    const cacheKey = `config:${pluginId}`;
    if (this.configurationCache.has(cacheKey)) {
      return this.configurationCache.get(cacheKey);
    }

    const config = {
      ...plugin.configuration?.defaults,
      // Would merge with user configuration from files/environment
    };

    this.configurationCache.set(cacheKey, config);
    return config;
  }

  /**
   * Unregister a plugin
   */
  unregisterPlugin(id: string): boolean {
    const success = this.plugins.delete(id);
    
    // Clear cached analyzers
    for (const [key, analyzer] of this.loadedAnalyzers) {
      if (key.startsWith(`${id}:`)) {
        this.loadedAnalyzers.delete(key);
      }
    }
    
    // Clear configuration cache
    this.configurationCache.delete(`config:${id}`);
    
    if (success) {
      console.log(`🗑️ Unregistered plugin: ${id}`);
    }
    
    return success;
  }

  /**
   * Get registry statistics
   */
  getStatistics(): RegistryStatistics {
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

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.loadedAnalyzers.clear();
    this.configurationCache.clear();
    
    telemetry.emit({
      type: 'plugin_cache_cleared',
      source: { analyzer: 'plugin-registry' },
      data: {
        organizationId: this.organizationId
      }
    });
    
    console.log('🧹 Cleared plugin registry caches');
  }
  
  /**
   * Persist plugin metadata to database
   */
  private async persistPluginMetadata(plugin: AnalyzerPlugin): Promise<void> {
    if (!this.organizationId) return;
    
    try {
      const client = await dbConnection.getClient();
      
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
    } catch (error) {
      console.warn(`Failed to persist plugin ${plugin.id} to database:`, error.message);
    }
  }
  
  /**
   * Sync discovered plugins to database
   */
  private async syncDiscoveredPluginsToDatabase(plugins: AnalyzerPlugin[]): Promise<void> {
    if (!this.organizationId) return;
    
    try {
      for (const plugin of plugins) {
        await this.persistPluginMetadata(plugin);
      }
    } catch (error) {
      console.warn('Failed to sync plugins to database:', error.message);
    }
  }
  
  /**
   * Group plugins by type for statistics
   */
  private groupPluginsByType(plugins: AnalyzerPlugin[]): Record<string, number> {
    return plugins.reduce((groups, plugin) => {
      groups[plugin.type] = (groups[plugin.type] || 0) + 1;
      return groups;
    }, {} as Record<string, number>);
  }
}

export interface RegistryStatistics {
  totalPlugins: number;
  officialPlugins: number;
  communityPlugins: number;
  internalPlugins: number;
  languageAnalyzers: number;
  frameworkAnalyzers: number;
  specializedAnalyzers: number;
  supportedLanguages: string[];
  supportedFrameworks: string[];
  loadedAnalyzers: number;
  discoveryPaths: string[];
}

// Global registry instance
export const pluginRegistry = new PluginRegistry();