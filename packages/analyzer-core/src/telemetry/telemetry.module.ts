import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RedisModule } from '@nestjs-modules/ioredis';
import * as dotenv from 'dotenv';

import { TelemetryController } from './telemetry.controller';
import { TelemetryGateway } from './gateways/telemetry.gateway';
import { TelemetryService } from './services/telemetry.service';
import { BackpressureManager } from './services/backpressure.service';
import { EventAggregator } from './services/event-aggregator.service';
import { MetricsCalculator } from './services/metrics-calculator.service';
import { ConnectionPool } from './services/connection-pool.service';
import { WsAuthGuard } from './guards/ws-auth.guard';
// import { TelemetryData } from '../database/entities/telemetry-data.entity';
import { TelemetryRealtimeService } from './services/telemetry-realtime.service';

// Load .env file first
dotenv.config();

// Check if database and Redis are disabled using environment variable directly
const isDatabaseDisabled = process.env.DISABLE_DATABASE === 'true';
const isRedisDisabled = process.env.DISABLE_REDIS === 'true';

const baseProviders = [
  TelemetryService,
  BackpressureManager,
  EventAggregator,
  MetricsCalculator,
  ConnectionPool,
  WsAuthGuard,
  TelemetryRealtimeService,
];

const databaseProviders = isDatabaseDisabled ? [] : [
  // Database-dependent providers would go here if needed
];

const baseImports = [
  ConfigModule,
  JwtModule.registerAsync({
    imports: [ConfigModule],
    inject: [ConfigService],
    useFactory: (configService: ConfigService) => ({
      secret: configService.get('JWT_SECRET', 'dev-secret-change-in-production'),
      signOptions: { expiresIn: '1h' },
    }),
  }),
];

const redisImports = isRedisDisabled ? [] : [
  RedisModule.forRootAsync({
    imports: [ConfigModule],
    inject: [ConfigService],
    useFactory: (configService: ConfigService) => ({
      type: 'single',
      url: configService.get('REDIS_URL', 'redis://localhost:6379'),
      options: {
        maxRetriesPerRequest: 3,
        enableReadyCheck: false,
        showFriendlyErrorStack: true,
        retryStrategy: (times: number) => {
          if (times > 3) {
            console.log('Redis connection failed after 3 retries, disabling Redis');
            return null;
          }
          return Math.min(times * 50, 500);
        },
      },
    }),
  }),
];

const databaseImports = isDatabaseDisabled ? [] : [
  // MikroOrmModule.forFeature([TelemetryData]), // Commented out to avoid import
];

@Module({
  imports: [
    ...baseImports,
    ...redisImports,
    ...databaseImports,
  ],
  controllers: [TelemetryController],
  providers: [
    TelemetryGateway,
    ...baseProviders,
    ...databaseProviders,
  ],
  exports: [
    TelemetryService,
    TelemetryGateway,
    TelemetryRealtimeService,
    BackpressureManager,
    EventAggregator,
    MetricsCalculator,
    ConnectionPool,
  ],
})
export class TelemetryModule {}