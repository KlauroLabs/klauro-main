import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { CodebasesController } from './codebases.controller';
import { CodebasesService } from './codebases.service';
import { Codebase } from '../database/entities/codebase.entity';
import { Workspace } from '../database/entities/workspace.entity';
import { User } from '../database/entities/user.entity';
import { WorkspaceAccess } from '../database/entities/workspace-access.entity';
import { AnalysisRun } from '../database/entities/analysis-run.entity';
import { Component } from '../database/entities/component.entity';
import { CodebaseConnection } from '../database/entities/codebase-connection.entity';
import { Tag } from '../database/entities/tag.entity';
import { AnalyzerModule } from '../analyzer/analyzer.module';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Codebase,
      Workspace,
      User,
      WorkspaceAccess,
      AnalysisRun,
      Component,
      CodebaseConnection,
      Tag,
    ]),
    AnalyzerModule,
  ],
  controllers: [CodebasesController],
  providers: [CodebasesService],
  exports: [CodebasesService],
})
export class CodebasesModule {}