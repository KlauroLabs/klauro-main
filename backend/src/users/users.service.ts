import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';

import { User } from '../database/entities/user.entity';
import { Membership } from '../database/entities/membership.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    @InjectRepository(Membership)
    private readonly membershipRepository: EntityRepository<Membership>,
  ) {}

  async findAll(): Promise<User[]> {
    return this.userRepository.findAll();
  }

  async findOne(id: string): Promise<User | null> {
    return this.userRepository.findOne(id);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ email });
  }

  async findUserMemberships(userId: string): Promise<Membership[]> {
    return this.membershipRepository.find({ user: userId }, {
      populate: ['organization'],
    });
  }
}