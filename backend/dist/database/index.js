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
const connection_1 = __importDefault(require("./connection"));
const organization_repository_1 = require("./repositories/organization-repository");
const project_repository_1 = require("./repositories/project-repository");
var connection_2 = require("./connection");
Object.defineProperty(exports, "db", { enumerable: true, get: function () { return __importDefault(connection_2).default; } });
Object.defineProperty(exports, "DatabaseConnection", { enumerable: true, get: function () { return connection_2.DatabaseConnection; } });
var base_repository_1 = require("./repositories/base-repository");
Object.defineProperty(exports, "BaseRepository", { enumerable: true, get: function () { return base_repository_1.BaseRepository; } });
var organization_repository_2 = require("./repositories/organization-repository");
Object.defineProperty(exports, "OrganizationRepository", { enumerable: true, get: function () { return organization_repository_2.OrganizationRepository; } });
Object.defineProperty(exports, "organizationRepository", { enumerable: true, get: function () { return organization_repository_2.organizationRepository; } });
var project_repository_2 = require("./repositories/project-repository");
Object.defineProperty(exports, "ProjectRepository", { enumerable: true, get: function () { return project_repository_2.ProjectRepository; } });
Object.defineProperty(exports, "projectRepository", { enumerable: true, get: function () { return project_repository_2.projectRepository; } });
__exportStar(require("./utils/database-utils"), exports);
async function initializeDatabase() {
    try {
        console.log('🔌 Initializing database connections...');
        await connection_1.default.initialize();
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
        await connection_1.default.close();
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
        const dbHealth = await connection_1.default.checkHealth();
        health.components.database = dbHealth;
        if (!dbHealth.isHealthy) {
            health.isHealthy = false;
            health.errors.push(...dbHealth.errors);
        }
        try {
            await organization_repository_1.organizationRepository.findById('00000000-0000-0000-0000-000000000000');
            health.components.organizationRepository = { status: 'healthy' };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('connect') || errorMessage.includes('ECONNREFUSED')) {
                health.components.organizationRepository = {
                    status: 'unhealthy',
                    error: errorMessage
                };
                health.isHealthy = false;
                health.errors.push(`Organization repository: ${errorMessage}`);
            }
            else {
                health.components.organizationRepository = { status: 'healthy' };
            }
        }
        try {
            await project_repository_1.projectRepository.findById('00000000-0000-0000-0000-000000000000');
            health.components.projectRepository = { status: 'healthy' };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('connect') || errorMessage.includes('ECONNREFUSED')) {
                health.components.projectRepository = {
                    status: 'unhealthy',
                    error: errorMessage
                };
                health.isHealthy = false;
                health.errors.push(`Project repository: ${errorMessage}`);
            }
            else {
                health.components.projectRepository = { status: 'healthy' };
            }
        }
    }
    catch (error) {
        health.isHealthy = false;
        health.errors.push(`Database health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return health;
}
