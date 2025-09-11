"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthMiddleware = void 0;
exports.createAuthMiddleware = createAuthMiddleware;
const passport_1 = __importDefault(require("passport"));
const auth_service_1 = require("../auth-service");
class AuthMiddleware {
    constructor(pool) {
        this.authenticate = (req, res, next) => {
            passport_1.default.authenticate('jwt', { session: false }, (err, user) => {
                if (err) {
                    return res.status(500).json({ error: 'Authentication error', message: err.message });
                }
                if (!user) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing authentication token' });
                }
                req.user = user;
                req.userId = user.sub;
                next();
            })(req, res, next);
        };
        this.optionalAuthenticate = (req, res, next) => {
            passport_1.default.authenticate('jwt', { session: false }, (err, user) => {
                if (!err && user) {
                    req.user = user;
                    req.userId = user.sub;
                }
                next();
            })(req, res, next);
        };
        this.requireOrganization = (req, res, next) => {
            const organizationId = req.params.organizationId || req.body.organizationId || req.query.organizationId;
            if (!organizationId) {
                return res.status(400).json({ error: 'Bad Request', message: 'Organization ID is required' });
            }
            if (!req.user) {
                return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
            }
            const userOrg = req.user.organizations?.find((org) => org.id === organizationId);
            if (!userOrg) {
                return res.status(403).json({ error: 'Forbidden', message: 'You do not have access to this organization' });
            }
            req.organizationId = organizationId;
            req.userRole = userOrg.role;
            next();
        };
        this.requireVerifiedEmail = async (req, res, next) => {
            if (!req.userId) {
                return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
            }
            try {
                const { user } = await this.authService.getUserWithMemberships(req.userId);
                if (!user.email_verified_at) {
                    return res.status(403).json({
                        error: 'Forbidden',
                        message: 'Email verification required',
                        code: 'EMAIL_NOT_VERIFIED'
                    });
                }
                next();
            }
            catch (error) {
                return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to verify email status' });
            }
        };
        this.refreshTokenFromCookie = (req, res, next) => {
            const refreshToken = req.cookies?.unravl_refresh_token;
            if (!refreshToken) {
                return res.status(401).json({ error: 'Unauthorized', message: 'Refresh token not found' });
            }
            req.body.refreshToken = refreshToken;
            next();
        };
        this.validateApiKey = (apiKeyHeader = 'x-api-key') => {
            return async (req, res, next) => {
                const apiKey = req.headers[apiKeyHeader];
                if (!apiKey) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'API key required' });
                }
                if (!apiKey.startsWith('unravl_')) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
                }
                next();
            };
        };
        this.requireTwoFactor = async (req, res, next) => {
            if (!req.userId) {
                return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
            }
            next();
        };
        this.checkSessionValidity = async (req, res, next) => {
            if (!req.user) {
                return next();
            }
            try {
                const { user } = await this.authService.getUserWithMemberships(req.userId);
                if (user.deleted_at) {
                    return res.status(401).json({ error: 'Unauthorized', message: 'Account has been deleted' });
                }
                next();
            }
            catch (error) {
                return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to validate session' });
            }
        };
        this.authService = new auth_service_1.AuthService(pool);
    }
}
exports.AuthMiddleware = AuthMiddleware;
function createAuthMiddleware(pool) {
    return new AuthMiddleware(pool);
}
