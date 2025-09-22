import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager, FilterQuery, QueryOrder, wrap } from '@mikro-orm/core';

import { Codebase, CodebaseStatus } from '../database/entities/codebase.entity';
import { Workspace } from '../database/entities/workspace.entity';
import { User } from '../database/entities/user.entity';
import { AnalysisRun } from '../database/entities/analysis-run.entity';
import { Component } from '../database/entities/component.entity';
import { CodebaseConnection } from '../database/entities/codebase-connection.entity';
import { Tag, TagType } from '../database/entities/tag.entity';
import { WorkspaceAccess, WorkspaceRole } from '../database/entities/workspace-access.entity';

import { CreateCodebaseDto } from './dto/create-codebase.dto';
import { UpdateCodebaseDto } from './dto/update-codebase.dto';
import { CodebaseQueryDto } from './dto/codebase-query.dto';
import { CodebaseResponseDto, CodebaseWithStatsResponseDto, CodebaseListResponseDto, CodebaseDashboardDto, CodebaseStatsDto } from './dto/codebase-response.dto';


@Injectable()
export class CodebasesService {
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
  ) {}

  async create(
    userId: string,
    workspaceId: string,
    createCodebaseDto: CreateCodebaseDto,
  ): Promise<CodebaseResponseDto> {
    // Verify workspace exists and user has access
    const workspace = await this.findAccessibleWorkspace(userId, workspaceId, WorkspaceRole.EDITOR);
    const user = await this.userRepository.findOneOrFail(userId, {
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

    // Create codebase
    const codebase = this.em.create(Codebase, {
      ...createCodebaseDto,
      workspace,
      owner: user,
      status: CodebaseStatus.ACTIVE,
      defaultBranch: createCodebaseDto.defaultBranch || 'main',
    } as any);

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

    // Create codebase with specific ID
    const codebase = this.em.create(Codebase, {
      id: codebaseId,
      ...createCodebaseDto,
      workspace,
      owner: user,
      status: CodebaseStatus.ACTIVE,
      defaultBranch: createCodebaseDto.defaultBranch || 'main',
    } as any);

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
}