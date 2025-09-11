-- =============================================================================
-- UNRAVL DATABASE SCHEMA
-- Comprehensive PostgreSQL schema for Unravl architecture visualization platform
-- Supports: Multi-tenancy, Repository Analysis, Real-time Telemetry, Billing
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- =============================================================================
-- CORE MULTI-TENANT FOUNDATION
-- =============================================================================

-- Organizations (Top-level tenant isolation)
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    website_url VARCHAR(500),
    logo_url VARCHAR(500),
    settings JSONB DEFAULT '{}',
    billing_email VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9-]+$'),
    CONSTRAINT organizations_name_length CHECK (length(name) >= 2)
);

-- Teams within organizations
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    slug VARCHAR(100) NOT NULL,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(organization_id, slug),
    CONSTRAINT teams_slug_format CHECK (slug ~ '^[a-z0-9-]+$')
);

-- Users and authentication
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    email_verified_at TIMESTAMP WITH TIME ZONE,
    password_hash VARCHAR(255),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    avatar_url VARCHAR(500),
    timezone VARCHAR(50) DEFAULT 'UTC',
    locale VARCHAR(10) DEFAULT 'en',
    last_login_at TIMESTAMP WITH TIME ZONE,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT users_email_format CHECK (email ~ '^[^@]+@[^@]+\.[^@]+$')
);

-- User memberships in organizations/teams
CREATE TABLE memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    permissions JSONB DEFAULT '[]',
    invited_by UUID REFERENCES users(id),
    invited_at TIMESTAMP WITH TIME ZONE,
    joined_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id, organization_id, team_id),
    CONSTRAINT memberships_role_valid CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    CONSTRAINT memberships_team_org_consistency CHECK (
        team_id IS NULL OR 
        EXISTS (SELECT 1 FROM teams WHERE id = team_id AND organization_id = memberships.organization_id)
    )
);

-- =============================================================================
-- PROJECT AND REPOSITORY MANAGEMENT
-- =============================================================================

-- Projects (repositories being analyzed)
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    repository_url VARCHAR(500),
    repository_provider VARCHAR(50), -- github, gitlab, bitbucket, etc.
    repository_id VARCHAR(255), -- External repo ID
    default_branch VARCHAR(100) DEFAULT 'main',
    language VARCHAR(50),
    framework VARCHAR(100),
    status VARCHAR(50) DEFAULT 'active',
    settings JSONB DEFAULT '{}',
    last_analyzed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(organization_id, name),
    CONSTRAINT projects_status_valid CHECK (status IN ('active', 'archived', 'analyzing', 'error')),
    CONSTRAINT projects_provider_valid CHECK (repository_provider IN ('github', 'gitlab', 'bitbucket', 'azure', 'custom', null))
);

-- Analysis runs/snapshots
CREATE TABLE analysis_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    triggered_by UUID REFERENCES users(id),
    commit_sha VARCHAR(40),
    branch VARCHAR(255),
    status VARCHAR(50) DEFAULT 'queued',
    analyzer_version VARCHAR(50),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    processing_time_ms INTEGER,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT analysis_runs_status_valid CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);

-- =============================================================================
-- ARCHITECTURE BLUEPRINT STORAGE
-- =============================================================================

-- Components discovered in analysis
CREATE TABLE components (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    component_id VARCHAR(255) NOT NULL, -- Internal component identifier
    name VARCHAR(255) NOT NULL,
    type VARCHAR(100) NOT NULL,
    path TEXT NOT NULL,
    architectural_layer VARCHAR(50),
    line_count INTEGER,
    complexity INTEGER,
    last_modified TIMESTAMP WITH TIME ZONE,
    is_entry_point BOOLEAN DEFAULT false,
    is_orphaned BOOLEAN DEFAULT false,
    exports JSONB DEFAULT '[]',
    imports JSONB DEFAULT '[]',
    responsibilities JSONB DEFAULT '[]',
    ai_description TEXT,
    test_coverage NUMERIC(5,2),
    position_x NUMERIC(10,2),
    position_y NUMERIC(10,2),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(analysis_run_id, component_id),
    CONSTRAINT components_type_valid CHECK (type IN ('route', 'controller', 'middleware', 'model', 'service', 'utility', 'config', 'database', 'external_api', 'orphaned')),
    CONSTRAINT components_layer_valid CHECK (architectural_layer IN ('presentation', 'business', 'data', 'infrastructure', 'external')),
    CONSTRAINT components_complexity_range CHECK (complexity >= 1 AND complexity <= 10),
    CONSTRAINT components_coverage_range CHECK (test_coverage >= 0 AND test_coverage <= 100)
);

-- Function-level analysis within components
CREATE TABLE functions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    component_id UUID NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    signature TEXT,
    return_type VARCHAR(255),
    line_count INTEGER,
    complexity INTEGER,
    is_public BOOLEAN DEFAULT true,
    is_async BOOLEAN DEFAULT false,
    parameters JSONB DEFAULT '[]',
    ai_description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(component_id, name, signature)
);

-- Function call relationships
CREATE TABLE function_calls (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    caller_function_id UUID NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    called_function_id UUID NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
    call_count INTEGER DEFAULT 1,
    call_sites JSONB DEFAULT '[]', -- Array of line numbers/locations
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(caller_function_id, called_function_id)
);

-- Connections between components
CREATE TABLE connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    from_component_id UUID NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    to_component_id UUID NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    connection_type VARCHAR(100) NOT NULL,
    weight INTEGER DEFAULT 1,
    call_sites INTEGER DEFAULT 0,
    data_flow VARCHAR(255),
    http_method VARCHAR(10),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(analysis_run_id, from_component_id, to_component_id, connection_type),
    CONSTRAINT connections_type_valid CHECK (connection_type IN ('import', 'http_call', 'database', 'middleware_chain', 'function_call', 'data_flow')),
    CONSTRAINT connections_different_components CHECK (from_component_id != to_component_id)
);

-- Entry points (ways into the system)
CREATE TABLE entry_points (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    component_id UUID NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    entry_point_id VARCHAR(255) NOT NULL,
    type VARCHAR(100) NOT NULL,
    path TEXT NOT NULL,
    methods JSONB DEFAULT '[]',
    description TEXT,
    parameters JSONB DEFAULT '[]',
    response_schema JSONB,
    middleware JSONB DEFAULT '[]',
    authentication_required BOOLEAN DEFAULT false,
    authentication_type VARCHAR(50),
    rate_limit_requests INTEGER,
    rate_limit_window VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(analysis_run_id, entry_point_id),
    CONSTRAINT entry_points_type_valid CHECK (type IN ('http_endpoint', 'websocket', 'cli_command', 'event_handler', 'scheduler', 'queue_consumer', 'webhook', 'grpc_service'))
);

-- Exit points (external integrations)
CREATE TABLE exit_points (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    component_id UUID NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    exit_point_id VARCHAR(255) NOT NULL,
    type VARCHAR(100) NOT NULL,
    destination TEXT NOT NULL,
    description TEXT,
    is_critical BOOLEAN DEFAULT false,
    authentication_type VARCHAR(50),
    error_handling JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(analysis_run_id, exit_point_id),
    CONSTRAINT exit_points_type_valid CHECK (type IN ('database_query', 'external_api', 'message_publish', 'file_operation', 'cache_operation', 'email_send', 'sms_send', 'webhook_call', 'log_write'))
);

-- Risk assessments
CREATE TABLE risk_areas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    component_id UUID NOT NULL REFERENCES components(id) ON DELETE CASCADE,
    risk_level VARCHAR(20) NOT NULL,
    reasons JSONB DEFAULT '[]',
    impact TEXT,
    mitigation_suggestions JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT risk_areas_level_valid CHECK (risk_level IN ('low', 'medium', 'high', 'critical'))
);

-- =============================================================================
-- FRAMEWORK AND DEPENDENCY TRACKING
-- =============================================================================

-- Technology stack analysis
CREATE TABLE technology_stacks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    primary_framework VARCHAR(255),
    primary_framework_version VARCHAR(100),
    languages JSONB DEFAULT '[]',
    frameworks JSONB DEFAULT '[]',
    build_tools JSONB DEFAULT '[]',
    testing_frameworks JSONB DEFAULT '[]',
    databases JSONB DEFAULT '[]',
    message_queues JSONB DEFAULT '[]',
    caching_systems JSONB DEFAULT '[]',
    authentication_methods JSONB DEFAULT '[]',
    deployment_platforms JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(analysis_run_id)
);

-- Dependencies
CREATE TABLE dependencies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    version VARCHAR(100),
    type VARCHAR(50) NOT NULL,
    license VARCHAR(100),
    size_bytes BIGINT,
    is_directly_used BOOLEAN DEFAULT true,
    usage_locations JSONB DEFAULT '[]',
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(analysis_run_id, name, type),
    CONSTRAINT dependencies_type_valid CHECK (type IN ('production', 'development', 'peer'))
);

-- Security vulnerabilities in dependencies
CREATE TABLE security_vulnerabilities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    dependency_id UUID NOT NULL REFERENCES dependencies(id) ON DELETE CASCADE,
    severity VARCHAR(20) NOT NULL,
    description TEXT NOT NULL,
    cve_id VARCHAR(50),
    fix_available BOOLEAN DEFAULT false,
    recommended_version VARCHAR(100),
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE,
    
    CONSTRAINT vulnerabilities_severity_valid CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

-- =============================================================================
-- TEST COVERAGE AND QUALITY METRICS
-- =============================================================================

-- Test coverage information
CREATE TABLE test_coverage (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    component_id UUID REFERENCES components(id) ON DELETE CASCADE,
    coverage_type VARCHAR(50) NOT NULL,
    overall_percentage NUMERIC(5,2),
    lines_covered INTEGER,
    lines_total INTEGER,
    functions_covered INTEGER,
    functions_total INTEGER,
    branches_covered INTEGER,
    branches_total INTEGER,
    test_files JSONB DEFAULT '[]',
    uncovered_lines JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT coverage_type_valid CHECK (coverage_type IN ('unit', 'integration', 'e2e', 'overall')),
    CONSTRAINT coverage_percentage_range CHECK (overall_percentage >= 0 AND overall_percentage <= 100)
);

-- Testing frameworks and configuration
CREATE TABLE testing_info (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    framework_name VARCHAR(255) NOT NULL,
    framework_version VARCHAR(100),
    framework_type VARCHAR(50) NOT NULL,
    config_file VARCHAR(500),
    total_tests INTEGER DEFAULT 0,
    passing_tests INTEGER DEFAULT 0,
    failing_tests INTEGER DEFAULT 0,
    test_files JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT testing_framework_type_valid CHECK (framework_type IN ('unit', 'integration', 'e2e', 'performance', 'visual'))
);

-- =============================================================================
-- REAL-TIME TELEMETRY INFRASTRUCTURE
-- =============================================================================

-- Telemetry data points (high-volume, partitioned table)
CREATE TABLE telemetry_events (
    id UUID DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    component_id VARCHAR(255), -- Links to components.component_id
    event_type VARCHAR(100) NOT NULL,
    event_name VARCHAR(255) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    duration_ms INTEGER,
    status VARCHAR(50),
    error_message TEXT,
    user_id VARCHAR(255),
    session_id VARCHAR(255),
    request_id VARCHAR(255),
    trace_id VARCHAR(255),
    span_id VARCHAR(255),
    parent_span_id VARCHAR(255),
    tags JSONB DEFAULT '{}',
    metrics JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT telemetry_events_type_valid CHECK (event_type IN ('http_request', 'function_call', 'database_query', 'external_api', 'error', 'performance', 'user_action', 'system_metric'))
) PARTITION BY RANGE (timestamp);

-- Performance metrics aggregated by time windows
CREATE TABLE performance_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    component_id VARCHAR(255),
    metric_name VARCHAR(255) NOT NULL,
    metric_type VARCHAR(50) NOT NULL,
    time_window VARCHAR(20) NOT NULL, -- '1m', '5m', '1h', '1d'
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    window_end TIMESTAMP WITH TIME ZONE NOT NULL,
    value_avg NUMERIC(15,6),
    value_min NUMERIC(15,6),
    value_max NUMERIC(15,6),
    value_sum NUMERIC(15,6),
    value_count BIGINT,
    percentile_50 NUMERIC(15,6),
    percentile_95 NUMERIC(15,6),
    percentile_99 NUMERIC(15,6),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(project_id, component_id, metric_name, time_window, window_start),
    CONSTRAINT metrics_type_valid CHECK (metric_type IN ('counter', 'gauge', 'histogram', 'timer')),
    CONSTRAINT metrics_window_valid CHECK (time_window IN ('1m', '5m', '15m', '1h', '6h', '1d', '7d'))
);

-- Error tracking and aggregation
CREATE TABLE error_tracking (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    component_id VARCHAR(255),
    error_hash VARCHAR(64) NOT NULL, -- Hash of error signature for grouping
    error_type VARCHAR(255) NOT NULL,
    error_message TEXT NOT NULL,
    stack_trace TEXT,
    first_seen TIMESTAMP WITH TIME ZONE NOT NULL,
    last_seen TIMESTAMP WITH TIME ZONE NOT NULL,
    occurrence_count BIGINT DEFAULT 1,
    status VARCHAR(50) DEFAULT 'active',
    assigned_to UUID REFERENCES users(id),
    resolved_at TIMESTAMP WITH TIME ZONE,
    tags JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(project_id, error_hash),
    CONSTRAINT error_status_valid CHECK (status IN ('active', 'resolved', 'ignored', 'investigating'))
);

-- =============================================================================
-- BILLING AND SUBSCRIPTION MANAGEMENT
-- =============================================================================

-- Subscription plans
CREATE TABLE subscription_plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    price_cents INTEGER NOT NULL,
    billing_interval VARCHAR(20) NOT NULL,
    max_projects INTEGER,
    max_team_members INTEGER,
    max_telemetry_events_per_month BIGINT,
    features JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT billing_interval_valid CHECK (billing_interval IN ('monthly', 'yearly')),
    CONSTRAINT price_positive CHECK (price_cents >= 0)
);

-- Organization subscriptions
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES subscription_plans(id),
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    cancel_at_period_end BOOLEAN DEFAULT false,
    trial_start TIMESTAMP WITH TIME ZONE,
    trial_end TIMESTAMP WITH TIME ZONE,
    stripe_subscription_id VARCHAR(255),
    stripe_customer_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT subscription_status_valid CHECK (status IN ('active', 'past_due', 'canceled', 'unpaid', 'trialing'))
);

-- Usage tracking for billing
CREATE TABLE usage_tracking (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    metric_name VARCHAR(100) NOT NULL,
    metric_value BIGINT NOT NULL DEFAULT 0,
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(organization_id, metric_name, period_start),
    CONSTRAINT usage_metrics_valid CHECK (metric_name IN ('projects', 'team_members', 'telemetry_events', 'analysis_runs', 'storage_mb'))
);

-- =============================================================================
-- API KEYS AND AUTHENTICATION
-- =============================================================================

-- API keys for telemetry collection
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    key_prefix VARCHAR(20) NOT NULL,
    scopes JSONB DEFAULT '[]',
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT api_key_scopes_valid CHECK (
        scopes::jsonb <@ '["telemetry:write", "telemetry:read", "analysis:read", "projects:read"]'::jsonb
    )
);

-- Authentication sessions
CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- INDEXES FOR PERFORMANCE
-- =============================================================================

-- Organizations and teams
CREATE INDEX idx_organizations_slug ON organizations(slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_teams_org_slug ON teams(organization_id, slug);
CREATE INDEX idx_memberships_user_org ON memberships(user_id, organization_id);
CREATE INDEX idx_memberships_org_team ON memberships(organization_id, team_id);

-- Projects and analysis
CREATE INDEX idx_projects_org ON projects(organization_id);
CREATE INDEX idx_projects_team ON projects(team_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_analysis_runs_project ON analysis_runs(project_id);
CREATE INDEX idx_analysis_runs_status ON analysis_runs(status);
CREATE INDEX idx_analysis_runs_completed ON analysis_runs(completed_at DESC) WHERE status = 'completed';

-- Components and relationships
CREATE INDEX idx_components_analysis_run ON components(analysis_run_id);
CREATE INDEX idx_components_type ON components(type);
CREATE INDEX idx_components_layer ON components(architectural_layer);
CREATE INDEX idx_components_entry_orphaned ON components(is_entry_point, is_orphaned);
CREATE INDEX idx_functions_component ON functions(component_id);
CREATE INDEX idx_function_calls_caller ON function_calls(caller_function_id);
CREATE INDEX idx_function_calls_called ON function_calls(called_function_id);
CREATE INDEX idx_connections_analysis ON connections(analysis_run_id);
CREATE INDEX idx_connections_from_to ON connections(from_component_id, to_component_id);
CREATE INDEX idx_connections_type ON connections(connection_type);

-- Entry and exit points
CREATE INDEX idx_entry_points_analysis ON entry_points(analysis_run_id);
CREATE INDEX idx_entry_points_component ON entry_points(component_id);
CREATE INDEX idx_entry_points_type ON entry_points(type);
CREATE INDEX idx_exit_points_analysis ON exit_points(analysis_run_id);
CREATE INDEX idx_exit_points_component ON exit_points(component_id);
CREATE INDEX idx_exit_points_critical ON exit_points(is_critical) WHERE is_critical = true;

-- Dependencies and security
CREATE INDEX idx_dependencies_analysis ON dependencies(analysis_run_id);
CREATE INDEX idx_dependencies_name_type ON dependencies(name, type);
CREATE INDEX idx_vulnerabilities_dependency ON security_vulnerabilities(dependency_id);
CREATE INDEX idx_vulnerabilities_severity ON security_vulnerabilities(severity);
CREATE INDEX idx_vulnerabilities_unresolved ON security_vulnerabilities(detected_at DESC) WHERE resolved_at IS NULL;

-- Test coverage
CREATE INDEX idx_test_coverage_analysis ON test_coverage(analysis_run_id);
CREATE INDEX idx_test_coverage_component ON test_coverage(component_id);
CREATE INDEX idx_test_coverage_type ON test_coverage(coverage_type);

-- Telemetry (high-performance indexes for time-series data)
CREATE INDEX idx_telemetry_project_time ON telemetry_events(project_id, timestamp DESC);
CREATE INDEX idx_telemetry_component_time ON telemetry_events(component_id, timestamp DESC) WHERE component_id IS NOT NULL;
CREATE INDEX idx_telemetry_type_time ON telemetry_events(event_type, timestamp DESC);
CREATE INDEX idx_telemetry_trace ON telemetry_events(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX idx_telemetry_session ON telemetry_events(session_id) WHERE session_id IS NOT NULL;

-- Performance metrics
CREATE INDEX idx_performance_project_component ON performance_metrics(project_id, component_id, metric_name);
CREATE INDEX idx_performance_time_window ON performance_metrics(time_window, window_start DESC);

-- Error tracking
CREATE INDEX idx_errors_project_hash ON error_tracking(project_id, error_hash);
CREATE INDEX idx_errors_component ON error_tracking(component_id) WHERE component_id IS NOT NULL;
CREATE INDEX idx_errors_status ON error_tracking(status);
CREATE INDEX idx_errors_last_seen ON error_tracking(last_seen DESC) WHERE status = 'active';

-- Authentication and billing
CREATE INDEX idx_api_keys_org ON api_keys(organization_id) WHERE is_active = true;
CREATE INDEX idx_api_keys_project ON api_keys(project_id) WHERE is_active = true AND project_id IS NOT NULL;
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_sessions_expires ON user_sessions(expires_at);
CREATE INDEX idx_subscriptions_org ON subscriptions(organization_id);
CREATE INDEX idx_usage_tracking_org_period ON usage_tracking(organization_id, period_start);

-- Full-text search indexes
CREATE INDEX idx_components_name_trgm ON components USING gin(name gin_trgm_ops);
CREATE INDEX idx_components_description_trgm ON components USING gin(ai_description gin_trgm_ops);
CREATE INDEX idx_functions_name_trgm ON functions USING gin(name gin_trgm_ops);

-- =============================================================================
-- TELEMETRY PARTITIONING (for high-volume data)
-- =============================================================================

-- Create monthly partitions for telemetry_events (last 12 months)
DO $$
DECLARE
    start_date DATE;
    end_date DATE;
    partition_name TEXT;
BEGIN
    -- Create partitions for the last 12 months and next 3 months
    FOR i IN -12..3 LOOP
        start_date := DATE_TRUNC('month', CURRENT_DATE + (i || ' months')::INTERVAL);
        end_date := start_date + INTERVAL '1 month';
        partition_name := 'telemetry_events_' || TO_CHAR(start_date, 'YYYY_MM');
        
        EXECUTE format('
            CREATE TABLE IF NOT EXISTS %I PARTITION OF telemetry_events
            FOR VALUES FROM (%L) TO (%L)
        ', partition_name, start_date, end_date);
        
        -- Add indexes to each partition
        EXECUTE format('
            CREATE INDEX IF NOT EXISTS %I ON %I(project_id, timestamp DESC)
        ', 'idx_' || partition_name || '_project_time', partition_name);
        
        EXECUTE format('
            CREATE INDEX IF NOT EXISTS %I ON %I(event_type, timestamp DESC)
        ', 'idx_' || partition_name || '_type_time', partition_name);
    END LOOP;
END $$;

-- =============================================================================
-- TRIGGERS AND FUNCTIONS
-- =============================================================================

-- Update timestamps trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers to relevant tables
CREATE TRIGGER trigger_organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_teams_updated_at BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_error_tracking_updated_at BEFORE UPDATE ON error_tracking FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_subscriptions_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trigger_usage_tracking_updated_at BEFORE UPDATE ON usage_tracking FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to update usage tracking
CREATE OR REPLACE FUNCTION update_usage_tracking(
    org_id UUID,
    metric VARCHAR(100),
    increment_by BIGINT DEFAULT 1
) RETURNS VOID AS $$
DECLARE
    current_period_start TIMESTAMP WITH TIME ZONE;
    current_period_end TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Calculate current billing period (monthly)
    current_period_start := DATE_TRUNC('month', NOW());
    current_period_end := current_period_start + INTERVAL '1 month';
    
    INSERT INTO usage_tracking (organization_id, metric_name, metric_value, period_start, period_end)
    VALUES (org_id, metric, increment_by, current_period_start, current_period_end)
    ON CONFLICT (organization_id, metric_name, period_start)
    DO UPDATE SET 
        metric_value = usage_tracking.metric_value + increment_by,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Trigger to update usage when telemetry events are inserted
CREATE OR REPLACE FUNCTION track_telemetry_usage()
RETURNS TRIGGER AS $$
DECLARE
    org_id UUID;
BEGIN
    -- Get organization_id from project
    SELECT p.organization_id INTO org_id
    FROM projects p
    WHERE p.id = NEW.project_id;
    
    IF org_id IS NOT NULL THEN
        PERFORM update_usage_tracking(org_id, 'telemetry_events', 1);
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_telemetry_usage AFTER INSERT ON telemetry_events FOR EACH ROW EXECUTE FUNCTION track_telemetry_usage();

-- =============================================================================
-- SAMPLE DATA AND DEFAULT PLANS
-- =============================================================================

-- Insert default subscription plans
INSERT INTO subscription_plans (name, description, price_cents, billing_interval, max_projects, max_team_members, max_telemetry_events_per_month, features) VALUES
('Free', 'Perfect for small projects and personal use', 0, 'monthly', 3, 5, 100000, '["basic_analysis", "manual_analysis", "basic_visualization"]'),
('Starter', 'Great for small teams getting started', 2900, 'monthly', 10, 15, 1000000, '["advanced_analysis", "realtime_telemetry", "team_collaboration", "api_access"]'),
('Professional', 'For growing teams with complex projects', 9900, 'monthly', 50, 50, 10000000, '["enterprise_analysis", "advanced_telemetry", "custom_integrations", "priority_support", "security_analysis"]'),
('Enterprise', 'For large organizations with custom needs', 29900, 'monthly', NULL, NULL, NULL, '["unlimited_everything", "dedicated_support", "custom_deployment", "sla_guarantee", "advanced_security"]');

-- =============================================================================
-- SECURITY POLICIES AND ROW LEVEL SECURITY
-- =============================================================================

-- Enable RLS on tenant-isolated tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE components ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_tracking ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (example for organizations)
CREATE POLICY org_isolation_policy ON organizations
    FOR ALL
    TO authenticated_users
    USING (
        id IN (
            SELECT m.organization_id 
            FROM memberships m 
            WHERE m.user_id = current_setting('app.current_user_id')::UUID
        )
    );

-- =============================================================================
-- PERFORMANCE OPTIMIZATION
-- =============================================================================

-- Analyze tables for better query planning
ANALYZE;

-- Analyzer plugins registry
CREATE TABLE analyzer_plugins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plugin_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    version VARCHAR(50) NOT NULL,
    author VARCHAR(255),
    type VARCHAR(50) NOT NULL,
    category VARCHAR(50) NOT NULL,
    priority INTEGER DEFAULT 50,
    supported_languages JSONB DEFAULT '[]',
    supported_frameworks JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    dependencies JSONB DEFAULT '[]',
    configuration JSONB DEFAULT '{}',
    last_used_at TIMESTAMP WITH TIME ZONE,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(organization_id, plugin_id),
    CONSTRAINT plugin_type_valid CHECK (type IN ('official', 'community', 'internal')),
    CONSTRAINT plugin_category_valid CHECK (category IN ('language', 'framework', 'specialized', 'integration'))
);

CREATE INDEX idx_analyzer_plugins_org_type ON analyzer_plugins(organization_id, type);
CREATE INDEX idx_analyzer_plugins_org_enabled ON analyzer_plugins(organization_id, enabled);
CREATE INDEX idx_analyzer_plugins_languages ON analyzer_plugins USING GIN (supported_languages);
CREATE INDEX idx_analyzer_plugins_frameworks ON analyzer_plugins USING GIN (supported_frameworks);

-- Set up automatic statistics collection
ALTER SYSTEM SET track_activities = on;
ALTER SYSTEM SET track_counts = on;
ALTER SYSTEM SET track_io_timing = on;
ALTER SYSTEM SET log_statement_stats = off;

-- Configure for time-series workload
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements,auto_explain';
ALTER SYSTEM SET max_connections = 200;
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET effective_cache_size = '1GB';
ALTER SYSTEM SET work_mem = '4MB';
ALTER SYSTEM SET maintenance_work_mem = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = 0.7;
ALTER SYSTEM SET wal_buffers = '16MB';
ALTER SYSTEM SET default_statistics_target = 100;

-- Reload configuration
SELECT pg_reload_conf();