"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectRepository = exports.ProjectRepository = void 0;
const base_repository_1 = require("./base-repository");
class ProjectRepository extends base_repository_1.BaseRepository {
    constructor() {
        super('projects', 'organization_id');
    }
    mapRowToEntity(row) {
        return {
            id: row.id,
            organization_id: row.organization_id,
            team_id: row.team_id,
            name: row.name,
            description: row.description,
            repository_url: row.repository_url,
            repository_provider: row.repository_provider,
            repository_id: row.repository_id,
            default_branch: row.default_branch || 'main',
            language: row.language,
            framework: row.framework,
            status: row.status || 'active',
            settings: row.settings || {},
            last_analyzed_at: row.last_analyzed_at ? new Date(row.last_analyzed_at) : undefined,
            created_at: new Date(row.created_at),
            updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
        };
    }
    mapEntityToRow(entity) {
        return {
            id: entity.id,
            organization_id: entity.organization_id,
            team_id: entity.team_id,
            name: entity.name,
            description: entity.description,
            repository_url: entity.repository_url,
            repository_provider: entity.repository_provider,
            repository_id: entity.repository_id,
            default_branch: entity.default_branch,
            language: entity.language,
            framework: entity.framework,
            status: entity.status,
            settings: entity.settings ? JSON.stringify(entity.settings) : null,
            last_analyzed_at: entity.last_analyzed_at,
            created_at: entity.created_at,
            updated_at: entity.updated_at,
        };
    }
    async findByName(name, organizationId) {
        try {
            const result = await this.find({
                filters: [{ field: 'name', operator: '=', value: name }],
                organizationId,
                pagination: { page: 1, limit: 1 },
            });
            return result.data.length > 0 ? result.data[0] : null;
        }
        catch (error) {
            console.error(`Error finding project by name ${name}:`, error);
            throw error;
        }
    }
    async findWithStats(id, organizationId) {
        try {
            const sql = `
        SELECT 
          p.*,
          COALESCE(analysis_stats.analysis_count, 0) as analysis_count,
          COALESCE(component_stats.component_count, 0) as component_count,
          latest_analysis.status as last_analysis_status,
          COALESCE(health_stats.avg_health_score, 0) as health_score,
          COALESCE(error_stats.error_count, 0) as error_count,
          COALESCE(telemetry_stats.event_count, 0) as telemetry_events_count
        FROM projects p
        LEFT JOIN (
          SELECT 
            project_id, 
            COUNT(*) as analysis_count
          FROM analysis_runs 
          GROUP BY project_id
        ) analysis_stats ON p.id = analysis_stats.project_id
        LEFT JOIN (
          SELECT 
            ar.project_id,
            COUNT(c.id) as component_count
          FROM analysis_runs ar
          JOIN components c ON ar.id = c.analysis_run_id
          WHERE ar.status = 'completed'
          GROUP BY ar.project_id
        ) component_stats ON p.id = component_stats.project_id
        LEFT JOIN (
          SELECT DISTINCT ON (project_id)
            project_id,
            status
          FROM analysis_runs
          ORDER BY project_id, completed_at DESC NULLS LAST
        ) latest_analysis ON p.id = latest_analysis.project_id
        LEFT JOIN (
          SELECT 
            project_id,
            AVG(health_score) as avg_health_score
          FROM component_daily_health
          WHERE day_bucket >= NOW() - INTERVAL '7 days'
          GROUP BY project_id
        ) health_stats ON p.id = health_stats.project_id
        LEFT JOIN (
          SELECT 
            project_id,
            COUNT(*) as error_count
          FROM error_tracking
          WHERE status = 'active'
          GROUP BY project_id
        ) error_stats ON p.id = error_stats.project_id
        LEFT JOIN (
          SELECT 
            project_id,
            COUNT(*) as event_count
          FROM telemetry_events
          WHERE timestamp >= NOW() - INTERVAL '24 hours'
          GROUP BY project_id
        ) telemetry_stats ON p.id = telemetry_stats.project_id
        WHERE p.id = $1 AND p.organization_id = $2
      `;
            const result = await this.query(sql, [id, organizationId]);
            if (result.rows.length === 0) {
                return null;
            }
            const row = result.rows[0];
            const project = this.mapRowToEntity(row);
            return {
                ...project,
                analysis_count: parseInt(row.analysis_count),
                component_count: parseInt(row.component_count),
                last_analysis_status: row.last_analysis_status,
                health_score: parseFloat(row.health_score) || 0,
                error_count: parseInt(row.error_count),
                telemetry_events_count: parseInt(row.telemetry_events_count),
            };
        }
        catch (error) {
            console.error(`Error finding project with stats for ID ${id}:`, error);
            throw error;
        }
    }
    async findByRepositoryUrl(repositoryUrl, organizationId) {
        try {
            const result = await this.find({
                filters: [{ field: 'repository_url', operator: '=', value: repositoryUrl }],
                organizationId,
            });
            return result.data;
        }
        catch (error) {
            console.error(`Error finding projects by repository URL ${repositoryUrl}:`, error);
            throw error;
        }
    }
    async updateAnalysisStatus(id, status, organizationId, lastAnalyzedAt) {
        try {
            const updateData = { status };
            if (lastAnalyzedAt) {
                updateData.last_analyzed_at = lastAnalyzedAt;
            }
            return await this.update(id, updateData, organizationId);
        }
        catch (error) {
            console.error(`Error updating analysis status for project ${id}:`, error);
            throw error;
        }
    }
    async findStaleProjects(organizationId, staleThreshold) {
        try {
            const result = await this.find({
                filters: [
                    { field: 'status', operator: '=', value: 'active' },
                    { field: 'last_analyzed_at', operator: '<', value: staleThreshold },
                ],
                organizationId,
            });
            return result.data;
        }
        catch (error) {
            console.error('Error finding stale projects:', error);
            throw error;
        }
    }
    async getDashboardSummary(organizationId) {
        try {
            const sql = `
        WITH project_stats AS (
          SELECT 
            COUNT(*) as total_projects,
            COUNT(CASE WHEN status = 'active' THEN 1 END) as active_projects,
            COUNT(CASE WHEN status = 'analyzing' THEN 1 END) as analyzing_projects,
            COUNT(CASE WHEN status = 'error' THEN 1 END) as error_projects
          FROM projects 
          WHERE organization_id = $1
        ),
        analysis_stats AS (
          SELECT COUNT(*) as recent_analysis_count
          FROM analysis_runs ar
          JOIN projects p ON ar.project_id = p.id
          WHERE p.organization_id = $1
            AND ar.created_at >= NOW() - INTERVAL '24 hours'
        ),
        component_stats AS (
          SELECT COUNT(*) as total_components
          FROM components c
          JOIN analysis_runs ar ON c.analysis_run_id = ar.id
          JOIN projects p ON ar.project_id = p.id
          WHERE p.organization_id = $1
            AND ar.status = 'completed'
        ),
        error_stats AS (
          SELECT COUNT(*) as active_errors
          FROM error_tracking et
          JOIN projects p ON et.project_id = p.id
          WHERE p.organization_id = $1
            AND et.status = 'active'
        ),
        health_stats AS (
          SELECT AVG(health_score) as avg_health_score
          FROM component_daily_health cdh
          JOIN projects p ON cdh.project_id = p.id
          WHERE p.organization_id = $1
            AND cdh.day_bucket >= NOW() - INTERVAL '7 days'
        )
        SELECT 
          ps.total_projects,
          ps.active_projects,
          ps.analyzing_projects,
          ps.error_projects,
          COALESCE(as_stats.recent_analysis_count, 0) as recent_analysis_count,
          COALESCE(cs.total_components, 0) as total_components,
          COALESCE(es.active_errors, 0) as active_errors,
          COALESCE(hs.avg_health_score, 0) as avg_health_score
        FROM project_stats ps
        CROSS JOIN analysis_stats as_stats
        CROSS JOIN component_stats cs
        CROSS JOIN error_stats es
        CROSS JOIN health_stats hs
      `;
            const result = await this.query(sql, [organizationId]);
            if (result.rows.length === 0) {
                return {
                    total_projects: 0,
                    active_projects: 0,
                    analyzing_projects: 0,
                    error_projects: 0,
                    recent_analysis_count: 0,
                    total_components: 0,
                    active_errors: 0,
                    avg_health_score: 0,
                };
            }
            const row = result.rows[0];
            return {
                total_projects: parseInt(row.total_projects),
                active_projects: parseInt(row.active_projects),
                analyzing_projects: parseInt(row.analyzing_projects),
                error_projects: parseInt(row.error_projects),
                recent_analysis_count: parseInt(row.recent_analysis_count),
                total_components: parseInt(row.total_components),
                active_errors: parseInt(row.active_errors),
                avg_health_score: parseFloat(row.avg_health_score) || 0,
            };
        }
        catch (error) {
            console.error('Error getting dashboard summary:', error);
            throw error;
        }
    }
    async createWithUsageTracking(projectData, client) {
        const executeInTransaction = async (transactionClient) => {
            const projectWithStatus = {
                ...projectData,
                status: 'active'
            };
            const project = await this.create(projectWithStatus, projectData.organization_id);
            const usageSql = `
        SELECT update_usage_tracking($1, 'projects', 1)
      `;
            await transactionClient.query(usageSql, [projectData.organization_id]);
            return project;
        };
        if (client) {
            return await executeInTransaction(client);
        }
        else {
            return await this.withTransaction(executeInTransaction);
        }
    }
    async archiveProject(id, organizationId) {
        return await this.withTransaction(async (client) => {
            const project = await this.update(id, { status: 'archived' }, organizationId);
            if (!project) {
                return false;
            }
            const usageSql = `
        SELECT update_usage_tracking($1, 'projects', -1)
      `;
            await client.query(usageSql, [organizationId]);
            return true;
        });
    }
    async getActivityTimeline(id, organizationId, limit = 50) {
        try {
            const sql = `
        (
          SELECT 
            'analysis' as activity_type,
            ar.id as activity_id,
            ar.status as activity_status,
            ar.started_at as activity_time,
            JSON_BUILD_OBJECT(
              'commit_sha', ar.commit_sha,
              'branch', ar.branch,
              'processing_time_ms', ar.processing_time_ms
            ) as activity_data
          FROM analysis_runs ar
          WHERE ar.project_id = $1
        )
        UNION ALL
        (
          SELECT 
            'error' as activity_type,
            et.id as activity_id,
            et.status as activity_status,
            et.first_seen as activity_time,
            JSON_BUILD_OBJECT(
              'error_type', et.error_type,
              'error_message', et.error_message,
              'occurrence_count', et.occurrence_count
            ) as activity_data
          FROM error_tracking et
          WHERE et.project_id = $1
        )
        ORDER BY activity_time DESC
        LIMIT $2
      `;
            const result = await this.query(sql, [id, limit]);
            return result.rows;
        }
        catch (error) {
            console.error(`Error getting activity timeline for project ${id}:`, error);
            throw error;
        }
    }
}
exports.ProjectRepository = ProjectRepository;
exports.projectRepository = new ProjectRepository();
