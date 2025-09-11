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
exports.authConfig = void 0;
const dotenv = __importStar(require("dotenv"));
const crypto = __importStar(require("crypto"));
dotenv.config();
function validateJWTSecret(secret, name) {
    if (!secret) {
        throw new Error(`${name} environment variable is required for security`);
    }
    if (secret.length < 32) {
        throw new Error(`${name} must be at least 32 characters long`);
    }
    if (secret === 'unravl-access-secret-change-in-production' ||
        secret === 'unravl-refresh-secret-change-in-production') {
        throw new Error(`${name} contains default value - please set a secure secret`);
    }
    const entropy = calculateEntropy(secret);
    if (entropy < 3.5) {
        throw new Error(`${name} has insufficient entropy (${entropy.toFixed(2)} bits/char). Use a more complex secret.`);
    }
    return secret;
}
function calculateEntropy(str) {
    const charCounts = {};
    for (const char of str) {
        charCounts[char] = (charCounts[char] || 0) + 1;
    }
    let entropy = 0;
    const len = str.length;
    for (const count of Object.values(charCounts)) {
        const probability = count / len;
        entropy -= probability * Math.log2(probability);
    }
    return entropy;
}
const isProduction = process.env.NODE_ENV === 'production';
exports.authConfig = {
    jwt: {
        accessSecret: isProduction
            ? validateJWTSecret(process.env.JWT_ACCESS_SECRET, 'JWT_ACCESS_SECRET')
            : process.env.JWT_ACCESS_SECRET || crypto.randomBytes(32).toString('hex'),
        refreshSecret: isProduction
            ? validateJWTSecret(process.env.JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET')
            : process.env.JWT_REFRESH_SECRET || crypto.randomBytes(32).toString('hex'),
        accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
        issuer: process.env.JWT_ISSUER || 'unravl',
        audience: process.env.JWT_AUDIENCE || 'unravl-api',
    },
    oauth: {
        github: {
            clientId: process.env.GITHUB_CLIENT_ID || '',
            clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
            callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:3001/api/auth/oauth/github/callback',
            scope: ['user:email', 'read:user'],
        },
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID || '',
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
            callbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/auth/oauth/google/callback',
            scope: ['email', 'profile'],
        },
        microsoft: {
            clientId: process.env.MICROSOFT_CLIENT_ID || '',
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
            callbackUrl: process.env.MICROSOFT_CALLBACK_URL || 'http://localhost:3001/api/auth/oauth/microsoft/callback',
            scope: ['user.read'],
        },
        gitlab: {
            clientId: process.env.GITLAB_CLIENT_ID || '',
            clientSecret: process.env.GITLAB_CLIENT_SECRET || '',
            callbackUrl: process.env.GITLAB_CALLBACK_URL || 'http://localhost:3001/api/auth/oauth/gitlab/callback',
            scope: ['read_user', 'openid', 'email'],
        },
    },
    security: {
        bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10'),
        tokenBlacklistTTL: parseInt(process.env.TOKEN_BLACKLIST_TTL || '86400'),
        maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5'),
        loginAttemptWindow: parseInt(process.env.LOGIN_ATTEMPT_WINDOW || '900'),
        passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || '8'),
        passwordRequireUppercase: process.env.PASSWORD_REQUIRE_UPPERCASE === 'true',
        passwordRequireLowercase: process.env.PASSWORD_REQUIRE_LOWERCASE === 'true',
        passwordRequireNumbers: process.env.PASSWORD_REQUIRE_NUMBERS === 'true',
        passwordRequireSpecial: process.env.PASSWORD_REQUIRE_SPECIAL === 'true',
    },
    cookies: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: (process.env.COOKIE_SAME_SITE || 'lax'),
        refreshTokenName: 'unravl_refresh_token',
        domain: process.env.COOKIE_DOMAIN,
        path: '/',
    },
    cors: {
        origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000', 'http://localhost:5173'],
        credentials: true,
    },
    rateLimit: {
        auth: {
            windowMs: 15 * 60 * 1000,
            max: 5,
            message: 'Too many authentication attempts, please try again later',
        },
        api: {
            windowMs: 15 * 60 * 1000,
            max: 100,
            message: 'Too many requests, please try again later',
        },
    },
};
