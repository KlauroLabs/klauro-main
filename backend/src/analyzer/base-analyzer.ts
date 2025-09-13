// Universal base analyzer interface - framework and language agnostic
// This defines the contract that all specific analyzers must implement
// Production-ready with comprehensive error handling and validation

import { 
  ArchitectureBlueprint, ComponentNode, Connection, RiskArea, ProjectMetadata,
  EntryPoint, ExitPoint, TechnologyStack, DependencyAnalysis, DatabaseAnalysis,
  APIEndpoint, SecurityAnalysis, TestingInfo, DeploymentInfo, CallGraph,
  FrameworkInfo, DatabaseConnection, FunctionInfo, TestCoverage
} from '../types';
import { aiAnalyzer } from '../ai/ai-analyzer';
import { AnalyzerError, ValidationError, FileSystemError } from './errors';
import { AnalyzerMetrics, MetricsCollector } from './metrics';
import { CacheManager } from './cache';
import { telemetry, TelemetryEvent } from '../telemetry/telemetry-schema';
import { FrameworkDetector } from './patterns/framework-detector';
import { EntryExitDetector } from './patterns/entry-exit-detector';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface AnalyzerOptions {
  includeTests?: boolean;
  maxDepth?: number;
  excludePatterns?: string[];
  customPatterns?: Record<string, string[]>;
  enableCache?: boolean;
  cacheDirectory?: string;
  metricsEnabled?: boolean;
  maxFileSize?: number; // Maximum file size in bytes to analyze
  timeout?: number; // Analysis timeout in milliseconds
  parallel?: boolean; // Enable parallel processing
  maxWorkers?: number; // Maximum number of parallel workers
  enableAI?: boolean; // Enable AI-powered analysis enhancements
  aiProviders?: string[]; // Specific AI providers to use
  aiCacheEnabled?: boolean; // Enable AI response caching
}

export interface LanguageDetection {
  language: string;
  confidence: number;
  frameworks: FrameworkDetection[];
  files: string[];
}

export interface FrameworkDetection {
  name: string;
  version?: string;
  confidence: number;
  patterns: string[];
  configFiles?: string[];
  dependencies?: string[];
  metadata?: Record<string, any>;
}

export interface ComponentDiscovery {
  totalFiles: number;
  analyzedFiles: number;
  skippedFiles: number;
  components: ComponentNode[];
  frameworkComponents?: FrameworkComponent[];
  libraries?: LibraryInfo[];
}

export interface FrameworkComponent {
  type: string;
  pattern: string;
  instances: string[];
  framework: string;
}

export interface LibraryInfo {
  name: string;
  version: string;
  type: 'ui' | 'utility' | 'data' | 'network' | 'testing' | 'build' | 'other';
  usage: string[];
  critical: boolean;
}

// Base abstract class that all language/framework analyzers extend
export abstract class BaseAnalyzer {
  protected projectPath: string = '';
  protected options: AnalyzerOptions = {};
  protected frameworkPatterns: Map<string, FrameworkPattern> = new Map();
  protected callGraph: CallGraph | null = null;
  protected databaseConnections: DatabaseConnection[] = [];
  protected testCoverage: TestCoverage | null = null;
  protected metrics: MetricsCollector;
  protected cache: CacheManager;
  protected startTime: number = 0;
  protected analysisId: string = '';
  protected errors: AnalyzerError[] = [];
  protected warnings: string[] = [];
  protected frameworkDetector: FrameworkDetector;
  protected entryExitDetector: EntryExitDetector;

  constructor() {
    this.initializeFrameworkPatterns();
    this.metrics = new MetricsCollector();
    this.cache = new CacheManager();
    this.analysisId = this.generateAnalysisId();
    this.frameworkDetector = new FrameworkDetector();
    this.entryExitDetector = new EntryExitDetector();
  }

  private generateAnalysisId(): string {
    return `analysis_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  // Main entry point - orchestrates the entire analysis process
  async analyzeRepository(repositoryPath: string, options: AnalyzerOptions = {}): Promise<ArchitectureBlueprint> {
    this.startTime = Date.now();
    this.projectPath = repositoryPath;
    this.options = this.validateOptions(options);
    this.errors = [];
    this.warnings = [];

    // Validate repository path
    await this.validateRepositoryPath(repositoryPath);

    // Initialize cache if enabled
    if (this.options.enableCache) {
      await this.cache.initialize(this.options.cacheDirectory || path.join(repositoryPath, '.unravl-cache'));
    }

    console.log(`🔍 Starting ${this.getAnalyzerName()} analysis of: ${repositoryPath}`);
    this.metrics.startAnalysis(this.analysisId, repositoryPath);
    
    // Start telemetry span
    const span = telemetry.createSpan('analyzer.analyzeRepository');
    
    // Emit analysis start event
    telemetry.emit({
      type: 'analysis_started',
      source: { 
        analyzer: this.getAnalyzerName()
      },
      data: {
        repositoryPath,
        totalFiles: 0,
        options: this.options
      }
    });

    try {
      // Step 1: Detect if this analyzer can handle this project
      const detection = await this.wrapWithMetrics('language_detection', 
        () => this.detectLanguageAndFramework()
      );
      
      if (detection.confidence < 0.5) {
        throw new ValidationError(
          `${this.getAnalyzerName()} analyzer not suitable for this project`,
          { confidence: detection.confidence, requiredConfidence: 0.5 }
        );
      }

      // Step 2: Discover and classify all files
      const discovery = await this.wrapWithMetrics('component_discovery',
        () => this.discoverComponents()
      );
      console.log(`📁 Discovered ${discovery.totalFiles} files, analyzed ${discovery.analyzedFiles}, found ${discovery.components.length} components`);

      // Step 3: Analyze relationships and dependencies
      const connections = await this.wrapWithMetrics('connection_analysis',
        () => this.analyzeConnections(discovery.components)
      );
      console.log(`🔗 Found ${connections.length} connections`);

      // Step 4: Identify architecture patterns and entry points
      const entryPoints = await this.wrapWithMetrics('entry_point_identification',
        () => this.identifyEntryPoints(discovery.components)
      );
      console.log(`🚪 Identified ${entryPoints.length} entry points`);

      // Step 5: Assess risks and complexity
      const riskAreas = await this.wrapWithMetrics('risk_assessment',
        () => this.assessRisks(discovery.components, connections)
      );

      // Step 5.5: Identify exit points
      const exitPoints = await this.wrapWithMetrics('exit_point_identification',
        () => this.identifyExitPoints(discovery.components)
      );
      console.log(`🚪 Identified ${exitPoints.length} exit points`);

      // Step 5.6: Generate call graph
      this.callGraph = await this.wrapWithMetrics('call_graph_generation',
        () => this.generateCallGraph(discovery.components)
      );
      console.log(`📊 Generated call graph with ${this.callGraph?.nodes.length || 0} nodes`);

      // Step 5.7: Analyze database connections
      this.databaseConnections = await this.wrapWithMetrics('database_analysis',
        () => this.analyzeDatabaseConnections(discovery.components)
      );
      console.log(`🗄️ Found ${this.databaseConnections.length} database connections`);

      // Step 5.8: Analyze test coverage
      this.testCoverage = await this.wrapWithMetrics('test_coverage_analysis',
        () => this.analyzeTestCoverage(discovery.components)
      );
      console.log(`✅ Test coverage: ${this.testCoverage?.overall || 0}%`);

      // Step 6: Generate final blueprint
      let blueprint: ArchitectureBlueprint = {
        projectName: await this.getProjectName(),
        framework: detection.frameworks[0]?.name || detection.language,
        components: discovery.components,
        connections,
        entryPoints,
        exitPoints,
        orphanedComponents: this.identifyOrphanedComponents(discovery.components),
        riskAreas,
        metadata: await this.generateProjectMetadata(discovery, detection),
        technologyStack: await this.analyzeTechnologyStack(detection),
        dependencies: await this.analyzeDependencies(),
        databaseInfo: await this.analyzeDatabaseInfo(),
        apiEndpoints: await this.analyzeAPIEndpoints(discovery.components),
        securityAnalysis: await this.analyzeSecurityInfo(),
        testingInfo: await this.analyzeTestingInfo(),
        deploymentInfo: await this.analyzeDeploymentInfo()
      };

      // Record analysis completion
      const analysisTime = Date.now() - this.startTime;
      this.metrics.completeAnalysis(this.analysisId, analysisTime, blueprint);
      
      // Emit analysis completed event
      telemetry.emit({
        type: 'analysis_completed',
        source: { 
          analyzer: this.getAnalyzerName()
        },
        data: {
          success: true,
          componentsFound: blueprint.components.length,
          connectionsFound: blueprint.connections.length,
          entryPointsFound: blueprint.entryPoints.length,
          exitPointsFound: blueprint.exitPoints.length,
          orphanedComponents: blueprint.orphanedComponents.length,
          riskAreas: blueprint.riskAreas.length,
          duration: analysisTime,
          errors: []
        }
      });

      // Save to cache if enabled
      if (this.options.enableCache) {
        await this.cache.saveBlueprint(this.analysisId, blueprint);
      }

      console.log(`✅ ${this.getAnalyzerName()} analysis complete: ${blueprint.components.length} components, ${blueprint.connections.length} connections`);
      console.log(`⏱️ Analysis took ${(analysisTime / 1000).toFixed(2)} seconds`);
      
      if (this.warnings.length > 0) {
        console.log(`⚠️ ${this.warnings.length} warnings encountered during analysis`);
      }

      // AI Enhancement Phase
      if (this.options.enableAI) {
        try {
          console.log('🤖 Enhancing blueprint with AI analysis...');
          blueprint = await aiAnalyzer.enhanceBlueprint(blueprint);
          console.log('✅ AI enhancement completed');
        } catch (error) {
          console.warn('⚠️ AI enhancement failed, continuing with basic analysis:', error);
          this.warnings.push(`AI enhancement failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      span.end();
      return blueprint;

    } catch (error) {
      const analysisTime = Date.now() - this.startTime;
      this.metrics.failAnalysis(this.analysisId, error instanceof Error ? error : new Error(String(error)), analysisTime);
      
      // Emit analysis error event
      telemetry.emit({
        type: 'error_occurred',
        source: { 
          analyzer: this.getAnalyzerName()
        },
        data: {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          duration: analysisTime
        }
      });
      
      span.end();
      
      if (error instanceof AnalyzerError) {
        throw error;
      }
      
      throw new AnalyzerError(
        `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        'ANALYSIS_FAILED',
        { analysisId: this.analysisId, projectPath: repositoryPath, error }
      );
    }
  }

  // Abstract methods that each analyzer must implement
  abstract getAnalyzerName(): string;
  abstract getSupportedLanguages(): string[];
  abstract getSupportedFrameworks(): string[];
  
  protected abstract detectLanguageAndFramework(): Promise<LanguageDetection>;
  protected abstract discoverComponents(): Promise<ComponentDiscovery>;
  protected abstract analyzeConnections(components: ComponentNode[]): Promise<Connection[]>;
  protected abstract assessRisks(components: ComponentNode[], connections: Connection[]): Promise<RiskArea[]>;
  protected abstract generateCallGraph(components: ComponentNode[]): Promise<CallGraph>;
  protected abstract analyzeDatabaseConnections(components: ComponentNode[]): Promise<DatabaseConnection[]>;
  protected abstract analyzeTestCoverage(components: ComponentNode[]): Promise<TestCoverage | null>;
  
  // Default implementations using enhanced detectors
  protected async identifyEntryPoints(components: ComponentNode[]): Promise<EntryPoint[]> {
    const span = telemetry.createSpan('analyzer.identifyEntryPoints');
    
    try {
      const entryPoints = await this.entryExitDetector.detectEntryPoints(components, this.projectPath);
      span.end();
      return entryPoints;
    } catch (error) {
      telemetry.emit({
        type: 'error_occurred',
        source: { 
          analyzer: this.getAnalyzerName(),
          component: 'entry-point-detection' 
        },
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      
      span.end();
      return [];
    }
  }
  
  protected async identifyExitPoints(components: ComponentNode[]): Promise<ExitPoint[]> {
    const span = telemetry.createSpan('analyzer.identifyExitPoints');
    
    try {
      const exitPoints = await this.entryExitDetector.detectExitPoints(components, this.projectPath);
      span.end();
      return exitPoints;
    } catch (error) {
      telemetry.emit({
        type: 'error_occurred',
        source: { 
          analyzer: this.getAnalyzerName(),
          component: 'exit-point-detection' 
        },
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      
      span.end();
      return [];
    }
  }

  // Common helper methods that can be overridden by specific analyzers
  protected async getProjectName(): Promise<string> {
    const packageJsonPath = `${this.projectPath}/package.json`;
    try {
      const fs = await import('fs-extra');
      const packageJson = await fs.readJSON(packageJsonPath);
      return packageJson.name || this.getDefaultProjectName();
    } catch {
      return this.getDefaultProjectName();
    }
  }

  private getDefaultProjectName(): string {
    const path = require('path');
    return path.basename(this.projectPath);
  }

  protected identifyOrphanedComponents(components: ComponentNode[]): string[] {
    return components
      .filter(comp => 
        comp.dependencies.length === 0 && 
        comp.dependents.length === 0 && 
        !comp.metadata.isEntry
      )
      .map(comp => comp.id);
  }

  protected async generateProjectMetadata(
    discovery: ComponentDiscovery, 
    detection: LanguageDetection
  ): Promise<ProjectMetadata> {
    const avgComplexity = discovery.components.length > 0
      ? discovery.components.reduce((sum, c) => sum + c.metadata.complexity, 0) / discovery.components.length
      : 0;

    return {
      totalComponents: discovery.components.length,
      frameworkVersion: detection.frameworks[0]?.version || 'unknown',
      analysisDate: new Date(),
      repositoryPath: this.projectPath,
      entryPointsCount: 0, // Will be set after entry point analysis
      orphanedCount: 0,   // Will be set after orphan analysis  
      complexityAverage: avgComplexity,
      primaryLanguage: detection.language,
      languageDistribution: await this.calculateLanguageDistribution(),
      codebaseSize: await this.calculateCodebaseSize(),
      aiGeneratedSummary: undefined // TODO: Implement AI summary
    };
  }

  // Validation methods
  private validateOptions(options: AnalyzerOptions): AnalyzerOptions {
    const defaults: AnalyzerOptions = {
      includeTests: true,
      maxDepth: 10,
      excludePatterns: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
      enableCache: true,
      metricsEnabled: true,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      timeout: 5 * 60 * 1000, // 5 minutes
      parallel: false,
      maxWorkers: 4,
      enableAI: false, // Default to disabled for performance
      aiProviders: ['claude', 'openai', 'fallback'],
      aiCacheEnabled: true
    };

    const merged = { ...defaults, ...options };

    // Validate numeric values
    if (merged.maxDepth! < 1 || merged.maxDepth! > 100) {
      throw new ValidationError('maxDepth must be between 1 and 100', { maxDepth: merged.maxDepth });
    }

    if (merged.maxFileSize! < 0) {
      throw new ValidationError('maxFileSize must be non-negative', { maxFileSize: merged.maxFileSize });
    }

    if (merged.timeout! < 1000) {
      throw new ValidationError('timeout must be at least 1000ms', { timeout: merged.timeout });
    }

    if (merged.maxWorkers! < 1 || merged.maxWorkers! > 16) {
      throw new ValidationError('maxWorkers must be between 1 and 16', { maxWorkers: merged.maxWorkers });
    }

    return merged;
  }

  private async validateRepositoryPath(repositoryPath: string): Promise<void> {
    try {
      const stats = await fs.stat(repositoryPath);
      if (!stats.isDirectory()) {
        throw new FileSystemError(
          `Repository path is not a directory: ${repositoryPath}`,
          'NOT_DIRECTORY'
        );
      }
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        throw new FileSystemError(
          `Repository path does not exist: ${repositoryPath}`,
          'PATH_NOT_FOUND'
        );
      }
      throw error;
    }

    // Check for minimum required permissions
    try {
      await fs.access(repositoryPath, fs.constants.R_OK);
    } catch (error) {
      throw new FileSystemError(
        `No read permission for repository: ${repositoryPath}`,
        'PERMISSION_DENIED'
      );
    }
  }

  // Metrics wrapper
  protected async wrapWithMetrics<T>(
    operationName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const startTime = Date.now();
    
    try {
      const result = await operation();
      const duration = Date.now() - startTime;
      
      if (this.options.metricsEnabled) {
        this.metrics.recordOperation(operationName, duration, true);
      }
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      if (this.options.metricsEnabled) {
        this.metrics.recordOperation(operationName, duration, false, error as Error);
      }
      
      throw error;
    }
  }

  // Utility methods for file system operations
  protected async findFiles(patterns: string[], excludePatterns: string[] = []): Promise<string[]> {
    const { glob } = await import('glob');
    const allFiles: string[] = [];

    for (const pattern of patterns) {
      const files = await glob(pattern, {
        cwd: this.projectPath,
        ignore: excludePatterns,
        absolute: true
      });
      allFiles.push(...files);
    }

    return [...new Set(allFiles)]; // Remove duplicates
  }

  protected async readFile(filePath: string): Promise<string> {
    try {
      // Check file size before reading
      const stats = await fs.stat(filePath);
      
      if (this.options.maxFileSize && stats.size > this.options.maxFileSize) {
        this.warnings.push(`File ${filePath} exceeds maximum size (${stats.size} bytes), skipping`);
        throw new FileSystemError(
          `File exceeds maximum size: ${filePath}`,
          'FILE_TOO_LARGE',
          { filePath, size: stats.size, maxSize: this.options.maxFileSize }
        );
      }

      // Check cache first if enabled
      if (this.options.enableCache) {
        const cachedContent = await this.cache.getFileContent(filePath, stats.mtime);
        if (cachedContent) {
          return cachedContent;
        }
      }

      const content = await fs.readFile(filePath, 'utf-8');

      // Cache the content if enabled
      if (this.options.enableCache) {
        await this.cache.saveFileContent(filePath, content, stats.mtime);
      }

      return content;
    } catch (error) {
      if (error instanceof FileSystemError) {
        throw error;
      }
      
      throw new FileSystemError(
        `Failed to read file: ${filePath}`,
        'READ_ERROR',
        { filePath, error }
      );
    }
  }

  protected generateComponentId(filePath: string): string {
    const path = require('path');
    const relativePath = path.relative(this.projectPath, filePath);
    return relativePath.replace(/[^a-zA-Z0-9]/g, '_');
  }

  protected calculateComplexity(content: string): number {
    // Universal complexity calculation based on control flow
    const complexityPatterns = [
      /\bif\b/g, /\belse\b/g, /\bwhile\b/g, /\bfor\b/g,
      /\bswitch\b/g, /\bcase\b/g, /\btry\b/g, /\bcatch\b/g,
      /\bthrow\b/g, /\breturn\b/g, /\b&&\b/g, /\b\|\|\b/g,
      /\?\s*:/g, // Ternary operators
    ];

    let complexity = 1; // Base complexity
    for (const pattern of complexityPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return Math.min(complexity, 10); // Cap at 10
  }

  // New framework detection methods
  protected initializeFrameworkPatterns(): void {
    // Common framework patterns - override in specific analyzers
    this.frameworkPatterns.set('express', {
      name: 'Express',
      files: ['app.js', 'server.js', 'index.js'],
      dependencies: ['express'],
      patterns: [
        /app\.use\(/,
        /app\.get\(/,
        /app\.post\(/,
        /express\(\)/,
        /Router\(\)/
      ],
      configPatterns: [
        'app.set(',
        'app.engine(',
        'express.static('
      ]
    });

    this.frameworkPatterns.set('react', {
      name: 'React',
      files: ['App.jsx', 'App.tsx', 'index.jsx', 'index.tsx'],
      dependencies: ['react', 'react-dom'],
      patterns: [
        /import.*React/,
        /from ['"]react['"]/,
        /useState\(/,
        /useEffect\(/,
        /\.jsx$/,
        /<[A-Z][a-zA-Z]*.*\/>/
      ],
      configPatterns: [
        'ReactDOM.render(',
        'ReactDOM.createRoot(',
        'createElement('
      ]
    });

    this.frameworkPatterns.set('nestjs', {
      name: 'NestJS',
      files: ['main.ts', 'app.module.ts'],
      dependencies: ['@nestjs/core', '@nestjs/common'],
      patterns: [
        /@Module\(/,
        /@Controller\(/,
        /@Injectable\(/,
        /@Get\(/,
        /@Post\(/,
        /NestFactory\.create/
      ],
      configPatterns: [
        'imports:',
        'providers:',
        'controllers:',
        'exports:'
      ]
    });

    this.frameworkPatterns.set('django', {
      name: 'Django',
      files: ['manage.py', 'settings.py', 'urls.py', 'wsgi.py'],
      dependencies: ['django'],
      patterns: [
        /from django/,
        /import django/,
        /django\.contrib/,
        /path\(/,
        /urlpatterns/
      ],
      configPatterns: [
        'INSTALLED_APPS',
        'MIDDLEWARE',
        'DATABASES',
        'DEBUG ='
      ]
    });

    this.frameworkPatterns.set('spring', {
      name: 'Spring Boot',
      files: ['pom.xml', 'build.gradle', 'application.properties', 'application.yml'],
      dependencies: ['spring-boot-starter'],
      patterns: [
        /@SpringBootApplication/,
        /@RestController/,
        /@Service/,
        /@Repository/,
        /@Component/,
        /@Autowired/
      ],
      configPatterns: [
        'spring.datasource',
        'server.port',
        'spring.jpa'
      ]
    });
  }

  protected async detectFramework(content: string, filePath: string): Promise<FrameworkDetection | null> {
    let bestMatch: FrameworkDetection | null = null;
    let highestConfidence = 0;

    for (const [key, pattern] of this.frameworkPatterns) {
      let confidence = 0;
      const matches: string[] = [];

      // Check file patterns
      const fileName = require('path').basename(filePath);
      if (pattern.files?.includes(fileName)) {
        confidence += 0.3;
        matches.push(`File: ${fileName}`);
      }

      // Check code patterns
      for (const regex of pattern.patterns || []) {
        if (regex.test(content)) {
          confidence += 0.2;
          matches.push(`Pattern: ${regex.source}`);
        }
      }

      // Check config patterns
      for (const configPattern of pattern.configPatterns || []) {
        if (content.includes(configPattern)) {
          confidence += 0.15;
          matches.push(`Config: ${configPattern}`);
        }
      }

      if (confidence > highestConfidence) {
        highestConfidence = confidence;
        bestMatch = {
          name: pattern.name,
          version: await this.detectFrameworkVersion(pattern.name, content),
          confidence,
          patterns: matches,
          configFiles: pattern.files,
          dependencies: pattern.dependencies
        };
      }
    }

    return bestMatch;
  }

  protected async detectFrameworkVersion(framework: string, content: string): Promise<string | undefined> {
    // Framework-specific version detection
    const versionPatterns: Record<string, RegExp> = {
      'Express': /"express":\s*"[~^]?([0-9.]+)"/,
      'React': /"react":\s*"[~^]?([0-9.]+)"/,
      'NestJS': /"@nestjs\/core":\s*"[~^]?([0-9.]+)"/,
      'Django': /Django==([0-9.]+)/,
      'Spring Boot': /<version>([0-9.]+)<\/version>/
    };

    const pattern = versionPatterns[framework];
    if (pattern) {
      const match = content.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return undefined;
  }

  protected async extractFunctions(content: string, language: string): Promise<FunctionInfo[]> {
    const functions: FunctionInfo[] = [];
    
    // Language-specific function patterns
    const patterns: Record<string, RegExp> = {
      javascript: /(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function))/g,
      typescript: /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\s*\{)/g,
      python: /(?:def\s+(\w+)\s*\([^)]*\)|async\s+def\s+(\w+)\s*\([^)]*\))/g,
      java: /(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g
    };

    const pattern = patterns[language.toLowerCase()];
    if (!pattern) return functions;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const functionName = match[1] || match[2];
      if (functionName) {
        const functionInfo: FunctionInfo = {
          name: functionName,
          signature: match[0],
          parameters: this.extractParameters(match[0]),
          returnType: this.extractReturnType(match[0], language),
          complexity: this.calculateFunctionComplexity(content, match.index),
          lineCount: this.calculateFunctionLineCount(content, match.index),
          isPublic: /public/.test(match[0]),
          isAsync: /async/.test(match[0]),
          isStatic: /static/.test(match[0]),
          calls: [],
          calledBy: []
        };
        functions.push(functionInfo);
      }
    }

    return functions;
  }

  protected extractParameters(signature: string): any[] {
    const paramMatch = signature.match(/\(([^)]*)\)/);
    if (!paramMatch || !paramMatch[1]) return [];

    const params = paramMatch[1].split(',').map(p => p.trim()).filter(p => p);
    return params.map(param => {
      const parts = param.split(/[:\s=]/);
      return {
        name: parts[0].replace(/[^\w]/g, ''),
        type: parts[1] || 'any',
        isOptional: param.includes('?') || param.includes('='),
        defaultValue: param.includes('=') ? param.split('=')[1]?.trim() : undefined
      };
    });
  }

  protected extractReturnType(signature: string, language: string): string {
    if (language === 'typescript' || language === 'java') {
      const match = signature.match(/\)\s*:\s*([^{]+)/);
      return match ? match[1].trim() : 'void';
    }
    if (language === 'python') {
      const match = signature.match(/->\s*([^:]+)/);
      return match ? match[1].trim() : 'Any';
    }
    return 'unknown';
  }

  protected calculateFunctionComplexity(content: string, startIndex: number): number {
    // Find the function body
    let braceCount = 0;
    let inFunction = false;
    let functionContent = '';
    
    for (let i = startIndex; i < content.length; i++) {
      if (content[i] === '{') {
        braceCount++;
        inFunction = true;
      } else if (content[i] === '}') {
        braceCount--;
        if (braceCount === 0 && inFunction) {
          break;
        }
      }
      if (inFunction) {
        functionContent += content[i];
      }
    }

    return this.calculateComplexity(functionContent);
  }

  protected calculateFunctionLineCount(content: string, startIndex: number): number {
    let braceCount = 0;
    let inFunction = false;
    let lineCount = 0;
    
    for (let i = startIndex; i < content.length; i++) {
      if (content[i] === '{') {
        braceCount++;
        inFunction = true;
      } else if (content[i] === '}') {
        braceCount--;
        if (braceCount === 0 && inFunction) {
          break;
        }
      }
      if (inFunction && content[i] === '\n') {
        lineCount++;
      }
    }

    return lineCount;
  }

  protected async detectDatabaseConnections(content: string): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    
    // Common database connection patterns
    const patterns = [
      {
        type: 'postgresql',
        regex: /(?:postgres(?:ql)?:\/\/|DATABASE_URL.*postgres)/i,
        extract: /(?:host[=:]\s*['"]?([^'"\s,;]+)|postgres:\/\/[^:]+:[^@]+@([^:\/]+))/
      },
      {
        type: 'mysql',
        regex: /(?:mysql:\/\/|mysql\.createConnection)/i,
        extract: /(?:host[=:]\s*['"]?([^'"\s,;]+)|mysql:\/\/[^:]+:[^@]+@([^:\/]+))/
      },
      {
        type: 'mongodb',
        regex: /(?:mongodb(?:\+srv)?:\/\/|MongoClient)/i,
        extract: /mongodb(?:\+srv)?:\/\/([^:\/]+)/
      },
      {
        type: 'redis',
        regex: /(?:redis:\/\/|createClient.*redis)/i,
        extract: /(?:host[=:]\s*['"]?([^'"\s,;]+)|redis:\/\/([^:\/]+))/
      },
      {
        type: 'sqlite',
        regex: /(?:sqlite3?:\/\/|sqlite3\.connect)/i,
        extract: /(?:sqlite3?:\/\/([^'"\s]+)|database[=:]\s*['"]?([^'"\s,;]+))/
      }
    ];

    for (const pattern of patterns) {
      if (pattern.regex.test(content)) {
        const match = content.match(pattern.extract);
        const connection: DatabaseConnection = {
          id: `db_${pattern.type}_${connections.length}`,
          name: pattern.type,
          type: pattern.type as any,
          host: match ? match[1] || match[2] : undefined,
          componentIds: [],
          usage: []
        };
        connections.push(connection);
      }
    }

    return connections;
  }

  protected async analyzeEndpointControllers(content: string, framework: string): Promise<any[]> {
    const endpoints: any[] = [];
    
    // Framework-specific endpoint patterns
    const patterns: Record<string, RegExp[]> = {
      'Express': [
        /app\.(get|post|put|delete|patch)\(['"]([^'"]+)['"].*?(?:,\s*(?:async\s*)?(?:function\s*)?(\w+)|,\s*(?:async\s*)?\()/g,
        /router\.(get|post|put|delete|patch)\(['"]([^'"]+)['"].*?(?:,\s*(?:async\s*)?(?:function\s*)?(\w+)|,\s*(?:async\s*)?\()/g
      ],
      'NestJS': [
        /@(Get|Post|Put|Delete|Patch)\(['"]?([^'"\)]*)['"]?\)\s*(?:async\s+)?(\w+)/g,
        /@Controller\(['"]([^'"]+)['"]\)/g
      ],
      'Django': [
        /path\(['"]([^'"]+)['"],\s*([\w.]+)/g,
        /url\(r?['"]([^'"]+)['"],\s*([\w.]+)/g
      ],
      'Spring Boot': [
        /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\(['"]([^'"]+)['"]\)\s*public\s+\w+\s+(\w+)/g,
        /@RequestMapping\(['"]([^'"]+)['"]\)/g
      ]
    };

    const frameworkPatterns = patterns[framework];
    if (!frameworkPatterns) return endpoints;

    for (const pattern of frameworkPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        endpoints.push({
          method: match[1]?.toUpperCase() || 'GET',
          path: match[2] || match[1],
          handler: match[3] || 'anonymous',
          controller: this.extractControllerName(content, match.index)
        });
      }
    }

    return endpoints;
  }

  protected extractControllerName(content: string, position: number): string {
    // Look backwards for class/controller declaration
    const before = content.substring(0, position);
    const classMatch = before.match(/(?:class|controller)\s+(\w+)/i);
    return classMatch ? classMatch[1] : 'UnknownController';
  }

  protected async calculateTestCoverageMetrics(testFiles: string[]): Promise<TestCoverage> {
    // Basic coverage calculation - override in specific analyzers
    const coverage: TestCoverage = {
      overall: 0,
      lines: { covered: 0, total: 0, percentage: 0 },
      branches: { covered: 0, total: 0, percentage: 0 },
      functions: { covered: 0, total: 0, percentage: 0 },
      statements: { covered: 0, total: 0, percentage: 0 },
      byComponent: {},
      byType: {},
      uncoveredFiles: []
    };

    // This would be implemented with actual coverage tools
    // For now, return a basic structure
    return coverage;
  }

  protected async calculateLanguageDistribution(): Promise<Record<string, number>> {
    const distribution: Record<string, number> = {};
    const extensions: Record<string, string> = {
      '.js': 'JavaScript',
      '.ts': 'TypeScript',
      '.jsx': 'JavaScript',
      '.tsx': 'TypeScript',
      '.py': 'Python',
      '.java': 'Java',
      '.cs': 'C#',
      '.go': 'Go',
      '.rb': 'Ruby',
      '.php': 'PHP'
    };

    const files = await this.findFiles(['**/*'], ['node_modules/**', '**/dist/**', '**/build/**']);
    
    for (const file of files) {
      const ext = require('path').extname(file).toLowerCase();
      if (extensions[ext]) {
        distribution[extensions[ext]] = (distribution[extensions[ext]] || 0) + 1;
      }
    }

    return distribution;
  }

  protected async calculateCodebaseSize(): Promise<any> {
    let totalLines = 0;
    let codeLines = 0;
    let commentLines = 0;
    let blankLines = 0;

    const files = await this.findFiles(
      ['**/*.{js,ts,jsx,tsx,py,java,cs,go,rb,php}'],
      ['node_modules/**', '**/dist/**', '**/build/**']
    );

    for (const file of files) {
      try {
        const content = await this.readFile(file);
        const lines = content.split('\n');
        totalLines += lines.length;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            blankLines++;
          } else if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            commentLines++;
          } else {
            codeLines++;
          }
        }
      } catch (error) {
        // Skip files that can't be read
      }
    }

    return { totalLines, codeLines, commentLines, blankLines };
  }

  // Default implementations for new abstract methods
  protected async analyzeTechnologyStack(detection: LanguageDetection): Promise<TechnologyStack> {
    const frameworks = detection.frameworks.map(f => ({
      name: f.name,
      version: f.version || 'unknown',
      type: 'web' as const,
      usage: 'primary' as const,
      conventions: [],
      patterns: f.patterns,
      configFiles: f.configFiles,
      detectionConfidence: f.confidence,
      metadata: f.metadata
    }));

    return {
      primaryFramework: frameworks[0] || null,
      additionalFrameworks: frameworks.slice(1),
      languages: [{
        name: detection.language,
        fileCount: detection.files.length,
        lineCount: 0,
        percentage: 100
      }],
      buildTools: [],
      testingFrameworks: [],
      databases: [],
      messageQueues: [],
      caching: [],
      authentication: [],
      deployment: []
    } as any;
  }

  protected async analyzeDependencies(): Promise<DependencyAnalysis> {
    // Default implementation - override in specific analyzers
    return {
      totalCount: 0,
      directDependencies: [],
      devDependencies: [],
      peerDependencies: [],
      vulnerabilities: [],
      outdated: [],
      unused: [],
      licenseCompliance: []
    };
  }

  protected async analyzeDatabaseInfo(): Promise<DatabaseAnalysis | undefined> {
    if (this.databaseConnections.length === 0) {
      return undefined;
    }

    const firstConnection = this.databaseConnections[0];
    return {
      type: firstConnection.type,
      connectionMethod: 'driver' as const,
      host: firstConnection.host,
      port: firstConnection.port,
      database: firstConnection.database,
      connections: this.databaseConnections,
      schema: undefined,
      migrations: [],
      queries: [],
      performance: {
        avgQueryTime: 0,
        slowQueries: [],
        nPlusOneProblems: [],
        indexUsage: {}
      }
    };
  }

  protected async analyzeAPIEndpoints(components: ComponentNode[]): Promise<APIEndpoint[]> {
    // Default implementation - override in specific analyzers
    return [];
  }

  protected async analyzeSecurityInfo(): Promise<SecurityAnalysis> {
    // Default implementation - override in specific analyzers
    return {
      vulnerabilities: [],
      authenticationMethods: [],
      authorizationPatterns: [],
      dataEncryption: [],
      inputValidation: [],
      securityHeaders: [],
      secrets: []
    };
  }

  protected async analyzeTestingInfo(): Promise<TestingInfo> {
    // Default implementation - override in specific analyzers
    return {
      frameworks: [],
      coverage: this.testCoverage || {
        overall: 0,
        lines: { covered: 0, total: 0, percentage: 0 },
        branches: { covered: 0, total: 0, percentage: 0 },
        functions: { covered: 0, total: 0, percentage: 0 },
        statements: { covered: 0, total: 0, percentage: 0 },
        byComponent: {},
        byType: {},
        uncoveredFiles: []
      },
      testTypes: [],
      testFiles: [],
      totalTests: 0,
      passingTests: 0,
      failingTests: 0,
      skippedTests: 0,
      testSuites: []
    };
  }

  protected async analyzeDeploymentInfo(): Promise<DeploymentInfo> {
    // Default implementation - override in specific analyzers
    return {
      platform: 'unknown',
      containerization: { type: 'none' },
      cicd: {
        platform: 'unknown',
        configFile: '',
        stages: [],
        deploymentStrategy: 'unknown',
        automated: false
      },
      monitoring: {
        tools: [],
        metrics: [],
        logging: {
          level: 'info',
          destination: 'unknown',
          structured: false,
          aggregation: false
        },
        alerting: {
          platform: 'unknown',
          rules: [],
          channels: []
        }
      },
      scaling: {
        type: 'horizontal',
        automatic: false,
        metrics: [],
        limits: {
          minInstances: 1,
          maxInstances: 1,
          cpu: '100%',
          memory: '100%'
        }
      }
    };
  }
}

export interface FrameworkPattern {
  name: string;
  files?: string[];
  dependencies?: string[];
  patterns?: RegExp[];
  configPatterns?: string[];
}

// Factory for creating the appropriate analyzer based on project detection
export class AnalyzerFactory {
  private static analyzers: BaseAnalyzer[] = [];

  static registerAnalyzer(analyzer: BaseAnalyzer): void {
    this.analyzers.push(analyzer);
  }

  static async createAnalyzer(repositoryPath: string): Promise<BaseAnalyzer> {
    const detections: Array<{analyzer: BaseAnalyzer, confidence: number}> = [];

    // Try each analyzer to see which one can handle this project
    for (const analyzer of this.analyzers) {
      try {
        // Set the project path for detection
        analyzer['projectPath'] = repositoryPath;
        const detection = await analyzer['detectLanguageAndFramework'].call(analyzer);
        detections.push({ analyzer, confidence: detection.confidence });
      } catch (error) {
        // This analyzer can't handle the project, try the next one
        continue;
      }
    }

    // Sort by confidence and pick the best match
    detections.sort((a, b) => b.confidence - a.confidence);
    
    if (detections.length > 0 && detections[0].confidence > 0.3) {
      console.log(`Selected ${detections[0].analyzer.getAnalyzerName()} analyzer with ${(detections[0].confidence * 100).toFixed(0)}% confidence`);
      return detections[0].analyzer;
    }

    throw new Error('No suitable analyzer found for this project type');
  }

  static getAvailableAnalyzers(): string[] {
    return this.analyzers.map(analyzer => analyzer.getAnalyzerName());
  }

  static async detectProjectStack(repositoryPath: string): Promise<{
    languages: string[];
    frameworks: string[];
    databases: string[];
    tools: string[];
  }> {
    const stack = {
      languages: [] as string[],
      frameworks: [] as string[],
      databases: [] as string[],
      tools: [] as string[]
    };

    // Detect from package files
    const fs = await import('fs-extra');
    const path = require('path');

    // Check package.json
    try {
      const packageJson = await fs.readJSON(path.join(repositoryPath, 'package.json'));
      stack.languages.push('JavaScript/TypeScript');
      
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (deps.express) stack.frameworks.push('Express');
      if (deps.react) stack.frameworks.push('React');
      if (deps['@nestjs/core']) stack.frameworks.push('NestJS');
      if (deps.vue) stack.frameworks.push('Vue');
      if (deps['@angular/core']) stack.frameworks.push('Angular');
      if (deps.next) stack.frameworks.push('Next.js');
      if (deps.jest || deps.mocha) stack.tools.push(deps.jest ? 'Jest' : 'Mocha');
      if (deps.webpack || deps.vite || deps.parcel) {
        stack.tools.push(deps.webpack ? 'Webpack' : deps.vite ? 'Vite' : 'Parcel');
      }
    } catch {}

    // Check requirements.txt / setup.py
    try {
      const requirements = await fs.readFile(path.join(repositoryPath, 'requirements.txt'), 'utf-8');
      stack.languages.push('Python');
      if (requirements.includes('django')) stack.frameworks.push('Django');
      if (requirements.includes('flask')) stack.frameworks.push('Flask');
      if (requirements.includes('fastapi')) stack.frameworks.push('FastAPI');
      if (requirements.includes('pytest')) stack.tools.push('Pytest');
    } catch {}

    // Check pom.xml / build.gradle
    try {
      const pomExists = await fs.pathExists(path.join(repositoryPath, 'pom.xml'));
      const gradleExists = await fs.pathExists(path.join(repositoryPath, 'build.gradle'));
      if (pomExists || gradleExists) {
        stack.languages.push('Java');
        stack.tools.push(pomExists ? 'Maven' : 'Gradle');
      }
    } catch {}

    // Check for database config files
    try {
      const dockerCompose = await fs.readFile(path.join(repositoryPath, 'docker-compose.yml'), 'utf-8');
      if (dockerCompose.includes('postgres')) stack.databases.push('PostgreSQL');
      if (dockerCompose.includes('mysql')) stack.databases.push('MySQL');
      if (dockerCompose.includes('mongo')) stack.databases.push('MongoDB');
      if (dockerCompose.includes('redis')) stack.databases.push('Redis');
    } catch {}

    return stack;
  }
}