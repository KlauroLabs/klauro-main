import { Pool } from 'pg';
import { User, Organization, Membership, RefreshToken } from '../../types';
import { BaseRepository } from './base-repository';
import { v4 as uuidv4 } from 'uuid';

export class UserRepository extends BaseRepository {
  constructor(pool: Pool) {
    super(pool, 'users');
  }

  async findByEmail(email: string): Promise<User | null> {
    const query = `
      SELECT * FROM users 
      WHERE email = $1 AND deleted_at IS NULL
    `;
    const result = await this.pool.query(query, [email]);
    return result.rows[0] || null;
  }

  async findById(id: string): Promise<User | null> {
    const query = `
      SELECT * FROM users 
      WHERE id = $1 AND deleted_at IS NULL
    `;
    const result = await this.pool.query(query, [id]);
    return result.rows[0] || null;
  }

  async createUser(userData: {
    email: string;
    password_hash?: string;
    first_name?: string;
    last_name?: string;
    avatar_url?: string;
  }): Promise<User> {
    const id = uuidv4();
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

  async updateUser(id: string, updates: Partial<User>): Promise<User | null> {
    const allowedFields = ['first_name', 'last_name', 'avatar_url', 'timezone', 'locale', 'settings'];
    const updateFields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    for (const field of allowedFields) {
      if (field in updates) {
        updateFields.push(`${field} = $${paramCount}`);
        values.push((updates as any)[field]);
        paramCount++;
      }
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

  async verifyEmail(userId: string): Promise<User | null> {
    const query = `
      UPDATE users
      SET email_verified_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
    `;
    const result = await this.pool.query(query, [userId]);
    return result.rows[0] || null;
  }

  async updateLastLogin(userId: string): Promise<void> {
    const query = `
      UPDATE users
      SET last_login_at = NOW()
      WHERE id = $1
    `;
    await this.pool.query(query, [userId]);
  }

  async getUserMemberships(userId: string): Promise<Membership[]> {
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

  async getUserOrganizations(userId: string): Promise<Organization[]> {
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

  async getMembershipByOrgAndUser(userId: string, organizationId: string): Promise<Membership | null> {
    const query = `
      SELECT * FROM memberships
      WHERE user_id = $1 AND organization_id = $2 AND team_id IS NULL
    `;
    const result = await this.pool.query(query, [userId, organizationId]);
    return result.rows[0] || null;
  }

  async createMembership(data: {
    user_id: string;
    organization_id: string;
    team_id?: string;
    role: 'owner' | 'admin' | 'member' | 'viewer';
    invited_by?: string;
  }): Promise<Membership> {
    const id = uuidv4();
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

  async updateMembershipRole(membershipId: string, role: string): Promise<Membership | null> {
    const query = `
      UPDATE memberships
      SET role = $1
      WHERE id = $2
      RETURNING *
    `;
    const result = await this.pool.query(query, [role, membershipId]);
    return result.rows[0] || null;
  }

  async saveRefreshToken(userId: string, token: string, expiresAt: Date): Promise<void> {
    const id = uuidv4();
    const query = `
      INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `;
    await this.pool.query(query, [id, userId, token, expiresAt]);
  }

  async findRefreshToken(token: string): Promise<RefreshToken | null> {
    const query = `
      SELECT * FROM refresh_tokens
      WHERE token = $1 AND revoked_at IS NULL AND expires_at > NOW()
    `;
    const result = await this.pool.query(query, [token]);
    return result.rows[0] || null;
  }

  async revokeRefreshToken(token: string): Promise<void> {
    const query = `
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE token = $1
    `;
    await this.pool.query(query, [token]);
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    const query = `
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
    `;
    await this.pool.query(query, [userId]);
  }

  async cleanupExpiredTokens(): Promise<void> {
    const query = `
      DELETE FROM refresh_tokens
      WHERE expires_at < NOW() OR revoked_at < NOW() - INTERVAL '30 days'
    `;
    await this.pool.query(query);
  }
}