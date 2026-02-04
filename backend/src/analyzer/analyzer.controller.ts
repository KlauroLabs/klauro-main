import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitInterceptor } from '../common/interceptors/rate-limit.interceptor';
import { CASAnalyzerService, CASAnalysisRequest } from './services/cas-analyzer.service';
import { PatternDetector } from './patterns/pattern-detector';
import { CASOutput } from './core/orchestrator';
import { CASAnalyzerContribution, CASNode, CASEdge } from '../types/cas.types';
import { ComponentNode, Connection } from '../types';
import { ProjectsService } from '../projects/projects.service';
import { CreateProjectDto } from '../projects/dto/create-project.dto';
import { RepositoryProvider } from '../database/entities/project.entity';
import { AnalysisRun, AnalysisStatus, AnalysisType } from '../database/entities/analysis-run.entity';
import { Component, ComponentType, ArchitecturalLayer } from '../database/entities/component.entity';
import { ComponentConnection, ConnectionType } from '../database/entities/component-connection.entity';
import { EntityManager } from '@mikro-orm/core';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs-extra';

interface AnalysisRequest {
  projectPath: string;
  language: 'python' | 'java' | 'csharp' | 'go' | 'auto';
  options?: {
    maxFileSize?: number;
    excludePatterns?: string[];
    includeTests?: boolean;
    level?: number;
    type?: string;
    nameFilter?: string;
  };
}

interface AnalysisResponse {
  success: boolean;
  cas_version: string;
  analysis_timestamp: string;
  analysis_id: string;
  system: {
    id: string;
    name: string;
    description?: string;
    type: string;
    root_path: string;
  };
  nodes: any[];
  edges: any[];
  entry_points: any[];
  exit_points: any[];
  libraries: any[];
  analyzer_contributions: any[];
  metadata?: any;
  legacy?: {
    components: ComponentNode[];
    connections: Connection[];
    architecture?: any;
    insights?: any;
    infrastructure?: any;
  };
}

@ApiTags('Analyzer')
@Controller('analyze')
// @UseGuards(JwtAuthGuard) // Temporarily disabled for development
@ApiBearerAuth()
@UseInterceptors(RateLimitInterceptor)
export class AnalyzerController {
  private readonly logger = new Logger(AnalyzerController.name);

  constructor(
    private readonly casAnalyzerService: CASAnalyzerService,
    private readonly patternDetector: PatternDetector,
    private readonly projectsService: ProjectsService,
    private readonly em: EntityManager
  ) {}

  @Post('python')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze Python codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzePython(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'python' });
  }

  @Post('java')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze Java codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzeJava(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'java' });
  }

  @Post('csharp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze C# codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzeCSharp(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'csharp' });
  }

  @Post('go')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze Go codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzeGo(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'go' });
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Auto-detect language and analyze codebase' })
  @ApiBody({ type: Object, description: 'Analysis request' })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzeAuto(@Body(new ValidationPipe()) request: AnalysisRequest) {
    return this.analyzeProject({ ...request, language: 'auto' });
  }

  @Post('cas')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Analyze codebase using CAS format' })
  @ApiBody({ type: Object, description: 'CAS analysis request' })
  @ApiResponse({ status: 200, description: 'CAS analysis completed' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async analyzeCAS(@Body(new ValidationPipe()) request: { projectPath: string; options?: any }) {
    return this.analyzeCASProject(request);
  }

  @Get('cas/:analysisId/query')
  @ApiOperation({ summary: 'Query CAS analysis results with progressive disclosure' })
  @ApiResponse({ status: 200, description: 'Filtered CAS results' })
  async queryCAS(
    @Param('analysisId') analysisId: string,
    @Query('level') level?: number,
    @Query('type') type?: string,
    @Query('nameFilter') nameFilter?: string
  ) {
    // In a production system, you would retrieve the CAS output from storage
    // For now, return an error indicating the analysis ID is not found
    throw new NotFoundException(`Analysis ${analysisId} not found. Use the /analyze/cas endpoint first.`);
  }

  @Get('cas/detected-analyzers')
  @ApiOperation({ summary: 'Get list of analyzers that would be detected for a project' })
  @ApiResponse({ status: 200, description: 'List of detected analyzers' })
  async getDetectedAnalyzers(@Query('projectPath') projectPath: string) {
    if (!projectPath) {
      throw new BadRequestException('projectPath query parameter is required');
    }

    try {
      const analyzers = await this.casAnalyzerService.getDetectedAnalyzers(projectPath);
      return {
        projectPath,
        detectedAnalyzers: analyzers.map((a: any) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          version: a.version,
          detectPatterns: a.detectPatterns,
          requires: a.requires,
          enhances: a.enhances
        }))
      };
    } catch (error) {
      this.logger.error(`Failed to detect analyzers: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  @Get('patterns/:projectId')
  @ApiOperation({ summary: 'Get detected patterns for project' })
  @ApiResponse({ status: 200, description: 'Detected patterns' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getPatterns(@Param('projectId') projectId: string) {
    try {
      // In a real implementation, this would fetch from database
      // For now, we'll return a placeholder
      return {
        projectId,
        patterns: [],
        antiPatterns: [],
        architectureType: 'unknown',
        confidenceScore: 0,
        recommendations: [],
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(`Failed to get patterns: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  @Get('performance/:projectId')
  @ApiOperation({ summary: 'Get performance metrics for project' })
  @ApiResponse({ status: 200, description: 'Performance metrics' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getPerformanceMetrics(@Param('projectId') projectId: string) {
    try {
      // In a real implementation, this would fetch from database
      return {
        projectId,
        metrics: {
          complexity: 0,
          maintainability: 0,
          testCoverage: 0,
          technicalDebt: 0,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(`Failed to get performance metrics: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  @Post('python/ast')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parse Python file using AST' })
  @ApiBody({ 
    schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' }
      }
    }
  })
  @ApiResponse({ status: 200, description: 'AST analysis result' })
  async analyzePythonAST(@Body() body: { filePath: string }) {
    try {
      const { filePath } = body;
      
      if (!await fs.pathExists(filePath)) {
        throw new BadRequestException('File not found');
      }

      const scriptPath = path.join(__dirname, 'scripts', 'python_ast_parser.py');
      
      return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python3', [scriptPath, filePath]);
        let output = '';
        let error = '';

        pythonProcess.stdout.on('data', (data) => {
          output += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          error += data.toString();
        });

        pythonProcess.on('close', (code) => {
          if (code !== 0) {
            reject(new BadRequestException(`Python AST parsing failed: ${error}`));
          } else {
            try {
              const result = JSON.parse(output);
              resolve(result);
            } catch (parseError) {
              reject(new BadRequestException('Failed to parse Python AST output'));
            }
          }
        });
      });
    } catch (error) {
      this.logger.error(`Failed to analyze Python AST: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  private async analyzeCASProject(request: CASAnalysisRequest): Promise<CASOutput> {
    const startTime = Date.now();

    try {
      this.logger.log(`Starting CAS analysis for ${request.projectPath}`);

      const casResult = await this.casAnalyzerService.analyzeProject(request);

      const analysisTime = Date.now() - startTime;
      this.logger.log(`CAS analysis completed in ${analysisTime}ms`);
      this.logger.log(`Results: ${casResult.nodes.length} nodes, ${casResult.edges.length} edges`);
      this.logger.log(`Analyzers: ${casResult.analyzer_contributions.map((c: CASAnalyzerContribution) => c.analyzer_name).join(', ')}`);

      return casResult;
    } catch (error) {
      this.logger.error(`CAS analysis failed: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  private async analyzeProject(request: AnalysisRequest): Promise<AnalysisResponse> {
    const startTime = Date.now();

    try {
      const { projectPath, language, options } = request;

      // Validate project path
      if (!await fs.pathExists(projectPath)) {
        throw new BadRequestException('Project path does not exist');
      }

      // Use the CAS analyzer for the actual analysis
      this.logger.log(`Starting CAS-based analysis for ${projectPath}`);
      this.logger.log(`Will run ALL applicable language and framework analyzers`);

      const casResult = await this.casAnalyzerService.analyzeProject({
        projectPath,
        options: {
          includeTests: options?.includeTests || false,
          maxDepth: 5,
          filters: options?.excludePatterns || ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**']
        }
      });

      // Convert CAS results to legacy format for backward compatibility
      const result = this.convertCASToLegacyBlueprint(casResult);
      const composite = this.convertCASToLegacyComposite(casResult);
      
      // Detect patterns
      let patterns = null;
      if (result.components && result.connections) {
        patterns = await this.patternDetector.detectPatterns(
          result.components,
          result.connections,
          this.generateProjectId(projectPath)
        );
      }


      const analysisTime = Date.now() - startTime;

      // Get the detected languages and frameworks from CAS results
      const detectedLanguages = this.extractLanguagesFromCAS(casResult);
      const detectedFrameworks = this.extractFrameworksFromCAS(casResult);
      const primaryLanguage = detectedLanguages[0] || 'unknown';

      // Generate project ID for use in both database persistence and response
      let projectId = this.generateProjectId(projectPath);

      // Persist analysis results to database if persistResults is enabled
      try {

        // Try to find existing project or create a new one
        let project;
        try {
          // For now, use temp organization ID - this should come from auth context in production
          const tempOrgId = '77777777-7777-7777-7777-777777777777';
          project = await this.projectsService.findOne(tempOrgId, projectId);
          this.logger.log(`Found existing project: ${project.name}`);
        } catch (error) {
          // Project doesn't exist, create a new one
          const projectName = path.basename(projectPath);
          const createProjectDto: CreateProjectDto = {
            name: projectName,
            description: `Auto-created from analysis of ${projectPath}`,
            language: primaryLanguage,
            defaultBranch: 'main',
            repositoryProvider: RepositoryProvider.CUSTOM, // For local file system analysis
            repositoryUrl: `file://${projectPath}`, // Store the path as a URL for consistency
          };

          try {
            // Create project with temp user/org IDs - this should come from auth context in production
            // IMPORTANT: Pass the deterministic projectId to ensure consistency across analyses
            project = await this.projectsService.createWithId(
              '77777777-7777-7777-7777-777777777777',
              '88888888-8888-8888-8888-888888888888',
              projectId,
              createProjectDto
            );
            this.logger.log(`Created new project: ${project.name} (${project.id})`);
          } catch (createError) {
            // If creation fails because name already exists, try to find by ID again
            // This handles race conditions or name conflicts
            this.logger.warn(`Failed to create project, trying to find again: ${(createError as Error).message}`);
            project = await this.projectsService.findOne('77777777-7777-7777-7777-777777777777', projectId);
          }
        }

        // Create AnalysisRun record
        const analysisRun = this.em.create(AnalysisRun, {
          project: projectId,
          status: AnalysisStatus.RUNNING,
          type: AnalysisType.MANUAL,
          branch: 'main',
          startedAt: new Date(startTime),
          configuration: options || {},
          metadata: this.convertCASMetadata(casResult) || {},
          blueprint: result // Store the entire blueprint
        } as any);

        analysisRun.start();
        await this.em.persistAndFlush(analysisRun);

        // Create Component records from the blueprint components
        const componentMap = new Map<string, Component>();

        if (result.components && result.components.length > 0) {
          for (const comp of result.components) {
            const component = this.em.create(Component, {
              analysisRun,
              name: comp.name || path.basename(comp.path || ''),
              type: this.mapComponentType(comp.type),
              path: comp.path || '',
              language: comp.language || primaryLanguage,
              framework: comp.framework,
              layer: this.mapArchitecturalLayer(comp.type),
              lineCount: comp.metadata?.lineCount || 0,
              complexity: comp.metadata?.complexity || 0,
              exports: comp.metadata?.exports,
              imports: comp.metadata?.imports,
              httpMethods: comp.metadata?.httpMethods,
              dbQueries: comp.metadata?.dbQueries,
              externalCalls: comp.metadata?.externalCalls,
              isEntry: comp.metadata?.isEntry || false,
              isOrphaned: comp.metadata?.isOrphaned || false,
              responsibilities: comp.metadata?.responsibilities,
              functions: comp.metadata?.functions,
              metadata: comp.metadata || {}
            } as any);

            await this.em.persist(component);
            componentMap.set(comp.id || comp.path || comp.name, component);
          }
        }

        // Create ComponentConnection records from the blueprint connections
        if (result.connections && result.connections.length > 0) {
          for (const conn of result.connections) {
            const fromComponent = componentMap.get(conn.from);
            const toComponent = componentMap.get(conn.to);

            if (fromComponent && toComponent) {
              const connection = this.em.create(ComponentConnection, {
                fromComponent,
                toComponent,
                type: this.mapConnectionType(conn.type),
                weight: conn.weight,
                protocol: conn.protocol,
                callSites: conn.metadata?.callSites,
                dataFlow: conn.metadata?.dataFlow,
                httpMethod: conn.metadata?.httpMethod,
                metadata: conn.metadata || {}
              } as any);

              await this.em.persist(connection);
            }
          }
        }

        // Complete the analysis run
        analysisRun.complete(result, undefined);
        await this.em.flush();

        // Mark project as analyzed
        await this.projectsService.markAsAnalyzed('77777777-7777-7777-7777-777777777777', projectId);

        this.logger.log(`✅ Analysis results persisted to database for project ${projectId}`);
        this.logger.log(`   - Created ${componentMap.size} components`);
        this.logger.log(`   - Created ${result.connections?.length || 0} connections`);
      } catch (persistError) {
        this.logger.warn(`⚠️ Failed to persist analysis results to database: ${(persistError as Error).message}`);
        // Continue with response even if persistence fails
      }

      // Return analysis response in new CAS format with legacy compatibility
      return {
        success: true,
        cas_version: casResult.cas_version,
        analysis_timestamp: casResult.analysis_timestamp,
        analysis_id: casResult.analysis_id,
        system: casResult.system,
        nodes: casResult.nodes,
        edges: casResult.edges,
        entry_points: casResult.entry_points || [],
        exit_points: casResult.exit_points || [],
        libraries: casResult.libraries || [],
        analyzer_contributions: casResult.analyzer_contributions,
        // metadata: casResult.metadata,
        legacy: {
          components: result.components || [],
          connections: result.connections || [],
          insights: composite.insights,
          infrastructure: composite.infrastructure
        }
      };
    } catch (error) {
      this.logger.error(`Analysis failed: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  private async detectLanguage(projectPath: string): Promise<string | null> {
    // Simple language detection based on file extensions
    const files = await fs.readdir(projectPath);
    
    // Check for TypeScript/JavaScript first (most common for this project)
    if (files.some(f => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx'))) return 'typescript';
    if (files.includes('package.json')) return 'typescript';
    if (files.includes('tsconfig.json')) return 'typescript';
    
    if (files.some(f => f.endsWith('.py'))) return 'python';
    if (files.some(f => f.endsWith('.java'))) return 'java';
    if (files.some(f => f.endsWith('.cs'))) return 'csharp';
    if (files.some(f => f.endsWith('.go'))) return 'go';
    
    // Check for language-specific files
    if (files.includes('requirements.txt') || files.includes('setup.py')) return 'python';
    if (files.includes('pom.xml') || files.includes('build.gradle')) return 'java';
    if (files.includes('*.csproj') || files.includes('*.sln')) return 'csharp';
    if (files.includes('go.mod')) return 'go';
    
    return null;
  }

  private generateProjectId(projectPath: string): string {
    // Generate a deterministic UUID based on path for consistent project IDs
    const crypto = require('crypto');
    const { v5 } = require('uuid');

    // Use a namespace UUID for our project - this ensures deterministic UUIDs
    const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace

    // Generate UUID v5 (deterministic) based on project path
    return v5(projectPath, namespace);
  }

  private mapComponentType(type: string | undefined): ComponentType {
    if (!type) return ComponentType.UTILITY;

    const typeMap: Record<string, ComponentType> = {
      'route': ComponentType.ROUTE,
      'controller': ComponentType.CONTROLLER,
      'middleware': ComponentType.MIDDLEWARE,
      'model': ComponentType.MODEL,
      'service': ComponentType.SERVICE,
      'utility': ComponentType.UTILITY,
      'config': ComponentType.CONFIG,
      'database': ComponentType.DATABASE,
      'external_api': ComponentType.EXTERNAL_API,
      'orphaned': ComponentType.ORPHANED,
      'module': ComponentType.MODULE,
      'component': ComponentType.COMPONENT,
      'guard': ComponentType.GUARD,
      'interceptor': ComponentType.INTERCEPTOR,
      'pipe': ComponentType.PIPE,
      'filter': ComponentType.FILTER,
      'repository': ComponentType.REPOSITORY,
      'provider': ComponentType.PROVIDER,
      'hook': ComponentType.HOOK,
      'hoc': ComponentType.HOC,
      'store': ComponentType.STORE,
    };

    return typeMap[type.toLowerCase()] || ComponentType.UTILITY;
  }

  private mapArchitecturalLayer(type: string | undefined): ArchitecturalLayer {
    if (!type) return ArchitecturalLayer.BUSINESS;

    const layerMap: Record<string, ArchitecturalLayer> = {
      'route': ArchitecturalLayer.PRESENTATION,
      'controller': ArchitecturalLayer.PRESENTATION,
      'middleware': ArchitecturalLayer.INFRASTRUCTURE,
      'model': ArchitecturalLayer.DATA,
      'service': ArchitecturalLayer.BUSINESS,
      'utility': ArchitecturalLayer.INFRASTRUCTURE,
      'config': ArchitecturalLayer.INFRASTRUCTURE,
      'database': ArchitecturalLayer.DATA,
      'external_api': ArchitecturalLayer.EXTERNAL,
      'orphaned': ArchitecturalLayer.BUSINESS,
      'module': ArchitecturalLayer.INFRASTRUCTURE,
      'component': ArchitecturalLayer.PRESENTATION,
      'guard': ArchitecturalLayer.INFRASTRUCTURE,
      'interceptor': ArchitecturalLayer.INFRASTRUCTURE,
      'pipe': ArchitecturalLayer.BUSINESS,
      'filter': ArchitecturalLayer.INFRASTRUCTURE,
      'repository': ArchitecturalLayer.DATA,
      'provider': ArchitecturalLayer.BUSINESS,
      'hook': ArchitecturalLayer.BUSINESS,
      'hoc': ArchitecturalLayer.PRESENTATION,
      'store': ArchitecturalLayer.BUSINESS,
    };

    return layerMap[type.toLowerCase()] || ArchitecturalLayer.BUSINESS;
  }

  private mapConnectionType(type: string | undefined): ConnectionType {
    if (!type) return ConnectionType.DEPENDENCY;

    const typeMap: Record<string, ConnectionType> = {
      'import': ConnectionType.IMPORT,
      'http_call': ConnectionType.HTTP_CALL,
      'database': ConnectionType.DATABASE,
      'middleware_chain': ConnectionType.MIDDLEWARE_CHAIN,
      'function_call': ConnectionType.FUNCTION_CALL,
      'data_flow': ConnectionType.DATA_FLOW,
      'dependency_injection': ConnectionType.DEPENDENCY_INJECTION,
      'data_relationship': ConnectionType.DATA_RELATIONSHIP,
      'contains': ConnectionType.CONTAINS,
      'form_handling': ConnectionType.FORM_HANDLING,
      'template_inheritance': ConnectionType.TEMPLATE_INHERITANCE,
      'template_include': ConnectionType.TEMPLATE_INCLUDE,
      'uses_middleware': ConnectionType.USES_MIDDLEWARE,
      'uses_model': ConnectionType.USES_MODEL,
      'route_controller': ConnectionType.ROUTE_CONTROLLER,
      'module_import': ConnectionType.MODULE_IMPORT,
      'module_controller': ConnectionType.MODULE_CONTROLLER,
      'module_provider': ConnectionType.MODULE_PROVIDER,
      'dependency': ConnectionType.DEPENDENCY,
      'navigation': ConnectionType.NAVIGATION,
      'guards': ConnectionType.GUARDS,
      'intercepts': ConnectionType.INTERCEPTS,
      'api_call': ConnectionType.API_CALL,
    };

    return typeMap[type.toLowerCase()] || ConnectionType.DEPENDENCY;
  }

  private convertCASToLegacyBlueprint(casResult: CASOutput): any {
    return {
      components: casResult.nodes.map((node: CASNode) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        path: node.source?.file || '',
        language: node.metadata?.language || 'unknown',
        framework: node.metadata?.framework,
        metadata: node.metadata
      })),
      connections: casResult.edges.map((edge: CASEdge) => ({
        id: edge.id,
        from: edge.source,
        to: edge.target,
        type: edge.type,
        weight: edge.metadata?.weight || 1,
        protocol: edge.metadata?.attributes?.protocol,
        metadata: edge.metadata
      }))
    };
  }

  private convertCASToLegacyComposite(casResult: CASOutput): any {
    return {
      insights: {
        architecturalPatterns: [],
        codeQualityMetrics: {},
        performanceInsights: [],
        securityFindings: [],
        technicalDebt: [],
        dependencies: casResult.libraries,
        testingInsights: [],
        documentationCoverage: {},
        aiContext: {}
      },
      infrastructure: {},
      contributions: casResult.analyzer_contributions.map((contrib: CASAnalyzerContribution) => ({
        analyzerName: contrib.analyzer_name,
        analyzerType: contrib.contribution_type,
        confidence: contrib.confidence,
        duration: contrib.execution_time || '0ms',
        components: [],
        connections: []
      })),
      completeness: this.calculateCompleteness(casResult),
      validation: { isValid: true, errors: [], warnings: [] }
    };
  }

  private convertCASMetadata(casResult: CASOutput): any {
    return {
      analyzersRun: casResult.analyzer_contributions.map((c: CASAnalyzerContribution) => c.analyzer_name),
      languages: this.extractLanguagesFromCAS(casResult),
      frameworks: this.extractFrameworksFromCAS(casResult),
      infrastructure: [],
      confidence: this.calculateOverallConfidence(casResult)
    };
  }

  private extractLanguagesFromCAS(casResult: CASOutput): string[] {
    const languages = new Set<string>();
    casResult.analyzer_contributions.forEach((contrib: CASAnalyzerContribution) => {
      if (contrib.contribution_type === 'language') {
        languages.add(contrib.analyzer_name.toLowerCase().replace(' analyzer', ''));
      }
    });
    return Array.from(languages);
  }

  private extractFrameworksFromCAS(casResult: CASOutput): string[] {
    const frameworks = new Set<string>();
    casResult.analyzer_contributions.forEach((contrib: CASAnalyzerContribution) => {
      if (contrib.contribution_type === 'framework') {
        frameworks.add(contrib.analyzer_name.toLowerCase().replace(' analyzer', ''));
      }
    });
    return Array.from(frameworks);
  }

  private calculateCompleteness(casResult: CASOutput): number {
    let completeness = 0;
    if (casResult.nodes.length > 0) completeness += 0.4;
    if (casResult.edges.length > 0) completeness += 0.3;
    if (casResult.entry_points && casResult.entry_points.length > 0) completeness += 0.2;
    if (casResult.analyzer_contributions.length > 0) completeness += 0.1;
    return completeness;
  }

  private calculateOverallConfidence(casResult: CASOutput): number {
    if (casResult.analyzer_contributions.length === 0) return 0;
    const avgConfidence = casResult.analyzer_contributions.reduce((sum: number, c: CASAnalyzerContribution) => sum + (c.confidence || 0), 0) /
                         casResult.analyzer_contributions.length;
    return avgConfidence;
  }
}