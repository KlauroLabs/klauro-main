// Register Framework Analyzers - Automatically registers all framework analyzers with the plugin system
// Phase 3: Framework Sub-Analyzers - Plugin registration

import { PluginRegistry, AnalyzerPlugin } from './plugin-registry';
import { FRAMEWORK_ANALYZERS } from './frameworks';
import { telemetry } from '../telemetry/telemetry-schema';

/**
 * Register all framework analyzers with the plugin registry
 */
export async function registerFrameworkAnalyzers(registry: PluginRegistry): Promise<void> {
  const span = telemetry.createSpan('register-framework-analyzers');
  
  console.log('📦 Registering framework analyzers...');
  
  let successCount = 0;
  let failureCount = 0;
  
  for (const analyzerInfo of FRAMEWORK_ANALYZERS) {
    try {
      const plugin: AnalyzerPlugin = {
        id: `unravl.framework.${analyzerInfo.name.toLowerCase().replace(/[.\s]/g, '-')}`,
        name: `${analyzerInfo.name} Framework Analyzer`,
        version: '1.0.0',
        description: `Specialized analyzer for ${analyzerInfo.name} framework projects`,
        author: 'Unravl Team',
        analyzer: analyzerInfo.analyzer,
        supportedLanguages: analyzerInfo.languages,
        supportedFrameworks: analyzerInfo.frameworks,
        type: 'official',
        category: 'framework',
        priority: analyzerInfo.priority,
        metadata: {
          minEngineVersion: '1.0.0',
          license: 'MIT',
          keywords: [
            analyzerInfo.name.toLowerCase(),
            analyzerInfo.category,
            ...analyzerInfo.frameworks
          ],
          maintainers: ['Unravl Team'],
          lastUpdated: new Date(),
          verified: true,
          homepage: 'https://unravl.io/analyzers/' + analyzerInfo.name.toLowerCase(),
          repository: 'https://github.com/unravl/analyzers',
          documentation: 'https://docs.unravl.io/analyzers/' + analyzerInfo.name.toLowerCase()
        },
        dependencies: [
          {
            name: `unravl.language.${analyzerInfo.languages[0]}`,
            version: '1.0.0',
            type: 'required',
            description: `Requires ${analyzerInfo.languages[0]} base analyzer`
          }
        ],
        configuration: {
          schema: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean', default: true },
              depth: { type: 'number', default: 3 },
              excludePatterns: {
                type: 'array',
                items: { type: 'string' },
                default: ['node_modules', 'dist', 'build', '.git']
              }
            }
          },
          defaults: {
            enabled: true,
            depth: 3,
            excludePatterns: ['node_modules', 'dist', 'build', '.git']
          },
          required: []
        }
      };
      
      await registry.registerPlugin(plugin);
      successCount++;
      
      telemetry.emit({
        type: 'framework_analyzer_registered',
        source: { analyzer: 'framework-registration' },
        data: {
          analyzerName: analyzerInfo.name,
          pluginId: plugin.id,
          category: analyzerInfo.category,
          frameworks: analyzerInfo.frameworks
        }
      });
      
    } catch (error) {
      failureCount++;
      console.error(`❌ Failed to register ${analyzerInfo.name} analyzer:`, error);
      
      telemetry.emit({
        type: 'error_occurred',
        source: { analyzer: 'framework-registration' },
        data: {
          analyzerName: analyzerInfo.name,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
  
  console.log(`✅ Registered ${successCount} framework analyzers`);
  if (failureCount > 0) {
    console.log(`⚠️ Failed to register ${failureCount} framework analyzers`);
  }
  
  span.end();
}

/**
 * Auto-detect and register appropriate framework analyzer for a project
 */
export async function autoRegisterFrameworkAnalyzer(
  registry: PluginRegistry,
  projectPath: string,
  detectedLanguage: string,
  detectedFrameworks: string[]
): Promise<string | null> {
  const span = telemetry.createSpan('auto-register-framework-analyzer');
  
  console.log(`🔍 Auto-detecting framework analyzer for ${detectedLanguage} with frameworks:`, detectedFrameworks);
  
  // Find the best matching framework analyzer
  let bestMatch: typeof FRAMEWORK_ANALYZERS[0] | null = null;
  let highestPriority = -1;
  
  for (const analyzerInfo of FRAMEWORK_ANALYZERS) {
    // Check if language matches
    if (!analyzerInfo.languages.includes(detectedLanguage.toLowerCase())) {
      continue;
    }
    
    // Check if any framework matches
    const frameworkMatch = analyzerInfo.frameworks.some(fw => 
      detectedFrameworks.some(detected => {
        const fwLower = fw.toLowerCase();
        const detectedLower = detected.toLowerCase();
        return fwLower === detectedLower || 
               fwLower.includes(detectedLower) || 
               detectedLower.includes(fwLower);
      })
    );
    
    if (frameworkMatch && analyzerInfo.priority > highestPriority) {
      bestMatch = analyzerInfo;
      highestPriority = analyzerInfo.priority;
    }
  }
  
  if (bestMatch) {
    const pluginId = `unravl.framework.${bestMatch.name.toLowerCase().replace(/[.\s]/g, '-')}`;
    
    // Check if already registered
    const existingPlugin = registry.getPlugin(pluginId);
    if (!existingPlugin) {
      // Register the framework analyzer
      const plugin: AnalyzerPlugin = {
        id: pluginId,
        name: `${bestMatch.name} Framework Analyzer`,
        version: '1.0.0',
        description: `Auto-detected analyzer for ${bestMatch.name} framework`,
        author: 'Unravl Team',
        analyzer: bestMatch.analyzer,
        supportedLanguages: bestMatch.languages,
        supportedFrameworks: bestMatch.frameworks,
        type: 'official',
        category: 'framework',
        priority: bestMatch.priority,
        metadata: {
          minEngineVersion: '1.0.0',
          license: 'MIT',
          keywords: bestMatch.frameworks,
          maintainers: ['Unravl Team'],
          lastUpdated: new Date(),
          verified: true,
          autoDetected: true
        },
        dependencies: [],
        configuration: {
          schema: {},
          defaults: {},
          required: []
        }
      };
      
      await registry.registerPlugin(plugin);
    }
    
    console.log(`✅ Auto-registered ${bestMatch.name} framework analyzer`);
    
    telemetry.emit({
      type: 'framework_analyzer_auto_detected',
      source: { analyzer: 'framework-registration' },
      data: {
        analyzerName: bestMatch.name,
        pluginId,
        detectedLanguage,
        detectedFrameworks
      }
    });
    
    span.end();
    return pluginId;
  }
  
  console.log('ℹ️ No matching framework analyzer found');
  span.end();
  return null;
}

/**
 * Get framework analyzer recommendations based on project analysis
 */
export function getFrameworkAnalyzerRecommendations(
  detectedLanguage: string,
  detectedFrameworks: string[],
  projectFiles: string[]
): string[] {
  const recommendations: string[] = [];
  
  for (const analyzerInfo of FRAMEWORK_ANALYZERS) {
    // Check language compatibility
    if (!analyzerInfo.languages.includes(detectedLanguage.toLowerCase())) {
      continue;
    }
    
    // Calculate match score
    let score = 0;
    
    // Framework name matches
    for (const fw of analyzerInfo.frameworks) {
      if (detectedFrameworks.some(d => d.toLowerCase().includes(fw.toLowerCase()))) {
        score += 10;
      }
    }
    
    // File pattern matches (simplified)
    if (analyzerInfo.name === 'React' && projectFiles.some(f => f.endsWith('.jsx') || f.endsWith('.tsx'))) {
      score += 5;
    }
    if (analyzerInfo.name === 'Vue' && projectFiles.some(f => f.endsWith('.vue'))) {
      score += 5;
    }
    if (analyzerInfo.name === 'Angular' && projectFiles.some(f => f === 'angular.json')) {
      score += 10;
    }
    if (analyzerInfo.name === 'Django' && projectFiles.some(f => f === 'manage.py')) {
      score += 10;
    }
    if (analyzerInfo.name === 'Next.js' && projectFiles.some(f => f.includes('next.config'))) {
      score += 15;
    }
    
    if (score > 0) {
      recommendations.push(`${analyzerInfo.name} (score: ${score})`);
    }
  }
  
  // Sort by score (extracted from recommendation string)
  recommendations.sort((a, b) => {
    const scoreA = parseInt(a.match(/score: (\d+)/)?.[1] || '0');
    const scoreB = parseInt(b.match(/score: (\d+)/)?.[1] || '0');
    return scoreB - scoreA;
  });
  
  return recommendations;
}