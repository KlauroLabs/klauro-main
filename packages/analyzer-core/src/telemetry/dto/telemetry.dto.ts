import { IsString, IsNumber, IsEnum, IsOptional, IsArray, ValidateNested, IsBoolean, IsUUID, Min, Max, IsObject, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TelemetryEventType, FlowStatus, IssueType, ComponentStatus } from '../types/telemetry.types';

export class RequestFlowDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiProperty()
  @IsString()
  traceId!: string;

  @ApiProperty()
  @IsString()
  spanId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentSpanId?: string;

  @ApiProperty()
  @IsUUID()
  projectId!: string;

  @ApiProperty()
  @IsString()
  componentId!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  path!: string[];

  @ApiProperty()
  @IsString()
  method!: string;

  @ApiProperty()
  @IsString()
  endpoint!: string;

  @ApiProperty()
  @IsNumber()
  timestamp!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  duration?: number;

  @ApiProperty({ enum: FlowStatus })
  @IsEnum(FlowStatus)
  status!: FlowStatus;

  @ApiPropertyOptional()
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class PerformanceMetricsDto {
  @ApiProperty()
  @IsString()
  componentId!: string;

  @ApiProperty()
  @IsUUID()
  projectId!: string;

  @ApiProperty()
  @IsNumber()
  timestamp!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(100)
  cpu!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  memory!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  heapUsed!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  heapTotal!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  requestsPerSecond!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  averageLatency!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  p50Latency!: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  p95Latency: number = 0;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  p99Latency: number = 0;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(100)
  errorRate: number = 0;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  throughput: number = 0;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  activeRequests: number = 0;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  queuedRequests: number = 0;
}

export class ActiveConnectionDto {
  @ApiProperty()
  @IsString()
  from!: string;

  @ApiProperty()
  @IsString()
  to!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  count: number = 0;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  bandwidth: number = 0;

  @ApiProperty()
  @IsString()
  protocol!: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  latency: number = 0;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(100)
  packetLoss: number = 0;

  @ApiProperty()
  @IsNumber()
  timestamp!: number;
}

export class IssueDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiProperty()
  @IsString()
  componentId!: string;

  @ApiProperty()
  @IsUUID()
  projectId!: string;

  @ApiProperty({ enum: IssueType })
  @IsEnum(IssueType)
  type!: IssueType;

  @ApiProperty({ enum: ['low', 'medium', 'high', 'critical'] })
  @IsEnum(['low', 'medium', 'high', 'critical'])
  severity: 'low' | 'medium' | 'high' | 'critical' = 'low';

  @ApiProperty()
  @IsString()
  message!: string;

  @ApiPropertyOptional()
  @IsOptional()
  details?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  stackTrace?: string;

  @ApiProperty()
  @IsNumber()
  @Min(1)
  count: number = 1;

  @ApiProperty()
  @IsNumber()
  firstOccurrence!: number;

  @ApiProperty()
  @IsNumber()
  lastOccurrence!: number;

  @ApiProperty()
  @IsNumber()
  timestamp!: number;

  @ApiProperty()
  @IsBoolean()
  resolved!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  acknowledgedBy?: string;
}

export class ComponentStatusUpdateDto {
  @ApiProperty()
  @IsString()
  componentId!: string;

  @ApiProperty()
  @IsUUID()
  projectId!: string;

  @ApiProperty({ enum: ComponentStatus })
  @IsEnum(ComponentStatus)
  status!: ComponentStatus;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(100)
  health: number = 100;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  uptime: number = 0;

  @ApiProperty()
  @IsNumber()
  lastHeartbeat!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => PerformanceMetricsDto)
  metrics?: Partial<PerformanceMetricsDto>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  dependencies?: {
    componentId: string;
    status: ComponentStatus;
    latency: number;
  }[];
}

export class TelemetryEventDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiProperty({ enum: TelemetryEventType })
  @IsEnum(TelemetryEventType)
  type!: TelemetryEventType;

  @ApiProperty()
  @IsNumber()
  timestamp!: number;

  @ApiProperty()
  data: {
    requestFlow?: RequestFlowDto;
    performanceMetrics?: PerformanceMetricsDto;
    activeConnections?: ActiveConnectionDto[];
    issues?: IssueDto[];
    componentStatus?: ComponentStatusUpdateDto;
  } = {};
}

export class TelemetryBatchDto {
  @ApiProperty()
  @IsUUID()
  projectId!: string;

  @ApiProperty()
  @IsUUID()
  organizationId!: string;

  @ApiProperty()
  @IsNumber()
  timestamp!: number;

  @ApiProperty({ type: [TelemetryEventDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TelemetryEventDto)
  events: TelemetryEventDto[] = [];

  @ApiPropertyOptional()
  @IsOptional()
  metadata?: {
    sdkVersion: string;
    runtime: string;
    hostname: string;
    environment: string;
  };
}

export class TelemetrySubscriptionDto {
  @ApiProperty()
  @IsUUID()
  projectId!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  componentIds?: string[];

  @ApiPropertyOptional({ enum: TelemetryEventType, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(TelemetryEventType, { each: true })
  eventTypes?: TelemetryEventType[];

  @ApiPropertyOptional()
  @IsOptional()
  filters?: {
    minSeverity?: string;
    tags?: string[];
    statusFilter?: string[];
  };
}

export class CASRuntimeEventDto {
  @ApiProperty({ enum: ['request', 'error', 'exit', 'log', 'custom'] })
  @IsIn(['request', 'error', 'exit', 'log', 'custom'])
  type!: 'request' | 'error' | 'exit' | 'log' | 'custom';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timestamp?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  schema_version?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  service_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  environment?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  signal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  static_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  node_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entry_point_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  exit_point_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  call_chain_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  trace_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  span_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parent_span_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  route?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  path?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  status_code?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  duration_ms?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  error_message?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  stack?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  attributes?: Record<string, any>;
}
