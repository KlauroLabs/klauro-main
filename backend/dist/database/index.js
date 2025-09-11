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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectRepository = exports.ProjectRepository = exports.organizationRepository = exports.OrganizationRepository = exports.BaseRepository = exports.DatabaseConnection = exports.db = void 0;
exports.initializeDatabase = initializeDatabase;
exports.shutdownDatabase = shutdownDatabase;
exports.checkDatabaseHealth = checkDatabaseHealth;
var connection_1 = require("./connection");
Object.defineProperty(exports, "db", { enumerable: true, get: function () { return __importDefault(connection_1).default; } });
Object.defineProperty(exports, "DatabaseConnection", { enumerable: true, get: function () { return connection_1.DatabaseConnection; } });
var base_repository_1 = require("./repositories/base-repository");
Object.defineProperty(exports, "BaseRepository", { enumerable: true, get: function () { return base_repository_1.BaseRepository; } });
var organization_repository_1 = require("./repositories/organization-repository");
Object.defineProperty(exports, "OrganizationRepository", { enumerable: true, get: function () { return organization_repository_1.OrganizationRepository; } });
Object.defineProperty(exports, "organizationRepository", { enumerable: true, get: function () { return organization_repository_1.organizationRepository; } });
var project_repository_1 = require("./repositories/project-repository");
Object.defineProperty(exports, "ProjectRepository", { enumerable: true, get: function () { return project_repository_1.ProjectRepository; } });
Object.defineProperty(exports, "projectRepository", { enumerable: true, get: function () { return project_repository_1.projectRepository; } });
__exportStar(require("./utils/database-utils"), exports);
async function initializeDatabase() {
    try {
        console.log('🔌 Initializing database connections...');
        await db.initialize();
        console.log('✅ Database initialization complete');
    }
    catch (error) {
        console.error('❌ Database initialization failed:', error);
        throw error;
    }
}
async function shutdownDatabase() {
    try {
        console.log('🔌 Shutting down database connections...');
        await db.close();
        console.log('✅ Database shutdown complete');
    }
    catch (error) {
        console.error('❌ Database shutdown failed:', error);
        throw error;
    }
}
async function checkDatabaseHealth() {
    const health = {
        isHealthy: true,
        components: {},
        errors: [],
    };
    try {
        const dbHealth = await db.checkHealth();
        health.components.database = dbHealth;
        if (!dbHealth.isHealthy) {
            health.isHealthy = false;
            health.errors.push(...dbHealth.errors);
        }
        try {
            await organizationRepository.count();
            health.components.organizationRepository = { status: 'healthy' };
        }
        catch (error) {
            health.components.organizationRepository = {
                status: 'unhealthy',
                error: error instanceof Error ? error.message : String(error)
            };
            health.isHealthy = false;
            health.errors.push(`Organization repository: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
            await projectRepository.count();
            health.components.projectRepository = { status: 'healthy' };
        }
        catch (error) {
            health.components.projectRepository = {
                status: 'unhealthy',
                error: error instanceof Error ? error.message : String(error)
            };
            health.isHealthy = false;
            health.errors.push(`Project repository: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    catch (error) {
        health.isHealthy = false;
        health.errors.push(`Database health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return health;
}
