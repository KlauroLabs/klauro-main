import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RedisModule } from '@nestjs-modules/ioredis';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { TelemetryController } from './telemetry.controller';
import { TelemetryGateway } from './gateways/telemetry.gateway';
import { TelemetryService } from './services/telemetry.service';
import { BackpressureManager } from './services/backpressure.service';
import { EventAggregator } from './services/event-aggregator.service';
import { MetricsCalculator } from './services/metrics-calculator.service';
import { ConnectionPool } from './services/connection-pool.service';
import { WsAuthGuard } from './guards/ws-auth.guard';
import { TelemetryData } from '../database/entities/telemetry-data.entity';
import { TelemetryRealtimeService } from './services/telemetry-realtime.service';

// Check if database is disabled using environment variable directly
const isDatabaseDisabled = process.env.DISABLE_DATABASE === 'true';

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
  RedisModule.forRootAsync({
    imports: [ConfigModule],
    inject: [ConfigService],
    useFactory: (configService: ConfigService) => ({
      type: 'single',
      url: configService.get('REDIS_URL', 'redis://localhost:6379'),
    }),
  }),
];

const databaseImports = isDatabaseDisabled ? [] : [
  MikroOrmModule.forFeature([TelemetryData]),
];

@Module({
  imports: [
    ...baseImports,
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