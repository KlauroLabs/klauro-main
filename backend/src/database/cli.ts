#!/usr/bin/env node

import { Pool } from 'pg';
import { MigrationManager } from './migration-manager';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

const logger = console;

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  
  if (!command || command === 'help') {
    showHelp();
    process.exit(0);
  }
  
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'unravl',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  
  const manager = new MigrationManager(pool);
  
  try {
    await manager.initialize();
    
    switch (command) {
      case 'migrate':
      case 'up':
        await manager.migrate();
        break;
        
      case 'rollback':
      case 'down':
        const steps = args[0] ? parseInt(args[0]) : 1;
        await manager.rollback(steps);
        break;
        
      case 'reset':
        if (process.env.NODE_ENV === 'production') {
          logger.error('Reset is not allowed in production');
          process.exit(1);
        }
        await manager.reset();
        break;
        
      case 'status':
        await manager.status();
        break;
        
      case 'create':
        if (!args[0]) {
          logger.error('Migration name is required');
          process.exit(1);
        }
        const migrationPath = await manager.createMigration(args[0]);
        logger.info(`Migration created: ${migrationPath}`);
        break;
        
      case 'validate':
        const valid = await manager.validateChecksums();
        if (!valid) {
          logger.error('Checksum validation failed');
          process.exit(1);
        }
        logger.info('All checksums are valid');
        break;
        
      default:
        logger.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed', error);
    await pool.end();
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Database Migration CLI

Usage: npm run migrate [command] [options]

Commands:
  migrate, up           Run all pending migrations
  rollback, down [n]    Rollback last n migrations (default: 1)
  reset                 Rollback all migrations (not allowed in production)
  status                Show migration status
  create <name>         Create a new migration
  validate              Validate migration checksums
  help                  Show this help message

Examples:
  npm run migrate up                    # Run all pending migrations
  npm run migrate rollback 2            # Rollback last 2 migrations
  npm run migrate create add_users      # Create a new migration
  npm run migrate status                # Show migration status
`);
}

main().catch(error => {
  logger.error('Unexpected error', error);
  process.exit(1);
});