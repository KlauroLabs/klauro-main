import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus, RepositoryProvider } from '../../database/entities/project.entity';

export class ProjectResponseDto {
  @ApiProperty({
    description: 'Unique project identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Organization ID that owns this project',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  organizationId!: string;

  @ApiPropertyOptional({
    description: 'User ID of the project owner',
    example: '123e4567-e89b-12d3-a456-426614174002',
  })
  ownerId?: string;

  @ApiProperty({
    description: 'Project name',
    example: 'My Awesome Project',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Project description',
    example: 'A revolutionary web application',
  })
  description?: string;

  @ApiPropertyOptional({
    description: 'Repository URL',
    example: 'https://github.com/user/awesome-project',
  })
  repositoryUrl?: string;

  @ApiPropertyOptional({
    description: 'Repository provider',
    enum: RepositoryProvider,
    example: RepositoryProvider.GITHUB,
  })
  repositoryProvider?: RepositoryProvider;

  @ApiPropertyOptional({
    description: 'Repository ID from provider',
    example: '123456789',
  })
  repositoryId?: string;

  @ApiProperty({
    description: 'Default branch to analyze',
    example: 'main',
  })
  defaultBranch!: string;

  @ApiPropertyOptional({
    description: 'Primary programming language',
    example: 'TypeScript',
  })
  language?: string;

  @ApiPropertyOptional({
    description: 'Primary framework',
    example: 'NestJS',
  })
  framework?: string;

  @ApiProperty({
    description: 'Project status',
    enum: ProjectStatus,
    example: ProjectStatus.ACTIVE,
  })
  status!: ProjectStatus;

  @ApiPropertyOptional({
    description: 'Project settings and configuration',
  })
  settings?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Last analysis timestamp',
    example: '2024-01-15T10:30:00.000Z',
  })
  lastAnalyzedAt?: string;

  @ApiProperty({
    description: 'Project creation timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2024-01-15T12:00:00.000Z',
  })
  updatedAt!: string;
}

export class ProjectStatsDto {
  @ApiProperty({
    description: 'Total number of analysis runs',
    example: 42,
  })
  analysisCount!: number;

  @ApiProperty({
    description: 'Total number of components detected',
    example: 156,
  })
  componentCount!: number;

  @ApiPropertyOptional({
    description: 'Status of the last analysis',
    example: 'completed',
  })
  lastAnalysisStatus?: string;

  @ApiProperty({
    description: 'Overall project health score (0-100)',
    example: 85.5,
  })
  healthScore!: number;

  @ApiProperty({
    description: 'Number of active errors',
    example: 3,
  })
  errorCount!: number;

  @ApiProperty({
    description: 'Telemetry events in the last 24 hours',
    example: 128,
  })
  telemetryEventsCount!: number;
}

export class ProjectWithStatsResponseDto extends ProjectResponseDto {
  @ApiProperty({
    description: 'Project statistics',
    type: ProjectStatsDto,
  })
  stats!: ProjectStatsDto;
}

export class ProjectListResponseDto {
  @ApiProperty({
    description: 'List of projects',
    type: [ProjectResponseDto],
  })
  data!: ProjectResponseDto[];

  @ApiProperty({
    description: 'Total number of projects',
    example: 100,
  })
  total!: number;

  @ApiProperty({
    description: 'Current page number',
    example: 1,
  })
  page!: number;

  @ApiProperty({
    description: 'Number of items per page',
    example: 20,
  })
  limit!: number;

  @ApiProperty({
    description: 'Total number of pages',
    example: 5,
  })
  totalPages!: number;

  @ApiProperty({
    description: 'Whether there are more pages',
    example: true,
  })
  hasMore!: boolean;
}

export class ProjectDashboardDto {
  @ApiProperty({
    description: 'Total number of projects',
    example: 15,
  })
  totalProjects!: number;

  @ApiProperty({
    description: 'Number of active projects',
    example: 12,
  })
  activeProjects!: number;

  @ApiProperty({
    description: 'Number of projects currently being analyzed',
    example: 2,
  })
  analyzingProjects!: number;

  @ApiProperty({
    description: 'Number of projects with errors',
    example: 1,
  })
  errorProjects!: number;

  @ApiProperty({
    description: 'Recent analysis runs (last 24 hours)',
    example: 8,
  })
  recentAnalysisCount!: number;

  @ApiProperty({
    description: 'Total components across all projects',
    example: 1542,
  })
  totalComponents!: number;

  @ApiProperty({
    description: 'Number of active errors across all projects',
    example: 7,
  })
  activeErrors!: number;

  @ApiProperty({
    description: 'Average health score across all projects',
    example: 82.3,
  })
  averageHealthScore!: number;
}