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

import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectQueryDto } from './dto/project-query.dto';
import {
  ProjectResponseDto,
  ProjectWithStatsResponseDto,
  ProjectListResponseDto,
  ProjectDashboardDto,
} from './dto/project-response.dto';

// TODO: Implement JwtAuthGuard when auth module is ready
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('projects')
@Controller('projects')
// @UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @ApiOperation({ 
    summary: 'Create a new project',
    description: 'Creates a new project in the current user\'s organization',
  })
  @ApiResponse({
    status: 201,
    description: 'Project created successfully',
    type: ProjectResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation error or duplicate name',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async create(
    @Body() createProjectDto: CreateProjectDto,
    @Request() req: any,
  ): Promise<ProjectResponseDto> {
    // TODO: Extract organizationId and userId from JWT token
    const organizationId = req.user?.organizationId || 'temp-org-id';
    const userId = req.user?.id || 'temp-user-id';
    
    return this.projectsService.create(organizationId, userId, createProjectDto);
  }

  @Get()
  @ApiOperation({
    summary: 'Get all projects',
    description: 'Retrieves a paginated list of projects for the current organization',
  })
  @ApiResponse({
    status: 200,
    description: 'Projects retrieved successfully',
    type: ProjectListResponseDto,
  })
  async findAll(
    @Query() queryDto: ProjectQueryDto,
    @Request() req: any,
  ): Promise<ProjectListResponseDto> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.findAll(organizationId, queryDto);
  }

  @Get('dashboard')
  @ApiOperation({
    summary: 'Get dashboard statistics',
    description: 'Retrieves dashboard statistics for all projects in the organization',
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard statistics retrieved successfully',
    type: ProjectDashboardDto,
  })
  async getDashboard(@Request() req: any): Promise<ProjectDashboardDto> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.getDashboard(organizationId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get project by ID',
    description: 'Retrieves a specific project by its ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Project retrieved successfully',
    type: ProjectResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async findOne(
    @Param('id') id: string,
    @Request() req: any,
  ): Promise<ProjectResponseDto> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.findOne(organizationId, id);
  }

  @Get(':id/stats')
  @ApiOperation({
    summary: 'Get project with statistics',
    description: 'Retrieves a specific project with detailed statistics',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Project with statistics retrieved successfully',
    type: ProjectWithStatsResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async findOneWithStats(
    @Param('id') id: string,
    @Request() req: any,
  ): Promise<ProjectWithStatsResponseDto> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.findOneWithStats(organizationId, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update project',
    description: 'Updates a specific project',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Project updated successfully',
    type: ProjectResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - validation error',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async update(
    @Param('id') id: string,
    @Body() updateProjectDto: UpdateProjectDto,
    @Request() req: any,
  ): Promise<ProjectResponseDto> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.update(organizationId, id, updateProjectDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete project',
    description: 'Soft deletes a project (archives it)',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 204,
    description: 'Project deleted successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async remove(
    @Param('id') id: string,
    @Request() req: any,
  ): Promise<void> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.remove(organizationId, id);
  }

  @Patch(':id/restore')
  @ApiOperation({
    summary: 'Restore deleted project',
    description: 'Restores a soft-deleted project',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Project restored successfully',
    type: ProjectResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async restore(
    @Param('id') id: string,
    @Request() req: any,
  ): Promise<ProjectResponseDto> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.restore(organizationId, id);
  }

  @Patch(':id/analyzing')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark project as analyzing',
    description: 'Internal endpoint to mark a project as currently being analyzed',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 204,
    description: 'Project marked as analyzing',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async markAsAnalyzing(
    @Param('id') id: string,
    @Request() req: any,
  ): Promise<void> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.markAsAnalyzing(organizationId, id);
  }

  @Patch(':id/analyzed')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark project as analyzed',
    description: 'Internal endpoint to mark a project as successfully analyzed',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 204,
    description: 'Project marked as analyzed',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async markAsAnalyzed(
    @Param('id') id: string,
    @Request() req: any,
  ): Promise<void> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.markAsAnalyzed(organizationId, id);
  }

  @Patch(':id/error')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark project as having analysis error',
    description: 'Internal endpoint to mark a project as having analysis errors',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 204,
    description: 'Project marked as having error',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async markAsError(
    @Param('id') id: string,
    @Request() req: any,
  ): Promise<void> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    return this.projectsService.markAsError(organizationId, id);
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'Get project analysis history',
    description: 'Retrieves analysis history for a project with trends',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Number of days to retrieve',
    example: 30,
  })
  @ApiResponse({
    status: 200,
    description: 'Analysis history retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async getHistory(
    @Param('id') id: string,
    @Query('days') days: number = 30,
    @Request() req: any,
  ): Promise<any> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    // return this.projectsService.getHistory(organizationId, id, days);
    return { message: 'History endpoint temporarily disabled' };
  }

  @Get(':id/compare')
  @ApiOperation({
    summary: 'Compare project versions',
    description: 'Compares two versions of project analysis',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'from',
    required: true,
    description: 'From version',
    example: '1.0.0',
  })
  @ApiQuery({
    name: 'to',
    required: true,
    description: 'To version',
    example: '1.1.0',
  })
  @ApiResponse({
    status: 200,
    description: 'Version comparison retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Project or version not found',
  })
  async compareVersions(
    @Param('id') id: string,
    @Query('from') fromVersion: string,
    @Query('to') toVersion: string,
    @Request() req: any,
  ): Promise<any> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    // return this.projectsService.compareVersions(organizationId, id, fromVersion, toVersion);
    return { message: 'Compare versions endpoint temporarily disabled' };
  }

  @Post(':id/scan')
  @ApiOperation({
    summary: 'Trigger issue scan',
    description: 'Triggers an issue scan for the project',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Issue scan completed',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async scanForIssues(
    @Param('id') id: string,
    @Request() req: any,
  ): Promise<any> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    // return this.projectsService.scanForIssues(organizationId, id);
    return { message: 'Scan for issues endpoint temporarily disabled' };
  }

  @Get(':id/issues')
  @ApiOperation({
    summary: 'Get project issues',
    description: 'Retrieves all issues for a project',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by status',
    enum: ['open', 'acknowledged', 'resolved', 'closed'],
  })
  @ApiQuery({
    name: 'severity',
    required: false,
    description: 'Filter by severity',
    enum: ['low', 'medium', 'high', 'critical'],
  })
  @ApiResponse({
    status: 200,
    description: 'Issues retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async getIssues(
    @Param('id') id: string,
    @Request() req: any,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
  ): Promise<any> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    // return this.projectsService.getIssues(organizationId, id, { status, severity });
    return { message: 'Get issues endpoint temporarily disabled' };
  }

  @Get(':id/hotspots')
  @ApiOperation({
    summary: 'Get bug hotspots',
    description: 'Retrieves bug hotspots for a project',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Number of hotspots to return',
    example: 10,
  })
  @ApiResponse({
    status: 200,
    description: 'Bug hotspots retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found',
  })
  async getBugHotspots(
    @Param('id') id: string,
    @Query('limit') limit: number = 10,
    @Request() req: any,
  ): Promise<any> {
    const organizationId = req.user?.organizationId || 'temp-org-id';
    // return this.projectsService.getBugHotspots(organizationId, id, limit);
    return { message: 'Bug hotspots endpoint temporarily disabled' };
  }
}