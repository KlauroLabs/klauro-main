import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager, FilterQuery, QueryOrder, wrap } from '@mikro-orm/core';

import { Codebase, CodebaseStatus } from '../database/entities/codebase.entity';
import { Workspace } from '../database/entities/workspace.entity';
import { User } from '../database/entities/user.entity';
import { AnalysisRun, AnalysisStatus, AnalysisType } from '../database/entities/analysis-run.entity';
import { Component } from '../database/entities/component.entity';
import { CodebaseConnection } from '../database/entities/codebase-connection.entity';
import { Tag, TagType } from '../database/entities/tag.entity';
import { WorkspaceAccess, WorkspaceRole } from '../database/entities/workspace-access.entity';

import { CreateCodebaseDto } from './dto/create-codebase.dto';
import { UpdateCodebaseDto } from './dto/update-codebase.dto';
import { CodebaseQueryDto } from './dto/codebase-query.dto';
import { CodebaseResponseDto, CodebaseWithStatsResponseDto, CodebaseListResponseDto, CodebaseDashboardDto, CodebaseStatsDto } from './dto/codebase-response.dto';

import { CASAnalyzerService } from '../analyzer/services/cas-analyzer.service';

@Injectable()
export class CodebasesService {
  private readonly logger = new Logger(CodebasesService.name);

  constructor(
    @InjectRepository(Codebase)
    private readonly codebaseRepository: EntityRepository<Codebase>,
    @InjectRepository(Workspace)
    private readonly workspaceRepository: EntityRepository<Workspace>,
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    @InjectRepository(AnalysisRun)
    private readonly analysisRunRepository: EntityRepository<AnalysisRun>,
    @InjectRepository(Component)
    private readonly componentRepository: EntityRepository<Component>,
    @InjectRepository(CodebaseConnection)
    private readonly connectionRepository: EntityRepository<CodebaseConnection>,
    @InjectRepository(Tag)
    private readonly tagRepository: EntityRepository<Tag>,
    @InjectRepository(WorkspaceAccess)
    private readonly workspaceAccessRepository: EntityRepository<WorkspaceAccess>,
    private readonly em: EntityManager,
    private readonly casAnalyzerService: CASAnalyzerService,
  ) {}

  async create(
    userId: string,
    workspaceId: string,
    createCodebaseDto: CreateCodebaseDto,
  ): Promise<CodebaseResponseDto> {
    // Verify workspace exists and user has access
    const workspace = await this.findAccessibleWorkspace(userId, workspaceId, WorkspaceRole.EDITOR);
    const user = await this.userRepository.findOneOrFail(userId, {
      populate: ['ownedCodebases'],
      failHandler: () => new NotFoundException('User not found'),
    });

    // Check if user can create codebase
    if (!user.canCreateCodebase()) {
      throw new ForbiddenException('User has reached codebase limit for their billing tier');
    }

    // Check if codebase name is unique within workspace
    const existingCodebase = await this.codebaseRepository.findOne({
      name: createCodebaseDto.name,
      workspace: workspaceId,
      deletedAt: null,
    });

    if (existingCodebase) {
      throw new BadRequestException('Codebase name already exists in this workspace');
    }

    // Prepare codebase data, cleaning up empty values
    const codebaseData: any = {
      name: createCodebaseDto.name,
      description: createCodebaseDto.description,
      workspace,
      owner: user,
      status: CodebaseStatus.ACTIVE,
      defaultBranch: createCodebaseDto.defaultBranch || 'main',
      language: createCodebaseDto.language,
      framework: createCodebaseDto.framework,
      settings: createCodebaseDto.settings,
    };

    // Only set repository fields if repositoryUrl is provided and not empty
    if (createCodebaseDto.repositoryUrl && createCodebaseDto.repositoryUrl.trim()) {
      codebaseData.repositoryUrl = createCodebaseDto.repositoryUrl;
      codebaseData.repositoryProvider = createCodebaseDto.repositoryProvider;
      codebaseData.repositoryId = createCodebaseDto.repositoryId;
    }

    // Create codebase
    const codebase = this.em.create(Codebase, codebaseData);

    await this.em.persistAndFlush(codebase);

    return this.mapToResponseDto(codebase);
  }

  async createWithId(
    userId: string,
    workspaceId: string,
    codebaseId: string,
    createCodebaseDto: CreateCodebaseDto,
  ): Promise<CodebaseResponseDto> {
    // Verify workspace and permissions
    const workspace = await this.findAccessibleWorkspace(userId, workspaceId, WorkspaceRole.EDITOR);
    const user = await this.userRepository.findOneOrFail(userId, {
      populate: ['ownedCodebases'],
      failHandler: () => new NotFoundException('User not found'),
    });

    // Check if codebase name already exists in workspace
    const existingCodebase = await this.codebaseRepository.findOne({
      workspace: workspaceId,
      name: createCodebaseDto.name,
      deletedAt: null,
    });

    if (existingCodebase) {
      throw new BadRequestException('Codebase name already exists in this workspace');
    }

    // Prepare codebase data, cleaning up empty values
    const codebaseData: any = {
      id: codebaseId,
      name: createCodebaseDto.name,
      description: createCodebaseDto.description,
      workspace,
      owner: user,
      status: CodebaseStatus.ACTIVE,
      defaultBranch: createCodebaseDto.defaultBranch || 'main',
      language: createCodebaseDto.language,
      framework: createCodebaseDto.framework,
      settings: createCodebaseDto.settings,
    };

    // Only set repository fields if repositoryUrl is provided and not empty
    if (createCodebaseDto.repositoryUrl && createCodebaseDto.repositoryUrl.trim()) {
      codebaseData.repositoryUrl = createCodebaseDto.repositoryUrl;
      codebaseData.repositoryProvider = createCodebaseDto.repositoryProvider;
      codebaseData.repositoryId = createCodebaseDto.repositoryId;
    }

    // Create codebase with specific ID
    const codebase = this.em.create(Codebase, codebaseData);

    await this.em.persistAndFlush(codebase);

    return this.mapToResponseDto(codebase);
  }

  async findAll(
    userId: string,
    workspaceId: string,
    queryDto: CodebaseQueryDto,
  ): Promise<CodebaseListResponseDto> {
    // Verify workspace access
    await this.findAccessibleWorkspace(userId, workspaceId, WorkspaceRole.VIEWER);

    const { page = 1, limit = 20, sortBy = 'updatedAt', sortOrder = 'desc', ...filters } = queryDto;

    const where: FilterQuery<Codebase> = {
      workspace: workspaceId,
      deletedAt: null,
    };

    // Apply filters
    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.repositoryProvider) {
      where.repositoryProvider = filters.repositoryProvider;
    }

    if (filters.language) {
      where.language = { $ilike: `%${filters.language}%` };
    }

    if (filters.framework) {
      where.framework = { $ilike: `%${filters.framework}%` };
    }

    if (filters.search) {
      where.$or = [
        { name: { $ilike: `%${filters.search}%` } },
        { description: { $ilike: `%${filters.search}%` } },
      ];
    }

    // TODO: Add tag filtering when needed
    // if (filters.tags && filters.tags.length > 0) {
    //   // Filter by tags
    // }

    const [codebases, total] = await this.codebaseRepository.findAndCount(
      where,
      {
        populate: ['owner', 'workspace'],
        orderBy: { [sortBy]: sortOrder === 'asc' ? QueryOrder.ASC : QueryOrder.DESC },
        limit,
        offset: (page - 1) * limit,
      },
    );

    const totalPages = Math.ceil(total / limit);

    return {
      data: codebases.map(codebase => this.mapToResponseDto(codebase)),
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  async findOne(
    userId: string,
    workspaceId: string,
    id: string,
  ): Promise<CodebaseResponseDto> {
    const codebase = await this.findCodebaseByIdAndWorkspace(userId, workspaceId, id);
    return this.mapToResponseDto(codebase);
  }

  async findOneWithStats(
    userId: string,
    workspaceId: string,
    id: string,
  ): Promise<CodebaseWithStatsResponseDto> {
    const codebase = await this.findCodebaseByIdAndWorkspace(userId, workspaceId, id);
    const stats = await this.getCodebaseStats(id);

    return {
      ...this.mapToResponseDto(codebase),
      ...stats,
    };
  }

  async update(
    userId: string,
    workspaceId: string,
    id: string,
    updateCodebaseDto: UpdateCodebaseDto,
  ): Promise<CodebaseResponseDto> {
    const codebase = await this.findCodebaseByIdAndWorkspace(userId, workspaceId, id, WorkspaceRole.EDITOR);

    // Check name uniqueness if name is being updated
    if (updateCodebaseDto.name && updateCodebaseDto.name !== codebase.name) {
      const existingCodebase = await this.codebaseRepository.findOne({
        name: updateCodebaseDto.name,
        workspace: workspaceId,
        id: { $ne: id },
        deletedAt: null,
      });

      if (existingCodebase) {
        throw new BadRequestException('Codebase name already exists in this workspace');
      }
    }

    wrap(codebase).assign(updateCodebaseDto);
    await this.em.flush();

    return this.mapToResponseDto(codebase);
  }

  async remove(userId: string, workspaceId: string, id: string): Promise<void> {
    const codebase = await this.findCodebaseByIdAndWorkspace(userId, workspaceId, id, WorkspaceRole.ADMIN);

    codebase.archive();
    await this.em.flush();
  }

  async restore(userId: string, workspaceId: string, id: string): Promise<CodebaseResponseDto> {
    await this.findAccessibleWorkspace(userId, workspaceId, WorkspaceRole.ADMIN);

    const codebase = await this.codebaseRepository.findOne({
      id,
      workspace: workspaceId,
    }, {
      populate: ['workspace'],
    });

    if (!codebase) {
      throw new NotFoundException('Codebase not found');
    }

    codebase.restore();
    await this.em.flush();

    return this.mapToResponseDto(codebase);
  }

  async getDashboard(userId: string, workspaceId: string): Promise<CodebaseDashboardDto> {
    await this.findAccessibleWorkspace(userId, workspaceId, WorkspaceRole.VIEWER);

    const totalCodebases = await this.codebaseRepository.count({
      workspace: workspaceId,
      deletedAt: null,
    });

    const activeCodebases = await this.codebaseRepository.count({
      workspace: workspaceId,
      status: CodebaseStatus.ACTIVE,
      deletedAt: null,
    });

    const analyzingCodebases = await this.codebaseRepository.count({
      workspace: workspaceId,
      status: CodebaseStatus.ANALYZING,
      deletedAt: null,
    });

    const errorCodebases = await this.codebaseRepository.count({
      workspace: workspaceId,
      status: CodebaseStatus.ERROR,
      deletedAt: null,
    });

    const totalConnections = await this.connectionRepository.count({
      $or: [
        { sourceCodebase: { workspace: workspaceId } },
        { targetCodebase: { workspace: workspaceId } },
      ],
    });

    return {
      totalCodebases,
      activeCodebases,
      analyzingCodebases,
      errorCodebases,
      totalComponents: 0,
      totalConnections,
      languageDistribution: {},
      frameworkDistribution: {},
      recentActivity: [],
    };
  }

  async startAnalysis(userId: string, workspaceId: string, id: string): Promise<{analysisId: string}> {
    const codebase = await this.findCodebaseByIdAndWorkspace(userId, workspaceId, id, WorkspaceRole.EDITOR);
    const user = await this.userRepository.findOneOrFail(userId);

    const localPath = codebase.settings?.localPath as string | undefined;

    if (!codebase.repositoryUrl && !localPath) {
      throw new BadRequestException('Codebase must have either a repository URL or local path configured for analysis');
    }

    const analysisRun = this.em.create(AnalysisRun, {
      codebase,
      triggeredBy: user,
      status: AnalysisStatus.PENDING,
      type: AnalysisType.MANUAL,
      branch: codebase.defaultBranch,
      configuration: {},
      metadata: {},
    } as any);

    await this.em.persistAndFlush(analysisRun);

    codebase.markAsAnalyzing();
    await this.em.flush();

    this.performAnalysis(analysisRun, codebase, localPath || codebase.repositoryUrl!)
      .catch(error => {
        this.logger.error(`Analysis failed for codebase ${codebase.id}:`, error);
      });

    return { analysisId: analysisRun.id };
  }

  private async performAnalysis(
    analysisRun: AnalysisRun,
    codebase: Codebase,
    repositoryPath: string,
  ): Promise<void> {
    try {
      analysisRun.start();
      await this.em.flush();

      this.logger.log(`Starting CAS analysis for codebase ${codebase.name} (${codebase.id})`);

      const progressCallback = async (progress: number, operation: string) => {
        analysisRun.updateProgress(progress, operation);
        await this.em.flush();
        this.logger.debug(`Analysis progress for ${codebase.id}: ${progress}% - ${operation}`);
      };

      await progressCallback(10, 'Initializing CAS analysis...');

      const casResult = await this.casAnalyzerService.analyzeProject({
        projectPath: repositoryPath,
        options: {
          includeTests: true,
        }
      });

      await progressCallback(80, 'Processing CAS results...');

      const blueprint = this.convertCASToBlueprint(casResult);

      await this.storeAnalysisResults(analysisRun, blueprint);

      await progressCallback(90, 'Storing analysis data...');

      const enhancedBlueprint = {
        ...blueprint,
        id: analysisRun.id,
        codebaseId: codebase.id,
        codebaseName: codebase.name,
        metadata: {
          ...blueprint.metadata,
          analysisDate: new Date(),
          repositoryPath,
          cas_version: casResult.cas_version,
          version: '2.0.0',
          analyzersRun: casResult.analyzer_contributions.map((c: any) => c.analyzer_name),
        },
      };

      analysisRun.complete(enhancedBlueprint, undefined);
      await this.em.flush();

      codebase.markAsAnalyzed();
      await this.em.flush();

      this.logger.log(`Analysis completed for codebase ${codebase.name} (${codebase.id})`);

    } catch (error: any) {
      this.logger.error(`Analysis failed for codebase ${codebase.name} (${codebase.id}):`, error);

      analysisRun.fail(error.message || 'Unknown analysis error');
      await this.em.flush();

      codebase.markAsError();
      await this.em.flush();
    }
  }

  private async storeAnalysisResults(analysisRun: AnalysisRun, blueprint: any): Promise<void> {
    if (!blueprint.components) return;

    await this.em.nativeDelete(Component, { analysisRun: analysisRun.id });

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
  }

  private mapCASTypeToComponentType(casType: string): string {
    const typeMap: Record<string, string> = {
      'file': 'module',
      'class': 'component',
      'function': 'utility',
      'method': 'utility',
      'interface': 'model',
      'type': 'model',
      'enum': 'model',
      'controller': 'controller',
      'service': 'service',
      'repository': 'repository',
      'module': 'module',
      'middleware': 'middleware',
      'guard': 'guard',
      'interceptor': 'interceptor',
      'pipe': 'pipe',
      'filter': 'filter',
      'provider': 'provider',
      'component': 'component',
      'hook': 'hook',
      'hoc': 'hoc',
      'route': 'route',
      'endpoint': 'route',
      'api': 'route',
      'model': 'model',
      'entity': 'model',
      'schema': 'model',
      'config': 'config',
      'constant': 'config',
      'variable': 'utility',
    };

    return typeMap[casType.toLowerCase()] || 'utility';
  }

  private convertCASToBlueprint(casResult: any): any {
    return {
      components: casResult.nodes.map((node: any) => ({
        id: node.id,
        name: node.name,
        type: this.mapCASTypeToComponentType(node.type),
        path: node.file_path || node.source?.file || '',
        language: node.metadata?.language || 'unknown',
        framework: node.metadata?.framework,
        metadata: {
          ...node.metadata,
          originalType: node.type,
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

  async markAsAnalyzing(userId: string, workspaceId: string, id: string): Promise<void> {
    const codebase = await this.findCodebaseByIdAndWorkspace(userId, workspaceId, id, WorkspaceRole.EDITOR);
    codebase.markAsAnalyzing();
    await this.em.flush();
  }

  async markAsAnalyzed(userId: string, workspaceId: string, id: string): Promise<void> {
    const codebase = await this.findCodebaseByIdAndWorkspace(userId, workspaceId, id, WorkspaceRole.EDITOR);
    codebase.markAsAnalyzed();
    await this.em.flush();
  }

  async markAsError(userId: string, workspaceId: string, id: string): Promise<void> {
    const codebase = await this.findCodebaseByIdAndWorkspace(userId, workspaceId, id, WorkspaceRole.EDITOR);
    codebase.markAsError();
    await this.em.flush();
  }

  private async findAccessibleWorkspace(
    userId: string,
    workspaceId: string,
    requiredRole: WorkspaceRole = WorkspaceRole.VIEWER
  ): Promise<Workspace> {
    const workspace = await this.workspaceRepository.findOne({
      id: workspaceId,
      deletedAt: null,
      isActive: true,
    }, {
      populate: ['user', 'organization.owner'],
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    // Check if user has required access
    const hasAccess = await this.checkUserWorkspaceAccess(userId, workspace, requiredRole);
    if (!hasAccess) {
      throw new ForbiddenException('Insufficient permissions for this workspace');
    }

    return workspace;
  }

  private async checkUserWorkspaceAccess(
    userId: string,
    workspace: Workspace,
    requiredRole: WorkspaceRole
  ): Promise<boolean> {
    // Owner access
    if (workspace.isUserOwned && workspace.user?.id === userId) {
      return true;
    }

    if (workspace.isOrganizationOwned && workspace.organization?.owner.id === userId) {
      return true;
    }

    // Check explicit access grant
    const access = await this.workspaceAccessRepository.findOne({
      workspace: workspace.id,
      user: userId,
    });

    if (!access?.isActive) {
      return workspace.isPublic && requiredRole === WorkspaceRole.VIEWER;
    }

    // Check role hierarchy
    const roleHierarchy = {
      [WorkspaceRole.VIEWER]: 1,
      [WorkspaceRole.EDITOR]: 2,
      [WorkspaceRole.ADMIN]: 3,
    };

    return roleHierarchy[access.role] >= roleHierarchy[requiredRole];
  }

  private async findCodebaseByIdAndWorkspace(
    userId: string,
    workspaceId: string,
    id: string,
    requiredRole: WorkspaceRole = WorkspaceRole.VIEWER
  ): Promise<Codebase> {
    await this.findAccessibleWorkspace(userId, workspaceId, requiredRole);

    const codebase = await this.codebaseRepository.findOne({
      id,
      workspace: workspaceId,
      deletedAt: null,
    }, {
      populate: ['owner', 'workspace'],
    });

    if (!codebase) {
      throw new NotFoundException('Codebase not found');
    }

    return codebase;
  }

  private async getCodebaseStats(codebaseId: string): Promise<CodebaseStatsDto> {
    // Simplified stats implementation
    const analysisCount = await this.analysisRunRepository.count({
      codebase: codebaseId,
    });

    const connectionCount = await this.connectionRepository.count({
      $or: [
        { sourceCodebase: codebaseId },
        { targetCodebase: codebaseId },
      ],
    });

    const incomingConnections = await this.connectionRepository.count({
      targetCodebase: codebaseId,
    });

    const outgoingConnections = await this.connectionRepository.count({
      sourceCodebase: codebaseId,
    });

    return {
      analysisCount,
      componentCount: 0,
      lastAnalysisStatus: undefined,
      healthScore: 100,
      errorCount: 0,
      telemetryEventsCount: 0,
      connectionCount,
      incomingConnections,
      outgoingConnections,
    };
  }

  private mapToResponseDto(codebase: Codebase): CodebaseResponseDto {
    return {
      id: codebase.id,
      workspaceId: codebase.workspace.id,
      name: codebase.name,
      description: codebase.description,
      repositoryUrl: codebase.repositoryUrl,
      repositoryProvider: codebase.repositoryProvider,
      repositoryId: codebase.repositoryId,
      defaultBranch: codebase.defaultBranch,
      language: codebase.language,
      framework: codebase.framework,
      status: codebase.status,
      settings: codebase.settings,
      lastAnalyzedAt: codebase.lastAnalyzedAt?.toISOString(),
      createdAt: codebase.createdAt.toISOString(),
      updatedAt: codebase.updatedAt.toISOString(),
    };
  }

  async getBlueprint(userId: string, workspaceId: string, codebaseId: string): Promise<any> {
    await this.findAccessibleWorkspace(userId, workspaceId, WorkspaceRole.VIEWER);

    const latestAnalysis = await this.analysisRunRepository.findOne(
      {
        codebase: codebaseId,
        status: AnalysisStatus.COMPLETED
      },
      {
        orderBy: { completedAt: 'DESC' }
      }
    );

    if (!latestAnalysis) {
      throw new NotFoundException('No completed analysis found for this codebase');
    }

    if (!latestAnalysis.blueprint) {
      throw new NotFoundException('No blueprint data found for this analysis');
    }

    return {
      analysisId: latestAnalysis.id,
      blueprint: latestAnalysis.blueprint,
    };
  }

  async getComponents(userId: string, workspaceId: string, codebaseId: string): Promise<any> {
    await this.findAccessibleWorkspace(userId, workspaceId, WorkspaceRole.VIEWER);

    const latestAnalysis = await this.analysisRunRepository.findOne(
      {
        codebase: codebaseId,
        status: AnalysisStatus.COMPLETED
      },
      {
        orderBy: { completedAt: 'DESC' }
      }
    );

    if (!latestAnalysis) {
      throw new NotFoundException('No completed analysis found for this codebase');
    }

    if (!latestAnalysis.blueprint?.components) {
      return {
        analysisId: latestAnalysis.id,
        components: [],
      };
    }

    return {
      analysisId: latestAnalysis.id,
      components: latestAnalysis.blueprint.components,
    };
  }

  async getConnections(userId: string, workspaceId: string, codebaseId: string): Promise<any> {
    await this.findAccessibleWorkspace(userId, workspaceId, WorkspaceRole.VIEWER);

    const latestAnalysis = await this.analysisRunRepository.findOne(
      {
        codebase: codebaseId,
        status: AnalysisStatus.COMPLETED
      },
      {
        orderBy: { completedAt: 'DESC' }
      }
    );

    if (!latestAnalysis) {
      throw new NotFoundException('No completed analysis found for this codebase');
    }

    if (latestAnalysis.blueprint?.connections) {
      const connections = latestAnalysis.blueprint.connections.map((conn: any) => ({
        id: conn.id,
        from: conn.from,
        to: conn.to,
        type: conn.type,
        weight: conn.weight || 1,
        protocol: conn.protocol,
        metadata: conn.metadata,
      }));

      return {
        analysisId: latestAnalysis.id,
        connections,
      };
    }

    return {
      analysisId: latestAnalysis.id,
      connections: [],
    };
  }
}