import { ApiProperty } from '@nestjs/swagger';
import { WorkspaceVisibility } from '../../database/entities/workspace.entity';

export class WorkspaceResponseDto {
  @ApiProperty({
    description: 'Workspace ID',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  id!: string;

  @ApiProperty({
    description: 'Workspace name',
    example: 'My Development Workspace',
  })
  name!: string;

  @ApiProperty({
    description: 'Workspace slug',
    example: 'my-dev-workspace',
  })
  slug!: string;

  @ApiProperty({
    description: 'Workspace description',
    example: 'A workspace for development projects',
    required: false,
  })
  description?: string;

  @ApiProperty({
    description: 'Workspace visibility',
    enum: WorkspaceVisibility,
    example: WorkspaceVisibility.PRIVATE,
  })
  visibility!: WorkspaceVisibility;

  @ApiProperty({
    description: 'Owner type',
    enum: ['user', 'organization'],
    example: 'user',
  })
  ownerType!: 'user' | 'organization';

  @ApiProperty({
    description: 'Owner ID',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  ownerId!: string;

  @ApiProperty({
    description: 'Owner name',
    example: 'John Doe',
  })
  ownerName!: string;

  @ApiProperty({
    description: 'Whether the workspace is active',
    example: true,
  })
  isActive!: boolean;

  @ApiProperty({
    description: 'Workspace settings',
    example: { theme: 'dark', notifications: true },
    required: false,
  })
  settings?: Record<string, any>;

  @ApiProperty({
    description: 'User role in workspace',
    enum: ['viewer', 'editor', 'admin', 'owner'],
    example: 'owner',
    required: false,
  })
  userRole?: string;

  @ApiProperty({
    description: 'Number of access grants',
    example: 5,
  })
  accessGrantCount!: number;

  @ApiProperty({
    description: 'Number of codebases',
    example: 12,
    required: false,
  })
  codebaseCount?: number;

  @ApiProperty({
    description: 'Number of tags',
    example: 3,
    required: false,
  })
  tagCount?: number;

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

export class WorkspaceListResponseDto {
  @ApiProperty({
    description: 'List of workspaces',
    type: [WorkspaceResponseDto],
  })
  data!: WorkspaceResponseDto[];

  @ApiProperty({
    description: 'Total number of workspaces',
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

export class WorkspaceStatsDto {
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
    description: 'Total number of connections',
    example: 150,
  })
  totalConnections!: number;

  @ApiProperty({
    description: 'Total number of analysis runs',
    example: 87,
  })
  totalAnalysisRuns!: number;

  @ApiProperty({
    description: 'Last analysis timestamp',
    example: '2024-01-15T10:30:00.000Z',
    required: false,
  })
  lastAnalysisAt?: string;

  @ApiProperty({
    description: 'Average health score',
    example: 85.5,
  })
  averageHealthScore!: number;
}