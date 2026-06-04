import { BadRequestException, Injectable } from '@nestjs/common';
import { AppLoggerService } from '../logger/app-logger.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UserRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    private readonly users: UserRepository,
    private readonly logger: AppLoggerService,
  ) {}

  async create(dto: CreateUserDto) {
    const existing = await this.users.findByTenantAndEmail('tenant-1', dto.email);
    if (existing) {
      throw new BadRequestException('Email already exists for tenant');
    }
    this.logger.info('Creating user', { tenantId: 'tenant-1' });
    return { ...dto, tenantId: 'tenant-1' };
  }
}
