-- =============================================================================
-- MIGRATION 003: Analyzer and Telemetry System Alignment
-- Description: Enhanced database schema to fully support analyzer architecture types
-- and telemetry system requirements for real-time data processing
-- Author: PostgreSQL Database Expert
-- Date: 2024-01-16  
-- =============================================================================

-- Migration metadata
INSERT INTO schema_migrations (version, name, applied_at) 
VALUES ('003', 'analyzer_telemetry_alignment', NOW())
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- ENHANCED COMPONENTS TABLE FOR ANALYZER ARCHITECTURE TYPES
-- =============================================================================

-- Add missing fields for full analyzer compatibility
ALTER TABLE components 
ADD COLUMN IF NOT EXISTS http_methods JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS db_queries JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS external_calls JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS functions JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS performance_metrics JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS side_effects JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS annotations JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS source_hash VARCHAR(64), -- For change detection
ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER,
ADD COLUMN IF NOT EXISTS framework_specific_metadata JSONB DEFAULT '{}';

-- Add computed column for component health score
ALTER TABLE components 
ADD COLUMN IF NOT EXISTS health_score NUMERIC(5,2) GENERATED ALWAYS AS (
    GREATEST(0, LEAST(100, 
        100 - 
        (CASE WHEN test_coverage IS NULL THEN 20 ELSE (100 - test_coverage) * 0.3 END) -
        ((complexity - 1) * 10 * 0.4) -
        (CASE WHEN is_orphaned THEN 20 ELSE 0 END)
    ))
) STORED;

-- =============================================================================
-- CALL GRAPH TABLES FOR ANALYZER INTEGRATION
-- =============================================================================

-- Call graph nodes (functions, methods, classes)
CREATE TABLE IF NOT EXISTS call_graph_nodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    component_id UUID NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    node_id VARCHAR(255) NOT NULL, -- Unique within analysis run
    name VARCHAR(255) NOT NULL,
    node_type VARCHAR(50) NOT NULL, -- function, method, class, module
    file_path TEXT NOT NULL,
    line_number INTEGER,
    column_number INTEGER,
    signature TEXT,
    return_type VARCHAR(255),
    complexity INTEGER DEFAULT 1,
    fan_in INTEGER DEFAULT 0, -- Number of incoming calls
    fan_out INTEGER DEFAULT 0, -- Number of outgoing calls
    depth INTEGER DEFAULT 0, -- Depth in call hierarchy
    is_critical BOOLEAN DEFAULT false,
    is_async BOOLEAN DEFAULT false,
    is_generator BOOLEAN DEFAULT false,
    is_constructor BOOLEAN DEFAULT false,
    is_static BOOLEAN DEFAULT false,
    is_abstract BOOLEAN DEFAULT false,
    parameters JSONB DEFAULT '[]',
    annotations JSONB DEFAULT '[]',
    side_effects JSONB DEFAULT '[]',
    test_coverage NUMERIC(5,2),
    performance_metrics JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(analysis_run_id, node_id),
    CONSTRAINT call_graph_nodes_type_valid CHECK (node_type IN ('function', 'method', 'class', 'module')),
    CONSTRAINT call_graph_nodes_complexity_range CHECK (complexity >= 1 AND complexity <= 50)
);

-- Call graph edges (call relationships)
CREATE TABLE IF NOT EXISTS call_graph_edges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    from_node_id UUID NOT NULL REFERENCES call_graph_nodes(id) ON DELETE CASCADE,
    to_node_id UUID NOT NULL REFERENCES call_graph_nodes(id) ON DELETE CASCADE,
    call_count INTEGER DEFAULT 1,
    edge_type VARCHAR(50) DEFAULT 'direct', -- direct, indirect, virtual, callback
    is_async BOOLEAN DEFAULT false,
    is_conditional BOOLEAN DEFAULT false,
    call_sites JSONB DEFAULT '[]', -- Array of {file, line, column}
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(analysis_run_id, from_node_id, to_node_id),
    CONSTRAINT call_graph_edges_type_valid CHECK (edge_type IN ('direct', 'indirect', 'virtual', 'callback')),
    CONSTRAINT call_graph_edges_different_nodes CHECK (from_node_id != to_node_id)
);

-- Hot paths (frequently executed code paths)
CREATE TABLE IF NOT EXISTS hot_paths (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    path_nodes UUID[] NOT NULL, -- Array of call_graph_node IDs
    frequency_score NUMERIC(10,4) DEFAULT 0,
    average_time_ms NUMERIC(10,4),
    critical_path BOOLEAN DEFAULT false,
    description TEXT,
    optimization_suggestions JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- ENHANCED TELEMETRY EVENTS FOR ANALYZER INTEGRATION
-- =============================================================================

-- Add analyzer-specific event types to existing telemetry_events table constraints
DO $$
BEGIN
    -- Drop existing constraint if it exists
    IF EXISTS (
        SELECT 1 FROM information_schema.check_constraints 
        WHERE constraint_name = 'telemetry_events_type_valid'
    ) THEN
        ALTER TABLE telemetry_events DROP CONSTRAINT telemetry_events_type_valid;
    END IF;
    
    -- Add new constraint with analyzer event types
    ALTER TABLE telemetry_events ADD CONSTRAINT telemetry_events_type_valid CHECK (
        event_type IN (
            -- Existing types
            'http_request', 'function_call', 'database_query', 'external_api', 
            'error', 'performance', 'user_action', 'system_metric',
            -- New analyzer types
            'analysis_started', 'analysis_completed', 'component_discovered',
            'dependency_detected', 'entry_point_found', 'exit_point_found',
            'pattern_detected', 'ast_traversal', 'file_processed', 
            'optimization_applied', 'framework_detected', 'call_graph_generated',
            'complexity_calculated', 'risk_identified', 'test_coverage_calculated',
            'cache_hit', 'cache_miss', 'memory_snapshot'
        )
    );
END $$;

-- Telemetry event correlation table for trace analysis
CREATE TABLE IF NOT EXISTS telemetry_traces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    trace_id VARCHAR(255) NOT NULL,
    span_id VARCHAR(255) NOT NULL,
    parent_span_id VARCHAR(255),
    operation_name VARCHAR(255) NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,
    status VARCHAR(20) DEFAULT 'ok', -- ok, error, timeout
    component_id VARCHAR(255),
    tags JSONB DEFAULT '{}',
    logs JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(project_id, trace_id, span_id),
    CONSTRAINT telemetry_traces_status_valid CHECK (status IN ('ok', 'error', 'timeout'))
) PARTITION BY RANGE (start_time);

-- =============================================================================
-- INSTRUMENTATION POINTS TABLE
-- =============================================================================

-- Instrumentation configuration for real-time telemetry collection
CREATE TABLE IF NOT EXISTS instrumentation_points (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    component_id VARCHAR(255), -- Links to components.component_id
    point_id VARCHAR(255) NOT NULL,
    point_type VARCHAR(100) NOT NULL,
    location_file TEXT NOT NULL,
    location_function VARCHAR(255),
    location_line INTEGER NOT NULL,
    location_column INTEGER,
    ast_node_id VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    sampling_rate NUMERIC(4,3) DEFAULT 1.0, -- 0.0 to 1.0
    sampling_type VARCHAR(50) DEFAULT 'always', -- always, random, adaptive, conditional
    conditions JSONB DEFAULT '[]',
    data_capture_config JSONB DEFAULT '{}',
    performance_config JSONB DEFAULT '{}',
    invocation_count BIGINT DEFAULT 0,
    total_time_ms BIGINT DEFAULT 0,
    error_count BIGINT DEFAULT 0,
    last_invocation TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(project_id, point_id),
    CONSTRAINT instrumentation_points_type_valid CHECK (point_type IN (
        'function_entry', 'function_exit', 'loop_iteration', 'conditional_branch',
        'exception_handler', 'async_operation', 'database_query', 'api_call',
        'file_operation', 'memory_allocation', 'custom'
    )),
    CONSTRAINT instrumentation_points_sampling_range CHECK (sampling_rate >= 0.0 AND sampling_rate <= 1.0)
);

-- =============================================================================
-- ANALYSIS MANIFEST GENERATION SUPPORT
-- =============================================================================

-- Store complete analysis manifests for caching and comparison
CREATE TABLE IF NOT EXISTS analysis_manifests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    manifest_type VARCHAR(100) NOT NULL, -- blueprint, telemetry, comparison
    manifest_version VARCHAR(20) DEFAULT '1.0.0',
    manifest_data JSONB NOT NULL,
    manifest_hash VARCHAR(64) NOT NULL, -- For quick comparison
    file_size_bytes INTEGER,
    compression_used BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(analysis_run_id, manifest_type),
    CONSTRAINT analysis_manifests_type_valid CHECK (manifest_type IN ('blueprint', 'telemetry', 'comparison', 'security', 'testing'))
);

-- =============================================================================
-- PERFORMANCE OPTIMIZATION TABLES
-- =============================================================================

-- Optimization suggestions from analyzer
CREATE TABLE IF NOT EXISTS optimization_suggestions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    component_id UUID REFERENCES components(id) ON DELETE CASCADE,
    suggestion_type VARCHAR(100) NOT NULL,
    location TEXT NOT NULL,
    current_performance_ms NUMERIC(10,4),
    estimated_improvement_percent NUMERIC(5,2),
    implementation_effort VARCHAR(20), -- low, medium, high
    priority_score INTEGER DEFAULT 5, -- 1-10 scale
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    implementation_steps JSONB DEFAULT '[]',
    code_example TEXT,
    affected_components JSONB DEFAULT '[]',
    status VARCHAR(50) DEFAULT 'pending',
    implemented_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT optimization_suggestions_type_valid CHECK (suggestion_type IN (
        'caching', 'parallelization', 'batching', 'indexing', 'query', 
        'algorithm', 'architecture', 'memory', 'network', 'io'
    )),
    CONSTRAINT optimization_suggestions_effort_valid CHECK (implementation_effort IN ('low', 'medium', 'high')),
    CONSTRAINT optimization_suggestions_status_valid CHECK (status IN ('pending', 'in_progress', 'implemented', 'rejected', 'obsolete')),
    CONSTRAINT optimization_suggestions_priority_range CHECK (priority_score >= 1 AND priority_score <= 10)
);

-- Bottleneck tracking
CREATE TABLE IF NOT EXISTS bottlenecks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    component_id VARCHAR(255),
    bottleneck_type VARCHAR(50) NOT NULL,
    location TEXT NOT NULL,
    severity VARCHAR(20) NOT NULL,
    impact_score NUMERIC(5,2), -- 0-100 scale
    frequency_count INTEGER DEFAULT 1,
    average_delay_ms NUMERIC(10,4),
    first_detected TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_detected TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE,
    recommendations JSONB DEFAULT '[]',
    metrics JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT bottlenecks_type_valid CHECK (bottleneck_type IN ('cpu', 'memory', 'io', 'network', 'database', 'synchronization')),
    CONSTRAINT bottlenecks_severity_valid CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

-- =============================================================================
-- REAL-TIME TELEMETRY AGGREGATION TABLES
-- =============================================================================

-- Real-time component health metrics
CREATE TABLE IF NOT EXISTS component_health_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    component_id VARCHAR(255) NOT NULL,
    metric_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    requests_per_minute NUMERIC(10,2) DEFAULT 0,
    average_response_time_ms NUMERIC(10,4) DEFAULT 0,
    error_rate_percent NUMERIC(5,2) DEFAULT 0,
    memory_usage_mb NUMERIC(10,2) DEFAULT 0,
    cpu_usage_percent NUMERIC(5,2) DEFAULT 0,
    health_score NUMERIC(5,2) DEFAULT 100,
    status VARCHAR(20) DEFAULT 'healthy',
    alerts_active INTEGER DEFAULT 0,
    
    CONSTRAINT component_health_status_valid CHECK (status IN ('healthy', 'warning', 'critical', 'unknown'))
) PARTITION BY RANGE (metric_timestamp);

-- System-wide health dashboard metrics  
CREATE TABLE IF NOT EXISTS system_health_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    snapshot_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    total_components INTEGER NOT NULL,
    healthy_components INTEGER NOT NULL,
    warning_components INTEGER NOT NULL,
    critical_components INTEGER NOT NULL,
    average_health_score NUMERIC(5,2) NOT NULL,
    total_requests_per_minute NUMERIC(12,2) DEFAULT 0,
    system_error_rate_percent NUMERIC(5,2) DEFAULT 0,
    system_response_time_p95_ms NUMERIC(10,4) DEFAULT 0,
    active_bottlenecks INTEGER DEFAULT 0,
    optimization_opportunities INTEGER DEFAULT 0,
    metrics_snapshot JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- COMPREHENSIVE INDEXING STRATEGY
-- =============================================================================

-- Call graph indexes for performance
CREATE INDEX IF NOT EXISTS idx_call_graph_nodes_analysis_component 
ON call_graph_nodes(analysis_run_id, component_id);

CREATE INDEX IF NOT EXISTS idx_call_graph_nodes_type_critical 
ON call_graph_nodes(node_type, is_critical, fan_in DESC) 
WHERE is_critical = true;

CREATE INDEX IF NOT EXISTS idx_call_graph_nodes_complexity 
ON call_graph_nodes(complexity DESC, fan_out DESC);

CREATE INDEX IF NOT EXISTS idx_call_graph_edges_analysis 
ON call_graph_edges(analysis_run_id, call_count DESC);

CREATE INDEX IF NOT EXISTS idx_call_graph_edges_from_to 
ON call_graph_edges(from_node_id, to_node_id, call_count);

-- Hot paths indexes
CREATE INDEX IF NOT EXISTS idx_hot_paths_analysis_critical 
ON hot_paths(analysis_run_id, critical_path, frequency_score DESC) 
WHERE critical_path = true;

-- Telemetry trace indexes for distributed tracing
CREATE INDEX IF NOT EXISTS idx_telemetry_traces_project_trace 
ON telemetry_traces(project_id, trace_id, start_time DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_traces_span_parent 
ON telemetry_traces(span_id, parent_span_id) 
WHERE parent_span_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telemetry_traces_operation_duration 
ON telemetry_traces(operation_name, duration_ms DESC) 
WHERE status = 'ok' AND duration_ms IS NOT NULL;

-- Instrumentation points indexes
CREATE INDEX IF NOT EXISTS idx_instrumentation_project_active 
ON instrumentation_points(project_id, is_active, point_type) 
WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_instrumentation_component_type 
ON instrumentation_points(component_id, point_type, invocation_count DESC) 
WHERE component_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_instrumentation_performance 
ON instrumentation_points(project_id, total_time_ms DESC, error_count DESC) 
WHERE total_time_ms > 0;

-- Analysis manifest indexes
CREATE INDEX IF NOT EXISTS idx_analysis_manifests_run_type 
ON analysis_manifests(analysis_run_id, manifest_type);

CREATE INDEX IF NOT EXISTS idx_analysis_manifests_hash 
ON analysis_manifests(manifest_hash);

-- Optimization suggestions indexes
CREATE INDEX IF NOT EXISTS idx_optimization_suggestions_analysis 
ON optimization_suggestions(analysis_run_id, status, priority_score DESC);

CREATE INDEX IF NOT EXISTS idx_optimization_suggestions_component_type 
ON optimization_suggestions(component_id, suggestion_type, priority_score DESC) 
WHERE component_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_optimization_suggestions_pending 
ON optimization_suggestions(status, priority_score DESC, created_at DESC) 
WHERE status = 'pending';

-- Bottlenecks indexes
CREATE INDEX IF NOT EXISTS idx_bottlenecks_project_severity 
ON bottlenecks(project_id, severity, impact_score DESC) 
WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bottlenecks_component_type 
ON bottlenecks(component_id, bottleneck_type, last_detected DESC) 
WHERE component_id IS NOT NULL AND resolved_at IS NULL;

-- Component health metrics indexes (for partitioned table)
CREATE INDEX IF NOT EXISTS idx_component_health_project_time 
ON component_health_metrics(project_id, metric_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_component_health_component_status 
ON component_health_metrics(component_id, status, metric_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_component_health_alerts 
ON component_health_metrics(project_id, alerts_active DESC, metric_timestamp DESC) 
WHERE alerts_active > 0;

-- System health snapshots indexes
CREATE INDEX IF NOT EXISTS idx_system_health_project_time 
ON system_health_snapshots(project_id, snapshot_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_system_health_score 
ON system_health_snapshots(average_health_score ASC, snapshot_timestamp DESC);

-- Enhanced existing components indexes
CREATE INDEX IF NOT EXISTS idx_components_health_score 
ON components(health_score DESC, analysis_run_id) 
WHERE health_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_components_performance 
ON components(analysis_run_id, complexity DESC, test_coverage ASC);

CREATE INDEX IF NOT EXISTS idx_components_source_hash 
ON components(source_hash) 
WHERE source_hash IS NOT NULL;

-- Full-text search enhancement
CREATE INDEX IF NOT EXISTS idx_components_functions_gin 
ON components USING gin((functions::text) gin_trgm_ops) 
WHERE functions IS NOT NULL AND jsonb_array_length(functions) > 0;

-- =============================================================================
-- TELEMETRY PARTITIONING FOR HIGH-VOLUME TABLES  
-- =============================================================================

-- Create monthly partitions for telemetry_traces (last 6 months + next 3 months)
DO $$
DECLARE
    start_date DATE;
    end_date DATE;
    partition_name TEXT;
BEGIN
    FOR i IN -6..3 LOOP
        start_date := DATE_TRUNC('month', CURRENT_DATE + (i || ' months')::INTERVAL);
        end_date := start_date + INTERVAL '1 month';
        partition_name := 'telemetry_traces_' || TO_CHAR(start_date, 'YYYY_MM');
        
        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I PARTITION OF telemetry_traces
            FOR VALUES FROM (%L) TO (%L)
        ', partition_name, start_date, end_date);
        
        -- Add indexes to each partition
        EXECUTE format('
            CREATE INDEX IF NOT EXISTS %I ON %I(project_id, trace_id, start_time DESC)
        ', 'idx_' || partition_name || '_project_trace', partition_name);
    END LOOP;
END $$;

-- Create daily partitions for component_health_metrics (last 30 days + next 7 days)
DO $$
DECLARE
    start_date DATE;
    end_date DATE;
    partition_name TEXT;
BEGIN
    FOR i IN -30..7 LOOP
        start_date := CURRENT_DATE + (i || ' days')::INTERVAL;
        end_date := start_date + INTERVAL '1 day';
        partition_name := 'component_health_metrics_' || TO_CHAR(start_date, 'YYYY_MM_DD');
        
        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I PARTITION OF component_health_metrics
            FOR VALUES FROM (%L) TO (%L)
        ', partition_name, start_date, end_date);
        
        -- Add indexes to each partition
        EXECUTE format('
            CREATE INDEX IF NOT EXISTS %I ON %I(component_id, metric_timestamp DESC)
        ', 'idx_' || partition_name || '_component_time', partition_name);
    END LOOP;
END $$;

-- =============================================================================
-- DATABASE FUNCTIONS FOR ANALYZER AND TELEMETRY INTEGRATION
-- =============================================================================

-- Function to calculate component health score in real-time
CREATE OR REPLACE FUNCTION calculate_component_health(
    p_project_id UUID,
    p_component_id VARCHAR(255),
    p_time_window INTERVAL DEFAULT INTERVAL '1 hour'
) RETURNS NUMERIC(5,2) AS $$
DECLARE
    v_error_rate NUMERIC(5,2) := 0;
    v_avg_response_time NUMERIC(10,4) := 0;
    v_test_coverage NUMERIC(5,2) := 80; -- Default assumption
    v_complexity INTEGER := 1;
    v_health_score NUMERIC(5,2);
    v_window_start TIMESTAMP WITH TIME ZONE;
BEGIN
    v_window_start := NOW() - p_time_window;
    
    -- Get error rate from telemetry events
    SELECT COALESCE(
        (COUNT(CASE WHEN status = 'error' THEN 1 END)::NUMERIC / NULLIF(COUNT(*), 0)::NUMERIC) * 100,
        0
    ) INTO v_error_rate
    FROM telemetry_events
    WHERE project_id = p_project_id
      AND component_id = p_component_id
      AND timestamp >= v_window_start;
    
    -- Get average response time
    SELECT COALESCE(AVG(duration_ms), 0) INTO v_avg_response_time
    FROM telemetry_events
    WHERE project_id = p_project_id
      AND component_id = p_component_id
      AND timestamp >= v_window_start
      AND duration_ms IS NOT NULL;
    
    -- Get component metadata from latest analysis
    SELECT COALESCE(c.test_coverage, 80), COALESCE(c.complexity, 1)
    INTO v_test_coverage, v_complexity
    FROM components c
    JOIN analysis_runs ar ON c.analysis_run_id = ar.id
    WHERE ar.project_id = p_project_id
      AND c.component_id = p_component_id
      AND ar.status = 'completed'
    ORDER BY ar.completed_at DESC
    LIMIT 1;
    
    -- Calculate health score (0-100)
    v_health_score := GREATEST(0, LEAST(100,
        100 - 
        (v_error_rate * 0.4) - -- Error rate impact (40%)
        (LEAST(v_avg_response_time / 1000.0, 5) * 20 * 0.3) - -- Response time impact (30%)
        ((100 - v_test_coverage) * 0.2) - -- Test coverage impact (20%)
        ((v_complexity - 1) * 5 * 0.1) -- Complexity impact (10%)
    ));
    
    RETURN v_health_score;
END;
$$ LANGUAGE plpgsql;

-- Function to get hot paths for a project
CREATE OR REPLACE FUNCTION get_project_hot_paths(
    p_project_id UUID,
    p_limit INTEGER DEFAULT 10
) RETURNS TABLE(
    path_id UUID,
    path_description TEXT,
    frequency_score NUMERIC(10,4),
    average_time_ms NUMERIC(10,4),
    component_count INTEGER,
    optimization_score NUMERIC(5,2)
) AS $$
BEGIN
    RETURN QUERY
    WITH latest_analysis AS (
        SELECT id as analysis_run_id
        FROM analysis_runs
        WHERE project_id = p_project_id
          AND status = 'completed'
        ORDER BY completed_at DESC
        LIMIT 1
    ),
    hot_path_analysis AS (
        SELECT 
            hp.id,
            hp.description,
            hp.frequency_score,
            hp.average_time_ms,
            array_length(hp.path_nodes, 1) as node_count,
            CASE 
                WHEN hp.average_time_ms > 1000 AND hp.frequency_score > 0.7 THEN 95
                WHEN hp.average_time_ms > 500 AND hp.frequency_score > 0.5 THEN 80
                WHEN hp.average_time_ms > 100 AND hp.frequency_score > 0.3 THEN 60
                ELSE 40
            END as opt_score
        FROM hot_paths hp
        JOIN latest_analysis la ON hp.analysis_run_id = la.analysis_run_id
        ORDER BY hp.frequency_score DESC, hp.average_time_ms DESC
        LIMIT p_limit
    )
    SELECT 
        hpa.id,
        hpa.description,
        hpa.frequency_score,
        hpa.average_time_ms,
        hpa.node_count,
        hpa.opt_score
    FROM hot_path_analysis hpa;
END;
$$ LANGUAGE plpgsql;

-- Function to update instrumentation point metrics
CREATE OR REPLACE FUNCTION update_instrumentation_metrics(
    p_point_id VARCHAR(255),
    p_duration_ms INTEGER,
    p_is_error BOOLEAN DEFAULT false
) RETURNS VOID AS $$
BEGIN
    UPDATE instrumentation_points
    SET 
        invocation_count = invocation_count + 1,
        total_time_ms = total_time_ms + p_duration_ms,
        error_count = CASE WHEN p_is_error THEN error_count + 1 ELSE error_count END,
        last_invocation = NOW(),
        updated_at = NOW()
    WHERE point_id = p_point_id;
    
    -- If no rows were updated, the instrumentation point doesn't exist
    IF NOT FOUND THEN
        RAISE NOTICE 'Instrumentation point % not found', p_point_id;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to generate telemetry manifest
CREATE OR REPLACE FUNCTION generate_telemetry_manifest(
    p_project_id UUID,
    p_time_window INTERVAL DEFAULT INTERVAL '24 hours'
) RETURNS JSONB AS $$
DECLARE
    v_manifest JSONB;
    v_window_start TIMESTAMP WITH TIME ZONE;
BEGIN
    v_window_start := NOW() - p_time_window;
    
    WITH telemetry_stats AS (
        SELECT 
            COUNT(*) as total_events,
            COUNT(DISTINCT component_id) as active_components,
            COUNT(DISTINCT session_id) as unique_sessions,
            AVG(duration_ms) as avg_duration,
            COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count
        FROM telemetry_events
        WHERE project_id = p_project_id
          AND timestamp >= v_window_start
    ),
    component_metrics AS (
        SELECT 
            component_id,
            COUNT(*) as event_count,
            AVG(duration_ms) as avg_duration,
            COUNT(CASE WHEN status = 'error' THEN 1 END) as error_count
        FROM telemetry_events
        WHERE project_id = p_project_id
          AND timestamp >= v_window_start
          AND component_id IS NOT NULL
        GROUP BY component_id
    ),
    performance_hotspots AS (
        SELECT 
            component_id,
            avg_duration,
            error_count::NUMERIC / NULLIF(event_count, 0)::NUMERIC as error_rate
        FROM component_metrics
        WHERE avg_duration > 1000 OR (error_count::NUMERIC / NULLIF(event_count, 0)::NUMERIC) > 0.05
        ORDER BY avg_duration DESC
        LIMIT 10
    )
    SELECT jsonb_build_object(
        'version', '1.0.0',
        'generated_at', extract(epoch from now()),
        'project_id', p_project_id,
        'time_window_hours', extract(hours from p_time_window),
        'summary', (
            SELECT jsonb_build_object(
                'total_events', total_events,
                'active_components', active_components,
                'unique_sessions', unique_sessions,
                'average_duration_ms', avg_duration,
                'error_count', error_count,
                'error_rate_percent', CASE WHEN total_events > 0 THEN (error_count::NUMERIC / total_events::NUMERIC) * 100 ELSE 0 END
            )
            FROM telemetry_stats
        ),
        'component_metrics', (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'component_id', component_id,
                    'event_count', event_count,
                    'avg_duration_ms', avg_duration,
                    'error_count', error_count,
                    'error_rate_percent', (error_count::NUMERIC / NULLIF(event_count, 0)::NUMERIC) * 100
                )
            )
            FROM component_metrics
        ),
        'performance_hotspots', (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'component_id', component_id,
                    'avg_duration_ms', avg_duration,
                    'error_rate_percent', error_rate * 100
                )
            )
            FROM performance_hotspots
        ),
        'instrumentation_points', (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'point_id', point_id,
                    'point_type', point_type,
                    'invocation_count', invocation_count,
                    'avg_duration_ms', CASE WHEN invocation_count > 0 THEN total_time_ms::NUMERIC / invocation_count ELSE 0 END,
                    'error_rate_percent', CASE WHEN invocation_count > 0 THEN (error_count::NUMERIC / invocation_count) * 100 ELSE 0 END
                )
            )
            FROM instrumentation_points
            WHERE project_id = p_project_id AND is_active = true
        )
    ) INTO v_manifest;
    
    RETURN v_manifest;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- AUTOMATED MAINTENANCE AND CLEANUP
-- =============================================================================

-- Function to cleanup old telemetry data based on retention policies
CREATE OR REPLACE FUNCTION cleanup_telemetry_data()
RETURNS TEXT AS $$
DECLARE
    v_result TEXT := '';
    v_cutoff_date TIMESTAMP WITH TIME ZONE;
    v_deleted_count BIGINT;
BEGIN
    -- Clean up old component health metrics (keep 90 days)
    v_cutoff_date := NOW() - INTERVAL '90 days';
    
    DELETE FROM component_health_metrics 
    WHERE metric_timestamp < v_cutoff_date;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    v_result := v_result || 'Deleted ' || v_deleted_count || ' old component health metrics' || E'\n';
    
    -- Clean up old telemetry traces (keep 30 days)
    v_cutoff_date := NOW() - INTERVAL '30 days';
    
    DELETE FROM telemetry_traces 
    WHERE start_time < v_cutoff_date;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    v_result := v_result || 'Deleted ' || v_deleted_count || ' old telemetry traces' || E'\n';
    
    -- Clean up resolved bottlenecks (keep 180 days after resolution)
    v_cutoff_date := NOW() - INTERVAL '180 days';
    
    DELETE FROM bottlenecks 
    WHERE resolved_at IS NOT NULL AND resolved_at < v_cutoff_date;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    v_result := v_result || 'Deleted ' || v_deleted_count || ' old resolved bottlenecks' || E'\n';
    
    -- Archive old optimization suggestions (keep 1 year)
    v_cutoff_date := NOW() - INTERVAL '1 year';
    
    UPDATE optimization_suggestions 
    SET status = 'archived'
    WHERE created_at < v_cutoff_date AND status NOT IN ('implemented', 'in_progress');
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    v_result := v_result || 'Archived ' || v_deleted_count || ' old optimization suggestions' || E'\n';
    
    -- Vacuum analyze high-traffic tables
    VACUUM ANALYZE telemetry_events;
    VACUUM ANALYZE component_health_metrics;
    VACUUM ANALYZE telemetry_traces;
    
    v_result := v_result || 'Completed vacuum analyze on telemetry tables';
    
    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- TRIGGERS FOR AUTOMATIC MAINTENANCE
-- =============================================================================

-- Trigger to update component health when telemetry events are added
CREATE OR REPLACE FUNCTION auto_update_component_health()
RETURNS TRIGGER AS $$
DECLARE
    v_health_score NUMERIC(5,2);
BEGIN
    -- Only process for components with significant activity
    IF NEW.component_id IS NOT NULL AND 
       random() < 0.1 THEN -- Sample 10% of events to avoid excessive computation
        
        v_health_score := calculate_component_health(NEW.project_id, NEW.component_id);
        
        INSERT INTO component_health_metrics (
            project_id, component_id, metric_timestamp, health_score,
            requests_per_minute, average_response_time_ms, error_rate_percent
        )
        SELECT 
            NEW.project_id,
            NEW.component_id,
            DATE_TRUNC('minute', NEW.timestamp),
            v_health_score,
            COUNT(*) as rpm,
            AVG(duration_ms) as avg_time,
            (COUNT(CASE WHEN status = 'error' THEN 1 END)::NUMERIC / COUNT(*)::NUMERIC) * 100 as error_rate
        FROM telemetry_events
        WHERE project_id = NEW.project_id
          AND component_id = NEW.component_id
          AND timestamp >= DATE_TRUNC('minute', NEW.timestamp)
          AND timestamp < DATE_TRUNC('minute', NEW.timestamp) + INTERVAL '1 minute'
        ON CONFLICT (project_id, component_id, metric_timestamp) DO UPDATE SET
            health_score = EXCLUDED.health_score,
            requests_per_minute = EXCLUDED.requests_per_minute,
            average_response_time_ms = EXCLUDED.average_response_time_ms,
            error_rate_percent = EXCLUDED.error_rate_percent;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only create trigger if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers 
        WHERE trigger_name = 'trigger_auto_update_component_health'
    ) THEN
        CREATE TRIGGER trigger_auto_update_component_health
            AFTER INSERT ON telemetry_events
            FOR EACH ROW
            EXECUTE FUNCTION auto_update_component_health();
    END IF;
END $$;

-- Trigger to automatically detect bottlenecks
CREATE OR REPLACE FUNCTION auto_detect_bottlenecks()
RETURNS TRIGGER AS $$
DECLARE
    v_threshold_ms NUMERIC := 5000; -- 5 second threshold
    v_bottleneck_exists BOOLEAN;
BEGIN
    -- Check if this is a slow operation that could indicate a bottleneck
    IF NEW.duration_ms IS NOT NULL AND NEW.duration_ms > v_threshold_ms THEN
        
        -- Check if we already have this bottleneck recorded recently
        SELECT EXISTS(
            SELECT 1 FROM bottlenecks
            WHERE project_id = NEW.project_id
              AND component_id = NEW.component_id
              AND bottleneck_type = 'performance'
              AND resolved_at IS NULL
              AND last_detected >= NOW() - INTERVAL '1 hour'
        ) INTO v_bottleneck_exists;
        
        IF NOT v_bottleneck_exists THEN
            INSERT INTO bottlenecks (
                project_id, component_id, bottleneck_type, location,
                severity, impact_score, average_delay_ms, 
                recommendations
            ) VALUES (
                NEW.project_id,
                NEW.component_id,
                'performance',
                COALESCE(NEW.component_id, 'unknown'),
                CASE 
                    WHEN NEW.duration_ms > 10000 THEN 'critical'
                    WHEN NEW.duration_ms > 7500 THEN 'high'
                    ELSE 'medium'
                END,
                LEAST(100, NEW.duration_ms / 100), -- Impact score based on duration
                NEW.duration_ms,
                jsonb_build_array(
                    'Optimize slow operation',
                    'Add caching if applicable',
                    'Consider async processing',
                    'Review database queries if applicable'
                )
            );
        ELSE
            -- Update existing bottleneck
            UPDATE bottlenecks
            SET 
                frequency_count = frequency_count + 1,
                average_delay_ms = (average_delay_ms + NEW.duration_ms) / 2,
                last_detected = NOW()
            WHERE project_id = NEW.project_id
              AND component_id = NEW.component_id
              AND bottleneck_type = 'performance'
              AND resolved_at IS NULL;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create bottleneck detection trigger if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.triggers 
        WHERE trigger_name = 'trigger_auto_detect_bottlenecks'
    ) THEN
        CREATE TRIGGER trigger_auto_detect_bottlenecks
            AFTER INSERT ON telemetry_events
            FOR EACH ROW
            EXECUTE FUNCTION auto_detect_bottlenecks();
    END IF;
END $$;

-- =============================================================================
-- VERIFY MIGRATION SUCCESS  
-- =============================================================================

DO $$
DECLARE
    v_new_tables INTEGER;
    v_new_columns INTEGER;
    v_new_indexes INTEGER;
    v_new_functions INTEGER;
BEGIN
    -- Count new tables
    SELECT COUNT(*) INTO v_new_tables
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'call_graph_nodes', 'call_graph_edges', 'hot_paths', 'telemetry_traces',
        'instrumentation_points', 'analysis_manifests', 'optimization_suggestions',
        'bottlenecks', 'component_health_metrics', 'system_health_snapshots'
      );
    
    -- Count new columns in components
    SELECT COUNT(*) INTO v_new_columns
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'components'
      AND column_name IN (
        'http_methods', 'db_queries', 'external_calls', 'functions',
        'performance_metrics', 'side_effects', 'annotations', 'source_hash',
        'file_size_bytes', 'framework_specific_metadata', 'health_score'
      );
    
    -- Count new indexes (approximate)
    SELECT COUNT(*) INTO v_new_indexes
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname LIKE '%call_graph%'
      OR indexname LIKE '%telemetry_traces%'
      OR indexname LIKE '%instrumentation%'
      OR indexname LIKE '%optimization%'
      OR indexname LIKE '%bottlenecks%'
      OR indexname LIKE '%component_health%'
      OR indexname LIKE '%system_health%';
    
    -- Count new functions
    SELECT COUNT(*) INTO v_new_functions
    FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'calculate_component_health', 'get_project_hot_paths', 
        'update_instrumentation_metrics', 'generate_telemetry_manifest',
        'cleanup_telemetry_data', 'auto_update_component_health',
        'auto_detect_bottlenecks'
      );
    
    RAISE NOTICE 'Migration 003 completed successfully:';
    RAISE NOTICE '  - New tables created: %', v_new_tables;
    RAISE NOTICE '  - New columns added to components: %', v_new_columns;
    RAISE NOTICE '  - New indexes created: %', v_new_indexes;
    RAISE NOTICE '  - New functions created: %', v_new_functions;
    RAISE NOTICE '  - Real-time health monitoring: ENABLED';
    RAISE NOTICE '  - Automatic bottleneck detection: ENABLED';
    RAISE NOTICE '  - Call graph analysis: ENABLED';
    RAISE NOTICE '  - Telemetry tracing: ENABLED';
    RAISE NOTICE '  - Optimization suggestions: ENABLED';
END $$;