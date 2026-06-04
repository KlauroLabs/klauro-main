import { IsString, IsOptional, IsEnum, IsObject, IsNotEmpty, Length, Matches, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { WorkspaceVisibility } from '../../database/entities/workspace.entity';

export class CreateWorkspaceDto {
  @ApiProperty({
    description: 'Workspace name',
    example: 'My Development Workspace',
    minLength: 1,
    maxLength: 100,
  })
  @IsNotEmpty()
  @IsString()
  @Length(1, 100)
  @Transform(({ value }) => value?.trim())
  name!: string;

  @ApiProperty({
    description: 'Workspace slug (must be unique, alphanumeric with hyphens)',
    example: 'my-dev-workspace',
    minLength: 3,
    maxLength: 50,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  })
  @IsNotEmpty()
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric characters with hyphens',
  })
  @Transform(({ value }) => value?.toLowerCase().trim())
  slug!: string;

  @ApiPropertyOptional({
    description: 'Workspace description',
    example: 'A workspace for development projects',
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
    default: WorkspaceVisibility.PRIVATE,
  })
  @IsOptional()
  @IsEnum(WorkspaceVisibility)
  visibility?: WorkspaceVisibility;

  @ApiPropertyOptional({
    description: 'Workspace settings (JSON object)',
    example: { theme: 'dark', notifications: true },
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;
}