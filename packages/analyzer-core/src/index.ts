import * as dotenv from 'dotenv';

// Load environment variables first
dotenv.config();

import { App } from './app';
import { Logger } from './services/logger.service';

const PORT = parseInt(process.env.PORT || '3001');
const logger = new Logger('Main');

async function startServer() {
  try {
    logger.info('Initializing Klauro Platform...');
    
    const app = new App();
    await app.initialize();
    
    app.start(PORT);
    
    logger.info('Security features enabled:');
    logger.info('- JWT Authentication with secure secret validation');
    logger.info('- OAuth with state validation and PKCE');
    logger.info('- Comprehensive rate limiting');
    logger.info('- CSRF protection');
    logger.info('- Input sanitization and validation');
    logger.info('- SQL injection prevention');
    logger.info('- XSS protection');
    logger.info('- Security headers with Helmet');
    logger.info('- Structured logging with Winston');
    logger.info('- Email service ready');
    logger.info('- Database migration system active');
    
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Start the server with proper error handling
startServer().catch(error => {
  console.error('💥 Startup error:', error);
  process.exit(1);
});