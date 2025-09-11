"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RBACMiddleware = void 0;
exports.createRBACMiddleware = createRBACMiddleware;
const user_repository_1 = require("../../database/repositories/user-repository");
const ROLE_HIERARCHY = {
    owner: 4,
    admin: 3,
    member: 2,
    viewer: 1,
};
const ROLE_PERMISSIONS = {
    owner: [
        'org:read', 'org:write', 'org:delete', 'org:billing',
        'project:create', 'project:read', 'project:write', 'project:delete', 'project:analyze',
        'user:invite', 'user:remove', 'user:update_role',
        'team:create', 'team:read', 'team:write', 'team:delete',
        'api_key:create', 'api_key:read', 'api_key:delete',
        'webhook:create', 'webhook:read', 'webhook:delete',
    ],
    admin: [
        'org:read', 'org:write',
        'project:create', 'project:read', 'project:write', 'project:delete', 'project:analyze',
        'user:invite', 'user:remove',
        'team:create', 'team:read', 'team:write', 'team:delete',
        'api_key:create', 'api_key:read', 'api_key:delete',
        'webhook:create', 'webhook:read', 'webhook:delete',
    ],
    member: [
        'org:read',
        'project:create', 'project:read', 'project:write', 'project:analyze',
        'team:read', 'team:write',
        'api_key:create', 'api_key:read',
        'webhook:read',
    ],
    viewer: [
        'org:read',
        'project:read',
        'team:read',
        'api_key:read',
        'webhook:read',
    ],
};
class RBACMiddleware {
    constructor(pool) {
        this.pool = pool;
        this.requireRole = (...allowedRoles) => {
            return (req, res, next) => {
                if (!req.userRole) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: 'No role assigned for this resource'
                    });
                }
                const userRole = req.userRole;
                if (!allowedRoles.includes(userRole)) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: `This action requires one of the following roles: ${allowedRoles.join(', ')}`
                    });
                }
                next();
            };
        };
        this.requireMinRole = (minRole) => {
            return (req, res, next) => {
                if (!req.userRole) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: 'No role assigned for this resource'
                    });
                }
                const userRole = req.userRole;
                const userRoleLevel = ROLE_HIERARCHY[userRole];
                const minRoleLevel = ROLE_HIERARCHY[minRole];
                if (userRoleLevel < minRoleLevel) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: `This action requires at least ${minRole} role`
                    });
                }
                next();
            };
        };
        this.requirePermission = (...permissions) => {
            return (req, res, next) => {
                if (!req.userRole) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: 'No role assigned for this resource'
                    });
                }
                const userRole = req.userRole;
                const userPermissions = ROLE_PERMISSIONS[userRole];
                const hasPermission = permissions.some(permission => userPermissions.includes(permission));
                if (!hasPermission) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: `You don't have permission to perform this action`
                    });
                }
                next();
            };
        };
        this.requireOwnership = (resourceType) => {
            return async (req, res, next) => {
                if (!req.userId) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
                }
                const resourceId = req.params.id || req.params[`${resourceType}Id`];
                if (!resourceId) {
                    return res.status(400).json({ error: 'Bad Request', message: `${resourceType} ID is required` });
                }
                try {
                    const isOwner = await this.checkResourceOwnership(req.userId, resourceType, resourceId);
                    if (!isOwner && req.userRole !== 'owner' && req.userRole !== 'admin') {
                        return res.status(403).json({
                            error: 'Forbidden',
                            message: `You don't have permission to modify this ${resourceType}`
                        });
                    }
                    next();
                }
                catch (error) {
                    return res.status(500).json({
                        error: 'Internal Server Error',
                        message: 'Failed to verify ownership'
                    });
                }
            };
        };
        this.requireTeamMembership = async (req, res, next) => {
            if (!req.userId) {
                return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
            }
            const teamId = req.params.teamId || req.body.teamId;
            if (!teamId) {
                return res.status(400).json({ error: 'Bad Request', message: 'Team ID is required' });
            }
            try {
                const memberships = await this.userRepo.getUserMemberships(req.userId);
                const isTeamMember = memberships.some(m => m.team_id === teamId);
                if (!isTeamMember) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: 'You are not a member of this team'
                    });
                }
                next();
            }
            catch (error) {
                return res.status(500).json({
                    error: 'Internal Server Error',
                    message: 'Failed to verify team membership'
                });
            }
        };
        this.checkAccess = (resource, action) => {
            return async (req, res, next) => {
                if (!req.userId) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
                }
                const permission = `${resource}:${action}`;
                if (!req.userRole) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: 'No role assigned for this resource'
                    });
                }
                const userRole = req.userRole;
                const userPermissions = ROLE_PERMISSIONS[userRole];
                if (!userPermissions.includes(permission)) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: `You don't have permission to ${action} ${resource}`
                    });
                }
                next();
            };
        };
        this.userRepo = new user_repository_1.UserRepository(pool);
    }
    async checkResourceOwnership(userId, resourceType, resourceId) {
        let query;
        switch (resourceType) {
            case 'project':
                query = `
          SELECT COUNT(*) as count
          FROM projects p
          JOIN memberships m ON p.organization_id = m.organization_id
          WHERE p.id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'admin')
        `;
                break;
            case 'team':
                query = `
          SELECT COUNT(*) as count
          FROM teams t
          JOIN memberships m ON t.organization_id = m.organization_id
          WHERE t.id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'admin')
        `;
                break;
            case 'api_key':
                query = `
          SELECT COUNT(*) as count
          FROM api_keys
          WHERE id = $1 AND user_id = $2
        `;
                break;
            case 'webhook':
                query = `
          SELECT COUNT(*) as count
          FROM webhooks w
          JOIN projects p ON w.project_id = p.id
          JOIN memberships m ON p.organization_id = m.organization_id
          WHERE w.id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'admin')
        `;
                break;
            default:
                return false;
        }
        const result = await this.pool.query(query, [resourceId, userId]);
        return result.rows[0].count > 0;
    }
    hasPermission(role, permission) {
        return ROLE_PERMISSIONS[role].includes(permission);
    }
    getRolePermissions(role) {
        return ROLE_PERMISSIONS[role];
    }
    compareRoles(role1, role2) {
        return ROLE_HIERARCHY[role1] - ROLE_HIERARCHY[role2];
    }
}
exports.RBACMiddleware = RBACMiddleware;
function createRBACMiddleware(pool) {
    return new RBACMiddleware(pool);
}
