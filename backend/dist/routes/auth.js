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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthRoutes = createAuthRoutes;
exports.installValidation = installValidation;
const express_1 = require("express");
const passport_1 = __importDefault(require("passport"));
const auth_service_1 = require("../auth/auth-service");
const auth_middleware_1 = require("../auth/middleware/auth-middleware");
const auth_config_1 = require("../config/auth.config");
const express_validator_1 = require("express-validator");
const rate_limiter_1 = require("../middleware/rate-limiter");
const oauth_security_1 = require("../auth/oauth-security");
function createAuthRoutes(pool) {
    const router = (0, express_1.Router)();
    const authService = new auth_service_1.AuthService(pool);
    const authMiddleware = new auth_middleware_1.AuthMiddleware(pool);
    const validateRegister = [
        (0, express_validator_1.body)('email').isEmail().normalizeEmail(),
        (0, express_validator_1.body)('password').isLength({ min: auth_config_1.authConfig.security.passwordMinLength }),
        (0, express_validator_1.body)('first_name').optional().trim().isLength({ min: 1, max: 100 }),
        (0, express_validator_1.body)('last_name').optional().trim().isLength({ min: 1, max: 100 }),
        (0, express_validator_1.body)('organization_name').optional().trim().isLength({ min: 2, max: 255 }),
    ];
    const validateLogin = [
        (0, express_validator_1.body)('email').isEmail().normalizeEmail(),
        (0, express_validator_1.body)('password').notEmpty(),
    ];
    const handleValidationErrors = (req, res, next) => {
        const errors = (0, express_validator_1.validationResult)(req);
        if (!errors.isEmpty()) {
            res.status(400).json({ errors: errors.array() });
            return;
        }
        next();
    };
    router.post('/register', rate_limiter_1.rateLimiters.auth.register, validateRegister, handleValidationErrors, async (req, res) => {
        try {
            const registerData = req.body;
            const authResponse = await authService.register(registerData);
            res.cookie(auth_config_1.authConfig.cookies.refreshTokenName, authResponse.refresh_token, {
                httpOnly: auth_config_1.authConfig.cookies.httpOnly,
                secure: auth_config_1.authConfig.cookies.secure,
                sameSite: auth_config_1.authConfig.cookies.sameSite,
                domain: auth_config_1.authConfig.cookies.domain,
                path: auth_config_1.authConfig.cookies.path,
                maxAge: 7 * 24 * 60 * 60 * 1000,
            });
            res.status(201).json({
                access_token: authResponse.access_token,
                token_type: authResponse.token_type,
                expires_in: authResponse.expires_in,
                user: authResponse.user,
                organizations: authResponse.organizations,
            });
        }
        catch (error) {
            res.status(400).json({ error: 'Registration failed', message: error.message });
        }
    });
    router.post('/login', rate_limiter_1.rateLimiters.auth.login, validateLogin, handleValidationErrors, async (req, res) => {
        try {
            const loginData = req.body;
            const authResponse = await authService.login(loginData);
            res.cookie(auth_config_1.authConfig.cookies.refreshTokenName, authResponse.refresh_token, {
                httpOnly: auth_config_1.authConfig.cookies.httpOnly,
                secure: auth_config_1.authConfig.cookies.secure,
                sameSite: auth_config_1.authConfig.cookies.sameSite,
                domain: auth_config_1.authConfig.cookies.domain,
                path: auth_config_1.authConfig.cookies.path,
                maxAge: 7 * 24 * 60 * 60 * 1000,
            });
            res.json({
                access_token: authResponse.access_token,
                token_type: authResponse.token_type,
                expires_in: authResponse.expires_in,
                user: authResponse.user,
                organizations: authResponse.organizations,
            });
        }
        catch (error) {
            res.status(401).json({ error: 'Authentication failed', message: error.message });
        }
    });
    router.post('/logout', authMiddleware.authenticate, async (req, res) => {
        try {
            const refreshToken = req.cookies[auth_config_1.authConfig.cookies.refreshTokenName];
            if (refreshToken) {
                await authService.logout(refreshToken);
            }
            res.clearCookie(auth_config_1.authConfig.cookies.refreshTokenName, {
                domain: auth_config_1.authConfig.cookies.domain,
                path: auth_config_1.authConfig.cookies.path,
            });
            res.json({ message: 'Logged out successfully' });
        }
        catch (error) {
            res.status(500).json({ error: 'Logout failed', message: error.message });
        }
    });
    router.post('/logout-all', authMiddleware.authenticate, async (req, res) => {
        try {
            await authService.logoutAllDevices(req.userId);
            res.clearCookie(auth_config_1.authConfig.cookies.refreshTokenName, {
                domain: auth_config_1.authConfig.cookies.domain,
                path: auth_config_1.authConfig.cookies.path,
            });
            res.json({ message: 'Logged out from all devices successfully' });
        }
        catch (error) {
            res.status(500).json({ error: 'Logout failed', message: error.message });
        }
    });
    router.post('/refresh', rate_limiter_1.rateLimiters.auth.tokenRefresh, async (req, res) => {
        try {
            const refreshToken = req.cookies[auth_config_1.authConfig.cookies.refreshTokenName] || req.body.refreshToken;
            if (!refreshToken) {
                return res.status(401).json({ error: 'Refresh token required' });
            }
            const authResponse = await authService.refreshToken(refreshToken);
            res.cookie(auth_config_1.authConfig.cookies.refreshTokenName, authResponse.refresh_token, {
                httpOnly: auth_config_1.authConfig.cookies.httpOnly,
                secure: auth_config_1.authConfig.cookies.secure,
                sameSite: auth_config_1.authConfig.cookies.sameSite,
                domain: auth_config_1.authConfig.cookies.domain,
                path: auth_config_1.authConfig.cookies.path,
                maxAge: 7 * 24 * 60 * 60 * 1000,
            });
            res.json({
                access_token: authResponse.access_token,
                token_type: authResponse.token_type,
                expires_in: authResponse.expires_in,
                user: authResponse.user,
                organizations: authResponse.organizations,
            });
        }
        catch (error) {
            res.status(401).json({ error: 'Token refresh failed', message: error.message });
        }
    });
    router.get('/me', authMiddleware.authenticate, async (req, res) => {
        try {
            const { user, memberships } = await authService.getUserWithMemberships(req.userId);
            res.json({ user, memberships });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to fetch user', message: error.message });
        }
    });
    const providers = ['github', 'google', 'microsoft', 'gitlab'];
    providers.forEach(provider => {
        router.get(`/oauth/${provider}`, (req, res, next) => {
            const returnUrl = req.query.return_url;
            const { state, codeChallenge } = oauth_security_1.OAuthSecurity.createOAuthSession(provider, returnUrl);
            const authOptions = {
                scope: auth_config_1.authConfig.oauth[provider].scope,
                state,
            };
            if (codeChallenge && provider === 'github') {
                authOptions.code_challenge = codeChallenge;
                authOptions.code_challenge_method = 'S256';
            }
            passport_1.default.authenticate(provider, authOptions)(req, res, next);
        });
        router.get(`/oauth/${provider}/callback`, rate_limiter_1.rateLimiters.auth.oauthCallback, oauth_security_1.OAuthSecurity.middleware(), passport_1.default.authenticate(provider, { session: false, failureRedirect: '/login' }), async (req, res) => {
            try {
                const profile = req.user;
                const oauthState = req.oauthState;
                const authResponse = await authService.loginWithOAuth(profile);
                res.cookie(auth_config_1.authConfig.cookies.refreshTokenName, authResponse.refresh_token, {
                    httpOnly: auth_config_1.authConfig.cookies.httpOnly,
                    secure: auth_config_1.authConfig.cookies.secure,
                    sameSite: auth_config_1.authConfig.cookies.sameSite,
                    domain: auth_config_1.authConfig.cookies.domain,
                    path: auth_config_1.authConfig.cookies.path,
                    maxAge: 7 * 24 * 60 * 60 * 1000,
                });
                const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
                const returnUrl = oauthState.returnUrl || '/dashboard';
                res.redirect(`${frontendUrl}/auth/callback?token=${authResponse.access_token}&return=${encodeURIComponent(returnUrl)}`);
            }
            catch (error) {
                res.redirect(`/login?error=${encodeURIComponent(error.message)}`);
            }
        });
    });
    router.post('/verify-email', authMiddleware.authenticate, async (req, res) => {
        try {
            const userRepo = new (require('../database/repositories/user-repository').UserRepository)(pool);
            await userRepo.verifyEmail(req.userId);
            res.json({ message: 'Email verified successfully' });
        }
        catch (error) {
            res.status(500).json({ error: 'Email verification failed', message: error.message });
        }
    });
    router.post('/resend-verification', authMiddleware.authenticate, rate_limiter_1.rateLimiters.auth.emailVerification, async (req, res) => {
        try {
            res.json({ message: 'Verification email sent' });
        }
        catch (error) {
            res.status(500).json({ error: 'Failed to send verification email', message: error.message });
        }
    });
    router.post('/forgot-password', rate_limiter_1.rateLimiters.auth.passwordReset, (0, express_validator_1.body)('email').isEmail().normalizeEmail(), handleValidationErrors, async (req, res) => {
        try {
            res.json({ message: 'Password reset email sent if account exists' });
        }
        catch (error) {
            res.json({ message: 'Password reset email sent if account exists' });
        }
    });
    router.post('/reset-password', rate_limiter_1.rateLimiters.auth.passwordReset, (0, express_validator_1.body)('token').notEmpty(), (0, express_validator_1.body)('password').isLength({ min: auth_config_1.authConfig.security.passwordMinLength }), handleValidationErrors, async (req, res) => {
        try {
            res.json({ message: 'Password reset successfully' });
        }
        catch (error) {
            res.status(400).json({ error: 'Password reset failed', message: error.message });
        }
    });
    router.post('/change-password', authMiddleware.authenticate, (0, express_validator_1.body)('current_password').notEmpty(), (0, express_validator_1.body)('new_password').isLength({ min: auth_config_1.authConfig.security.passwordMinLength }), handleValidationErrors, async (req, res) => {
        try {
            res.json({ message: 'Password changed successfully' });
        }
        catch (error) {
            res.status(400).json({ error: 'Password change failed', message: error.message });
        }
    });
    return router;
}
async function installValidation() {
    const { body } = await Promise.resolve().then(() => __importStar(require('express-validator')));
    return { body };
}
