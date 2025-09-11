-- =============================================================================
-- MIGRATION 001: Create Initial Unravl Schema
-- Description: Initial database schema creation with all core tables
-- Author: System
-- Date: 2024-01-15
-- =============================================================================

-- Migration metadata
INSERT INTO schema_migrations (version, name, applied_at) 
VALUES ('001', 'create_initial_schema', NOW())
ON CONFLICT (version) DO NOTHING;

-- This migration creates the complete initial schema
-- The actual schema creation is in ../schema.sql

-- Verify core tables were created
DO $$
DECLARE
    missing_tables TEXT[];
    expected_tables TEXT[] := ARRAY[
        'organizations', 'teams', 'users', 'memberships',
        'projects', 'analysis_runs', 'components', 'functions',
        'connections', 'entry_points', 'exit_points', 'risk_areas',
        'dependencies', 'security_vulnerabilities', 'test_coverage',
        'telemetry_events', 'performance_metrics', 'error_tracking',
        'subscription_plans', 'subscriptions', 'usage_tracking',
        'api_keys', 'user_sessions'
    ];
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY expected_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name = table_name
        ) THEN
            missing_tables := missing_tables || table_name;
        END IF;
    END LOOP;
    
    IF array_length(missing_tables, 1) > 0 THEN
        RAISE EXCEPTION 'Missing tables after migration: %', array_to_string(missing_tables, ', ');
    END IF;
    
    RAISE NOTICE 'Migration 001 completed successfully - all % tables created', array_length(expected_tables, 1);
END $$;