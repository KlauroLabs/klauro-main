import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager, FilterQuery, QueryOrder, wrap } from '@mikro-orm/core';

import { Workspace, WorkspaceVisibility } from '../database/entities/workspace.entity';
import { WorkspaceAccess, WorkspaceRole, AccessStatus } from '../database/entities/workspace-access.entity';
import { Organization } from '../database/entities/organization.entity';
import { User } from '../database/entities/user.entity';
import { Tag, TagType } from '../database/entities/tag.entity';
import { Membership, MembershipRole } from '../database/entities/membership.entity';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { WorkspaceQueryDto } from './dto/workspace-query.dto';
import { GrantAccessDto } from './dto/grant-access.dto';
import { WorkspaceResponseDto, WorkspaceListResponseDto, WorkspaceStatsDto } from './dto/workspace-response.dto';

export { CreateWorkspaceDto } from './dto/create-workspace.dto';
export { UpdateWorkspaceDto } from './dto/update-workspace.dto';
export { WorkspaceQueryDto } from './dto/workspace-query.dto';
export { GrantAccessDto } from './dto/grant-access.dto';
export { WorkspaceResponseDto, WorkspaceListResponseDto, WorkspaceStatsDto } from './dto/workspace-response.dto';


@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Workspace)
    private readonly workspaceRepository: EntityRepository<Workspace>,
    @InjectRepository(WorkspaceAccess)
    private readonly workspaceAccessRepository: EntityRepository<WorkspaceAccess>,
    @InjectRepository(Organization)
    private readonly organizationRepository: EntityRepository<Organization>,
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    @InjectRepository(Tag)
    private readonly tagRepository: EntityRepository<Tag>,
    @InjectRepository(Membership)
    private readonly membershipRepository: EntityRepository<Membership>,
    private readonly em: EntityManager,
  ) {}

  async createUserWorkspace(
    userId: string,
    createWorkspaceDto: CreateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    const user = await this.userRepository.findOneOrFail(userId, {
      populate: ['ownedWorkspaces'],
      failHandler: () => new NotFoundException('User not found'),
    });

    // Check if user can create workspace
    if (!user.canCreateWorkspace()) {
      throw new ForbiddenException('User has reached workspace limit for their billing tier');
    }

    // Check slug uniqueness
    await this.checkSlugUniqueness(createWorkspaceDto.slug);

    const workspace = this.workspaceRepository.create({
      name: createWorkspaceDto.name,
      slug: createWorkspaceDto.slug,
      description: createWorkspaceDto.description,
      settings: createWorkspaceDto.settings,
      user: user,
      isActive: true,
      visibility: createWorkspaceDto.visibility || WorkspaceVisibility.PRIVATE,
    } as any);

    await this.em.persistAndFlush(workspace);

    return this.mapToResponseDto(workspace, user);
  }

  async createOrganizationWorkspace(
    organizationId: string,
    userId: string,
    createWorkspaceDto: CreateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    const organization = await this.organizationRepository.findOneOrFail(organizationId, {
      populate: ['owner', 'workspaces'],
      failHandler: () => new NotFoundException('Organization not found'),
    });

    const user = await this.userRepository.findOneOrFail(userId, {
      failHandler: () => new NotFoundException('User not found'),
    });

    // Check if organization can create workspace
    if (!organization.canCreateWorkspace()) {
      throw new ForbiddenException('Organization has reached workspace limit for their billing tier');
    }

    // Verify user has permission (owner or admin member)
    if (organization.owner.id !== userId) {
      const membership = await this.membershipRepository.findOne({
        user: userId,
        organization: organizationId,
      });

      if (!membership || !membership.isAdmin) {
        throw new ForbiddenException('User does not have permission to create workspaces for this organization');
      }
    }

    // Check slug uniqueness
    await this.checkSlugUniqueness(createWorkspaceDto.slug);

    const workspace = this.workspaceRepository.create({
      name: createWorkspaceDto.name,
      slug: createWorkspaceDto.slug,
      description: createWorkspaceDto.description,
      settings: createWorkspaceDto.settings,
      organization: organization,
      isActive: true,
      visibility: createWorkspaceDto.visibility || WorkspaceVisibility.PRIVATE,
    } as any);

    await this.em.persistAndFlush(workspace);

    return this.mapToResponseDto(workspace, user);
  }

  async findAccessibleWorkspaces(
    userId: string,
    queryDto: WorkspaceQueryDto,
  ): Promise<WorkspaceListResponseDto> {
    const { page = 1, limit = 20, sortBy = 'updatedAt', sortOrder = 'desc', ...filters } = queryDto;

    const user = await this.userRepository.findOneOrFail(userId, {
      populate: ['ownedWorkspaces', 'workspaceAccess.workspace'],
      failHandler: () => new NotFoundException('User not found'),
    });

    // Build base query for workspaces user can access
    const where: FilterQuery<Workspace> = {
      deletedAt: null,
      isActive: true,
    };

    // Apply visibility filters
    const accessibleWorkspaceIds = await this.getAccessibleWorkspaceIds(userId);
    where.id = { $in: accessibleWorkspaceIds };

    // Apply additional filters
    if (filters.visibility) {
      where.visibility = filters.visibility;
    }

    if (filters.search) {
      where.$or = [
        { name: { $ilike: `%${filters.search}%` } },
        { description: { $ilike: `%${filters.search}%` } },
        { slug: { $ilike: `%${filters.search}%` } },
      ];
    }

    if (filters.owned) {
      where.user = userId;
    }

    const [workspaces, total] = await this.workspaceRepository.findAndCount(
      where,
      {
        populate: ['user', 'organization', 'accessGrants'],
        orderBy: { [sortBy]: sortOrder === 'asc' ? QueryOrder.ASC : QueryOrder.DESC },
        limit,
        offset: (page - 1) * limit,
      },
    );

    const totalPages = Math.ceil(total / limit);

    const workspaceResponses = await Promise.all(
      workspaces.map(workspace => this.mapToResponseDto(workspace, user))
    );

    return {
      data: workspaceResponses,
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  async findOne(userId: string, workspaceId: string): Promise<WorkspaceResponseDto> {
    const workspace = await this.findAccessibleWorkspace(userId, workspaceId);
    const user = await this.userRepository.findOneOrFail(userId);
    return this.mapToResponseDto(workspace, user);
  }

  async update(
    userId: string,
    workspaceId: string,
    updateWorkspaceDto: UpdateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    const workspace = await this.findAccessibleWorkspace(userId, workspaceId);
    const user = await this.userRepository.findOneOrFail(userId);

    // Check permissions - only owner or admins can update
    const userRole = await this.getUserWorkspaceRole(userId, workspaceId);
    if (!this.isOwner(workspace, userId) && userRole !== WorkspaceRole.ADMIN) {
      throw new ForbiddenException('Insufficient permissions to update workspace');
    }

    // Check slug uniqueness if being updated
    if (updateWorkspaceDto.slug && updateWorkspaceDto.slug !== workspace.slug) {
      await this.checkSlugUniqueness(updateWorkspaceDto.slug);
    }

    wrap(workspace).assign(updateWorkspaceDto);
    await this.em.flush();

    return this.mapToResponseDto(workspace, user);
  }

  async archive(userId: string, workspaceId: string): Promise<void> {
    const workspace = await this.findAccessibleWorkspace(userId, workspaceId);

    // Check permissions - only owner can archive
    if (!this.isOwner(workspace, userId)) {
      throw new ForbiddenException('Only workspace owner can archive workspace');
    }

    workspace.archive();
    await this.em.flush();
  }

  async restore(userId: string, workspaceId: string): Promise<WorkspaceResponseDto> {
    const workspace = await this.workspaceRepository.findOneOrFail(workspaceId, {
      populate: ['user', 'organization'],
      failHandler: () => new NotFoundException('Workspace not found'),
    });

    // Check permissions - only owner can restore
    if (!this.isOwner(workspace, userId)) {
      throw new ForbiddenException('Only workspace owner can restore workspace');
    }

    workspace.restore();
    await this.em.flush();

    const user = await this.userRepository.findOneOrFail(userId);
    return this.mapToResponseDto(workspace, user);
  }

  async grantAccess(
    userId: string,
    workspaceId: string,
    grantAccessDto: GrantAccessDto,
  ): Promise<void> {
    const workspace = await this.findAccessibleWorkspace(userId, workspaceId);
    const granteeUser = await this.userRepository.findOneOrFail(grantAccessDto.userId, {
      failHandler: () => new NotFoundException('User to grant access not found'),
    });

    // Check permissions - only owner or admins can grant access
    const userRole = await this.getUserWorkspaceRole(userId, workspaceId);
    if (!this.isOwner(workspace, userId) && userRole !== WorkspaceRole.ADMIN) {
      throw new ForbiddenException('Insufficient permissions to grant access');
    }

    // Check if access already exists
    const existingAccess = await this.workspaceAccessRepository.findOne({
      workspace: workspaceId,
      user: grantAccessDto.userId,
    });

    if (existingAccess) {
      // Update existing access
      existingAccess.role = grantAccessDto.role;
      existingAccess.activate();
      if (grantAccessDto.expiresAt) {
        existingAccess.setExpiration(grantAccessDto.expiresAt);
      }
      if (grantAccessDto.notes) {
        existingAccess.notes = grantAccessDto.notes;
      }
    } else {
      // Create new access
      const access = this.em.create(WorkspaceAccess, {
        workspace,
        user: granteeUser,
        role: grantAccessDto.role,
        status: AccessStatus.ACTIVE,
        grantedBy: await this.userRepository.findOneOrFail(userId),
        grantedAt: new Date(),
        expiresAt: grantAccessDto.expiresAt,
        notes: grantAccessDto.notes,
      } as any);

      this.em.persist(access);
    }

    await this.em.flush();
  }

  async revokeAccess(userId: string, workspaceId: string, targetUserId: string): Promise<void> {
    const workspace = await this.findAccessibleWorkspace(userId, workspaceId);

    // Check permissions - only owner or admins can revoke access
    const userRole = await this.getUserWorkspaceRole(userId, workspaceId);
    if (!this.isOwner(workspace, userId) && userRole !== WorkspaceRole.ADMIN) {
      throw new ForbiddenException('Insufficient permissions to revoke access');
    }

    const access = await this.workspaceAccessRepository.findOne({
      workspace: workspaceId,
      user: targetUserId,
    });

    if (!access) {
      throw new NotFoundException('Access grant not found');
    }

    const revokedBy = await this.userRepository.findOneOrFail(userId);
    access.revoke(revokedBy);

    await this.em.flush();
  }

  async getWorkspaceStats(userId: string, workspaceId: string): Promise<WorkspaceStatsDto> {
    await this.findAccessibleWorkspace(userId, workspaceId);

    // TODO: Implement actual stats calculation when Codebase entities are integrated
    return {
      totalCodebases: 0,
      activeCodebases: 0,
      analyzingCodebases: 0,
      errorCodebases: 0,
      totalConnections: 0,
      totalAnalysisRuns: 0,
      averageHealthScore: 100,
    };
  }

  private async findAccessibleWorkspace(userId: string, workspaceId: string): Promise<Workspace> {
    const workspace = await this.workspaceRepository.findOne(
      { id: workspaceId, deletedAt: null },
      { populate: ['user', 'organization', 'accessGrants'] }
    );

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    // Check if user has access
    const hasAccess = await this.checkUserAccess(userId, workspace);
    if (!hasAccess) {
      throw new ForbiddenException('No access to this workspace');
    }

    return workspace;
  }

  private async checkUserAccess(userId: string, workspace: Workspace): Promise<boolean> {
    // Owner access
    if (this.isOwner(workspace, userId)) {
      return true;
    }

    // Public workspace access
    if (workspace.isPublic) {
      return true;
    }

    // Explicit access grant
    const access = await this.workspaceAccessRepository.findOne({
      workspace: workspace.id,
      user: userId,
    });

    return access?.isActive || false;
  }

  private isOwner(workspace: Workspace, userId: string): boolean {
    if (workspace.isUserOwned) {
      return workspace.user?.id === userId;
    }

    if (workspace.isOrganizationOwned) {
      return workspace.organization?.owner.id === userId;
    }

    return false;
  }

  private async getUserWorkspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const access = await this.workspaceAccessRepository.findOne({
      workspace: workspaceId,
      user: userId,
    });

    return access?.isActive ? access.role : null;
  }

  private async getAccessibleWorkspaceIds(userId: string): Promise<string[]> {
    const user = await this.userRepository.findOne(userId, {
      populate: ['ownedWorkspaces', 'workspaceAccess.workspace'],
    });

    if (!user) return [];

    const ownedWorkspaceIds = user.ownedWorkspaces.getItems().map(w => w.id);
    const accessedWorkspaceIds = user.workspaceAccess.getItems()
      .filter(access => access.isActive)
      .map(access => access.workspace.id);

    // Also include public workspaces
    const publicWorkspaces = await this.workspaceRepository.find({
      visibility: WorkspaceVisibility.PUBLIC,
      deletedAt: null,
      isActive: true,
    });
    const publicWorkspaceIds = publicWorkspaces.map(w => w.id);

    return [...new Set([...ownedWorkspaceIds, ...accessedWorkspaceIds, ...publicWorkspaceIds])];
  }

  private async checkSlugUniqueness(slug: string): Promise<void> {
    const existingWorkspace = await this.workspaceRepository.findOne({
      slug,
      deletedAt: null,
    });

    if (existingWorkspace) {
      throw new BadRequestException('Workspace slug already exists');
    }
  }

  private async mapToResponseDto(workspace: Workspace, currentUser: User): Promise<WorkspaceResponseDto> {
    const userRole = await this.getUserWorkspaceRole(currentUser.id, workspace.id);

    // Get additional counts
    const tagCount = await this.tagRepository.count({
      workspace: workspace.id,
      type: TagType.WORKSPACE,
      isActive: true,
    });

    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      description: workspace.description,
      visibility: workspace.visibility,
      ownerType: workspace.ownerType,
      ownerId: workspace.ownerId,
      ownerName: workspace.isUserOwned ? workspace.user!.displayName : workspace.organization!.name,
      isActive: workspace.isActive,
      settings: workspace.settings,
      userRole: userRole || undefined,
      accessGrantCount: workspace.accessGrantCount,
      tagCount,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    };
  }
}