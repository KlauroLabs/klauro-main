"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUserRoutes = createUserRoutes;
const express_1 = require("express");
const auth_middleware_1 = require("../auth/middleware/auth-middleware");
const user_repository_1 = require("../database/repositories/user-repository");
const express_validator_1 = require("express-validator");
const bcrypt = __importStar(require("bcrypt"));
const auth_config_1 = require("../config/auth.config");
function createUserRoutes(pool) {
    const router = (0, express_1.Router)();
    const authMiddleware = new auth_middleware_1.AuthMiddleware(pool);
    const userRepo = new user_repository_1.UserRepository(pool);
    const validateProfileUpdate = [
        (0, express_validator_1.body)('first_name').optional().trim().isLength({ min: 1, max: 100 }),
        (0, express_validator_1.body)('last_name').optional().trim().isLength({ min: 1, max: 100 }),
        (0, express_validator_1.body)('avatar_url').optional().trim().isURL(),
        (0, express_validator_1.body)('timezone').optional().trim().isIn([
            'UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
            'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
            'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Singapore', 'Australia/Sydney'
        ]),
        (0, express_validator_1.body)('locale').optional().trim().isIn(['en', 'es', 'fr', 'de', 'ja', 'zh', 'pt', 'ru']),
    ];
    const validatePasswordChange = [
        (0, express_validator_1.body)('current_password').notEmpty(),
        (0, express_validator_1.body)('new_password').isLength({ min: auth_config_1.authConfig.security.passwordMinLength }),
    ];
    const handleValidationErrors = (req, res, next) => {
        const errors = (0, express_validator_1.validationResult)(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }
        next();
    };
    router.get('/profile', authMiddleware.authenticate, async (req, res) => {
        try {
            const user = await userRepo.findById(req.userId);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            const { password_hash, ...userProfile } = user;
            const memberships = await userRepo.getUserMemberships(req.userId);
            const organizations = await userRepo.getUserOrganizations(req.userId);
            res.json({
                user: userProfile,
                memberships,
                organizations,
            });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to fetch profile', message: error.message });
        }
    });
    router.put('/profile', authMiddleware.authenticate, validateProfileUpdate, handleValidationErrors, async (req, res) => {
        try {
            const updates = req.body;
            const user = await userRepo.updateUser(req.userId, updates);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            const { password_hash, ...userProfile } = user;
            res.json({ user: userProfile });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to update profile', message: error.message });
        }
    });
    router.put('/settings', authMiddleware.authenticate, (0, express_validator_1.body)('settings').isObject(), handleValidationErrors, async (req, res) => {
        try {
            const { settings } = req.body;
            const currentUser = await userRepo.findById(req.userId);
            if (!currentUser) {
                return res.status(404).json({ error: 'User not found' });
            }
            const mergedSettings = {
                ...(currentUser.settings || {}),
                ...settings,
            };
            const user = await userRepo.updateUser(req.userId, { settings: mergedSettings });
            res.json({ settings: user?.settings });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to update settings', message: error.message });
        }
    });
    router.post('/change-password', authMiddleware.authenticate, validatePasswordChange, handleValidationErrors, async (req, res) => {
        try {
            const { current_password, new_password } = req.body;
            const user = await userRepo.findById(req.userId);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            if (!user.password_hash) {
                return res.status(400).json({
                    error: 'Password change not available',
                    message: 'Your account uses OAuth authentication only'
                });
            }
            const isValidPassword = await bcrypt.compare(current_password, user.password_hash);
            if (!isValidPassword) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
            validatePasswordStrength(new_password);
            const newPasswordHash = await bcrypt.hash(new_password, auth_config_1.authConfig.security.bcryptRounds);
            const updateQuery = `
          UPDATE users 
          SET password_hash = $1, updated_at = NOW() 
          WHERE id = $2
        `;
            await pool.query(updateQuery, [newPasswordHash, req.userId]);
            await userRepo.revokeAllUserTokens(req.userId);
            res.json({ message: 'Password changed successfully. Please log in again.' });
        }
        catch (error) {
            res.status(400).json({ error: 'Failed to change password', message: error.message });
        }
    });
    router.delete('/account', authMiddleware.authenticate, (0, express_validator_1.body)('confirmation').equals('DELETE'), handleValidationErrors, async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
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
            const deleteQuery = `
          UPDATE users 
          SET deleted_at = NOW(), 
              email = CONCAT(email, '_deleted_', EXTRACT(EPOCH FROM NOW())::TEXT)
          WHERE id = $1
        `;
            await client.query(deleteQuery, [req.userId]);
            const removeMembershipsQuery = `
          DELETE FROM memberships WHERE user_id = $1
        `;
            await client.query(removeMembershipsQuery, [req.userId]);
            await userRepo.revokeAllUserTokens(req.userId);
            await client.query('COMMIT');
            res.json({ message: 'Account deleted successfully' });
        }
        catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: 'Failed to delete account', message: error.message });
        }
        finally {
            client.release();
        }
    });
    router.get('/activity', authMiddleware.authenticate, async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;
            const activities = [];
            res.json({ activities, limit, offset, total: 0 });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to fetch activity', message: error.message });
        }
    });
    router.get('/api-keys', authMiddleware.authenticate, async (req, res) => {
        try {
            const query = `
          SELECT id, name, key_prefix, created_at, last_used_at, expires_at
          FROM api_keys
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC
        `;
            const result = await pool.query(query, [req.userId]);
            res.json({ api_keys: result.rows });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to fetch API keys', message: error.message });
        }
    });
    router.post('/api-keys', authMiddleware.authenticate, authMiddleware.requireVerifiedEmail, (0, express_validator_1.body)('name').trim().isLength({ min: 1, max: 100 }), (0, express_validator_1.body)('expires_in_days').optional().isInt({ min: 1, max: 365 }), handleValidationErrors, async (req, res) => {
        try {
            const { name, expires_in_days } = req.body;
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
                    key: apiKey,
                },
                message: 'Save this API key securely. It will not be shown again.',
            });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to create API key', message: error.message });
        }
    });
    router.delete('/api-keys/:keyId', authMiddleware.authenticate, async (req, res) => {
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
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to revoke API key', message: error.message });
        }
    });
    router.get('/notifications', authMiddleware.authenticate, async (req, res) => {
        try {
            const user = await userRepo.findById(req.userId);
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
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to fetch notification preferences', message: error.message });
        }
    });
    router.put('/notifications', authMiddleware.authenticate, (0, express_validator_1.body)('notifications').isObject(), handleValidationErrors, async (req, res) => {
        try {
            const { notifications } = req.body;
            const currentUser = await userRepo.findById(req.userId);
            if (!currentUser) {
                return res.status(404).json({ error: 'User not found' });
            }
            const updatedSettings = {
                ...(currentUser.settings || {}),
                notifications,
            };
            await userRepo.updateUser(req.userId, { settings: updatedSettings });
            res.json({ notifications });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to update notification preferences', message: error.message });
        }
    });
    return router;
}
function validatePasswordStrength(password) {
    const config = auth_config_1.authConfig.security;
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
function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
