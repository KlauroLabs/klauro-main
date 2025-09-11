"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseConnection = exports.db = void 0;
const pg_1 = require("pg");
const dotenv = __importStar(require("dotenv"));
const joi_1 = __importDefault(require("joi"));
dotenv.config();
const configSchema = joi_1.default.object({
    DATABASE_HOST: joi_1.default.string().default('localhost'),
    DATABASE_PORT: joi_1.default.number().port().default(5432),
    DATABASE_NAME: joi_1.default.string().required(),
    DATABASE_USER: joi_1.default.string().required(),
    DATABASE_PASSWORD: joi_1.default.string().required(),
    DATABASE_SSL: joi_1.default.boolean().default(false),
    DATABASE_POOL_MIN: joi_1.default.number().min(1).default(5),
    DATABASE_POOL_MAX: joi_1.default.number().min(5).default(50),
    DATABASE_POOL_IDLE_TIMEOUT: joi_1.default.number().default(30000),
    DATABASE_POOL_CONNECTION_TIMEOUT: joi_1.default.number().default(60000),
    DATABASE_POOL_ACQUIRE_TIMEOUT: joi_1.default.number().default(60000),
    DATABASE_POOL_MAX_USES: joi_1.default.number().default(7500),
});
class DatabaseConnection {
    constructor() {
        this.pool = null;
        this.config = null;
        this.isInitialized = false;
        this.healthCheckInterval = null;
        this.connectionStartTime = 0;
        this.healthErrors = [];
    }
    async initialize() {
        if (this.isInitialized) {
            return;
        }
        try {
            const { error, value: envVars } = configSchema.validate(process.env, {
                allowUnknown: true,
                stripUnknown: true,
            });
            if (error) {
                throw new Error(`Database configuration error: ${error.message}`);
            }
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
            const poolConfig = {
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
                acquireTimeoutMillis: this.config.poolConfig.acquireTimeoutMillis,
                maxUses: this.config.poolConfig.maxUses,
                application_name: 'unravl-backend',
                statement_timeout: 30000,
                query_timeout: 30000,
            };
            this.pool = new pg_1.Pool(poolConfig);
            this.connectionStartTime = Date.now();
            this.setupEventHandlers();
            await this.testConnection();
            this.startHealthMonitoring();
            this.isInitialized = true;
            console.log('✅ Database connection pool initialized successfully');
            console.log(`📊 Pool config: min=${this.config.poolConfig.min}, max=${this.config.poolConfig.max}`);
        }
        catch (error) {
            console.error('❌ Failed to initialize database connection:', error);
            throw error;
        }
    }
    setupEventHandlers() {
        if (!this.pool)
            return;
        this.pool.on('connect', (client) => {
            console.log('🔗 New database client connected');
        });
        this.pool.on('acquire', () => {
            console.log('📋 Client acquired from pool');
        });
        this.pool.on('release', () => {
            console.log('📤 Client released back to pool');
        });
        this.pool.on('remove', () => {
            console.log('🗑️  Client removed from pool');
        });
        this.pool.on('error', (error, client) => {
            console.error('❌ Database pool error:', error);
            this.healthErrors.push(`Pool error: ${error.message}`);
            if (this.healthErrors.length > 10) {
                this.healthErrors = this.healthErrors.slice(-10);
            }
        });
    }
    async testConnection() {
        if (!this.pool) {
            throw new Error('Pool not initialized');
        }
        try {
            const client = await this.pool.connect();
            const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
            console.log(`🚀 Database connected: ${result.rows[0].pg_version}`);
            client.release();
        }
        catch (error) {
            console.error('❌ Database connection test failed:', error);
            throw error;
        }
    }
    startHealthMonitoring() {
        this.healthCheckInterval = setInterval(async () => {
            try {
                await this.checkHealth();
            }
            catch (error) {
                console.error('Health check failed:', error);
            }
        }, 30000);
    }
    async query(text, params) {
        if (!this.pool) {
            throw new Error('Database not initialized. Call initialize() first.');
        }
        const start = Date.now();
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query(text, params);
            const duration = Date.now() - start;
            if (duration > 1000) {
                console.warn(`⚠️  Slow query detected (${duration}ms): ${text.substring(0, 100)}...`);
            }
            return {
                rows: result.rows,
                rowCount: result.rowCount || 0,
                command: result.command,
                fields: result.fields,
            };
        }
        catch (error) {
            const duration = Date.now() - start;
            console.error(`❌ Query failed after ${duration}ms:`, error);
            console.error(`Query: ${text}`);
            console.error(`Params:`, params);
            throw error;
        }
        finally {
            if (client) {
                client.release();
            }
        }
    }
    async transaction(callback) {
        if (!this.pool) {
            throw new Error('Database not initialized. Call initialize() first.');
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const transactionClient = client;
            const result = await callback(transactionClient);
            await client.query('COMMIT');
            return result;
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Transaction rolled back due to error:', error);
            throw error;
        }
        finally {
            client.release();
        }
    }
    async getClient() {
        if (!this.pool) {
            throw new Error('Database not initialized. Call initialize() first.');
        }
        return await this.pool.connect();
    }
    async checkHealth() {
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
        }
        catch (error) {
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
    async close() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        if (this.pool) {
            console.log('🔌 Closing database connection pool...');
            await this.pool.end();
            this.pool = null;
        }
        this.isInitialized = false;
        console.log('✅ Database connection pool closed');
    }
    isReady() {
        return this.isInitialized && this.pool !== null;
    }
}
exports.DatabaseConnection = DatabaseConnection;
const db = new DatabaseConnection();
exports.db = db;
exports.default = db;
const gracefulShutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}, closing database connections...`);
    try {
        await db.close();
        console.log('✅ Database connections closed successfully');
        process.exit(0);
    }
    catch (error) {
        console.error('❌ Error closing database connections:', error);
        process.exit(1);
    }
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));
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
