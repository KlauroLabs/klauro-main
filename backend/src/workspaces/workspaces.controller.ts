import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';

import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { WorkspaceQueryDto } from './dto/workspace-query.dto';
import { GrantAccessDto } from './dto/grant-access.dto';
import { WorkspaceResponseDto, WorkspaceListResponseDto, WorkspaceStatsDto } from './dto/workspace-response.dto';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('workspaces')
@Controller('workspaces')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Post('user')
  @ApiOperation({
    summary: 'Create a user workspace',
    description: 'Creates a new workspace owned by the current user',
  })
  @ApiResponse({
    status: 201,
    description: 'Workspace successfully created',
    type: WorkspaceResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation failed or slug already exists',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - user has reached workspace limit',
  })
  async createUserWorkspace(
    @Request() req: any,
    @Body() createWorkspaceDto: CreateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    const userId = req.user.id;
    return this.workspacesService.createUserWorkspace(userId, createWorkspaceDto);
  }

  @Post('organization/:organizationId')
  @ApiOperation({
    summary: 'Create an organization workspace',
    description: 'Creates a new workspace owned by the specified organization',
  })
  @ApiParam({
    name: 'organizationId',
    description: 'Organization ID',
    type: 'string',
  })
  @ApiResponse({
    status: 201,
    description: 'Workspace successfully created',
    type: WorkspaceResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation failed or slug already exists',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions or workspace limit reached',
  })
  @ApiResponse({
    status: 404,
    description: 'Organization not found',
  })
  async createOrganizationWorkspace(
    @Request() req: any,
    @Param('organizationId') organizationId: string,
    @Body() createWorkspaceDto: CreateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    const userId = req.user.id;
    return this.workspacesService.createOrganizationWorkspace(
      organizationId,
      userId,
      createWorkspaceDto,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Get accessible workspaces',
    description: 'Retrieves workspaces that the current user has access to',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'sortBy', required: false, type: String, description: 'Sort field' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Sort order' })
  @ApiQuery({ name: 'visibility', required: false, enum: ['private', 'public', 'internal'], description: 'Workspace visibility' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search term' })
  @ApiQuery({ name: 'owned', required: false, type: Boolean, description: 'Show only owned workspaces' })
  @ApiQuery({ name: 'accessed', required: false, type: Boolean, description: 'Show only accessed workspaces' })
  @ApiResponse({
    status: 200,
    description: 'List of accessible workspaces',
    type: WorkspaceListResponseDto,
  })
  async findAll(
    @Request() req: any,
    @Query() queryDto: WorkspaceQueryDto,
  ): Promise<WorkspaceListResponseDto> {
    const userId = req.user.id;
    return this.workspacesService.findAccessibleWorkspaces(userId, queryDto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get workspace by ID',
    description: 'Retrieves a specific workspace by its ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Workspace details',
    type: WorkspaceResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - no access to workspace',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace not found',
  })
  async findOne(
    @Request() req: any,
    @Param('id') id: string,
  ): Promise<WorkspaceResponseDto> {
    const userId = req.user.id;
    return this.workspacesService.findOne(userId, id);
  }

  @Get(':id/stats')
  @ApiOperation({
    summary: 'Get workspace statistics',
    description: 'Retrieves statistics for a specific workspace',
  })
  @ApiParam({
    name: 'id',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Workspace statistics',
    type: WorkspaceStatsDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - no access to workspace',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace not found',
  })
  async getStats(
    @Request() req: any,
    @Param('id') id: string,
  ): Promise<WorkspaceStatsDto> {
    const userId = req.user.id;
    return this.workspacesService.getWorkspaceStats(userId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update workspace',
    description: 'Updates workspace details. Requires admin or owner permissions.',
  })
  @ApiParam({
    name: 'id',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Workspace successfully updated',
    type: WorkspaceResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation failed',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace not found',
  })
  async update(
    @Request() req: any,
    @Param('id') id: string,
    @Body() updateWorkspaceDto: UpdateWorkspaceDto,
  ): Promise<WorkspaceResponseDto> {
    const userId = req.user.id;
    return this.workspacesService.update(userId, id, updateWorkspaceDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Archive workspace',
    description: 'Archives a workspace. Only the owner can archive a workspace.',
  })
  @ApiParam({
    name: 'id',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiResponse({
    status: 204,
    description: 'Workspace successfully archived',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - only owner can archive workspace',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace not found',
  })
  async archive(@Request() req: any, @Param('id') id: string): Promise<void> {
    const userId = req.user.id;
    return this.workspacesService.archive(userId, id);
  }

  @Post(':id/restore')
  @ApiOperation({
    summary: 'Restore workspace',
    description: 'Restores an archived workspace. Only the owner can restore a workspace.',
  })
  @ApiParam({
    name: 'id',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Workspace successfully restored',
    type: WorkspaceResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - only owner can restore workspace',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace not found',
  })
  async restore(
    @Request() req: any,
    @Param('id') id: string,
  ): Promise<WorkspaceResponseDto> {
    const userId = req.user.id;
    return this.workspacesService.restore(userId, id);
  }

  @Post(':id/access')
  @ApiOperation({
    summary: 'Grant workspace access',
    description: 'Grants access to a user for the workspace. Requires admin or owner permissions.',
  })
  @ApiParam({
    name: 'id',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiResponse({
    status: 201,
    description: 'Access successfully granted',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation failed',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace or user not found',
  })
  async grantAccess(
    @Request() req: any,
    @Param('id') id: string,
    @Body() grantAccessDto: GrantAccessDto,
  ): Promise<void> {
    const userId = req.user.id;
    return this.workspacesService.grantAccess(userId, id, grantAccessDto);
  }

  @Delete(':id/access/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke workspace access',
    description: 'Revokes user access to the workspace. Requires admin or owner permissions.',
  })
  @ApiParam({
    name: 'id',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'userId',
    description: 'User ID to revoke access from',
    type: 'string',
  })
  @ApiResponse({
    status: 204,
    description: 'Access successfully revoked',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace or access grant not found',
  })
  async revokeAccess(
    @Request() req: any,
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
  ): Promise<void> {
    const userId = req.user.id;
    return this.workspacesService.revokeAccess(userId, id, targetUserId);
  }
}