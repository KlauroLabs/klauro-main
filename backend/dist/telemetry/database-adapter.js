"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryDatabaseAdapter = exports.EVENT_TYPE_MAPPING = void 0;
exports.EVENT_TYPE_MAPPING = {
    'analysis_started': 'system_metric',
    'analysis_completed': 'system_metric',
    'component_discovered': 'system_metric',
    'dependency_detected': 'system_metric',
    'entry_point_found': 'system_metric',
    'exit_point_found': 'system_metric',
    'pattern_detected': 'system_metric',
    'ast_traversal': 'system_metric',
    'file_processed': 'system_metric',
    'error_occurred': 'error',
    'performance_metric': 'performance',
    'memory_snapshot': 'performance',
    'cache_hit': 'performance',
    'cache_miss': 'performance',
    'optimization_applied': 'performance',
    'framework_detected': 'system_metric',
    'database_connection_found': 'database_query',
    'api_endpoint_discovered': 'system_metric',
    'test_coverage_calculated': 'system_metric',
    'risk_identified': 'system_metric',
    'call_graph_generated': 'system_metric',
    'complexity_calculated': 'system_metric',
    'component_discovery_completed': 'system_metric',
    'framework_analyzer_registered': 'system_metric',
    'framework_analyzer_auto_detected': 'system_metric',
    'manifest_generation_started': 'system_metric',
    'manifest_generation_completed': 'system_metric',
    'manifest_saved': 'system_metric',
    'plugin_registered': 'system_metric',
    'plugin_discovery_started': 'system_metric',
    'plugin_discovery_completed': 'system_metric',
    'analyzer_selected': 'system_metric',
    'analyzer_selected_from_cache': 'system_metric',
    'analyzer_selection_failed': 'error',
    'plugin_cache_cleared': 'system_metric',
};
class TelemetryDatabaseAdapter {
    static toDatabaseEvent(event) {
        const databaseEventType = exports.EVENT_TYPE_MAPPING[event.type];
        return {
            project_id: event.metadata.projectId,
            component_id: event.source.component,
            event_type: databaseEventType,
            event_name: event.type,
            timestamp: new Date(event.timestamp),
            duration_ms: event.performance?.duration,
            status: this.determineStatus(event),
            error_message: this.extractErrorMessage(event),
            user_id: event.metadata.userId,
            session_id: event.sessionId,
            trace_id: event.correlationId,
            span_id: this.extractSpanId(event),
            parent_span_id: event.parentId,
            tags: {
                analyzer: event.source.analyzer,
                environment: event.metadata.environment,
                version: event.metadata.version,
                platform: event.metadata.platform,
                ...event.metadata.tags
            },
            metrics: this.extractMetrics(event),
            metadata: {
                source: event.source,
                data: event.data,
                context: event.context,
                labels: event.metadata.labels
            }
        };
    }
    static fromDatabaseEvent(dbEvent) {
        return {
            id: dbEvent.id || 'unknown',
            timestamp: dbEvent.timestamp.getTime(),
            type: dbEvent.event_name,
            source: {
                analyzer: dbEvent.tags?.analyzer || 'unknown',
                component: dbEvent.component_id,
                file: dbEvent.metadata?.source?.file,
                function: dbEvent.metadata?.source?.function,
                line: dbEvent.metadata?.source?.line,
                column: dbEvent.metadata?.source?.column
            },
            sessionId: dbEvent.session_id || 'unknown',
            correlationId: dbEvent.trace_id,
            parentId: dbEvent.parent_span_id,
            data: dbEvent.metadata?.data || {},
            metadata: {
                projectId: dbEvent.project_id,
                userId: dbEvent.user_id,
                environment: dbEvent.tags?.environment || 'development',
                version: dbEvent.tags?.version || 'unknown',
                platform: dbEvent.tags?.platform || 'unknown',
                tags: dbEvent.tags,
                labels: dbEvent.metadata?.labels
            },
            performance: dbEvent.duration_ms ? {
                startTime: 0,
                duration: dbEvent.duration_ms
            } : undefined,
            context: dbEvent.metadata?.context
        };
    }
    static determineStatus(event) {
        if (event.type === 'error_occurred') {
            return 'error';
        }
        if (event.data?.success === false) {
            return 'error';
        }
        if (event.data?.success === true || event.performance?.duration !== undefined) {
            return 'success';
        }
        return undefined;
    }
    static extractErrorMessage(event) {
        if (event.type === 'error_occurred') {
            return event.data?.error || event.data?.message;
        }
        if (event.data?.error) {
            return event.data.error;
        }
        return undefined;
    }
    static extractSpanId(event) {
        return event.data?.spanId || event.id;
    }
    static extractMetrics(event) {
        const metrics = {};
        if (event.performance) {
            if (event.performance.duration !== undefined) {
                metrics.duration_ms = event.performance.duration;
            }
            if (event.performance.memoryUsed !== undefined) {
                metrics.memory_used_bytes = event.performance.memoryUsed;
            }
            if (event.performance.memoryDelta !== undefined) {
                metrics.memory_delta_bytes = event.performance.memoryDelta;
            }
            if (event.performance.cpuTime !== undefined) {
                metrics.cpu_time_ms = event.performance.cpuTime;
            }
        }
        if (event.data?.metric && event.data?.value !== undefined) {
            metrics[event.data.metric] = event.data.value;
            if (event.data.unit) {
                metrics[`${event.data.metric}_unit`] = event.data.unit;
            }
        }
        if (event.type === 'component_discovered') {
            metrics.file_size_bytes = event.data?.fileSize;
            metrics.function_count = event.data?.functionCount;
            metrics.class_count = event.data?.classCount;
            metrics.import_count = event.data?.importCount;
            metrics.export_count = event.data?.exportCount;
            metrics.parse_time_ms = event.data?.parseTime;
        }
        if (event.type === 'dependency_detected') {
            metrics.dependency_weight = event.data?.weight;
            metrics.dependency_depth = event.data?.depth;
            metrics.is_circular = event.data?.circular;
        }
        if (event.type === 'pattern_detected') {
            metrics.confidence_score = event.data?.confidence;
            metrics.indicator_count = event.data?.indicators?.length;
        }
        return Object.keys(metrics).length > 0 ? metrics : undefined;
    }
    static createBatchInsert(events) {
        const dbEvents = events.map(event => this.toDatabaseEvent(event));
        const query = `
      INSERT INTO telemetry_events (
        project_id, component_id, event_type, event_name, timestamp,
        duration_ms, status, error_message, user_id, session_id,
        request_id, trace_id, span_id, parent_span_id, tags, metrics, metadata
      ) VALUES `;
        const placeholders = dbEvents.map((_, index) => {
            const offset = index * 17;
            return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17})`;
        }).join(', ');
        const values = dbEvents.map(event => [
            event.project_id,
            event.component_id,
            event.event_type,
            event.event_name,
            event.timestamp,
            event.duration_ms,
            event.status,
            event.error_message,
            event.user_id,
            event.session_id,
            event.request_id || null,
            event.trace_id,
            event.span_id,
            event.parent_span_id,
            JSON.stringify(event.tags),
            JSON.stringify(event.metrics),
            JSON.stringify(event.metadata)
        ]);
        return {
            query: query + placeholders,
            values
        };
    }
    static createPerformanceAggregationQuery(projectId, timeWindow = '1h', componentId) {
        const timeMapping = {
            '1m': '1 minute',
            '5m': '5 minutes',
            '15m': '15 minutes',
            '1h': '1 hour',
            '6h': '6 hours',
            '1d': '1 day',
            '7d': '7 days'
        };
        const timeInterval = timeMapping[timeWindow];
        const componentFilter = componentId ? `AND component_id = '${componentId}'` : '';
        return `
      INSERT INTO performance_metrics (
        project_id, component_id, metric_name, metric_type, time_window,
        window_start, window_end, value_avg, value_min, value_max, value_sum, value_count,
        percentile_50, percentile_95, percentile_99
      )
      SELECT 
        project_id,
        component_id,
        'response_time' as metric_name,
        'histogram' as metric_type,
        '${timeWindow}' as time_window,
        DATE_TRUNC('${timeInterval}', timestamp) as window_start,
        DATE_TRUNC('${timeInterval}', timestamp) + INTERVAL '${timeInterval}' as window_end,
        AVG(duration_ms) as value_avg,
        MIN(duration_ms) as value_min,
        MAX(duration_ms) as value_max,
        SUM(duration_ms) as value_sum,
        COUNT(*) as value_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as percentile_50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as percentile_95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as percentile_99
      FROM telemetry_events
      WHERE project_id = '${projectId}'
        AND duration_ms IS NOT NULL
        AND timestamp >= NOW() - INTERVAL '1 day'
        ${componentFilter}
      GROUP BY project_id, component_id, DATE_TRUNC('${timeInterval}', timestamp)
      ON CONFLICT (project_id, component_id, metric_name, time_window, window_start) 
      DO UPDATE SET
        window_end = EXCLUDED.window_end,
        value_avg = EXCLUDED.value_avg,
        value_min = EXCLUDED.value_min,
        value_max = EXCLUDED.value_max,
        value_sum = EXCLUDED.value_sum,
        value_count = EXCLUDED.value_count,
        percentile_50 = EXCLUDED.percentile_50,
        percentile_95 = EXCLUDED.percentile_95,
        percentile_99 = EXCLUDED.percentile_99;
    `;
    }
    static createErrorTrackingQuery(projectId, componentId) {
        const componentFilter = componentId ? `AND component_id = '${componentId}'` : '';
        return `
      INSERT INTO error_tracking (
        project_id, component_id, error_hash, error_type, error_message,
        stack_trace, first_seen, last_seen, occurrence_count, status, metadata
      )
      SELECT 
        project_id,
        component_id,
        MD5(error_message) as error_hash,
        COALESCE((metadata->>'data'->>'error_type')::text, 'unknown') as error_type,
        error_message,
        (metadata->>'data'->>'stack')::text as stack_trace,
        MIN(timestamp) as first_seen,
        MAX(timestamp) as last_seen,
        COUNT(*) as occurrence_count,
        'active' as status,
        jsonb_build_object(
          'first_event_id', MIN(id),
          'last_event_id', MAX(id),
          'event_count', COUNT(*)
        ) as metadata
      FROM telemetry_events
      WHERE project_id = '${projectId}'
        AND event_type = 'error'
        AND error_message IS NOT NULL
        AND timestamp >= NOW() - INTERVAL '1 hour'
        ${componentFilter}
      GROUP BY project_id, component_id, MD5(error_message), error_message, (metadata->>'data'->>'error_type')::text
      ON CONFLICT (project_id, error_hash)
      DO UPDATE SET
        last_seen = EXCLUDED.last_seen,
        occurrence_count = error_tracking.occurrence_count + EXCLUDED.occurrence_count,
        metadata = error_tracking.metadata || EXCLUDED.metadata;
    `;
    }
}
exports.TelemetryDatabaseAdapter = TelemetryDatabaseAdapter;
