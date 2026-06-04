import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
dotenv.config();

function validateJWTSecret(secret: string | undefined, name: string): string {
  if (!secret) {
    throw new Error(`${name} environment variable is required for security`);
  }
  
  if (secret.length < 32) {
    throw new Error(`${name} must be at least 32 characters long`);
  }
  
  if (secret === 'klauro-access-secret-change-in-production' || 
      secret === 'klauro-refresh-secret-change-in-production') {
    throw new Error(`${name} contains default value - please set a secure secret`);
  }
  
  const entropy = calculateEntropy(secret);
  if (entropy < 3.5) {
    throw new Error(`${name} has insufficient entropy (${entropy.toFixed(2)} bits/char). Use a more complex secret.`);
  }
  
  return secret;
}

function calculateEntropy(str: string): number {
  const charCounts: { [key: string]: number } = {};
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

export const authConfig = {
  jwt: {
    accessSecret: isProduction 
      ? validateJWTSecret(process.env.JWT_ACCESS_SECRET, 'JWT_ACCESS_SECRET')
      : process.env.JWT_ACCESS_SECRET || crypto.randomBytes(32).toString('hex'),
    refreshSecret: isProduction
      ? validateJWTSecret(process.env.JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET')
      : process.env.JWT_REFRESH_SECRET || crypto.randomBytes(32).toString('hex'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    issuer: process.env.JWT_ISSUER || 'klauro',
    audience: process.env.JWT_AUDIENCE || 'klauro-api',
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
    refreshTokenName: 'klauro_refresh_token',
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