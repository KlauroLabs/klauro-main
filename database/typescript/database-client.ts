/**
 * Database Client
 * Main database connection and repository factory
 * Provides centralized database access with connection pooling and transaction support
 */

import { Pool, PoolConfig, PoolClient } from 'pg';
import { AnalyzerRepository } from './repositories/analyzer-repository';
import { TelemetryRepository } from './repositories/telemetry-repository';

export interface DatabaseConfig extends PoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | object;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  maxUses?: number;
  application_name?: string;
}

export interface TransactionCallback<T> {
  (client: PoolClient): Promise<T>;
}

export interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  connectionCount?: number;
  error?: string;
}

export class DatabaseClient {
  private pool: Pool;
  private _analyzerRepository?: AnalyzerRepository;
  private _telemetryRepository?: TelemetryRepository;
  private isShuttingDown = false;

  constructor(config: DatabaseConfig) {
    // Configure connection pool with optimizations for time-series workload
    const poolConfig: PoolConfig = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      max: config.max || 20, // Maximum pool size
      idleTimeoutMillis: config.idleTimeoutMillis || 30000, // 30 seconds
      connectionTimeoutMillis: config.connectionTimeoutMillis || 10000, // 10 seconds
      maxUses: config.maxUses || 7500, // Recycle connections after 7500 uses
      application_name: config.application_name || 'unravl-platform',
      
      // Additional PostgreSQL-specific optimizations
      statement_timeout: 300000, // 5 minutes
      query_timeout: 60000, // 1 minute
      
      // Connection pool events
      log: (message: string, level: string) => {
        if (level === 'error') {
          console.error(`Database Pool Error: ${message}`);
        }
      }
    };

    this.pool = new Pool(poolConfig);
    this.setupPoolEventHandlers();
  }

  private setupPoolEventHandlers(): void {
    this.pool.on('connect', (client: PoolClient) => {
      console.log('New database client connected');
      
      // Configure session parameters for optimal performance
      client.query(`
        SET timezone TO 'UTC';
        SET statement_timeout TO '300s';
        SET lock_timeout TO '30s';
        SET idle_in_transaction_session_timeout TO '60s';
        SET search_path TO public;
      `).catch(err => {
        console.error('Failed to configure client session:', err);
      });
    });

    this.pool.on('acquire', (client: PoolClient) => {
      // console.log('Database client acquired from pool');
    });

    this.pool.on('release', (client: PoolClient) => {
      // console.log('Database client released back to pool');
    });

    this.pool.on('remove', (client: PoolClient) => {
      console.log('Database client removed from pool');
    });

    this.pool.on('error', (err: Error, client: PoolClient) => {
      console.error('Database pool error:', err);
      console.error('Client:', client);
    });
  }

  // =============================================================================
  // REPOSITORY ACCESS
  // =============================================================================

  get analyzer(): AnalyzerRepository {
    if (!this._analyzerRepository) {
      this._analyzerRepository = new AnalyzerRepository(this.pool);
    }
    return this._analyzerRepository;
  }

  get telemetry(): TelemetryRepository {
    if (!this._telemetryRepository) {
      this._telemetryRepository = new TelemetryRepository(this.pool);
    }
    return this._telemetryRepository;
  }

  // =============================================================================
  // DIRECT QUERY ACCESS
  // =============================================================================

  async query(text: string, params?: any[]): Promise<any> {
    if (this.isShuttingDown) {
      throw new Error('Database is shutting down');
    }

    const start = Date.now();
    const client = await this.pool.connect();
    
    try {
      const result = await client.query(text, params);
      const duration = Date.now() - start;
      
      // Log slow queries (> 1 second)
      if (duration > 1000) {
        console.warn(`Slow query executed in ${duration}ms:`, {
          query: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
          params: params?.length ? `${params.length} parameters` : 'no parameters'
        });
      }
      
      return result;
    } finally {
      client.release();
    }
  }

  // =============================================================================
  // TRANSACTION MANAGEMENT
  // =============================================================================

  async transaction<T>(callback: TransactionCallback<T>): Promise<T> {
    if (this.isShuttingDown) {
      throw new Error('Database is shutting down');
    }

    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const result = await callback(client);
      
      await client.query('COMMIT');
      return result;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async transactionWithRetry<T>(
    callback: TransactionCallback<T>, 
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.transaction(callback);
      } catch (error) {
        lastError = error as Error;
        
        // Check if error is retryable (serialization failure, deadlock, etc.)
        const isRetryable = this.isRetryableError(error as Error);
        
        if (!isRetryable || attempt === maxRetries) {
          throw error;
        }
        
        // Exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        console.warn(`Transaction attempt ${attempt + 1} failed, retrying in ${delay}ms:`, error);
      }
    }
    
    throw lastError!;
  }

  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    
    // PostgreSQL serialization failure codes
    const retryableErrors = [
      '40001', // serialization_failure
      '40P01', // deadlock_detected
      '53200', // out_of_memory (might be temporary)
      '53300', // too_many_connections (might be temporary)
      '08006', // connection_failure
      '08000', // connection_exception
    ];
    
    // Check for PostgreSQL error codes
    if ('code' in error && typeof (error as any).code === 'string') {
      return retryableErrors.includes((error as any).code);
    }
    
    // Check for common retryable patterns in error messages
    return (
      message.includes('serialization failure') ||
      message.includes('deadlock detected') ||
      message.includes('connection') ||
      message.includes('timeout')
    );
  }

  // =============================================================================
  // HEALTH MONITORING
  // =============================================================================

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    
    try {
      // Simple connectivity check
      const result = await this.query('SELECT 1 as healthy, NOW() as server_time');
      const latencyMs = Date.now() - start;
      
      // Get pool information
      const poolInfo = {
        total: this.pool.totalCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount
      };
      
      return {
        healthy: true,
        latencyMs,
        connectionCount: poolInfo.total
      };
      
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: (error as Error).message
      };
    }
  }

  async detailedHealthCheck(): Promise<{
    basic: HealthCheckResult;
    poolStats: {
      totalConnections: number;
      idleConnections: number;
      waitingClients: number;
    };
    telemetryStats: {
      eventsToday: number;
      errorRate: number;
      avgResponseTime: number;
    };
    performanceTest: {
      queryTime: number;
      insertTime: number;
    };
  }> {
    const basicHealth = await this.healthCheck();
    
    // Pool statistics
    const poolStats = {
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingClients: this.pool.waitingCount
    };
    
    // Telemetry statistics
    let telemetryStats = {
      eventsToday: 0,
      errorRate: 0,
      avgResponseTime: 0
    };
    
    try {
      const telemetryMetrics = await this.telemetry.getTelemetryMetrics();
      telemetryStats = {
        eventsToday: telemetryMetrics.totalEventsToday,
        errorRate: telemetryMetrics.errorRatePercent,
        avgResponseTime: telemetryMetrics.avgResponseTimeMs
      };
    } catch (error) {
      console.warn('Failed to get telemetry stats for health check:', error);
    }
    
    // Performance test
    let performanceTest = { queryTime: 0, insertTime: 0 };
    
    try {
      // Test query performance
      const queryStart = Date.now();
      await this.query('SELECT COUNT(*) FROM telemetry_events WHERE timestamp >= NOW() - INTERVAL \'1 minute\'');
      performanceTest.queryTime = Date.now() - queryStart;
      
      // Test insert performance with a dummy operation
      const insertStart = Date.now();
      await this.query('SELECT 1'); // Simple operation as proxy for insert performance
      performanceTest.insertTime = Date.now() - insertStart;
      
    } catch (error) {
      console.warn('Failed to run performance test for health check:', error);
    }
    
    return {
      basic: basicHealth,
      poolStats,
      telemetryStats,
      performanceTest
    };
  }

  // =============================================================================
  // MAINTENANCE OPERATIONS
  // =============================================================================

  async runMaintenance(): Promise<{
    vacuumResults: string[];
    cleanupResults: string;
    viewRefreshResults: string;
    partitionMaintenanceResults: string;
  }> {
    console.log('Starting database maintenance...');
    
    const results = {
      vacuumResults: [] as string[],
      cleanupResults: '',
      viewRefreshResults: '',
      partitionMaintenanceResults: ''
    };
    
    try {
      // Vacuum analyze high-traffic tables
      const tablesToVacuum = [
        'telemetry_events',
        'performance_metrics',
        'component_health_metrics',
        'telemetry_traces'
      ];
      
      for (const table of tablesToVacuum) {
        try {
          const start = Date.now();
          await this.query(`VACUUM ANALYZE ${table}`);
          const duration = Date.now() - start;
          results.vacuumResults.push(`${table}: ${duration}ms`);
        } catch (error) {
          results.vacuumResults.push(`${table}: ERROR - ${(error as Error).message}`);
        }
      }
      
      // Clean up old telemetry data
      try {
        results.cleanupResults = await this.telemetry.cleanupOldTelemetryData();
      } catch (error) {
        results.cleanupResults = `ERROR: ${(error as Error).message}`;
      }
      
      // Refresh materialized views
      try {
        await this.telemetry.refreshTelemetryViews();
        results.viewRefreshResults = 'Successfully refreshed telemetry views';
      } catch (error) {
        results.viewRefreshResults = `ERROR: ${(error as Error).message}`;
      }
      
      // Partition maintenance
      try {
        const partitionResult = await this.query('SELECT manage_telemetry_partitions()');
        results.partitionMaintenanceResults = partitionResult.rows[0].manage_telemetry_partitions;
      } catch (error) {
        results.partitionMaintenanceResults = `ERROR: ${(error as Error).message}`;
      }
      
    } catch (error) {
      console.error('Database maintenance failed:', error);
      throw error;
    }
    
    console.log('Database maintenance completed:', results);
    return results;
  }

  async getTableSizes(): Promise<Array<{ table: string; sizeBytes: number; rowCount: number }>> {
    const query = `
      SELECT 
        schemaname,
        tablename,
        pg_total_relation_size(schemaname||'.'||tablename) as size_bytes,
        n_tup_ins + n_tup_upd + n_tup_del as row_estimate
      FROM pg_tables 
      LEFT JOIN pg_stat_user_tables ON pg_tables.tablename = pg_stat_user_tables.relname
      WHERE schemaname = 'public'
        AND tablename NOT LIKE 'pg_%'
      ORDER BY size_bytes DESC
    `;
    
    const result = await this.query(query);
    
    return result.rows.map((row: any) => ({
      table: row.tablename,
      sizeBytes: parseInt(row.size_bytes) || 0,
      rowCount: parseInt(row.row_estimate) || 0
    }));
  }

  async getConnectionInfo(): Promise<{
    active: number;
    idle: number;
    total: number;
    maxConnections: number;
  }> {
    const query = `
      SELECT 
        COUNT(*) FILTER (WHERE state = 'active') as active,
        COUNT(*) FILTER (WHERE state = 'idle') as idle,
        COUNT(*) as total,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_connections
      FROM pg_stat_activity
    `;
    
    const result = await this.query(query);
    const row = result.rows[0];
    
    return {
      active: parseInt(row.active) || 0,
      idle: parseInt(row.idle) || 0,
      total: parseInt(row.total) || 0,
      maxConnections: parseInt(row.max_connections) || 0
    };
  }

  // =============================================================================
  // SCHEMA MANAGEMENT
  // =============================================================================

  async runMigrations(): Promise<string[]> {
    console.log('Checking for pending migrations...');
    
    // Ensure migrations table exists
    await this.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
    
    // Get applied migrations
    const appliedResult = await this.query(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    const appliedMigrations = new Set(appliedResult.rows.map((row: any) => row.version));
    
    // Available migrations (in practice, these would be read from files)
    const availableMigrations = [
      { version: '001', name: 'create_schema', sql: '' },
      { version: '002', name: 'add_telemetry_tables', sql: '' },
      { version: '003', name: 'analyzer_telemetry_alignment', sql: '' }
    ];
    
    const results: string[] = [];
    
    for (const migration of availableMigrations) {
      if (!appliedMigrations.has(migration.version)) {
        console.log(`Would apply migration ${migration.version}: ${migration.name}`);
        results.push(`Migration ${migration.version} would be applied (${migration.name})`);
        // In practice: await this.query(migration.sql);
      }
    }
    
    if (results.length === 0) {
      results.push('All migrations are up to date');
    }
    
    return results;
  }

  // =============================================================================
  // CONNECTION LIFECYCLE
  // =============================================================================

  async connect(): Promise<void> {
    console.log('Initializing database connection pool...');
    
    // Test the connection
    const healthCheck = await this.healthCheck();
    if (!healthCheck.healthy) {
      throw new Error(`Database health check failed: ${healthCheck.error}`);
    }
    
    console.log(`Database connected successfully (latency: ${healthCheck.latencyMs}ms)`);
  }

  async disconnect(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    
    this.isShuttingDown = true;
    console.log('Shutting down database connection pool...');
    
    try {
      await this.pool.end();
      console.log('Database connection pool closed successfully');
    } catch (error) {
      console.error('Error closing database connection pool:', error);
      throw error;
    }
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  isConnected(): boolean {
    return !this.isShuttingDown && this.pool.totalCount > 0;
  }

  getPoolStatus(): {
    total: number;
    idle: number;
    waiting: number;
  } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount
    };
  }
}

// =============================================================================
// DATABASE CLIENT FACTORY
// =============================================================================

export class DatabaseClientFactory {
  private static instance: DatabaseClient | null = null;

  static create(config: DatabaseConfig): DatabaseClient {
    if (DatabaseClientFactory.instance) {
      console.warn('Database client already exists, returning existing instance');
      return DatabaseClientFactory.instance;
    }

    DatabaseClientFactory.instance = new DatabaseClient(config);
    return DatabaseClientFactory.instance;
  }

  static getInstance(): DatabaseClient {
    if (!DatabaseClientFactory.instance) {
      throw new Error('Database client not initialized. Call create() first.');
    }
    return DatabaseClientFactory.instance;
  }

  static async shutdown(): Promise<void> {
    if (DatabaseClientFactory.instance) {
      await DatabaseClientFactory.instance.disconnect();
      DatabaseClientFactory.instance = null;
    }
  }
}

// =============================================================================
// CONFIGURATION HELPERS
// =============================================================================

export function createDatabaseConfig(options: {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  maxConnections?: number;
}): DatabaseConfig {
  return {
    host: options.host || process.env.DB_HOST || 'localhost',
    port: options.port || parseInt(process.env.DB_PORT || '5432'),
    database: options.database || process.env.DB_NAME || 'unravl',
    user: options.user || process.env.DB_USER || 'postgres',
    password: options.password || process.env.DB_PASSWORD || '',
    ssl: options.ssl ?? (process.env.DB_SSL === 'true'),
    max: options.maxConnections || parseInt(process.env.DB_MAX_CONNECTIONS || '20'),
    application_name: 'unravl-platform'
  };
}

export function createDatabaseConfigFromUrl(
  connectionUrl: string,
  options?: Partial<DatabaseConfig>
): DatabaseConfig {
  const url = new URL(connectionUrl);
  
  return {
    host: url.hostname,
    port: parseInt(url.port) || 5432,
    database: url.pathname.slice(1), // Remove leading slash
    user: url.username,
    password: url.password,
    ssl: url.searchParams.get('ssl') === 'true' || url.searchParams.get('sslmode') !== 'disable',
    ...options
  };
}