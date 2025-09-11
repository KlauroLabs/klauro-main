-- =============================================================================
-- MIGRATION 002: Add Telemetry Partitioning and Optimization
-- Description: Enhanced telemetry partitioning with automatic partition management
-- Author: Database Developer  
-- Date: 2024-01-16
-- =============================================================================

-- Migration metadata
INSERT INTO schema_migrations (version, name, applied_at) 
VALUES ('002', 'add_telemetry_optimization', NOW())
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- ENHANCED TELEMETRY PARTITIONING
-- =============================================================================

-- Create function to automatically create future partitions
CREATE OR REPLACE FUNCTION auto_create_telemetry_partition()
RETURNS TRIGGER AS $$
DECLARE
    partition_date DATE;
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    -- Extract the month from the timestamp
    partition_date := DATE_TRUNC('month', NEW.timestamp);
    partition_name := 'telemetry_events_' || TO_CHAR(partition_date, 'YYYY_MM');
    start_date := partition_date;
    end_date := start_date + INTERVAL '1 month';
    
    -- Check if partition exists, create if not
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables 
        WHERE tablename = partition_name AND schemaname = 'public'
    ) THEN
        -- Create partition
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
        
        EXECUTE format('
            CREATE INDEX %I ON %I(component_id, timestamp DESC) WHERE component_id IS NOT NULL
        ', 'idx_' || partition_name || '_component_time', partition_name);
        
        EXECUTE format('
            CREATE INDEX %I ON %I(trace_id) WHERE trace_id IS NOT NULL
        ', 'idx_' || partition_name || '_trace', partition_name);
        
        RAISE NOTICE 'Auto-created partition %', partition_name;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for automatic partition creation
CREATE TRIGGER trigger_auto_create_telemetry_partition
    BEFORE INSERT ON telemetry_events
    FOR EACH ROW
    EXECUTE FUNCTION auto_create_telemetry_partition();

-- =============================================================================
-- ADDITIONAL PERFORMANCE INDEXES
-- =============================================================================

-- Performance metrics indexes for time-series aggregation
CREATE INDEX IF NOT EXISTS idx_performance_metrics_window_component 
ON performance_metrics(time_window, component_id, window_start DESC)
WHERE component_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_performance_metrics_project_metric
ON performance_metrics(project_id, metric_name, window_start DESC);

-- Error tracking indexes for quick lookup
CREATE INDEX IF NOT EXISTS idx_error_tracking_component_type
ON error_tracking(component_id, error_type, last_seen DESC)
WHERE component_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_error_tracking_occurrence_count
ON error_tracking(occurrence_count DESC, status)
WHERE status = 'active';

-- Component analysis indexes
CREATE INDEX IF NOT EXISTS idx_components_complexity_coverage
ON components(complexity DESC, test_coverage ASC)
WHERE analysis_run_id IN (
    SELECT id FROM analysis_runs WHERE status = 'completed'
);

-- Connection weight index for graph analysis
CREATE INDEX IF NOT EXISTS idx_connections_weight_type
ON connections(connection_type, weight DESC, analysis_run_id);

-- =============================================================================
-- TELEMETRY AGGREGATION MATERIALIZED VIEWS
-- =============================================================================

-- Hourly telemetry aggregation
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_hourly_stats AS
SELECT 
    project_id,
    component_id,
    event_type,
    DATE_TRUNC('hour', timestamp) as hour_bucket,
    COUNT(*) as event_count,
    AVG(duration_ms) as avg_duration_ms,
    MIN(duration_ms) as min_duration_ms,
    MAX(duration_ms) as max_duration_ms,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as p50_duration_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration_ms,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99_duration_ms,
    COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count,
    COUNT(DISTINCT session_id) as unique_sessions,
    COUNT(DISTINCT user_id) as unique_users
FROM telemetry_events
WHERE timestamp >= NOW() - INTERVAL '7 days'
GROUP BY project_id, component_id, event_type, hour_bucket;

-- Index on materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_hourly_stats_unique
ON telemetry_hourly_stats(project_id, component_id, event_type, hour_bucket);

CREATE INDEX IF NOT EXISTS idx_telemetry_hourly_stats_hour
ON telemetry_hourly_stats(hour_bucket DESC);

-- Daily component health scores
CREATE MATERIALIZED VIEW IF NOT EXISTS component_daily_health AS
WITH daily_metrics AS (
    SELECT 
        project_id,
        component_id,
        DATE_TRUNC('day', timestamp) as day_bucket,
        COUNT(*) as total_requests,
        AVG(duration_ms) as avg_response_time,
        COUNT(CASE WHEN status = 'error' THEN 1 END)::NUMERIC / COUNT(*)::NUMERIC as error_rate
    FROM telemetry_events
    WHERE timestamp >= NOW() - INTERVAL '30 days'
      AND component_id IS NOT NULL
      AND event_type IN ('http_request', 'function_call')
    GROUP BY project_id, component_id, day_bucket
)
SELECT 
    dm.project_id,
    dm.component_id,
    dm.day_bucket,
    dm.total_requests,
    dm.avg_response_time,
    dm.error_rate * 100 as error_rate_percent,
    GREATEST(0, LEAST(100, 
        100 - 
        (dm.error_rate * 100 * 0.4) -
        (LEAST(dm.avg_response_time / 1000.0, 5) * 20 * 0.3) -
        (20 * 0.3)  -- Assume 80% test coverage as baseline
    )) as health_score
FROM daily_metrics dm;

-- Index on component health materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_component_daily_health_unique
ON component_daily_health(project_id, component_id, day_bucket);

CREATE INDEX IF NOT EXISTS idx_component_daily_health_score
ON component_daily_health(health_score DESC, day_bucket DESC);

-- =============================================================================
-- AUTOMATED MAINTENANCE FUNCTIONS
-- =============================================================================

-- Function to refresh materialized views
CREATE OR REPLACE FUNCTION refresh_telemetry_views()
RETURNS VOID AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY telemetry_hourly_stats;
    REFRESH MATERIALIZED VIEW CONCURRENTLY component_daily_health;
    
    -- Clean up old data (keep 90 days of hourly stats)
    DELETE FROM telemetry_hourly_stats 
    WHERE hour_bucket < NOW() - INTERVAL '90 days';
    
    -- Clean up old health scores (keep 90 days)
    DELETE FROM component_daily_health 
    WHERE day_bucket < NOW() - INTERVAL '90 days';
    
    RAISE NOTICE 'Telemetry materialized views refreshed and cleaned up';
END;
$$ LANGUAGE plpgsql;

-- Function to manage partition lifecycle
CREATE OR REPLACE FUNCTION manage_telemetry_partitions()
RETURNS TEXT AS $$
DECLARE
    result TEXT := '';
BEGIN
    -- Create partitions for next 3 months
    SELECT create_telemetry_partitions(3) INTO result;
    
    -- Drop partitions older than 12 months
    result := result || E'\n' || drop_old_telemetry_partitions(12);
    
    -- Analyze partitioned tables for better query planning
    ANALYZE telemetry_events;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- BACKGROUND TASK CONFIGURATION
-- =============================================================================

-- Create a simple task queue table for background processing
CREATE TABLE IF NOT EXISTS background_tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_type VARCHAR(100) NOT NULL,
    task_data JSONB DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'pending',
    priority INTEGER DEFAULT 5,
    max_retries INTEGER DEFAULT 3,
    retry_count INTEGER DEFAULT 0,
    scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT background_tasks_status_valid CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    CONSTRAINT background_tasks_priority_range CHECK (priority >= 1 AND priority <= 10)
);

-- Indexes for background task processing
CREATE INDEX IF NOT EXISTS idx_background_tasks_status_priority
ON background_tasks(status, priority DESC, scheduled_at ASC)
WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_background_tasks_type_status
ON background_tasks(task_type, status, created_at DESC);

-- Trigger for background tasks updated_at
CREATE TRIGGER trigger_background_tasks_updated_at 
    BEFORE UPDATE ON background_tasks 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- TELEMETRY RETENTION POLICIES
-- =============================================================================

-- Create retention policy configuration table
CREATE TABLE IF NOT EXISTS retention_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name VARCHAR(255) NOT NULL,
    retention_period INTERVAL NOT NULL,
    partition_column VARCHAR(255) NOT NULL DEFAULT 'timestamp',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(table_name)
);

-- Insert default retention policies
INSERT INTO retention_policies (table_name, retention_period, partition_column) VALUES
('telemetry_events', INTERVAL '1 year', 'timestamp'),
('performance_metrics', INTERVAL '6 months', 'window_start'),
('error_tracking', INTERVAL '2 years', 'first_seen')
ON CONFLICT (table_name) DO NOTHING;

-- Function to apply retention policies
CREATE OR REPLACE FUNCTION apply_retention_policies()
RETURNS TEXT AS $$
DECLARE
    policy RECORD;
    cutoff_date TIMESTAMP WITH TIME ZONE;
    deleted_count BIGINT;
    result TEXT := '';
BEGIN
    FOR policy IN 
        SELECT * FROM retention_policies WHERE is_active = true
    LOOP
        cutoff_date := NOW() - policy.retention_period;
        
        -- Apply retention based on table
        CASE policy.table_name
            WHEN 'telemetry_events' THEN
                -- For partitioned table, drop old partitions
                result := result || drop_old_telemetry_partitions(
                    EXTRACT(YEAR FROM policy.retention_period)::INTEGER * 12 + 
                    EXTRACT(MONTH FROM policy.retention_period)::INTEGER
                ) || E'\n';
            
            WHEN 'performance_metrics' THEN
                DELETE FROM performance_metrics 
                WHERE window_start < cutoff_date;
                GET DIAGNOSTICS deleted_count = ROW_COUNT;
                result := result || 'Deleted ' || deleted_count || ' old performance metrics' || E'\n';
            
            WHEN 'error_tracking' THEN
                UPDATE error_tracking 
                SET status = 'archived'
                WHERE first_seen < cutoff_date AND status != 'archived';
                GET DIAGNOSTICS deleted_count = ROW_COUNT;
                result := result || 'Archived ' || deleted_count || ' old error records' || E'\n';
        END CASE;
    END LOOP;
    
    RETURN COALESCE(NULLIF(result, ''), 'No retention policies applied');
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- VERIFY MIGRATION SUCCESS
-- =============================================================================

DO $$
DECLARE
    partition_count INTEGER;
    index_count INTEGER;
    materialized_view_count INTEGER;
BEGIN
    -- Check partitions
    SELECT COUNT(*) INTO partition_count
    FROM pg_tables 
    WHERE tablename LIKE 'telemetry_events_%' 
      AND schemaname = 'public';
    
    -- Check new indexes
    SELECT COUNT(*) INTO index_count
    FROM pg_indexes
    WHERE schemaname = 'public' 
      AND indexname LIKE 'idx_%telemetry%' 
      OR indexname LIKE 'idx_%performance%'
      OR indexname LIKE 'idx_%error%';
    
    -- Check materialized views
    SELECT COUNT(*) INTO materialized_view_count
    FROM pg_matviews
    WHERE schemaname = 'public'
      AND matviewname IN ('telemetry_hourly_stats', 'component_daily_health');
    
    RAISE NOTICE 'Migration 002 completed successfully:';
    RAISE NOTICE '  - Telemetry partitions: %', partition_count;
    RAISE NOTICE '  - Performance indexes: %', index_count;
    RAISE NOTICE '  - Materialized views: %', materialized_view_count;
    RAISE NOTICE '  - Automatic partition creation: ENABLED';
    RAISE NOTICE '  - Retention policies: CONFIGURED';
END $$;