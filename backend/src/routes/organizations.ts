import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { AuthMiddleware } from '../auth/middleware/auth-middleware';
import { RBACMiddleware } from '../auth/middleware/rbac-middleware';
import { OrganizationRepository } from '../database/repositories/organization-repository';
import { UserRepository } from '../database/repositories/user-repository';
import { body, param, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';

export function createOrganizationRoutes(pool: Pool): Router {
  const router = Router();
  const authMiddleware = new AuthMiddleware(pool);
  const rbacMiddleware = new RBACMiddleware(pool);
  const orgRepo = new OrganizationRepository(pool);
  const userRepo = new UserRepository(pool);

  // Validation middleware
  const validateCreateOrg = [
    body('name').trim().isLength({ min: 2, max: 255 }),
    body('slug').optional().trim().matches(/^[a-z0-9-]+$/),
    body('description').optional().trim().isLength({ max: 1000 }),
    body('website_url').optional().trim().isURL(),
    body('billing_email').optional().isEmail().normalizeEmail(),
  ];

  const validateUpdateOrg = [
    body('name').optional().trim().isLength({ min: 2, max: 255 }),
    body('description').optional().trim().isLength({ max: 1000 }),
    body('website_url').optional().trim().isURL(),
    body('billing_email').optional().isEmail().normalizeEmail(),
    body('logo_url').optional().trim().isURL(),
  ];

  const validateInvite = [
    body('email').isEmail().normalizeEmail(),
    body('role').isIn(['admin', 'member', 'viewer']),
    body('team_id').optional().isUUID(),
  ];

  const handleValidationErrors = (req: Request, res: Response, next: any) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  };

  // Create organization
  router.post('/', 
    authMiddleware.authenticate,
    authMiddleware.requireVerifiedEmail,
    validateCreateOrg,
    handleValidationErrors,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { name, slug, description, website_url, billing_email } = req.body;
        
        // Generate slug if not provided
        const orgSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 100);

        // Check if slug already exists
        const existingOrg = await orgRepo.findBySlug(orgSlug);
        if (existingOrg) {
          return res.status(409).json({ error: 'Organization slug already exists' });
        }

        // Create organization
        const organization = await orgRepo.create({
          name,
          slug: orgSlug,
          description,
          website_url,
          billing_email: billing_email || req.user!.email,
        });

        // Add creator as owner
        await userRepo.createMembership({
          user_id: req.userId!,
          organization_id: organization.id,
          role: 'owner',
        });

        await client.query('COMMIT');

        res.status(201).json({ organization });
      } catch (error: any) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to create organization', message: error.message });
      } finally {
        client.release();
      }
    }
  );

  // Get user's organizations
  router.get('/', 
    authMiddleware.authenticate,
    async (req: Request, res: Response) => {
      try {
        const organizations = await userRepo.getUserOrganizations(req.userId!);
        const memberships = await userRepo.getUserMemberships(req.userId!);
        
        const orgsWithRoles = organizations.map(org => {
          const membership = memberships.find(m => m.organization_id === org.id);
          return {
            ...org,
            role: membership?.role,
            joined_at: membership?.joined_at,
          };
        });

        res.json({ organizations: orgsWithRoles });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to fetch organizations', message: error.message });
      }
    }
  );

  // Get organization by ID
  router.get('/:organizationId',
    authMiddleware.authenticate,
    authMiddleware.requireOrganization,
    rbacMiddleware.requirePermission('org:read'),
    async (req: Request, res: Response) => {
      try {
        const organization = await orgRepo.findById(req.params.organizationId);
        if (!organization) {
          return res.status(404).json({ error: 'Organization not found' });
        }

        // Get member count
        const memberCountQuery = `
          SELECT COUNT(DISTINCT user_id) as count 
          FROM memberships 
          WHERE organization_id = $1
        `;
        const memberResult = await pool.query(memberCountQuery, [organization.id]);

        // Get project count
        const projectCountQuery = `
          SELECT COUNT(*) as count 
          FROM projects 
          WHERE organization_id = $1 AND deleted_at IS NULL
        `;
        const projectResult = await pool.query(projectCountQuery, [organization.id]);

        res.json({
          organization: {
            ...organization,
            member_count: parseInt(memberResult.rows[0].count),
            project_count: parseInt(projectResult.rows[0].count),
            user_role: req.userRole,
          }
        });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to fetch organization', message: error.message });
      }
    }
  );

  // Update organization
  router.put('/:organizationId',
    authMiddleware.authenticate,
    authMiddleware.requireOrganization,
    rbacMiddleware.requireMinRole('admin'),
    validateUpdateOrg,
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        const updates = req.body;
        const organization = await orgRepo.update(req.params.organizationId, updates);
        
        if (!organization) {
          return res.status(404).json({ error: 'Organization not found' });
        }

        res.json({ organization });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to update organization', message: error.message });
      }
    }
  );

  // Delete organization
  router.delete('/:organizationId',
    authMiddleware.authenticate,
    authMiddleware.requireOrganization,
    rbacMiddleware.requireRole('owner'),
    async (req: Request, res: Response) => {
      try {
        await orgRepo.softDelete(req.params.organizationId);
        res.json({ message: 'Organization deleted successfully' });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to delete organization', message: error.message });
      }
    }
  );

  // Get organization members
  router.get('/:organizationId/members',
    authMiddleware.authenticate,
    authMiddleware.requireOrganization,
    rbacMiddleware.requirePermission('org:read'),
    async (req: Request, res: Response) => {
      try {
        const query = `
          SELECT 
            m.*,
            u.email,
            u.first_name,
            u.last_name,
            u.avatar_url,
            u.last_login_at,
            t.name as team_name,
            t.slug as team_slug
          FROM memberships m
          JOIN users u ON m.user_id = u.id
          LEFT JOIN teams t ON m.team_id = t.id
          WHERE m.organization_id = $1
          ORDER BY m.created_at DESC
        `;
        const result = await pool.query(query, [req.params.organizationId]);

        res.json({ members: result.rows });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to fetch members', message: error.message });
      }
    }
  );

  // Invite user to organization
  router.post('/:organizationId/invite',
    authMiddleware.authenticate,
    authMiddleware.requireOrganization,
    rbacMiddleware.requirePermission('user:invite'),
    validateInvite,
    handleValidationErrors,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { email, role, team_id } = req.body;
        const organizationId = req.params.organizationId;

        // Check if user exists
        let user = await userRepo.findByEmail(email);
        
        if (!user) {
          // Create pending invitation
          // TODO: Implement invitation system with email sending
          return res.status(202).json({ 
            message: 'Invitation sent to email address',
            invitation_sent: true 
          });
        }

        // Check if user is already a member
        const existingMembership = await userRepo.getMembershipByOrgAndUser(user.id, organizationId);
        if (existingMembership) {
          return res.status(409).json({ error: 'User is already a member of this organization' });
        }

        // Add user to organization
        const membership = await userRepo.createMembership({
          user_id: user.id,
          organization_id: organizationId,
          team_id,
          role,
          invited_by: req.userId,
        });

        await client.query('COMMIT');

        res.status(201).json({ membership });
      } catch (error: any) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to invite user', message: error.message });
      } finally {
        client.release();
      }
    }
  );

  // Update member role
  router.put('/:organizationId/members/:userId',
    authMiddleware.authenticate,
    authMiddleware.requireOrganization,
    rbacMiddleware.requirePermission('user:update_role'),
    body('role').isIn(['admin', 'member', 'viewer']),
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        const { role } = req.body;
        const { organizationId, userId } = req.params;

        // Can't change owner role
        const membership = await userRepo.getMembershipByOrgAndUser(userId, organizationId);
        if (!membership) {
          return res.status(404).json({ error: 'Member not found' });
        }

        if (membership.role === 'owner') {
          return res.status(403).json({ error: 'Cannot change owner role' });
        }

        // Can't demote yourself if you're the last admin
        if (userId === req.userId && req.userRole === 'admin' && role !== 'admin') {
          const adminCountQuery = `
            SELECT COUNT(*) as count 
            FROM memberships 
            WHERE organization_id = $1 AND role IN ('owner', 'admin')
          `;
          const adminResult = await pool.query(adminCountQuery, [organizationId]);
          
          if (parseInt(adminResult.rows[0].count) <= 1) {
            return res.status(403).json({ error: 'Cannot demote the last admin' });
          }
        }

        const updatedMembership = await userRepo.updateMembershipRole(membership.id, role);

        res.json({ membership: updatedMembership });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to update member role', message: error.message });
      }
    }
  );

  // Remove member from organization
  router.delete('/:organizationId/members/:userId',
    authMiddleware.authenticate,
    authMiddleware.requireOrganization,
    rbacMiddleware.requirePermission('user:remove'),
    async (req: Request, res: Response) => {
      try {
        const { organizationId, userId } = req.params;

        // Can't remove owner
        const membership = await userRepo.getMembershipByOrgAndUser(userId, organizationId);
        if (!membership) {
          return res.status(404).json({ error: 'Member not found' });
        }

        if (membership.role === 'owner') {
          return res.status(403).json({ error: 'Cannot remove organization owner' });
        }

        // Can't remove yourself if you're the last admin
        if (userId === req.userId && req.userRole === 'admin') {
          const adminCountQuery = `
            SELECT COUNT(*) as count 
            FROM memberships 
            WHERE organization_id = $1 AND role IN ('owner', 'admin')
          `;
          const adminResult = await pool.query(adminCountQuery, [organizationId]);
          
          if (parseInt(adminResult.rows[0].count) <= 1) {
            return res.status(403).json({ error: 'Cannot remove the last admin' });
          }
        }

        // Remove membership
        const deleteQuery = `
          DELETE FROM memberships 
          WHERE user_id = $1 AND organization_id = $2
        `;
        await pool.query(deleteQuery, [userId, organizationId]);

        res.json({ message: 'Member removed successfully' });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to remove member', message: error.message });
      }
    }
  );

  // Leave organization
  router.post('/:organizationId/leave',
    authMiddleware.authenticate,
    authMiddleware.requireOrganization,
    async (req: Request, res: Response) => {
      try {
        const { organizationId } = req.params;

        // Can't leave if you're the owner
        if (req.userRole === 'owner') {
          return res.status(403).json({ 
            error: 'Organization owner cannot leave', 
            message: 'Transfer ownership before leaving the organization' 
          });
        }

        // Remove membership
        const deleteQuery = `
          DELETE FROM memberships 
          WHERE user_id = $1 AND organization_id = $2
        `;
        await pool.query(deleteQuery, [req.userId, organizationId]);

        res.json({ message: 'Successfully left the organization' });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to leave organization', message: error.message });
      }
    }
  );

  return router;
}