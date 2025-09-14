import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { Organization } from '../database/entities/organization.entity';
import { Membership } from '../database/entities/membership.entity';
import { Project } from '../database/entities/project.entity';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Organization,
      Membership,
      Project,
    ]),
  ],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}