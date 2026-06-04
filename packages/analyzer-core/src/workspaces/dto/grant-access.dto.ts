import { IsString, IsEnum, IsOptional, IsDateString, Length, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { WorkspaceRole } from '../../database/entities/workspace-access.entity';

export class GrantAccessDto {
  @ApiProperty({
    description: 'User ID to grant access to',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsString()
  @IsUUID()
  userId!: string;

  @ApiProperty({
    description: 'Role to grant',
    enum: WorkspaceRole,
    example: WorkspaceRole.EDITOR,
  })
  @IsEnum(WorkspaceRole)
  role!: WorkspaceRole;

  @ApiPropertyOptional({
    description: 'Access expiration date (ISO 8601)',
    example: '2024-12-31T23:59:59.000Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: Date;

  @ApiPropertyOptional({
    description: 'Optional notes about the access grant',
    example: 'Temporary access for project collaboration',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  @Transform(({ value }) => value?.trim())
  notes?: string;
}