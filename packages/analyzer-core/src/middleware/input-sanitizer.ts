import { Request, Response, NextFunction } from 'express';
import { body, param, query, validationResult, ValidationChain } from 'express-validator';
import DOMPurify from 'isomorphic-dompurify';
import validator from 'validator';

export class InputSanitizer {
  private static readonly SQL_INJECTION_PATTERNS = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|EXEC|EXECUTE|SCRIPT|TRUNCATE)\b)/gi,
    /(--|\/\*|\*\/|xp_|sp_|0x)/gi,
    /(\bOR\b\s*\d+\s*=\s*\d+|\bAND\b\s*\d+\s*=\s*\d+)/gi,
  ];
  
  private static readonly XSS_PATTERNS = [
    /<script[^>]*>.*?<\/script>/gi,
    /<iframe[^>]*>.*?<\/iframe>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi,
    /<embed[^>]*>/gi,
    /<object[^>]*>/gi,
  ];
  
  private static readonly PATH_TRAVERSAL_PATTERNS = [
    /\.\.\//g,
    /\.\.%2[fF]/g,
    /%2[eE]\./g,
    /\x00/g,
  ];
  
  private static readonly COMMAND_INJECTION_PATTERNS = [
    /[;&|`$]/g,
    /\$\(/g,
    /\|\|/g,
    /&&/g,
  ];
  
  static sanitizeString(value: string, options: {
    maxLength?: number;
    allowHtml?: boolean;
    allowSpecialChars?: boolean;
    trim?: boolean;
  } = {}): string {
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
      sanitized = DOMPurify.sanitize(sanitized, { ALLOWED_TAGS: [] });
    }
    
    if (!options.allowSpecialChars) {
      sanitized = validator.escape(sanitized);
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
  
  static sanitizePath(path: string): string {
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
  
  static sanitizeCommand(command: string): string {
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
  
  static sanitizeEmail(email: string): string {
    if (!validator.isEmail(email)) {
      throw new Error('Invalid email format');
    }
    
    return validator.normalizeEmail(email) || email;
  }
  
  static sanitizeUrl(url: string, options: {
    protocols?: string[];
    requireProtocol?: boolean;
  } = {}): string {
    const urlOptions = {
      protocols: options.protocols || ['http', 'https'],
      require_protocol: options.requireProtocol !== false,
    };
    
    if (!validator.isURL(url, urlOptions)) {
      throw new Error('Invalid URL format');
    }
    
    return url;
  }
  
  static sanitizeNumber(value: any, options: {
    min?: number;
    max?: number;
    isInt?: boolean;
  } = {}): number {
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
  
  static sanitizeUUID(uuid: string): string {
    if (!validator.isUUID(uuid)) {
      throw new Error('Invalid UUID format');
    }
    
    return uuid.toLowerCase();
  }
  
  static sanitizeJSON(json: string): any {
    try {
      const parsed = JSON.parse(json);
      return JSON.parse(JSON.stringify(parsed));
    } catch {
      throw new Error('Invalid JSON format');
    }
  }
  
  static middleware(options: {
    skipPaths?: RegExp[];
    strict?: boolean;
  } = {}) {
    return (req: Request, res: Response, next: NextFunction) => {
      const skipPaths = options.skipPaths || [];
      const shouldSkip = skipPaths.some(pattern => pattern.test(req.path));
      
      if (shouldSkip) {
        return next();
      }
      
      try {
        if (req.body && typeof req.body === 'object') {
          req.body = this.sanitizeObject(req.body, options.strict);
        }
        
        // In Express 5, req.query and req.params are read-only
        // We'll validate them but not modify them
        // Security validation still happens through express-validator
        
        next();
      } catch (error: any) {
        res.status(400).json({
          error: 'Bad Request',
          message: error.message || 'Invalid input detected',
        });
      }
    };
  }
  
  private static sanitizeObject(obj: any, strict?: boolean): any {
    if (obj === null || obj === undefined) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item, strict));
    }
    
    if (typeof obj === 'object') {
      const sanitized: any = {};
      
      for (const [key, value] of Object.entries(obj)) {
        const sanitizedKey = this.sanitizeString(key, { maxLength: 100 });
        
        if (typeof value === 'string') {
          sanitized[sanitizedKey] = this.sanitizeString(value, {
            maxLength: strict ? 10000 : undefined,
            allowHtml: false,
            allowSpecialChars: !strict,
          });
        } else {
          sanitized[sanitizedKey] = this.sanitizeObject(value, strict);
        }
      }
      
      return sanitized;
    }
    
    return obj;
  }
}

export const validators = {
  email: () => body('email').isEmail().normalizeEmail().withMessage('Invalid email address'),
  
  password: (minLength: number = 8) => 
    body('password')
      .isLength({ min: minLength })
      .withMessage(`Password must be at least ${minLength} characters`)
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .withMessage('Password must contain uppercase, lowercase, and numbers'),
  
  uuid: (field: string) => 
    param(field).isUUID().withMessage(`Invalid ${field} UUID`),
  
  pagination: () => [
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],
  
  sortOrder: () => 
    query('sort').optional().isIn(['asc', 'desc', 'ASC', 'DESC']),
  
  date: (field: string) => 
    body(field).optional().isISO8601().toDate(),
  
  url: (field: string) => 
    body(field).optional().isURL({
      protocols: ['http', 'https'],
      require_protocol: true,
    }),
  
  slug: (field: string) => 
    body(field)
      .optional()
      .matches(/^[a-z0-9-]+$/)
      .withMessage('Slug must contain only lowercase letters, numbers, and hyphens'),
  
  phone: (field: string) => 
    body(field).optional().isMobilePhone('any'),
  
  alphanumeric: (field: string) => 
    body(field).isAlphanumeric().withMessage(`${field} must be alphanumeric`),
  
  json: (field: string) => 
    body(field).isJSON().withMessage(`${field} must be valid JSON`),
};

export function handleValidationErrors(req: Request, res: Response, next: NextFunction) {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map(err => ({
      field: err.type === 'field' ? (err as any).path : undefined,
      message: err.msg,
      value: (err as any).value,
    }));
    
    return res.status(400).json({
      error: 'Validation Error',
      message: 'Input validation failed',
      errors: formattedErrors,
    });
  }
  
  next();
}

export const globalInputSanitizer = InputSanitizer.middleware({
  skipPaths: [
    /^\/api\/health/,
    /^\/api\/metrics/,
  ],
  strict: false,
});