-- =============================================================================
-- UNRAVL DATABASE - EXAMPLE QUERIES
-- Demonstrates common usage patterns and performance-optimized queries
-- =============================================================================

-- =============================================================================
-- PROJECT ANALYSIS QUERIES
-- =============================================================================

-- 1. Get the latest analysis for a project with component summary
SELECT 
    ar.id as analysis_id,
    ar.commit_sha,
    ar.completed_at,
    ar.processing_time_ms,
    COUNT(c.id) as total_components,
    COUNT(CASE WHEN c.is_entry_point = true THEN 1 END) as entry_points,
    COUNT(CASE WHEN c.is_orphaned = true THEN 1 END) as orphaned_components,
    AVG(c.complexity) as avg_complexity,
    AVG(c.test_coverage) as avg_test_coverage
FROM analysis_runs ar
LEFT JOIN components c ON ar.id = c.analysis_run_id
WHERE ar.project_id = $1
  AND ar.status = 'completed'
GROUP BY ar.id, ar.commit_sha, ar.completed_at, ar.processing_time_ms
ORDER BY ar.completed_at DESC
LIMIT 1;

-- 2. Find high-risk components in the latest analysis
WITH latest_analysis AS (
    SELECT id FROM analysis_runs 
    WHERE project_id = $1 AND status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
)
SELECT 
    c.name,
    c.type,
    c.path,
    c.complexity,
    c.test_coverage,
    ra.risk_level,
    array_agg(DISTINCT reason) as risk_reasons
FROM components c
JOIN risk_areas ra ON c.id = ra.component_id
JOIN latest_analysis la ON c.analysis_run_id = la.id
CROSS JOIN LATERAL jsonb_array_elements_text(ra.reasons) AS reason
WHERE ra.risk_level IN ('high', 'critical')
GROUP BY c.id, c.name, c.type, c.path, c.complexity, c.test_coverage, ra.risk_level
ORDER BY 
    CASE ra.risk_level 
        WHEN 'critical' THEN 1 
        WHEN 'high' THEN 2 
    END,
    c.complexity DESC;

-- 3. Component dependency graph for visualization
WITH latest_analysis AS (
    SELECT id FROM analysis_runs 
    WHERE project_id = $1 AND status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
),
component_connections AS (
    SELECT 
        from_comp.id as from_id,
        from_comp.name as from_name,
        from_comp.type as from_type,
        from_comp.position_x as from_x,
        from_comp.position_y as from_y,
        to_comp.id as to_id,
        to_comp.name as to_name,
        to_comp.type as to_type,
        to_comp.position_x as to_x,
        to_comp.position_y as to_y,
        conn.connection_type,
        conn.weight
    FROM connections conn
    JOIN components from_comp ON conn.from_component_id = from_comp.id
    JOIN components to_comp ON conn.to_component_id = to_comp.id
    JOIN latest_analysis la ON conn.analysis_run_id = la.id
    WHERE conn.weight > 1  -- Filter low-weight connections
)
SELECT 
    json_build_object(
        'nodes', json_agg(DISTINCT json_build_object(
            'id', from_id,
            'name', from_name,
            'type', from_type,
            'x', from_x,
            'y', from_y
        )) ||
        json_agg(DISTINCT json_build_object(
            'id', to_id,
            'name', to_name,
            'type', to_type,
            'x', to_x,
            'y', to_y
        )),
        'edges', json_agg(json_build_object(
            'from', from_id,
            'to', to_id,
            'type', connection_type,
            'weight', weight
        ))
    ) as graph_data
FROM component_connections;

-- 4. Track component evolution across analysis runs
SELECT 
    ar.commit_sha,
    ar.completed_at,
    c.complexity,
    c.test_coverage,
    c.line_count,
    LAG(c.complexity) OVER (ORDER BY ar.completed_at) as prev_complexity,
    LAG(c.test_coverage) OVER (ORDER BY ar.completed_at) as prev_coverage
FROM components c
JOIN analysis_runs ar ON c.analysis_run_id = ar.id
WHERE ar.project_id = $1
  AND c.component_id = $2  -- Stable component identifier
  AND ar.status = 'completed'
ORDER BY ar.completed_at DESC
LIMIT 10;

-- =============================================================================
-- REAL-TIME TELEMETRY QUERIES  
-- =============================================================================

-- 5. Real-time system health dashboard
SELECT 
    component_id,
    COUNT(*) as request_count,
    AVG(duration_ms) as avg_response_time,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_response_time,
    COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
    (COUNT(CASE WHEN status = 'error' THEN 1 END)::float / COUNT(*)::float * 100) as error_rate
FROM telemetry_events 
WHERE project_id = $1
  AND timestamp >= NOW() - INTERVAL '5 minutes'
  AND event_type = 'http_request'
GROUP BY component_id
HAVING COUNT(*) > 10  -- Filter low-traffic components
ORDER BY error_rate DESC, avg_response_time DESC;

-- 6. Error hotspots with context
SELECT 
    et.component_id,
    et.error_type,
    et.error_message,
    et.occurrence_count,
    et.first_seen,
    et.last_seen,
    c.name as component_name,
    c.type as component_type,
    EXTRACT(EPOCH FROM (et.last_seen - et.first_seen)) / 60 as duration_minutes
FROM error_tracking et
LEFT JOIN components c ON et.component_id = c.component_id
    AND c.analysis_run_id = (
        SELECT id FROM analysis_runs 
        WHERE project_id = $1 AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1
    )
WHERE et.project_id = $1
  AND et.status = 'active'
  AND et.last_seen >= NOW() - INTERVAL '24 hours'
ORDER BY et.occurrence_count DESC, et.last_seen DESC;

-- 7. Performance trend analysis
WITH hourly_metrics AS (
    SELECT 
        component_id,
        DATE_TRUNC('hour', timestamp) as hour,
        AVG(duration_ms) as avg_duration,
        COUNT(*) as request_count
    FROM telemetry_events
    WHERE project_id = $1
      AND event_type = 'http_request'
      AND timestamp >= NOW() - INTERVAL '24 hours'
    GROUP BY component_id, DATE_TRUNC('hour', timestamp)
)
SELECT 
    component_id,
    hour,
    avg_duration,
    request_count,
    LAG(avg_duration) OVER (PARTITION BY component_id ORDER BY hour) as prev_avg_duration,
    (avg_duration - LAG(avg_duration) OVER (PARTITION BY component_id ORDER BY hour)) / 
        LAG(avg_duration) OVER (PARTITION BY component_id ORDER BY hour) * 100 as duration_change_pct
FROM hourly_metrics
ORDER BY component_id, hour;

-- =============================================================================
-- MULTI-TENANT ORGANIZATION QUERIES
-- =============================================================================

-- 8. Organization usage summary for billing
SELECT 
    o.name,
    o.id,
    s.current_period_start,
    s.current_period_end,
    sp.name as plan_name,
    COUNT(DISTINCT p.id) as active_projects,
    COUNT(DISTINCT m.user_id) as team_members,
    COALESCE(ut_events.metric_value, 0) as telemetry_events_this_month,
    COALESCE(ut_analyses.metric_value, 0) as analysis_runs_this_month
FROM organizations o
LEFT JOIN subscriptions s ON o.id = s.organization_id AND s.status = 'active'
LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
LEFT JOIN projects p ON o.id = p.organization_id AND p.status = 'active'
LEFT JOIN memberships m ON o.id = m.organization_id
LEFT JOIN usage_tracking ut_events ON o.id = ut_events.organization_id 
    AND ut_events.metric_name = 'telemetry_events'
    AND ut_events.period_start >= DATE_TRUNC('month', NOW())
LEFT JOIN usage_tracking ut_analyses ON o.id = ut_analyses.organization_id
    AND ut_analyses.metric_name = 'analysis_runs'
    AND ut_analyses.period_start >= DATE_TRUNC('month', NOW())
WHERE o.id = $1
GROUP BY o.id, o.name, s.current_period_start, s.current_period_end, 
         sp.name, ut_events.metric_value, ut_analyses.metric_value;

-- 9. Team collaboration insights
SELECT 
    t.name as team_name,
    COUNT(DISTINCT m.user_id) as team_size,
    COUNT(DISTINCT p.id) as projects_count,
    COUNT(DISTINCT ar.id) as total_analyses,
    AVG(ar.processing_time_ms) as avg_analysis_time,
    MAX(ar.completed_at) as last_analysis
FROM teams t
LEFT JOIN memberships m ON t.id = m.team_id
LEFT JOIN projects p ON t.id = p.team_id
LEFT JOIN analysis_runs ar ON p.id = ar.project_id AND ar.status = 'completed'
WHERE t.organization_id = $1
GROUP BY t.id, t.name
ORDER BY projects_count DESC;

-- =============================================================================
-- SECURITY AND DEPENDENCY QUERIES
-- =============================================================================

-- 10. Security vulnerability dashboard
WITH latest_analyses AS (
    SELECT DISTINCT ON (project_id) 
        id, project_id 
    FROM analysis_runs 
    WHERE status = 'completed'
    ORDER BY project_id, completed_at DESC
)
SELECT 
    p.name as project_name,
    sv.severity,
    COUNT(*) as vulnerability_count,
    array_agg(DISTINCT d.name) as affected_dependencies
FROM security_vulnerabilities sv
JOIN dependencies d ON sv.dependency_id = d.id
JOIN latest_analyses la ON d.analysis_run_id = la.id
JOIN projects p ON la.project_id = p.id
WHERE p.organization_id = $1
  AND sv.fix_available = false
GROUP BY p.id, p.name, sv.severity
ORDER BY 
    CASE sv.severity 
        WHEN 'critical' THEN 1 
        WHEN 'high' THEN 2 
        WHEN 'medium' THEN 3 
        WHEN 'low' THEN 4 
    END,
    vulnerability_count DESC;

-- 11. Dependency usage analysis
WITH latest_analysis AS (
    SELECT id FROM analysis_runs 
    WHERE project_id = $1 AND status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
)
SELECT 
    d.name,
    d.version,
    d.type,
    d.license,
    d.size_bytes,
    d.is_directly_used,
    jsonb_array_length(d.usage_locations) as usage_count,
    COUNT(sv.id) as vulnerability_count
FROM dependencies d
LEFT JOIN security_vulnerabilities sv ON d.id = sv.dependency_id AND sv.fix_available = false
JOIN latest_analysis la ON d.analysis_run_id = la.id
GROUP BY d.id, d.name, d.version, d.type, d.license, d.size_bytes, d.is_directly_used, d.usage_locations
ORDER BY d.is_directly_used DESC, usage_count DESC;

-- =============================================================================
-- PERFORMANCE MONITORING QUERIES
-- =============================================================================

-- 12. System performance overview
SELECT 
    pm.metric_name,
    pm.component_id,
    pm.time_window,
    pm.value_avg,
    pm.value_max,
    pm.percentile_95,
    pm.value_count,
    pm.window_start
FROM performance_metrics pm
WHERE pm.project_id = $1
  AND pm.time_window = '5m'
  AND pm.window_start >= NOW() - INTERVAL '1 hour'
  AND pm.metric_name IN ('response_time_ms', 'throughput_rps', 'error_rate_pct')
ORDER BY pm.component_id, pm.metric_name, pm.window_start DESC;

-- 13. Slow query identification
SELECT 
    component_id,
    event_name,
    AVG(duration_ms) as avg_duration,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration,
    COUNT(*) as occurrence_count
FROM telemetry_events
WHERE project_id = $1
  AND event_type = 'database_query'
  AND timestamp >= NOW() - INTERVAL '1 hour'
  AND duration_ms > 1000  -- Queries slower than 1 second
GROUP BY component_id, event_name
HAVING COUNT(*) > 5
ORDER BY avg_duration DESC;

-- =============================================================================
-- ANALYTICS AND INSIGHTS QUERIES
-- =============================================================================

-- 14. Architecture complexity trends
SELECT 
    DATE_TRUNC('week', ar.completed_at) as week,
    AVG(
        (SELECT AVG(complexity) FROM components c WHERE c.analysis_run_id = ar.id)
    ) as avg_complexity,
    AVG(
        (SELECT AVG(test_coverage) FROM components c WHERE c.analysis_run_id = ar.id)
    ) as avg_test_coverage,
    COUNT(ar.id) as analyses_count
FROM analysis_runs ar
WHERE ar.project_id = $1
  AND ar.status = 'completed'
  AND ar.completed_at >= NOW() - INTERVAL '12 weeks'
GROUP BY DATE_TRUNC('week', ar.completed_at)
ORDER BY week;

-- 15. Most active components (by telemetry volume)
SELECT 
    te.component_id,
    c.name as component_name,
    c.type as component_type,
    COUNT(*) as total_events,
    COUNT(CASE WHEN te.event_type = 'http_request' THEN 1 END) as http_requests,
    COUNT(CASE WHEN te.event_type = 'database_query' THEN 1 END) as db_queries,
    COUNT(CASE WHEN te.event_type = 'error' THEN 1 END) as errors,
    AVG(te.duration_ms) FILTER (WHERE te.duration_ms IS NOT NULL) as avg_duration
FROM telemetry_events te
LEFT JOIN components c ON te.component_id = c.component_id
    AND c.analysis_run_id = (
        SELECT id FROM analysis_runs 
        WHERE project_id = $1 AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1
    )
WHERE te.project_id = $1
  AND te.timestamp >= NOW() - INTERVAL '24 hours'
GROUP BY te.component_id, c.name, c.type
HAVING COUNT(*) > 100
ORDER BY total_events DESC
LIMIT 20;

-- =============================================================================
-- ADMINISTRATIVE QUERIES
-- =============================================================================

-- 16. Database health and partition information
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) as index_size
FROM pg_tables 
WHERE schemaname = 'public'
  AND tablename LIKE 'telemetry_events%'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- 17. Query performance analysis
SELECT 
    query,
    calls,
    total_time,
    mean_time,
    stddev_time,
    rows,
    100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0) AS hit_percent
FROM pg_stat_statements 
WHERE query LIKE '%telemetry_events%' 
   OR query LIKE '%components%'
   OR query LIKE '%analysis_runs%'
ORDER BY total_time DESC
LIMIT 10;