import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

// Import all entities
import { User } from './entities/user.entity';
import { Organization } from './entities/organization.entity';
import { Membership } from './entities/membership.entity';
import { Project } from './entities/project.entity';
import { AnalysisRun } from './entities/analysis-run.entity';
import { Component } from './entities/component.entity';
import { ComponentConnection } from './entities/component-connection.entity';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      User,
      Organization,
      Membership,
      Project,
      AnalysisRun,
      Component,
      ComponentConnection,
    ]),
  ],
  exports: [MikroOrmModule],
})
export class DatabaseModule {}