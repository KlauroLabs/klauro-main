import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [
    TerminusModule,
    MikroOrmModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}