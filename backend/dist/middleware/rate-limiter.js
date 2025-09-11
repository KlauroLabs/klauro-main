"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalRateLimiter = exports.rateLimiters = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const standardHandler = (req, res) => {
    res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: res.getHeader('Retry-After'),
    });
};
exports.rateLimiters = {
    strict: (0, express_rate_limit_1.default)({
        windowMs: 15 * 60 * 1000,
        max: 5,
        message: 'Too many attempts, please try again later',
        standardHeaders: true,
        legacyHeaders: false,
        handler: standardHandler,
    }),
    auth: {
        login: (0, express_rate_limit_1.default)({
            windowMs: 15 * 60 * 1000,
            max: 5,
            message: 'Too many login attempts, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            skipSuccessfulRequests: false,
            handler: standardHandler,
        }),
        register: (0, express_rate_limit_1.default)({
            windowMs: 60 * 60 * 1000,
            max: 3,
            message: 'Too many registration attempts, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
        passwordReset: (0, express_rate_limit_1.default)({
            windowMs: 60 * 60 * 1000,
            max: 3,
            message: 'Too many password reset attempts, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
        emailVerification: (0, express_rate_limit_1.default)({
            windowMs: 60 * 60 * 1000,
            max: 5,
            message: 'Too many email verification attempts, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
        oauthCallback: (0, express_rate_limit_1.default)({
            windowMs: 5 * 60 * 1000,
            max: 10,
            message: 'Too many OAuth attempts, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
        tokenRefresh: (0, express_rate_limit_1.default)({
            windowMs: 15 * 60 * 1000,
            max: 10,
            message: 'Too many token refresh attempts, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
    },
    api: {
        standard: (0, express_rate_limit_1.default)({
            windowMs: 15 * 60 * 1000,
            max: 100,
            message: 'Too many requests, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
        generous: (0, express_rate_limit_1.default)({
            windowMs: 15 * 60 * 1000,
            max: 500,
            message: 'Too many requests, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
        search: (0, express_rate_limit_1.default)({
            windowMs: 1 * 60 * 1000,
            max: 30,
            message: 'Too many search requests, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
        write: (0, express_rate_limit_1.default)({
            windowMs: 15 * 60 * 1000,
            max: 50,
            message: 'Too many write operations, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
        upload: (0, express_rate_limit_1.default)({
            windowMs: 60 * 60 * 1000,
            max: 20,
            message: 'Too many uploads, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            handler: standardHandler,
        }),
    },
    createCustomLimiter(config) {
        return (0, express_rate_limit_1.default)({
            windowMs: config.windowMs,
            max: config.max,
            message: config.message || 'Too many requests, please try again later',
            standardHeaders: true,
            legacyHeaders: false,
            skipSuccessfulRequests: config.skipSuccessfulRequests || false,
            skipFailedRequests: config.skipFailedRequests || false,
            handler: standardHandler,
        });
    },
};
exports.globalRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 1 * 60 * 1000,
    max: 1000,
    message: 'Too many requests from this IP, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    handler: standardHandler,
});
