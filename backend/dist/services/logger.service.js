"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const winston_1 = __importDefault(require("winston"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const logsDir = path_1.default.join(process.cwd(), 'logs');
if (!fs_1.default.existsSync(logsDir)) {
    fs_1.default.mkdirSync(logsDir, { recursive: true });
}
const logLevels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};
const logColors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'blue',
};
winston_1.default.addColors(logColors);
const format = winston_1.default.format.combine(winston_1.default.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }), winston_1.default.format.errors({ stack: true }), winston_1.default.format.json());
const consoleFormat = winston_1.default.format.combine(winston_1.default.format.colorize({ all: true }), winston_1.default.format.printf((info) => `${info.timestamp} [${info.level}]: ${info.message} ${info.stack || ''}`));
const transports = [
    new winston_1.default.transports.File({
        filename: path_1.default.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 10485760,
        maxFiles: 5,
    }),
    new winston_1.default.transports.File({
        filename: path_1.default.join(logsDir, 'combined.log'),
        maxsize: 10485760,
        maxFiles: 5,
    }),
];
if (process.env.NODE_ENV !== 'production') {
    transports.push(new winston_1.default.transports.Console({
        format: consoleFormat,
    }));
}
else {
    transports.push(new winston_1.default.transports.Console({
        format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    }));
}
const logger = winston_1.default.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    levels: logLevels,
    format,
    transports,
    exitOnError: false,
});
class Logger {
    constructor(context, metadata) {
        this.context = context;
        this.metadata = metadata || {};
    }
    formatMessage(message, meta) {
        return `[${this.context}] ${message}`;
    }
    getMeta(meta) {
        return {
            ...this.metadata,
            ...meta,
            context: this.context,
            timestamp: new Date().toISOString(),
        };
    }
    error(message, error, meta) {
        const errorMeta = {
            ...this.getMeta(meta),
            error: error ? {
                message: error.message,
                stack: error.stack,
                name: error.name,
                ...error,
            } : undefined,
        };
        logger.error(this.formatMessage(message), errorMeta);
    }
    warn(message, meta) {
        logger.warn(this.formatMessage(message), this.getMeta(meta));
    }
    info(message, meta) {
        logger.info(this.formatMessage(message), this.getMeta(meta));
    }
    http(message, meta) {
        logger.http(this.formatMessage(message), this.getMeta(meta));
    }
    debug(message, meta) {
        logger.debug(this.formatMessage(message), this.getMeta(meta));
    }
    static createRequestLogger(req) {
        const requestId = req.id || Math.random().toString(36).substring(7);
        const userId = req.userId;
        return new Logger('Request', {
            requestId,
            method: req.method,
            path: req.path,
            ip: req.ip,
            userId,
            userAgent: req.headers['user-agent'],
        });
    }
    static httpLoggerMiddleware() {
        return (req, res, next) => {
            const requestId = Math.random().toString(36).substring(7);
            req.id = requestId;
            const start = Date.now();
            const requestLogger = Logger.createRequestLogger(req);
            res.on('finish', () => {
                const duration = Date.now() - start;
                const level = res.statusCode >= 400 ? 'warn' : 'http';
                requestLogger[level](`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`, {
                    statusCode: res.statusCode,
                    duration,
                    query: req.query,
                    body: req.method !== 'GET' ? this.sanitizeBody(req.body) : undefined,
                });
            });
            next();
        };
    }
    static sanitizeBody(body) {
        if (!body)
            return undefined;
        const sanitized = { ...body };
        const sensitiveFields = ['password', 'token', 'secret', 'api_key', 'credit_card'];
        for (const field of sensitiveFields) {
            if (sanitized[field]) {
                sanitized[field] = '[REDACTED]';
            }
        }
        return sanitized;
    }
    static auditLog(action, details) {
        const auditLogger = new Logger('Audit');
        auditLogger.info(action, {
            ...details,
            timestamp: new Date().toISOString(),
        });
        const auditEntry = {
            action,
            ...details,
            timestamp: new Date().toISOString(),
        };
        fs_1.default.appendFileSync(path_1.default.join(logsDir, 'audit.log'), JSON.stringify(auditEntry) + '\n');
    }
    static securityLog(event, details) {
        const securityLogger = new Logger('Security');
        securityLogger.warn(event, details);
        const securityEntry = {
            event,
            ...details,
            timestamp: new Date().toISOString(),
        };
        fs_1.default.appendFileSync(path_1.default.join(logsDir, 'security.log'), JSON.stringify(securityEntry) + '\n');
    }
    static performanceLog(operation, duration, metadata) {
        const perfLogger = new Logger('Performance');
        const level = duration > 1000 ? 'warn' : 'debug';
        perfLogger[level](`Operation ${operation} took ${duration}ms`, {
            operation,
            duration,
            ...metadata,
        });
    }
}
exports.Logger = Logger;
exports.default = logger;
