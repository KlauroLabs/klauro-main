import { Injectable } from '@nestjs/common';
import { UserEntity } from './entities/user.entity';

@Injectable()
export class UserRepository {
  async findByTenantAndEmail(tenantId: string, email: string): Promise<UserEntity | null> {
    return null;
  }
}
