// Enhanced Analyzer Factory - Integrates with Plugin Registry
// Production-ready factory with plugin discovery, caching, and intelligent selection

import { BaseAnalyzer } from './base-analyzer';
import { pluginRegistry, AnalyzerPlugin, PluginDiscoveryOptions } from './plugin-registry';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface AnalyzerSelection {
  analyzer: BaseAnalyzer;
  plugin: AnalyzerPlugin;
  confidence: number;
  detectionTime: number;
  metadata: AnalyzerSelectionMetadata;
}

export interface AnalyzerSelectionMetadata {
  projectType: string;
  primaryLanguage: string;
  frameworks: string[];
  complexityScore: number;
  alternativeAnalyzers: string[];
  selectionReason: string;
  warnings?: string[];
}

export interface ProjectAnalysisContext {
  repositoryPath: string;
  projectName?: string;
  hint?: ProjectTypeHint;
  constraints?: AnalysisConstraints;
  preferences?: AnalyzerPreferences;
}

export interface ProjectTypeHint {
  language?: string;
  framework?: string;
  projectType?: 'web' | 'api' | 'mobile' | 'desktop' | 'library' | 'microservice';
  stack?: 'frontend' | 'backend' | 'fullstack' | 'data';
}

export interface AnalysisConstraints {
  maxAnalysisTime?: number;
  excludeAnalyzers?: string[];
  requireOfficial?: boolean;
  minConfidence?: number;
  allowExperimental?: boolean;
}

export interface AnalyzerPreferences {
  preferredAnalyzers?: string[];
  prioritizeSpeed?: boolean;
  prioritizeAccuracy?: boolean;
  preferCommunity?: boolean;
}

export interface FactoryStatistics {
  totalSelections: number;
  averageSelectionTime: number;
  successRate: number;
  popularAnalyzers: Array<{ name: string; usage: number }>;
  averageConfidence: number;
  cacheHitRate: number;
}

export class EnhancedAnalyzerFactory {
  private selectionCache = new Map<string, AnalyzerSelection>();
  private selectionHistory: AnalyzerSelection[] = [];
  private statistics: FactoryStatistics = {
    totalSelections: 0,
    averageSelectionTime: 0,
    successRate: 0,
    popularAnalyzers: [],
    averageConfidence: 0,
    cacheHitRate: 0
  };

  constructor() {
    this.initializeBuiltInAnalyzers();
  }

  /**
   * Initialize and register built-in analyzers
   */
  private async initializeBuiltInAnalyzers(): Promise<void> {
    try {
      // Discover and register plugins
      await pluginRegistry.discoverPlugins({
        includeOfficial: true,
        includeCommunity: true,
        includeInternal: true
      });

      // Register the existing SystemTopologyAnalyzer if not already registered
      try {
        const { SystemTopologyAnalyzer } = await import('./system-topology-analyzer');
        
        if (!pluginRegistry.getPlugin('system-topology')) {
          pluginRegistry.registerPlugin({
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
            priority: 100, // High priority as fallback
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
      } catch (error) {
        console.warn('⚠️ Failed to register SystemTopologyAnalyzer:', error instanceof Error ? error.message : String(error));
      }

      console.log('🚀 Enhanced Analyzer Factory initialized with plugin system');
    } catch (error) {
      console.error('❌ Failed to initialize Enhanced Analyzer Factory:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Create the best analyzer for a project with intelligent selection
   */
  async createAnalyzer(context: ProjectAnalysisContext): Promise<AnalyzerSelection> {
    const startTime = Date.now();
    this.statistics.totalSelections++;

    try {
      // Check cache first
      const cacheKey = this.generateCacheKey(context);
      if (this.selectionCache.has(cacheKey)) {
        this.statistics.cacheHitRate = (this.statistics.cacheHitRate * (this.statistics.totalSelections - 1) + 1) / this.statistics.totalSelections;
        return this.selectionCache.get(cacheKey)!;
      }

      // Analyze project to understand requirements
      const projectAnalysis = await this.analyzeProject(context);
      
      // Get candidate analyzers
      const candidates = await this.getCandidateAnalyzers(projectAnalysis, context);
      
      // Evaluate and select best analyzer
      const selection = await this.selectBestAnalyzer(candidates, projectAnalysis, context);
      
      // Update statistics and cache
      const detectionTime = Date.now() - startTime;
      selection.detectionTime = detectionTime;
      
      this.updateStatistics(selection, detectionTime);
      this.selectionCache.set(cacheKey, selection);
      this.selectionHistory.push(selection);

      console.log(`🎯 Selected ${selection.plugin.name} analyzer (confidence: ${(selection.confidence * 100).toFixed(0)}%, ${detectionTime}ms)`);
      
      return selection;

    } catch (error) {
      console.error('❌ Failed to create analyzer:', error instanceof Error ? error.message : String(error));
      
      // Fallback to system topology analyzer
      const fallback = await this.createFallbackAnalyzer(context);
      if (fallback) {
        fallback.detectionTime = Date.now() - startTime;
        fallback.metadata.warnings = [`Using fallback analyzer due to: ${error instanceof Error ? error.message : String(error)}`];
        return fallback;
      }
      
      throw new Error(`No suitable analyzer found for project: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Analyze project structure and characteristics
   */
  private async analyzeProject(context: ProjectAnalysisContext): Promise<ProjectAnalysis> {
    const analysis: ProjectAnalysis = {
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
      // Quick file system scan
      const files = await this.scanProjectFiles(context.repositoryPath);
      
      // Analyze languages
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const language = this.mapExtensionToLanguage(ext);
        if (language) {
          analysis.languages.set(language, (analysis.languages.get(language) || 0) + 1);
        }
        analysis.fileTypes.set(ext, (analysis.fileTypes.get(ext) || 0) + 1);
      }

      // Analyze directory structure
      for (const file of files) {
        const dirs = file.split('/');
        dirs.forEach(dir => {
          if (dir && !dir.startsWith('.')) {
            analysis.directoryStructure.add(dir.toLowerCase());
          }
        });
      }

      // Detect configuration files and frameworks
      const configFiles = files.filter(f => this.isConfigFile(f));
      for (const config of configFiles) {
        analysis.configFiles.add(path.basename(config));
        const frameworks = await this.detectFrameworksFromConfig(config);
        frameworks.forEach(fw => analysis.frameworks.add(fw));
      }

      // Determine project type and stack
      analysis.projectType = this.determineProjectType(analysis);
      analysis.stack = this.determineStack(analysis);

      return analysis;

    } catch (error) {
      console.warn(`⚠️ Project analysis failed: ${error instanceof Error ? error.message : String(error)}`);
      return analysis;
    }
  }

  /**
   * Scan project files (limited for performance)
   */
  private async scanProjectFiles(repositoryPath: string): Promise<string[]> {
    const files: string[] = [];
    const maxFiles = 200; // Limit for performance
    
    try {
      const entries = await fs.readdir(repositoryPath, { recursive: true });
      for (const entry of entries.slice(0, maxFiles)) {
        const fullPath = path.join(repositoryPath, entry.toString());
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) {
            files.push(path.relative(repositoryPath, fullPath));
          }
        } catch {
          // Skip files we can't access
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to scan project files: ${error instanceof Error ? error.message : String(error)}`);
    }

    return files;
  }

  /**
   * Map file extension to programming language
   */
  private mapExtensionToLanguage(ext: string): string | null {
    const mapping: Record<string, string> = {
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

  /**
   * Check if file is a configuration file
   */
  private isConfigFile(filePath: string): boolean {
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

  /**
   * Detect frameworks from configuration file
   */
  private async detectFrameworksFromConfig(configFile: string): Promise<string[]> {
    const frameworks: string[] = [];
    
    try {
      const content = await fs.readFile(configFile, 'utf-8');
      const fileName = path.basename(configFile);

      if (fileName === 'package.json') {
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        
        Object.keys(deps).forEach(dep => {
          if (dep === 'react') frameworks.push('React');
          if (dep === 'vue') frameworks.push('Vue');
          if (dep === '@angular/core') frameworks.push('Angular');
          if (dep === 'express') frameworks.push('Express');
          if (dep === '@nestjs/core') frameworks.push('NestJS');
          if (dep === 'next') frameworks.push('Next.js');
          if (dep === 'nuxt') frameworks.push('Nuxt.js');
          if (dep === 'svelte') frameworks.push('Svelte');
        });
      } else if (fileName === 'requirements.txt') {
        if (content.includes('django')) frameworks.push('Django');
        if (content.includes('flask')) frameworks.push('Flask');
        if (content.includes('fastapi')) frameworks.push('FastAPI');
        if (content.includes('tornado')) frameworks.push('Tornado');
      }
      // Add more framework detection logic as needed

    } catch (error) {
      // Ignore parsing errors
    }

    return frameworks;
  }

  /**
   * Determine project type from analysis
   */
  private determineProjectType(analysis: ProjectAnalysis): string {
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

  /**
   * Determine stack from analysis
   */
  private determineStack(analysis: ProjectAnalysis): string {
    const hasWebFramework = Array.from(analysis.frameworks).some(fw => 
      ['React', 'Vue', 'Angular', 'Svelte'].includes(fw)
    );
    const hasBackendFramework = Array.from(analysis.frameworks).some(fw => 
      ['Express', 'NestJS', 'Django', 'Flask', 'FastAPI'].includes(fw)
    );

    if (hasWebFramework && hasBackendFramework) return 'fullstack';
    if (hasWebFramework) return 'frontend';
    if (hasBackendFramework) return 'backend';
    return 'unknown';
  }

  /**
   * Get candidate analyzers based on project analysis
   */
  private async getCandidateAnalyzers(
    projectAnalysis: ProjectAnalysis, 
    context: ProjectAnalysisContext
  ): Promise<AnalyzerCandidate[]> {
    const candidates: AnalyzerCandidate[] = [];
    const plugins = pluginRegistry.getPlugins();

    for (const plugin of plugins) {
      // Skip excluded analyzers
      if (context.constraints?.excludeAnalyzers?.includes(plugin.id)) {
        continue;
      }

      // Check official requirement
      if (context.constraints?.requireOfficial && plugin.type !== 'official') {
        continue;
      }

      // Calculate compatibility score
      const compatibility = this.calculateCompatibilityScore(plugin, projectAnalysis, context);
      
      if (compatibility.score > 0) {
        candidates.push({
          plugin,
          compatibility,
          priority: plugin.priority + compatibility.score * 10
        });
      }
    }

    // Sort by priority (higher first)
    candidates.sort((a, b) => b.priority - a.priority);

    return candidates.slice(0, 5); // Limit to top 5 candidates
  }

  /**
   * Calculate compatibility score between plugin and project
   */
  private calculateCompatibilityScore(
    plugin: AnalyzerPlugin,
    projectAnalysis: ProjectAnalysis,
    context: ProjectAnalysisContext
  ): CompatibilityScore {
    let score = 0;
    const reasons: string[] = [];
    const penalties: string[] = [];

    // Language compatibility
    const projectLanguages = Array.from(projectAnalysis.languages.keys());
    const supportedLanguages = plugin.supportedLanguages;
    
    const languageMatch = projectLanguages.some(lang => supportedLanguages.includes(lang));
    if (languageMatch) {
      score += 40;
      reasons.push('Language compatibility');
    } else if (supportedLanguages.includes('any') || plugin.category === 'specialized') {
      score += 20;
      reasons.push('Universal analyzer');
    }

    // Framework compatibility
    const projectFrameworks = Array.from(projectAnalysis.frameworks);
    const supportedFrameworks = plugin.supportedFrameworks;
    
    const frameworkMatch = projectFrameworks.some(fw => supportedFrameworks.includes(fw));
    if (frameworkMatch) {
      score += 30;
      reasons.push('Framework compatibility');
    } else if (supportedFrameworks.includes('any')) {
      score += 15;
      reasons.push('Generic framework support');
    }

    // Type hint compatibility
    if (context.hint?.language && supportedLanguages.includes(context.hint.language)) {
      score += 20;
      reasons.push('Matches language hint');
    }
    if (context.hint?.framework && supportedFrameworks.includes(context.hint.framework)) {
      score += 20;
      reasons.push('Matches framework hint');
    }

    // Preference bonuses
    if (context.preferences?.preferredAnalyzers?.includes(plugin.id)) {
      score += 25;
      reasons.push('User preference');
    }
    if (context.preferences?.preferCommunity && plugin.type === 'community') {
      score += 10;
      reasons.push('Community preference');
    }

    // Quality indicators
    if (plugin.metadata.verified) {
      score += 10;
      reasons.push('Verified plugin');
    }
    if (plugin.type === 'official') {
      score += 15;
      reasons.push('Official plugin');
    }

    // Penalties
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

  /**
   * Select the best analyzer from candidates
   */
  private async selectBestAnalyzer(
    candidates: AnalyzerCandidate[],
    projectAnalysis: ProjectAnalysis,
    context: ProjectAnalysisContext
  ): Promise<AnalyzerSelection> {
    if (candidates.length === 0) {
      throw new Error('No compatible analyzers found');
    }

    // Test top candidates with actual detection
    for (const candidate of candidates.slice(0, 3)) {
      try {
        const AnalyzerClass = candidate.plugin.analyzer;
        if (!AnalyzerClass || typeof AnalyzerClass !== 'function') {
          continue;
        }
        const analyzer = new (AnalyzerClass as any)();
        analyzer['projectPath'] = context.repositoryPath;
        
        const detection = await analyzer['detectLanguageAndFramework']?.();
        if (detection && detection.confidence >= (context.constraints?.minConfidence || 0.3)) {
          
          return {
            analyzer,
            plugin: candidate.plugin,
            confidence: detection.confidence,
            detectionTime: 0, // Will be set later
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
      } catch (error) {
        console.warn(`⚠️ Analyzer ${candidate.plugin.name} failed detection: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error('No analyzer successfully detected the project');
  }

  /**
   * Create fallback analyzer
   */
  private async createFallbackAnalyzer(context: ProjectAnalysisContext): Promise<AnalyzerSelection | null> {
    const systemTopologyPlugin = pluginRegistry.getPlugin('system-topology');
    if (systemTopologyPlugin) {
      try {
        const AnalyzerClass = systemTopologyPlugin.analyzer;
        const analyzer = new (AnalyzerClass as any)();
        
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
      } catch (error) {
        console.error('❌ Fallback analyzer failed:', error instanceof Error ? error.message : String(error));
      }
    }
    
    return null;
  }

  /**
   * Calculate project complexity score
   */
  private calculateComplexityScore(analysis: ProjectAnalysis): number {
    let score = 0;
    
    score += analysis.languages.size * 10; // Multiple languages increase complexity
    score += analysis.frameworks.size * 15; // Multiple frameworks increase complexity
    score += Math.min(analysis.directoryStructure.size * 2, 50); // Directory depth
    score += Math.min(analysis.configFiles.size * 5, 30); // Configuration complexity
    
    return Math.min(score, 100);
  }

  /**
   * Generate cache key for analyzer selection
   */
  private generateCacheKey(context: ProjectAnalysisContext): string {
    const key = [
      context.repositoryPath,
      context.hint?.language || '',
      context.hint?.framework || '',
      context.constraints?.requireOfficial || false,
      context.preferences?.preferredAnalyzers?.join(',') || ''
    ].join('|');
    
    return Buffer.from(key).toString('base64');
  }

  /**
   * Update factory statistics
   */
  private updateStatistics(selection: AnalyzerSelection, detectionTime: number): void {
    this.statistics.averageSelectionTime = 
      (this.statistics.averageSelectionTime * (this.statistics.totalSelections - 1) + detectionTime) / 
      this.statistics.totalSelections;
    
    this.statistics.averageConfidence = 
      (this.statistics.averageConfidence * (this.statistics.totalSelections - 1) + selection.confidence) / 
      this.statistics.totalSelections;

    this.statistics.successRate = this.statistics.totalSelections > 0 ? 
      this.selectionHistory.length / this.statistics.totalSelections : 0;

    // Update popular analyzers
    const existing = this.statistics.popularAnalyzers.find(p => p.name === selection.plugin.name);
    if (existing) {
      existing.usage++;
    } else {
      this.statistics.popularAnalyzers.push({ name: selection.plugin.name, usage: 1 });
    }
    
    this.statistics.popularAnalyzers.sort((a, b) => b.usage - a.usage);
    this.statistics.popularAnalyzers = this.statistics.popularAnalyzers.slice(0, 10);
  }

  /**
   * Get factory statistics
   */
  getStatistics(): FactoryStatistics {
    return { ...this.statistics };
  }

  /**
   * Clear caches
   */
  clearCaches(): void {
    this.selectionCache.clear();
    pluginRegistry.clearCaches();
    console.log('🧹 Cleared analyzer factory caches');
  }

  /**
   * Get selection history
   */
  getSelectionHistory(): AnalyzerSelection[] {
    return [...this.selectionHistory];
  }
}

interface ProjectAnalysis {
  repositoryPath: string;
  projectName: string;
  languages: Map<string, number>;
  frameworks: Set<string>;
  fileTypes: Map<string, number>;
  directoryStructure: Set<string>;
  configFiles: Set<string>;
  complexityIndicators: string[];
  projectType: string;
  stack: string;
}

interface AnalyzerCandidate {
  plugin: AnalyzerPlugin;
  compatibility: CompatibilityScore;
  priority: number;
}

interface CompatibilityScore {
  score: number;
  reasons: string[];
  penalties: string[];
  languageMatch: boolean;
  frameworkMatch: boolean;
}

// Global factory instance
export const analyzerFactory = new EnhancedAnalyzerFactory();