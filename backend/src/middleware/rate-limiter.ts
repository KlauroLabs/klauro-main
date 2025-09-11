import rateLimit, { RateLimitRequestHandler, Options } from 'express-rate-limit';
import { Request, Response } from 'express';

interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}


const standardHandler = (req: Request, res: Response) => {
  res.status(429).json({
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Please try again later.',
    retryAfter: res.getHeader('Retry-After'),
  });
};

export const rateLimiters = {
  strict: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many attempts, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    handler: standardHandler,
  }),
  
  auth: {
    login: rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 5,
      message: 'Too many login attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      handler: standardHandler,
    }),
    
    register: rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 3,
      message: 'Too many registration attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
    
    passwordReset: rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 3,
      message: 'Too many password reset attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
    
    emailVerification: rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 5,
      message: 'Too many email verification attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
    
    oauthCallback: rateLimit({
      windowMs: 5 * 60 * 1000,
      max: 10,
      message: 'Too many OAuth attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
    
    tokenRefresh: rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      message: 'Too many token refresh attempts, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
  },
  
  api: {
    standard: rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: 'Too many requests, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
    
    generous: rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 500,
      message: 'Too many requests, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
    
    search: rateLimit({
      windowMs: 1 * 60 * 1000,
      max: 30,
      message: 'Too many search requests, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
    
    write: rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 50,
      message: 'Too many write operations, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
    
    upload: rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 20,
      message: 'Too many uploads, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      handler: standardHandler,
    }),
  },
  
  createCustomLimiter(config: RateLimitConfig): RateLimitRequestHandler {
    return rateLimit({
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

export const globalRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
});