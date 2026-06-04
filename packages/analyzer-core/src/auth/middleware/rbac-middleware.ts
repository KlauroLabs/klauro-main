import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { UserRepository } from '../../database/repositories/user-repository';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
type Permission = 
  | 'org:read'
  | 'org:write'
  | 'org:delete'
  | 'org:billing'
  | 'project:create'
  | 'project:read'
  | 'project:write'
  | 'project:delete'
  | 'project:analyze'
  | 'user:invite'
  | 'user:remove'
  | 'user:update_role'
  | 'team:create'
  | 'team:read'
  | 'team:write'
  | 'team:delete'
  | 'api_key:create'
  | 'api_key:read'
  | 'api_key:delete'
  | 'webhook:create'
  | 'webhook:read'
  | 'webhook:delete';

const ROLE_HIERARCHY: Record<Role, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
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

export class RBACMiddleware {
  private userRepo: UserRepository;

  constructor(private pool: Pool) {
    this.userRepo = new UserRepository(pool);
  }

  requireRole = (...allowedRoles: Role[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!(req as any).userRole) {
        return res.status(403).json({ 
          error: 'Forbidden', 
          message: 'No role assigned for this resource' 
        });
      }

      const userRole = (req as any).userRole as Role;
      if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({ 
          error: 'Forbidden', 
          message: `This action requires one of the following roles: ${allowedRoles.join(', ')}` 
        });
      }

      next();
    };
  };

  requireMinRole = (minRole: Role) => {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!(req as any).userRole) {
        return res.status(403).json({ 
          error: 'Forbidden', 
          message: 'No role assigned for this resource' 
        });
      }

      const userRole = (req as any).userRole as Role;
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

  requirePermission = (...permissions: Permission[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!(req as any).userRole) {
        return res.status(403).json({ 
          error: 'Forbidden', 
          message: 'No role assigned for this resource' 
        });
      }

      const userRole = (req as any).userRole as Role;
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

  requireOwnership = (resourceType: 'project' | 'team' | 'api_key' | 'webhook') => {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!(req as any).userId) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      }

      const resourceId = req.params.id || req.params[`${resourceType}Id`];
      if (!resourceId) {
        return res.status(400).json({ error: 'Bad Request', message: `${resourceType} ID is required` });
      }

      try {
        // Check if user owns the resource or has admin/owner role in the organization
        const isOwner = await this.checkResourceOwnership((req as any).userId, resourceType, resourceId);
        
        if (!isOwner && (req as any).userRole !== 'owner' && (req as any).userRole !== 'admin') {
          return res.status(403).json({ 
            error: 'Forbidden', 
            message: `You don't have permission to modify this ${resourceType}` 
          });
        }

        next();
      } catch (error) {
        return res.status(500).json({ 
          error: 'Internal Server Error', 
          message: 'Failed to verify ownership' 
        });
      }
    };
  };

  requireTeamMembership = async (req: Request, res: Response, next: NextFunction) => {
    if (!(req as any).userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const teamId = req.params.teamId || req.body.teamId;
    if (!teamId) {
      return res.status(400).json({ error: 'Bad Request', message: 'Team ID is required' });
    }

    try {
      const memberships = await this.userRepo.getUserMemberships((req as any).userId);
      const isTeamMember = memberships.some(m => m.team_id === teamId);

      if (!isTeamMember) {
        return res.status(403).json({ 
          error: 'Forbidden', 
          message: 'You are not a member of this team' 
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ 
        error: 'Internal Server Error', 
        message: 'Failed to verify team membership' 
      });
    }
  };

  checkAccess = (resource: string, action: string) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      if (!(req as any).userId) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      }

      // Custom access control logic based on resource and action
      // This can be extended to support more complex permission models
      const permission = `${resource}:${action}` as Permission;
      
      if (!(req as any).userRole) {
        return res.status(403).json({ 
          error: 'Forbidden', 
          message: 'No role assigned for this resource' 
        });
      }

      const userRole = (req as any).userRole as Role;
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

  private async checkResourceOwnership(
    userId: string, 
    resourceType: string, 
    resourceId: string
  ): Promise<boolean> {
    let query: string;

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

  hasPermission(role: Role, permission: Permission): boolean {
    return ROLE_PERMISSIONS[role].includes(permission);
  }

  getRolePermissions(role: Role): Permission[] {
    return ROLE_PERMISSIONS[role];
  }

  compareRoles(role1: Role, role2: Role): number {
    return ROLE_HIERARCHY[role1] - ROLE_HIERARCHY[role2];
  }
}

export function createRBACMiddleware(pool: Pool) {
  return new RBACMiddleware(pool);
}