import * as dotenv from 'dotenv';
dotenv.config();

export const authConfig = {
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'unravl-access-secret-change-in-production',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'unravl-refresh-secret-change-in-production',
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
    tokenBlacklistTTL: parseInt(process.env.TOKEN_BLACKLIST_TTL || '86400'), // 24 hours in seconds
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5'),
    loginAttemptWindow: parseInt(process.env.LOGIN_ATTEMPT_WINDOW || '900'), // 15 minutes in seconds
    passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || '8'),
    passwordRequireUppercase: process.env.PASSWORD_REQUIRE_UPPERCASE === 'true',
    passwordRequireLowercase: process.env.PASSWORD_REQUIRE_LOWERCASE === 'true',
    passwordRequireNumbers: process.env.PASSWORD_REQUIRE_NUMBERS === 'true',
    passwordRequireSpecial: process.env.PASSWORD_REQUIRE_SPECIAL === 'true',
  },
  
  cookies: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: (process.env.COOKIE_SAME_SITE || 'lax') as 'lax' | 'strict' | 'none',
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
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // 5 requests per window
      message: 'Too many authentication attempts, please try again later',
    },
    api: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // 100 requests per window
      message: 'Too many requests, please try again later',
    },
  },
};