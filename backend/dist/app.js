"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.App = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const pg_1 = require("pg");
const passport_1 = __importDefault(require("passport"));
const rate_limiter_1 = require("./middleware/rate-limiter");
const csrf_protection_1 = require("./middleware/csrf-protection");
const input_sanitizer_1 = require("./middleware/input-sanitizer");
const logger_service_1 = require("./services/logger.service");
const oauth_strategies_1 = require("./auth/oauth-providers/oauth-strategies");
const auth_config_1 = require("./config/auth.config");
const auth_1 = require("./routes/auth");
const organizations_1 = require("./routes/organizations");
const users_1 = require("./routes/users");
const migration_manager_1 = require("./database/migrations/migration-manager");
class App {
    constructor() {
        this.logger = new logger_service_1.Logger('App');
        this.app = (0, express_1.default)();
        this.pool = this.createDatabasePool();
    }
    createDatabasePool() {
        return new pg_1.Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432'),
            database: process.env.DB_NAME || 'unravl',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });
    }
    async initialize() {
        try {
            await this.initializeDatabase();
            this.setupMiddleware();
            this.setupRoutes();
            this.setupErrorHandling();
            this.logger.info('Application initialized successfully');
        }
        catch (error) {
            this.logger.error('Failed to initialize application', error);
            throw error;
        }
    }
    async initializeDatabase() {
        try {
            await this.pool.query('SELECT 1');
            this.logger.info('Database connection established');
            if (process.env.RUN_MIGRATIONS === 'true') {
                await (0, migration_manager_1.runMigrations)(this.pool);
            }
        }
        catch (error) {
            this.logger.error('Database connection failed', error);
            throw error;
        }
    }
    setupMiddleware() {
        this.app.use((0, helmet_1.default)({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", 'data:', 'https:'],
                },
            },
            hsts: {
                maxAge: 31536000,
                includeSubDomains: true,
                preload: true,
            },
        }));
        this.app.use((0, cors_1.default)({
            origin: auth_config_1.authConfig.cors.origin,
            credentials: auth_config_1.authConfig.cors.credentials,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
            exposedHeaders: ['X-CSRF-Token'],
        }));
        this.app.use(express_1.default.json({ limit: '10mb' }));
        this.app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
        this.app.use((0, cookie_parser_1.default)());
        this.app.use(logger_service_1.Logger.httpLoggerMiddleware());
        this.app.use(rate_limiter_1.globalRateLimiter);
        this.app.use(input_sanitizer_1.globalInputSanitizer);
        (0, oauth_strategies_1.initializePassport)();
        this.app.use(passport_1.default.initialize());
        this.app.set('trust proxy', 1);
        this.app.use((req, res, next) => {
            req.id = Math.random().toString(36).substring(7);
            next();
        });
    }
    setupRoutes() {
        this.app.get('/health', (req, res) => {
            res.json({ status: 'healthy', timestamp: new Date().toISOString() });
        });
        this.app.get('/health/ready', async (req, res) => {
            try {
                await this.pool.query('SELECT 1');
                res.json({ status: 'ready', timestamp: new Date().toISOString() });
            }
            catch (error) {
                res.status(503).json({ status: 'not ready', error: 'Database unavailable' });
            }
        });
        this.app.get('/api/csrf-token', csrf_protection_1.attachCSRFToken, csrf_protection_1.CSRFProtection.tokenEndpoint());
        this.app.use('/api/auth', (0, auth_1.createAuthRoutes)(this.pool));
        this.app.use('/api/organizations', (0, organizations_1.createOrganizationRoutes)(this.pool));
        this.app.use('/api/users', (0, users_1.createUserRoutes)(this.pool));
        this.app.use((req, res) => {
            res.status(404).json({
                error: 'Not Found',
                message: 'The requested resource was not found',
                path: req.path,
            });
        });
    }
    setupErrorHandling() {
        this.app.use((err, req, res, next) => {
            const logger = logger_service_1.Logger.createRequestLogger(req);
            if (err.name === 'ValidationError') {
                logger.warn('Validation error', { error: err.message });
                return res.status(400).json({
                    error: 'Validation Error',
                    message: err.message,
                    details: err.details,
                });
            }
            if (err.name === 'UnauthorizedError') {
                logger.warn('Unauthorized access attempt', { error: err.message });
                return res.status(401).json({
                    error: 'Unauthorized',
                    message: 'Authentication required',
                });
            }
            if (err.code === 'EBADCSRFTOKEN') {
                logger.warn('CSRF token validation failed');
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Invalid CSRF token',
                });
            }
            if (err.status && err.status < 500) {
                logger.warn('Client error', { error: err.message, status: err.status });
                return res.status(err.status).json({
                    error: err.name || 'Client Error',
                    message: err.message,
                });
            }
            logger.error('Unhandled error', err);
            const isDevelopment = process.env.NODE_ENV !== 'production';
            return res.status(500).json({
                error: 'Internal Server Error',
                message: isDevelopment ? err.message : 'An unexpected error occurred',
                ...(isDevelopment && { stack: err.stack }),
            });
        });
        process.on('unhandledRejection', (reason, promise) => {
            this.logger.error('Unhandled Promise Rejection', reason);
        });
        process.on('uncaughtException', (error) => {
            this.logger.error('Uncaught Exception', error);
            this.shutdown();
        });
        process.on('SIGTERM', () => {
            this.logger.info('SIGTERM received, shutting down gracefully');
            this.shutdown();
        });
        process.on('SIGINT', () => {
            this.logger.info('SIGINT received, shutting down gracefully');
            this.shutdown();
        });
    }
    async shutdown() {
        try {
            this.logger.info('Closing database connections');
            await this.pool.end();
            this.logger.info('Shutdown complete');
            process.exit(0);
        }
        catch (error) {
            this.logger.error('Error during shutdown', error);
            process.exit(1);
        }
    }
    start(port = 3001) {
        this.app.listen(port, () => {
            this.logger.info(`Server running on port ${port}`);
            this.logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
            if (process.env.NODE_ENV === 'production') {
                this.logger.info('Production mode - all security features enabled');
            }
            else {
                this.logger.warn('Development mode - some security features may be relaxed');
            }
        });
    }
    getApp() {
        return this.app;
    }
    getPool() {
        return this.pool;
    }
}
exports.App = App;
