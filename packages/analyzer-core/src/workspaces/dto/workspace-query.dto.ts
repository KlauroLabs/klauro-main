import { IsOptional, IsInt, Min, Max, IsEnum, IsString, IsBoolean, Length } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { WorkspaceVisibility } from '../../database/entities/workspace.entity';

export class WorkspaceQueryDto {
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
    enum: ['name', 'slug', 'created_at', 'updated_at'],
  })
  @IsOptional()
  @IsString()
  @IsEnum(['name', 'slug', 'created_at', 'updated_at'])
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
    description: 'Filter by workspace visibility',
    enum: WorkspaceVisibility,
  })
  @IsOptional()
  @IsEnum(WorkspaceVisibility)
  visibility?: WorkspaceVisibility;

  @ApiPropertyOptional({
    description: 'Search term',
    example: 'development',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(({ value }) => value?.trim())
  search?: string;

  @ApiPropertyOptional({
    description: 'Show only owned workspaces',
    example: true,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  owned?: boolean;

  @ApiPropertyOptional({
    description: 'Show only accessed workspaces',
    example: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  accessed?: boolean;
}