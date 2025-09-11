/**
 * Base Repository Pattern for Unravl Platform
 * 
 * Provides a foundation for all database repositories with:
 * - Multi-tenant row-level security support
 * - Common CRUD operations
 * - Query building utilities
 * - Transaction support
 * - Pagination and filtering
 * - Type-safe database operations
 */

import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import db, { QueryResult, TransactionClient } from '../connection';

// =============================================================================
// TYPES AND INTERFACES
// =============================================================================

export interface BaseEntity {
  id: string;
  created_at: Date;
  updated_at?: Date;
}

export interface PaginationOptions {
  page: number;
  limit: number;
  sort?: string;
  sortDirection?: 'ASC' | 'DESC';
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface FilterCondition {
  field: string;
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'ILIKE' | 'IN' | 'NOT IN' | 'IS NULL' | 'IS NOT NULL';
  value?: any;
  values?: any[];
}

export interface QueryOptions {
  filters?: FilterCondition[];
  pagination?: PaginationOptions;
  organizationId?: string; // For multi-tenant filtering
  includeSoftDeleted?: boolean;
}

export interface QueryBuilder {
  select: string[];
  from: string;
  joins: string[];
  where: string[];
  orderBy: string[];
  limit?: number;
  offset?: number;
  params: any[];
}

// =============================================================================
// BASE REPOSITORY CLASS
// =============================================================================

export abstract class BaseRepository<T extends BaseEntity> {
  protected tableName: string;
  protected primaryKey: string = 'id';
  protected tenantColumn?: string; // For multi-tenant tables
  protected softDeleteColumn?: string = 'deleted_at'; // For soft delete support

  constructor(tableName: string, tenantColumn?: string) {
    this.tableName = tableName;
    this.tenantColumn = tenantColumn;
  }

  // =============================================================================
  // ABSTRACT METHODS (must be implemented by child classes)
  // =============================================================================

  /**
   * Map database row to entity object
   */
  protected abstract mapRowToEntity(row: any): T;

  /**
   * Map entity object to database row for inserts/updates
   */
  protected abstract mapEntityToRow(entity: Partial<T>): any;

  // =============================================================================
  // CRUD OPERATIONS
  // =============================================================================

  /**
   * Find entity by ID
   */
  async findById(id: string, organizationId?: string): Promise<T | null> {
    try {
      const query = this.buildSelectQuery({
        filters: [{ field: this.primaryKey, operator: '=', value: id }],
        organizationId,
      });

      const result = await db.query(query.sql, query.params);
      
      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      console.error(`Error finding ${this.tableName} by ID ${id}:`, error);
      throw error;
    }
  }

  /**
   * Find multiple entities with filtering and pagination
   */
  async find(options: QueryOptions = {}): Promise<PaginatedResult<T>> {
    try {
      // Build count query
      const countQuery = this.buildCountQuery(options);
      const countResult = await db.query(countQuery.sql, countQuery.params);
      const total = parseInt(countResult.rows[0].count);

      // Build select query
      const selectQuery = this.buildSelectQuery(options);
      const result = await db.query(selectQuery.sql, selectQuery.params);

      const entities = result.rows.map(row => this.mapRowToEntity(row));

      // Calculate pagination
      const page = options.pagination?.page || 1;
      const limit = options.pagination?.limit || 20;
      const totalPages = Math.ceil(total / limit);

      return {
        data: entities,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      };
    } catch (error) {
      console.error(`Error finding ${this.tableName}:`, error);
      throw error;
    }
  }

  /**
   * Create a new entity
   */
  async create(entity: Omit<T, 'id' | 'created_at' | 'updated_at'>, organizationId?: string): Promise<T> {
    try {
      const id = uuidv4();
      const now = new Date();
      
      const entityWithDefaults = {
        ...entity,
        id,
        created_at: now,
        updated_at: now,
      };

      const row = this.mapEntityToRow(entityWithDefaults);
      
      // Add tenant information if applicable
      if (this.tenantColumn && organizationId) {
        row[this.tenantColumn] = organizationId;
      }

      const columns = Object.keys(row);
      const values = columns.map((_, index) => `$${index + 1}`);
      const params = columns.map(col => row[col]);

      const sql = `
        INSERT INTO ${this.tableName} (${columns.join(', ')})
        VALUES (${values.join(', ')})
        RETURNING *
      `;

      const result = await db.query(sql, params);
      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      console.error(`Error creating ${this.tableName}:`, error);
      throw error;
    }
  }

  /**
   * Update an existing entity
   */
  async update(id: string, updates: Partial<Omit<T, 'id' | 'created_at'>>, organizationId?: string): Promise<T | null> {
    try {
      const updatesWithTimestamp = {
        ...updates,
        updated_at: new Date(),
      };

      const row = this.mapEntityToRow(updatesWithTimestamp);
      
      const columns = Object.keys(row).filter(col => col !== this.primaryKey);
      const setClause = columns.map((col, index) => `${col} = $${index + 1}`).join(', ');
      const params = columns.map(col => row[col]);
      
      // Add ID and organization filter params
      params.push(id);
      let whereClause = `${this.primaryKey} = $${params.length}`;
      
      if (this.tenantColumn && organizationId) {
        params.push(organizationId);
        whereClause += ` AND ${this.tenantColumn} = $${params.length}`;
      }

      if (this.softDeleteColumn) {
        whereClause += ` AND ${this.softDeleteColumn} IS NULL`;
      }

      const sql = `
        UPDATE ${this.tableName}
        SET ${setClause}
        WHERE ${whereClause}
        RETURNING *
      `;

      const result = await db.query(sql, params);
      
      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      console.error(`Error updating ${this.tableName} with ID ${id}:`, error);
      throw error;
    }
  }

  /**
   * Delete an entity (soft delete if supported, otherwise hard delete)
   */
  async delete(id: string, organizationId?: string): Promise<boolean> {
    try {
      let sql: string;
      const params: any[] = [id];
      let whereClause = `${this.primaryKey} = $1`;

      if (this.tenantColumn && organizationId) {
        params.push(organizationId);
        whereClause += ` AND ${this.tenantColumn} = $${params.length}`;
      }

      if (this.softDeleteColumn) {
        // Soft delete
        params.push(new Date());
        sql = `
          UPDATE ${this.tableName}
          SET ${this.softDeleteColumn} = $${params.length}
          WHERE ${whereClause} AND ${this.softDeleteColumn} IS NULL
        `;
      } else {
        // Hard delete
        sql = `DELETE FROM ${this.tableName} WHERE ${whereClause}`;
      }

      const result = await db.query(sql, params);
      return result.rowCount > 0;
    } catch (error) {
      console.error(`Error deleting ${this.tableName} with ID ${id}:`, error);
      throw error;
    }
  }

  // =============================================================================
  // QUERY BUILDING UTILITIES
  // =============================================================================

  /**
   * Build SELECT query with filters, pagination, and tenant isolation
   */
  protected buildSelectQuery(options: QueryOptions = {}): { sql: string; params: any[] } {
    const builder: QueryBuilder = {
      select: ['*'],
      from: this.tableName,
      joins: [],
      where: [],
      orderBy: [],
      params: [],
    };

    // Apply filters
    this.applyFilters(builder, options.filters || []);
    
    // Apply tenant filtering
    if (this.tenantColumn && options.organizationId) {
      builder.where.push(`${this.tableName}.${this.tenantColumn} = $${builder.params.length + 1}`);
      builder.params.push(options.organizationId);
    }

    // Apply soft delete filtering
    if (this.softDeleteColumn && !options.includeSoftDeleted) {
      builder.where.push(`${this.tableName}.${this.softDeleteColumn} IS NULL`);
    }

    // Apply sorting
    if (options.pagination?.sort) {
      const direction = options.pagination.sortDirection || 'ASC';
      builder.orderBy.push(`${options.pagination.sort} ${direction}`);
    } else {
      builder.orderBy.push(`${this.tableName}.created_at DESC`);
    }

    // Apply pagination
    if (options.pagination) {
      const offset = (options.pagination.page - 1) * options.pagination.limit;
      builder.limit = options.pagination.limit;
      builder.offset = offset;
    }

    return this.buildSqlFromQuery(builder);
  }

  /**
   * Build COUNT query for pagination
   */
  protected buildCountQuery(options: QueryOptions = {}): { sql: string; params: any[] } {
    const builder: QueryBuilder = {
      select: ['COUNT(*) as count'],
      from: this.tableName,
      joins: [],
      where: [],
      orderBy: [],
      params: [],
    };

    // Apply filters (same as select query but without pagination)
    this.applyFilters(builder, options.filters || []);
    
    if (this.tenantColumn && options.organizationId) {
      builder.where.push(`${this.tableName}.${this.tenantColumn} = $${builder.params.length + 1}`);
      builder.params.push(options.organizationId);
    }

    if (this.softDeleteColumn && !options.includeSoftDeleted) {
      builder.where.push(`${this.tableName}.${this.softDeleteColumn} IS NULL`);
    }

    return this.buildSqlFromQuery(builder);
  }

  /**
   * Apply filter conditions to query builder
   */
  protected applyFilters(builder: QueryBuilder, filters: FilterCondition[]): void {
    filters.forEach(filter => {
      const paramIndex = builder.params.length + 1;
      
      switch (filter.operator) {
        case '=':
        case '!=':
        case '>':
        case '<':
        case '>=':
        case '<=':
          builder.where.push(`${filter.field} ${filter.operator} $${paramIndex}`);
          builder.params.push(filter.value);
          break;
          
        case 'LIKE':
        case 'ILIKE':
          builder.where.push(`${filter.field} ${filter.operator} $${paramIndex}`);
          builder.params.push(filter.value);
          break;
          
        case 'IN':
          if (filter.values && filter.values.length > 0) {
            const placeholders = filter.values.map((_, i) => `$${paramIndex + i}`).join(', ');
            builder.where.push(`${filter.field} IN (${placeholders})`);
            builder.params.push(...filter.values);
          }
          break;
          
        case 'NOT IN':
          if (filter.values && filter.values.length > 0) {
            const placeholders = filter.values.map((_, i) => `$${paramIndex + i}`).join(', ');
            builder.where.push(`${filter.field} NOT IN (${placeholders})`);
            builder.params.push(...filter.values);
          }
          break;
          
        case 'IS NULL':
          builder.where.push(`${filter.field} IS NULL`);
          break;
          
        case 'IS NOT NULL':
          builder.where.push(`${filter.field} IS NOT NULL`);
          break;
      }
    });
  }

  /**
   * Convert query builder to SQL string and parameters
   */
  protected buildSqlFromQuery(builder: QueryBuilder): { sql: string; params: any[] } {
    let sql = `SELECT ${builder.select.join(', ')} FROM ${builder.from}`;
    
    if (builder.joins.length > 0) {
      sql += ' ' + builder.joins.join(' ');
    }
    
    if (builder.where.length > 0) {
      sql += ' WHERE ' + builder.where.join(' AND ');
    }
    
    if (builder.orderBy.length > 0) {
      sql += ' ORDER BY ' + builder.orderBy.join(', ');
    }
    
    if (builder.limit !== undefined) {
      sql += ` LIMIT ${builder.limit}`;
    }
    
    if (builder.offset !== undefined) {
      sql += ` OFFSET ${builder.offset}`;
    }

    return { sql, params: builder.params };
  }

  // =============================================================================
  // TRANSACTION SUPPORT
  // =============================================================================

  /**
   * Execute operations within a transaction
   */
  async withTransaction<R>(callback: (client: TransactionClient) => Promise<R>): Promise<R> {
    return await db.transaction(callback);
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  /**
   * Check if entity exists
   */
  async exists(id: string, organizationId?: string): Promise<boolean> {
    try {
      const entity = await this.findById(id, organizationId);
      return entity !== null;
    } catch (error) {
      console.error(`Error checking existence of ${this.tableName} with ID ${id}:`, error);
      return false;
    }
  }

  /**
   * Get total count of entities
   */
  async count(organizationId?: string): Promise<number> {
    try {
      const result = await this.find({
        organizationId,
        pagination: { page: 1, limit: 1 }
      });
      return result.pagination.total;
    } catch (error) {
      console.error(`Error counting ${this.tableName}:`, error);
      throw error;
    }
  }

  /**
   * Execute raw SQL query
   */
  protected async query<R = any>(sql: string, params?: any[]): Promise<QueryResult<R>> {
    return await db.query(sql, params);
  }

  /**
   * Escape SQL identifier (table name, column name, etc.)
   */
  protected escapeIdentifier(identifier: string): string {
    return '"' + identifier.replace(/"/g, '""') + '"';
  }

  /**
   * Build UPSERT query (INSERT ... ON CONFLICT)
   */
  protected buildUpsertQuery(
    data: any,
    conflictColumns: string[],
    updateColumns: string[]
  ): { sql: string; params: any[] } {
    const columns = Object.keys(data);
    const values = columns.map((_, index) => `$${index + 1}`);
    const params = columns.map(col => data[col]);

    const updateClause = updateColumns
      .map(col => `${col} = EXCLUDED.${col}`)
      .join(', ');

    const sql = `
      INSERT INTO ${this.tableName} (${columns.join(', ')})
      VALUES (${values.join(', ')})
      ON CONFLICT (${conflictColumns.join(', ')})
      DO UPDATE SET ${updateClause}
      RETURNING *
    `;

    return { sql, params };
  }
}