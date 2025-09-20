import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { AnalysisService } from './analysis.service';
import { AnalysisResult } from '../database/entities/analysis-result.entity';
import { AnalysisRun } from '../database/entities/analysis-run.entity';
import { PatternDetection } from '../database/entities/pattern-detection.entity';
import { AnalyzerModule } from '../analyzer/analyzer.module';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      AnalysisResult,
      AnalysisRun,
      PatternDetection,
    ]),
    AnalyzerModule,
  ],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}