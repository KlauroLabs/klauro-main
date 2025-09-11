"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalInputSanitizer = exports.validators = exports.InputSanitizer = void 0;
exports.handleValidationErrors = handleValidationErrors;
const express_validator_1 = require("express-validator");
const isomorphic_dompurify_1 = __importDefault(require("isomorphic-dompurify"));
const validator_1 = __importDefault(require("validator"));
class InputSanitizer {
    static sanitizeString(value, options = {}) {
        if (typeof value !== 'string') {
            return '';
        }
        let sanitized = value;
        if (options.trim !== false) {
            sanitized = sanitized.trim();
        }
        if (options.maxLength) {
            sanitized = sanitized.substring(0, options.maxLength);
        }
        if (!options.allowHtml) {
            sanitized = isomorphic_dompurify_1.default.sanitize(sanitized, { ALLOWED_TAGS: [] });
        }
        if (!options.allowSpecialChars) {
            sanitized = validator_1.default.escape(sanitized);
        }
        for (const pattern of this.SQL_INJECTION_PATTERNS) {
            if (pattern.test(sanitized)) {
                throw new Error('Potential SQL injection detected');
            }
        }
        for (const pattern of this.XSS_PATTERNS) {
            if (pattern.test(sanitized)) {
                sanitized = sanitized.replace(pattern, '');
            }
        }
        return sanitized;
    }
    static sanitizePath(path) {
        if (typeof path !== 'string') {
            return '';
        }
        for (const pattern of this.PATH_TRAVERSAL_PATTERNS) {
            if (pattern.test(path)) {
                throw new Error('Potential path traversal detected');
            }
        }
        return path.replace(/[^a-zA-Z0-9-_/.]/, '');
    }
    static sanitizeCommand(command) {
        if (typeof command !== 'string') {
            return '';
        }
        for (const pattern of this.COMMAND_INJECTION_PATTERNS) {
            if (pattern.test(command)) {
                throw new Error('Potential command injection detected');
            }
        }
        return command;
    }
    static sanitizeEmail(email) {
        if (!validator_1.default.isEmail(email)) {
            throw new Error('Invalid email format');
        }
        return validator_1.default.normalizeEmail(email) || email;
    }
    static sanitizeUrl(url, options = {}) {
        const urlOptions = {
            protocols: options.protocols || ['http', 'https'],
            require_protocol: options.requireProtocol !== false,
        };
        if (!validator_1.default.isURL(url, urlOptions)) {
            throw new Error('Invalid URL format');
        }
        return url;
    }
    static sanitizeNumber(value, options = {}) {
        const num = Number(value);
        if (isNaN(num)) {
            throw new Error('Invalid number');
        }
        if (options.isInt && !Number.isInteger(num)) {
            throw new Error('Value must be an integer');
        }
        if (options.min !== undefined && num < options.min) {
            throw new Error(`Value must be at least ${options.min}`);
        }
        if (options.max !== undefined && num > options.max) {
            throw new Error(`Value must be at most ${options.max}`);
        }
        return num;
    }
    static sanitizeUUID(uuid) {
        if (!validator_1.default.isUUID(uuid)) {
            throw new Error('Invalid UUID format');
        }
        return uuid.toLowerCase();
    }
    static sanitizeJSON(json) {
        try {
            const parsed = JSON.parse(json);
            return JSON.parse(JSON.stringify(parsed));
        }
        catch {
            throw new Error('Invalid JSON format');
        }
    }
    static middleware(options = {}) {
        return (req, res, next) => {
            const skipPaths = options.skipPaths || [];
            const shouldSkip = skipPaths.some(pattern => pattern.test(req.path));
            if (shouldSkip) {
                return next();
            }
            try {
                if (req.body && typeof req.body === 'object') {
                    req.body = this.sanitizeObject(req.body, options.strict);
                }
                if (req.query && typeof req.query === 'object') {
                    req.query = this.sanitizeObject(req.query, options.strict);
                }
                if (req.params && typeof req.params === 'object') {
                    req.params = this.sanitizeObject(req.params, options.strict);
                }
                next();
            }
            catch (error) {
                res.status(400).json({
                    error: 'Bad Request',
                    message: error.message || 'Invalid input detected',
                });
            }
        };
    }
    static sanitizeObject(obj, strict) {
        if (obj === null || obj === undefined) {
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map(item => this.sanitizeObject(item, strict));
        }
        if (typeof obj === 'object') {
            const sanitized = {};
            for (const [key, value] of Object.entries(obj)) {
                const sanitizedKey = this.sanitizeString(key, { maxLength: 100 });
                if (typeof value === 'string') {
                    sanitized[sanitizedKey] = this.sanitizeString(value, {
                        maxLength: strict ? 10000 : undefined,
                        allowHtml: false,
                        allowSpecialChars: !strict,
                    });
                }
                else {
                    sanitized[sanitizedKey] = this.sanitizeObject(value, strict);
                }
            }
            return sanitized;
        }
        return obj;
    }
}
exports.InputSanitizer = InputSanitizer;
InputSanitizer.SQL_INJECTION_PATTERNS = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|EXEC|EXECUTE|SCRIPT|TRUNCATE)\b)/gi,
    /(--|\/\*|\*\/|xp_|sp_|0x)/gi,
    /(\bOR\b\s*\d+\s*=\s*\d+|\bAND\b\s*\d+\s*=\s*\d+)/gi,
];
InputSanitizer.XSS_PATTERNS = [
    /<script[^>]*>.*?<\/script>/gi,
    /<iframe[^>]*>.*?<\/iframe>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi,
    /<embed[^>]*>/gi,
    /<object[^>]*>/gi,
];
InputSanitizer.PATH_TRAVERSAL_PATTERNS = [
    /\.\.\//g,
    /\.\.%2[fF]/g,
    /%2[eE]\./g,
    /\x00/g,
];
InputSanitizer.COMMAND_INJECTION_PATTERNS = [
    /[;&|`$]/g,
    /\$\(/g,
    /\|\|/g,
    /&&/g,
];
exports.validators = {
    email: () => (0, express_validator_1.body)('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
    password: (minLength = 8) => (0, express_validator_1.body)('password')
        .isLength({ min: minLength })
        .withMessage(`Password must be at least ${minLength} characters`)
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain uppercase, lowercase, and numbers'),
    uuid: (field) => (0, express_validator_1.param)(field).isUUID().withMessage(`Invalid ${field} UUID`),
    pagination: () => [
        (0, express_validator_1.query)('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
        (0, express_validator_1.query)('offset').optional().isInt({ min: 0 }).toInt(),
    ],
    sortOrder: () => (0, express_validator_1.query)('sort').optional().isIn(['asc', 'desc', 'ASC', 'DESC']),
    date: (field) => (0, express_validator_1.body)(field).optional().isISO8601().toDate(),
    url: (field) => (0, express_validator_1.body)(field).optional().isURL({
        protocols: ['http', 'https'],
        require_protocol: true,
    }),
    slug: (field) => (0, express_validator_1.body)(field)
        .optional()
        .matches(/^[a-z0-9-]+$/)
        .withMessage('Slug must contain only lowercase letters, numbers, and hyphens'),
    phone: (field) => (0, express_validator_1.body)(field).optional().isMobilePhone('any'),
    alphanumeric: (field) => (0, express_validator_1.body)(field).isAlphanumeric().withMessage(`${field} must be alphanumeric`),
    json: (field) => (0, express_validator_1.body)(field).isJSON().withMessage(`${field} must be valid JSON`),
};
function handleValidationErrors(req, res, next) {
    const errors = (0, express_validator_1.validationResult)(req);
    if (!errors.isEmpty()) {
        const formattedErrors = errors.array().map(err => ({
            field: err.type === 'field' ? err.path : undefined,
            message: err.msg,
            value: err.value,
        }));
        return res.status(400).json({
            error: 'Validation Error',
            message: 'Input validation failed',
            errors: formattedErrors,
        });
    }
    next();
}
exports.globalInputSanitizer = InputSanitizer.middleware({
    skipPaths: [
        /^\/api\/health/,
        /^\/api\/metrics/,
    ],
    strict: false,
});
