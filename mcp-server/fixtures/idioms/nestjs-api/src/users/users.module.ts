import { Module } from '@nestjs/common';
import { AppLoggerService } from '../logger/app-logger.service';
import { TenantGuard } from '../auth/tenant.guard';
import { UsersController } from './users.controller';
import { UserRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UserRepository, TenantGuard, AppLoggerService],
  exports: [UsersService],
})
export class UsersModule {}
