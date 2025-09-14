import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SpatialController } from './spatial.controller';
import { SpatialAnalyzer } from './spatial-analyzer';
import { TelemetryOverlayService } from './telemetry-overlay.service';
import { AnalyzerModule } from '../analyzer/analyzer.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    AnalyzerModule
  ],
  controllers: [SpatialController],
  providers: [
    SpatialAnalyzer,
    TelemetryOverlayService
  ],
  exports: [
    SpatialAnalyzer,
    TelemetryOverlayService
  ]
})
export class SpatialModule {}