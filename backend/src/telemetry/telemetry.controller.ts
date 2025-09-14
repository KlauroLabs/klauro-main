import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimitInterceptor } from '../common/interceptors/rate-limit.interceptor';
import { TelemetryService } from './services/telemetry.service';
import { BackpressureManager } from './services/backpressure.service';
import { MetricsCalculator } from './services/metrics-calculator.service';
import { TelemetryMessage, TelemetryPayloadType } from './types/telemetry.types';
import { TelemetryBatchDto } from './dto/telemetry.dto';

@ApiTags('Telemetry')
@Controller('api/telemetry')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseInterceptors(RateLimitInterceptor)
export class TelemetryController {
  private readonly logger = new Logger(TelemetryController.name);

  constructor(
    private readonly telemetryService: TelemetryService,
    private readonly backpressureManager: BackpressureManager,
    private readonly metricsCalculator: MetricsCalculator,
  ) {}

  @Post('ingest')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ingest telemetry data' })
  @ApiResponse({ status: 202, description: 'Telemetry data accepted for processing' })
  @ApiResponse({ status: 400, description: 'Invalid telemetry data' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async ingestTelemetry(
    @Body(new ValidationPipe({ transform: true })) message: TelemetryMessage,
  ) {
    try {
      // Check rate limits
      const rateLimitStatus = await this.telemetryService.getRateLimitStatus(message.projectId);
      if (rateLimitStatus.remaining <= 0) {
        throw new BadRequestException('Rate limit exceeded. Please retry later.');
      }

      // Check backpressure
      const canProcess = await this.backpressureManager.checkBackpressure(
        message.projectId,
        1
      );

      if (!canProcess) {
        return {
          success: false,
          message: 'System overloaded. Please retry later.',
          retryAfter: 5000,
        };
      }

      // Ingest telemetry
      await this.telemetryService.ingestTelemetry(message);

      return {
        success: true,
        message: 'Telemetry data accepted',
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to ingest telemetry: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Post('batch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ingest batch of telemetry events' })
  @ApiResponse({ status: 202, description: 'Batch accepted for processing' })
  @ApiResponse({ status: 400, description: 'Invalid batch data' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async ingestBatch(
    @Body(new ValidationPipe({ transform: true })) batch: TelemetryBatchDto,
  ) {
    try {
      // Check backpressure for batch
      const canProcess = await this.backpressureManager.checkBackpressure(
        batch.projectId,
        batch.events.length
      );

      if (!canProcess) {
        return {
          success: false,
          message: 'System overloaded. Please retry later.',
          retryAfter: 10000,
        };
      }

      // Process batch
      await this.telemetryService.processBatch(batch);

      return {
        success: true,
        processed: batch.events.length,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to process batch: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('metrics/:projectId')
  @ApiOperation({ summary: 'Get project telemetry metrics' })
  @ApiResponse({ status: 200, description: 'Project metrics' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getProjectMetrics(@Param('projectId') projectId: string) {
    try {
      const metrics = await this.telemetryService.getProjectMetrics(projectId);
      
      if (!metrics || Object.keys(metrics).length === 0) {
        throw new NotFoundException('No metrics found for project');
      }

      return {
        projectId,
        metrics,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to get metrics: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('aggregated/:projectId')
  @ApiOperation({ summary: 'Get aggregated metrics for a project' })
  @ApiResponse({ status: 200, description: 'Aggregated metrics' })
  async getAggregatedMetrics(
    @Param('projectId') projectId: string,
    @Query('window') window: '1m' | '5m' | '15m' | '1h' | '24h' = '1m',
  ) {
    try {
      const aggregation = await this.telemetryService.getAggregatedMetrics(projectId, window);
      
      if (!aggregation) {
        return {
          projectId,
          window,
          metrics: {
            requestCount: 0,
            errorCount: 0,
            avgLatency: 0,
            avgCpu: 0,
            avgMemory: 0,
            availability: 100,
          },
          timestamp: Date.now(),
        };
      }

      return aggregation;
    } catch (error) {
      this.logger.error(`Failed to get aggregated metrics: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('recent/:projectId')
  @ApiOperation({ summary: 'Get recent telemetry data' })
  @ApiResponse({ status: 200, description: 'Recent telemetry events' })
  async getRecentTelemetry(
    @Param('projectId') projectId: string,
    @Query('limit') limit: number = 100,
  ) {
    try {
      const events = await this.telemetryService.getRecentTelemetry(projectId, limit);
      
      return {
        projectId,
        events,
        count: events.length,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to get recent telemetry: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('hotspots/:projectId')
  @ApiOperation({ summary: 'Detect performance hotspots' })
  @ApiResponse({ status: 200, description: 'Detected hotspots' })
  async detectHotspots(@Param('projectId') projectId: string) {
    try {
      const recentEvents = await this.telemetryService.getRecentTelemetry(projectId, 1000);
      const telemetryEvents = recentEvents.map(e => ({
        id: e.id,
        type: e.type as any,
        timestamp: e.timestamp.getTime(),
        data: e.data,
      }));

      const hotspots = await this.metricsCalculator.detectHotspots(telemetryEvents);
      
      return {
        projectId,
        hotspots,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to detect hotspots: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('bottlenecks/:projectId')
  @ApiOperation({ summary: 'Detect system bottlenecks' })
  @ApiResponse({ status: 200, description: 'Detected bottlenecks' })
  async detectBottlenecks(@Param('projectId') projectId: string) {
    try {
      const recentEvents = await this.telemetryService.getRecentTelemetry(projectId, 1000);
      const telemetryEvents = recentEvents.map(e => ({
        id: e.id,
        type: e.type as any,
        timestamp: e.timestamp.getTime(),
        data: e.data,
      }));

      const bottlenecks = await this.metricsCalculator.detectBottlenecks(telemetryEvents);
      
      return {
        projectId,
        bottlenecks,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to detect bottlenecks: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('memory-leak/:projectId')
  @ApiOperation({ summary: 'Check for memory leaks' })
  @ApiResponse({ status: 200, description: 'Memory leak detection result' })
  async checkMemoryLeak(@Param('projectId') projectId: string) {
    try {
      const recentEvents = await this.telemetryService.getRecentTelemetry(projectId, 500);
      const telemetryEvents = recentEvents.map(e => ({
        id: e.id,
        type: e.type as any,
        timestamp: e.timestamp.getTime(),
        data: e.data,
      }));

      const hasLeak = this.metricsCalculator.detectMemoryLeak(telemetryEvents);
      
      return {
        projectId,
        hasMemoryLeak: hasLeak,
        message: hasLeak 
          ? 'Potential memory leak detected. Memory usage shows consistent upward trend.'
          : 'No memory leak detected.',
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to check memory leak: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('rate-limit/:projectId')
  @ApiOperation({ summary: 'Get rate limit status for project' })
  @ApiResponse({ status: 200, description: 'Rate limit status' })
  async getRateLimitStatus(@Param('projectId') projectId: string) {
    try {
      const status = await this.telemetryService.getRateLimitStatus(projectId);
      
      return {
        projectId,
        ...status,
        percentage: ((status.current / status.limit) * 100).toFixed(2),
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to get rate limit status: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Get('backpressure/:projectId')
  @ApiOperation({ summary: 'Get backpressure state for project' })
  @ApiResponse({ status: 200, description: 'Backpressure state' })
  async getBackpressureState(@Param('projectId') projectId: string) {
    try {
      const state = await this.backpressureManager.getProjectBackpressureState(projectId);
      
      return {
        projectId,
        state: state || {
          eventsPerSecond: 0,
          queueDepth: 0,
          memoryUsage: 0,
          cpuUsage: 0,
          capacity: 0,
        },
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to get backpressure state: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Post('reset-limits/:projectId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset rate limits for project (admin only)' })
  @ApiResponse({ status: 200, description: 'Limits reset successfully' })
  async resetLimits(@Param('projectId') projectId: string) {
    try {
      await this.backpressureManager.resetProjectLimits(projectId);
      
      return {
        success: true,
        message: 'Project limits reset successfully',
        projectId,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to reset limits: ${error.message}`, error.stack);
      throw error;
    }
  }
}