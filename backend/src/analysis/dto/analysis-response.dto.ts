import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnalysisStatus, AnalysisType } from '../../database/entities/analysis-run.entity';

export class AnalysisRunResponseDto {
  @ApiProperty({
    description: 'Analysis run ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Project ID',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  projectId!: string;

  @ApiProperty({
    description: 'User ID who triggered the analysis',
    example: '123e4567-e89b-12d3-a456-426614174002',
  })
  triggeredById?: string;

  @ApiProperty({
    description: 'Analysis status',
    enum: AnalysisStatus,
    example: AnalysisStatus.RUNNING,
  })
  status!: AnalysisStatus;

  @ApiProperty({
    description: 'Analysis type',
    enum: AnalysisType,
    example: AnalysisType.MANUAL,
  })
  type!: AnalysisType;

  @ApiPropertyOptional({
    description: 'Branch being analyzed',
    example: 'main',
  })
  branch?: string;

  @ApiPropertyOptional({
    description: 'Commit SHA being analyzed',
    example: 'a1b2c3d4e5f6789012345678901234567890abcd',
  })
  commitSha?: string;

  @ApiPropertyOptional({
    description: 'Analysis start timestamp',
    example: '2024-01-15T10:00:00.000Z',
  })
  startedAt?: string;

  @ApiPropertyOptional({
    description: 'Analysis completion timestamp',
    example: '2024-01-15T10:05:30.000Z',
  })
  completedAt?: string;

  @ApiProperty({
    description: 'Processing time in milliseconds',
    example: 330000,
  })
  processingTimeMs?: number;

  @ApiProperty({
    description: 'Analysis progress percentage (0-100)',
    example: 75,
  })
  progress?: number;

  @ApiPropertyOptional({
    description: 'Current operation being performed',
    example: 'Analyzing components...',
  })
  currentOperation?: string;

  @ApiPropertyOptional({
    description: 'Error message if analysis failed',
    example: 'Repository not accessible',
  })
  errorMessage?: string;

  @ApiPropertyOptional({
    description: 'Analysis configuration used',
  })
  configuration?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Analysis metadata',
  })
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Path to generated manifest file',
    example: '/manifests/analysis-123.json',
  })
  manifestPath?: string;

  @ApiProperty({
    description: 'Analysis run creation timestamp',
    example: '2024-01-15T09:55:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: 'Analysis run last update timestamp',
    example: '2024-01-15T10:05:30.000Z',
  })
  updatedAt!: string;
}

export class AnalysisRunListResponseDto {
  @ApiProperty({
    description: 'List of analysis runs',
    type: [AnalysisRunResponseDto],
  })
  data!: AnalysisRunResponseDto[];

  @ApiProperty({
    description: 'Total number of analysis runs',
    example: 45,
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
    example: 3,
  })
  totalPages!: number;

  @ApiProperty({
    description: 'Whether there are more pages',
    example: true,
  })
  hasMore!: boolean;
}

export class AnalysisProgressDto {
  @ApiProperty({
    description: 'Analysis run ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  analysisId!: string;

  @ApiProperty({
    description: 'Current status',
    enum: AnalysisStatus,
    example: AnalysisStatus.RUNNING,
  })
  status!: AnalysisStatus;

  @ApiProperty({
    description: 'Progress percentage (0-100)',
    example: 45,
  })
  progress!: number;

  @ApiPropertyOptional({
    description: 'Current operation',
    example: 'Analyzing TypeScript components...',
  })
  currentOperation?: string;

  @ApiProperty({
    description: 'Estimated time remaining in milliseconds',
    example: 120000,
  })
  estimatedTimeRemaining?: number;

  @ApiProperty({
    description: 'Timestamp of this progress update',
    example: '2024-01-15T10:02:30.000Z',
  })
  timestamp!: string;
}

export class ArchitectureBlueprintDto {
  @ApiProperty({
    description: 'Analysis run ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Project name',
    example: 'My Awesome Project',
  })
  projectName!: string;

  @ApiProperty({
    description: 'Detected primary framework',
    example: 'NestJS',
  })
  framework!: string;

  @ApiProperty({
    description: 'List of detected components',
    example: [],
  })
  components!: any[];

  @ApiProperty({
    description: 'Component connections and relationships',
    example: [],
  })
  connections!: any[];

  @ApiProperty({
    description: 'Entry points (routes, endpoints, etc.)',
    example: [],
  })
  entryPoints!: any[];

  @ApiProperty({
    description: 'Exit points (external APIs, databases, etc.)',
    example: [],
  })
  exitPoints!: any[];

  @ApiProperty({
    description: 'Components with no dependencies or dependents',
    example: [],
  })
  orphanedComponents!: string[];

  @ApiProperty({
    description: 'Areas of concern or high risk',
    example: [],
  })
  riskAreas!: any[];

  @ApiProperty({
    description: 'Technology stack information',
    example: {},
  })
  technologyStack!: any;

  @ApiProperty({
    description: 'Dependency analysis results',
    example: {},
  })
  dependencies!: any;

  @ApiProperty({
    description: 'API endpoints discovered',
    example: [],
  })
  apiEndpoints!: any[];

  @ApiProperty({
    description: 'Security analysis results',
    example: {},
  })
  securityAnalysis!: any;

  @ApiProperty({
    description: 'Testing information',
    example: {},
  })
  testingInfo!: any;

  @ApiProperty({
    description: 'Analysis metadata',
    example: {},
  })
  metadata!: any;

  @ApiPropertyOptional({
    description: 'Database schema information',
  })
  databaseInfo?: any;

  @ApiPropertyOptional({
    description: 'Deployment information',
  })
  deploymentInfo?: any;

  @ApiProperty({
    description: 'Analysis statistics',
    example: {
      totalComponents: 156,
      totalConnections: 342,
      averageComplexity: 7.2,
      riskAreas: 5,
      orphanedCount: 12,
    },
  })
  statistics!: {
    totalComponents: number;
    totalConnections: number;
    averageComplexity: number;
    riskAreas: number;
    orphanedCount: number;
    cyclomaticComplexity: number;
    technicalDebt: number;
  };
}

export class AnalysisResultDto {
  @ApiProperty({
    description: 'Whether the analysis was successful',
    example: true,
  })
  success!: boolean;

  @ApiProperty({
    description: 'Analysis run information',
    type: AnalysisRunResponseDto,
  })
  analysisRun!: AnalysisRunResponseDto;

  @ApiPropertyOptional({
    description: 'Architecture blueprint (only available when analysis is completed)',
    type: ArchitectureBlueprintDto,
  })
  blueprint?: ArchitectureBlueprintDto;

  @ApiPropertyOptional({
    description: 'Spatial visualization data',
  })
  spatialVisualization?: any;

  @ApiPropertyOptional({
    description: 'Path to the generated manifest file',
    example: '/manifests/analysis-123.json',
  })
  manifestPath?: string;

  @ApiPropertyOptional({
    description: 'List of analyzers that were used',
    example: [
      { name: 'TypeScriptAnalyzer', type: 'language', status: 'fulfilled' },
      { name: 'NestJSAnalyzer', type: 'framework', status: 'fulfilled' },
    ],
  })
  analyzersUsed?: Array<{
    name: string;
    type: string;
    status: string;
  }>;

  @ApiPropertyOptional({
    description: 'Additional metadata from the analysis',
  })
  metadata?: any;

  @ApiPropertyOptional({
    description: 'Error message if analysis failed',
    example: 'Repository path not accessible',
  })
  error?: string;

  @ApiProperty({
    description: 'Total processing time in milliseconds',
    example: 125000,
  })
  processingTime!: number;
}