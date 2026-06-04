import { IsString, IsOptional, IsEnum, IsObject, IsNotEmpty, Length, IsUrl, Matches, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { RepositoryProvider } from '../../database/entities/codebase.entity';

export enum CodebaseSourceType {
  REPOSITORY_URL = 'repository_url',
  LOCAL_PATH = 'local_path',
  UPLOAD = 'upload',
}

export class CreateCodebaseDto {
  @ApiProperty({
    description: 'Codebase name',
    example: 'My Application',
    minLength: 1,
    maxLength: 255,
  })
  @IsNotEmpty()
  @IsString()
  @Length(1, 255)
  @Transform(({ value }) => value?.trim())
  name!: string;

  @ApiPropertyOptional({
    description: 'Codebase description',
    example: 'A web application built with React and Node.js',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  @Transform(({ value }) => value?.trim())
  description?: string;

  @ApiPropertyOptional({
    description: 'Source type for the codebase',
    enum: CodebaseSourceType,
    example: CodebaseSourceType.REPOSITORY_URL,
    default: CodebaseSourceType.REPOSITORY_URL,
  })
  @IsOptional()
  @IsEnum(CodebaseSourceType)
  sourceType?: CodebaseSourceType;

  @ApiPropertyOptional({
    description: 'Repository URL (required if sourceType is repository_url)',
    example: 'https://github.com/user/repo.git',
    maxLength: 500,
  })
  @ValidateIf(o => o.sourceType === CodebaseSourceType.REPOSITORY_URL || (!o.sourceType && !o.localPath))
  @IsString()
  @IsUrl()
  @Length(0, 500)
  repositoryUrl?: string;

  @ApiPropertyOptional({
    description: 'Local filesystem path (required if sourceType is local_path, for testing only)',
    example: '/Users/username/projects/my-app',
    maxLength: 500,
  })
  @ValidateIf(o => o.sourceType === CodebaseSourceType.LOCAL_PATH)
  @IsString()
  @Length(0, 500)
  @Transform(({ value }) => value?.trim())
  localPath?: string;

  @ApiPropertyOptional({
    description: 'Repository provider',
    enum: RepositoryProvider,
    example: RepositoryProvider.GITHUB,
  })
  @IsOptional()
  @IsEnum(RepositoryProvider)
  repositoryProvider?: RepositoryProvider;

  @ApiPropertyOptional({
    description: 'Repository ID from the provider',
    example: '123456789',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Length(0, 100)
  @Transform(({ value }) => value?.trim())
  repositoryId?: string;

  @ApiPropertyOptional({
    description: 'Default branch name',
    example: 'main',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Length(0, 100)
  @Matches(/^[a-zA-Z0-9/_.-]+$/, {
    message: 'Branch name contains invalid characters',
  })
  @Transform(({ value }) => value?.trim())
  defaultBranch?: string;

  @ApiPropertyOptional({
    description: 'Primary programming language',
    example: 'TypeScript',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @Length(0, 50)
  @Transform(({ value }) => value?.trim())
  language?: string;

  @ApiPropertyOptional({
    description: 'Primary framework',
    example: 'React',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @Length(0, 50)
  @Transform(({ value }) => value?.trim())
  framework?: string;

  @ApiPropertyOptional({
    description: 'Codebase settings (JSON object)',
    example: { autoAnalyze: true, notifyOnChanges: false },
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;
}