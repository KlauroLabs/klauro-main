import { IsString, IsOptional, IsEnum, IsObject, IsNotEmpty, Length, IsUrl, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { RepositoryProvider } from '../../database/entities/codebase.entity';

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
    description: 'Repository URL',
    example: 'https://github.com/user/repo.git',
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