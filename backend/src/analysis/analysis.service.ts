import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { EntityManager, EntityRepository, FilterQuery, QueryOrder, wrap } from '@mikro-orm/core';

import { AnalysisRun, AnalysisStatus, AnalysisType } from '../database/entities/analysis-run.entity';
import { Project } from '../database/entities/project.entity';
import { User } from '../database/entities/user.entity';
import { Component } from '../database/entities/component.entity';
import { ComponentConnection } from '../database/entities/component-connection.entity';

import { StartAnalysisDto } from './dto/start-analysis.dto';
import {
  AnalysisRunResponseDto,
  AnalysisRunListResponseDto,
  AnalysisProgressDto,
  AnalysisResultDto,
  ArchitectureBlueprintDto,
} from './dto/analysis-response.dto';

// Import CAS analyzer system
import { CASAnalyzerService } from '../analyzer/services/cas-analyzer.service';
import * as path from 'path';

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly runningAnalyses = new Map<string, boolean>();

  constructor(
    private readonly em: EntityManager,
    private readonly casAnalyzerService: CASAnalyzerService,
  ) {}

  async startAnalysis(
    organizationId: string,
    projectId: string,
    userId: string,
    startAnalysisDto: StartAnalysisDto,
  ): Promise<AnalysisResultDto> {
    // Verify project exists and user has access
    const project = await this.em.findOne(Project, {
      id: projectId,
      organization: organizationId,
    }, {
      populate: ['owner'],
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const user = await this.em.findOne(User, { id: userId });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if analysis is already running for this project
    if (this.runningAnalyses.has(projectId)) {
      throw new BadRequestException('Analysis is already running for this project');
    }

    // Check for recent analysis if not forced
    if (!startAnalysisDto.force) {
      const recentAnalysis = await this.em.findOne(AnalysisRun, {
        project: projectId,
        status: { $in: [AnalysisStatus.RUNNING, AnalysisStatus.PENDING] },
      });

      if (recentAnalysis) {
        throw new BadRequestException('Analysis is already running or pending for this project');
      }
    }

    // Create analysis run
    const analysisRun = this.em.create(AnalysisRun, {
      project,
      triggeredBy: user,
      status: AnalysisStatus.PENDING,
      type: startAnalysisDto.type || AnalysisType.MANUAL,
      branch: startAnalysisDto.branch || project.defaultBranch,
      commitSha: startAnalysisDto.commitSha,
      configuration: startAnalysisDto.configuration || {},
      metadata: startAnalysisDto.metadata || {},
    } as any);

    await this.em.persistAndFlush(analysisRun);

    // Mark project as analyzing
    project.markAsAnalyzing();
    await this.em.flush();

    // Start analysis in background
    this.performAnalysis(analysisRun, project, startAnalysisDto)
      .catch(error => {
        this.logger.error(`Analysis failed for run ${analysisRun.id}:`, error);
      });

    return {
      success: true,
      analysisRun: this.mapToResponseDto(analysisRun),
      processingTime: 0,
    };
  }

  async getAnalysisRuns(
    organizationId: string,
    projectId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<AnalysisRunListResponseDto> {
    // Verify project exists and user has access
    const project = await this.em.findOne(Project, {
      id: projectId,
      organization: organizationId,
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const [analysisRuns, total] = await this.em.findAndCount(AnalysisRun,
      { project: projectId },
      {
        populate: ['triggeredBy'],
        orderBy: { createdAt: QueryOrder.DESC },
        limit,
        offset: (page - 1) * limit,
      },
    );

    const totalPages = Math.ceil(total / limit);

    return {
      data: analysisRuns.map(run => this.mapToResponseDto(run)),
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  async getAnalysisRun(
    organizationId: string,
    projectId: string,
    analysisId: string,
  ): Promise<AnalysisResultDto> {
    const analysisRun = await this.findAnalysisRun(organizationId, projectId, analysisId);
    
    const result: AnalysisResultDto = {
      success: analysisRun.isCompleted,
      analysisRun: this.mapToResponseDto(analysisRun),
      processingTime: analysisRun.processingTimeMs || 0,
    };

    // Include blueprint if analysis is completed
    if (analysisRun.isCompleted && analysisRun.blueprint) {
      result.blueprint = await this.mapToArchitectureDto(analysisRun);
    }

    if (analysisRun.isFailed) {
      result.error = analysisRun.errorMessage;
    }

    if (analysisRun.manifestPath) {
      result.manifestPath = analysisRun.manifestPath;
    }

    return result;
  }

  async getAnalysisProgress(
    organizationId: string,
    projectId: string,
    analysisId: string,
  ): Promise<AnalysisProgressDto> {
    const analysisRun = await this.findAnalysisRun(organizationId, projectId, analysisId);
    
    let estimatedTimeRemaining: number | undefined;
    
    if (analysisRun.isRunning && analysisRun.startedAt && analysisRun.progress) {
      const elapsedTime = Date.now() - analysisRun.startedAt.getTime();
      const progressRatio = analysisRun.progress / 100;
      
      if (progressRatio > 0) {
        const totalEstimatedTime = elapsedTime / progressRatio;
        estimatedTimeRemaining = totalEstimatedTime - elapsedTime;
      }
    }

    return {
      analysisId: analysisRun.id,
      status: analysisRun.status,
      progress: analysisRun.progress || 0,
      currentOperation: analysisRun.currentOperation,
      estimatedTimeRemaining,
      timestamp: new Date().toISOString(),
    };
  }

  async getArchitectureBlueprint(
    organizationId: string,
    projectId: string,
    analysisId?: string,
  ): Promise<ArchitectureBlueprintDto> {
    // If no specific analysis ID, get the latest completed analysis
    let analysisRun: AnalysisRun;
    
    if (analysisId) {
      analysisRun = await this.findAnalysisRun(organizationId, projectId, analysisId);
    } else {
      const project = await this.em.findOne(Project, {
        id: projectId,
        organization: organizationId,
      });

      if (!project) {
        throw new NotFoundException('Project not found');
      }

      const latestAnalysis = await this.em.findOne(AnalysisRun,
        {
          project: projectId,
          status: AnalysisStatus.COMPLETED,
        },
        { orderBy: { completedAt: QueryOrder.DESC } },
      );

      if (!latestAnalysis) {
        throw new NotFoundException('No completed analysis found for this project');
      }

      analysisRun = latestAnalysis;
    }

    if (!analysisRun.isCompleted) {
      throw new BadRequestException('Analysis is not completed yet');
    }

    if (!analysisRun.blueprint) {
      throw new NotFoundException('Blueprint data not found for this analysis');
    }

    return this.mapToArchitectureDto(analysisRun);
  }

  async cancelAnalysis(
    organizationId: string,
    projectId: string,
    analysisId: string,
  ): Promise<void> {
    const analysisRun = await this.findAnalysisRun(organizationId, projectId, analysisId);
    
    if (!analysisRun.isRunning && analysisRun.status !== AnalysisStatus.PENDING) {
      throw new BadRequestException('Analysis cannot be cancelled in its current state');
    }

    analysisRun.cancel();
    await this.em.flush();

    // Remove from running analyses
    this.runningAnalyses.delete(projectId);

    // Update project status
    const project = await this.em.findOne(Project, { id: projectId });
    if (project) {
      project.markAsAnalyzed(); // Return to active state
      await this.em.flush();
    }
  }

  private async performAnalysis(
    analysisRun: AnalysisRun,
    project: Project,
    startAnalysisDto: StartAnalysisDto,
  ): Promise<void> {
    const projectId = project.id;
    this.runningAnalyses.set(projectId, true);

    try {
      // Update status to running
      analysisRun.start();
      await this.em.flush();

      this.logger.log(`Starting analysis for project ${project.name} (${projectId})`);

      // Use CAS analyzer service
      
      // Determine repository path
      let repositoryPath = startAnalysisDto.repositoryPath;
      if (!repositoryPath && project.repositoryUrl) {
        // For remote repositories, you might want to clone them first
        // For now, we'll throw an error if no local path is provided
        throw new Error('Repository path is required for analysis. Remote repository cloning not yet implemented.');
      }
      
      if (!repositoryPath) {
        throw new Error('No repository path provided and no repository URL configured');
      }

      // Progress tracking callback
      const progressCallback = async (progress: number, operation: string) => {
        analysisRun.updateProgress(progress, operation);
        await this.em.flush();
        this.logger.debug(`Analysis progress for ${projectId}: ${progress}% - ${operation}`);
      };

      // Configure analysis options
      const analysisOptions = {
        ...startAnalysisDto.configuration,
        persistResults: true,
        generateManifest: true,
        usePluginRegistry: true,
        enableTelemetry: true,
        projectId: project.name,
        progressCallback,
      };

      // Run the CAS analysis
      await progressCallback(10, 'Initializing analysis...');
      const casResult = await this.casAnalyzerService.analyzeProject({
        projectPath: repositoryPath,
        options: analysisOptions
      });
      
      await progressCallback(80, 'Processing results...');

      // Convert CAS format to legacy blueprint format for database storage
      const legacyBlueprint = this.convertCASToBlueprint(casResult);

      // Store components in database
      await this.storeAnalysisResults(analysisRun, legacyBlueprint);

      await progressCallback(90, 'Processing analysis results...');

      await progressCallback(100, 'Completing analysis...');

      // Complete the analysis
      const enhancedBlueprint = {
        ...legacyBlueprint,
        id: analysisRun.id,
        projectId: project.id,
        projectName: project.name,
        metadata: {
          ...legacyBlueprint.metadata,
          analysisDate: new Date(),
          repositoryPath,
          cas_version: casResult.cas_version,
          version: '2.0.0',
          analyzersRun: casResult.analyzer_contributions.map((c: any) => c.analyzer_name),
        },
      };

      analysisRun.complete(enhancedBlueprint, undefined);
      await this.em.flush();

      // Update project status
      project.markAsAnalyzed();
      await this.em.flush();

      this.logger.log(`Analysis completed for project ${project.name} (${projectId})`);

    } catch (error: any) {
      this.logger.error(`Analysis failed for project ${project.name} (${projectId}):`, error);
      
      // Mark analysis as failed
      analysisRun.fail(error.message || 'Unknown analysis error');
      await this.em.flush();

      // Update project status to error
      project.markAsError();
      await this.em.flush();

    } finally {
      // Remove from running analyses
      this.runningAnalyses.delete(projectId);
    }
  }

  private async storeAnalysisResults(analysisRun: AnalysisRun, blueprint: any): Promise<void> {
    if (!blueprint.components) return;

    // Clear existing components for this analysis run
    await this.em.nativeDelete(Component, { analysisRun: analysisRun.id });
    await this.em.nativeDelete(ComponentConnection, {
      fromComponent: { analysisRun: analysisRun.id }
    });

    // Store components
    const componentMap = new Map<string, Component>();
    
    for (const comp of blueprint.components) {
      const component = this.em.create(Component, {
        analysisRun,
        name: comp.name,
        type: comp.type,
        path: comp.path,
        language: comp.language,
        framework: comp.framework,
        layer: comp.metadata?.layer || 'infrastructure',
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
        aiDescription: comp.metadata?.aiDescription,
        functions: comp.metadata?.functions,
        testCoverage: comp.metadata?.testCoverage,
        performanceMetrics: comp.metadata?.performanceMetrics,
        metadata: comp.metadata,
        positionX: comp.position?.x,
        positionY: comp.position?.y,
      } as any);

      componentMap.set(comp.id, component);
    }

    await this.em.persistAndFlush([...componentMap.values()]);

    // Store connections
    if (blueprint.connections) {
      const connections = [];

      for (const conn of blueprint.connections) {
        const fromComponent = componentMap.get(conn.from);
        const toComponent = componentMap.get(conn.to);

        if (fromComponent && toComponent) {
          const connection = this.em.create(ComponentConnection, {
            fromComponent,
            toComponent,
            type: conn.type,
            weight: conn.weight,
            protocol: conn.protocol,
            callSites: conn.metadata?.callSites,
            dataFlow: conn.metadata?.dataFlow,
            httpMethod: conn.metadata?.httpMethod,
            injectionType: conn.metadata?.injectionType,
            relationship: conn.metadata?.relationship,
            importType: conn.metadata?.importType,
            scope: conn.metadata?.scope,
            relationType: conn.metadata?.relationType,
            middlewareName: conn.metadata?.middlewareName,
            basePath: conn.metadata?.basePath,
            routePath: conn.metadata?.routePath,
            formName: conn.metadata?.formName,
            path: conn.metadata?.path,
            guardType: conn.metadata?.guardType,
            layoutType: conn.metadata?.layoutType,
            methods: conn.metadata?.methods,
            pageType: conn.metadata?.pageType,
            metadata: conn.metadata,
          } as any);

          connections.push(connection);
        }
      }

      if (connections.length > 0) {
        await this.em.persistAndFlush(connections);
      }
    }
  }

  private async findAnalysisRun(
    organizationId: string,
    projectId: string,
    analysisId: string,
  ): Promise<AnalysisRun> {
    const analysisRun = await this.em.findOne(AnalysisRun, {
      id: analysisId,
      project: {
        id: projectId,
        organization: organizationId,
      },
    }, {
      populate: ['project', 'triggeredBy'],
    });

    if (!analysisRun) {
      throw new NotFoundException('Analysis run not found');
    }

    return analysisRun;
  }

  private async mapToArchitectureDto(analysisRun: AnalysisRun): Promise<ArchitectureBlueprintDto> {
    // Get components and connections for this analysis
    const components = await this.em.find(Component,
      { analysisRun: analysisRun.id },
      { populate: ['outgoingConnections', 'incomingConnections'] },
    );

    const connections = await this.em.find(ComponentConnection, {
      fromComponent: { analysisRun: analysisRun.id },
    }, {
      populate: ['fromComponent', 'toComponent'],
    });

    // Convert stored data back to blueprint format
    const blueprint = analysisRun.blueprint || {};

    // Calculate statistics
    const totalComponents = components.length;
    const totalConnections = connections.length;
    const averageComplexity = components.length > 0 
      ? components.reduce((sum, c) => sum + c.complexity, 0) / components.length 
      : 0;
    const orphanedCount = components.filter(c => c.isOrphaned).length;
    const riskAreas = components.filter(c => c.riskLevel === 'high' || c.riskLevel === 'critical').length;
    const cyclomaticComplexity = components.reduce((sum, c) => sum + c.complexity, 0);
    const technicalDebt = components.reduce((sum, c) => sum + (c.getMetadata('technicalDebt') || 0), 0);

    return {
      id: analysisRun.id,
      projectName: analysisRun.project?.name || 'Unknown',
      framework: blueprint.framework || 'Unknown',
      components: components.map(this.mapComponentToDto),
      connections: connections.map(this.mapConnectionToDto),
      entryPoints: blueprint.entryPoints || [],
      exitPoints: blueprint.exitPoints || [],
      orphanedComponents: components.filter(c => c.isOrphaned).map(c => c.id),
      riskAreas: blueprint.riskAreas || [],
      technologyStack: blueprint.technologyStack || {},
      dependencies: blueprint.dependencies || {},
      apiEndpoints: blueprint.apiEndpoints || [],
      securityAnalysis: blueprint.securityAnalysis || {},
      testingInfo: blueprint.testingInfo || {},
      metadata: blueprint.metadata || {},
      databaseInfo: blueprint.databaseInfo,
      deploymentInfo: blueprint.deploymentInfo,
      statistics: {
        totalComponents,
        totalConnections,
        averageComplexity: Math.round(averageComplexity * 10) / 10,
        riskAreas,
        orphanedCount,
        cyclomaticComplexity,
        technicalDebt,
      },
    };
  }

  private mapComponentToDto(component: Component): any {
    return {
      id: component.id,
      name: component.name,
      type: component.type,
      path: component.path,
      language: component.language,
      framework: component.framework,
      layer: component.layer,
      dependencies: component.dependencies,
      dependents: component.dependents,
      metadata: {
        lineCount: component.lineCount,
        complexity: component.complexity,
        exports: component.exports,
        imports: component.imports,
        httpMethods: component.httpMethods,
        dbQueries: component.dbQueries,
        externalCalls: component.externalCalls,
        isEntry: component.isEntry,
        isOrphaned: component.isOrphaned,
        layer: component.layer,
        responsibilities: component.responsibilities,
        aiDescription: component.aiDescription,
        functions: component.functions,
        testCoverage: component.testCoverage,
        performanceMetrics: component.performanceMetrics,
        ...component.metadata,
      },
      position: component.position,
      metrics: component.metrics,
    };
  }

  private mapConnectionToDto(connection: ComponentConnection): any {
    return {
      from: connection.fromComponent.id,
      to: connection.toComponent.id,
      type: connection.type,
      weight: connection.weight,
      protocol: connection.protocol,
      metadata: {
        callSites: connection.callSites,
        dataFlow: connection.dataFlow,
        httpMethod: connection.httpMethod,
        injectionType: connection.injectionType,
        relationship: connection.relationship,
        importType: connection.importType,
        scope: connection.scope,
        relationType: connection.relationType,
        middlewareName: connection.middlewareName,
        basePath: connection.basePath,
        routePath: connection.routePath,
        formName: connection.formName,
        path: connection.path,
        guardType: connection.guardType,
        layoutType: connection.layoutType,
        methods: connection.methods,
        pageType: connection.pageType,
        ...connection.metadata,
      },
    };
  }

  private convertCASToBlueprint(casResult: any): any {
    return {
      components: casResult.nodes.map((node: any) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        path: node.file_path || '',
        language: node.metadata?.language || 'unknown',
        framework: node.metadata?.framework,
        metadata: {
          ...node.metadata,
          lineCount: node.line_end ? (node.line_end - (node.line_start || 1)) : undefined,
          level: node.level
        }
      })),
      connections: casResult.edges.map((edge: any) => ({
        id: edge.id,
        from: edge.source,
        to: edge.target,
        type: edge.type,
        weight: edge.metadata?.weight || 1,
        protocol: edge.metadata?.protocol,
        metadata: edge.metadata
      })),
      entryPoints: casResult.entry_points,
      exitPoints: casResult.exit_points,
      dependencies: casResult.libraries,
      metadata: {
        cas_version: casResult.cas_version,
        analyzer_contributions: casResult.analyzer_contributions,
        system: casResult.system
      }
    };
  }

  private mapToResponseDto(analysisRun: AnalysisRun): AnalysisRunResponseDto {
    return {
      id: analysisRun.id,
      projectId: analysisRun.project?.id || '',
      triggeredById: analysisRun.triggeredBy?.id,
      status: analysisRun.status,
      type: analysisRun.type,
      branch: analysisRun.branch,
      commitSha: analysisRun.commitSha,
      startedAt: analysisRun.startedAt?.toISOString(),
      completedAt: analysisRun.completedAt?.toISOString(),
      processingTimeMs: analysisRun.processingTimeMs,
      progress: analysisRun.progress,
      currentOperation: analysisRun.currentOperation,
      errorMessage: analysisRun.errorMessage,
      configuration: analysisRun.configuration,
      metadata: analysisRun.metadata,
      manifestPath: analysisRun.manifestPath,
      createdAt: analysisRun.createdAt.toISOString(),
      updatedAt: analysisRun.updatedAt.toISOString(),
    };
  }
}