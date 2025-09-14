import { IsString, IsOptional, IsEnum, IsUrl, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RepositoryProvider } from '../../database/entities/project.entity';

export class CreateProjectDto {
  @ApiProperty({
    description: 'Project name',
    example: 'My Awesome Project',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    description: 'Project description',
    example: 'A revolutionary web application that will change the world',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Repository URL (GitHub, GitLab, etc.)',
    example: 'https://github.com/user/awesome-project',
  })
  @IsOptional()
  @IsUrl()
  repositoryUrl?: string;

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
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  repositoryId?: string;

  @ApiPropertyOptional({
    description: 'Default branch to analyze',
    example: 'main',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  defaultBranch?: string;

  @ApiPropertyOptional({
    description: 'Primary programming language',
    example: 'TypeScript',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  language?: string;

  @ApiPropertyOptional({
    description: 'Primary framework',
    example: 'NestJS',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  framework?: string;

  @ApiPropertyOptional({
    description: 'Project settings and configuration',
    example: {
      enableAutoAnalysis: true,
      analysisFrequency: 'daily',
      notificationPreferences: {
        email: true,
        slack: false,
      },
    },
  })
  @IsOptional()
  settings?: Record<string, any>;
}