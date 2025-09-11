import { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { JWTPayload } from '../../types';
import { AuthService } from '../auth-service';
import { Pool } from 'pg';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
      userId?: string;
      organizationId?: string;
      userRole?: string;
    }
  }
}

export class AuthMiddleware {
  private authService: AuthService;

  constructor(pool: Pool) {
    this.authService = new AuthService(pool);
  }

  authenticate = (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('jwt', { session: false }, (err: any, user: JWTPayload | false) => {
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

  optionalAuthenticate = (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('jwt', { session: false }, (err: any, user: JWTPayload | false) => {
      if (!err && user) {
        req.user = user;
        req.userId = user.sub;
      }
      next();
    })(req, res, next);
  };

  requireOrganization = (req: Request, res: Response, next: NextFunction) => {
    const organizationId = req.params.organizationId || req.body.organizationId || req.query.organizationId;

    if (!organizationId) {
      return res.status(400).json({ error: 'Bad Request', message: 'Organization ID is required' });
    }

    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const userOrg = req.user.organizations?.find(org => org.id === organizationId);
    if (!userOrg) {
      return res.status(403).json({ error: 'Forbidden', message: 'You do not have access to this organization' });
    }

    req.organizationId = organizationId;
    req.userRole = userOrg.role;
    next();
  };

  requireVerifiedEmail = async (req: Request, res: Response, next: NextFunction) => {
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
    } catch (error) {
      return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to verify email status' });
    }
  };

  refreshTokenFromCookie = (req: Request, res: Response, next: NextFunction) => {
    const refreshToken = req.cookies?.unravl_refresh_token;
    
    if (!refreshToken) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Refresh token not found' });
    }

    req.body.refreshToken = refreshToken;
    next();
  };

  validateApiKey = (apiKeyHeader: string = 'x-api-key') => {
    return async (req: Request, res: Response, next: NextFunction) => {
      const apiKey = req.headers[apiKeyHeader] as string;

      if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized', message: 'API key required' });
      }

      // TODO: Implement API key validation logic
      // This would typically involve checking the API key against a database
      // For now, we'll just check if it matches a pattern
      if (!apiKey.startsWith('unravl_')) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
      }

      next();
    };
  };

  requireTwoFactor = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    // TODO: Implement two-factor authentication check
    // This would check if the user has 2FA enabled and if the current session has completed 2FA
    
    next();
  };

  checkSessionValidity = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next();
    }

    // Check if the user's access token is still valid
    // This is already handled by the JWT verification in passport
    // But we could add additional checks here like:
    // - Check if user account is still active
    // - Check if user hasn't been banned
    // - Check if organization membership is still valid

    try {
      const { user } = await this.authService.getUserWithMemberships(req.userId!);
      
      if (user.deleted_at) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Account has been deleted' });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to validate session' });
    }
  };
}

export function createAuthMiddleware(pool: Pool) {
  return new AuthMiddleware(pool);
}