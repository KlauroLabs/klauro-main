import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager, FilterQuery, QueryOrder, wrap } from '@mikro-orm/core';

import { Project, ProjectStatus } from '../database/entities/project.entity';
import { Organization } from '../database/entities/organization.entity';
import { User } from '../database/entities/user.entity';
import { AnalysisRun } from '../database/entities/analysis-run.entity';
import { Component } from '../database/entities/component.entity';

import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectQueryDto } from './dto/project-query.dto';
import {
  ProjectResponseDto,
  ProjectWithStatsResponseDto,
  ProjectListResponseDto,
  ProjectDashboardDto,
  ProjectStatsDto,
} from './dto/project-response.dto';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: EntityRepository<Project>,
    @InjectRepository(Organization)
    private readonly organizationRepository: EntityRepository<Organization>,
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    @InjectRepository(AnalysisRun)
    private readonly analysisRunRepository: EntityRepository<AnalysisRun>,
    @InjectRepository(Component)
    private readonly componentRepository: EntityRepository<Component>,
    private readonly em: EntityManager,
  ) {}

  async create(
    organizationId: string,
    userId: string,
    createProjectDto: CreateProjectDto,
  ): Promise<ProjectResponseDto> {
    // Verify organization exists and user has access
    const organization = await this.organizationRepository.findOne({ id: organizationId });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const user = await this.userRepository.findOne({ id: userId });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if project name is unique within organization
    const existingProject = await this.projectRepository.findOne({
      name: createProjectDto.name,
      organization: organizationId,
      deletedAt: null,
    });

    if (existingProject) {
      throw new BadRequestException('Project name already exists in this organization');
    }

    // Create project
    const project = this.projectRepository.create({
      ...createProjectDto,
      organization,
      owner: user,
      status: ProjectStatus.ACTIVE,
      defaultBranch: createProjectDto.defaultBranch || 'main',
    } as any);

    await this.em.persistAndFlush(project);

    return this.mapToResponseDto(project);
  }

  async findAll(
    organizationId: string,
    queryDto: ProjectQueryDto,
  ): Promise<ProjectListResponseDto> {
    const { page = 1, limit = 20, sortBy = 'updatedAt', sortOrder = 'desc', ...filters } = queryDto;
    
    const where: FilterQuery<Project> = {
      organization: organizationId,
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

    const [projects, total] = await this.projectRepository.findAndCount(
      where,
      {
        populate: ['owner'],
        orderBy: { [sortBy]: sortOrder === 'asc' ? QueryOrder.ASC : QueryOrder.DESC },
        limit,
        offset: (page - 1) * limit,
      },
    );

    const totalPages = Math.ceil(total / limit);

    return {
      data: projects.map(project => this.mapToResponseDto(project)),
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  async findOne(
    organizationId: string,
    id: string,
  ): Promise<ProjectResponseDto> {
    const project = await this.findProjectByIdAndOrg(organizationId, id);
    return this.mapToResponseDto(project);
  }

  async findOneWithStats(
    organizationId: string,
    id: string,
  ): Promise<ProjectWithStatsResponseDto> {
    const project = await this.findProjectByIdAndOrg(organizationId, id);
    const stats = await this.getProjectStats(id);

    return {
      ...this.mapToResponseDto(project),
      stats,
    };
  }

  async update(
    organizationId: string,
    id: string,
    updateProjectDto: UpdateProjectDto,
  ): Promise<ProjectResponseDto> {
    const project = await this.findProjectByIdAndOrg(organizationId, id);

    // Check name uniqueness if name is being updated
    if (updateProjectDto.name && updateProjectDto.name !== project.name) {
      const existingProject = await this.projectRepository.findOne({
        name: updateProjectDto.name,
        organization: organizationId,
        id: { $ne: id },
        deletedAt: null,
      });

      if (existingProject) {
        throw new BadRequestException('Project name already exists in this organization');
      }
    }

    wrap(project).assign(updateProjectDto);
    await this.em.flush();

    return this.mapToResponseDto(project);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const project = await this.findProjectByIdAndOrg(organizationId, id);
    
    project.softDelete();
    project.archive();
    
    await this.em.flush();
  }

  async restore(organizationId: string, id: string): Promise<ProjectResponseDto> {
    const project = await this.projectRepository.findOne({
      id,
      organization: organizationId,
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    project.restore();
    await this.em.flush();

    return this.mapToResponseDto(project);
  }

  async getDashboard(organizationId: string): Promise<ProjectDashboardDto> {
    // Simplified dashboard implementation for now
    const totalProjects = await this.projectRepository.count({
      organization: organizationId,
    });

    return {
      totalProjects,
      activeProjects: 0,
      analyzingProjects: 0,
      errorProjects: 0,
      recentAnalysisCount: 0,
      totalComponents: 0,
      activeErrors: 0,
      averageHealthScore: 100,
    };
  }

  async markAsAnalyzing(organizationId: string, id: string): Promise<void> {
    const project = await this.findProjectByIdAndOrg(organizationId, id);
    project.markAsAnalyzing();
    await this.em.flush();
  }

  async markAsAnalyzed(organizationId: string, id: string): Promise<void> {
    const project = await this.findProjectByIdAndOrg(organizationId, id);
    project.markAsAnalyzed();
    await this.em.flush();
  }

  async markAsError(organizationId: string, id: string): Promise<void> {
    const project = await this.findProjectByIdAndOrg(organizationId, id);
    project.markAsError();
    await this.em.flush();
  }

  private async findProjectByIdAndOrg(organizationId: string, id: string): Promise<Project> {
    const project = await this.projectRepository.findOne({
      id,
      organization: organizationId,
      deletedAt: null,
    }, {
      populate: ['owner', 'organization'],
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return project;
  }

  private async getProjectStats(projectId: string): Promise<ProjectStatsDto> {
    // Simplified stats implementation - TODO: Fix complex queries for MikroORM v6
    // const analysisCount = await this.analysisRunRepository.count({
    //   project: projectId,
    // });

    // const componentCount = await this.componentRepository.count({
    //   analysisRun: {
    //     project: projectId,
    //   },
    // });

    // const lastAnalysis = await this.analysisRunRepository.findOne(
    //   { project: projectId },
    //   { orderBy: { createdAt: QueryOrder.DESC } },
    // );

    // // Simplified health score calculation
    // let healthScore = 0;
    // if (componentCount > 0) {
    //   const components = await this.componentRepository.find(
    //     {
    //       analysisRun: {
    //         project: projectId,
    //         status: 'completed',
    //       },
    //     },
    //     { orderBy: { createdAt: QueryOrder.DESC }, limit: 100 },
    //   );

    //   if (components.length > 0) {
    //     const avgComplexity = components.reduce((sum, c) => sum + c.complexity, 0) / components.length;
    //     const avgTestCoverage = components
    //       .filter(c => c.testCoverage !== null)
    //       .reduce((sum, c) => sum + (c.testCoverage || 0), 0) / Math.max(components.filter(c => c.testCoverage !== null).length, 1);
        
    //     healthScore = Math.max(0, 100 - (avgComplexity * 5) + (avgTestCoverage * 0.5));
    //   }
    // }

    return {
      analysisCount: 0,
      componentCount: 0,
      lastAnalysisStatus: undefined,
      healthScore: 100,
      errorCount: 0,
      telemetryEventsCount: 0,
    };
  }

  private mapToResponseDto(project: Project): ProjectResponseDto {
    return {
      id: project.id,
      organizationId: project.organization.id,
      ownerId: project.owner?.id,
      name: project.name,
      description: project.description,
      repositoryUrl: project.repositoryUrl,
      repositoryProvider: project.repositoryProvider,
      repositoryId: project.repositoryId,
      defaultBranch: project.defaultBranch,
      language: project.language,
      framework: project.framework,
      status: project.status,
      settings: project.settings,
      lastAnalyzedAt: project.lastAnalyzedAt?.toISOString(),
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }
}