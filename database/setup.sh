#!/bin/bash

# =============================================================================
# Unravl Database Setup Script
# Sets up PostgreSQL database with proper configuration for Unravl platform
# =============================================================================

set -e  # Exit on any error

# Configuration
DB_NAME=${DB_NAME:-"unravl_dev"}
DB_USER=${DB_USER:-"unravl_user"}
DB_PASSWORD=${DB_PASSWORD:-"unravl_password_change_me"}
DB_HOST=${DB_HOST:-"localhost"}
DB_PORT=${DB_PORT:-"5432"}
POSTGRES_SUPERUSER=${POSTGRES_SUPERUSER:-"postgres"}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if PostgreSQL is running
check_postgres() {
    log_info "Checking PostgreSQL connection..."
    if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_SUPERUSER" -c "SELECT 1;" > /dev/null 2>&1; then
        log_error "Cannot connect to PostgreSQL at $DB_HOST:$DB_PORT with user $POSTGRES_SUPERUSER"
        log_error "Please ensure PostgreSQL is running and accessible"
        exit 1
    fi
    log_success "PostgreSQL connection verified"
}

# Create database and user
create_database() {
    log_info "Creating database and user..."
    
    # Create user if doesn't exist
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_SUPERUSER" -c "
        DO \$\$
        BEGIN
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_user WHERE usename = '$DB_USER') THEN
                CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
            END IF;
        END
        \$\$;
    " > /dev/null
    
    # Create database if doesn't exist
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_SUPERUSER" -c "
        SELECT 'CREATE DATABASE $DB_NAME'
        WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME');
    " | grep -q "CREATE DATABASE" && {
        psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_SUPERUSER" -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
        log_success "Database '$DB_NAME' created"
    } || log_info "Database '$DB_NAME' already exists"
    
    # Grant privileges
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_SUPERUSER" -d "$DB_NAME" -c "
        GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
        GRANT ALL ON SCHEMA public TO $DB_USER;
        GRANT CREATE ON DATABASE $DB_NAME TO $DB_USER;
    " > /dev/null
    
    log_success "User '$DB_USER' configured with appropriate privileges"
}

# Install required PostgreSQL extensions
install_extensions() {
    log_info "Installing required PostgreSQL extensions..."
    
    # List of required extensions
    extensions=(
        "uuid-ossp"
        "pgcrypto" 
        "pg_trgm"
        "btree_gin"
        "btree_gist"
    )
    
    for ext in "${extensions[@]}"; do
        log_info "Installing extension: $ext"
        psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_SUPERUSER" -d "$DB_NAME" -c "
            CREATE EXTENSION IF NOT EXISTS \"$ext\";
        " > /dev/null
    done
    
    log_success "All extensions installed successfully"
}

# Run schema creation
create_schema() {
    log_info "Creating database schema..."
    
    if [ ! -f "schema.sql" ]; then
        log_error "schema.sql file not found in current directory"
        exit 1
    fi
    
    # Run the main schema file
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "schema.sql" > /dev/null
    log_success "Schema created successfully"
}

# Install utility functions
install_functions() {
    log_info "Installing utility functions..."
    
    if [ ! -f "functions.sql" ]; then
        log_warning "functions.sql file not found, skipping function installation"
        return
    fi
    
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "functions.sql" > /dev/null
    log_success "Utility functions installed"
}

# Configure PostgreSQL for optimal performance
configure_postgres() {
    log_info "Applying performance configurations..."
    
    # Note: These are development-friendly settings
    # For production, tune these based on your hardware
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_SUPERUSER" -c "
        -- Time-series optimizations
        ALTER SYSTEM SET max_connections = 200;
        ALTER SYSTEM SET shared_buffers = '256MB';
        ALTER SYSTEM SET effective_cache_size = '1GB';
        ALTER SYSTEM SET work_mem = '4MB';
        ALTER SYSTEM SET maintenance_work_mem = '64MB';
        
        -- WAL and checkpoint settings
        ALTER SYSTEM SET checkpoint_completion_target = 0.7;
        ALTER SYSTEM SET wal_buffers = '16MB';
        
        -- Query planning
        ALTER SYSTEM SET default_statistics_target = 100;
        
        -- Monitoring
        ALTER SYSTEM SET track_activities = on;
        ALTER SYSTEM SET track_counts = on;
        ALTER SYSTEM SET track_io_timing = on;
    " > /dev/null
    
    log_success "PostgreSQL configured for Unravl workload"
    log_warning "Please restart PostgreSQL to apply configuration changes"
}

# Create initial admin user and organization
create_initial_data() {
    log_info "Creating initial admin user and organization..."
    
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" << 'EOF'
-- Create initial organization
INSERT INTO organizations (id, name, slug, description) 
VALUES (
    '00000000-0000-0000-0000-000000000001'::UUID,
    'Unravl Demo Organization', 
    'unravl-demo',
    'Default organization for Unravl development and testing'
) ON CONFLICT (slug) DO NOTHING;

-- Create initial admin user
INSERT INTO users (id, email, first_name, last_name, email_verified_at)
VALUES (
    '00000000-0000-0000-0000-000000000001'::UUID,
    'admin@unravl.dev',
    'Admin',
    'User', 
    NOW()
) ON CONFLICT (email) DO NOTHING;

-- Create admin membership
INSERT INTO memberships (user_id, organization_id, role, joined_at)
VALUES (
    '00000000-0000-0000-0000-000000000001'::UUID,
    '00000000-0000-0000-0000-000000000001'::UUID,
    'owner',
    NOW()
) ON CONFLICT (user_id, organization_id, team_id) DO NOTHING;

-- Create free plan subscription
INSERT INTO subscriptions (organization_id, plan_id, status, current_period_start, current_period_end)
VALUES (
    '00000000-0000-0000-0000-000000000001'::UUID,
    (SELECT id FROM subscription_plans WHERE name = 'Free' LIMIT 1),
    'active',
    DATE_TRUNC('month', NOW()),
    DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
) ON CONFLICT DO NOTHING;

EOF
    
    log_success "Initial admin user created (admin@unravl.dev)"
}

# Verify installation
verify_installation() {
    log_info "Verifying installation..."
    
    # Check table count
    table_count=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "
        SELECT COUNT(*) FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    " | xargs)
    
    log_info "Created $table_count tables"
    
    # Check if partitions were created
    partition_count=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "
        SELECT COUNT(*) FROM pg_tables 
        WHERE tablename LIKE 'telemetry_events_%';
    " | xargs)
    
    log_info "Created $partition_count telemetry partitions"
    
    # Check initial data
    org_count=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "
        SELECT COUNT(*) FROM organizations;
    " | xargs)
    
    user_count=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "
        SELECT COUNT(*) FROM users;
    " | xargs)
    
    plan_count=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "
        SELECT COUNT(*) FROM subscription_plans;
    " | xargs)
    
    log_success "Verification complete:"
    log_success "  - Organizations: $org_count"
    log_success "  - Users: $user_count" 
    log_success "  - Subscription plans: $plan_count"
    log_success "  - Tables: $table_count"
    log_success "  - Telemetry partitions: $partition_count"
}

# Show connection info
show_connection_info() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_success "Unravl Database Setup Complete!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Connection Details:"
    echo "  Database: $DB_NAME"
    echo "  Host: $DB_HOST"
    echo "  Port: $DB_PORT"
    echo "  User: $DB_USER"
    echo ""
    echo "Connection String:"
    echo "  postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
    echo ""
    echo "Initial Admin User:"
    echo "  Email: admin@unravl.dev"
    echo "  Organization: Unravl Demo Organization"
    echo "  Role: Owner"
    echo ""
    echo "Next Steps:"
    echo "  1. Update your application configuration with the connection details above"
    echo "  2. Restart PostgreSQL if configuration changes were applied"
    echo "  3. Run your application and create your first project!"
    echo ""
}

# Main execution
main() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔍 UNRAVL DATABASE SETUP"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # Validate environment
    if [ -z "$DB_PASSWORD" ] || [ "$DB_PASSWORD" = "unravl_password_change_me" ]; then
        log_warning "Using default password. Set DB_PASSWORD environment variable for production!"
    fi
    
    # Run setup steps
    check_postgres
    create_database
    install_extensions
    create_schema
    install_functions
    configure_postgres
    create_initial_data
    verify_installation
    show_connection_info
}

# Script options
case "${1:-setup}" in
    "setup")
        main
        ;;
    "reset")
        log_warning "Resetting database (all data will be lost)..."
        read -p "Are you sure? Type 'yes' to continue: " confirm
        if [ "$confirm" = "yes" ]; then
            psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_SUPERUSER" -c "DROP DATABASE IF EXISTS $DB_NAME;"
            log_info "Database dropped, running setup..."
            main
        else
            log_info "Reset cancelled"
        fi
        ;;
    "verify")
        verify_installation
        ;;
    "help"|"-h"|"--help")
        echo "Unravl Database Setup Script"
        echo ""
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  setup    Create database and schema (default)"
        echo "  reset    Drop and recreate database"
        echo "  verify   Verify installation"
        echo "  help     Show this help"
        echo ""
        echo "Environment Variables:"
        echo "  DB_NAME            Database name (default: unravl_dev)"
        echo "  DB_USER            Database user (default: unravl_user)" 
        echo "  DB_PASSWORD        Database password (required)"
        echo "  DB_HOST            Database host (default: localhost)"
        echo "  DB_PORT            Database port (default: 5432)"
        echo "  POSTGRES_SUPERUSER Postgres admin user (default: postgres)"
        ;;
    *)
        log_error "Unknown command: $1"
        echo "Run '$0 help' for usage information"
        exit 1
        ;;
esac