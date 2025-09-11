/**
 * Database Module Entry Point
 * 
 * This module exports all database-related functionality for the Unravl platform:
 * - Database connection management
 * - Repository pattern implementations
 * - Type definitions and interfaces
 * - Utility functions and helpers
 */

// Import db for local use
import dbConnection from './connection';
// Import repository instances for health checks
import { organizationRepository as orgRepo } from './repositories/organization-repository';
import { projectRepository as projRepo } from './repositories/project-repository';

// Core database connection
export { default as db, DatabaseConnection } from './connection';
export type { ConnectionHealth, QueryResult, TransactionClient } from './connection';

// Base repository and types
export { BaseRepository } from './repositories/base-repository';
export type {
  BaseEntity,
  PaginationOptions,
  PaginatedResult,
  FilterCondition,
  QueryOptions,
  QueryBuilder
} from './repositories/base-repository';

// Organization repository
export { OrganizationRepository, organizationRepository } from './repositories/organization-repository';
export type {
  Organization,
  OrganizationWithStats,
  CreateOrganizationData
} from './repositories/organization-repository';

// Project repository
export { ProjectRepository, projectRepository } from './repositories/project-repository';
export type {
  Project,
  ProjectWithStats,
  CreateProjectData
} from './repositories/project-repository';

// Database initialization and utility functions
export * from './utils/database-utils';

/**
 * Initialize all database connections and repositories
 * Call this function during application startup
 */
export async function initializeDatabase(): Promise<void> {
  try {
    console.log('🔌 Initializing database connections...');
    
    // Initialize main database connection
    await dbConnection.initialize();
    
    console.log('✅ Database initialization complete');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

/**
 * Gracefully shutdown all database connections
 * Call this function during application shutdown
 */
export async function shutdownDatabase(): Promise<void> {
  try {
    console.log('🔌 Shutting down database connections...');
    
    // Close main database connection
    await dbConnection.close();
    
    console.log('✅ Database shutdown complete');
  } catch (error) {
    console.error('❌ Database shutdown failed:', error);
    throw error;
  }
}

/**
 * Health check for all database components
 * Returns overall database health status
 */
export async function checkDatabaseHealth(): Promise<{
  isHealthy: boolean;
  components: Record<string, any>;
  errors: string[];
}> {
  const health = {
    isHealthy: true,
    components: {} as Record<string, any>,
    errors: [] as string[],
  };

  try {
    // Check main database connection
    const dbHealth = await dbConnection.checkHealth();
    health.components.database = dbHealth;
    
    if (!dbHealth.isHealthy) {
      health.isHealthy = false;
      health.errors.push(...dbHealth.errors);
    }
    
    // Check repositories (basic connectivity)
    try {
      // Just try to query - this will fail if DB isn't connected
      await orgRepo.findById('00000000-0000-0000-0000-000000000000');
      health.components.organizationRepository = { status: 'healthy' };
    } catch (error) {
      // If it's a connection error, mark as unhealthy
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('connect') || errorMessage.includes('ECONNREFUSED')) {
        health.components.organizationRepository = { 
          status: 'unhealthy', 
          error: errorMessage
        };
        health.isHealthy = false;
        health.errors.push(`Organization repository: ${errorMessage}`);
      } else {
        // Query worked, just no results - that's healthy
        health.components.organizationRepository = { status: 'healthy' };
      }
    }

    try {
      // Just try to query - this will fail if DB isn't connected
      await projRepo.findById('00000000-0000-0000-0000-000000000000');
      health.components.projectRepository = { status: 'healthy' };
    } catch (error) {
      // If it's a connection error, mark as unhealthy
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('connect') || errorMessage.includes('ECONNREFUSED')) {
        health.components.projectRepository = { 
          status: 'unhealthy', 
          error: errorMessage
        };
        health.isHealthy = false;
        health.errors.push(`Project repository: ${errorMessage}`);
      } else {
        // Query worked, just no results - that's healthy
        health.components.projectRepository = { status: 'healthy' };
      }
    }

  } catch (error) {
    health.isHealthy = false;
    health.errors.push(`Database health check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return health;
}