export enum TelemetryEventType {
  REQUEST_FLOW = 'request_flow',
  PERFORMANCE_METRICS = 'performance_metrics',
  ACTIVE_CONNECTIONS = 'active_connections',
  ISSUES = 'issues',
  COMPONENT_STATUS = 'component_status',
  DATABASE_QUERY = 'database_query',
  MESSAGE_QUEUE = 'message_queue',
  CUSTOM = 'custom',
}

export type TelemetryPayloadType = 'metric' | 'trace' | 'event' | 'heartbeat';

export interface TelemetryPayload {
  type: TelemetryPayloadType;
  data: TelemetryStream | PerformanceMetrics | RequestFlow | Issue | any;
  componentId?: string;
  tags?: string[];
  attributes?: Record<string, any>;
}

export interface TelemetryMessage {
  version: '1.0';
  timestamp: number;
  projectId: string;
  type: TelemetryPayloadType;
  payload: TelemetryPayload;
  metadata?: {
    sdkVersion?: string;
    runtime?: string;
    hostname?: string;
    environment?: string;
  };
}

export interface CASRuntimeEvent {
  type: 'request' | 'error' | 'exit' | 'log' | 'custom';
  timestamp?: string;
  schema_version?: string;
  service_name?: string;
  environment?: string;
  signal?: string;
  static_id?: string;
  node_id?: string;
  entry_point_id?: string;
  exit_point_id?: string;
  call_chain_id?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  method?: string;
  route?: string;
  path?: string;
  status_code?: number;
  duration_ms?: number;
  error_message?: string;
  stack?: string;
  attributes?: Record<string, any>;
}

export enum FlowStatus {
  IN_PROGRESS = 'in-progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TIMEOUT = 'timeout',
  CANCELLED = 'cancelled',
}

export enum IssueType {
  ERROR = 'error',
  WARNING = 'warning',
  BOTTLENECK = 'bottleneck',
  DEGRADATION = 'degradation',
  OUTAGE = 'outage',
}

export enum ComponentStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  CRITICAL = 'critical',
  OFFLINE = 'offline',
}

export interface RequestFlow {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  projectId: string;
  componentId: string;
  path: string[];
  method: string;
  endpoint: string;
  timestamp: number;
  duration?: number;
  status: FlowStatus;
  metadata?: Record<string, any>;
  tags?: string[];
}

export interface PerformanceMetrics {
  componentId: string;
  projectId: string;
  timestamp: number;
  cpu: number;
  memory: number;
  heapUsed: number;
  heapTotal: number;
  requestsPerSecond: number;
  averageLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  errorRate: number;
  throughput: number;
  activeRequests: number;
  queuedRequests: number;
}

export interface ActiveConnection {
  from: string;
  to: string;
  count: number;
  bandwidth: number;
  protocol: string;
  latency: number;
  packetLoss: number;
  timestamp: number;
}

export interface Issue {
  id: string;
  componentId: string;
  projectId: string;
  type: IssueType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  details?: Record<string, any>;
  stackTrace?: string;
  count: number;
  firstOccurrence: number;
  lastOccurrence: number;
  timestamp: number;
  resolved: boolean;
  acknowledgedBy?: string;
}

export interface ComponentStatusUpdate {
  componentId: string;
  projectId: string;
  status: ComponentStatus;
  health: number;
  uptime: number;
  lastHeartbeat: number;
  metrics?: Partial<PerformanceMetrics>;
  dependencies?: {
    componentId: string;
    status: ComponentStatus;
    latency: number;
  }[];
}

export interface DatabaseQuery {
  id: string;
  componentId: string;
  projectId: string;
  query: string;
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';
  table: string;
  duration: number;
  rowsAffected: number;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface MessageQueueEvent {
  id: string;
  componentId: string;
  projectId: string;
  queue: string;
  topic?: string;
  messageType: string;
  action: 'publish' | 'consume' | 'ack' | 'nack' | 'requeue';
  timestamp: number;
  duration?: number;
  success: boolean;
  messageSize: number;
  attributes?: Record<string, any>;
}

export interface TelemetryStream {
  requestFlow?: RequestFlow;
  performanceMetrics?: PerformanceMetrics;
  activeConnections?: ActiveConnection[];
  issues?: Issue[];
  componentStatus?: ComponentStatusUpdate;
  databaseQuery?: DatabaseQuery;
  messageQueue?: MessageQueueEvent;
}

export interface TelemetryBatch {
  projectId: string;
  organizationId: string;
  timestamp: number;
  events: TelemetryEvent[];
  metadata?: {
    sdkVersion: string;
    runtime: string;
    hostname: string;
    environment: string;
  };
}

export interface TelemetryEvent {
  id: string;
  type: TelemetryEventType;
  timestamp: number;
  data: TelemetryStream;
}

export interface TelemetrySubscription {
  projectId: string;
  componentIds?: string[];
  eventTypes?: TelemetryEventType[];
  filters?: {
    minSeverity?: string;
    tags?: string[];
    statusFilter?: string[];
  };
}

export interface TelemetryAggregation {
  projectId: string;
  componentId: string;
  window: '1m' | '5m' | '15m' | '1h' | '24h';
  metrics: {
    requestCount: number;
    errorCount: number;
    avgLatency: number;
    avgCpu: number;
    avgMemory: number;
    availability: number;
  };
  timestamp: number;
}

export interface InstrumentationConfig {
  enabled: boolean;
  projectId: string;
  apiKey: string;
  endpoint: string;
  batchSize: number;
  flushInterval: number;
  maxRetries: number;
  samplingRate: number;
  enableAutoInstrumentation: boolean;
  enableRequestTracking: boolean;
  enableDatabaseTracking: boolean;
  enableQueueTracking: boolean;
  enableErrorTracking: boolean;
  excludeRoutes?: string[];
  excludeHeaders?: string[];
  redactKeys?: string[];
}
