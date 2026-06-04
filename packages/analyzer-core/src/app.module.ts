import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { TerminusModule } from '@nestjs/terminus';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { HealthModule } from './health/health.module';
import { WebSocketModule } from './websocket/websocket.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { CodebasesModule } from './codebases/codebases.module';
import { ProjectsModule } from './projects/projects.module';
import { AnalysisModule } from './analysis/analysis.module';
import { ComponentsModule } from './components/components.module';

import { configurationSchema } from './config/configuration';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: configurationSchema,
    }),

    // Database
    MikroOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        driver: PostgreSqlDriver,
        host: configService.get('DB_HOST', 'localhost'),
        port: configService.get('DB_PORT', 5432),
        user: configService.get('DB_USER', 'postgres'),
        password: configService.get('DB_PASSWORD'),
        dbName: configService.get('DB_NAME', 'klauro'),
        entities: ['dist/**/*.entity.js'],
        entitiesTs: ['src/**/*.entity.ts'],
        migrations: {
          path: 'dist/database/migrations',
          pathTs: 'src/database/migrations',
          glob: '!(*.d).{js,ts}',
        },
        debug: configService.get('NODE_ENV') !== 'production',
        allowGlobalContext: true,
        forceEntityConstructor: true,
        validate: true,
        strict: true,
        discovery: {
          warnWhenNoEntities: false,
        },
      }),
    }),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => [
        {
          name: 'default',
          ttl: configService.get('THROTTLE_TTL', 60000), // 1 minute
          limit: configService.get('THROTTLE_LIMIT', 100), // 100 requests per minute
        },
        {
          name: 'analysis',
          ttl: configService.get('ANALYSIS_THROTTLE_TTL', 300000), // 5 minutes
          limit: configService.get('ANALYSIS_THROTTLE_LIMIT', 5), // 5 analysis requests per 5 minutes
        },
      ],
    }),

    // Health checks
    TerminusModule,

    // Core modules
    DatabaseModule,
    AuthModule,
    OrganizationsModule,
    UsersModule,
    WorkspacesModule,
    CodebasesModule,
    ProjectsModule,
    AnalysisModule,
    ComponentsModule,
    WebSocketModule,
    HealthModule,
    TelemetryModule,
  ],
})
export class AppModule {}
