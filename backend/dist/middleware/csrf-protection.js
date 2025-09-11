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
exports.csrfProtectionStrict = exports.csrfProtection = exports.CSRFProtection = void 0;
exports.attachCSRFToken = attachCSRFToken;
const crypto = __importStar(require("crypto"));
const tokenStore = {
    tokens: new Map(),
    cleanupInterval: setInterval(() => {
        const now = Date.now();
        const maxAge = 60 * 60 * 1000;
        for (const [key, value] of tokenStore.tokens.entries()) {
            if (now - value.createdAt > maxAge || value.used) {
                tokenStore.tokens.delete(key);
            }
        }
    }, 5 * 60 * 1000),
};
class CSRFProtection {
    static generateToken(userId) {
        const token = crypto.randomBytes(this.TOKEN_LENGTH).toString('hex');
        const key = userId || token;
        tokenStore.tokens.set(key, {
            token,
            createdAt: Date.now(),
            used: false,
        });
        return token;
    }
    static validateToken(token, userId) {
        if (!token) {
            return false;
        }
        const key = userId || token;
        const stored = tokenStore.tokens.get(key);
        if (!stored || stored.used) {
            return false;
        }
        if (stored.token !== token) {
            return false;
        }
        stored.used = true;
        return true;
    }
    static middleware(options = {}) {
        const skipMethods = options.skipMethods || ['GET', 'HEAD', 'OPTIONS'];
        const skipPaths = options.skipPaths || [];
        const requireAuth = options.requireAuth !== false;
        return (req, res, next) => {
            if (skipMethods.includes(req.method)) {
                return next();
            }
            const shouldSkip = skipPaths.some(pattern => pattern.test(req.path));
            if (shouldSkip) {
                return next();
            }
            const token = req.headers[this.TOKEN_HEADER] ||
                req.body?.[this.TOKEN_BODY_FIELD] ||
                req.query[this.TOKEN_QUERY_PARAM];
            const userId = requireAuth ? req.userId : undefined;
            if (requireAuth && !userId) {
                return res.status(401).json({
                    error: 'Unauthorized',
                    message: 'Authentication required for this operation',
                });
            }
            if (!this.validateToken(token, userId)) {
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Invalid or missing CSRF token',
                    code: 'CSRF_TOKEN_INVALID',
                });
            }
            next();
        };
    }
    static tokenEndpoint() {
        return (req, res) => {
            const userId = req.userId;
            const token = this.generateToken(userId);
            res.json({
                csrf_token: token,
                expires_in: 3600,
            });
        };
    }
}
exports.CSRFProtection = CSRFProtection;
CSRFProtection.TOKEN_LENGTH = 32;
CSRFProtection.TOKEN_HEADER = 'x-csrf-token';
CSRFProtection.TOKEN_BODY_FIELD = '_csrf';
CSRFProtection.TOKEN_QUERY_PARAM = '_csrf';
exports.csrfProtection = CSRFProtection.middleware({
    skipPaths: [
        /^\/api\/auth\/login$/,
        /^\/api\/auth\/register$/,
        /^\/api\/auth\/oauth/,
        /^\/api\/auth\/refresh$/,
        /^\/api\/auth\/forgot-password$/,
        /^\/api\/auth\/reset-password$/,
        /^\/api\/webhooks/,
        /^\/api\/health/,
    ],
});
exports.csrfProtectionStrict = CSRFProtection.middleware({
    skipMethods: ['GET', 'HEAD', 'OPTIONS'],
    requireAuth: true,
});
function attachCSRFToken(req, res, next) {
    if (req.method === 'GET' && req.userId) {
        const token = CSRFProtection.generateToken(req.userId);
        res.setHeader('X-CSRF-Token', token);
    }
    next();
}
