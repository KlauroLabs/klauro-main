import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { AnalysisService } from './analysis.service';
import { AnalysisResult } from '../database/entities/analysis-result.entity';
import { AnalysisRun } from '../database/entities/analysis-run.entity';
import { PatternDetection } from '../database/entities/pattern-detection.entity';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      AnalysisResult,
      AnalysisRun,
      PatternDetection,
    ]),
  ],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}