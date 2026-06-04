import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { createHash } from 'crypto';

interface CSRFTokenStore {
  tokens: Map<string, { token: string; createdAt: number; used: boolean }>;
  cleanupInterval: NodeJS.Timeout;
}

const tokenStore: CSRFTokenStore = {
  tokens: new Map(),
  cleanupInterval: setInterval(() => {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour
    
    for (const [key, value] of tokenStore.tokens.entries()) {
      if (now - value.createdAt > maxAge || value.used) {
        tokenStore.tokens.delete(key);
      }
    }
  }, 5 * 60 * 1000), // Cleanup every 5 minutes
};

export class CSRFProtection {
  private static readonly TOKEN_LENGTH = 32;
  private static readonly TOKEN_HEADER = 'x-csrf-token';
  private static readonly TOKEN_BODY_FIELD = '_csrf';
  private static readonly TOKEN_QUERY_PARAM = '_csrf';
  
  static generateToken(userId?: string): string {
    const token = crypto.randomBytes(this.TOKEN_LENGTH).toString('hex');
    const key = userId || token;
    
    tokenStore.tokens.set(key, {
      token,
      createdAt: Date.now(),
      used: false,
    });
    
    return token;
  }
  
  static validateToken(token: string, userId?: string): boolean {
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
  
  static middleware(options: { 
    skipMethods?: string[]; 
    skipPaths?: RegExp[];
    requireAuth?: boolean;
  } = {}) {
    const skipMethods = options.skipMethods || ['GET', 'HEAD', 'OPTIONS'];
    const skipPaths = options.skipPaths || [];
    const requireAuth = options.requireAuth !== false;
    
    return (req: Request, res: Response, next: NextFunction) => {
      if (skipMethods.includes(req.method)) {
        return next();
      }
      
      const shouldSkip = skipPaths.some(pattern => pattern.test(req.path));
      if (shouldSkip) {
        return next();
      }
      
      const token = req.headers[this.TOKEN_HEADER] as string ||
                   req.body?.[this.TOKEN_BODY_FIELD] ||
                   req.query[this.TOKEN_QUERY_PARAM] as string;
      
      const userId = requireAuth ? (req as any).userId : undefined;
      
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
    return (req: Request, res: Response) => {
      const userId = (req as any).userId;
      const token = this.generateToken(userId);
      
      res.json({ 
        csrf_token: token,
        expires_in: 3600,
      });
    };
  }
}

export const csrfProtection = CSRFProtection.middleware({
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

export const csrfProtectionStrict = CSRFProtection.middleware({
  skipMethods: ['GET', 'HEAD', 'OPTIONS'],
  requireAuth: true,
});

export function attachCSRFToken(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' && (req as any).userId) {
    const token = CSRFProtection.generateToken((req as any).userId);
    res.setHeader('X-CSRF-Token', token);
  }
  next();
}