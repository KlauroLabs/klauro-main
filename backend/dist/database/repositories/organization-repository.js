"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizationRepository = exports.OrganizationRepository = void 0;
const base_repository_1 = require("./base-repository");
class OrganizationRepository extends base_repository_1.BaseRepository {
    constructor() {
        super('organizations');
    }
    mapRowToEntity(row) {
        return {
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            website_url: row.website_url,
            logo_url: row.logo_url,
            settings: row.settings || {},
            billing_email: row.billing_email,
            created_at: new Date(row.created_at),
            updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
            deleted_at: row.deleted_at ? new Date(row.deleted_at) : undefined,
        };
    }
    mapEntityToRow(entity) {
        return {
            id: entity.id,
            name: entity.name,
            slug: entity.slug,
            description: entity.description,
            website_url: entity.website_url,
            logo_url: entity.logo_url,
            settings: entity.settings ? JSON.stringify(entity.settings) : null,
            billing_email: entity.billing_email,
            created_at: entity.created_at,
            updated_at: entity.updated_at,
            deleted_at: entity.deleted_at,
        };
    }
    async findBySlug(slug) {
        try {
            const result = await this.find({
                filters: [{ field: 'slug', operator: '=', value: slug }],
                pagination: { page: 1, limit: 1 },
            });
            return result.data.length > 0 ? result.data[0] : null;
        }
        catch (error) {
            console.error(`Error finding organization by slug ${slug}:`, error);
            throw error;
        }
    }
    async isSlugAvailable(slug, excludeId) {
        try {
            const filters = [{ field: 'slug', operator: '=', value: slug }];
            if (excludeId) {
                filters.push({ field: 'id', operator: '!=', value: excludeId });
            }
            const result = await this.find({
                filters,
                pagination: { page: 1, limit: 1 },
            });
            return result.data.length === 0;
        }
        catch (error) {
            console.error(`Error checking slug availability for ${slug}:`, error);
            throw error;
        }
    }
    async createWithInitialSetup(organizationData, adminUserId, client) {
        const executeInTransaction = async (transactionClient) => {
            const orgRow = this.mapEntityToRow({
                ...organizationData,
                id: undefined,
                created_at: new Date(),
                updated_at: new Date(),
            });
            const orgColumns = Object.keys(orgRow);
            const orgValues = orgColumns.map((_, index) => `$${index + 1}`);
            const orgParams = orgColumns.map(col => orgRow[col]);
            const orgSql = `
        INSERT INTO organizations (${orgColumns.join(', ')})
        VALUES (${orgValues.join(', ')})
        RETURNING *
      `;
            const orgResult = await transactionClient.query(orgSql, orgParams);
            const organization = this.mapRowToEntity(orgResult.rows[0]);
            const membershipSql = `
        INSERT INTO memberships (user_id, organization_id, role, joined_at, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `;
            await transactionClient.query(membershipSql, [
                adminUserId,
                organization.id,
                'owner',
                new Date(),
                new Date(),
            ]);
            const subscriptionSql = `
        INSERT INTO subscriptions (
          organization_id, 
          plan_id, 
          status, 
          current_period_start, 
          current_period_end,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          (SELECT id FROM subscription_plans WHERE name = 'Free' LIMIT 1),
          $2,
          $3,
          $4,
          $5,
          $6
        )
      `;
            const periodStart = new Date();
            periodStart.setDate(1);
            const periodEnd = new Date(periodStart);
            periodEnd.setMonth(periodEnd.getMonth() + 1);
            await transactionClient.query(subscriptionSql, [
                organization.id,
                'active',
                periodStart,
                periodEnd,
                new Date(),
                new Date(),
            ]);
            const usageSql = `
        INSERT INTO usage_tracking (
          organization_id,
          metric_name,
          metric_value,
          period_start,
          period_end,
          created_at,
          updated_at
        )
        VALUES 
          ($1, 'projects', 0, $2, $3, $4, $5),
          ($1, 'team_members', 1, $2, $3, $4, $5),
          ($1, 'telemetry_events', 0, $2, $3, $4, $5),
          ($1, 'analysis_runs', 0, $2, $3, $4, $5),
          ($1, 'storage_mb', 0, $2, $3, $4, $5)
      `;
            await transactionClient.query(usageSql, [
                organization.id,
                periodStart,
                periodEnd,
                new Date(),
                new Date(),
            ]);
            return organization;
        };
        if (client) {
            return await executeInTransaction(client);
        }
        else {
            return await this.withTransaction(executeInTransaction);
        }
    }
    async findWithStats(id) {
        try {
            const sql = `
        SELECT 
          o.*,
          COALESCE(member_stats.member_count, 0) as member_count,
          COALESCE(project_stats.project_count, 0) as project_count,
          COALESCE(sp.name, 'No Plan') as current_plan,
          COALESCE(s.status, 'inactive') as subscription_status,
          COALESCE(usage_stats.projects, 0) as usage_projects,
          COALESCE(usage_stats.team_members, 0) as usage_team_members,
          COALESCE(usage_stats.telemetry_events, 0) as usage_telemetry_events,
          COALESCE(usage_stats.analysis_runs, 0) as usage_analysis_runs,
          COALESCE(usage_stats.storage_mb, 0) as usage_storage_mb
        FROM organizations o
        LEFT JOIN (
          SELECT 
            organization_id, 
            COUNT(*) as member_count
          FROM memberships 
          WHERE team_id IS NULL 
          GROUP BY organization_id
        ) member_stats ON o.id = member_stats.organization_id
        LEFT JOIN (
          SELECT 
            organization_id, 
            COUNT(*) as project_count
          FROM projects 
          WHERE status = 'active'
          GROUP BY organization_id
        ) project_stats ON o.id = project_stats.organization_id
        LEFT JOIN subscriptions s ON o.id = s.organization_id AND s.status = 'active'
        LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
        LEFT JOIN (
          SELECT 
            organization_id,
            SUM(CASE WHEN metric_name = 'projects' THEN metric_value ELSE 0 END) as projects,
            SUM(CASE WHEN metric_name = 'team_members' THEN metric_value ELSE 0 END) as team_members,
            SUM(CASE WHEN metric_name = 'telemetry_events' THEN metric_value ELSE 0 END) as telemetry_events,
            SUM(CASE WHEN metric_name = 'analysis_runs' THEN metric_value ELSE 0 END) as analysis_runs,
            SUM(CASE WHEN metric_name = 'storage_mb' THEN metric_value ELSE 0 END) as storage_mb
          FROM usage_tracking 
          WHERE period_start >= DATE_TRUNC('month', NOW())
          GROUP BY organization_id
        ) usage_stats ON o.id = usage_stats.organization_id
        WHERE o.id = $1 AND o.deleted_at IS NULL
      `;
            const result = await this.query(sql, [id]);
            if (result.rows.length === 0) {
                return null;
            }
            const row = result.rows[0];
            const organization = this.mapRowToEntity(row);
            return {
                ...organization,
                member_count: parseInt(row.member_count),
                project_count: parseInt(row.project_count),
                current_plan: row.current_plan,
                subscription_status: row.subscription_status,
                usage_summary: {
                    projects: parseInt(row.usage_projects),
                    team_members: parseInt(row.usage_team_members),
                    telemetry_events: parseInt(row.usage_telemetry_events),
                    analysis_runs: parseInt(row.usage_analysis_runs),
                    storage_mb: parseInt(row.usage_storage_mb),
                },
            };
        }
        catch (error) {
            console.error(`Error finding organization with stats for ID ${id}:`, error);
            throw error;
        }
    }
    async findByUserId(userId) {
        try {
            const sql = `
        SELECT 
          o.*,
          m.role,
          m.team_id
        FROM organizations o
        INNER JOIN memberships m ON o.id = m.organization_id
        WHERE m.user_id = $1 
          AND o.deleted_at IS NULL
        ORDER BY o.name ASC
      `;
            const result = await this.query(sql, [userId]);
            return result.rows.map(row => ({
                ...this.mapRowToEntity(row),
                role: row.role,
                team_id: row.team_id,
            }));
        }
        catch (error) {
            console.error(`Error finding organizations for user ${userId}:`, error);
            throw error;
        }
    }
    async updateSettings(id, settings) {
        try {
            const sql = `
        UPDATE organizations 
        SET 
          settings = $2,
          updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *
      `;
            const result = await this.query(sql, [id, JSON.stringify(settings)]);
            if (result.rows.length === 0) {
                return null;
            }
            return this.mapRowToEntity(result.rows[0]);
        }
        catch (error) {
            console.error(`Error updating settings for organization ${id}:`, error);
            throw error;
        }
    }
    async hasUserAccess(organizationId, userId, requiredRole) {
        try {
            const roleHierarchy = ['viewer', 'member', 'admin', 'owner'];
            let sql = `
        SELECT m.role
        FROM memberships m
        WHERE m.organization_id = $1 AND m.user_id = $2
      `;
            const result = await this.query(sql, [organizationId, userId]);
            if (result.rows.length === 0) {
                return false;
            }
            if (!requiredRole) {
                return true;
            }
            const userRole = result.rows[0].role;
            const userRoleIndex = roleHierarchy.indexOf(userRole);
            const requiredRoleIndex = roleHierarchy.indexOf(requiredRole);
            return userRoleIndex >= requiredRoleIndex;
        }
        catch (error) {
            console.error(`Error checking user access for organization ${organizationId}:`, error);
            return false;
        }
    }
    async getCurrentUsage(organizationId) {
        try {
            const sql = `
        SELECT 
          metric_name,
          metric_value
        FROM usage_tracking
        WHERE organization_id = $1
          AND period_start >= DATE_TRUNC('month', NOW())
          AND period_end <= DATE_TRUNC('month', NOW()) + INTERVAL '1 month'
      `;
            const result = await this.query(sql, [organizationId]);
            const usage = {};
            result.rows.forEach(row => {
                usage[row.metric_name] = parseInt(row.metric_value);
            });
            return usage;
        }
        catch (error) {
            console.error(`Error getting current usage for organization ${organizationId}:`, error);
            throw error;
        }
    }
}
exports.OrganizationRepository = OrganizationRepository;
exports.organizationRepository = new OrganizationRepository();
