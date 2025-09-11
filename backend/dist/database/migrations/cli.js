#!/usr/bin/env node
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
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const migration_manager_1 = require("./migration-manager");
const dotenv = __importStar(require("dotenv"));
const logger_service_1 = require("../../services/logger.service");
dotenv.config();
const logger = new logger_service_1.Logger('MigrationCLI');
async function main() {
    const command = process.argv[2];
    const args = process.argv.slice(3);
    if (!command || command === 'help') {
        showHelp();
        process.exit(0);
    }
    const pool = new pg_1.Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'unravl',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    const manager = new migration_manager_1.MigrationManager(pool);
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
    }
    catch (error) {
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
