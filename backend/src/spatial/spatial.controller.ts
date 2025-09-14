import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Param, 
  Query,
  UseGuards,
  Sse
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Observable, interval } from 'rxjs';
import { map } from 'rxjs/operators';
import { SpatialAnalyzer } from './spatial-analyzer';
import { TelemetryOverlayService } from './telemetry-overlay.service';
import { BaseAnalyzer } from '../analyzer/base-analyzer';

@ApiTags('spatial')
@Controller('api/spatial')
export class SpatialController {
  constructor(
    private readonly spatialAnalyzer: SpatialAnalyzer,
    private readonly telemetryService: TelemetryOverlayService,
    private readonly baseAnalyzer: BaseAnalyzer
  ) {}

  @Get('analyze/:repoPath')
  @ApiOperation({ summary: 'Analyze repository and generate spatial manifest' })
  @ApiResponse({ status: 200, description: 'Spatial manifest generated successfully' })
  async analyzeRepository(@Param('repoPath') repoPath: string) {
    // Perform base analysis
    const analysisResult = await this.baseAnalyzer.analyzeRepository(repoPath);
    
    // Generate spatial manifest
    const spatialManifest = await this.spatialAnalyzer.analyzeSpatialStructure(analysisResult);
    
    // Convert to visualization data
    const visualizationData = await this.spatialAnalyzer.generateVisualizationData(spatialManifest);
    
    return {
      success: true,
      data: visualizationData,
      metadata: {
        analyzedAt: new Date().toISOString(),
        repoPath,
        nodeCount: spatialManifest.nodes.size,
        connectionCount: spatialManifest.connections.length,
      }
    };
  }

  @Get('nodes')
  @ApiOperation({ summary: 'Get all spatial nodes' })
  async getNodes(@Query('level') level?: number) {
    // This would typically fetch from a database
    // For now, returning sample data structure
    return {
      nodes: [
        {
          id: 'system-root',
          type: 'system',
          name: 'Unravl Platform',
          description: 'Interactive architecture visualization system',
          level: 0,
          position: { x: 600, y: 50 },
          size: { width: 400, height: 300 },
          metrics: {
            complexity: 85,
            dependencies: 42,
            calls: 1250,
            lines: 15000
          },
          children: ['service-backend', 'service-frontend', 'service-analyzer'],
          entryPoints: [
            {
              id: 'ep-1',
              type: 'http',
              path: '/api/analyze',
              method: 'POST',
              description: 'Main analysis endpoint'
            }
          ],
          exitPoints: [
            {
              id: 'ex-1',
              type: 'database',
              target: 'PostgreSQL',
              operation: 'read/write',
              description: 'Main data store'
            }
          ],
          metadata: {
            language: 'TypeScript',
            framework: 'NestJS',
            pattern: 'microservices'
          }
        }
      ]
    };
  }

  @Get('connections')
  @ApiOperation({ summary: 'Get all connections between nodes' })
  async getConnections() {
    return {
      connections: [
        {
          id: 'conn-1',
          source: 'service-frontend',
          target: 'service-backend',
          type: 'api-call',
          label: 'REST API',
          strength: 5,
          metadata: {
            frequency: 100,
            latency: 50,
            protocol: 'https'
          }
        }
      ]
    };
  }

  @Get('telemetry/:nodeId')
  @ApiOperation({ summary: 'Get telemetry data for a specific node' })
  async getNodeTelemetry(@Param('nodeId') nodeId: string) {
    const metrics = this.telemetryService.getNodeMetrics(nodeId);
    
    return {
      nodeId,
      metrics,
      health: metrics.length > 0 ? metrics[metrics.length - 1].status : 'healthy',
      summary: {
        totalMetrics: metrics.length,
        lastUpdate: metrics.length > 0 ? new Date(metrics[metrics.length - 1].timestamp) : null
      }
    };
  }

  @Sse('telemetry/stream')
  @ApiOperation({ summary: 'Stream real-time telemetry data' })
  telemetryStream(): Observable<MessageEvent> {
    return this.telemetryService.getTelemetryStream().pipe(
      map(data => ({
        data: JSON.stringify(data),
        type: 'telemetry'
      }) as MessageEvent)
    );
  }

  @Get('health')
  @ApiOperation({ summary: 'Get system health overview' })
  async getSystemHealth() {
    const health = this.telemetryService.getSystemHealth();
    const bottlenecks = this.telemetryService.getBottlenecks();
    const unusedComponents = this.telemetryService.identifyUnusedComponents();
    
    return {
      overall: this.calculateOverallHealth(health),
      nodes: Object.fromEntries(health),
      bottlenecks,
      unusedComponents,
      timestamp: new Date().toISOString()
    };
  }

  @Get('heatmap/:metric')
  @ApiOperation({ summary: 'Generate heat map for specific metric' })
  async getHeatMap(@Param('metric') metric: string) {
    const heatMap = this.telemetryService.generateHeatMap(metric);
    
    return {
      metric,
      data: Object.fromEntries(heatMap),
      timestamp: new Date().toISOString()
    };
  }

  @Get('flows')
  @ApiOperation({ summary: 'Get active data flows' })
  async getActiveFlows() {
    const flows = this.telemetryService.getActiveFlows();
    
    return {
      flows,
      totalFlows: flows.length,
      timestamp: new Date().toISOString()
    };
  }

  @Post('simulate/traffic')
  @ApiOperation({ summary: 'Simulate traffic between nodes' })
  async simulateTraffic(@Body() body: { connectionId: string; source: string; target: string }) {
    this.telemetryService.simulateTraffic(body.connectionId, body.source, body.target);
    
    return {
      success: true,
      message: 'Traffic simulation started'
    };
  }

  @Post('journey')
  @ApiOperation({ summary: 'Track user journey through system' })
  async trackJourney(@Body() body: { sessionId: string; path: string[] }) {
    this.telemetryService.trackUserJourney(body.sessionId, body.path);
    
    return {
      success: true,
      sessionId: body.sessionId,
      pathLength: body.path.length
    };
  }

  @Get('export')
  @ApiOperation({ summary: 'Export all metrics data' })
  async exportMetrics() {
    return this.telemetryService.exportMetrics();
  }

  @Post('threshold')
  @ApiOperation({ summary: 'Set metric thresholds' })
  async setThreshold(@Body() body: { metric: string; warning: number; error: number }) {
    this.telemetryService.setThreshold(body.metric, body.warning, body.error);
    
    return {
      success: true,
      metric: body.metric,
      thresholds: {
        warning: body.warning,
        error: body.error
      }
    };
  }

  private calculateOverallHealth(health: Map<string, 'healthy' | 'warning' | 'error'>): string {
    const values = Array.from(health.values());
    
    if (values.some(v => v === 'error')) return 'error';
    if (values.some(v => v === 'warning')) return 'warning';
    return 'healthy';
  }
}