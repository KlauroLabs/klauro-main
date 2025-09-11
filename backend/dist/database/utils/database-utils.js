"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tableExists = tableExists;
exports.columnExists = columnExists;
exports.getDatabaseVersion = getDatabaseVersion;
exports.getDatabaseSize = getDatabaseSize;
exports.getTableStats = getTableStats;
exports.getConnectionStats = getConnectionStats;
exports.performMaintenance = performMaintenance;
exports.validateSchemaIntegrity = validateSchemaIntegrity;
exports.createBackup = createBackup;
exports.escapeIdentifier = escapeIdentifier;
exports.escapeStringLiteral = escapeStringLiteral;
exports.buildWhereClause = buildWhereClause;
const connection_1 = __importDefault(require("../connection"));
async function tableExists(tableName, schema = 'public') {
    try {
        const result = await connection_1.default.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = $1 AND table_name = $2
      ) as exists
    `, [schema, tableName]);
        return result.rows[0].exists;
    }
    catch (error) {
        console.error(`Error checking if table ${tableName} exists:`, error);
        return false;
    }
}
async function columnExists(tableName, columnName, schema = 'public') {
    try {
        const result = await connection_1.default.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
      ) as exists
    `, [schema, tableName, columnName]);
        return result.rows[0].exists;
    }
    catch (error) {
        console.error(`Error checking if column ${columnName} exists in table ${tableName}:`, error);
        return false;
    }
}
async function getDatabaseVersion() {
    try {
        const result = await connection_1.default.query('SELECT version() as version');
        const versionString = result.rows[0].version;
        const versionMatch = versionString.match(/PostgreSQL (\d+)\.(\d+)(?:\.(\d+))?/);
        if (versionMatch) {
            return {
                version: versionString,
                major: parseInt(versionMatch[1]),
                minor: parseInt(versionMatch[2]),
                patch: parseInt(versionMatch[3] || '0'),
            };
        }
        return {
            version: versionString,
            major: 0,
            minor: 0,
            patch: 0,
        };
    }
    catch (error) {
        console.error('Error getting database version:', error);
        throw error;
    }
}
async function getDatabaseSize() {
    try {
        const result = await connection_1.default.query(`
      SELECT 
        pg_database_size(current_database()) as size_bytes,
        pg_size_pretty(pg_database_size(current_database())) as size_pretty
    `);
        return {
            size_bytes: parseInt(result.rows[0].size_bytes),
            size_pretty: result.rows[0].size_pretty,
        };
    }
    catch (error) {
        console.error('Error getting database size:', error);
        throw error;
    }
}
async function getTableStats() {
    try {
        const result = await connection_1.default.query(`
      SELECT 
        schemaname,
        tablename as table_name,
        n_live_tup::bigint as row_count,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
        pg_size_pretty(pg_indexes_size(schemaname||'.'||tablename)) as index_size,
        pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size
      FROM pg_stat_user_tables 
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
      LIMIT 20
    `);
        return result.rows;
    }
    catch (error) {
        console.error('Error getting table statistics:', error);
        throw error;
    }
}
async function getConnectionStats() {
    try {
        const [connectionsResult, maxConnectionsResult, stateResult] = await Promise.all([
            connection_1.default.query(`
        SELECT 
          count(*) as total_connections,
          count(*) filter (where state = 'active') as active_connections,
          count(*) filter (where state = 'idle') as idle_connections
        FROM pg_stat_activity
        WHERE pid != pg_backend_pid()
      `),
            connection_1.default.query('SHOW max_connections'),
            connection_1.default.query(`
        SELECT 
          state,
          count(*) as count
        FROM pg_stat_activity
        WHERE pid != pg_backend_pid()
        GROUP BY state
        ORDER BY count DESC
      `)
        ]);
        const connections = connectionsResult.rows[0];
        const maxConnections = parseInt(maxConnectionsResult.rows[0].max_connections);
        const usagePercentage = (connections.total_connections / maxConnections) * 100;
        return {
            total_connections: parseInt(connections.total_connections),
            active_connections: parseInt(connections.active_connections),
            idle_connections: parseInt(connections.idle_connections),
            max_connections: maxConnections,
            usage_percentage: Math.round(usagePercentage * 100) / 100,
            connections_by_state: stateResult.rows.map(row => ({
                state: row.state || 'unknown',
                count: parseInt(row.count),
            })),
        };
    }
    catch (error) {
        console.error('Error getting connection statistics:', error);
        throw error;
    }
}
async function performMaintenance() {
    const startTime = Date.now();
    const tasksCompleted = [];
    const errors = [];
    try {
        await connection_1.default.query('ANALYZE');
        tasksCompleted.push('Updated table statistics (ANALYZE)');
        try {
            await connection_1.default.query('SELECT apply_retention_policies()');
            tasksCompleted.push('Applied data retention policies');
        }
        catch (error) {
            errors.push(`Retention policies: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
            await connection_1.default.query('SELECT refresh_telemetry_views()');
            tasksCompleted.push('Refreshed telemetry materialized views');
        }
        catch (error) {
            errors.push(`Materialized views: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
            const result = await connection_1.default.query('SELECT manage_telemetry_partitions()');
            if (result.rows[0].manage_telemetry_partitions.trim()) {
                tasksCompleted.push('Managed telemetry partitions');
            }
        }
        catch (error) {
            errors.push(`Partition management: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    catch (error) {
        errors.push(`General maintenance error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
        tasks_completed: tasksCompleted,
        errors,
        duration_ms: Date.now() - startTime,
    };
}
async function validateSchemaIntegrity() {
    const issues = [];
    try {
        const expectedTables = [
            'organizations', 'teams', 'users', 'memberships',
            'projects', 'analysis_runs', 'components', 'connections',
            'telemetry_events', 'subscription_plans', 'subscriptions'
        ];
        for (const table of expectedTables) {
            const exists = await tableExists(table);
            if (!exists) {
                issues.push(`Missing core table: ${table}`);
            }
        }
        const [tableCount, indexCount, constraintCount] = await Promise.all([
            connection_1.default.query(`
        SELECT COUNT(*) as count 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `),
            connection_1.default.query(`
        SELECT COUNT(*) as count 
        FROM pg_indexes 
        WHERE schemaname = 'public'
      `),
            connection_1.default.query(`
        SELECT COUNT(*) as count 
        FROM information_schema.table_constraints 
        WHERE table_schema = 'public'
      `)
        ]);
        try {
            const orphanChecks = [
                { table: 'projects', column: 'organization_id', reference: 'organizations' },
                { table: 'memberships', column: 'organization_id', reference: 'organizations' },
                { table: 'memberships', column: 'user_id', reference: 'users' },
            ];
            for (const check of orphanChecks) {
                const result = await connection_1.default.query(`
          SELECT COUNT(*) as count
          FROM ${check.table}
          WHERE ${check.column} NOT IN (SELECT id FROM ${check.reference})
        `);
                const orphanCount = parseInt(result.rows[0].count);
                if (orphanCount > 0) {
                    issues.push(`Found ${orphanCount} orphaned records in ${check.table}.${check.column}`);
                }
            }
        }
        catch (error) {
            issues.push(`Error checking referential integrity: ${error instanceof Error ? error.message : String(error)}`);
        }
        return {
            is_valid: issues.length === 0,
            issues,
            table_count: parseInt(tableCount.rows[0].count),
            index_count: parseInt(indexCount.rows[0].count),
            constraint_count: parseInt(constraintCount.rows[0].count),
        };
    }
    catch (error) {
        issues.push(`Schema validation error: ${error instanceof Error ? error.message : String(error)}`);
        return {
            is_valid: false,
            issues,
            table_count: 0,
            index_count: 0,
            constraint_count: 0,
        };
    }
}
async function createBackup(includeData = true) {
    try {
        const [dbSize, tableCount] = await Promise.all([
            getDatabaseSize(),
            connection_1.default.query(`
        SELECT COUNT(*) as count 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `)
        ]);
        const schemaResult = await connection_1.default.query(`
      SELECT 
        'CREATE TABLE ' || schemaname || '.' || tablename || ' (' ||
        string_agg(column_name || ' ' || data_type, ', ') || ');' as create_statement
      FROM information_schema.tables t
      JOIN information_schema.columns c ON t.table_name = c.table_name
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      GROUP BY schemaname, tablename
    `);
        let dataCommands = '';
        if (includeData) {
            dataCommands = '-- Data export would be generated here using pg_dump or similar tool';
        }
        return {
            backup_info: {
                timestamp: new Date(),
                database_name: process.env.DATABASE_NAME || 'unknown',
                database_size: dbSize.size_pretty,
                table_count: parseInt(tableCount.rows[0].count),
            },
            sql_commands: {
                schema: schemaResult.rows.map(row => row.create_statement).join('\n'),
                data: includeData ? dataCommands : undefined,
            }
        };
    }
    catch (error) {
        console.error('Error creating backup:', error);
        throw error;
    }
}
function escapeIdentifier(identifier) {
    return '"' + identifier.replace(/"/g, '""') + '"';
}
function escapeStringLiteral(literal) {
    return "'" + literal.replace(/'/g, "''") + "'";
}
function buildWhereClause(filters, startIndex = 1) {
    const conditions = [];
    const params = [];
    let paramIndex = startIndex;
    filters.forEach(filter => {
        switch (filter.operator) {
            case 'IN':
                if (filter.values && filter.values.length > 0) {
                    const placeholders = filter.values.map(() => `$${paramIndex++}`).join(', ');
                    conditions.push(`${filter.field} IN (${placeholders})`);
                    params.push(...filter.values);
                }
                break;
            case 'BETWEEN':
                if (filter.values && filter.values.length >= 2) {
                    conditions.push(`${filter.field} BETWEEN $${paramIndex++} AND $${paramIndex++}`);
                    params.push(filter.values[0], filter.values[1]);
                }
                break;
            default:
                conditions.push(`${filter.field} ${filter.operator} $${paramIndex++}`);
                params.push(filter.value);
                break;
        }
    });
    return {
        clause: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
        params
    };
}
