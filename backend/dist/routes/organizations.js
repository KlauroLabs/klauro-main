"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrganizationRoutes = createOrganizationRoutes;
const express_1 = require("express");
const auth_middleware_1 = require("../auth/middleware/auth-middleware");
const rbac_middleware_1 = require("../auth/middleware/rbac-middleware");
const organization_repository_1 = require("../database/repositories/organization-repository");
const user_repository_1 = require("../database/repositories/user-repository");
const express_validator_1 = require("express-validator");
function createOrganizationRoutes(pool) {
    const router = (0, express_1.Router)();
    const authMiddleware = new auth_middleware_1.AuthMiddleware(pool);
    const rbacMiddleware = new rbac_middleware_1.RBACMiddleware(pool);
    const orgRepo = new organization_repository_1.OrganizationRepository(pool);
    const userRepo = new user_repository_1.UserRepository(pool);
    const validateCreateOrg = [
        (0, express_validator_1.body)('name').trim().isLength({ min: 2, max: 255 }),
        (0, express_validator_1.body)('slug').optional().trim().matches(/^[a-z0-9-]+$/),
        (0, express_validator_1.body)('description').optional().trim().isLength({ max: 1000 }),
        (0, express_validator_1.body)('website_url').optional().trim().isURL(),
        (0, express_validator_1.body)('billing_email').optional().isEmail().normalizeEmail(),
    ];
    const validateUpdateOrg = [
        (0, express_validator_1.body)('name').optional().trim().isLength({ min: 2, max: 255 }),
        (0, express_validator_1.body)('description').optional().trim().isLength({ max: 1000 }),
        (0, express_validator_1.body)('website_url').optional().trim().isURL(),
        (0, express_validator_1.body)('billing_email').optional().isEmail().normalizeEmail(),
        (0, express_validator_1.body)('logo_url').optional().trim().isURL(),
    ];
    const validateInvite = [
        (0, express_validator_1.body)('email').isEmail().normalizeEmail(),
        (0, express_validator_1.body)('role').isIn(['admin', 'member', 'viewer']),
        (0, express_validator_1.body)('team_id').optional().isUUID(),
    ];
    const handleValidationErrors = (req, res, next) => {
        const errors = (0, express_validator_1.validationResult)(req);
        if (!errors.isEmpty()) {
            res.status(400).json({ errors: errors.array() });
            return;
        }
        next();
    };
    router.post('/', authMiddleware.authenticate, authMiddleware.requireVerifiedEmail, validateCreateOrg, handleValidationErrors, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { name, slug, description, website_url, billing_email } = req.body;
            const orgSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 100);
            const existingOrg = await orgRepo.findBySlug(orgSlug);
            if (existingOrg) {
                return res.status(409).json({ error: 'Organization slug already exists' });
            }
            const organization = await orgRepo.create({
                name,
                slug: orgSlug,
                description,
                website_url,
                billing_email,
                settings: {},
            });
            await userRepo.createMembership({
                user_id: req.userId,
                organization_id: organization.id,
                role: 'owner',
            });
            await client.query('COMMIT');
            res.status(201).json({ organization });
        }
        catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: 'Failed to create organization', message: error.message });
        }
        finally {
            client.release();
        }
    });
    router.get('/', authMiddleware.authenticate, async (req, res) => {
        try {
            const organizations = await userRepo.getUserOrganizations(req.userId);
            const memberships = await userRepo.getUserMemberships(req.userId);
            const orgsWithRoles = organizations.map(org => {
                const membership = memberships.find(m => m.organization_id === org.id);
                return {
                    ...org,
                    role: membership?.role,
                    joined_at: membership?.joined_at,
                };
            });
            res.json({ organizations: orgsWithRoles });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to fetch organizations', message: error.message });
        }
    });
    router.get('/:organizationId', authMiddleware.authenticate, authMiddleware.requireOrganization, rbacMiddleware.requirePermission('org:read'), async (req, res) => {
        try {
            const organization = await orgRepo.findById(req.params.organizationId);
            if (!organization) {
                return res.status(404).json({ error: 'Organization not found' });
            }
            const memberCountQuery = `
          SELECT COUNT(DISTINCT user_id) as count 
          FROM memberships 
          WHERE organization_id = $1
        `;
            const memberResult = await pool.query(memberCountQuery, [organization.id]);
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
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to fetch organization', message: error.message });
        }
    });
    router.put('/:organizationId', authMiddleware.authenticate, authMiddleware.requireOrganization, rbacMiddleware.requireMinRole('admin'), validateUpdateOrg, handleValidationErrors, async (req, res) => {
        try {
            const updates = req.body;
            const organization = await orgRepo.update(req.params.organizationId, updates);
            if (!organization) {
                return res.status(404).json({ error: 'Organization not found' });
            }
            res.json({ organization });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to update organization', message: error.message });
        }
    });
    router.delete('/:organizationId', authMiddleware.authenticate, authMiddleware.requireOrganization, rbacMiddleware.requireRole('owner'), async (req, res) => {
        try {
            await orgRepo.softDelete(req.params.organizationId);
            res.json({ message: 'Organization deleted successfully' });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to delete organization', message: error.message });
        }
    });
    router.get('/:organizationId/members', authMiddleware.authenticate, authMiddleware.requireOrganization, rbacMiddleware.requirePermission('org:read'), async (req, res) => {
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
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to fetch members', message: error.message });
        }
    });
    router.post('/:organizationId/invite', authMiddleware.authenticate, authMiddleware.requireOrganization, rbacMiddleware.requirePermission('user:invite'), validateInvite, handleValidationErrors, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { email, role, team_id } = req.body;
            const organizationId = req.params.organizationId;
            let user = await userRepo.findByEmail(email);
            if (!user) {
                return res.status(202).json({
                    message: 'Invitation sent to email address',
                    invitation_sent: true
                });
            }
            const existingMembership = await userRepo.getMembershipByOrgAndUser(user.id, organizationId);
            if (existingMembership) {
                return res.status(409).json({ error: 'User is already a member of this organization' });
            }
            const membership = await userRepo.createMembership({
                user_id: user.id,
                organization_id: organizationId,
                team_id,
                role,
                invited_by: req.userId,
            });
            await client.query('COMMIT');
            res.status(201).json({ membership });
        }
        catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: 'Failed to invite user', message: error.message });
        }
        finally {
            client.release();
        }
    });
    router.put('/:organizationId/members/:userId', authMiddleware.authenticate, authMiddleware.requireOrganization, rbacMiddleware.requirePermission('user:update_role'), (0, express_validator_1.body)('role').isIn(['admin', 'member', 'viewer']), handleValidationErrors, async (req, res) => {
        try {
            const { role } = req.body;
            const { organizationId, userId } = req.params;
            const membership = await userRepo.getMembershipByOrgAndUser(userId, organizationId);
            if (!membership) {
                return res.status(404).json({ error: 'Member not found' });
            }
            if (membership.role === 'owner') {
                return res.status(403).json({ error: 'Cannot change owner role' });
            }
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
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to update member role', message: error.message });
        }
    });
    router.delete('/:organizationId/members/:userId', authMiddleware.authenticate, authMiddleware.requireOrganization, rbacMiddleware.requirePermission('user:remove'), async (req, res) => {
        try {
            const { organizationId, userId } = req.params;
            const membership = await userRepo.getMembershipByOrgAndUser(userId, organizationId);
            if (!membership) {
                return res.status(404).json({ error: 'Member not found' });
            }
            if (membership.role === 'owner') {
                return res.status(403).json({ error: 'Cannot remove organization owner' });
            }
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
            const deleteQuery = `
          DELETE FROM memberships 
          WHERE user_id = $1 AND organization_id = $2
        `;
            await pool.query(deleteQuery, [userId, organizationId]);
            res.json({ message: 'Member removed successfully' });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to remove member', message: error.message });
        }
    });
    router.post('/:organizationId/leave', authMiddleware.authenticate, authMiddleware.requireOrganization, async (req, res) => {
        try {
            const { organizationId } = req.params;
            if (req.userRole === 'owner') {
                return res.status(403).json({
                    error: 'Organization owner cannot leave',
                    message: 'Transfer ownership before leaving the organization'
                });
            }
            const deleteQuery = `
          DELETE FROM memberships 
          WHERE user_id = $1 AND organization_id = $2
        `;
            await pool.query(deleteQuery, [req.userId, organizationId]);
            res.json({ message: 'Successfully left the organization' });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to leave organization', message: error.message });
        }
    });
    return router;
}
