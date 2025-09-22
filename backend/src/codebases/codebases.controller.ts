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

import { CodebasesService } from './codebases.service';
import { CreateCodebaseDto } from './dto/create-codebase.dto';
import { UpdateCodebaseDto } from './dto/update-codebase.dto';
import { CodebaseQueryDto } from './dto/codebase-query.dto';
import { CodebaseResponseDto, CodebaseWithStatsResponseDto, CodebaseListResponseDto, CodebaseDashboardDto } from './dto/codebase-response.dto';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('codebases')
@Controller('workspaces/:workspaceId/codebases')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class CodebasesController {
  constructor(private readonly codebasesService: CodebasesService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a new codebase',
    description: 'Creates a new codebase in the specified workspace',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiResponse({
    status: 201,
    description: 'Codebase created successfully',
    // type: CodebaseResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation error or duplicate name',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions or codebase limit reached',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace not found',
  })
  async create(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Body() createCodebaseDto: CreateCodebaseDto,
  ): Promise<CodebaseResponseDto> {
    const userId = req.user.id;
    return this.codebasesService.create(userId, workspaceId, createCodebaseDto);
  }

  @Post(':id')
  @ApiOperation({
    summary: 'Create codebase with specific ID',
    description: 'Creates a new codebase with a predefined ID (useful for migrations)',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'id',
    description: 'Codebase ID',
    type: 'string',
  })
  @ApiResponse({
    status: 201,
    description: 'Codebase created successfully with specified ID',
    // type: CodebaseResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation error or duplicate name/ID',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace not found',
  })
  async createWithId(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() createCodebaseDto: CreateCodebaseDto,
  ): Promise<CodebaseResponseDto> {
    const userId = req.user.id;
    return this.codebasesService.createWithId(userId, workspaceId, id, createCodebaseDto);
  }

  @Get()
  @ApiOperation({
    summary: 'Get all codebases',
    description: 'Retrieves a paginated list of codebases for the specified workspace',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'sortBy', required: false, type: String, description: 'Sort field' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Sort order' })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'archived', 'analyzing', 'error'], description: 'Codebase status' })
  @ApiQuery({ name: 'repositoryProvider', required: false, enum: ['github', 'gitlab', 'bitbucket', 'azure_devops', 'custom'], description: 'Repository provider' })
  @ApiQuery({ name: 'language', required: false, type: String, description: 'Programming language' })
  @ApiQuery({ name: 'framework', required: false, type: String, description: 'Framework' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search term' })
  @ApiResponse({
    status: 200,
    description: 'Codebases retrieved successfully',
    // type: CodebaseListResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - no access to workspace',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace not found',
  })
  async findAll(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Query() queryDto: CodebaseQueryDto,
  ): Promise<CodebaseListResponseDto> {
    const userId = req.user.id;
    return this.codebasesService.findAll(userId, workspaceId, queryDto);
  }

  @Get('dashboard')
  @ApiOperation({
    summary: 'Get dashboard statistics',
    description: 'Retrieves dashboard statistics for all codebases in the workspace',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard statistics retrieved successfully',
    type: CodebaseDashboardDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - no access to workspace',
  })
  @ApiResponse({
    status: 404,
    description: 'Workspace not found',
  })
  async getDashboard(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
  ): Promise<CodebaseDashboardDto> {
    const userId = req.user.id;
    return this.codebasesService.getDashboard(userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get codebase by ID',
    description: 'Retrieves a specific codebase by its ID',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'id',
    description: 'Codebase ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Codebase retrieved successfully',
    // type: CodebaseResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - no access to workspace',
  })
  @ApiResponse({
    status: 404,
    description: 'Codebase or workspace not found',
  })
  async findOne(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ): Promise<CodebaseResponseDto> {
    const userId = req.user.id;
    return this.codebasesService.findOne(userId, workspaceId, id);
  }

  @Get(':id/stats')
  @ApiOperation({
    summary: 'Get codebase with statistics',
    description: 'Retrieves a specific codebase with detailed statistics',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'id',
    description: 'Codebase ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Codebase with statistics retrieved successfully',
    type: CodebaseWithStatsResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - no access to workspace',
  })
  @ApiResponse({
    status: 404,
    description: 'Codebase or workspace not found',
  })
  async findOneWithStats(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ): Promise<CodebaseWithStatsResponseDto> {
    const userId = req.user.id;
    return this.codebasesService.findOneWithStats(userId, workspaceId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update codebase',
    description: 'Updates codebase details. Requires editor or admin permissions.',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'id',
    description: 'Codebase ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Codebase updated successfully',
    // type: CodebaseResponseDto,
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
    description: 'Codebase or workspace not found',
  })
  async update(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() updateCodebaseDto: UpdateCodebaseDto,
  ): Promise<CodebaseResponseDto> {
    const userId = req.user.id;
    return this.codebasesService.update(userId, workspaceId, id, updateCodebaseDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Archive codebase',
    description: 'Archives a codebase. Requires admin permissions.',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'id',
    description: 'Codebase ID',
    type: 'string',
  })
  @ApiResponse({
    status: 204,
    description: 'Codebase archived successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions',
  })
  @ApiResponse({
    status: 404,
    description: 'Codebase or workspace not found',
  })
  async remove(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ): Promise<void> {
    const userId = req.user.id;
    return this.codebasesService.remove(userId, workspaceId, id);
  }

  @Post(':id/restore')
  @ApiOperation({
    summary: 'Restore codebase',
    description: 'Restores an archived codebase. Requires admin permissions.',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'id',
    description: 'Codebase ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Codebase restored successfully',
    // type: CodebaseResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions',
  })
  @ApiResponse({
    status: 404,
    description: 'Codebase or workspace not found',
  })
  async restore(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ): Promise<CodebaseResponseDto> {
    const userId = req.user.id;
    return this.codebasesService.restore(userId, workspaceId, id);
  }

  @Post(':id/analyze')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Mark codebase as analyzing',
    description: 'Marks the codebase status as analyzing (used by analysis pipeline)',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'id',
    description: 'Codebase ID',
    type: 'string',
  })
  @ApiResponse({
    status: 202,
    description: 'Codebase marked as analyzing',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions',
  })
  @ApiResponse({
    status: 404,
    description: 'Codebase or workspace not found',
  })
  async markAsAnalyzing(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ): Promise<void> {
    const userId = req.user.id;
    return this.codebasesService.markAsAnalyzing(userId, workspaceId, id);
  }

  @Post(':id/analyzed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark codebase as analyzed',
    description: 'Marks the codebase as successfully analyzed (used by analysis pipeline)',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'id',
    description: 'Codebase ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Codebase marked as analyzed',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions',
  })
  @ApiResponse({
    status: 404,
    description: 'Codebase or workspace not found',
  })
  async markAsAnalyzed(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ): Promise<void> {
    const userId = req.user.id;
    return this.codebasesService.markAsAnalyzed(userId, workspaceId, id);
  }

  @Post(':id/error')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark codebase as error',
    description: 'Marks the codebase as having analysis errors (used by analysis pipeline)',
  })
  @ApiParam({
    name: 'workspaceId',
    description: 'Workspace ID',
    type: 'string',
  })
  @ApiParam({
    name: 'id',
    description: 'Codebase ID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Codebase marked as error',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - insufficient permissions',
  })
  @ApiResponse({
    status: 404,
    description: 'Codebase or workspace not found',
  })
  async markAsError(
    @Request() req: any,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ): Promise<void> {
    const userId = req.user.id;
    return this.codebasesService.markAsError(userId, workspaceId, id);
  }
}