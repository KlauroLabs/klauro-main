// Analyzer Bootstrap - Registers official language analyzers with the plugin system
// Production-ready initialization of the core analyzer ecosystem

import { pluginRegistry } from './plugin-registry';
import { SystemTopologyAnalyzer } from './system-topology-analyzer';
import { AnalyzerPlugin } from './plugin-registry';
import { 
  PythonAnalyzer, 
  TypeScriptJavaScriptAnalyzer, 
  JavaAnalyzer, 
  CSharpAnalyzer, 
  GoAnalyzer, 
  RustAnalyzer, 
  PHPAnalyzer,
  ANALYZER_METADATA 
} from './languages';

/**
 * Bootstrap the analyzer system with official plugins
 * This should be called during application initialization
 */
export async function bootstrapAnalyzers(): Promise<void> {
  console.log('🚀 Bootstrapping Unravl Analyzer System...');

  // Register official analyzers
  await registerOfficialAnalyzers();
  
  // Log registration statistics
  const stats = pluginRegistry.getStatistics();
  console.log(`✅ Analyzer System Initialized:`);
  console.log(`   • ${stats.officialPlugins} official analyzers`);
  console.log(`   • ${stats.supportedLanguages.length} supported languages`);
  console.log(`   • ${stats.supportedFrameworks.length} supported frameworks`);
  
  if (stats.supportedLanguages.length > 0) {
    console.log(`   • Languages: ${stats.supportedLanguages.join(', ')}`);
  }
}

/**
 * Register all official analyzers provided by the Unravl platform
 */
async function registerOfficialAnalyzers(): Promise<void> {
  const officialAnalyzers: Omit<AnalyzerPlugin, 'analyzer'>[] = [
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
        'any' // Universal analyzer that works with any framework
      ],
      type: 'official',
      category: 'specialized',
      priority: 100, // Highest priority as it's the most comprehensive
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

    // TypeScript/JavaScript Specialized Analyzer
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

    // Python Specialized Analyzer
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

    // Java Specialized Analyzer
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

    // C#/.NET Specialized Analyzer
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

    // Go Specialized Analyzer
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

    // Rust Specialized Analyzer
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

    // PHP Specialized Analyzer
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

  // Register the System Topology Analyzer (our current implementation)
  try {
    const topologyPlugin: AnalyzerPlugin = {
      ...officialAnalyzers[0],
      analyzer: SystemTopologyAnalyzer
    };
    
    pluginRegistry.registerPlugin(topologyPlugin);
    console.log(`✅ Registered: ${topologyPlugin.name}`);
  } catch (error) {
    console.error(`❌ Failed to register System Topology Analyzer: ${(error as Error).message}`);
  }

  // Register all Phase 2 language base analyzers
  const languageAnalyzers = [
    { class: PythonAnalyzer, config: officialAnalyzers[1] },
    { class: TypeScriptJavaScriptAnalyzer, config: officialAnalyzers[1] }, // Will be updated
    { class: JavaAnalyzer, config: officialAnalyzers[2] },
    { class: CSharpAnalyzer, config: officialAnalyzers[3] },
    { class: GoAnalyzer, config: officialAnalyzers[4] },
    { class: RustAnalyzer, config: officialAnalyzers[5] },
    { class: PHPAnalyzer, config: officialAnalyzers[6] }
  ];

  // Register each language analyzer with its metadata
  for (let i = 0; i < ANALYZER_METADATA.length; i++) {
    const metadata = ANALYZER_METADATA[i];
    const analyzerClass = languageAnalyzers[i]?.class;
    
    if (analyzerClass) {
      try {
        const plugin: AnalyzerPlugin = {
          id: `unravl-${metadata.name.toLowerCase().replace('analyzer', '')}-analyzer`,
          name: metadata.name.replace('Analyzer', ' Analyzer'),
          version: '1.0.0',
          description: `Production-ready ${metadata.languages.join('/')} analyzer with comprehensive AST parsing`,
          author: 'Unravl Team',
          supportedLanguages: [...metadata.languages],
          supportedFrameworks: [...metadata.frameworks],
          type: 'official',
          category: metadata.category as any,
          priority: metadata.priority,
          metadata: {
            minEngineVersion: '1.0.0',
            license: 'MIT',
            homepage: 'https://unravl.dev',
            repository: 'https://github.com/unravl/platform',
            documentation: `https://docs.unravl.dev/analyzers/${metadata.languages[0]}`,
            keywords: [
              ...metadata.languages,
              ...metadata.frameworks.slice(0, 5), // First 5 frameworks
              'ast-parsing', 'production-ready', 'official'
            ],
            maintainers: ['Unravl Team <team@unravl.dev>'],
            lastUpdated: new Date(),
            verified: true
          },
          dependencies: [],
          analyzer: analyzerClass
        };
        
        pluginRegistry.registerPlugin(plugin);
        console.log(`✅ Registered: ${plugin.name} (${plugin.supportedLanguages.join(', ')})`);
      } catch (error) {
        console.error(`❌ Failed to register ${metadata.name}: ${(error as Error).message}`);
      }
    }
  }

  console.log('🎯 Official analyzer registration complete');
}

/**
 * Get the best analyzer for a project path
 * This is a convenience function that uses the plugin registry
 */
export async function getAnalyzerForProject(projectPath: string) {
  return await pluginRegistry.getAnalyzerForProject(projectPath);
}

/**
 * Get registry statistics
 */
export function getAnalyzerStatistics() {
  return pluginRegistry.getStatistics();
}

/**
 * Discovery and load community analyzers from configured directories
 */
export async function loadCommunityAnalyzers(): Promise<void> {
  console.log('🔍 Discovering community analyzers...');
  
  try {
    const results = await pluginRegistry.discoverPlugins({
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
  } catch (error) {
    console.error('❌ Failed to discover community analyzers:', (error as Error).message);
  }
}

/**
 * Initialize the complete analyzer ecosystem
 * Call this during application startup
 */
export async function initializeAnalyzerSystem(): Promise<void> {
  try {
    await bootstrapAnalyzers();
    await loadCommunityAnalyzers();
    
    const stats = pluginRegistry.getStatistics();
    console.log(`\n🎉 Unravl Analyzer System Ready!`);
    console.log(`   Total Analyzers: ${stats.totalPlugins}`);
    console.log(`   Languages: ${stats.supportedLanguages.length}`);
    console.log(`   Frameworks: ${stats.supportedFrameworks.length}\n`);
  } catch (error) {
    console.error('💥 Failed to initialize analyzer system:', (error as Error).message);
    throw error;
  }
}