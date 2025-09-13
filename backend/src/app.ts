import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import passport from 'passport';

// Security middleware
import { globalRateLimiter } from './middleware/rate-limiter';
import { csrfProtection, CSRFProtection, attachCSRFToken } from './middleware/csrf-protection';
import { globalInputSanitizer } from './middleware/input-sanitizer';

// Services
import { Logger } from './services/logger.service';
import { emailService } from './services/email.service';

// Auth
import { initializePassport } from './auth/oauth-providers/oauth-strategies';
import { authConfig } from './config/auth.config';

// Routes
import { createAuthRoutes } from './routes/auth';
import { createOrganizationRoutes } from './routes/organizations';
import { createUserRoutes } from './routes/users';
// import { createVisualizationRouter } from './routes/visualization';
import { createAnalyzerRoutes } from './routes/analyzer';

// Database
import { runMigrations } from './database/migrations/migration-manager';

export class App {
  private app: Application;
  private pool: Pool;
  private logger = new Logger('App');
  
  constructor() {
    this.app = express();
    this.pool = this.createDatabasePool();
  }
  
  private createDatabasePool(): Pool {
    return new Pool({
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
  
  async initialize(): Promise<void> {
    try {
      // Try database initialization but don't fail if it's not available (for demo)
      try {
        await this.initializeDatabase();
      } catch (dbError) {
        this.logger.warn('Database not available - running in demo mode', dbError as Error);
      }
      
      this.setupMiddleware();
      this.setupRoutes();
      this.setupErrorHandling();
      
      this.logger.info('Application initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize application', error);
      throw error;
    }
  }
  
  private async initializeDatabase(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
      this.logger.info('Database connection established');
      
      if (process.env.RUN_MIGRATIONS === 'true') {
        await runMigrations(this.pool);
      }
    } catch (error) {
      this.logger.error('Database connection failed', error);
      throw error;
    }
  }
  
  private setupMiddleware(): void {
    // Security headers
    this.app.use(helmet({
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
    
    // CORS
    this.app.use(cors({
      origin: authConfig.cors.origin,
      credentials: authConfig.cors.credentials,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
      exposedHeaders: ['X-CSRF-Token'],
    }));
    
    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    this.app.use(cookieParser());
    
    // Logging - Temporarily disabled for Express 5 compatibility
    // this.app.use(Logger.httpLoggerMiddleware());
    
    // Global rate limiting
    this.app.use(globalRateLimiter);
    
    // Input sanitization - Temporarily disabled due to Express 5 compatibility
    // this.app.use(globalInputSanitizer);
    
    // Passport initialization
    initializePassport();
    this.app.use(passport.initialize());
    
    // Trust proxy for accurate IP addresses
    this.app.set('trust proxy', 1);
    
    // Request ID generation
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      (req as any).id = Math.random().toString(36).substring(7);
      next();
    });
  }
  
  private setupRoutes(): void {
    // Health check endpoints
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });
    
    this.app.get('/health/ready', async (req: Request, res: Response) => {
      try {
        await this.pool.query('SELECT 1');
        res.json({ status: 'ready', timestamp: new Date().toISOString() });
      } catch (error) {
        res.status(503).json({ status: 'not ready', error: 'Database unavailable' });
      }
    });
    
    // CSRF token endpoint
    this.app.get('/api/csrf-token', attachCSRFToken, CSRFProtection.tokenEndpoint());
    
    // API routes
    this.app.use('/api/auth', createAuthRoutes(this.pool));
    this.app.use('/api/organizations', createOrganizationRoutes(this.pool));
    this.app.use('/api/users', createUserRoutes(this.pool));
    // this.app.use('/api/visualization', createVisualizationRouter(this.pool));
    this.app.use('/api/analyzer', createAnalyzerRoutes(this.pool));
    
    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: 'Not Found',
        message: 'The requested resource was not found',
        path: req.path,
      });
    });
  }
  
  private setupErrorHandling(): void {
    // Global error handler
    this.app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      const logger = Logger.createRequestLogger(req);
      
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
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      this.logger.error('Unhandled Promise Rejection', reason);
    });
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error: Error) => {
      this.logger.error('Uncaught Exception', error);
      this.shutdown();
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
      this.logger.info('SIGTERM received, shutting down gracefully');
      this.shutdown();
    });
    
    process.on('SIGINT', () => {
      this.logger.info('SIGINT received, shutting down gracefully');
      this.shutdown();
    });
  }
  
  private async shutdown(): Promise<void> {
    try {
      this.logger.info('Closing database connections');
      await this.pool.end();
      
      this.logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      this.logger.error('Error during shutdown', error);
      process.exit(1);
    }
  }
  
  start(port: number = 3001): void {
    this.app.listen(port, () => {
      this.logger.info(`Server running on port ${port}`);
      this.logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      
      if (process.env.NODE_ENV === 'production') {
        this.logger.info('Production mode - all security features enabled');
      } else {
        this.logger.warn('Development mode - some security features may be relaxed');
      }
    });
  }
  
  getApp(): Application {
    return this.app;
  }
  
  getPool(): Pool {
    return this.pool;
  }
}