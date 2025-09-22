import { IsString, IsOptional, IsEnum, IsObject, Length, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { WorkspaceVisibility } from '../../database/entities/workspace.entity';

export class UpdateWorkspaceDto {
  @ApiPropertyOptional({
    description: 'Workspace name',
    example: 'My Updated Workspace',
    minLength: 1,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(({ value }) => value?.trim())
  name?: string;

  @ApiPropertyOptional({
    description: 'Workspace slug (must be unique, alphanumeric with hyphens)',
    example: 'my-updated-workspace',
    minLength: 3,
    maxLength: 50,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  })
  @IsOptional()
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric characters with hyphens',
  })
  @Transform(({ value }) => value?.toLowerCase().trim())
  slug?: string;

  @ApiPropertyOptional({
    description: 'Workspace description',
    example: 'An updated workspace description',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  @Transform(({ value }) => value?.trim())
  description?: string;

  @ApiPropertyOptional({
    description: 'Workspace visibility',
    enum: WorkspaceVisibility,
  })
  @IsOptional()
  @IsEnum(WorkspaceVisibility)
  visibility?: WorkspaceVisibility;

  @ApiPropertyOptional({
    description: 'Workspace settings (JSON object)',
    example: { theme: 'light', notifications: false },
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;
}