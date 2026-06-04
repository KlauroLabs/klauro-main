import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import passport from 'passport';
import { AuthService } from '../auth/auth-service';
import { AuthMiddleware } from '../auth/middleware/auth-middleware';
import { authConfig } from '../config/auth.config';
import { AuthRequest, RegisterRequest, OAuthProfile } from '../types';
import { body, validationResult } from 'express-validator';
import { rateLimiters } from '../middleware/rate-limiter';
import { OAuthSecurity } from '../auth/oauth-security';

export function createAuthRoutes(pool: Pool): Router {
  const router = Router();
  const authService = new AuthService(pool);
  const authMiddleware = new AuthMiddleware(pool);

  // Rate limiting is now handled by specific limiters in middleware/rate-limiter.ts

  // Validation middleware
  const validateRegister = [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: authConfig.security.passwordMinLength }),
    body('first_name').optional().trim().isLength({ min: 1, max: 100 }),
    body('last_name').optional().trim().isLength({ min: 1, max: 100 }),
    body('organization_name').optional().trim().isLength({ min: 2, max: 255 }),
  ];

  const validateLogin = [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ];

  const handleValidationErrors = (req: Request, res: Response, next: NextFunction): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    next();
  };

  // Register endpoint
  router.post('/register', rateLimiters.auth.register, validateRegister, handleValidationErrors, async (req: Request, res: Response) => {
    try {
      const registerData: RegisterRequest = req.body;
      const authResponse = await authService.register(registerData);

      // Set refresh token cookie
      res.cookie(authConfig.cookies.refreshTokenName, authResponse.refresh_token, {
        httpOnly: authConfig.cookies.httpOnly,
        secure: authConfig.cookies.secure,
        sameSite: authConfig.cookies.sameSite,
        domain: authConfig.cookies.domain,
        path: authConfig.cookies.path,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.status(201).json({
        access_token: authResponse.access_token,
        token_type: authResponse.token_type,
        expires_in: authResponse.expires_in,
        user: authResponse.user,
        organizations: authResponse.organizations,
      });
    } catch (error: any) {
      res.status(400).json({ error: 'Registration failed', message: error.message });
    }
  });

  // Login endpoint
  router.post('/login', rateLimiters.auth.login, validateLogin, handleValidationErrors, async (req: Request, res: Response) => {
    try {
      const loginData: AuthRequest = req.body;
      const authResponse = await authService.login(loginData);

      // Set refresh token cookie
      res.cookie(authConfig.cookies.refreshTokenName, authResponse.refresh_token, {
        httpOnly: authConfig.cookies.httpOnly,
        secure: authConfig.cookies.secure,
        sameSite: authConfig.cookies.sameSite,
        domain: authConfig.cookies.domain,
        path: authConfig.cookies.path,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.json({
        access_token: authResponse.access_token,
        token_type: authResponse.token_type,
        expires_in: authResponse.expires_in,
        user: authResponse.user,
        organizations: authResponse.organizations,
      });
    } catch (error: any) {
      res.status(401).json({ error: 'Authentication failed', message: error.message });
    }
  });

  // Logout endpoint
  router.post('/logout', authMiddleware.authenticate, async (req: Request, res: Response) => {
    try {
      const refreshToken = req.cookies[authConfig.cookies.refreshTokenName];
      
      if (refreshToken) {
        await authService.logout(refreshToken);
      }

      // Clear refresh token cookie
      res.clearCookie(authConfig.cookies.refreshTokenName, {
        domain: authConfig.cookies.domain,
        path: authConfig.cookies.path,
      });

      res.json({ message: 'Logged out successfully' });
    } catch (error: any) {
      res.status(500).json({ error: 'Logout failed', message: error.message });
    }
  });

  // Logout all devices endpoint
  router.post('/logout-all', authMiddleware.authenticate, async (req: Request, res: Response) => {
    try {
      await authService.logoutAllDevices((req as any).userId!);

      // Clear refresh token cookie
      res.clearCookie(authConfig.cookies.refreshTokenName, {
        domain: authConfig.cookies.domain,
        path: authConfig.cookies.path,
      });

      res.json({ message: 'Logged out from all devices successfully' });
    } catch (error: any) {
      res.status(500).json({ error: 'Logout failed', message: error.message });
    }
  });

  // Refresh token endpoint
  router.post('/refresh', rateLimiters.auth.tokenRefresh, async (req: Request, res: Response) => {
    try {
      const refreshToken = req.cookies[authConfig.cookies.refreshTokenName] || req.body.refreshToken;
      
      if (!refreshToken) {
        return res.status(401).json({ error: 'Refresh token required' });
      }

      const authResponse = await authService.refreshToken(refreshToken);

      // Set new refresh token cookie
      res.cookie(authConfig.cookies.refreshTokenName, authResponse.refresh_token, {
        httpOnly: authConfig.cookies.httpOnly,
        secure: authConfig.cookies.secure,
        sameSite: authConfig.cookies.sameSite,
        domain: authConfig.cookies.domain,
        path: authConfig.cookies.path,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.json({
        access_token: authResponse.access_token,
        token_type: authResponse.token_type,
        expires_in: authResponse.expires_in,
        user: authResponse.user,
        organizations: authResponse.organizations,
      });
    } catch (error: any) {
      res.status(401).json({ error: 'Token refresh failed', message: error.message });
    }
  });

  // Get current user endpoint
  router.get('/me', authMiddleware.authenticate, async (req: Request, res: Response) => {
    try {
      const { user, memberships } = await authService.getUserWithMemberships((req as any).userId!);
      res.json({ user, memberships });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to fetch user', message: error.message });
    }
  });

  // OAuth routes
  const providers = ['github', 'google', 'microsoft', 'gitlab'];

  providers.forEach(provider => {
    // OAuth initiation endpoint
    router.get(`/oauth/${provider}`, (req, res, next) => {
      const returnUrl = req.query.return_url as string;
      const { state, codeChallenge } = OAuthSecurity.createOAuthSession(provider, returnUrl);
      
      const authOptions: any = {
        scope: (authConfig.oauth as any)[provider].scope,
        state,
      };
      
      if (codeChallenge && provider === 'github') {
        authOptions.code_challenge = codeChallenge;
        authOptions.code_challenge_method = 'S256';
      }
      
      passport.authenticate(provider, authOptions)(req, res, next);
    });

    // OAuth callback endpoint
    router.get(`/oauth/${provider}/callback`,
      rateLimiters.auth.oauthCallback,
      OAuthSecurity.middleware(),
      passport.authenticate(provider, { session: false, failureRedirect: '/login' }),
      async (req: Request, res: Response) => {
        try {
          const profile = req.user as OAuthProfile;
          const oauthState = (req as any).oauthState;
          const authResponse = await authService.loginWithOAuth(profile);

          // Set refresh token cookie
          res.cookie(authConfig.cookies.refreshTokenName, authResponse.refresh_token, {
            httpOnly: authConfig.cookies.httpOnly,
            secure: authConfig.cookies.secure,
            sameSite: authConfig.cookies.sameSite,
            domain: authConfig.cookies.domain,
            path: authConfig.cookies.path,
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
          });

          // Redirect to frontend with access token
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
          const returnUrl = oauthState.returnUrl || '/dashboard';
          res.redirect(`${frontendUrl}/auth/callback?token=${authResponse.access_token}&return=${encodeURIComponent(returnUrl)}`);
        } catch (error: any) {
          res.redirect(`/login?error=${encodeURIComponent(error.message)}`);
        }
      }
    );
  });

  // Verify email endpoint
  router.post('/verify-email', authMiddleware.authenticate, async (req: Request, res: Response) => {
    try {
      // TODO: Implement email verification with token
      // For now, we'll just mark the email as verified
      const userRepo = new (require('../database/repositories/user-repository').UserRepository)(pool);
      await userRepo.verifyEmail((req as any).userId!);
      
      res.json({ message: 'Email verified successfully' });
    } catch (error: any) {
      res.status(500).json({ error: 'Email verification failed', message: error.message });
    }
  });

  // Resend verification email endpoint
  router.post('/resend-verification', authMiddleware.authenticate, rateLimiters.auth.emailVerification, async (req: Request, res: Response) => {
    try {
      // TODO: Implement email sending service
      res.json({ message: 'Verification email sent' });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to send verification email', message: error.message });
    }
  });

  // Password reset request endpoint
  router.post('/forgot-password', rateLimiters.auth.passwordReset,
    body('email').isEmail().normalizeEmail(),
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        // TODO: Implement password reset token generation and email sending
        res.json({ message: 'Password reset email sent if account exists' });
      } catch (error: any) {
        // Don't reveal if email exists
        res.json({ message: 'Password reset email sent if account exists' });
      }
    }
  );

  // Password reset confirmation endpoint
  router.post('/reset-password', rateLimiters.auth.passwordReset,
    body('token').notEmpty(),
    body('password').isLength({ min: authConfig.security.passwordMinLength }),
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        // TODO: Implement password reset with token validation
        res.json({ message: 'Password reset successfully' });
      } catch (error: any) {
        res.status(400).json({ error: 'Password reset failed', message: error.message });
      }
    }
  );

  // Change password endpoint (for authenticated users)
  router.post('/change-password', authMiddleware.authenticate,
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: authConfig.security.passwordMinLength }),
    handleValidationErrors,
    async (req: Request, res: Response) => {
      try {
        // TODO: Implement password change
        res.json({ message: 'Password changed successfully' });
      } catch (error: any) {
        res.status(400).json({ error: 'Password change failed', message: error.message });
      }
    }
  );

  return router;
}

// Install validation middleware
export async function installValidation() {
  const { body } = await import('express-validator');
  return { body };
}