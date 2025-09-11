"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseRepository = void 0;
const uuid_1 = require("uuid");
const connection_1 = __importDefault(require("../connection"));
class BaseRepository {
    constructor(tableName, tenantColumn) {
        this.primaryKey = 'id';
        this.softDeleteColumn = 'deleted_at';
        this.tableName = tableName;
        this.tenantColumn = tenantColumn;
    }
    async findById(id, organizationId) {
        try {
            const query = this.buildSelectQuery({
                filters: [{ field: this.primaryKey, operator: '=', value: id }],
                organizationId,
            });
            const result = await connection_1.default.query(query.sql, query.params);
            if (result.rows.length === 0) {
                return null;
            }
            return this.mapRowToEntity(result.rows[0]);
        }
        catch (error) {
            console.error(`Error finding ${this.tableName} by ID ${id}:`, error);
            throw error;
        }
    }
    async find(options = {}) {
        try {
            const countQuery = this.buildCountQuery(options);
            const countResult = await connection_1.default.query(countQuery.sql, countQuery.params);
            const total = parseInt(countResult.rows[0].count);
            const selectQuery = this.buildSelectQuery(options);
            const result = await connection_1.default.query(selectQuery.sql, selectQuery.params);
            const entities = result.rows.map(row => this.mapRowToEntity(row));
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
        }
        catch (error) {
            console.error(`Error finding ${this.tableName}:`, error);
            throw error;
        }
    }
    async create(entity, organizationId) {
        try {
            const id = (0, uuid_1.v4)();
            const now = new Date();
            const entityWithDefaults = {
                ...entity,
                id,
                created_at: now,
                updated_at: now,
            };
            const row = this.mapEntityToRow(entityWithDefaults);
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
            const result = await connection_1.default.query(sql, params);
            return this.mapRowToEntity(result.rows[0]);
        }
        catch (error) {
            console.error(`Error creating ${this.tableName}:`, error);
            throw error;
        }
    }
    async update(id, updates, organizationId) {
        try {
            const updatesWithTimestamp = {
                ...updates,
                updated_at: new Date(),
            };
            const row = this.mapEntityToRow(updatesWithTimestamp);
            const columns = Object.keys(row).filter(col => col !== this.primaryKey);
            const setClause = columns.map((col, index) => `${col} = $${index + 1}`).join(', ');
            const params = columns.map(col => row[col]);
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
            const result = await connection_1.default.query(sql, params);
            if (result.rows.length === 0) {
                return null;
            }
            return this.mapRowToEntity(result.rows[0]);
        }
        catch (error) {
            console.error(`Error updating ${this.tableName} with ID ${id}:`, error);
            throw error;
        }
    }
    async delete(id, organizationId) {
        try {
            let sql;
            const params = [id];
            let whereClause = `${this.primaryKey} = $1`;
            if (this.tenantColumn && organizationId) {
                params.push(organizationId);
                whereClause += ` AND ${this.tenantColumn} = $${params.length}`;
            }
            if (this.softDeleteColumn) {
                params.push(new Date());
                sql = `
          UPDATE ${this.tableName}
          SET ${this.softDeleteColumn} = $${params.length}
          WHERE ${whereClause} AND ${this.softDeleteColumn} IS NULL
        `;
            }
            else {
                sql = `DELETE FROM ${this.tableName} WHERE ${whereClause}`;
            }
            const result = await connection_1.default.query(sql, params);
            return result.rowCount > 0;
        }
        catch (error) {
            console.error(`Error deleting ${this.tableName} with ID ${id}:`, error);
            throw error;
        }
    }
    buildSelectQuery(options = {}) {
        const builder = {
            select: ['*'],
            from: this.tableName,
            joins: [],
            where: [],
            orderBy: [],
            params: [],
        };
        this.applyFilters(builder, options.filters || []);
        if (this.tenantColumn && options.organizationId) {
            builder.where.push(`${this.tableName}.${this.tenantColumn} = $${builder.params.length + 1}`);
            builder.params.push(options.organizationId);
        }
        if (this.softDeleteColumn && !options.includeSoftDeleted) {
            builder.where.push(`${this.tableName}.${this.softDeleteColumn} IS NULL`);
        }
        if (options.pagination?.sort) {
            const direction = options.pagination.sortDirection || 'ASC';
            builder.orderBy.push(`${options.pagination.sort} ${direction}`);
        }
        else {
            builder.orderBy.push(`${this.tableName}.created_at DESC`);
        }
        if (options.pagination) {
            const offset = (options.pagination.page - 1) * options.pagination.limit;
            builder.limit = options.pagination.limit;
            builder.offset = offset;
        }
        return this.buildSqlFromQuery(builder);
    }
    buildCountQuery(options = {}) {
        const builder = {
            select: ['COUNT(*) as count'],
            from: this.tableName,
            joins: [],
            where: [],
            orderBy: [],
            params: [],
        };
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
    applyFilters(builder, filters) {
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
    buildSqlFromQuery(builder) {
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
    async withTransaction(callback) {
        return await connection_1.default.transaction(callback);
    }
    async exists(id, organizationId) {
        try {
            const entity = await this.findById(id, organizationId);
            return entity !== null;
        }
        catch (error) {
            console.error(`Error checking existence of ${this.tableName} with ID ${id}:`, error);
            return false;
        }
    }
    async count(organizationId) {
        try {
            const result = await this.find({
                organizationId,
                pagination: { page: 1, limit: 1 }
            });
            return result.pagination.total;
        }
        catch (error) {
            console.error(`Error counting ${this.tableName}:`, error);
            throw error;
        }
    }
    async query(sql, params) {
        return await connection_1.default.query(sql, params);
    }
    escapeIdentifier(identifier) {
        return '"' + identifier.replace(/"/g, '""') + '"';
    }
    buildUpsertQuery(data, conflictColumns, updateColumns) {
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
exports.BaseRepository = BaseRepository;
