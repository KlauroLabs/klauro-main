import { IsString, IsOptional, IsEnum, IsBoolean, IsObject, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnalysisType } from '../../database/entities/analysis-run.entity';

export class StartAnalysisDto {
  @ApiPropertyOptional({
    description: 'Type of analysis to perform',
    enum: AnalysisType,
    example: AnalysisType.MANUAL,
  })
  @IsOptional()
  @IsEnum(AnalysisType)
  type?: AnalysisType = AnalysisType.MANUAL;

  @ApiPropertyOptional({
    description: 'Specific branch to analyze (overrides project default)',
    example: 'feature/new-feature',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  branch?: string;

  @ApiPropertyOptional({
    description: 'Specific commit SHA to analyze',
    example: 'a1b2c3d4e5f6789012345678901234567890abcd',
    maxLength: 40,
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  commitSha?: string;

  @ApiPropertyOptional({
    description: 'Path to repository (for local analysis)',
    example: '/path/to/local/repo',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  repositoryPath?: string;

  @ApiPropertyOptional({
    description: 'Analysis configuration options',
    example: {
      includeTests: true,
      maxDepth: 10,
      excludePatterns: ['node_modules/**', '*.test.js'],
      generateManifest: true,
      enableTelemetry: true,
      generateSpatialVisualization: true,
      analysisTimeout: 300000,
    },
  })
  @IsOptional()
  @IsObject()
  configuration?: {
    includeTests?: boolean;
    maxDepth?: number;
    excludePatterns?: string[];
    generateManifest?: boolean;
    enableTelemetry?: boolean;
    generateSpatialVisualization?: boolean;
    analysisTimeout?: number;
    useSpecificAnalyzer?: string;
    enableRealTimeUpdates?: boolean;
    optimizationLevel?: 'low' | 'medium' | 'high';
  };

  @ApiPropertyOptional({
    description: 'Whether to force re-analysis even if recent analysis exists',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean = false;

  @ApiPropertyOptional({
    description: 'Additional metadata for the analysis run',
    example: {
      triggeredBy: 'ci/cd',
      buildNumber: '123',
      environment: 'staging',
    },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}