"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserRepository = void 0;
const uuid_1 = require("uuid");
class UserRepository {
    constructor(pool) {
        this.pool = pool;
    }
    async findByEmail(email) {
        const query = `
      SELECT * FROM users 
      WHERE email = $1 AND deleted_at IS NULL
    `;
        const result = await this.pool.query(query, [email]);
        return result.rows[0] || null;
    }
    async findById(id) {
        const query = `
      SELECT * FROM users 
      WHERE id = $1 AND deleted_at IS NULL
    `;
        const result = await this.pool.query(query, [id]);
        return result.rows[0] || null;
    }
    async createUser(userData) {
        const id = (0, uuid_1.v4)();
        const query = `
      INSERT INTO users (id, email, password_hash, first_name, last_name, avatar_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
        const values = [
            id,
            userData.email,
            userData.password_hash || null,
            userData.first_name || null,
            userData.last_name || null,
            userData.avatar_url || null
        ];
        const result = await this.pool.query(query, values);
        return result.rows[0];
    }
    async updateUser(id, updates) {
        const allowedFields = ['first_name', 'last_name', 'avatar_url', 'timezone', 'locale', 'settings'];
        const sanitizedUpdates = {};
        for (const field of allowedFields) {
            if (field in updates) {
                const value = updates[field];
                if (field === 'first_name' || field === 'last_name') {
                    if (typeof value !== 'string' || value.length > 100) {
                        throw new Error(`Invalid ${field}: must be a string with max 100 characters`);
                    }
                    sanitizedUpdates[field] = value.trim();
                }
                else if (field === 'avatar_url') {
                    if (value !== null && (typeof value !== 'string' || !this.isValidUrl(value))) {
                        throw new Error('Invalid avatar_url: must be a valid URL');
                    }
                    sanitizedUpdates[field] = value;
                }
                else if (field === 'timezone') {
                    const validTimezones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
                        'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
                        'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney'];
                    if (value !== null && !validTimezones.includes(value)) {
                        throw new Error('Invalid timezone');
                    }
                    sanitizedUpdates[field] = value;
                }
                else if (field === 'locale') {
                    const validLocales = ['en', 'es', 'fr', 'de', 'ja', 'zh', 'pt', 'ru'];
                    if (value !== null && !validLocales.includes(value)) {
                        throw new Error('Invalid locale');
                    }
                    sanitizedUpdates[field] = value;
                }
                else if (field === 'settings') {
                    if (value !== null && typeof value !== 'object') {
                        throw new Error('Invalid settings: must be an object');
                    }
                    sanitizedUpdates[field] = value;
                }
            }
        }
        const updateFields = [];
        const values = [];
        let paramCount = 1;
        for (const field of Object.keys(sanitizedUpdates)) {
            updateFields.push(`"${field}" = $${paramCount}`);
            values.push(sanitizedUpdates[field]);
            paramCount++;
        }
        if (updateFields.length === 0) {
            return this.findById(id);
        }
        updateFields.push(`updated_at = NOW()`);
        values.push(id);
        const query = `
      UPDATE users
      SET ${updateFields.join(', ')}
      WHERE id = $${paramCount} AND deleted_at IS NULL
      RETURNING *
    `;
        const result = await this.pool.query(query, values);
        return result.rows[0] || null;
    }
    isValidUrl(url) {
        try {
            new URL(url);
            return true;
        }
        catch {
            return false;
        }
    }
    async verifyEmail(userId) {
        const query = `
      UPDATE users
      SET email_verified_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
    `;
        const result = await this.pool.query(query, [userId]);
        return result.rows[0] || null;
    }
    async updateLastLogin(userId) {
        const query = `
      UPDATE users
      SET last_login_at = NOW()
      WHERE id = $1
    `;
        await this.pool.query(query, [userId]);
    }
    async getUserMemberships(userId) {
        const query = `
      SELECT 
        m.*,
        o.name as organization_name,
        o.slug as organization_slug,
        t.name as team_name,
        t.slug as team_slug
      FROM memberships m
      JOIN organizations o ON m.organization_id = o.id
      LEFT JOIN teams t ON m.team_id = t.id
      WHERE m.user_id = $1
      ORDER BY m.created_at DESC
    `;
        const result = await this.pool.query(query, [userId]);
        return result.rows;
    }
    async getUserOrganizations(userId) {
        const query = `
      SELECT DISTINCT o.*
      FROM organizations o
      JOIN memberships m ON o.id = m.organization_id
      WHERE m.user_id = $1 AND o.deleted_at IS NULL
      ORDER BY o.name
    `;
        const result = await this.pool.query(query, [userId]);
        return result.rows;
    }
    async getMembershipByOrgAndUser(userId, organizationId) {
        const query = `
      SELECT * FROM memberships
      WHERE user_id = $1 AND organization_id = $2 AND team_id IS NULL
    `;
        const result = await this.pool.query(query, [userId, organizationId]);
        return result.rows[0] || null;
    }
    async createMembership(data) {
        const id = (0, uuid_1.v4)();
        const query = `
      INSERT INTO memberships (id, user_id, organization_id, team_id, role, invited_by, invited_at, joined_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING *
    `;
        const values = [
            id,
            data.user_id,
            data.organization_id,
            data.team_id || null,
            data.role,
            data.invited_by || null
        ];
        const result = await this.pool.query(query, values);
        return result.rows[0];
    }
    async updateMembershipRole(membershipId, role) {
        const query = `
      UPDATE memberships
      SET role = $1
      WHERE id = $2
      RETURNING *
    `;
        const result = await this.pool.query(query, [role, membershipId]);
        return result.rows[0] || null;
    }
    async saveRefreshToken(userId, token, expiresAt) {
        const id = (0, uuid_1.v4)();
        const query = `
      INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `;
        await this.pool.query(query, [id, userId, token, expiresAt]);
    }
    async findRefreshToken(token) {
        const query = `
      SELECT * FROM refresh_tokens
      WHERE token = $1 AND revoked_at IS NULL AND expires_at > NOW()
    `;
        const result = await this.pool.query(query, [token]);
        return result.rows[0] || null;
    }
    async revokeRefreshToken(token) {
        const query = `
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE token = $1
    `;
        await this.pool.query(query, [token]);
    }
    async revokeAllUserTokens(userId) {
        const query = `
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
    `;
        await this.pool.query(query, [userId]);
    }
    async cleanupExpiredTokens() {
        const query = `
      DELETE FROM refresh_tokens
      WHERE expires_at < NOW() OR revoked_at < NOW() - INTERVAL '30 days'
    `;
        await this.pool.query(query);
    }
}
exports.UserRepository = UserRepository;
