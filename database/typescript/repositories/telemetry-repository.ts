/**
 * Telemetry Repository
 * Database access layer for telemetry data collection and analysis
 * Perfectly aligned with TelemetryCollector and telemetry schema architecture
 */

import { Pool, PoolClient } from 'pg';
import {
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
  TelemetryMetrics
} from '../../../backend/src/telemetry/telemetry-schema';

export interface TelemetryEventCreateData {
  projectId: string;
  componentId?: string;
  eventType: TelemetryEventType;
  eventName: string;
  timestamp?: Date;
  durationMs?: number;
  status?: string;
  errorMessage?: string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  tags?: Record<string, string>;
  metrics?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface TelemetryTraceCreateData {
  projectId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
  status: 'ok' | 'error' | 'timeout';
  componentId?: string;
  tags?: Record<string, string>;
  logs?: any[];
}

export interface InstrumentationPointCreateData {
  projectId: string;
  componentId?: string;
  pointId: string;
  pointType: InstrumentationType;
  locationFile: string;
  locationFunction?: string;
  locationLine: number;
  locationColumn?: number;
  astNodeId?: string;
  samplingRate?: number;
  samplingType?: 'always' | 'random' | 'adaptive' | 'conditional';
  conditions?: any[];
  dataCaptureConfig?: Record<string, any>;
  performanceConfig?: Record<string, any>;
}

export interface TelemetryQueryFilters {
  projectId?: string;
  componentId?: string;
  eventType?: TelemetryEventType;
  timeFrom?: Date;
  timeTo?: Date;
  status?: string;
  traceId?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export interface ComponentHealthMetrics {
  componentId: string;
  timestamp: Date;
  requestsPerMinute: number;
  averageResponseTimeMs: number;
  errorRatePercent: number;
  memoryUsageMb?: number;
  cpuUsagePercent?: number;
  healthScore: number;
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  alertsActive: number;
}

export interface SystemHealthSnapshot {
  projectId: string;
  timestamp: Date;
  totalComponents: number;
  healthyComponents: number;
  warningComponents: number;
  criticalComponents: number;
  averageHealthScore: number;
  totalRequestsPerMinute: number;
  systemErrorRatePercent: number;
  systemResponseTimeP95Ms: number;
  activeBottlenecks: number;
  optimizationOpportunities: number;
  metricsSnapshot: Record<string, any>;
}

export interface BottleneckData {
  projectId: string;
  componentId?: string;
  bottleneckType: 'cpu' | 'memory' | 'io' | 'network' | 'database' | 'synchronization';
  location: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  impactScore: number;
  frequencyCount: number;
  averageDelayMs: number;
  recommendations: string[];
  metrics: Record<string, any>;
}

export class TelemetryRepository {
  constructor(private pool: Pool) {}

  // =============================================================================
  // TELEMETRY EVENT MANAGEMENT
  // =============================================================================

  async insertTelemetryEvent(event: TelemetryEventCreateData): Promise<void> {
    const query = `
      INSERT INTO telemetry_events (
        project_id, component_id, event_type, event_name, timestamp,
        duration_ms, status, error_message, user_id, session_id,
        request_id, trace_id, span_id, parent_span_id, tags, metrics, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `;

    await this.pool.query(query, [
      event.projectId,
      event.componentId,
      event.eventType,
      event.eventName,
      event.timestamp || new Date(),
      event.durationMs,
      event.status,
      event.errorMessage,
      event.userId,
      event.sessionId,
      event.requestId,
      event.traceId,
      event.spanId,
      event.parentSpanId,
      JSON.stringify(event.tags || {}),
      JSON.stringify(event.metrics || {}),
      JSON.stringify(event.metadata || {})
    ]);
  }

  async insertTelemetryEventsBatch(events: TelemetryEventCreateData[]): Promise<void> {
    if (events.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Use COPY for high-performance batch inserts
      const copyQuery = `
        COPY telemetry_events (
          project_id, component_id, event_type, event_name, timestamp,
          duration_ms, status, error_message, user_id, session_id,
          request_id, trace_id, span_id, parent_span_id, tags, metrics, metadata
        ) FROM STDIN WITH CSV
      `;

      const stream = client.query(copyQuery);
      
      for (const event of events) {
        const row = [
          event.projectId,
          event.componentId || '',
          event.eventType,
          event.eventName,
          event.timestamp?.toISOString() || new Date().toISOString(),
          event.durationMs || '',
          event.status || '',
          event.errorMessage || '',
          event.userId || '',
          event.sessionId || '',
          event.requestId || '',
          event.traceId || '',
          event.spanId || '',
          event.parentSpanId || '',
          JSON.stringify(event.tags || {}),
          JSON.stringify(event.metrics || {}),
          JSON.stringify(event.metadata || {})
        ].map(val => val === '' ? null : val);
        
        stream.write(row.join('\t') + '\n');
      }

      stream.end();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async queryTelemetryEvents(filters: TelemetryQueryFilters): Promise<TelemetryEventCreateData[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.projectId) {
      conditions.push(`project_id = $${paramIndex++}`);
      params.push(filters.projectId);
    }

    if (filters.componentId) {
      conditions.push(`component_id = $${paramIndex++}`);
      params.push(filters.componentId);
    }

    if (filters.eventType) {
      conditions.push(`event_type = $${paramIndex++}`);
      params.push(filters.eventType);
    }

    if (filters.timeFrom) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(filters.timeFrom);
    }

    if (filters.timeTo) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(filters.timeTo);
    }

    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }

    if (filters.traceId) {
      conditions.push(`trace_id = $${paramIndex++}`);
      params.push(filters.traceId);
    }

    if (filters.sessionId) {
      conditions.push(`session_id = $${paramIndex++}`);
      params.push(filters.sessionId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filters.limit ? `LIMIT ${filters.limit}` : '';
    const offsetClause = filters.offset ? `OFFSET ${filters.offset}` : '';

    const query = `
      SELECT 
        project_id, component_id, event_type, event_name, timestamp,
        duration_ms, status, error_message, user_id, session_id,
        request_id, trace_id, span_id, parent_span_id, tags, metrics, metadata
      FROM telemetry_events
      ${whereClause}
      ORDER BY timestamp DESC
      ${limitClause} ${offsetClause}
    `;

    const result = await this.pool.query(query, params);
    
    return result.rows.map(row => ({
      projectId: row.project_id,
      componentId: row.component_id,
      eventType: row.event_type,
      eventName: row.event_name,
      timestamp: row.timestamp,
      durationMs: row.duration_ms,
      status: row.status,
      errorMessage: row.error_message,
      userId: row.user_id,
      sessionId: row.session_id,
      requestId: row.request_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      tags: row.tags,
      metrics: row.metrics,
      metadata: row.metadata
    }));
  }

  async getTelemetryEventCount(filters: Omit<TelemetryQueryFilters, 'limit' | 'offset'>): Promise<number> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.projectId) {
      conditions.push(`project_id = $${paramIndex++}`);
      params.push(filters.projectId);
    }

    if (filters.componentId) {
      conditions.push(`component_id = $${paramIndex++}`);
      params.push(filters.componentId);
    }

    if (filters.eventType) {
      conditions.push(`event_type = $${paramIndex++}`);
      params.push(filters.eventType);
    }

    if (filters.timeFrom) {
      conditions.push(`timestamp >= $${paramIndex++}`);
      params.push(filters.timeFrom);
    }

    if (filters.timeTo) {
      conditions.push(`timestamp <= $${paramIndex++}`);
      params.push(filters.timeTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `SELECT COUNT(*) as count FROM telemetry_events ${whereClause}`;
    const result = await this.pool.query(query, params);
    
    return parseInt(result.rows[0].count);
  }

  // =============================================================================
  // TELEMETRY TRACE MANAGEMENT
  // =============================================================================

  async insertTelemetryTrace(trace: TelemetryTraceCreateData): Promise<void> {
    const query = `
      INSERT INTO telemetry_traces (
        project_id, trace_id, span_id, parent_span_id, operation_name,
        start_time, end_time, duration_ms, status, component_id, tags, logs
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (project_id, trace_id, span_id) DO UPDATE SET
        end_time = EXCLUDED.end_time,
        duration_ms = EXCLUDED.duration_ms,
        status = EXCLUDED.status,
        tags = EXCLUDED.tags,
        logs = EXCLUDED.logs
    `;

    await this.pool.query(query, [
      trace.projectId,
      trace.traceId,
      trace.spanId,
      trace.parentSpanId,
      trace.operationName,
      trace.startTime,
      trace.endTime,
      trace.durationMs,
      trace.status,
      trace.componentId,
      JSON.stringify(trace.tags || {}),
      JSON.stringify(trace.logs || [])
    ]);
  }

  async getTraceById(projectId: string, traceId: string): Promise<TelemetryTraceCreateData[]> {
    const query = `
      SELECT 
        project_id, trace_id, span_id, parent_span_id, operation_name,
        start_time, end_time, duration_ms, status, component_id, tags, logs
      FROM telemetry_traces
      WHERE project_id = $1 AND trace_id = $2
      ORDER BY start_time ASC
    `;

    const result = await this.pool.query(query, [projectId, traceId]);
    
    return result.rows.map(row => ({
      projectId: row.project_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      operationName: row.operation_name,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMs: row.duration_ms,
      status: row.status,
      componentId: row.component_id,
      tags: row.tags,
      logs: row.logs
    }));
  }

  async getTraceAnalysis(projectId: string, timeWindow: string = '1 hour'): Promise<any[]> {
    const query = `
      SELECT * FROM v_trace_analysis
      WHERE project_id = $1
        AND trace_start >= NOW() - INTERVAL '${timeWindow}'
      ORDER BY actual_trace_duration DESC
      LIMIT 100
    `;

    const result = await this.pool.query(query, [projectId]);
    return result.rows;
  }

  async getCriticalPaths(projectId: string, limit: number = 10): Promise<any[]> {
    const query = `
      SELECT * FROM v_trace_critical_paths
      WHERE project_id = $1
      ORDER BY total_duration DESC
      LIMIT $2
    `;

    const result = await this.pool.query(query, [projectId, limit]);
    return result.rows;
  }

  // =============================================================================
  // INSTRUMENTATION POINT MANAGEMENT
  // =============================================================================

  async createInstrumentationPoint(point: InstrumentationPointCreateData): Promise<void> {
    const query = `
      INSERT INTO instrumentation_points (
        project_id, component_id, point_id, point_type, location_file,
        location_function, location_line, location_column, ast_node_id,
        sampling_rate, sampling_type, conditions, data_capture_config,
        performance_config, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (project_id, point_id) DO UPDATE SET
        point_type = EXCLUDED.point_type,
        location_file = EXCLUDED.location_file,
        location_function = EXCLUDED.location_function,
        location_line = EXCLUDED.location_line,
        location_column = EXCLUDED.location_column,
        sampling_rate = EXCLUDED.sampling_rate,
        sampling_type = EXCLUDED.sampling_type,
        conditions = EXCLUDED.conditions,
        data_capture_config = EXCLUDED.data_capture_config,
        performance_config = EXCLUDED.performance_config,
        updated_at = NOW()
    `;

    await this.pool.query(query, [
      point.projectId,
      point.componentId,
      point.pointId,
      point.pointType,
      point.locationFile,
      point.locationFunction,
      point.locationLine,
      point.locationColumn,
      point.astNodeId,
      point.samplingRate || 1.0,
      point.samplingType || 'always',
      JSON.stringify(point.conditions || []),
      JSON.stringify(point.dataCaptureConfig || {}),
      JSON.stringify(point.performanceConfig || {}),
      true
    ]);
  }

  async updateInstrumentationMetrics(
    pointId: string,
    durationMs: number,
    isError: boolean = false
  ): Promise<void> {
    const query = `
      SELECT update_instrumentation_metrics($1, $2, $3)
    `;
    
    await this.pool.query(query, [pointId, durationMs, isError]);
  }

  async getInstrumentationPoints(
    projectId: string,
    activeOnly: boolean = true
  ): Promise<any[]> {
    const activeClause = activeOnly ? 'AND is_active = true' : '';
    
    const query = `
      SELECT 
        point_id, component_id, point_type, location_file, location_function,
        location_line, sampling_rate, sampling_type, invocation_count,
        total_time_ms, error_count, last_invocation, is_active
      FROM instrumentation_points
      WHERE project_id = $1 ${activeClause}
      ORDER BY invocation_count DESC
    `;

    const result = await this.pool.query(query, [projectId]);
    return result.rows;
  }

  async getInstrumentationEffectiveness(projectId: string): Promise<any[]> {
    const query = `
      SELECT * FROM v_instrumentation_effectiveness
      WHERE project_id = $1
      ORDER BY effectiveness_score DESC
    `;

    const result = await this.pool.query(query, [projectId]);
    return result.rows;
  }

  async deactivateInstrumentationPoint(pointId: string): Promise<void> {
    const query = `
      UPDATE instrumentation_points 
      SET is_active = false, updated_at = NOW()
      WHERE point_id = $1
    `;
    
    await this.pool.query(query, [pointId]);
  }

  // =============================================================================
  // COMPONENT HEALTH TRACKING
  // =============================================================================

  async insertComponentHealthMetrics(metrics: ComponentHealthMetrics): Promise<void> {
    const query = `
      INSERT INTO component_health_metrics (
        project_id, component_id, metric_timestamp, requests_per_minute,
        average_response_time_ms, error_rate_percent, memory_usage_mb,
        cpu_usage_percent, health_score, status, alerts_active
      ) VALUES ((SELECT id FROM projects WHERE id = $1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (project_id, component_id, metric_timestamp) DO UPDATE SET
        requests_per_minute = EXCLUDED.requests_per_minute,
        average_response_time_ms = EXCLUDED.average_response_time_ms,
        error_rate_percent = EXCLUDED.error_rate_percent,
        memory_usage_mb = EXCLUDED.memory_usage_mb,
        cpu_usage_percent = EXCLUDED.cpu_usage_percent,
        health_score = EXCLUDED.health_score,
        status = EXCLUDED.status,
        alerts_active = EXCLUDED.alerts_active
    `;

    // First get the project UUID from the project ID string
    const projectResult = await this.pool.query(
      'SELECT id FROM projects WHERE id = $1 OR name = $1',
      [metrics.componentId.split('_')[0]] // Assuming componentId starts with project identifier
    );

    if (projectResult.rows.length === 0) {
      throw new Error('Project not found');
    }

    const projectId = projectResult.rows[0].id;

    await this.pool.query(query, [
      projectId,
      metrics.componentId,
      metrics.timestamp,
      metrics.requestsPerMinute,
      metrics.averageResponseTimeMs,
      metrics.errorRatePercent,
      metrics.memoryUsageMb,
      metrics.cpuUsagePercent,
      metrics.healthScore,
      metrics.status,
      metrics.alertsActive
    ]);
  }

  async getRealtimeComponentPerformance(
    projectId: string,
    limit: number = 50
  ): Promise<any[]> {
    const query = `
      SELECT * FROM v_component_performance_realtime
      WHERE project_id = $1 AND recency_rank = 1
      ORDER BY health_score ASC, error_rate_percent DESC
      LIMIT $2
    `;

    const result = await this.pool.query(query, [projectId, limit]);
    return result.rows;
  }

  async calculateComponentHealth(
    projectId: string,
    componentId: string,
    timeWindow: string = '1 hour'
  ): Promise<number> {
    const query = `
      SELECT calculate_component_health($1, $2, $3::INTERVAL) as health_score
    `;

    const result = await this.pool.query(query, [projectId, componentId, timeWindow]);
    return result.rows[0].health_score;
  }

  // =============================================================================
  // SYSTEM HEALTH MONITORING
  // =============================================================================

  async insertSystemHealthSnapshot(snapshot: SystemHealthSnapshot): Promise<void> {
    const query = `
      INSERT INTO system_health_snapshots (
        project_id, snapshot_timestamp, total_components, healthy_components,
        warning_components, critical_components, average_health_score,
        total_requests_per_minute, system_error_rate_percent,
        system_response_time_p95_ms, active_bottlenecks,
        optimization_opportunities, metrics_snapshot
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `;

    await this.pool.query(query, [
      snapshot.projectId,
      snapshot.timestamp,
      snapshot.totalComponents,
      snapshot.healthyComponents,
      snapshot.warningComponents,
      snapshot.criticalComponents,
      snapshot.averageHealthScore,
      snapshot.totalRequestsPerMinute,
      snapshot.systemErrorRatePercent,
      snapshot.systemResponseTimeP95Ms,
      snapshot.activeBottlenecks,
      snapshot.optimizationOpportunities,
      JSON.stringify(snapshot.metricsSnapshot)
    ]);
  }

  async getProjectHealthDashboard(projectId: string): Promise<any> {
    const query = `
      SELECT * FROM v_project_health_dashboard
      WHERE project_id = $1
    `;

    const result = await this.pool.query(query, [projectId]);
    return result.rows[0] || null;
  }

  async getSystemHealthComprehensive(projectId: string): Promise<any> {
    const query = `
      SELECT * FROM v_system_health_comprehensive
      WHERE project_id = $1
    `;

    const result = await this.pool.query(query, [projectId]);
    return result.rows[0] || null;
  }

  // =============================================================================
  // BOTTLENECK AND OPTIMIZATION TRACKING
  // =============================================================================

  async insertBottleneck(bottleneck: BottleneckData): Promise<void> {
    const query = `
      INSERT INTO bottlenecks (
        project_id, component_id, bottleneck_type, location, severity,
        impact_score, frequency_count, average_delay_ms, recommendations, metrics
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (project_id, component_id, bottleneck_type, location) DO UPDATE SET
        severity = EXCLUDED.severity,
        impact_score = EXCLUDED.impact_score,
        frequency_count = bottlenecks.frequency_count + 1,
        average_delay_ms = (bottlenecks.average_delay_ms + EXCLUDED.average_delay_ms) / 2,
        last_detected = NOW(),
        recommendations = EXCLUDED.recommendations,
        metrics = EXCLUDED.metrics
    `;

    await this.pool.query(query, [
      bottleneck.projectId,
      bottleneck.componentId,
      bottleneck.bottleneckType,
      bottleneck.location,
      bottleneck.severity,
      bottleneck.impactScore,
      bottleneck.frequencyCount,
      bottleneck.averageDelayMs,
      JSON.stringify(bottleneck.recommendations),
      JSON.stringify(bottleneck.metrics)
    ]);
  }

  async getActiveBottlenecks(
    projectId: string,
    severity?: 'low' | 'medium' | 'high' | 'critical'
  ): Promise<any[]> {
    const severityClause = severity ? 'AND severity = $2' : '';
    const params = [projectId];
    if (severity) params.push(severity);

    const query = `
      SELECT 
        component_id, bottleneck_type, location, severity, impact_score,
        frequency_count, average_delay_ms, first_detected, last_detected,
        recommendations, metrics
      FROM bottlenecks
      WHERE project_id = $1 AND resolved_at IS NULL ${severityClause}
      ORDER BY severity DESC, impact_score DESC, last_detected DESC
    `;

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  async resolveBottleneck(
    projectId: string,
    componentId: string,
    bottleneckType: string,
    location: string
  ): Promise<void> {
    const query = `
      UPDATE bottlenecks 
      SET resolved_at = NOW()
      WHERE project_id = $1 
        AND component_id = $2 
        AND bottleneck_type = $3 
        AND location = $4
        AND resolved_at IS NULL
    `;

    await this.pool.query(query, [projectId, componentId, bottleneckType, location]);
  }

  async getOptimizationOpportunities(
    projectId: string,
    limit: number = 20
  ): Promise<any[]> {
    const query = `
      SELECT * FROM v_optimization_opportunities
      WHERE project_id = $1
      ORDER BY priority_score DESC, estimated_improvement_percent DESC
      LIMIT $2
    `;

    const result = await this.pool.query(query, [projectId, limit]);
    return result.rows;
  }

  // =============================================================================
  // TELEMETRY ANALYTICS AND AGGREGATION
  // =============================================================================

  async getHotFunctions(
    projectId: string,
    timeWindow: string = '1 hour',
    limit: number = 20
  ): Promise<any[]> {
    const query = `
      SELECT * FROM v_hot_functions
      WHERE component_id IN (
        SELECT component_id FROM telemetry_events te
        JOIN projects p ON te.project_id = p.id
        WHERE p.id = $1 
          AND te.timestamp >= NOW() - INTERVAL '${timeWindow}'
      )
      ORDER BY hotness_score DESC
      LIMIT $2
    `;

    const result = await this.pool.query(query, [projectId, limit]);
    return result.rows;
  }

  async getCallGraphAnalysis(projectId: string): Promise<any[]> {
    const query = `
      SELECT * FROM v_call_graph_analysis
      WHERE project_id = $1
      ORDER BY avg_importance_score DESC, high_risk_functions DESC
    `;

    const result = await this.pool.query(query, [projectId]);
    return result.rows;
  }

  async generateTelemetryManifest(
    projectId: string,
    timeWindow: string = '24 hours'
  ): Promise<Record<string, any>> {
    const query = `
      SELECT generate_telemetry_manifest($1, $2::INTERVAL) as manifest
    `;

    const result = await this.pool.query(query, [projectId, timeWindow]);
    return result.rows[0].manifest;
  }

  async getTelemetryHourlyStats(
    projectId: string,
    hoursBack: number = 24
  ): Promise<any[]> {
    const query = `
      SELECT * FROM telemetry_hourly_stats
      WHERE project_id = $1
        AND hour_bucket >= NOW() - INTERVAL '${hoursBack} hours'
      ORDER BY hour_bucket DESC
    `;

    const result = await this.pool.query(query, [projectId]);
    return result.rows;
  }

  async getComponentDailyHealth(
    projectId: string,
    daysBack: number = 7
  ): Promise<any[]> {
    const query = `
      SELECT * FROM component_daily_health
      WHERE project_id = $1
        AND day_bucket >= CURRENT_DATE - INTERVAL '${daysBack} days'
      ORDER BY day_bucket DESC, health_score ASC
    `;

    const result = await this.pool.query(query, [projectId]);
    return result.rows;
  }

  // =============================================================================
  // PERFORMANCE METRICS AGGREGATION
  // =============================================================================

  async insertPerformanceMetrics(
    projectId: string,
    componentId: string,
    metricName: string,
    metricType: 'counter' | 'gauge' | 'histogram' | 'timer',
    timeWindow: '1m' | '5m' | '15m' | '1h' | '6h' | '1d' | '7d',
    windowStart: Date,
    windowEnd: Date,
    values: {
      avg?: number;
      min?: number;
      max?: number;
      sum?: number;
      count?: number;
      p50?: number;
      p95?: number;
      p99?: number;
    }
  ): Promise<void> {
    const query = `
      INSERT INTO performance_metrics (
        project_id, component_id, metric_name, metric_type, time_window,
        window_start, window_end, value_avg, value_min, value_max,
        value_sum, value_count, percentile_50, percentile_95, percentile_99
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (project_id, component_id, metric_name, time_window, window_start) DO UPDATE SET
        value_avg = EXCLUDED.value_avg,
        value_min = LEAST(performance_metrics.value_min, EXCLUDED.value_min),
        value_max = GREATEST(performance_metrics.value_max, EXCLUDED.value_max),
        value_sum = EXCLUDED.value_sum,
        value_count = EXCLUDED.value_count,
        percentile_50 = EXCLUDED.percentile_50,
        percentile_95 = EXCLUDED.percentile_95,
        percentile_99 = EXCLUDED.percentile_99
    `;

    await this.pool.query(query, [
      projectId, componentId, metricName, metricType, timeWindow,
      windowStart, windowEnd, values.avg, values.min, values.max,
      values.sum, values.count, values.p50, values.p95, values.p99
    ]);
  }

  async getPerformanceMetrics(
    projectId: string,
    componentId?: string,
    metricName?: string,
    timeWindow?: string,
    hoursBack: number = 24
  ): Promise<any[]> {
    const conditions: string[] = ['project_id = $1'];
    const params: any[] = [projectId];
    let paramIndex = 2;

    if (componentId) {
      conditions.push(`component_id = $${paramIndex++}`);
      params.push(componentId);
    }

    if (metricName) {
      conditions.push(`metric_name = $${paramIndex++}`);
      params.push(metricName);
    }

    if (timeWindow) {
      conditions.push(`time_window = $${paramIndex++}`);
      params.push(timeWindow);
    }

    conditions.push(`window_start >= NOW() - INTERVAL '${hoursBack} hours'`);

    const query = `
      SELECT 
        component_id, metric_name, metric_type, time_window, window_start, window_end,
        value_avg, value_min, value_max, value_sum, value_count,
        percentile_50, percentile_95, percentile_99
      FROM performance_metrics
      WHERE ${conditions.join(' AND ')}
      ORDER BY window_start DESC
    `;

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  // =============================================================================
  // ERROR TRACKING
  // =============================================================================

  async trackError(
    projectId: string,
    componentId: string,
    errorType: string,
    errorMessage: string,
    stackTrace?: string,
    tags?: string[],
    metadata?: Record<string, any>
  ): Promise<void> {
    // Create error hash for grouping
    const crypto = await import('crypto');
    const errorSignature = `${errorType}:${errorMessage}`;
    const errorHash = crypto.createHash('sha256').update(errorSignature).digest('hex');

    const query = `
      INSERT INTO error_tracking (
        project_id, component_id, error_hash, error_type, error_message,
        stack_trace, first_seen, last_seen, occurrence_count,
        tags, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), 1, $7, $8)
      ON CONFLICT (project_id, error_hash) DO UPDATE SET
        last_seen = NOW(),
        occurrence_count = error_tracking.occurrence_count + 1,
        tags = EXCLUDED.tags,
        metadata = EXCLUDED.metadata
    `;

    await this.pool.query(query, [
      projectId,
      componentId,
      errorHash,
      errorType,
      errorMessage,
      stackTrace,
      JSON.stringify(tags || []),
      JSON.stringify(metadata || {})
    ]);
  }

  async getErrorsByComponent(
    projectId: string,
    componentId?: string,
    status?: 'active' | 'resolved' | 'ignored' | 'investigating',
    limit: number = 50
  ): Promise<any[]> {
    const conditions: string[] = ['project_id = $1'];
    const params: any[] = [projectId];
    let paramIndex = 2;

    if (componentId) {
      conditions.push(`component_id = $${paramIndex++}`);
      params.push(componentId);
    }

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }

    const query = `
      SELECT 
        component_id, error_hash, error_type, error_message,
        occurrence_count, first_seen, last_seen, status, tags, metadata
      FROM error_tracking
      WHERE ${conditions.join(' AND ')}
      ORDER BY occurrence_count DESC, last_seen DESC
      LIMIT ${limit}
    `;

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  async resolveError(projectId: string, errorHash: string): Promise<void> {
    const query = `
      UPDATE error_tracking 
      SET status = 'resolved', resolved_at = NOW()
      WHERE project_id = $1 AND error_hash = $2
    `;

    await this.pool.query(query, [projectId, errorHash]);
  }

  // =============================================================================
  // MAINTENANCE AND CLEANUP
  // =============================================================================

  async cleanupOldTelemetryData(): Promise<string> {
    const query = `SELECT cleanup_telemetry_data() as result`;
    const result = await this.pool.query(query);
    return result.rows[0].result;
  }

  async refreshTelemetryViews(): Promise<void> {
    const query = `SELECT refresh_telemetry_views()`;
    await this.pool.query(query);
  }

  async getTelemetryMetrics(): Promise<{
    totalEventsToday: number;
    uniqueComponentsActive: number;
    errorRatePercent: number;
    avgResponseTimeMs: number;
    activeTraces: number;
    instrumentationPointsActive: number;
  }> {
    const query = `
      WITH daily_stats AS (
        SELECT 
          COUNT(*) as total_events,
          COUNT(DISTINCT component_id) as unique_components,
          COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
          AVG(duration_ms) as avg_duration,
          COUNT(DISTINCT trace_id) FILTER (WHERE trace_id IS NOT NULL) as unique_traces
        FROM telemetry_events
        WHERE timestamp >= CURRENT_DATE
      ),
      instrumentation_stats AS (
        SELECT COUNT(*) as active_points
        FROM instrumentation_points
        WHERE is_active = true
      )
      SELECT 
        ds.total_events,
        ds.unique_components,
        CASE WHEN ds.total_events > 0 
             THEN (ds.error_count::NUMERIC / ds.total_events) * 100 
             ELSE 0 END as error_rate,
        ds.avg_duration,
        ds.unique_traces,
        istr.active_points
      FROM daily_stats ds
      CROSS JOIN instrumentation_stats istr
    `;

    const result = await this.pool.query(query);
    const row = result.rows[0];

    return {
      totalEventsToday: row.total_events || 0,
      uniqueComponentsActive: row.unique_components || 0,
      errorRatePercent: row.error_rate || 0,
      avgResponseTimeMs: row.avg_duration || 0,
      activeTraces: row.unique_traces || 0,
      instrumentationPointsActive: row.active_points || 0
    };
  }
}