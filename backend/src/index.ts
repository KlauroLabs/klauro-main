import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import passport from 'passport';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import routes
import { analyzeRoutes } from './routes/analyze';
import { createAuthRoutes } from './routes/auth';
import { createOrganizationRoutes } from './routes/organizations';
import { createUserRoutes } from './routes/users';

// Import authentication
import { initializePassport } from './auth/oauth-providers/oauth-strategies';
import { authConfig } from './config/auth.config';

// Import database
import db from './database/connection';

// Import analyzer system
import { initializeAnalyzerSystem, getAnalyzerStatistics } from './analyzer/analyzer-bootstrap';

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize systems
async function startServer() {
  try {
    console.log('🔧 Initializing Unravl Platform...');
    
    // Initialize database connection
    await db.initialize();
    const pool = await db.getClient();
    pool.release();
    
    // Initialize passport strategies
    initializePassport();
    
    // Initialize the analyzer system with all official plugins
    await initializeAnalyzerSystem();
    
    // Security middleware
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }));
    
    // CORS configuration
    app.use(cors(authConfig.cors));
    
    // Body parsing middleware
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.use(cookieParser());
    
    // Passport middleware
    app.use(passport.initialize());
    
    // Rate limiting
    const apiLimiter = rateLimit({
      windowMs: authConfig.rateLimit.api.windowMs,
      max: authConfig.rateLimit.api.max,
      message: authConfig.rateLimit.api.message,
      standardHeaders: true,
      legacyHeaders: false,
    });
    
    // Apply rate limiting to API routes
    app.use('/api/', apiLimiter);
    
    // Static files
    app.use(express.static('public'));

    // Get database pool for routes
    const poolConfig = {
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      database: process.env.DATABASE_NAME || 'unravl',
      user: process.env.DATABASE_USER || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: parseInt(process.env.DATABASE_POOL_MAX || '50'),
      min: parseInt(process.env.DATABASE_POOL_MIN || '5'),
    };
    const routePool = new Pool(poolConfig);

    // Routes
    app.use('/api/auth', createAuthRoutes(routePool));
    app.use('/api/organizations', createOrganizationRoutes(routePool));
    app.use('/api/users', createUserRoutes(routePool));
    app.use('/api/analyze', analyzeRoutes);
    // app.use('/api/analyses', analysesRoutes);

    // Health check with comprehensive status
    app.get('/api/health', async (req, res) => {
      const stats = getAnalyzerStatistics();
      const dbHealth = await db.checkHealth();
      
      res.json({ 
        status: dbHealth.isHealthy ? 'OK' : 'DEGRADED',
        message: 'Unravl API is running',
        database: {
          isHealthy: dbHealth.isHealthy,
          connections: {
            total: dbHealth.totalConnections,
            idle: dbHealth.idleConnections,
            waiting: dbHealth.waitingClients,
          },
          uptime: dbHealth.uptime,
          errors: dbHealth.errors.length,
        },
        analyzers: {
          total: stats.totalPlugins,
          official: stats.officialPlugins,
          community: stats.communityPlugins,
          languages: stats.supportedLanguages.length,
          frameworks: stats.supportedFrameworks.length
        },
        authentication: {
          providers: ['local', 'github', 'google', 'microsoft', 'gitlab'],
          jwtEnabled: true,
          oauthEnabled: true,
        },
        timestamp: new Date().toISOString()
      });
    });

    // Analyzer system information endpoint
    app.get('/api/analyzers', (req, res) => {
      const stats = getAnalyzerStatistics();
      res.json(stats);
    });

    // Error handling middleware
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('Error:', err);
      
      if (err.name === 'UnauthorizedError') {
        return res.status(401).json({ error: 'Unauthorized', message: err.message });
      }
      
      if (err.name === 'ValidationError') {
        return res.status(400).json({ error: 'Validation Error', message: err.message });
      }
      
      res.status(err.status || 500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message,
      });
    });

    app.listen(PORT, () => {
      console.log(`\n🎉 Unravl API Server Ready!`);
      console.log(`🚀 Server running on: http://localhost:${PORT}`);
      console.log(`\n📍 API Endpoints:`);
      console.log(`   • Health: http://localhost:${PORT}/api/health`);
      console.log(`   • Auth: http://localhost:${PORT}/api/auth/*`);
      console.log(`   • Organizations: http://localhost:${PORT}/api/organizations/*`);
      console.log(`   • Users: http://localhost:${PORT}/api/users/*`);
      console.log(`   • Analyzers: http://localhost:${PORT}/api/analyzers`);
      console.log(`   • Analysis: http://localhost:${PORT}/api/analyze`);
      
      const stats = getAnalyzerStatistics();
      console.log(`\n📋 System Status:`);
      console.log(`   • Database: Connected ✅`);
      console.log(`   • Authentication: Enabled (JWT + OAuth)`);
      console.log(`   • ${stats.totalPlugins} analyzers loaded`);
      console.log(`   • ${stats.supportedLanguages.length} languages supported`);
      console.log(`   • ${stats.supportedFrameworks.length} frameworks detected`);
      console.log(`\n🔐 Security Features:`);
      console.log(`   • JWT Authentication`);
      console.log(`   • OAuth Providers: GitHub, Google, Microsoft, GitLab`);
      console.log(`   • Role-Based Access Control (RBAC)`);
      console.log(`   • Rate Limiting Enabled`);
      console.log(`   • Helmet Security Headers`);
      console.log(`\n✨ Ready to serve Unravl platform!\n`);
    });

  } catch (error) {
    console.error('💥 Failed to start Unravl server:', error);
    process.exit(1);
  }
}

// Start the server with proper error handling
startServer().catch(error => {
  console.error('💥 Startup error:', error);
  process.exit(1);
});