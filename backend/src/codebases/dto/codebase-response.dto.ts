import { ApiProperty } from '@nestjs/swagger';
import { CodebaseStatus } from '../../database/entities/codebase.entity';

export class CodebaseResponseDto {
  @ApiProperty({
    description: 'Codebase ID',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  id!: string;

  @ApiProperty({
    description: 'Codebase name',
    example: 'My Application',
  })
  name!: string;

  @ApiProperty({
    description: 'Codebase description',
    example: 'A web application built with React and Node.js',
    required: false,
  })
  description?: string;

  @ApiProperty({
    description: 'Workspace ID',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  workspaceId!: string;

  @ApiProperty({
    description: 'Repository URL',
    example: 'https://github.com/user/repo.git',
    required: false,
  })
  repositoryUrl?: string;

  @ApiProperty({
    description: 'Repository provider',
    example: 'github',
    required: false,
  })
  repositoryProvider?: string;

  @ApiProperty({
    description: 'Repository ID',
    example: '123456789',
    required: false,
  })
  repositoryId?: string;

  @ApiProperty({
    description: 'Default branch',
    example: 'main',
    required: false,
  })
  defaultBranch?: string;

  @ApiProperty({
    description: 'Primary language',
    example: 'TypeScript',
    required: false,
  })
  language?: string;

  @ApiProperty({
    description: 'Primary framework',
    example: 'React',
    required: false,
  })
  framework?: string;

  @ApiProperty({
    description: 'Codebase status',
    enum: CodebaseStatus,
    example: CodebaseStatus.ACTIVE,
  })
  status!: CodebaseStatus;

  @ApiProperty({
    description: 'Last analysis timestamp',
    example: '2024-01-15T10:30:00.000Z',
    required: false,
  })
  lastAnalyzedAt?: string;

  @ApiProperty({
    description: 'Codebase settings',
    example: { autoAnalyze: true, notifyOnChanges: false },
    required: false,
  })
  settings?: Record<string, any>;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2024-01-15T10:30:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2024-01-15T10:30:00.000Z',
  })
  updatedAt!: string;
}

export class CodebaseWithStatsResponseDto extends CodebaseResponseDto {
  @ApiProperty({
    description: 'Number of files',
    example: 1250,
    required: false,
  })
  fileCount?: number;

  @ApiProperty({
    description: 'Size in bytes',
    example: 5242880,
    required: false,
  })
  sizeBytes?: number;

  @ApiProperty({
    description: 'Language breakdown',
    example: { TypeScript: 70, JavaScript: 20, CSS: 10 },
    required: false,
  })
  languageBreakdown?: Record<string, number>;

  @ApiProperty({
    description: 'Health score',
    example: 85.5,
    required: false,
  })
  healthScore?: number;

  @ApiProperty({
    description: 'Number of components',
    example: 45,
    required: false,
  })
  componentCount?: number;

  @ApiProperty({
    description: 'Number of connections',
    example: 120,
    required: false,
  })
  connectionCount?: number;
}

export class CodebaseListResponseDto {
  @ApiProperty({
    description: 'List of codebases',
    type: [CodebaseResponseDto],
  })
  data!: CodebaseResponseDto[];

  @ApiProperty({
    description: 'Total number of codebases',
    example: 42,
  })
  total!: number;

  @ApiProperty({
    description: 'Current page number',
    example: 1,
  })
  page!: number;

  @ApiProperty({
    description: 'Items per page',
    example: 20,
  })
  limit!: number;

  @ApiProperty({
    description: 'Total number of pages',
    example: 3,
  })
  totalPages!: number;

  @ApiProperty({
    description: 'Whether there are more pages',
    example: true,
  })
  hasMore!: boolean;
}

export class CodebaseDashboardDto {
  @ApiProperty({
    description: 'Total number of codebases',
    example: 25,
  })
  totalCodebases!: number;

  @ApiProperty({
    description: 'Number of active codebases',
    example: 20,
  })
  activeCodebases!: number;

  @ApiProperty({
    description: 'Number of codebases being analyzed',
    example: 2,
  })
  analyzingCodebases!: number;

  @ApiProperty({
    description: 'Number of codebases with errors',
    example: 3,
  })
  errorCodebases!: number;

  @ApiProperty({
    description: 'Total number of components',
    example: 500,
  })
  totalComponents!: number;

  @ApiProperty({
    description: 'Total number of connections',
    example: 1250,
  })
  totalConnections!: number;

  @ApiProperty({
    description: 'Language distribution',
    example: { TypeScript: 60, JavaScript: 30, Python: 10 },
  })
  languageDistribution!: Record<string, number>;

  @ApiProperty({
    description: 'Framework distribution',
    example: { React: 40, NestJS: 30, Django: 20, Express: 10 },
  })
  frameworkDistribution!: Record<string, number>;

  @ApiProperty({
    description: 'Recent analysis activity',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        analysisCount: { type: 'number' },
      },
    },
  })
  recentActivity!: Array<{ date: string; analysisCount: number }>;
}

export class CodebaseStatsDto {
  @ApiProperty({
    description: 'Number of analysis runs',
    example: 15,
  })
  analysisCount!: number;

  @ApiProperty({
    description: 'Number of components',
    example: 45,
  })
  componentCount!: number;

  @ApiProperty({
    description: 'Last analysis status',
    example: 'completed',
    required: false,
  })
  lastAnalysisStatus?: string;

  @ApiProperty({
    description: 'Overall health score',
    example: 85,
  })
  healthScore!: number;

  @ApiProperty({
    description: 'Number of errors',
    example: 3,
  })
  errorCount!: number;

  @ApiProperty({
    description: 'Number of telemetry events',
    example: 1250,
  })
  telemetryEventsCount!: number;

  @ApiProperty({
    description: 'Total number of connections',
    example: 8,
  })
  connectionCount!: number;

  @ApiProperty({
    description: 'Number of incoming connections',
    example: 5,
  })
  incomingConnections!: number;

  @ApiProperty({
    description: 'Number of outgoing connections',
    example: 3,
  })
  outgoingConnections!: number;
}