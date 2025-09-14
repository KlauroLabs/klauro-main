import { IsOptional, IsEnum, IsString, IsInt, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ProjectStatus, RepositoryProvider } from '../../database/entities/project.entity';

export class ProjectQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by project status',
    enum: ProjectStatus,
    example: ProjectStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional({
    description: 'Filter by repository provider',
    enum: RepositoryProvider,
    example: RepositoryProvider.GITHUB,
  })
  @IsOptional()
  @IsEnum(RepositoryProvider)
  repositoryProvider?: RepositoryProvider;

  @ApiPropertyOptional({
    description: 'Filter by primary language',
    example: 'TypeScript',
  })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({
    description: 'Filter by framework',
    example: 'NestJS',
  })
  @IsOptional()
  @IsString()
  framework?: string;

  @ApiPropertyOptional({
    description: 'Search query for project name or description',
    example: 'awesome',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    example: 1,
    minimum: 1,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    example: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Sort field',
    example: 'name',
    enum: ['name', 'createdAt', 'updatedAt', 'lastAnalyzedAt'],
  })
  @IsOptional()
  @IsString()
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'lastAnalyzedAt' = 'updatedAt';

  @ApiPropertyOptional({
    description: 'Sort direction',
    example: 'desc',
    enum: ['asc', 'desc'],
  })
  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}