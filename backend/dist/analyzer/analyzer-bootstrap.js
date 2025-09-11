"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapAnalyzers = bootstrapAnalyzers;
exports.getAnalyzerForProject = getAnalyzerForProject;
exports.getAnalyzerStatistics = getAnalyzerStatistics;
exports.loadCommunityAnalyzers = loadCommunityAnalyzers;
exports.initializeAnalyzerSystem = initializeAnalyzerSystem;
const plugin_registry_1 = require("./plugin-registry");
const system_topology_analyzer_1 = require("./system-topology-analyzer");
const languages_1 = require("./languages");
async function bootstrapAnalyzers() {
    console.log('🚀 Bootstrapping Unravl Analyzer System...');
    await registerOfficialAnalyzers();
    const stats = plugin_registry_1.pluginRegistry.getStatistics();
    console.log(`✅ Analyzer System Initialized:`);
    console.log(`   • ${stats.officialPlugins} official analyzers`);
    console.log(`   • ${stats.supportedLanguages.length} supported languages`);
    console.log(`   • ${stats.supportedFrameworks.length} supported frameworks`);
    if (stats.supportedLanguages.length > 0) {
        console.log(`   • Languages: ${stats.supportedLanguages.join(', ')}`);
    }
}
async function registerOfficialAnalyzers() {
    const officialAnalyzers = [
        {
            id: 'unravl-system-topology',
            name: 'System Topology Analyzer',
            version: '1.0.0',
            description: 'Multi-language system architecture analyzer with pattern recognition',
            author: 'Unravl Team',
            supportedLanguages: [
                'typescript', 'javascript', 'python', 'java',
                'csharp', 'go', 'rust', 'php', 'ruby', 'kotlin', 'swift'
            ],
            supportedFrameworks: [
                'any'
            ],
            type: 'official',
            category: 'specialized',
            priority: 100,
            metadata: {
                minEngineVersion: '1.0.0',
                license: 'MIT',
                homepage: 'https://unravl.dev',
                repository: 'https://github.com/unravl/platform',
                documentation: 'https://docs.unravl.dev/analyzers/system-topology',
                keywords: [
                    'architecture', 'topology', 'patterns', 'multi-language',
                    'comprehensive', 'production-ready', 'official'
                ],
                maintainers: ['Unravl Team <team@unravl.dev>'],
                lastUpdated: new Date(),
                verified: true
            },
            dependencies: []
        },
        {
            id: 'unravl-typescript-analyzer',
            name: 'TypeScript/JavaScript Analyzer',
            version: '1.0.0',
            description: 'Specialized analyzer for TypeScript and JavaScript projects with AST parsing',
            author: 'Unravl Team',
            supportedLanguages: ['typescript', 'javascript'],
            supportedFrameworks: [
                'nestjs', 'express', 'fastify', 'koa', 'react', 'vue', 'angular',
                'next', 'nuxt', 'svelte', 'gatsby', 'electron', 'react-native'
            ],
            type: 'official',
            category: 'language',
            priority: 90,
            metadata: {
                minEngineVersion: '1.0.0',
                license: 'MIT',
                homepage: 'https://unravl.dev',
                repository: 'https://github.com/unravl/platform',
                documentation: 'https://docs.unravl.dev/analyzers/typescript',
                keywords: [
                    'typescript', 'javascript', 'ast', 'node', 'frontend', 'backend'
                ],
                maintainers: ['Unravl Team <team@unravl.dev>'],
                lastUpdated: new Date(),
                verified: true
            },
            dependencies: []
        },
        {
            id: 'unravl-python-analyzer',
            name: 'Python Analyzer',
            version: '1.0.0',
            description: 'Specialized analyzer for Python projects with framework detection',
            author: 'Unravl Team',
            supportedLanguages: ['python'],
            supportedFrameworks: [
                'django', 'flask', 'fastapi', 'pyramid', 'tornado', 'celery',
                'pytest', 'unittest', 'pandas', 'numpy', 'tensorflow', 'pytorch'
            ],
            type: 'official',
            category: 'language',
            priority: 90,
            metadata: {
                minEngineVersion: '1.0.0',
                license: 'MIT',
                homepage: 'https://unravl.dev',
                repository: 'https://github.com/unravl/platform',
                documentation: 'https://docs.unravl.dev/analyzers/python',
                keywords: [
                    'python', 'django', 'flask', 'fastapi', 'ml', 'data-science'
                ],
                maintainers: ['Unravl Team <team@unravl.dev>'],
                lastUpdated: new Date(),
                verified: true
            },
            dependencies: []
        },
        {
            id: 'unravl-java-analyzer',
            name: 'Java Analyzer',
            version: '1.0.0',
            description: 'Specialized analyzer for Java projects with Spring ecosystem support',
            author: 'Unravl Team',
            supportedLanguages: ['java', 'kotlin'],
            supportedFrameworks: [
                'spring-boot', 'spring', 'hibernate', 'junit', 'maven', 'gradle',
                'android', 'kafka', 'elasticsearch'
            ],
            type: 'official',
            category: 'language',
            priority: 90,
            metadata: {
                minEngineVersion: '1.0.0',
                license: 'MIT',
                homepage: 'https://unravl.dev',
                repository: 'https://github.com/unravl/platform',
                documentation: 'https://docs.unravl.dev/analyzers/java',
                keywords: [
                    'java', 'kotlin', 'spring', 'enterprise', 'jvm', 'android'
                ],
                maintainers: ['Unravl Team <team@unravl.dev>'],
                lastUpdated: new Date(),
                verified: true
            },
            dependencies: []
        },
        {
            id: 'unravl-dotnet-analyzer',
            name: '.NET Analyzer',
            version: '1.0.0',
            description: 'Specialized analyzer for .NET projects with ASP.NET Core support',
            author: 'Unravl Team',
            supportedLanguages: ['csharp', 'fsharp', 'vb'],
            supportedFrameworks: [
                'asp.net-core', 'entity-framework', 'blazor', 'xamarin', 'maui',
                'unity', 'nunit', 'xunit'
            ],
            type: 'official',
            category: 'language',
            priority: 90,
            metadata: {
                minEngineVersion: '1.0.0',
                license: 'MIT',
                homepage: 'https://unravl.dev',
                repository: 'https://github.com/unravl/platform',
                documentation: 'https://docs.unravl.dev/analyzers/dotnet',
                keywords: [
                    'csharp', 'dotnet', 'asp.net', 'blazor', 'xamarin', 'enterprise'
                ],
                maintainers: ['Unravl Team <team@unravl.dev>'],
                lastUpdated: new Date(),
                verified: true
            },
            dependencies: []
        },
        {
            id: 'unravl-go-analyzer',
            name: 'Go Analyzer',
            version: '1.0.0',
            description: 'Specialized analyzer for Go projects with concurrency pattern detection',
            author: 'Unravl Team',
            supportedLanguages: ['go'],
            supportedFrameworks: [
                'gin', 'echo', 'fiber', 'beego', 'gorilla-mux', 'grpc',
                'cobra', 'testify', 'gorm'
            ],
            type: 'official',
            category: 'language',
            priority: 90,
            metadata: {
                minEngineVersion: '1.0.0',
                license: 'MIT',
                homepage: 'https://unravl.dev',
                repository: 'https://github.com/unravl/platform',
                documentation: 'https://docs.unravl.dev/analyzers/go',
                keywords: [
                    'go', 'golang', 'concurrency', 'microservices', 'cloud-native'
                ],
                maintainers: ['Unravl Team <team@unravl.dev>'],
                lastUpdated: new Date(),
                verified: true
            },
            dependencies: []
        },
        {
            id: 'unravl-rust-analyzer',
            name: 'Rust Analyzer',
            version: '1.0.0',
            description: 'Specialized analyzer for Rust projects with ownership pattern analysis',
            author: 'Unravl Team',
            supportedLanguages: ['rust'],
            supportedFrameworks: [
                'actix-web', 'rocket', 'warp', 'axum', 'tokio', 'async-std',
                'diesel', 'sqlx', 'serde', 'clap'
            ],
            type: 'official',
            category: 'language',
            priority: 90,
            metadata: {
                minEngineVersion: '1.0.0',
                license: 'MIT',
                homepage: 'https://unravl.dev',
                repository: 'https://github.com/unravl/platform',
                documentation: 'https://docs.unravl.dev/analyzers/rust',
                keywords: [
                    'rust', 'memory-safety', 'performance', 'systems', 'web'
                ],
                maintainers: ['Unravl Team <team@unravl.dev>'],
                lastUpdated: new Date(),
                verified: true
            },
            dependencies: []
        },
        {
            id: 'unravl-php-analyzer',
            name: 'PHP Analyzer',
            version: '1.0.0',
            description: 'Specialized analyzer for PHP projects with framework ecosystem support',
            author: 'Unravl Team',
            supportedLanguages: ['php'],
            supportedFrameworks: [
                'laravel', 'symfony', 'codeigniter', 'slim', 'wordpress',
                'drupal', 'phpunit', 'composer'
            ],
            type: 'official',
            category: 'language',
            priority: 90,
            metadata: {
                minEngineVersion: '1.0.0',
                license: 'MIT',
                homepage: 'https://unravl.dev',
                repository: 'https://github.com/unravl/platform',
                documentation: 'https://docs.unravl.dev/analyzers/php',
                keywords: [
                    'php', 'laravel', 'symfony', 'wordpress', 'web', 'cms'
                ],
                maintainers: ['Unravl Team <team@unravl.dev>'],
                lastUpdated: new Date(),
                verified: true
            },
            dependencies: []
        }
    ];
    try {
        const topologyPlugin = {
            ...officialAnalyzers[0],
            analyzer: system_topology_analyzer_1.SystemTopologyAnalyzer
        };
        plugin_registry_1.pluginRegistry.registerPlugin(topologyPlugin);
        console.log(`✅ Registered: ${topologyPlugin.name}`);
    }
    catch (error) {
        console.error(`❌ Failed to register System Topology Analyzer: ${error.message}`);
    }
    const languageAnalyzers = [
        { class: languages_1.PythonAnalyzer, config: officialAnalyzers[1] },
        { class: languages_1.TypeScriptJavaScriptAnalyzer, config: officialAnalyzers[1] },
        { class: languages_1.JavaAnalyzer, config: officialAnalyzers[2] },
        { class: languages_1.CSharpAnalyzer, config: officialAnalyzers[3] },
        { class: languages_1.GoAnalyzer, config: officialAnalyzers[4] },
        { class: languages_1.RustAnalyzer, config: officialAnalyzers[5] },
        { class: languages_1.PHPAnalyzer, config: officialAnalyzers[6] }
    ];
    for (let i = 0; i < languages_1.ANALYZER_METADATA.length; i++) {
        const metadata = languages_1.ANALYZER_METADATA[i];
        const analyzerClass = languageAnalyzers[i]?.class;
        if (analyzerClass) {
            try {
                const plugin = {
                    id: `unravl-${metadata.name.toLowerCase().replace('analyzer', '')}-analyzer`,
                    name: metadata.name.replace('Analyzer', ' Analyzer'),
                    version: '1.0.0',
                    description: `Production-ready ${metadata.languages.join('/')} analyzer with comprehensive AST parsing`,
                    author: 'Unravl Team',
                    supportedLanguages: metadata.languages,
                    supportedFrameworks: metadata.frameworks,
                    type: 'official',
                    category: metadata.category,
                    priority: metadata.priority,
                    metadata: {
                        minEngineVersion: '1.0.0',
                        license: 'MIT',
                        homepage: 'https://unravl.dev',
                        repository: 'https://github.com/unravl/platform',
                        documentation: `https://docs.unravl.dev/analyzers/${metadata.languages[0]}`,
                        keywords: [
                            ...metadata.languages,
                            ...metadata.frameworks.slice(0, 5),
                            'ast-parsing', 'production-ready', 'official'
                        ],
                        maintainers: ['Unravl Team <team@unravl.dev>'],
                        lastUpdated: new Date(),
                        verified: true
                    },
                    dependencies: [],
                    analyzer: analyzerClass
                };
                plugin_registry_1.pluginRegistry.registerPlugin(plugin);
                console.log(`✅ Registered: ${plugin.name} (${plugin.supportedLanguages.join(', ')})`);
            }
            catch (error) {
                console.error(`❌ Failed to register ${metadata.name}: ${error.message}`);
            }
        }
    }
    console.log('🎯 Official analyzer registration complete');
}
async function getAnalyzerForProject(projectPath) {
    return await plugin_registry_1.pluginRegistry.getAnalyzerForProject(projectPath);
}
function getAnalyzerStatistics() {
    return plugin_registry_1.pluginRegistry.getStatistics();
}
async function loadCommunityAnalyzers() {
    console.log('🔍 Discovering community analyzers...');
    try {
        const results = await plugin_registry_1.pluginRegistry.discoverPlugins({
            includeOfficial: false,
            includeCommunity: true,
            includeInternal: true
        });
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        if (successful.length > 0) {
            console.log(`✅ Loaded ${successful.length} community analyzers:`);
            successful.forEach(result => {
                if (result.plugin) {
                    console.log(`   • ${result.plugin.name} v${result.plugin.version} by ${result.plugin.author}`);
                }
            });
        }
        if (failed.length > 0) {
            console.log(`⚠️ Failed to load ${failed.length} analyzers:`);
            failed.forEach(result => {
                console.log(`   • ${result.error}`);
            });
        }
        if (successful.length === 0 && failed.length === 0) {
            console.log('📭 No community analyzers found');
        }
    }
    catch (error) {
        console.error('❌ Failed to discover community analyzers:', error.message);
    }
}
async function initializeAnalyzerSystem() {
    try {
        await bootstrapAnalyzers();
        await loadCommunityAnalyzers();
        const stats = plugin_registry_1.pluginRegistry.getStatistics();
        console.log(`\n🎉 Unravl Analyzer System Ready!`);
        console.log(`   Total Analyzers: ${stats.totalPlugins}`);
        console.log(`   Languages: ${stats.supportedLanguages.length}`);
        console.log(`   Frameworks: ${stats.supportedFrameworks.length}\n`);
    }
    catch (error) {
        console.error('💥 Failed to initialize analyzer system:', error.message);
        throw error;
    }
}
