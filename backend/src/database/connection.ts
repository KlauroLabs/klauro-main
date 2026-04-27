/**
 * Database Connection Management for Unravl Platform
 * 
 * This module provides PostgreSQL connection management with:
 * - Connection pooling for optimal performance
 * - Multi-tenant database isolation
 * - Transaction management
 * - Health monitoring
 * - Graceful shutdown handling
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
import * as dotenv from 'dotenv';
import Joi from 'joi';

// Load environment variables
dotenv.config();

// =============================================================================
// CONFIGURATION AND TYPES
// =============================================================================

interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  poolConfig: {
    min: number;
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    acquireTimeoutMillis: number;
    maxUses: number;
  };
}

interface ConnectionHealth {
  isHealthy: boolean;
  totalConnections: number;
  idleConnections: number;
  waitingClients: number;
  uptime: number;
  errors: string[];
}

interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
  command: string;
  fields: any[];
}

interface TransactionClient {
  query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
  release(err?: Error | boolean): void;
}

// Configuration validation schema
const configSchema = Joi.object({
  DATABASE_HOST: Joi.string().default('localhost'),
  DATABASE_PORT: Joi.number().port().default(5432),
  DATABASE_NAME: Joi.string().required(),
  DATABASE_USER: Joi.string().required(),
  DATABASE_PASSWORD: Joi.string().required(),
  DATABASE_SSL: Joi.boolean().default(false),
  DATABASE_POOL_MIN: Joi.number().min(1).default(5),
  DATABASE_POOL_MAX: Joi.number().min(5).default(50),
  DATABASE_POOL_IDLE_TIMEOUT: Joi.number().default(30000),
  DATABASE_POOL_CONNECTION_TIMEOUT: Joi.number().default(60000),
  DATABASE_POOL_ACQUIRE_TIMEOUT: Joi.number().default(60000),
  DATABASE_POOL_MAX_USES: Joi.number().default(7500),
});

// =============================================================================
// DATABASE CONNECTION CLASS
// =============================================================================

class DatabaseConnection {
  private pool: Pool | null = null;
  private config: DatabaseConfig | null = null;
  private isInitialized: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private connectionStartTime: number = 0;
  private healthErrors: string[] = [];

  /**
   * Initialize the database connection pool
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Validate configuration
      const { error, value: envVars } = configSchema.validate(process.env, {
        allowUnknown: true,
        stripUnknown: true,
      });

      if (error) {
        throw new Error(`Database configuration error: ${error.message}`);
      }

      // Build configuration
      this.config = {
        host: envVars.DATABASE_HOST,
        port: envVars.DATABASE_PORT,
        database: envVars.DATABASE_NAME,
        username: envVars.DATABASE_USER,
        password: envVars.DATABASE_PASSWORD,
        ssl: envVars.DATABASE_SSL,
        poolConfig: {
          min: envVars.DATABASE_POOL_MIN,
          max: envVars.DATABASE_POOL_MAX,
          idleTimeoutMillis: envVars.DATABASE_POOL_IDLE_TIMEOUT,
          connectionTimeoutMillis: envVars.DATABASE_POOL_CONNECTION_TIMEOUT,
          acquireTimeoutMillis: envVars.DATABASE_POOL_ACQUIRE_TIMEOUT,
          maxUses: envVars.DATABASE_POOL_MAX_USES,
        },
      };

      // Create connection pool
      const poolConfig: PoolConfig = {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.username,
        password: this.config.password,
        ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
        min: this.config.poolConfig.min,
        max: this.config.poolConfig.max,
        idleTimeoutMillis: this.config.poolConfig.idleTimeoutMillis,
        connectionTimeoutMillis: this.config.poolConfig.connectionTimeoutMillis,
        maxUses: this.config.poolConfig.maxUses,
        application_name: 'unravl-backend',
        statement_timeout: 30000, // 30 second query timeout
        query_timeout: 30000,
      };

      this.pool = new Pool(poolConfig);
      this.connectionStartTime = Date.now();

      // Set up event handlers
      this.setupEventHandlers();

      // Test connection
      await this.testConnection();

      // Start health monitoring
      this.startHealthMonitoring();

      this.isInitialized = true;
      console.log('Database connection pool initialized successfully');
      console.log(`Pool config: min=${this.config.poolConfig.min}, max=${this.config.poolConfig.max}`);
      
    } catch (error) {
      console.error('Failed to initialize database connection:', error);
      throw error;
    }
  }

  /**
   * Set up pool event handlers for monitoring
   */
  private setupEventHandlers(): void {
    if (!this.pool) return;

    this.pool.on('connect', (client) => {
      console.log('New database client connected');
    });

    this.pool.on('acquire', () => {
      console.log('📋 Client acquired from pool');
    });

    this.pool.on('release', () => {
      console.log('Client released back to pool');
    });

    this.pool.on('remove', () => {
      console.log('Client removed from pool');
    });

    this.pool.on('error', (error, client) => {
      console.error('Database pool error:', error);
      this.healthErrors.push(`Pool error: ${error.message}`);
      
      // Keep only last 10 errors
      if (this.healthErrors.length > 10) {
        this.healthErrors = this.healthErrors.slice(-10);
      }
    });
  }

  /**
   * Test database connection with a simple query
   */
  private async testConnection(): Promise<void> {
    if (!this.pool) {
      throw new Error('Pool not initialized');
    }

    try {
      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
      console.log(`Database connected: ${result.rows[0].pg_version}`);
      client.release();
    } catch (error) {
      console.error('Database connection test failed:', error);
      throw error;
    }
  }

  /**
   * Start periodic health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.checkHealth();
      } catch (error) {
        console.error('Health check failed:', error);
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Execute a query with automatic connection management
   */
  async query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const start = Date.now();
    let client: PoolClient | undefined;

    try {
      client = await this.pool.connect();
      const result = await client.query(text, params);
      
      const duration = Date.now() - start;
      if (duration > 1000) {
        console.warn(`Slow query detected (${duration}ms): ${text.substring(0, 100)}...`);
      }

      return {
        rows: result.rows,
        rowCount: result.rowCount || 0,
        command: result.command,
        fields: result.fields,
      };
    } catch (error) {
      const duration = Date.now() - start;
      console.error(`Query failed after ${duration}ms:`, error);
      console.error(`Query: ${text}`);
      console.error(`Params:`, params);
      throw error;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Execute a transaction with automatic rollback on error
   */
  async transaction<T>(
    callback: (client: TransactionClient) => Promise<T>
  ): Promise<T> {
    if (!this.pool) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Wrap client to provide proper typing
      const transactionClient = client as TransactionClient;
      
      const result = await callback(transactionClient);
      await client.query('COMMIT');
      
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Transaction rolled back due to error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get a client from the pool for complex operations
   */
  async getClient(): Promise<PoolClient> {
    if (!this.pool) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    return await this.pool.connect();
  }

  /**
   * Check database health and return status
   */
  async checkHealth(): Promise<ConnectionHealth> {
    if (!this.pool || !this.config) {
      return {
        isHealthy: false,
        totalConnections: 0,
        idleConnections: 0,
        waitingClients: 0,
        uptime: 0,
        errors: ['Database not initialized'],
      };
    }

    try {
      const uptime = Date.now() - this.connectionStartTime;
      
      // Test with a simple query
      const result = await this.query('SELECT 1 as health_check');
      const isHealthy = result.rows.length === 1 && result.rows[0].health_check === 1;

      return {
        isHealthy,
        totalConnections: this.pool.totalCount,
        idleConnections: this.pool.idleCount,
        waitingClients: this.pool.waitingCount,
        uptime,
        errors: [...this.healthErrors],
      };
    } catch (error) {
      this.healthErrors.push(`Health check failed: ${error instanceof Error ? error.message : String(error)}`);
      
      return {
        isHealthy: false,
        totalConnections: this.pool?.totalCount || 0,
        idleConnections: this.pool?.idleCount || 0,
        waitingClients: this.pool?.waitingCount || 0,
        uptime: Date.now() - this.connectionStartTime,
        errors: [...this.healthErrors],
      };
    }
  }

  /**
   * Get current pool statistics
   */
  getPoolStats() {
    if (!this.pool) {
      return null;
    }

    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
      config: this.config?.poolConfig,
    };
  }

  /**
   * Gracefully close all connections
   */
  async close(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.pool) {
      console.log('Closing database connection pool...');
      await this.pool.end();
      this.pool = null;
    }

    this.isInitialized = false;
    console.log('Database connection pool closed');
  }

  /**
   * Check if database is initialized and ready
   */
  isReady(): boolean {
    return this.isInitialized && this.pool !== null;
  }
}

// =============================================================================
// SINGLETON INSTANCE AND EXPORTS
// =============================================================================

// Create singleton instance
const db = new DatabaseConnection();

// Export the singleton instance and types
export { db, DatabaseConnection, ConnectionHealth, QueryResult, TransactionClient };
export default db;

// =============================================================================
// GRACEFUL SHUTDOWN HANDLING
// =============================================================================

// Handle graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, closing database connections...`);
  
  try {
    await db.close();
    console.log('Database connections closed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error closing database connections:', error);
    process.exit(1);
  }
};

// Listen for shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  console.error('🚨 Uncaught Exception:', error);
  await db.close();
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  await db.close();
  process.exit(1);
});
