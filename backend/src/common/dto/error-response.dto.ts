import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({
    description: 'HTTP status code',
    example: 400,
  })
  statusCode!: number;

  @ApiProperty({
    description: 'Error code for programmatic handling',
    example: 'VALIDATION_FAILED',
  })
  code!: string;

  @ApiProperty({
    description: 'Human-readable error message',
    example: 'Invalid input data provided',
  })
  message!: string;

  @ApiProperty({
    description: 'Detailed error information',
    example: ['name must be at least 1 character long', 'slug must match pattern'],
    type: [String],
    required: false,
  })
  details?: string[];

  @ApiProperty({
    description: 'Request correlation ID for debugging',
    example: 'req_1234567890abcdef',
    required: false,
  })
  correlationId?: string;

  @ApiProperty({
    description: 'Timestamp when error occurred',
    example: '2024-01-15T10:30:00.000Z',
  })
  timestamp!: string;

  @ApiProperty({
    description: 'Request path that caused the error',
    example: '/api/workspaces',
  })
  path!: string;
}