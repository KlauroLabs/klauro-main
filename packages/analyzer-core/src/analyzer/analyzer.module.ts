import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { AnalyzerController } from './analyzer.controller';
import { FunctionCallController } from './controllers/function-call.controller';
import { PatternDetector } from './patterns/pattern-detector';
import { FunctionCallService } from './services/function-call.service';
import { CASAnalyzerService } from './services/cas-analyzer.service';
import { ProjectsModule } from '../projects/projects.module';

import { AnalysisRun } from '../database/entities/analysis-run.entity';
import { Component } from '../database/entities/component.entity';
import { ComponentConnection } from '../database/entities/component-connection.entity';
import { FunctionCall } from '../database/entities/function-call.entity';
import { CallChain } from '../database/entities/call-chain.entity';

@Module({
  imports: [
    ProjectsModule,
    MikroOrmModule.forFeature([
      AnalysisRun,
      Component,
      ComponentConnection,
      FunctionCall,
      CallChain
    ])
  ],
  controllers: [AnalyzerController, FunctionCallController],
  providers: [
    PatternDetector,
    CASAnalyzerService,
    FunctionCallService
  ],
  exports: [
    PatternDetector,
    CASAnalyzerService,
    FunctionCallService
  ],
})
export class AnalyzerModule {}