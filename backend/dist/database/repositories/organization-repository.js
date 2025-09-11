"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizationRepository = exports.OrganizationRepository = void 0;
const uuid_1 = require("uuid");
class OrganizationRepository {
    constructor(pool) {
        this.pool = pool;
    }
    async create(data) {
        const query = `
      INSERT INTO organizations (id, name, slug, description, website_url, billing_email, settings)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
        const values = [
            (0, uuid_1.v4)(),
            data.name,
            data.slug,
            data.description,
            data.website_url,
            data.billing_email,
            JSON.stringify(data.settings),
        ];
        const result = await this.pool.query(query, values);
        return this.mapRowToEntity(result.rows[0]);
    }
    async findById(id) {
        const query = `
      SELECT * FROM organizations 
      WHERE id = $1 AND deleted_at IS NULL
    `;
        const result = await this.pool.query(query, [id]);
        return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    }
    async findBySlug(slug) {
        const query = `
      SELECT * FROM organizations 
      WHERE slug = $1 AND deleted_at IS NULL
    `;
        const result = await this.pool.query(query, [slug]);
        return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    }
    async update(id, data) {
        const fields = [];
        const values = [];
        let paramIndex = 1;
        if (data.name) {
            fields.push(`name = $${paramIndex++}`);
            values.push(data.name);
        }
        if (data.description !== undefined) {
            fields.push(`description = $${paramIndex++}`);
            values.push(data.description);
        }
        if (data.website_url !== undefined) {
            fields.push(`website_url = $${paramIndex++}`);
            values.push(data.website_url);
        }
        if (data.billing_email !== undefined) {
            fields.push(`billing_email = $${paramIndex++}`);
            values.push(data.billing_email);
        }
        if (data.settings) {
            fields.push(`settings = $${paramIndex++}`);
            values.push(JSON.stringify(data.settings));
        }
        if (fields.length === 0) {
            return this.findById(id);
        }
        fields.push(`updated_at = NOW()`);
        values.push(id);
        const query = `
      UPDATE organizations 
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex} AND deleted_at IS NULL
      RETURNING *
    `;
        const result = await this.pool.query(query, values);
        return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    }
    async softDelete(id) {
        const query = `
      UPDATE organizations 
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
    `;
        await this.pool.query(query, [id]);
    }
    mapRowToEntity(row) {
        return {
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            website_url: row.website_url,
            logo_url: row.logo_url,
            settings: typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings || {},
            billing_email: row.billing_email,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at),
            deleted_at: row.deleted_at ? new Date(row.deleted_at) : undefined,
        };
    }
}
exports.OrganizationRepository = OrganizationRepository;
exports.organizationRepository = new OrganizationRepository(null);
