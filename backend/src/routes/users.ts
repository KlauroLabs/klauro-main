import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { AuthMiddleware } from '../auth/middleware/auth-middleware';
import { UserRepository } from '../database/repositories/user-repository';
import { body, validationResult } from 'express-validator';
import * as bcrypt from 'bcrypt';
import { authConfig } from '../config/auth.config';

export function createUserRoutes(pool: Pool): Router {
  const router = Router();
  const authMiddleware = new AuthMiddleware(pool);
  const userRepo = new UserRepository(pool);

  // Validation middleware
  const validateProfileUpdate = [
    body('first_name').optional().trim().isLength({ min: 1, max: 100 }),
    body('last_name').optional().trim().isLength({ min: 1, max: 100 }),
    body('avatar_url').optional().trim().isURL(),
    body('timezone').optional().trim().isIn([
      'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 
      'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
      'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney'
    ]),
    body('locale').optional().trim().isIn(['en', 'es', 'fr', 'de', 'ja', 'zh', 'pt', 'ru']),
  ];

  const validatePasswordChange = [
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: authConfig.security.passwordMinLength }),
  ];

  const handleValidationErrors = (req: Request, res: Response, next: any) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  };

  // Get current user profile
  router.get('/profile',
    authMiddleware.authenticate,
    async (req: Request, res: Response) => {
      try {
        const user = await userRepo.findById(req.userId!);
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        // Remove sensitive data
        const { password_hash, ...userProfile } = user;

        // Get user's organizations and teams
        const memberships = await userRepo.getUserMemberships(req.userId!);
        const organizations = await userRepo.getUserOrganizations(req.userId!);

        res.json({
          user: userProfile,
          memberships,
          organizations,
        });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to fetch profile', message: error.message });
      }
    }
  );

  // Update user profile
  router.put('/profile',
    authMiddleware.authenticate,
    validateProfileUpdate,
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        const updates = req.body;
        const user = await userRepo.updateUser(req.userId!, updates);
        
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        // Remove sensitive data
        const { password_hash, ...userProfile } = user;

        res.json({ user: userProfile });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to update profile', message: error.message });
      }
    }
  );

  // Update user settings
  router.put('/settings',
    authMiddleware.authenticate,
    body('settings').isObject(),
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        const { settings } = req.body;
        
        // Merge with existing settings
        const currentUser = await userRepo.findById(req.userId!);
        if (!currentUser) {
          return res.status(404).json({ error: 'User not found' });
        }

        const mergedSettings = {
          ...(currentUser.settings || {}),
          ...settings,
        };

        const user = await userRepo.updateUser(req.userId!, { settings: mergedSettings });
        
        res.json({ settings: user?.settings });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to update settings', message: error.message });
      }
    }
  );

  // Change password
  router.post('/change-password',
    authMiddleware.authenticate,
    validatePasswordChange,
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        const { current_password, new_password } = req.body;

        // Get user with password hash
        const user = await userRepo.findById(req.userId!);
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        // Check if user has a password (not OAuth only)
        if (!user.password_hash) {
          return res.status(400).json({ 
            error: 'Password change not available', 
            message: 'Your account uses OAuth authentication only' 
          });
        }

        // Verify current password
        const isValidPassword = await bcrypt.compare(current_password, user.password_hash);
        if (!isValidPassword) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Validate new password strength
        validatePasswordStrength(new_password);

        // Hash new password
        const newPasswordHash = await bcrypt.hash(new_password, authConfig.security.bcryptRounds);

        // Update password
        const updateQuery = `
          UPDATE users 
          SET password_hash = $1, updated_at = NOW() 
          WHERE id = $2
        `;
        await pool.query(updateQuery, [newPasswordHash, req.userId]);

        // Revoke all refresh tokens to force re-login
        await userRepo.revokeAllUserTokens(req.userId!);

        res.json({ message: 'Password changed successfully. Please log in again.' });
      } catch (error: any) {
        res.status(400).json({ error: 'Failed to change password', message: error.message });
      }
    }
  );

  // Delete account
  router.delete('/account',
    authMiddleware.authenticate,
    body('confirmation').equals('DELETE'),
    handleValidationErrors,
    async (req: Request, res: Response) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check if user is the sole owner of any organizations
        const ownerCheckQuery = `
          SELECT o.name, o.id
          FROM organizations o
          JOIN memberships m ON o.id = m.organization_id
          WHERE m.user_id = $1 AND m.role = 'owner'
          AND NOT EXISTS (
            SELECT 1 FROM memberships m2 
            WHERE m2.organization_id = o.id 
            AND m2.role = 'owner' 
            AND m2.user_id != $1
          )
        `;
        const ownerResult = await client.query(ownerCheckQuery, [req.userId]);

        if (ownerResult.rows.length > 0) {
          return res.status(400).json({
            error: 'Cannot delete account',
            message: 'You are the sole owner of one or more organizations. Transfer ownership before deleting your account.',
            organizations: ownerResult.rows,
          });
        }

        // Soft delete user account
        const deleteQuery = `
          UPDATE users 
          SET deleted_at = NOW(), 
              email = CONCAT(email, '_deleted_', EXTRACT(EPOCH FROM NOW())::TEXT)
          WHERE id = $1
        `;
        await client.query(deleteQuery, [req.userId]);

        // Remove all memberships
        const removeMembershipsQuery = `
          DELETE FROM memberships WHERE user_id = $1
        `;
        await client.query(removeMembershipsQuery, [req.userId]);

        // Revoke all refresh tokens
        await userRepo.revokeAllUserTokens(req.userId!);

        await client.query('COMMIT');

        res.json({ message: 'Account deleted successfully' });
      } catch (error: any) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to delete account', message: error.message });
      } finally {
        client.release();
      }
    }
  );

  // Get user's activity
  router.get('/activity',
    authMiddleware.authenticate,
    async (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = parseInt(req.query.offset as string) || 0;

        // TODO: Implement activity tracking
        // This would fetch user's recent actions from an activity log table
        const activities: any[] = [];

        res.json({ activities, limit, offset, total: 0 });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to fetch activity', message: error.message });
      }
    }
  );

  // Get user's API keys
  router.get('/api-keys',
    authMiddleware.authenticate,
    async (req: Request, res: Response) => {
      try {
        const query = `
          SELECT id, name, key_prefix, created_at, last_used_at, expires_at
          FROM api_keys
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC
        `;
        const result = await pool.query(query, [req.userId]);

        res.json({ api_keys: result.rows });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to fetch API keys', message: error.message });
      }
    }
  );

  // Create API key
  router.post('/api-keys',
    authMiddleware.authenticate,
    authMiddleware.requireVerifiedEmail,
    body('name').trim().isLength({ min: 1, max: 100 }),
    body('expires_in_days').optional().isInt({ min: 1, max: 365 }),
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        const { name, expires_in_days } = req.body;

        // Generate API key
        const apiKey = `unravl_${generateRandomString(32)}`;
        const keyPrefix = apiKey.substring(0, 12);
        const keyHash = await bcrypt.hash(apiKey, 10);

        const expiresAt = expires_in_days 
          ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000)
          : null;

        const insertQuery = `
          INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, expires_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
          RETURNING id, name, key_prefix, created_at, expires_at
        `;
        const result = await pool.query(insertQuery, [
          req.userId,
          name,
          keyHash,
          keyPrefix,
          expiresAt,
        ]);

        res.status(201).json({
          api_key: {
            ...result.rows[0],
            key: apiKey, // Only shown once
          },
          message: 'Save this API key securely. It will not be shown again.',
        });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to create API key', message: error.message });
      }
    }
  );

  // Revoke API key
  router.delete('/api-keys/:keyId',
    authMiddleware.authenticate,
    async (req: Request, res: Response) => {
      try {
        const updateQuery = `
          UPDATE api_keys 
          SET revoked_at = NOW() 
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
          RETURNING id
        `;
        const result = await pool.query(updateQuery, [req.params.keyId, req.userId]);

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'API key not found' });
        }

        res.json({ message: 'API key revoked successfully' });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to revoke API key', message: error.message });
      }
    }
  );

  // Get user's notification preferences
  router.get('/notifications',
    authMiddleware.authenticate,
    async (req: Request, res: Response) => {
      try {
        const user = await userRepo.findById(req.userId!);
        const notifications = user?.settings?.notifications || {
          email: {
            project_updates: true,
            team_invites: true,
            security_alerts: true,
            newsletter: false,
          },
          push: {
            project_updates: false,
            team_invites: true,
            security_alerts: true,
          },
        };

        res.json({ notifications });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to fetch notification preferences', message: error.message });
      }
    }
  );

  // Update notification preferences
  router.put('/notifications',
    authMiddleware.authenticate,
    body('notifications').isObject(),
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        const { notifications } = req.body;
        
        const currentUser = await userRepo.findById(req.userId!);
        if (!currentUser) {
          return res.status(404).json({ error: 'User not found' });
        }

        const updatedSettings = {
          ...(currentUser.settings || {}),
          notifications,
        };

        await userRepo.updateUser(req.userId!, { settings: updatedSettings });
        
        res.json({ notifications });
      } catch (error: any) {
        res.status(500).json({ error: 'Failed to update notification preferences', message: error.message });
      }
    }
  );

  return router;
}

function validatePasswordStrength(password: string): void {
  const config = authConfig.security;

  if (password.length < config.passwordMinLength) {
    throw new Error(`Password must be at least ${config.passwordMinLength} characters long`);
  }

  if (config.passwordRequireUppercase && !/[A-Z]/.test(password)) {
    throw new Error('Password must contain at least one uppercase letter');
  }

  if (config.passwordRequireLowercase && !/[a-z]/.test(password)) {
    throw new Error('Password must contain at least one lowercase letter');
  }

  if (config.passwordRequireNumbers && !/\d/.test(password)) {
    throw new Error('Password must contain at least one number');
  }

  if (config.passwordRequireSpecial && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    throw new Error('Password must contain at least one special character');
  }
}

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}