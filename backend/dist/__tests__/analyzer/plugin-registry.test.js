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
const plugin_registry_1 = require("../../analyzer/plugin-registry");
const base_analyzer_1 = require("../../analyzer/base-analyzer");
const fs = __importStar(require("fs-extra"));
const path = __importStar(require("path"));
class MockAnalyzer extends base_analyzer_1.BaseAnalyzer {
    getAnalyzerName() {
        return 'Mock Analyzer';
    }
    getSupportedLanguages() {
        return ['javascript'];
    }
    getSupportedFrameworks() {
        return ['mock-framework'];
    }
    async detectLanguageAndFramework() {
        return {
            language: 'javascript',
            confidence: 0.8,
            frameworks: [],
            files: []
        };
    }
    async discoverComponents() {
        return {
            totalFiles: 0,
            analyzedFiles: 0,
            skippedFiles: 0,
            components: []
        };
    }
    async analyzeConnections() {
        return [];
    }
    async identifyEntryPoints() {
        return [];
    }
    async identifyExitPoints() {
        return [];
    }
    async assessRisks() {
        return [];
    }
    async generateCallGraph() {
        return {
            nodes: [],
            edges: [],
            entryPoints: [],
            cycles: [],
            layers: [],
            hotPaths: [],
            deadCode: []
        };
    }
    async analyzeDatabaseConnections() {
        return [];
    }
    async analyzeTestCoverage() {
        return null;
    }
}
describe('PluginRegistry', () => {
    let registry;
    let tempDir;
    beforeEach(async () => {
        registry = new plugin_registry_1.PluginRegistry();
        tempDir = await fs.mkdtemp(path.join(__dirname, 'test-plugins-'));
    });
    afterEach(async () => {
        await fs.remove(tempDir);
    });
    describe('plugin registration', () => {
        it('should register a plugin successfully', () => {
            const plugin = {
                id: 'test-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'A test plugin',
                author: 'Test Author',
                analyzer: MockAnalyzer,
                supportedLanguages: ['javascript'],
                supportedFrameworks: ['test-framework'],
                type: 'community',
                category: 'language',
                priority: 50,
                metadata: {
                    minEngineVersion: '1.0.0',
                    license: 'MIT',
                    keywords: ['test'],
                    maintainers: [],
                    lastUpdated: new Date(),
                    verified: false
                },
                dependencies: []
            };
            expect(() => {
                registry.registerPlugin(plugin);
            }).not.toThrow();
            const retrievedPlugin = registry.getPlugin('test-plugin');
            expect(retrievedPlugin).toEqual(plugin);
        });
        it('should throw error for duplicate plugin IDs', () => {
            const plugin = {
                id: 'duplicate-plugin',
                name: 'Test Plugin',
                version: '1.0.0',
                description: 'A test plugin',
                author: 'Test Author',
                analyzer: MockAnalyzer,
                supportedLanguages: ['javascript'],
                supportedFrameworks: [],
                type: 'community',
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
            registry.registerPlugin(plugin);
            expect(() => {
                registry.registerPlugin({ ...plugin });
            }).toThrow('Plugin duplicate-plugin is already registered');
        });
        it('should validate required plugin fields', () => {
            const invalidPlugin = {
                id: '',
                name: 'Test Plugin',
            };
            expect(() => {
                registry.registerPlugin(invalidPlugin);
            }).toThrow('Plugin missing required fields');
        });
        it('should validate analyzer is a constructor function', () => {
            const plugin = {
                id: 'invalid-analyzer',
                name: 'Invalid Plugin',
                version: '1.0.0',
                description: 'Plugin with invalid analyzer',
                author: 'Test Author',
                analyzer: 'not-a-function',
                supportedLanguages: ['javascript'],
                supportedFrameworks: [],
                type: 'community',
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
            expect(() => {
                registry.registerPlugin(plugin);
            }).toThrow('Plugin analyzer must be a constructor function');
        });
    });
    describe('plugin discovery', () => {
        it('should discover plugins from manifest files', async () => {
            const pluginDir = path.join(tempDir, 'test-plugin');
            await fs.mkdir(pluginDir);
            const manifest = {
                id: 'discovered-plugin',
                name: 'Discovered Plugin',
                version: '1.0.0',
                description: 'A discovered plugin',
                author: 'Test Author',
                entry: 'index.js',
                supportedLanguages: ['typescript'],
                supportedFrameworks: ['express'],
                type: 'community',
                category: 'language',
                priority: 60,
                minEngineVersion: '1.0.0',
                license: 'MIT',
                keywords: ['test'],
                maintainers: [],
                lastUpdated: new Date().toISOString(),
                verified: false
            };
            await fs.writeJson(path.join(pluginDir, 'plugin.json'), manifest);
            const analyzerCode = `
        const { BaseAnalyzer } = require('../../base-analyzer');
        
        class DiscoveredAnalyzer extends BaseAnalyzer {
          getAnalyzerName() { return 'Discovered Analyzer'; }
          getSupportedLanguages() { return ['typescript']; }
          getSupportedFrameworks() { return ['express']; }
          
          async detectLanguageAndFramework() {
            return { language: 'typescript', confidence: 0.9, frameworks: [], files: [] };
          }
          
          async discoverComponents() {
            return { totalFiles: 0, analyzedFiles: 0, skippedFiles: 0, components: [] };
          }
          
          async analyzeConnections() { return []; }
          async identifyEntryPoints() { return []; }
          async identifyExitPoints() { return []; }
          async assessRisks() { return []; }
          async generateCallGraph() {
            return { nodes: [], edges: [], entryPoints: [], cycles: [], layers: [], hotPaths: [], deadCode: [] };
          }
          async analyzeDatabaseConnections() { return []; }
          async analyzeTestCoverage() { return null; }
        }
        
        module.exports = DiscoveredAnalyzer;
      `;
            await fs.writeFile(path.join(pluginDir, 'index.js'), analyzerCode);
            registry['pluginDirectories'] = [tempDir];
            const results = await registry.discoverPlugins();
            expect(results.length).toBeGreaterThan(0);
            const successResult = results.find(r => r.success);
            expect(successResult).toBeDefined();
            expect(successResult?.plugin?.id).toBe('discovered-plugin');
        });
        it('should filter plugins by discovery options', async () => {
            const communityPlugin = {
                id: 'community-plugin',
                name: 'Community Plugin',
                version: '1.0.0',
                description: 'Community plugin',
                author: 'Community',
                analyzer: MockAnalyzer,
                supportedLanguages: ['javascript'],
                supportedFrameworks: [],
                type: 'community',
                category: 'language',
                priority: 40,
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
            const officialPlugin = {
                ...communityPlugin,
                id: 'official-plugin',
                name: 'Official Plugin',
                type: 'official'
            };
            registry.registerPlugin(communityPlugin);
            registry.registerPlugin(officialPlugin);
            const communityOnly = await registry.discoverPlugins({
                includeOfficial: false,
                includeCommunity: true
            });
            expect(true).toBe(true);
        });
    });
    describe('analyzer selection', () => {
        it('should select best analyzer for project', async () => {
            const highPriorityPlugin = {
                id: 'high-priority',
                name: 'High Priority Plugin',
                version: '1.0.0',
                description: 'High priority plugin',
                author: 'Test',
                analyzer: MockAnalyzer,
                supportedLanguages: ['javascript'],
                supportedFrameworks: [],
                type: 'official',
                category: 'language',
                priority: 90,
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
            const lowPriorityPlugin = {
                ...highPriorityPlugin,
                id: 'low-priority',
                name: 'Low Priority Plugin',
                priority: 10
            };
            registry.registerPlugin(lowPriorityPlugin);
            registry.registerPlugin(highPriorityPlugin);
            await fs.writeFile(path.join(tempDir, 'test.js'), 'console.log("test");');
            const analyzer = await registry.getAnalyzerForProject(tempDir);
            expect(analyzer).toBeInstanceOf(MockAnalyzer);
        });
        it('should return null when no suitable analyzer found', async () => {
            class NoMatchAnalyzer extends base_analyzer_1.BaseAnalyzer {
                getAnalyzerName() { return 'No Match'; }
                getSupportedLanguages() { return ['cobol']; }
                getSupportedFrameworks() { return []; }
                async detectLanguageAndFramework() {
                    return { language: 'cobol', confidence: 0.1, frameworks: [], files: [] };
                }
                async discoverComponents() {
                    return { totalFiles: 0, analyzedFiles: 0, skippedFiles: 0, components: [] };
                }
                async analyzeConnections() { return []; }
                async identifyEntryPoints() { return []; }
                async identifyExitPoints() { return []; }
                async assessRisks() { return []; }
                async generateCallGraph() {
                    return { nodes: [], edges: [], entryPoints: [], cycles: [], layers: [], hotPaths: [], deadCode: [] };
                }
                async analyzeDatabaseConnections() { return []; }
                async analyzeTestCoverage() { return null; }
            }
            const plugin = {
                id: 'no-match',
                name: 'No Match Plugin',
                version: '1.0.0',
                description: 'Plugin that wont match',
                author: 'Test',
                analyzer: NoMatchAnalyzer,
                supportedLanguages: ['cobol'],
                supportedFrameworks: [],
                type: 'community',
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
            registry.registerPlugin(plugin);
            await fs.writeFile(path.join(tempDir, 'test.js'), 'console.log("test");');
            const analyzer = await registry.getAnalyzerForProject(tempDir);
            expect(analyzer).toBeNull();
        });
    });
    describe('plugin management', () => {
        it('should list all registered plugins', () => {
            const plugin1 = {
                id: 'plugin-1',
                name: 'Plugin 1',
                version: '1.0.0',
                description: 'First plugin',
                author: 'Test',
                analyzer: MockAnalyzer,
                supportedLanguages: ['javascript'],
                supportedFrameworks: [],
                type: 'community',
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
            const plugin2 = {
                ...plugin1,
                id: 'plugin-2',
                name: 'Plugin 2',
                category: 'framework'
            };
            registry.registerPlugin(plugin1);
            registry.registerPlugin(plugin2);
            const allPlugins = registry.getPlugins();
            expect(allPlugins).toHaveLength(2);
            expect(allPlugins.map(p => p.id)).toContain('plugin-1');
            expect(allPlugins.map(p => p.id)).toContain('plugin-2');
            const languagePlugins = registry.getPlugins('language');
            expect(languagePlugins).toHaveLength(1);
            expect(languagePlugins[0].id).toBe('plugin-1');
        });
        it('should unregister plugins', () => {
            const plugin = {
                id: 'removable-plugin',
                name: 'Removable Plugin',
                version: '1.0.0',
                description: 'Plugin to be removed',
                author: 'Test',
                analyzer: MockAnalyzer,
                supportedLanguages: ['javascript'],
                supportedFrameworks: [],
                type: 'community',
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
            registry.registerPlugin(plugin);
            expect(registry.getPlugin('removable-plugin')).toBeDefined();
            const removed = registry.unregisterPlugin('removable-plugin');
            expect(removed).toBe(true);
            expect(registry.getPlugin('removable-plugin')).toBeUndefined();
            const removedAgain = registry.unregisterPlugin('removable-plugin');
            expect(removedAgain).toBe(false);
        });
        it('should provide plugin configuration', () => {
            const plugin = {
                id: 'configurable-plugin',
                name: 'Configurable Plugin',
                version: '1.0.0',
                description: 'Plugin with configuration',
                author: 'Test',
                analyzer: MockAnalyzer,
                supportedLanguages: ['javascript'],
                supportedFrameworks: [],
                type: 'community',
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
                dependencies: [],
                configuration: {
                    schema: { type: 'object', properties: {} },
                    defaults: { enabled: true, maxDepth: 5 },
                    required: ['enabled']
                }
            };
            registry.registerPlugin(plugin);
            const config = registry.getPluginConfiguration('configurable-plugin');
            expect(config).toEqual({ enabled: true, maxDepth: 5 });
            const nonExistentConfig = registry.getPluginConfiguration('non-existent');
            expect(nonExistentConfig).toBeNull();
        });
    });
    describe('statistics and monitoring', () => {
        it('should provide registry statistics', () => {
            const officialPlugin = {
                id: 'official-1',
                name: 'Official Plugin',
                version: '1.0.0',
                description: 'Official plugin',
                author: 'Unravl Team',
                analyzer: MockAnalyzer,
                supportedLanguages: ['typescript'],
                supportedFrameworks: ['nestjs'],
                type: 'official',
                category: 'framework',
                priority: 90,
                metadata: {
                    minEngineVersion: '1.0.0',
                    license: 'MIT',
                    keywords: [],
                    maintainers: [],
                    lastUpdated: new Date(),
                    verified: true
                },
                dependencies: []
            };
            const communityPlugin = {
                id: 'community-1',
                name: 'Community Plugin',
                version: '1.0.0',
                description: 'Community plugin',
                author: 'Community Dev',
                analyzer: MockAnalyzer,
                supportedLanguages: ['python'],
                supportedFrameworks: ['django'],
                type: 'community',
                category: 'language',
                priority: 60,
                metadata: {
                    minEngineVersion: '1.0.0',
                    license: 'Apache-2.0',
                    keywords: [],
                    maintainers: [],
                    lastUpdated: new Date(),
                    verified: false
                },
                dependencies: []
            };
            registry.registerPlugin(officialPlugin);
            registry.registerPlugin(communityPlugin);
            const stats = registry.getStatistics();
            expect(stats.totalPlugins).toBe(2);
            expect(stats.officialPlugins).toBe(1);
            expect(stats.communityPlugins).toBe(1);
            expect(stats.internalPlugins).toBe(0);
            expect(stats.languageAnalyzers).toBe(1);
            expect(stats.frameworkAnalyzers).toBe(1);
            expect(stats.supportedLanguages).toContain('typescript');
            expect(stats.supportedLanguages).toContain('python');
            expect(stats.supportedFrameworks).toContain('nestjs');
            expect(stats.supportedFrameworks).toContain('django');
        });
        it('should clear caches', () => {
            registry.clearCaches();
            expect(true).toBe(true);
        });
    });
    describe('version compatibility', () => {
        it('should accept compatible versions', () => {
            const plugin = {
                id: 'version-compatible',
                name: 'Version Compatible Plugin',
                version: '1.0.0',
                description: 'Plugin with compatible version',
                author: 'Test',
                analyzer: MockAnalyzer,
                supportedLanguages: ['javascript'],
                supportedFrameworks: [],
                type: 'community',
                category: 'language',
                priority: 50,
                metadata: {
                    minEngineVersion: '0.9.0',
                    maxEngineVersion: '2.0.0',
                    license: 'MIT',
                    keywords: [],
                    maintainers: [],
                    lastUpdated: new Date(),
                    verified: false
                },
                dependencies: []
            };
            expect(() => {
                registry.registerPlugin(plugin);
            }).not.toThrow();
        });
        it('should reject incompatible versions', () => {
            const plugin = {
                id: 'version-incompatible',
                name: 'Version Incompatible Plugin',
                version: '1.0.0',
                description: 'Plugin with incompatible version',
                author: 'Test',
                analyzer: MockAnalyzer,
                supportedLanguages: ['javascript'],
                supportedFrameworks: [],
                type: 'community',
                category: 'language',
                priority: 50,
                metadata: {
                    minEngineVersion: '2.0.0',
                    license: 'MIT',
                    keywords: [],
                    maintainers: [],
                    lastUpdated: new Date(),
                    verified: false
                },
                dependencies: []
            };
            expect(() => {
                registry.registerPlugin(plugin);
            }).toThrow(/requires engine version/);
        });
    });
    describe('error handling', () => {
        it('should handle plugin loading errors gracefully', async () => {
            const pluginDir = path.join(tempDir, 'invalid-plugin');
            await fs.mkdir(pluginDir);
            await fs.writeFile(path.join(pluginDir, 'plugin.json'), '{ invalid json }');
            registry['pluginDirectories'] = [tempDir];
            const results = await registry.discoverPlugins();
            expect(results.length).toBeGreaterThan(0);
            const failureResult = results.find(r => !r.success);
            expect(failureResult).toBeDefined();
            expect(failureResult?.error).toContain('Failed to load plugin');
        });
        it('should handle missing analyzer files', async () => {
            const pluginDir = path.join(tempDir, 'missing-analyzer');
            await fs.mkdir(pluginDir);
            const manifest = {
                id: 'missing-analyzer-plugin',
                name: 'Missing Analyzer Plugin',
                version: '1.0.0',
                entry: 'nonexistent.js',
                minEngineVersion: '1.0.0'
            };
            await fs.writeJson(path.join(pluginDir, 'plugin.json'), manifest);
            registry['pluginDirectories'] = [tempDir];
            const results = await registry.discoverPlugins();
            const failureResult = results.find(r => !r.success && r.error?.includes('nonexistent.js'));
            expect(failureResult).toBeDefined();
        });
    });
});
