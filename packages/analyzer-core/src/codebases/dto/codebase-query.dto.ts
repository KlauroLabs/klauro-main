import { IsOptional, IsInt, Min, Max, IsEnum, IsString, Length, IsArray } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { CodebaseStatus, RepositoryProvider } from '../../database/entities/codebase.entity';

export class CodebaseQueryDto {
  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    example: 1,
    minimum: 1,
    maximum: 1000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @ApiPropertyOptional({
    description: 'Items per page',
    example: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Sort field',
    example: 'name',
    enum: ['name', 'created_at', 'updated_at', 'last_analyzed_at'],
  })
  @IsOptional()
  @IsString()
  @IsEnum(['name', 'created_at', 'updated_at', 'last_analyzed_at'])
  sortBy?: string;

  @ApiPropertyOptional({
    description: 'Sort order',
    example: 'asc',
    enum: ['asc', 'desc'],
  })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @ApiPropertyOptional({
    description: 'Filter by codebase status',
    enum: CodebaseStatus,
    example: CodebaseStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(CodebaseStatus)
  status?: CodebaseStatus;

  @ApiPropertyOptional({
    description: 'Filter by repository provider',
    enum: RepositoryProvider,
    example: RepositoryProvider.GITHUB,
  })
  @IsOptional()
  @IsEnum(RepositoryProvider)
  repositoryProvider?: RepositoryProvider;

  @ApiPropertyOptional({
    description: 'Filter by programming language',
    example: 'TypeScript',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  @Transform(({ value }) => value?.trim())
  language?: string;

  @ApiPropertyOptional({
    description: 'Filter by framework',
    example: 'React',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  @Transform(({ value }) => value?.trim())
  framework?: string;

  @ApiPropertyOptional({
    description: 'Search term',
    example: 'webapp',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(({ value }) => value?.trim())
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by tags',
    example: ['frontend', 'typescript'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    }
    return value;
  })
  tags?: string[];
}