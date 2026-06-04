import { IsString, IsOptional, IsEnum, IsObject, Length, IsUrl, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { RepositoryProvider } from '../../database/entities/codebase.entity';

export class UpdateCodebaseDto {
  @ApiPropertyOptional({
    description: 'Codebase name',
    example: 'My Updated Application',
    minLength: 1,
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  @Transform(({ value }) => value?.trim())
  name?: string;

  @ApiPropertyOptional({
    description: 'Codebase description',
    example: 'An updated description of the web application',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  @Transform(({ value }) => value?.trim())
  description?: string;

  @ApiPropertyOptional({
    description: 'Repository URL',
    example: 'https://github.com/user/updated-repo.git',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @IsUrl()
  @Length(0, 500)
  repositoryUrl?: string;

  @ApiPropertyOptional({
    description: 'Repository provider',
    enum: RepositoryProvider,
    example: RepositoryProvider.GITLAB,
  })
  @IsOptional()
  @IsEnum(RepositoryProvider)
  repositoryProvider?: RepositoryProvider;

  @ApiPropertyOptional({
    description: 'Repository ID from the provider',
    example: '987654321',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @Length(0, 100)
  @Transform(({ value }) => value?.trim())
  repositoryId?: string;

  @ApiPropertyOptional({
    description: 'Default branch name',
    example: 'develop',
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
    example: 'JavaScript',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @Length(0, 50)
  @Transform(({ value }) => value?.trim())
  language?: string;

  @ApiPropertyOptional({
    description: 'Primary framework',
    example: 'Vue.js',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @Length(0, 50)
  @Transform(({ value }) => value?.trim())
  framework?: string;

  @ApiPropertyOptional({
    description: 'Codebase settings (JSON object)',
    example: { autoAnalyze: false, notifyOnChanges: true },
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;
}