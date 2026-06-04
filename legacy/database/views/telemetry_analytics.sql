-- =============================================================================
-- TELEMETRY ANALYTICS VIEWS
-- Comprehensive views for real-time telemetry querying and analysis patterns
-- Designed to support the telemetry system architecture and analyzer integration
-- =============================================================================

-- =============================================================================
-- REAL-TIME COMPONENT PERFORMANCE VIEWS
-- =============================================================================

-- Real-time component performance metrics with sliding windows
CREATE OR REPLACE VIEW v_component_performance_realtime AS
WITH component_windows AS (
    SELECT 
        project_id,
        component_id,
        DATE_TRUNC('minute', timestamp) as minute_window,
        COUNT(*) as requests_per_minute,
        AVG(duration_ms) as avg_response_time,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as p50_response_time,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_response_time,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99_response_time,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
        COUNT(DISTINCT session_id) as unique_sessions,
        COUNT(DISTINCT user_id) as unique_users
    FROM telemetry_events
    WHERE timestamp >= NOW() - INTERVAL '1 hour'
      AND component_id IS NOT NULL
    GROUP BY project_id, component_id, minute_window
),
component_metrics AS (
    SELECT 
        cw.project_id,
        cw.component_id,
        cw.minute_window,
        cw.requests_per_minute,
        cw.avg_response_time,
        cw.p50_response_time,
        cw.p95_response_time,
        cw.p99_response_time,
        cw.error_count,
        CASE WHEN cw.requests_per_minute > 0 
             THEN (cw.error_count::NUMERIC / cw.requests_per_minute::NUMERIC) * 100
             ELSE 0 
        END as error_rate_percent,
        cw.unique_sessions,
        cw.unique_users,
        -- Health score calculation
        GREATEST(0, LEAST(100,
            100 - 
            (CASE WHEN cw.requests_per_minute > 0 
                  THEN (cw.error_count::NUMERIC / cw.requests_per_minute::NUMERIC) * 100 * 0.4
                  ELSE 0 END) -
            (LEAST(cw.avg_response_time / 1000.0, 5) * 20 * 0.6)
        )) as health_score,
        -- Status classification
        CASE 
            WHEN cw.error_count::NUMERIC / NULLIF(cw.requests_per_minute, 0)::NUMERIC > 0.1 THEN 'critical'
            WHEN cw.avg_response_time > 5000 THEN 'critical'
            WHEN cw.error_count::NUMERIC / NULLIF(cw.requests_per_minute, 0)::NUMERIC > 0.05 THEN 'warning'
            WHEN cw.avg_response_time > 2000 THEN 'warning'
            ELSE 'healthy'
        END as status
    FROM component_windows cw
)
SELECT 
    cm.*,
    c.name as component_name,
    c.type as component_type,
    c.architectural_layer,
    c.complexity,
    c.test_coverage,
    ROW_NUMBER() OVER (PARTITION BY cm.project_id, cm.component_id ORDER BY cm.minute_window DESC) as recency_rank
FROM component_metrics cm
LEFT JOIN components c ON cm.component_id = c.component_id
LEFT JOIN analysis_runs ar ON c.analysis_run_id = ar.id
WHERE ar.project_id = cm.project_id
  AND ar.status = 'completed'
  AND ar.completed_at = (
      SELECT MAX(ar2.completed_at) 
      FROM analysis_runs ar2 
      WHERE ar2.project_id = cm.project_id AND ar2.status = 'completed'
  );

-- Project-wide health dashboard view
CREATE OR REPLACE VIEW v_project_health_dashboard AS
WITH project_components AS (
    SELECT 
        project_id,
        COUNT(DISTINCT component_id) as total_components,
        COUNT(DISTINCT CASE WHEN status = 'healthy' THEN component_id END) as healthy_components,
        COUNT(DISTINCT CASE WHEN status = 'warning' THEN component_id END) as warning_components,
        COUNT(DISTINCT CASE WHEN status = 'critical' THEN component_id END) as critical_components,
        AVG(health_score) as avg_health_score,
        SUM(requests_per_minute) as total_requests_per_minute,
        AVG(error_rate_percent) as avg_error_rate,
        AVG(p95_response_time) as avg_p95_response_time
    FROM v_component_performance_realtime
    WHERE recency_rank = 1
    GROUP BY project_id
),
project_alerts AS (
    SELECT 
        project_id,
        COUNT(CASE WHEN severity IN ('high', 'critical') THEN 1 END) as active_critical_bottlenecks,
        COUNT(*) as total_active_bottlenecks
    FROM bottlenecks
    WHERE resolved_at IS NULL
    GROUP BY project_id
),
project_optimizations AS (
    SELECT 
        ar.project_id,
        COUNT(os.*) as pending_optimizations,
        COUNT(CASE WHEN os.priority_score >= 8 THEN 1 END) as high_priority_optimizations
    FROM optimization_suggestions os
    JOIN analysis_runs ar ON os.analysis_run_id = ar.id
    WHERE os.status = 'pending'
    GROUP BY ar.project_id
)
SELECT 
    pc.project_id,
    p.name as project_name,
    pc.total_components,
    pc.healthy_components,
    pc.warning_components,
    pc.critical_components,
    ROUND(pc.avg_health_score, 2) as avg_health_score,
    pc.total_requests_per_minute,
    ROUND(pc.avg_error_rate, 4) as avg_error_rate_percent,
    ROUND(pc.avg_p95_response_time, 2) as avg_p95_response_time_ms,
    COALESCE(pa.active_critical_bottlenecks, 0) as active_critical_bottlenecks,
    COALESCE(pa.total_active_bottlenecks, 0) as total_active_bottlenecks,
    COALESCE(po.pending_optimizations, 0) as pending_optimizations,
    COALESCE(po.high_priority_optimizations, 0) as high_priority_optimizations,
    -- Overall project health status
    CASE 
        WHEN pc.critical_components > 0 OR COALESCE(pa.active_critical_bottlenecks, 0) > 0 THEN 'critical'
        WHEN pc.warning_components > pc.healthy_components THEN 'warning'
        WHEN pc.avg_health_score < 70 THEN 'warning'
        ELSE 'healthy'
    END as overall_status,
    NOW() as snapshot_time
FROM project_components pc
JOIN projects p ON pc.project_id = p.id
LEFT JOIN project_alerts pa ON pc.project_id = pa.project_id
LEFT JOIN project_optimizations po ON pc.project_id = po.project_id;

-- =============================================================================
-- TELEMETRY TRACE ANALYSIS VIEWS
-- =============================================================================

-- Distributed trace analysis with performance insights
CREATE OR REPLACE VIEW v_trace_analysis AS
WITH trace_spans AS (
    SELECT 
        project_id,
        trace_id,
        COUNT(*) as span_count,
        MIN(start_time) as trace_start,
        MAX(COALESCE(end_time, start_time + (duration_ms * INTERVAL '1 millisecond'))) as trace_end,
        SUM(duration_ms) as total_duration_ms,
        MAX(duration_ms) as max_span_duration_ms,
        AVG(duration_ms) as avg_span_duration_ms,
        COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
        COUNT(DISTINCT component_id) as components_involved,
        array_agg(DISTINCT component_id ORDER BY start_time) FILTER (WHERE component_id IS NOT NULL) as component_flow,
        array_agg(operation_name ORDER BY start_time) as operation_flow
    FROM telemetry_traces
    WHERE start_time >= NOW() - INTERVAL '1 hour'
    GROUP BY project_id, trace_id
),
trace_performance AS (
    SELECT 
        ts.*,
        (ts.trace_end - ts.trace_start) as actual_trace_duration,
        -- Calculate parallelism efficiency
        CASE WHEN EXTRACT(EPOCH FROM (ts.trace_end - ts.trace_start)) * 1000 > 0
             THEN ts.total_duration_ms / (EXTRACT(EPOCH FROM (ts.trace_end - ts.trace_start)) * 1000)
             ELSE 1
        END as parallelism_ratio,
        -- Classify trace performance
        CASE 
            WHEN ts.error_count > 0 THEN 'error'
            WHEN EXTRACT(EPOCH FROM (ts.trace_end - ts.trace_start)) * 1000 > 10000 THEN 'slow'
            WHEN EXTRACT(EPOCH FROM (ts.trace_end - ts.trace_start)) * 1000 > 5000 THEN 'moderate'
            ELSE 'fast'
        END as performance_category
    FROM trace_spans ts
)
SELECT 
    tp.*,
    p.name as project_name,
    CASE 
        WHEN tp.parallelism_ratio > 2 THEN 'high_parallelism'
        WHEN tp.parallelism_ratio > 1.2 THEN 'some_parallelism'
        ELSE 'sequential'
    END as execution_pattern
FROM trace_performance tp
JOIN projects p ON tp.project_id = p.id;

-- Critical path analysis for traces
CREATE OR REPLACE VIEW v_trace_critical_paths AS
WITH trace_critical_spans AS (
    SELECT 
        project_id,
        trace_id,
        operation_name,
        component_id,
        duration_ms,
        start_time,
        RANK() OVER (PARTITION BY project_id, trace_id ORDER BY duration_ms DESC) as duration_rank,
        RANK() OVER (PARTITION BY project_id, trace_id ORDER BY start_time ASC) as chronological_rank
    FROM telemetry_traces
    WHERE start_time >= NOW() - INTERVAL '1 hour'
      AND duration_ms IS NOT NULL
),
path_analysis AS (
    SELECT 
        tcs.project_id,
        tcs.trace_id,
        array_agg(tcs.operation_name ORDER BY tcs.chronological_rank) as operation_sequence,
        array_agg(tcs.component_id ORDER BY tcs.chronological_rank) FILTER (WHERE tcs.component_id IS NOT NULL) as component_sequence,
        array_agg(tcs.duration_ms ORDER BY tcs.chronological_rank) as duration_sequence,
        -- Identify bottleneck operations (top 20% by duration)
        array_agg(tcs.operation_name ORDER BY tcs.duration_rank) FILTER (WHERE tcs.duration_rank <= GREATEST(1, COUNT(*) * 0.2)) as bottleneck_operations,
        SUM(tcs.duration_ms) as total_duration,
        COUNT(*) as total_spans
    FROM trace_critical_spans tcs
    GROUP BY tcs.project_id, tcs.trace_id
)
SELECT 
    pa.*,
    ta.performance_category,
    ta.components_involved,
    ta.error_count,
    p.name as project_name
FROM path_analysis pa
JOIN v_trace_analysis ta ON pa.project_id = ta.project_id AND pa.trace_id = ta.trace_id
JOIN projects p ON pa.project_id = p.id
WHERE ta.performance_category IN ('slow', 'moderate', 'error')
ORDER BY pa.total_duration DESC;

-- =============================================================================
-- CALL GRAPH ANALYSIS VIEWS
-- =============================================================================

-- Call graph metrics with complexity and risk analysis
CREATE OR REPLACE VIEW v_call_graph_analysis AS
WITH node_metrics AS (
    SELECT 
        cgn.analysis_run_id,
        cgn.component_id,
        cgn.id as node_id,
        cgn.name,
        cgn.node_type,
        cgn.complexity,
        cgn.fan_in,
        cgn.fan_out,
        cgn.is_critical,
        -- Calculate centrality metrics
        cgn.fan_in + cgn.fan_out as total_connections,
        cgn.fan_in::NUMERIC / NULLIF(cgn.fan_out, 0)::NUMERIC as fan_ratio,
        -- Risk scoring based on complexity and connections
        CASE 
            WHEN cgn.complexity > 7 AND (cgn.fan_in + cgn.fan_out) > 10 THEN 'high'
            WHEN cgn.complexity > 5 OR (cgn.fan_in + cgn.fan_out) > 15 THEN 'medium'
            ELSE 'low'
        END as risk_level,
        -- Calculate importance score
        (cgn.complexity * 0.3 + cgn.fan_in * 0.4 + cgn.fan_out * 0.3) as importance_score
    FROM call_graph_nodes cgn
),
component_call_metrics AS (
    SELECT 
        nm.analysis_run_id,
        nm.component_id,
        COUNT(*) as total_functions,
        COUNT(CASE WHEN nm.risk_level = 'high' THEN 1 END) as high_risk_functions,
        COUNT(CASE WHEN nm.risk_level = 'medium' THEN 1 END) as medium_risk_functions,
        COUNT(CASE WHEN nm.is_critical THEN 1 END) as critical_functions,
        AVG(nm.complexity) as avg_complexity,
        AVG(nm.importance_score) as avg_importance_score,
        MAX(nm.importance_score) as max_importance_score,
        SUM(nm.fan_in) as total_incoming_calls,
        SUM(nm.fan_out) as total_outgoing_calls
    FROM node_metrics nm
    GROUP BY nm.analysis_run_id, nm.component_id
)
SELECT 
    ccm.*,
    c.name as component_name,
    c.type as component_type,
    c.architectural_layer,
    c.test_coverage,
    ar.project_id,
    p.name as project_name,
    -- Component risk classification
    CASE 
        WHEN ccm.high_risk_functions > 0 AND ccm.avg_complexity > 6 THEN 'critical'
        WHEN ccm.high_risk_functions > 0 OR ccm.avg_complexity > 4 THEN 'high'
        WHEN ccm.medium_risk_functions > ccm.total_functions * 0.3 THEN 'medium'
        ELSE 'low'
    END as component_risk_level,
    -- Refactoring priority
    CASE 
        WHEN ccm.high_risk_functions > 2 AND ccm.test_coverage < 50 THEN 'urgent'
        WHEN ccm.avg_complexity > 5 AND ccm.max_importance_score > 15 THEN 'high'
        WHEN ccm.medium_risk_functions > 3 THEN 'medium'
        ELSE 'low'
    END as refactoring_priority
FROM component_call_metrics ccm
JOIN components c ON ccm.component_id = c.id
JOIN analysis_runs ar ON ccm.analysis_run_id = ar.id
JOIN projects p ON ar.project_id = p.id
WHERE ar.status = 'completed';

-- Hot functions analysis across the call graph
CREATE OR REPLACE VIEW v_hot_functions AS
WITH function_telemetry AS (
    SELECT 
        te.component_id,
        te.metadata->>'function_name' as function_name,
        COUNT(*) as call_count,
        AVG(te.duration_ms) as avg_duration_ms,
        MAX(te.duration_ms) as max_duration_ms,
        COUNT(CASE WHEN te.status = 'error' THEN 1 END) as error_count,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY te.duration_ms) as p95_duration_ms
    FROM telemetry_events te
    WHERE te.event_type = 'function_call'
      AND te.timestamp >= NOW() - INTERVAL '1 hour'
      AND te.component_id IS NOT NULL
      AND te.metadata->>'function_name' IS NOT NULL
    GROUP BY te.component_id, te.metadata->>'function_name'
),
function_static_analysis AS (
    SELECT 
        cgn.component_id,
        cgn.name as function_name,
        cgn.complexity,
        cgn.fan_in,
        cgn.fan_out,
        cgn.is_critical
    FROM call_graph_nodes cgn
    WHERE cgn.node_type IN ('function', 'method')
)
SELECT 
    COALESCE(ft.component_id, fsa.component_id) as component_id,
    COALESCE(ft.function_name, fsa.function_name) as function_name,
    ft.call_count,
    ft.avg_duration_ms,
    ft.max_duration_ms,
    ft.error_count,
    ft.p95_duration_ms,
    fsa.complexity,
    fsa.fan_in,
    fsa.fan_out,
    fsa.is_critical,
    -- Calculate hotness score combining static and dynamic metrics
    COALESCE(
        (COALESCE(ft.call_count, 0) * 0.3 + 
         COALESCE(ft.avg_duration_ms, 0) / 100 * 0.3 +
         COALESCE(fsa.complexity, 1) * 0.2 +
         COALESCE(fsa.fan_in + fsa.fan_out, 0) * 0.2), 0
    ) as hotness_score,
    -- Performance classification
    CASE 
        WHEN ft.avg_duration_ms > 1000 AND ft.call_count > 100 THEN 'critical_performance'
        WHEN ft.avg_duration_ms > 500 OR ft.call_count > 500 THEN 'high_performance_impact'
        WHEN ft.error_count > 0 AND ft.call_count > 10 THEN 'error_prone'
        WHEN fsa.complexity > 8 AND ft.call_count > 50 THEN 'complex_and_frequent'
        ELSE 'normal'
    END as performance_category,
    c.name as component_name,
    c.type as component_type
FROM function_telemetry ft
FULL OUTER JOIN function_static_analysis fsa 
    ON ft.component_id = fsa.component_id AND ft.function_name = fsa.function_name
LEFT JOIN components c ON COALESCE(ft.component_id, fsa.component_id) = c.component_id
WHERE COALESCE(ft.call_count, 0) > 0 OR COALESCE(fsa.fan_in + fsa.fan_out, 0) > 5
ORDER BY hotness_score DESC;

-- =============================================================================
-- OPTIMIZATION OPPORTUNITY VIEWS
-- =============================================================================

-- Comprehensive optimization opportunities analysis
CREATE OR REPLACE VIEW v_optimization_opportunities AS
WITH performance_opportunities AS (
    SELECT 
        project_id,
        component_id,
        'performance' as opportunity_type,
        'Optimize slow operations' as title,
        CONCAT('Component has ', COUNT(*), ' slow operations with avg response time ', 
               ROUND(AVG(duration_ms), 2), 'ms') as description,
        CASE 
            WHEN AVG(duration_ms) > 5000 THEN 95
            WHEN AVG(duration_ms) > 2000 THEN 80
            WHEN AVG(duration_ms) > 1000 THEN 60
            ELSE 40
        END as priority_score,
        COUNT(*) as affected_operations,
        AVG(duration_ms) as avg_impact_ms
    FROM telemetry_events
    WHERE timestamp >= NOW() - INTERVAL '24 hours'
      AND duration_ms > 500
      AND component_id IS NOT NULL
    GROUP BY project_id, component_id
    HAVING COUNT(*) >= 10
),
caching_opportunities AS (
    SELECT 
        te.project_id,
        te.component_id,
        'caching' as opportunity_type,
        'Add caching layer' as title,
        CONCAT('Repetitive operations detected: ', COUNT(*), ' calls to same endpoint/function') as description,
        CASE 
            WHEN COUNT(*) > 1000 THEN 90
            WHEN COUNT(*) > 500 THEN 75
            WHEN COUNT(*) > 100 THEN 60
            ELSE 40
        END as priority_score,
        COUNT(*) as affected_operations,
        AVG(te.duration_ms) as avg_impact_ms
    FROM telemetry_events te
    WHERE te.timestamp >= NOW() - INTERVAL '24 hours'
      AND te.component_id IS NOT NULL
    GROUP BY te.project_id, te.component_id, te.event_name, 
             te.metadata->>'method', te.metadata->>'path'
    HAVING COUNT(*) >= 50
),
complexity_opportunities AS (
    SELECT 
        ar.project_id,
        c.component_id,
        'refactoring' as opportunity_type,
        'Reduce code complexity' as title,
        CONCAT('High complexity component (', c.complexity, ') with low test coverage (', 
               COALESCE(c.test_coverage, 0), '%)') as description,
        CASE 
            WHEN c.complexity > 8 AND COALESCE(c.test_coverage, 0) < 30 THEN 95
            WHEN c.complexity > 6 AND COALESCE(c.test_coverage, 0) < 50 THEN 80
            WHEN c.complexity > 5 THEN 65
            ELSE 40
        END as priority_score,
        1 as affected_operations,
        c.complexity * 100 as avg_impact_ms -- Proxy for maintenance impact
    FROM components c
    JOIN analysis_runs ar ON c.analysis_run_id = ar.id
    WHERE ar.status = 'completed'
      AND c.complexity > 5
      AND ar.completed_at = (
          SELECT MAX(ar2.completed_at) 
          FROM analysis_runs ar2 
          WHERE ar2.project_id = ar.project_id AND ar2.status = 'completed'
      )
),
bottleneck_opportunities AS (
    SELECT 
        b.project_id,
        b.component_id,
        'bottleneck_resolution' as opportunity_type,
        CONCAT('Resolve ', b.bottleneck_type, ' bottleneck') as title,
        CONCAT('Active bottleneck causing ', ROUND(b.average_delay_ms, 2), 
               'ms average delay with ', b.frequency_count, ' occurrences') as description,
        CASE 
            WHEN b.severity = 'critical' THEN 100
            WHEN b.severity = 'high' THEN 85
            WHEN b.severity = 'medium' THEN 70
            ELSE 50
        END as priority_score,
        b.frequency_count as affected_operations,
        b.average_delay_ms as avg_impact_ms
    FROM bottlenecks b
    WHERE b.resolved_at IS NULL
      AND b.last_detected >= NOW() - INTERVAL '24 hours'
),
all_opportunities AS (
    SELECT * FROM performance_opportunities
    UNION ALL
    SELECT * FROM caching_opportunities
    UNION ALL
    SELECT * FROM complexity_opportunities
    UNION ALL
    SELECT * FROM bottleneck_opportunities
)
SELECT 
    ao.*,
    p.name as project_name,
    c.name as component_name,
    c.type as component_type,
    c.architectural_layer,
    -- Implementation effort estimation
    CASE 
        WHEN ao.opportunity_type = 'caching' THEN 'medium'
        WHEN ao.opportunity_type = 'performance' AND ao.avg_impact_ms > 2000 THEN 'high'
        WHEN ao.opportunity_type = 'refactoring' AND ao.priority_score > 80 THEN 'high'
        WHEN ao.opportunity_type = 'bottleneck_resolution' THEN 'medium'
        ELSE 'low'
    END as implementation_effort,
    -- Estimated improvement
    CASE 
        WHEN ao.opportunity_type = 'caching' AND ao.affected_operations > 500 THEN 70
        WHEN ao.opportunity_type = 'performance' THEN LEAST(80, ao.avg_impact_ms / 50)
        WHEN ao.opportunity_type = 'bottleneck_resolution' THEN LEAST(90, ao.avg_impact_ms / 100)
        ELSE 40
    END as estimated_improvement_percent,
    ROW_NUMBER() OVER (PARTITION BY ao.project_id ORDER BY ao.priority_score DESC, ao.affected_operations DESC) as priority_rank
FROM all_opportunities ao
JOIN projects p ON ao.project_id = p.id
LEFT JOIN components c ON ao.component_id = c.component_id
ORDER BY ao.priority_score DESC, ao.affected_operations DESC;

-- =============================================================================
-- INSTRUMENTATION EFFECTIVENESS VIEWS  
-- =============================================================================

-- Instrumentation coverage and effectiveness analysis
CREATE OR REPLACE VIEW v_instrumentation_effectiveness AS
WITH instrumentation_stats AS (
    SELECT 
        ip.project_id,
        ip.component_id,
        ip.point_type,
        COUNT(*) as total_points,
        COUNT(CASE WHEN ip.is_active THEN 1 END) as active_points,
        AVG(ip.sampling_rate) as avg_sampling_rate,
        SUM(ip.invocation_count) as total_invocations,
        SUM(ip.total_time_ms) as total_time_ms,
        SUM(ip.error_count) as total_errors,
        AVG(CASE WHEN ip.invocation_count > 0 
                 THEN ip.total_time_ms::NUMERIC / ip.invocation_count 
                 ELSE 0 END) as avg_duration_per_invocation
    FROM instrumentation_points ip
    GROUP BY ip.project_id, ip.component_id, ip.point_type
),
component_coverage AS (
    SELECT 
        iss.project_id,
        iss.component_id,
        COUNT(DISTINCT iss.point_type) as instrumented_types,
        SUM(iss.total_points) as total_instrumentation_points,
        SUM(iss.active_points) as active_instrumentation_points,
        SUM(iss.total_invocations) as total_invocations,
        SUM(iss.total_errors) as total_errors,
        AVG(iss.avg_duration_per_invocation) as avg_duration_ms,
        -- Calculate effectiveness score
        CASE 
            WHEN SUM(iss.total_invocations) > 1000 AND SUM(iss.total_errors) = 0 THEN 95
            WHEN SUM(iss.total_invocations) > 500 THEN 85
            WHEN SUM(iss.total_invocations) > 100 THEN 70
            WHEN SUM(iss.total_invocations) > 10 THEN 50
            ELSE 20
        END as effectiveness_score
    FROM instrumentation_stats iss
    GROUP BY iss.project_id, iss.component_id
)
SELECT 
    cc.*,
    p.name as project_name,
    c.name as component_name,
    c.type as component_type,
    c.complexity,
    -- Coverage metrics
    CASE WHEN cc.total_instrumentation_points > 0
         THEN (cc.active_instrumentation_points::NUMERIC / cc.total_instrumentation_points) * 100
         ELSE 0
    END as active_coverage_percent,
    CASE WHEN cc.total_invocations > 0
         THEN (cc.total_errors::NUMERIC / cc.total_invocations) * 100
         ELSE 0
    END as error_rate_percent,
    -- Recommendations
    CASE 
        WHEN cc.active_instrumentation_points = 0 THEN 'Enable instrumentation points'
        WHEN cc.total_invocations < 10 THEN 'Increase sampling rate or check instrumentation'
        WHEN cc.total_errors > cc.total_invocations * 0.05 THEN 'Investigate high error rate'
        WHEN cc.effectiveness_score > 80 THEN 'Well instrumented'
        ELSE 'Consider optimizing instrumentation'
    END as recommendation,
    -- Quality assessment
    CASE 
        WHEN cc.effectiveness_score >= 80 THEN 'excellent'
        WHEN cc.effectiveness_score >= 60 THEN 'good'
        WHEN cc.effectiveness_score >= 40 THEN 'fair'
        ELSE 'poor'
    END as instrumentation_quality
FROM component_coverage cc
JOIN projects p ON cc.project_id = p.id
LEFT JOIN components c ON cc.component_id = c.component_id;

-- =============================================================================
-- COMPREHENSIVE SYSTEM HEALTH VIEW
-- =============================================================================

-- Master system health view combining all telemetry aspects
CREATE OR REPLACE VIEW v_system_health_comprehensive AS
WITH health_dimensions AS (
    SELECT 
        p.id as project_id,
        p.name as project_name,
        -- Performance dimension
        COALESCE(phd.avg_health_score, 70) as performance_health,
        COALESCE(phd.total_requests_per_minute, 0) as current_load,
        COALESCE(phd.avg_error_rate_percent, 0) as error_rate,
        -- Architecture dimension
        COALESCE(AVG(cga.avg_complexity), 3) as avg_complexity,
        COALESCE(AVG(cga.avg_importance_score), 5) as avg_importance,
        COUNT(CASE WHEN cga.component_risk_level IN ('critical', 'high') THEN 1 END) as high_risk_components,
        -- Optimization dimension
        COUNT(vo.component_id) FILTER (WHERE vo.priority_rank <= 10) as top_optimization_opportunities,
        COALESCE(AVG(vo.priority_score), 0) FILTER (WHERE vo.priority_rank <= 10) as avg_optimization_priority,
        -- Instrumentation dimension
        COALESCE(AVG(vie.effectiveness_score), 50) as instrumentation_effectiveness,
        COUNT(vie.component_id) FILTER (WHERE vie.instrumentation_quality IN ('good', 'excellent')) as well_instrumented_components,
        -- Bottleneck dimension
        COUNT(b.id) FILTER (WHERE b.severity IN ('high', 'critical')) as critical_bottlenecks,
        COALESCE(AVG(b.impact_score), 0) FILTER (WHERE b.severity IN ('high', 'critical')) as avg_bottleneck_impact
    FROM projects p
    LEFT JOIN v_project_health_dashboard phd ON p.id = phd.project_id
    LEFT JOIN v_call_graph_analysis cga ON p.id = cga.project_id
    LEFT JOIN v_optimization_opportunities vo ON p.id = vo.project_id
    LEFT JOIN v_instrumentation_effectiveness vie ON p.id = vie.project_id
    LEFT JOIN bottlenecks b ON p.id = b.project_id AND b.resolved_at IS NULL
    GROUP BY p.id, p.name, phd.avg_health_score, phd.total_requests_per_minute, phd.avg_error_rate_percent
)
SELECT 
    hd.*,
    -- Calculate composite health scores
    (hd.performance_health * 0.35 + 
     (100 - LEAST(hd.avg_complexity * 20, 100)) * 0.20 +
     hd.instrumentation_effectiveness * 0.15 +
     GREATEST(0, 100 - hd.critical_bottlenecks * 25) * 0.15 +
     GREATEST(0, 100 - hd.error_rate * 10) * 0.15
    ) as composite_health_score,
    
    -- Overall system status
    CASE 
        WHEN hd.critical_bottlenecks > 2 OR hd.error_rate > 5 THEN 'critical'
        WHEN hd.performance_health < 60 OR hd.high_risk_components > 5 THEN 'warning'
        WHEN hd.performance_health < 80 OR hd.instrumentation_effectiveness < 60 THEN 'monitoring'
        ELSE 'healthy'
    END as system_status,
    
    -- Key recommendations
    CASE 
        WHEN hd.critical_bottlenecks > 0 THEN 'Address critical bottlenecks immediately'
        WHEN hd.error_rate > 2 THEN 'Investigate and fix error sources'
        WHEN hd.high_risk_components > 3 THEN 'Refactor high-risk components'
        WHEN hd.instrumentation_effectiveness < 50 THEN 'Improve telemetry instrumentation'
        WHEN hd.top_optimization_opportunities > 5 THEN 'Implement performance optimizations'
        ELSE 'System is operating well'
    END as primary_recommendation,
    
    -- Trending indicators (simplified - would need historical data for true trending)
    CASE 
        WHEN hd.current_load > 1000 THEN 'high_load'
        WHEN hd.current_load > 500 THEN 'moderate_load'
        ELSE 'low_load'
    END as load_trend,
    
    NOW() as health_check_time
FROM health_dimensions hd
ORDER BY composite_health_score ASC;