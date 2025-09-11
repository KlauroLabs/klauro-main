# Unravl Database Schema Documentation

## Overview

This directory contains the complete PostgreSQL database infrastructure for the Unravl platform, including schema definitions, migrations, configuration, and utilities for production-ready deployment.

## 🏗️ Architecture Overview

The database is designed for:
- **Multi-tenant SaaS** with row-level security
- **High-volume telemetry data** with time-series partitioning
- **Complex architectural analysis** with graph relationships
- **Enterprise billing** and usage tracking
- **Real-time performance monitoring**

## 📁 Directory Structure

```
database/
├── README.md                    # This file
├── schema.sql                   # Complete database schema
├── functions.sql               # Stored procedures and utilities
├── setup.sh                   # Database setup script
├── config/
│   ├── postgresql.conf         # Optimized PostgreSQL settings
│   └── pooling.conf           # PgBouncer connection pooling
├── migrations/
│   ├── 001_initial_schema.sql  # Initial schema creation
│   └── 002_add_telemetry_tables.sql  # Telemetry optimization
└── seeds/
    └── development-data.sql    # Realistic test data
```

## 🚀 Quick Start

### 1. Prerequisites

- PostgreSQL 14+ installed and running
- Sufficient permissions to create databases and users
- PgBouncer (optional, for production connection pooling)

### 2. Environment Setup

```bash
# Set environment variables
export DB_NAME="unravl_dev"
export DB_USER="unravl_user" 
export DB_PASSWORD="your_secure_password"
export DB_HOST="localhost"
export DB_PORT="5432"
```

### 3. Database Setup

```bash
# Navigate to database directory
cd database/

# Run setup script (creates database, user, schema)
./setup.sh

# Load development seed data (optional)
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f seeds/development-data.sql
```

### 4. Verify Installation

```bash
# Check tables were created
./setup.sh verify

# Test connection
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "SELECT COUNT(*) FROM organizations;"
```

## Architecture Principles

### 1. Multi-Tenant Architecture
- **Organization-based isolation**: All data is partitioned by organization
- **Team-based collaboration**: Teams provide sub-organization grouping
- **Row-Level Security (RLS)**: Automatic data isolation at the database level
- **Hierarchical permissions**: Owner → Admin → Member → Viewer roles

### 2. Time-Series Optimization
- **Partitioned telemetry**: Monthly partitions for high-volume event data
- **Aggregated metrics**: Pre-computed performance windows (1m, 5m, 1h, 1d)
- **Efficient indexes**: Time-based and composite indexes for fast queries
- **Automatic cleanup**: Configurable retention policies

### 3. Analysis Versioning
- **Snapshot architecture**: Each analysis run creates a complete snapshot
- **Immutable history**: Historical analysis results are preserved
- **Component lineage**: Track how components change over time
- **Branched analysis**: Support for analyzing different branches/commits

## Core Entity Relationships

```
Organizations (Tenant Root)
├── Teams (Optional grouping)
├── Projects (Repositories)
│   └── Analysis Runs (Snapshots)
│       ├── Components (Code elements)
│       ├── Connections (Relationships)
│       ├── Entry Points (System interfaces)
│       ├── Exit Points (External integrations)
│       └── Risk Areas (Quality assessments)
├── Subscriptions (Billing)
└── Usage Tracking (Metrics)
```

## Key Tables and Design Decisions

### Core Multi-Tenancy (`organizations`, `teams`, `users`, `memberships`)

**Design Rationale:**
- Organizations are the primary tenant boundary
- Teams are optional for large organizations
- Users can belong to multiple organizations
- Flexible role-based access control

**Performance Considerations:**
- All tenant-scoped queries include organization_id
- RLS policies enforce automatic data isolation
- Indexes on organization_id for all major tables

### Repository Analysis (`projects`, `analysis_runs`, `components`)

**Design Rationale:**
- Projects represent Git repositories
- Analysis runs are immutable snapshots
- Components capture individual code elements
- Rich metadata supports AI-generated insights

**Unique Features:**
- `component_id` for stable cross-run identification
- `architectural_layer` for layered architecture views
- JSONB fields for flexible framework-specific data
- Position coordinates for spatial visualization

### Function-Level Analysis (`functions`, `function_calls`)

**Design Rationale:**
- Capture fine-grained code structure
- Support call graph visualization
- Enable complexity analysis

**Performance:**
- Efficient parent-child relationships
- Indexes on frequently queried paths

### Telemetry Infrastructure (`telemetry_events`, `performance_metrics`)

**Design Rationale:**
- High-volume time-series data requires partitioning
- Pre-aggregated metrics for dashboard performance
- Flexible event structure via JSONB

**Scaling Strategy:**
```sql
-- Monthly partitioning handles 100M+ events
-- Automatic partition creation and cleanup
-- Compressed historical partitions
-- Optimized indexes per partition
```

### Error Tracking (`error_tracking`)

**Design Rationale:**
- Group similar errors by hash for deduplication
- Track error lifecycle (active → investigating → resolved)
- Link to specific components and analysis runs

## Performance Optimizations

### Indexing Strategy

1. **Tenant Isolation**: Every multi-tenant table has `(organization_id, ...)` indexes
2. **Time-Series**: Descending timestamp indexes for recent data access
3. **Full-Text Search**: GIN indexes with trigram similarity for component/function search
4. **Composite Indexes**: Multi-column indexes for common query patterns

### Query Patterns

```sql
-- Efficient tenant-scoped queries
SELECT * FROM projects 
WHERE organization_id = $1 AND status = 'active'
ORDER BY last_analyzed_at DESC;

-- Time-windowed telemetry aggregation  
SELECT component_id, 
       AVG(duration_ms) as avg_duration,
       COUNT(*) as request_count
FROM telemetry_events 
WHERE project_id = $1 
  AND timestamp >= NOW() - INTERVAL '1 hour'
  AND event_type = 'http_request'
GROUP BY component_id;

-- Cross-run component evolution
SELECT ar.commit_sha, c.complexity, c.test_coverage
FROM components c
JOIN analysis_runs ar ON c.analysis_run_id = ar.id
WHERE ar.project_id = $1 
  AND c.component_id = $2
ORDER BY ar.completed_at DESC;
```

### Partitioning Strategy

**Telemetry Events Partitioning:**
- Monthly partitions based on timestamp
- Automatic partition creation/cleanup
- Partition-wise joins for better performance
- Parallel query execution across partitions

## Billing and Usage Tracking

### Usage Metrics Tracked:
- `telemetry_events`: Real-time event volume
- `projects`: Number of active repositories
- `team_members`: Organization seat count  
- `analysis_runs`: Monthly analysis quota
- `storage_mb`: Data storage consumption

### Billing Integration:
- Stripe subscription management
- Real-time usage enforcement
- Automated billing cycle processing
- Overage handling and notifications

## Security Considerations

### Row-Level Security (RLS)
```sql
-- Automatic tenant isolation
CREATE POLICY org_isolation_policy ON projects
    FOR ALL TO authenticated_users  
    USING (
        organization_id IN (
            SELECT organization_id FROM memberships 
            WHERE user_id = current_setting('app.current_user_id')::UUID
        )
    );
```

### API Security
- Scoped API keys per project/organization
- Rate limiting at the database level
- Audit logging for sensitive operations
- Encrypted sensitive data (passwords, API keys)

## Scaling Considerations

### Horizontal Scaling
- Read replicas for analytical queries
- Connection pooling for high concurrency
- Cached aggregations for dashboard performance

### Data Lifecycle Management
```sql
-- Automatic telemetry data retention
DELETE FROM telemetry_events 
WHERE timestamp < NOW() - INTERVAL '90 days';

-- Archive old analysis runs
UPDATE analysis_runs SET status = 'archived'
WHERE completed_at < NOW() - INTERVAL '1 year';
```

### High Availability
- Streaming replication setup
- Point-in-time recovery configuration
- Automated failover procedures

## Common Operations

### Adding a New Project
```sql
-- 1. Create project
INSERT INTO projects (organization_id, name, repository_url) 
VALUES ($1, $2, $3);

-- 2. Update usage tracking
SELECT update_usage_tracking($1, 'projects', 1);
```

### Recording Analysis Results
```sql
-- 1. Create analysis run
INSERT INTO analysis_runs (project_id, triggered_by, commit_sha)
VALUES ($1, $2, $3) RETURNING id;

-- 2. Insert components (batch operation)
INSERT INTO components (analysis_run_id, component_id, name, type, ...)
VALUES ... (batch insert);

-- 3. Insert connections (batch operation)  
INSERT INTO connections (analysis_run_id, from_component_id, to_component_id, ...)
VALUES ... (batch insert);
```

### Telemetry Ingestion
```sql
-- High-volume insert with automatic partitioning
INSERT INTO telemetry_events (
    project_id, component_id, event_type, event_name,
    timestamp, duration_ms, status, tags, metrics
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);

-- Automatic usage tracking via triggers
-- Performance metrics aggregation via background job
```

## Monitoring and Maintenance

### Key Metrics to Monitor:
- Telemetry ingestion rate and partition sizes
- Query performance on analysis and components tables
- Usage tracking accuracy vs. actual consumption
- RLS policy performance impact

### Regular Maintenance:
- `VACUUM` and `ANALYZE` on high-churn tables
- Partition pruning for old telemetry data
- Index usage analysis and optimization
- Connection pool sizing adjustments

## Migration and Deployment

### Initial Setup:
1. Run `schema.sql` to create all tables and indexes
2. Configure connection pooling (PgBouncer recommended)
3. Set up monitoring (pg_stat_statements, auto_explain)
4. Configure automated backups and replication

### Schema Updates:
- Use migration scripts with proper rollback procedures
- Test on staging environment with production data volume
- Consider index creation with `CONCURRENTLY` option
- Plan for zero-downtime deployments

This schema supports Unravl's vision of creating living, interactive architecture visualizations by efficiently storing both static analysis results and real-time operational data, while maintaining the multi-tenant isolation and performance characteristics needed for a SaaS platform.