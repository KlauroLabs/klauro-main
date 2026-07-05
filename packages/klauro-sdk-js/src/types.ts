/**
 * Canonical Klauro CAS runtime event.
 *
 * This shape is kept EXACTLY compatible with the CAS runtime event contract
 * (`get_runtime_event_contract`). Every field name here is a field the ingest
 * endpoint understands and correlates on. Do not rename fields — the backend
 * correlates runtime signal back to static structure by these identifiers.
 */
export type CasRuntimeEventType = 'request' | 'error' | 'exit' | 'log' | 'custom';

export interface CasRuntimeEvent {
  /** Event category. Required. */
  type: CasRuntimeEventType;
  /** ISO-8601 timestamp. Filled in automatically if omitted. */
  timestamp?: string;
  /** Runtime event contract version. */
  schema_version?: string;
  /** Service / process emitting the event. */
  service_name?: string;
  /** Deployment environment (production, staging, ...). */
  environment?: string;
  /** CAS runtime_static_links.runtime_signal — e.g. "registerTool analyze_codebase". */
  signal?: string;
  /** CAS static object id for direct correlation. */
  static_id?: string;
  /** CAS node id. */
  node_id?: string;
  /** CAS entry point id. */
  entry_point_id?: string;
  /** CAS exit point id. */
  exit_point_id?: string;
  /** CAS call chain id. */
  call_chain_id?: string;
  /** Distributed trace id. */
  trace_id?: string;
  /** Span id. */
  span_id?: string;
  /** Parent span id. */
  parent_span_id?: string;
  /** HTTP or operation method. */
  method?: string;
  /** Normalized route pattern, e.g. /items/:id. */
  route?: string;
  /** Observed path or external target. */
  path?: string;
  /** HTTP status code. */
  status_code?: number;
  /** Elapsed duration in milliseconds. */
  duration_ms?: number;
  /** Error summary. */
  error_message?: string;
  /** Stack trace for source correlation. */
  stack?: string;
  /** Additional low-cardinality fields. */
  attributes?: Record<string, unknown>;
}

export interface KlauroConfig {
  /**
   * Klauro project id (the analysis / project this service maps to).
   * Required for the ingest URL. Also accepted as `projectId`.
   */
  projectId?: string;
  /** Telemetry API key. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Backend origin, e.g. https://mcp.klauro.com. Defaults to https://mcp.klauro.com. */
  endpoint?: string;
  /** Logical service name attached to every event. */
  service?: string;
  /** Alias for `service`, for parity with the CAS SDK contract. */
  serviceName?: string;
  /** Deployment environment attached to every event. */
  environment?: string;
  /** Flush when this many events are queued. Default 50. */
  batchSize?: number;
  /** Flush at least this often (ms). Default 5000. Set 0 to disable the timer. */
  flushInterval?: number;
  /** Max events retained in the queue before oldest are dropped. Default 10000. */
  maxQueueSize?: number;
  /** Injectable fetch (for tests / non-global-fetch runtimes). */
  fetchImpl?: typeof fetch;
  /** Called on delivery failure. Never throws into user code. */
  onError?: (err: unknown) => void;
  /** Emit internal diagnostics to console. Default false. */
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
  fetchImpl?: typeof fetch;
  onError: (err: unknown) => void;
  debug: boolean;
}

export const SCHEMA_VERSION = '1.0.0';
export const DEFAULT_ENDPOINT = 'https://mcp.klauro.com';
