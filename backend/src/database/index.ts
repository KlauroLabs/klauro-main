/**
 * Database Module Entry Point
 * 
 * This module exports all database-related functionality for the Unravl platform:
 * - Database connection management
 * - Repository pattern implementations
 * - Type definitions and interfaces
 * - Utility functions and helpers
 */

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
    await db.initialize();
    
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
    await db.close();
    
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
    const dbHealth = await db.checkHealth();
    health.components.database = dbHealth;
    
    if (!dbHealth.isHealthy) {
      health.isHealthy = false;
      health.errors.push(...dbHealth.errors);
    }
    
    // Check repositories (basic connectivity)
    try {
      await organizationRepository.count();
      health.components.organizationRepository = { status: 'healthy' };
    } catch (error) {
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
    } catch (error) {
      health.components.projectRepository = { 
        status: 'unhealthy', 
        error: error instanceof Error ? error.message : String(error)
      };
      health.isHealthy = false;
      health.errors.push(`Project repository: ${error instanceof Error ? error.message : String(error)}`);
    }

  } catch (error) {
    health.isHealthy = false;
    health.errors.push(`Database health check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return health;
}