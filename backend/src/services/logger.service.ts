import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
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

winston.addColors(logColors);

const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `${info.timestamp} [${info.level}]: ${info.message} ${info.stack || ''}`
  ),
);

const transports: winston.transport[] = [
  new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    maxsize: 10485760, // 10MB
    maxFiles: 5,
  }),
  new winston.transports.File({
    filename: path.join(logsDir, 'combined.log'),
    maxsize: 10485760, // 10MB
    maxFiles: 5,
  }),
];

if (process.env.NODE_ENV !== 'production') {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
} else {
  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels: logLevels,
  format,
  transports,
  exitOnError: false,
});

export class Logger {
  private context: string;
  private metadata: Record<string, any>;

  constructor(context: string, metadata?: Record<string, any>) {
    this.context = context;
    this.metadata = metadata || {};
  }

  private formatMessage(message: string, meta?: Record<string, any>): string {
    return `[${this.context}] ${message}`;
  }

  private getMeta(meta?: Record<string, any>): Record<string, any> {
    return {
      ...this.metadata,
      ...meta,
      context: this.context,
      timestamp: new Date().toISOString(),
    };
  }

  error(message: string, error?: Error | any, meta?: Record<string, any>): void {
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

  warn(message: string, meta?: Record<string, any>): void {
    logger.warn(this.formatMessage(message), this.getMeta(meta));
  }

  info(message: string, meta?: Record<string, any>): void {
    logger.info(this.formatMessage(message), this.getMeta(meta));
  }

  http(message: string, meta?: Record<string, any>): void {
    logger.http(this.formatMessage(message), this.getMeta(meta));
  }

  debug(message: string, meta?: Record<string, any>): void {
    logger.debug(this.formatMessage(message), this.getMeta(meta));
  }

  static createRequestLogger(req: Request): Logger {
    const requestId = (req as any).id || Math.random().toString(36).substring(7);
    const userId = (req as any).userId;
    
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
    return (req: Request, res: any, next: any) => {
      const requestId = Math.random().toString(36).substring(7);
      (req as any).id = requestId;
      
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

  private static sanitizeBody(body: any): any {
    if (!body) return undefined;
    
    const sanitized = { ...body };
    const sensitiveFields = ['password', 'token', 'secret', 'api_key', 'credit_card'];
    
    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }

  static auditLog(action: string, details: {
    userId?: string;
    organizationId?: string;
    resourceType?: string;
    resourceId?: string;
    changes?: any;
    result?: 'success' | 'failure';
    reason?: string;
  }): void {
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
    
    fs.appendFileSync(
      path.join(logsDir, 'audit.log'),
      JSON.stringify(auditEntry) + '\n'
    );
  }

  static securityLog(event: string, details: {
    userId?: string;
    ip?: string;
    userAgent?: string;
    threat?: string;
    action?: string;
    blocked?: boolean;
  }): void {
    const securityLogger = new Logger('Security');
    
    securityLogger.warn(event, details);
    
    const securityEntry = {
      event,
      ...details,
      timestamp: new Date().toISOString(),
    };
    
    fs.appendFileSync(
      path.join(logsDir, 'security.log'),
      JSON.stringify(securityEntry) + '\n'
    );
  }

  static performanceLog(operation: string, duration: number, metadata?: any): void {
    const perfLogger = new Logger('Performance');
    
    const level = duration > 1000 ? 'warn' : 'debug';
    perfLogger[level](`Operation ${operation} took ${duration}ms`, {
      operation,
      duration,
      ...metadata,
    });
  }
}

export default logger;