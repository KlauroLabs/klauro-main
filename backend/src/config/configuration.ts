import * as Joi from 'joi';
import { Options } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

export const configurationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3001),
  
  // Database
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().port().default(5432),
  DB_NAME: Joi.string().default('unravl'),
  DB_USER: Joi.string().default('postgres'),
  DB_PASSWORD: Joi.string().allow(''),
  
  // JWT
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('1h'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),
  
  // OAuth
  GOOGLE_CLIENT_ID: Joi.string().allow(''),
  GOOGLE_CLIENT_SECRET: Joi.string().allow(''),
  GITHUB_CLIENT_ID: Joi.string().allow(''),
  GITHUB_CLIENT_SECRET: Joi.string().allow(''),
  MICROSOFT_CLIENT_ID: Joi.string().allow(''),
  MICROSOFT_CLIENT_SECRET: Joi.string().allow(''),
  
  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow(''),
  
  // Rate Limiting
  THROTTLE_TTL: Joi.number().default(60000),
  THROTTLE_LIMIT: Joi.number().default(100),
  ANALYSIS_THROTTLE_TTL: Joi.number().default(300000),
  ANALYSIS_THROTTLE_LIMIT: Joi.number().default(5),
  
  // AI Services
  OPENAI_API_KEY: Joi.string().allow(''),
  ANTHROPIC_API_KEY: Joi.string().allow(''),
  
  // Frontend
  FRONTEND_URL: Joi.string().uri().default('http://localhost:3000'),
  
  // Analysis
  MAX_ANALYSIS_CONCURRENT: Joi.number().default(3),
  ANALYSIS_TIMEOUT: Joi.number().default(300000), // 5 minutes
  
  // File Upload
  MAX_FILE_SIZE: Joi.number().default(50 * 1024 * 1024), // 50MB
  UPLOAD_DEST: Joi.string().default('./uploads'),
});

export interface DatabaseConfig extends Options {
  driver: typeof PostgreSqlDriver;
  host: string;
  port: number;
  user: string;
  password?: string;
  dbName: string;
}