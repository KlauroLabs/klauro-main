-- =============================================================================
-- UNRAVL DATABASE UTILITY FUNCTIONS
-- Performance helpers and business logic functions
-- =============================================================================

-- Migration tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(10) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- TELEMETRY AND PERFORMANCE FUNCTIONS
-- =============================================================================

-- Function to efficiently query telemetry data with time bucketing
CREATE OR REPLACE FUNCTION get_telemetry_time_series(
    p_project_id UUID,
    p_component_id VARCHAR DEFAULT NULL,
    p_event_type VARCHAR DEFAULT NULL,
    p_start_time TIMESTAMP WITH TIME ZONE DEFAULT NOW() - INTERVAL '1 hour',
    p_end_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    p_bucket_size INTERVAL DEFAULT INTERVAL '5 minutes'
) RETURNS TABLE (
    time_bucket TIMESTAMP WITH TIME ZONE,
    event_count BIGINT,
    avg_duration NUMERIC,
    error_count BIGINT,
    p95_duration NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        date_trunc_interval(te.timestamp, p_bucket_size) as time_bucket,
        COUNT(*) as event_count,
        AVG(te.duration_ms)::NUMERIC as avg_duration,
        COUNT(CASE WHEN te.status = 'error' THEN 1 END) as error_count,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY te.duration_ms)::NUMERIC as p95_duration
    FROM telemetry_events te
    WHERE te.project_id = p_project_id
      AND te.timestamp >= p_start_time
      AND te.timestamp <= p_end_time
      AND (p_component_id IS NULL OR te.component_id = p_component_id)
      AND (p_event_type IS NULL OR te.event_type = p_event_type)
    GROUP BY date_trunc_interval(te.timestamp, p_bucket_size)
    ORDER BY time_bucket;
END;
$$ LANGUAGE plpgsql STABLE;

-- Helper function for flexible time bucketing
CREATE OR REPLACE FUNCTION date_trunc_interval(
    timestamp_val TIMESTAMP WITH TIME ZONE,
    bucket_size INTERVAL
) RETURNS TIMESTAMP WITH TIME ZONE AS $$
DECLARE
    bucket_seconds INTEGER;
    epoch_seconds BIGINT;
    bucketed_seconds BIGINT;
BEGIN
    -- Extract total seconds from interval
    bucket_seconds := EXTRACT(EPOCH FROM bucket_size)::INTEGER;
    
    -- Get epoch seconds from timestamp
    epoch_seconds := EXTRACT(EPOCH FROM timestamp_val)::BIGINT;
    
    -- Round down to nearest bucket
    bucketed_seconds := (epoch_seconds / bucket_seconds) * bucket_seconds;
    
    -- Convert back to timestamp
    RETURN TO_TIMESTAMP(bucketed_seconds);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get component health score
CREATE OR REPLACE FUNCTION calculate_component_health_score(
    p_project_id UUID,
    p_component_id VARCHAR,
    p_time_window INTERVAL DEFAULT INTERVAL '1 hour'
) RETURNS TABLE (
    component_id VARCHAR,
    health_score NUMERIC,
    error_rate NUMERIC,
    avg_response_time NUMERIC,
    request_count BIGINT,
    test_coverage NUMERIC,
    complexity_score NUMERIC
) AS $$
DECLARE
    error_weight NUMERIC := 0.4;
    performance_weight NUMERIC := 0.3;
    coverage_weight NUMERIC := 0.2;
    complexity_weight NUMERIC := 0.1;
BEGIN
    RETURN QUERY
    WITH telemetry_stats AS (
        SELECT 
            te.component_id,
            COUNT(*) as total_requests,
            AVG(te.duration_ms) as avg_duration,
            COUNT(CASE WHEN te.status = 'error' THEN 1 END)::NUMERIC / COUNT(*)::NUMERIC as error_rate_calc
        FROM telemetry_events te
        WHERE te.project_id = p_project_id
          AND te.component_id = p_component_id
          AND te.timestamp >= NOW() - p_time_window
          AND te.event_type IN ('http_request', 'function_call')
        GROUP BY te.component_id
    ),
    component_stats AS (
        SELECT 
            c.component_id,
            c.test_coverage,
            c.complexity
        FROM components c
        JOIN analysis_runs ar ON c.analysis_run_id = ar.id
        WHERE ar.project_id = p_project_id
          AND c.component_id = p_component_id
          AND ar.status = 'completed'
        ORDER BY ar.completed_at DESC
        LIMIT 1
    )
    SELECT 
        p_component_id as component_id,
        GREATEST(0, LEAST(100, 
            100 - 
            (COALESCE(ts.error_rate_calc, 0) * 100 * error_weight) -
            (LEAST(COALESCE(ts.avg_duration, 0) / 1000.0, 5) * 20 * performance_weight) -
            ((10 - COALESCE(cs.test_coverage, 0) / 10) * 10 * coverage_weight) -
            ((COALESCE(cs.complexity, 1) - 1) * 10 * complexity_weight)
        ))::NUMERIC as health_score,
        COALESCE(ts.error_rate_calc * 100, 0)::NUMERIC as error_rate,
        COALESCE(ts.avg_duration, 0)::NUMERIC as avg_response_time,
        COALESCE(ts.total_requests, 0)::BIGINT as request_count,
        COALESCE(cs.test_coverage, 0)::NUMERIC as test_coverage,
        COALESCE(cs.complexity, 1)::NUMERIC as complexity_score
    FROM component_stats cs
    FULL OUTER JOIN telemetry_stats ts ON cs.component_id = ts.component_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- ANALYSIS AND ARCHITECTURE FUNCTIONS
-- =============================================================================

-- Function to get architecture summary for a project
CREATE OR REPLACE FUNCTION get_architecture_summary(
    p_project_id UUID,
    p_analysis_run_id UUID DEFAULT NULL
) RETURNS JSON AS $$
DECLARE
    target_analysis_id UUID;
    result JSON;
BEGIN
    -- Get the latest analysis if not specified
    IF p_analysis_run_id IS NULL THEN
        SELECT id INTO target_analysis_id
        FROM analysis_runs
        WHERE project_id = p_project_id AND status = 'completed'
        ORDER BY completed_at DESC
        LIMIT 1;
    ELSE
        target_analysis_id := p_analysis_run_id;
    END IF;
    
    IF target_analysis_id IS NULL THEN
        RETURN '{"error": "No completed analysis found"}'::JSON;
    END IF;
    
    WITH summary_data AS (
        SELECT 
            COUNT(*) as total_components,
            COUNT(CASE WHEN c.type = 'route' THEN 1 END) as routes,
            COUNT(CASE WHEN c.type = 'controller' THEN 1 END) as controllers,
            COUNT(CASE WHEN c.type = 'service' THEN 1 END) as services,
            COUNT(CASE WHEN c.type = 'model' THEN 1 END) as models,
            COUNT(CASE WHEN c.is_entry_point = true THEN 1 END) as entry_points,
            COUNT(CASE WHEN c.is_orphaned = true THEN 1 END) as orphaned,
            AVG(c.complexity) as avg_complexity,
            AVG(c.test_coverage) as avg_coverage,
            SUM(c.line_count) as total_lines
        FROM components c
        WHERE c.analysis_run_id = target_analysis_id
    ),
    risk_summary AS (
        SELECT 
            COUNT(CASE WHEN ra.risk_level = 'critical' THEN 1 END) as critical_risks,
            COUNT(CASE WHEN ra.risk_level = 'high' THEN 1 END) as high_risks,
            COUNT(CASE WHEN ra.risk_level = 'medium' THEN 1 END) as medium_risks,
            COUNT(CASE WHEN ra.risk_level = 'low' THEN 1 END) as low_risks
        FROM risk_areas ra
        WHERE ra.analysis_run_id = target_analysis_id
    ),
    connection_summary AS (
        SELECT 
            COUNT(*) as total_connections,
            COUNT(CASE WHEN conn.connection_type = 'http_call' THEN 1 END) as http_connections,
            COUNT(CASE WHEN conn.connection_type = 'database' THEN 1 END) as db_connections,
            AVG(conn.weight) as avg_connection_weight
        FROM connections conn
        WHERE conn.analysis_run_id = target_analysis_id
    )
    SELECT json_build_object(
        'analysis_id', target_analysis_id,
        'components', json_build_object(
            'total', sd.total_components,
            'by_type', json_build_object(
                'routes', sd.routes,
                'controllers', sd.controllers,
                'services', sd.services,
                'models', sd.models
            ),
            'entry_points', sd.entry_points,
            'orphaned', sd.orphaned,
            'avg_complexity', ROUND(sd.avg_complexity::NUMERIC, 2),
            'avg_coverage', ROUND(sd.avg_coverage::NUMERIC, 2),
            'total_lines', sd.total_lines
        ),
        'risks', json_build_object(
            'critical', rs.critical_risks,
            'high', rs.high_risks,
            'medium', rs.medium_risks,
            'low', rs.low_risks
        ),
        'connections', json_build_object(
            'total', cs.total_connections,
            'http_calls', cs.http_connections,
            'database_calls', cs.db_connections,
            'avg_weight', ROUND(cs.avg_connection_weight::NUMERIC, 2)
        )
    ) INTO result
    FROM summary_data sd
    CROSS JOIN risk_summary rs  
    CROSS JOIN connection_summary cs;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to detect architecture anti-patterns
CREATE OR REPLACE FUNCTION detect_architecture_antipatterns(
    p_analysis_run_id UUID
) RETURNS TABLE (
    antipattern_type VARCHAR,
    severity VARCHAR,
    description TEXT,
    affected_components TEXT[]
) AS $$
BEGIN
    -- God Object Detection
    RETURN QUERY
    SELECT 
        'god_object'::VARCHAR as antipattern_type,
        CASE 
            WHEN c.complexity > 8 THEN 'high'
            WHEN c.complexity > 6 THEN 'medium'
            ELSE 'low'
        END::VARCHAR as severity,
        ('Component "' || c.name || '" has very high complexity (' || c.complexity || '/10) and many responsibilities')::TEXT as description,
        ARRAY[c.component_id]::TEXT[] as affected_components
    FROM components c
    WHERE c.analysis_run_id = p_analysis_run_id
      AND c.complexity > 5
      AND array_length(c.responsibilities, 1) > 3;
    
    -- Circular Dependencies  
    RETURN QUERY
    WITH circular_deps AS (
        SELECT DISTINCT
            c1.component_id as comp1,
            c2.component_id as comp2
        FROM connections conn1
        JOIN connections conn2 ON conn1.to_component_id = conn2.from_component_id
            AND conn1.from_component_id = conn2.to_component_id
        JOIN components c1 ON conn1.from_component_id = c1.id
        JOIN components c2 ON conn1.to_component_id = c2.id
        WHERE conn1.analysis_run_id = p_analysis_run_id
          AND conn2.analysis_run_id = p_analysis_run_id
    )
    SELECT 
        'circular_dependency'::VARCHAR,
        'medium'::VARCHAR,
        'Circular dependency detected between components'::TEXT,
        ARRAY[cd.comp1, cd.comp2]::TEXT[]
    FROM circular_deps cd;
    
    -- Orphaned Components
    RETURN QUERY
    SELECT 
        'orphaned_component'::VARCHAR,
        'low'::VARCHAR,
        ('Component "' || c.name || '" appears to be unused (no dependencies)')::TEXT,
        ARRAY[c.component_id]::TEXT[]
    FROM components c
    WHERE c.analysis_run_id = p_analysis_run_id
      AND c.is_orphaned = true
      AND c.is_entry_point = false;
      
    -- Low Test Coverage on Critical Components
    RETURN QUERY
    SELECT 
        'untested_critical_component'::VARCHAR,
        'high'::VARCHAR,
        ('Critical component "' || c.name || '" has low test coverage (' || COALESCE(c.test_coverage, 0) || '%)')::TEXT,
        ARRAY[c.component_id]::TEXT[]
    FROM components c
    WHERE c.analysis_run_id = p_analysis_run_id
      AND c.is_entry_point = true
      AND COALESCE(c.test_coverage, 0) < 50;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- BILLING AND USAGE FUNCTIONS
-- =============================================================================

-- Function to calculate organization usage for current period
CREATE OR REPLACE FUNCTION calculate_current_usage(
    p_organization_id UUID
) RETURNS JSON AS $$
DECLARE
    result JSON;
    current_period_start TIMESTAMP WITH TIME ZONE;
    current_period_end TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Get current billing period
    current_period_start := DATE_TRUNC('month', NOW());
    current_period_end := current_period_start + INTERVAL '1 month';
    
    WITH usage_data AS (
        SELECT 
            COUNT(DISTINCT p.id) as active_projects,
            COUNT(DISTINCT m.user_id) as team_members,
            COALESCE(SUM(CASE WHEN ut.metric_name = 'telemetry_events' THEN ut.metric_value ELSE 0 END), 0) as telemetry_events,
            COALESCE(SUM(CASE WHEN ut.metric_name = 'analysis_runs' THEN ut.metric_value ELSE 0 END), 0) as analysis_runs,
            COALESCE(SUM(CASE WHEN ut.metric_name = 'storage_mb' THEN ut.metric_value ELSE 0 END), 0) as storage_mb
        FROM organizations o
        LEFT JOIN projects p ON o.id = p.organization_id AND p.status = 'active'
        LEFT JOIN memberships m ON o.id = m.organization_id
        LEFT JOIN usage_tracking ut ON o.id = ut.organization_id 
            AND ut.period_start = current_period_start
        WHERE o.id = p_organization_id
        GROUP BY o.id
    )
    SELECT json_build_object(
        'period_start', current_period_start,
        'period_end', current_period_end,
        'active_projects', ud.active_projects,
        'team_members', ud.team_members,
        'telemetry_events', ud.telemetry_events,
        'analysis_runs', ud.analysis_runs,
        'storage_mb', ud.storage_mb
    ) INTO result
    FROM usage_data ud;
    
    RETURN COALESCE(result, '{}'::JSON);
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to check if organization is within plan limits
CREATE OR REPLACE FUNCTION check_plan_limits(
    p_organization_id UUID,
    p_metric_name VARCHAR,
    p_requested_amount BIGINT DEFAULT 1
) RETURNS JSON AS $$
DECLARE
    current_usage BIGINT;
    plan_limit BIGINT;
    plan_name VARCHAR;
    result JSON;
BEGIN
    -- Get current usage
    SELECT ut.metric_value INTO current_usage
    FROM usage_tracking ut
    WHERE ut.organization_id = p_organization_id
      AND ut.metric_name = p_metric_name
      AND ut.period_start = DATE_TRUNC('month', NOW());
    
    current_usage := COALESCE(current_usage, 0);
    
    -- Get plan limit
    SELECT 
        sp.name,
        CASE p_metric_name
            WHEN 'projects' THEN sp.max_projects
            WHEN 'team_members' THEN sp.max_team_members
            WHEN 'telemetry_events' THEN sp.max_telemetry_events_per_month
            ELSE NULL
        END
    INTO plan_name, plan_limit
    FROM subscriptions s
    JOIN subscription_plans sp ON s.plan_id = sp.id
    WHERE s.organization_id = p_organization_id
      AND s.status = 'active';
    
    -- Build result
    result := json_build_object(
        'metric_name', p_metric_name,
        'current_usage', current_usage,
        'requested_amount', p_requested_amount,
        'plan_limit', plan_limit,
        'plan_name', plan_name,
        'would_exceed', CASE 
            WHEN plan_limit IS NULL THEN false  -- Unlimited
            ELSE (current_usage + p_requested_amount) > plan_limit
        END,
        'remaining', CASE 
            WHEN plan_limit IS NULL THEN NULL  -- Unlimited
            ELSE GREATEST(0, plan_limit - current_usage)
        END
    );
    
    RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- PARTITION MANAGEMENT FUNCTIONS
-- =============================================================================

-- Function to create telemetry partitions for future months
CREATE OR REPLACE FUNCTION create_telemetry_partitions(
    months_ahead INTEGER DEFAULT 3
) RETURNS TEXT AS $$
DECLARE
    start_date DATE;
    end_date DATE;
    partition_name TEXT;
    result TEXT := '';
    i INTEGER;
BEGIN
    FOR i IN 1..months_ahead LOOP
        start_date := DATE_TRUNC('month', CURRENT_DATE + (i || ' months')::INTERVAL);
        end_date := start_date + INTERVAL '1 month';
        partition_name := 'telemetry_events_' || TO_CHAR(start_date, 'YYYY_MM');
        
        -- Check if partition already exists
        IF NOT EXISTS (
            SELECT 1 FROM pg_tables 
            WHERE tablename = partition_name AND schemaname = 'public'
        ) THEN
            EXECUTE format('
                CREATE TABLE %I PARTITION OF telemetry_events
                FOR VALUES FROM (%L) TO (%L)
            ', partition_name, start_date, end_date);
            
            -- Add indexes
            EXECUTE format('
                CREATE INDEX %I ON %I(project_id, timestamp DESC)
            ', 'idx_' || partition_name || '_project_time', partition_name);
            
            EXECUTE format('
                CREATE INDEX %I ON %I(event_type, timestamp DESC)  
            ', 'idx_' || partition_name || '_type_time', partition_name);
            
            result := result || 'Created partition ' || partition_name || E'\n';
        END IF;
    END LOOP;
    
    RETURN COALESCE(NULLIF(result, ''), 'No new partitions needed');
END;
$$ LANGUAGE plpgsql;

-- Function to drop old telemetry partitions
CREATE OR REPLACE FUNCTION drop_old_telemetry_partitions(
    months_to_keep INTEGER DEFAULT 12
) RETURNS TEXT AS $$
DECLARE
    cutoff_date DATE;
    partition_record RECORD;
    result TEXT := '';
BEGIN
    cutoff_date := DATE_TRUNC('month', CURRENT_DATE - (months_to_keep || ' months')::INTERVAL);
    
    FOR partition_record IN 
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
          AND tablename LIKE 'telemetry_events_%'
          AND tablename != 'telemetry_events'
          AND TO_DATE(RIGHT(tablename, 7), 'YYYY_MM') < cutoff_date
    LOOP
        EXECUTE format('DROP TABLE IF EXISTS %I', partition_record.tablename);
        result := result || 'Dropped partition ' || partition_record.tablename || E'\n';
    END LOOP;
    
    RETURN COALESCE(NULLIF(result, ''), 'No old partitions to drop');
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- MAINTENANCE AND MONITORING FUNCTIONS
-- =============================================================================

-- Function to get database health metrics
CREATE OR REPLACE FUNCTION get_database_health() RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    WITH table_stats AS (
        SELECT 
            schemaname,
            tablename,
            pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
            pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
            n_tup_ins + n_tup_upd + n_tup_del as total_modifications,
            n_dead_tup as dead_tuples,
            last_vacuum,
            last_analyze
        FROM pg_stat_user_tables pst
        JOIN pg_tables pt ON pst.relname = pt.tablename
        WHERE schemaname = 'public'
        ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
        LIMIT 10
    ),
    connection_stats AS (
        SELECT 
            count(*) as total_connections,
            count(*) filter (where state = 'active') as active_connections,
            count(*) filter (where state = 'idle') as idle_connections
        FROM pg_stat_activity
        WHERE pid != pg_backend_pid()
    )
    SELECT json_build_object(
        'timestamp', NOW(),
        'connections', row_to_json(cs.*),
        'largest_tables', json_agg(row_to_json(ts.*))
    ) INTO result
    FROM connection_stats cs
    CROSS JOIN table_stats ts
    GROUP BY cs.*;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;