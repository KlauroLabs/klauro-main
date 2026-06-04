/**
 * Klauro Database Layer
 * Main exports for database access, repositories, and types
 * Aligned with analyzer architecture and telemetry system
 */

// Database client and configuration
export {
  DatabaseClient,
  DatabaseClientFactory,
  createDatabaseConfig,
  createDatabaseConfigFromUrl,
  type DatabaseConfig,
  type TransactionCallback,
  type HealthCheckResult
} from './database-client';

// Analyzer repository and types
export {
  AnalyzerRepository,
  type AnalysisRunCreateData,
  type ComponentCreateData,
  type CallGraphNodeCreateData,
  type CallGraphEdgeCreateData,
  type AnalysisManifest
} from './repositories/analyzer-repository';

// Telemetry repository and types
export {
  TelemetryRepository,
  type TelemetryEventCreateData,
  type TelemetryTraceCreateData,
  type InstrumentationPointCreateData,
  type TelemetryQueryFilters,
  type ComponentHealthMetrics,
  type SystemHealthSnapshot,
  type BottleneckData
} from './repositories/telemetry-repository';

// Re-export core types from backend
export type {
  // Analyzer types
  ArchitectureBlueprint,
  ComponentNode,
  Connection,
  EntryPoint,
  ExitPoint,
  RiskArea,
  CallGraph,
  CallGraphNode,
  CallGraphEdge,
  HotPath,
  FunctionInfo,
  DatabaseConnection,
  OptimizationSuggestion,
  ProjectMetadata,
  TechnologyStack,
  DependencyAnalysis,
  TestCoverage,
  SecurityVulnerability,
  APIEndpoint,
  ComponentType,
  ConnectionType,
  EntryPointType,
  ExitPointType,
  ArchitecturalLayer,
  HTTPMethod
} from '../../packages/analyzer-core/src/types';

// Re-export telemetry types
export type {
  TelemetryEvent,
  TelemetryEventType,
  TelemetrySource,
  TelemetryMetadata,
  PerformanceTiming,
  ExecutionContext,
  InstrumentationPoint,
  InstrumentationType,
  TelemetryManifest,
  TelemetrySpan,
  TelemetryMetrics,
  AnalyzerTelemetry,
  ErrorTelemetry,
  PerformanceProfile,
  DataFlowTelemetry,
  HotPathTelemetry,
  BottleneckTelemetry,
  OptimizationSuggestion as TelemetryOptimizationSuggestion
} from '../../packages/analyzer-core/src/telemetry/telemetry-schema';

// Common database patterns and utilities
export const DatabasePatterns = {
  /**
   * Common query patterns for analyzer data
   */
  analyzer: {
    getLatestAnalysis: (projectId: string) => 
      `SELECT id FROM analysis_runs WHERE project_id = $1 AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`,
    
    getComponentsWithHealth: (analysisRunId: string) =>
      `SELECT c.*, ch.health_score FROM components c 
       LEFT JOIN component_health_metrics ch ON c.component_id = ch.component_id 
       WHERE c.analysis_run_id = $1 ORDER BY ch.health_score ASC`,
    
    getHighRiskComponents: (analysisRunId: string) =>
      `SELECT c.* FROM components c 
       WHERE c.analysis_run_id = $1 AND c.complexity > 7 
       ORDER BY c.complexity DESC, c.test_coverage ASC`
  },

  /**
   * Common query patterns for telemetry data
   */
  telemetry: {
    getRecentEvents: (projectId: string, hours: number = 1) =>
      `SELECT * FROM telemetry_events 
       WHERE project_id = $1 AND timestamp >= NOW() - INTERVAL '${hours} hours' 
       ORDER BY timestamp DESC`,
    
    getComponentHealth: (projectId: string, componentId: string) =>
      `SELECT calculate_component_health($1, $2, INTERVAL '1 hour') as health_score`,
    
    getActiveBottlenecks: (projectId: string) =>
      `SELECT * FROM bottlenecks 
       WHERE project_id = $1 AND resolved_at IS NULL 
       ORDER BY severity DESC, impact_score DESC`
  },

  /**
   * Performance monitoring queries
   */
  performance: {
    getSlowestComponents: (projectId: string, limit: number = 10) =>
      `SELECT component_id, AVG(duration_ms) as avg_response_time, COUNT(*) as request_count
       FROM telemetry_events 
       WHERE project_id = $1 AND timestamp >= NOW() - INTERVAL '1 hour' AND duration_ms IS NOT NULL
       GROUP BY component_id 
       ORDER BY avg_response_time DESC 
       LIMIT ${limit}`,
    
    getErrorRateByComponent: (projectId: string) =>
      `SELECT 
         component_id,
         COUNT(*) as total_requests,
         COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
         (COUNT(CASE WHEN status = 'error' THEN 1 END)::NUMERIC / COUNT(*)::NUMERIC) * 100 as error_rate
       FROM telemetry_events 
       WHERE project_id = $1 AND timestamp >= NOW() - INTERVAL '1 hour'
       GROUP BY component_id 
       HAVING COUNT(*) >= 10
       ORDER BY error_rate DESC`,
    
    getSystemLoad: (projectId: string) =>
      `SELECT 
         COUNT(*) as total_requests,
         COUNT(DISTINCT component_id) as active_components,
         AVG(duration_ms) as avg_response_time,
         COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count
       FROM telemetry_events 
       WHERE project_id = $1 AND timestamp >= NOW() - INTERVAL '1 hour'`
  }
};

/**
 * Database utility functions
 */
export const DatabaseUtils = {
  /**
   * Generate a hash for duplicate detection
   */
  async generateHash(data: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(data).digest('hex');
  },

  /**
   * Convert JavaScript object to PostgreSQL JSON
   */
  toJsonb(obj: any): string {
    return JSON.stringify(obj);
  },

  /**
   * Parse PostgreSQL JSONB to JavaScript object
   */
  fromJsonb<T>(jsonb: any): T {
    return typeof jsonb === 'string' ? JSON.parse(jsonb) : jsonb;
  },

  /**
   * Create a parameterized query with numbered placeholders
   */
  createParameterizedQuery(
    baseQuery: string, 
    conditions: Record<string, any>
  ): { query: string; params: any[] } {
    const conditionClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    Object.entries(conditions).forEach(([field, value]) => {
      if (value !== undefined && value !== null) {
        conditionClauses.push(`${field} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    });

    const whereClause = conditionClauses.length > 0 
      ? `WHERE ${conditionClauses.join(' AND ')}`
      : '';

    return {
      query: `${baseQuery} ${whereClause}`,
      params
    };
  },

  /**
   * Batch insert helper
   */
  createBatchInsertQuery(
    tableName: string,
    columns: string[],
    rows: any[][]
  ): { query: string; params: any[] } {
    const params: any[] = [];
    const valueClauses: string[] = [];
    let paramIndex = 1;

    rows.forEach(row => {
      const rowPlaceholders = row.map(() => `$${paramIndex++}`).join(', ');
      valueClauses.push(`(${rowPlaceholders})`);
      params.push(...row);
    });

    const query = `
      INSERT INTO ${tableName} (${columns.join(', ')})
      VALUES ${valueClauses.join(', ')}
    `;

    return { query, params };
  }
};

/**
 * Common database error types
 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    public code?: string,
    public table?: string,
    public constraint?: string
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class ValidationError extends DatabaseError {
  constructor(message: string, public field?: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends DatabaseError {
  constructor(resource: string, id?: string) {
    super(`${resource}${id ? ` with id ${id}` : ''} not found`, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DatabaseError {
  constructor(message: string, constraint?: string) {
    super(message, 'CONFLICT', undefined, constraint);
    this.name = 'ConflictError';
  }
}

/**
 * Database migration status
 */
export interface MigrationStatus {
  version: string;
  name: string;
  appliedAt: Date;
  status: 'applied' | 'pending' | 'failed';
}

/**
 * Common constants
 */
export const DatabaseConstants = {
  // Table names
  TABLES: {
    ANALYSIS_RUNS: 'analysis_runs',
    COMPONENTS: 'components',
    CONNECTIONS: 'connections',
    ENTRY_POINTS: 'entry_points',
    EXIT_POINTS: 'exit_points',
    CALL_GRAPH_NODES: 'call_graph_nodes',
    CALL_GRAPH_EDGES: 'call_graph_edges',
    TELEMETRY_EVENTS: 'telemetry_events',
    TELEMETRY_TRACES: 'telemetry_traces',
    INSTRUMENTATION_POINTS: 'instrumentation_points',
    PERFORMANCE_METRICS: 'performance_metrics',
    BOTTLENECKS: 'bottlenecks',
    ERROR_TRACKING: 'error_tracking'
  },

  // View names
  VIEWS: {
    COMPONENT_PERFORMANCE: 'v_component_performance_realtime',
    PROJECT_HEALTH: 'v_project_health_dashboard',
    CALL_GRAPH_ANALYSIS: 'v_call_graph_analysis',
    HOT_FUNCTIONS: 'v_hot_functions',
    OPTIMIZATION_OPPORTUNITIES: 'v_optimization_opportunities',
    SYSTEM_HEALTH: 'v_system_health_comprehensive'
  },

  // Function names
  FUNCTIONS: {
    CALCULATE_COMPONENT_HEALTH: 'calculate_component_health',
    UPDATE_INSTRUMENTATION_METRICS: 'update_instrumentation_metrics',
    GENERATE_TELEMETRY_MANIFEST: 'generate_telemetry_manifest',
    CLEANUP_TELEMETRY_DATA: 'cleanup_telemetry_data'
  },

  // Default time windows
  TIME_WINDOWS: {
    REALTIME: '1 minute',
    SHORT_TERM: '1 hour',
    MEDIUM_TERM: '24 hours',
    LONG_TERM: '7 days'
  }
} as const;