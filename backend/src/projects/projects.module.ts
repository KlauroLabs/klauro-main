import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

import { Project } from '../database/entities/project.entity';
import { Organization } from '../database/entities/organization.entity';
import { User } from '../database/entities/user.entity';
import { AnalysisRun } from '../database/entities/analysis-run.entity';
import { Component } from '../database/entities/component.entity';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Project,
      Organization,
      User,
      AnalysisRun,
      Component,
    ]),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}