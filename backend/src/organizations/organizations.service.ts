import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';

import { Organization } from '../database/entities/organization.entity';
import { Membership } from '../database/entities/membership.entity';

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: EntityRepository<Organization>,
    @InjectRepository(Membership)
    private readonly membershipRepository: EntityRepository<Membership>,
  ) {}

  async findAll(): Promise<Organization[]> {
    return this.organizationRepository.findAll();
  }

  async findOne(id: string): Promise<Organization | null> {
    return this.organizationRepository.findOne(id, {
      populate: ['memberships'],
    });
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    return this.organizationRepository.findOne({ slug });
  }

  async findUserMemberships(userId: string): Promise<Membership[]> {
    return this.membershipRepository.find({ user: userId }, {
      populate: ['organization'],
    });
  }
}