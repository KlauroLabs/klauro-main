

export type CasRuntimeEventType = 'request' | 'error' | 'exit' | 'log' | 'custom';

export interface CasRuntimeEvent {

  event_id?: string;

  type: CasRuntimeEventType;

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

  attributes?: Record<string, unknown>;
}

export interface KlauroConfig {

  projectId?: string;

  apiKey?: string;

  endpoint?: string;

  service?: string;

  serviceName?: string;

  environment?: string;

  batchSize?: number;

  flushInterval?: number;

  maxQueueSize?: number;

  retryAttempts?: number;

  retryBaseDelay?: number;

  fetchImpl?: typeof fetch;

  onError?: (err: unknown) => void;

  debug?: boolean;
}

export interface ResolvedConfig {
  projectId: string;
  apiKey?: string;
  endpoint: string;
  service?: string;
  environment?: string;
  batchSize: number;
  flushInterval: number;
  maxQueueSize: number;
  retryAttempts: number;
  retryBaseDelay: number;
  fetchImpl?: typeof fetch;
  onError: (err: unknown) => void;
  debug: boolean;
}

export const SCHEMA_VERSION = '1.0.0';
export const DEFAULT_ENDPOINT = 'https://mcp.klauro.com';
