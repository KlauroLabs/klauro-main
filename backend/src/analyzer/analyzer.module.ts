import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { AnalyzerController } from './analyzer.controller';
import { Component } from '../database/entities/component.entity';
import { ComponentConnection } from '../database/entities/component-connection.entity';
import { AnalysisService } from '../analysis/analysis.service';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Component,
      ComponentConnection,
    ]),
  ],
  controllers: [AnalyzerController],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalyzerModule {}