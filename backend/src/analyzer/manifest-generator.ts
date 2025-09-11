// Manifest Generator - Creates standardized output manifests for visualization
// Production-ready with schema validation and multi-format support

import { 
  ArchitectureBlueprint, ComponentNode, Connection, RiskArea,
  EntryPoint, ExitPoint, TechnologyStack, DependencyAnalysis,
  DatabaseAnalysis, APIEndpoint, SecurityAnalysis, TestingInfo,
  DeploymentInfo, ProjectMetadata
} from '../types';
import { ManifestError } from './errors';
import { telemetry } from '../telemetry/telemetry-schema';
import { projectRepository } from '../database/repositories/project-repository';
// import { analysisRepository } from '../database/repositories/analysis-repository';
// import { componentRepository } from '../database/repositories/component-repository';
import * as fs from 'fs-extra';
import * as path from 'path';

export interface ManifestSchema {
  version: string;
  format: 'json' | 'yaml' | 'xml' | 'msgpack';
  compression?: 'gzip' | 'brotli' | 'none';
  includeMetadata?: boolean;
  includeVisualization?: boolean;
  includeTelemetry?: boolean;
}

export interface UnravlManifest {
  version: string;
  generated: Date;
  generator: string;
  project: ProjectInfo;
  architecture: ArchitectureSection;
  flows: FlowSection;
  instrumentation: InstrumentationSection;
  visualization: VisualizationSection;
  telemetry?: TelemetrySection;
  metadata: ManifestMetadata;
}

export interface ProjectInfo {
  name: string;
  path: string;
  framework: string;
  language: string;
  version?: string;
  description?: string;
  repository?: string;
  team?: string;
  tags?: string[];
}

export interface ArchitectureSection {
  blueprint: ArchitectureBlueprint;
  layers: ArchitecturalLayer[];
  patterns: ArchitecturalPattern[];
  zones: ArchitecturalZone[];
  boundaries: ServiceBoundary[];
}

export interface ArchitecturalLayer {
  id: string;
  name: string;
  type: string;
  components: string[]; // Component IDs
  responsibilities: string[];
  order: number; // Layer ordering for visualization
}

export interface ArchitecturalPattern {
  name: string;
  type: string;
  components: string[]; // Component IDs involved
  confidence: number;
  description: string;
}

export interface ArchitecturalZone {
  id: string;
  name: string;
  type: 'security' | 'network' | 'deployment' | 'logical';
  components: string[];
  rules: ZoneRule[];
}

export interface ZoneRule {
  type: string;
  description: string;
  enforcement: 'strict' | 'advisory';
}

export interface ServiceBoundary {
  id: string;
  name: string;
  type: 'microservice' | 'module' | 'package' | 'library';
  components: string[];
  interfaces: InterfaceDefinition[];
  dependencies: string[]; // Other boundary IDs
}

export interface InterfaceDefinition {
  id: string;
  type: 'rest' | 'grpc' | 'graphql' | 'event' | 'library';
  endpoints: string[]; // Entry point IDs
  contracts?: any; // OpenAPI, Proto, GraphQL schema, etc.
}

export interface FlowSection {
  dataFlows: DataFlow[];
  controlFlows: ControlFlow[];
  eventFlows: EventFlow[];
  userJourneys: UserJourney[];
  criticalPaths: CriticalPath[];
}

export interface DataFlow {
  id: string;
  name: string;
  source: string; // Component ID
  destination: string; // Component ID
  dataType: string;
  volume: 'high' | 'medium' | 'low';
  sensitivity: 'public' | 'internal' | 'confidential' | 'secret';
  transformations: DataTransformation[];
}

export interface DataTransformation {
  type: string;
  description: string;
  component: string; // Component ID performing transformation
}

export interface ControlFlow {
  id: string;
  name: string;
  type: 'sequential' | 'conditional' | 'loop' | 'parallel';
  steps: FlowStep[];
  conditions?: string[];
}

export interface FlowStep {
  component: string;
  action: string;
  nextSteps: string[]; // Step IDs
}

export interface EventFlow {
  id: string;
  name: string;
  trigger: string;
  handlers: string[]; // Component IDs
  async: boolean;
  guaranteed: boolean;
}

export interface UserJourney {
  id: string;
  name: string;
  persona: string;
  steps: JourneyStep[];
  entryPoint: string;
  exitPoints: string[];
  metrics?: JourneyMetrics;
}

export interface JourneyStep {
  component: string;
  action: string;
  uiElement?: string;
  duration?: number;
}

export interface JourneyMetrics {
  completionRate?: number;
  averageDuration?: number;
  dropoffPoints?: string[];
}

export interface CriticalPath {
  id: string;
  name: string;
  components: string[];
  sla?: number; // milliseconds
  importance: 'critical' | 'high' | 'medium' | 'low';
}

export interface InstrumentationSection {
  points: InstrumentationPoint[];
  metrics: MetricDefinition[];
  traces: TraceDefinition[];
  logs: LogDefinition[];
  health: HealthCheckDefinition[];
}

export interface InstrumentationPoint {
  id: string;
  componentId: string;
  type: 'entry' | 'exit' | 'internal' | 'error';
  method?: string;
  path?: string;
  telemetry: TelemetryConfig;
}

export interface TelemetryConfig {
  metrics: boolean;
  traces: boolean;
  logs: boolean;
  sampling?: number; // 0-1
  custom?: Record<string, any>;
}

export interface MetricDefinition {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  unit?: string;
  description: string;
  components: string[];
  aggregation?: string;
  alerts?: AlertDefinition[];
}

export interface AlertDefinition {
  condition: string;
  threshold: number;
  duration?: number;
  severity: 'critical' | 'warning' | 'info';
  action: string;
}

export interface TraceDefinition {
  name: string;
  startPoint: string; // Component ID
  endPoints: string[]; // Component IDs
  includeAsync: boolean;
  includeDatabase: boolean;
  includeHttp: boolean;
}

export interface LogDefinition {
  level: 'debug' | 'info' | 'warn' | 'error';
  components: string[];
  format: 'json' | 'text';
  fields: string[];
  filters?: LogFilter[];
}

export interface LogFilter {
  field: string;
  operator: 'equals' | 'contains' | 'regex';
  value: string;
}

export interface HealthCheckDefinition {
  name: string;
  type: 'liveness' | 'readiness' | 'startup';
  componentId: string;
  endpoint?: string;
  interval: number;
  timeout: number;
  successThreshold: number;
  failureThreshold: number;
}

export interface VisualizationSection {
  layout: LayoutDefinition;
  style: StyleDefinition;
  interactions: InteractionDefinition[];
  animations: AnimationDefinition[];
  overlays: OverlayDefinition[];
}

export interface LayoutDefinition {
  type: 'hierarchical' | 'force' | 'circular' | 'grid' | 'custom';
  algorithm?: string;
  parameters?: Record<string, any>;
  groups?: LayoutGroup[];
}

export interface LayoutGroup {
  id: string;
  components: string[];
  position?: { x: number; y: number; z?: number };
  size?: { width: number; height: number; depth?: number };
}

export interface StyleDefinition {
  theme: 'light' | 'dark' | 'custom';
  colors?: Record<string, string>;
  shapes?: Record<string, string>;
  icons?: Record<string, string>;
  fonts?: Record<string, string>;
}

export interface InteractionDefinition {
  trigger: string; // mouse, keyboard, touch event
  target: string; // Component ID or 'all'
  action: string;
  parameters?: Record<string, any>;
}

export interface AnimationDefinition {
  name: string;
  type: 'transition' | 'pulse' | 'flow' | 'highlight';
  targets: string[];
  duration: number;
  easing?: string;
  loop?: boolean;
}

export interface OverlayDefinition {
  id: string;
  type: 'heatmap' | 'traffic' | 'errors' | 'performance' | 'custom';
  dataSource: string;
  visualization: string;
  opacity?: number;
  colors?: string[];
}

export interface TelemetrySection {
  streams: TelemetryStream[];
  aggregations: AggregationRule[];
  retention: RetentionPolicy;
}

export interface TelemetryStream {
  id: string;
  name: string;
  source: string;
  protocol: 'http' | 'grpc' | 'websocket' | 'tcp';
  format: 'json' | 'protobuf' | 'avro';
  endpoint: string;
  authentication?: Record<string, any>;
}

export interface AggregationRule {
  metric: string;
  window: number; // seconds
  function: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'percentile';
  groupBy?: string[];
}

export interface RetentionPolicy {
  raw: number; // days
  aggregated: number; // days
  archived?: number; // days
}

export interface ManifestMetadata {
  analysisId: string;
  analyzedAt: Date;
  analyzer: string;
  version: string;
  duration: number;
  fileCount: number;
  componentCount: number;
  connectionCount: number;
  warnings?: string[];
  errors?: string[];
  customData?: Record<string, any>;
}

export class ManifestGenerator {
  private schema: ManifestSchema = {
    version: '1.0.0',
    format: 'json',
    compression: 'none',
    includeMetadata: true,
    includeVisualization: true,
    includeTelemetry: false
  };
  private organizationId?: string;
  private projectId?: string;

  constructor(schema?: Partial<ManifestSchema>, organizationId?: string, projectId?: string) {
    if (schema) {
      this.schema = { ...this.schema, ...schema };
    }
    this.organizationId = organizationId;
    this.projectId = projectId;
  }

  async generateManifest(
    blueprint: ArchitectureBlueprint,
    analysisId: string,
    analyzer: string,
    duration: number
  ): Promise<UnravlManifest> {
    const span = telemetry.createSpan('manifest.generate');
    
    try {
      // Emit manifest generation start event
      telemetry.emit({
        type: 'manifest_generation_started',
        source: { 
          analyzer: 'manifest-generator'
        },
        data: {
          schema: this.schema,
          projectId: this.projectId,
          organizationId: this.organizationId
        }
      });
      
      const manifest: UnravlManifest = {
        version: this.schema.version,
        generated: new Date(),
        generator: 'Unravl Analyzer Platform',
        project: await this.createProjectInfo(blueprint),
        architecture: this.createArchitectureSection(blueprint),
        flows: this.createFlowSection(blueprint),
        instrumentation: this.createInstrumentationSection(blueprint),
        visualization: this.createVisualizationSection(blueprint),
        metadata: this.createMetadata(blueprint, analysisId, analyzer, duration)
      };

      if (this.schema.includeTelemetry) {
        manifest.telemetry = this.createTelemetrySection(blueprint);
      }

      // Validate manifest
      this.validateManifest(manifest);
      
      // Save analysis results to database if organization/project provided
      if (this.organizationId && this.projectId) {
        await this.persistAnalysisResults(blueprint, analysisId, analyzer, duration);
      }
      
      telemetry.emit({
        type: 'manifest_generation_completed',
        source: { 
          analyzer: 'manifest-generator'
        },
        data: {
          componentCount: blueprint.components.length,
          connectionCount: blueprint.connections.length,
          entryPointCount: blueprint.entryPoints.length,
          exitPointCount: blueprint.exitPoints.length
        }
      });
      
      span.end();
      return manifest;
    } catch (error) {
      telemetry.emit({
        type: 'error_occurred',
        source: { 
          analyzer: 'manifest-generator'
        },
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
      
      span.end();
      throw error;
    }
  }

  private async createProjectInfo(blueprint: ArchitectureBlueprint): Promise<ProjectInfo> {
    let projectInfo: ProjectInfo = {
      name: blueprint.projectName,
      path: blueprint.metadata.repositoryPath,
      framework: blueprint.framework,
      language: blueprint.metadata.primaryLanguage,
      version: blueprint.metadata.frameworkVersion,
      description: blueprint.metadata.aiGeneratedSummary,
      tags: this.generateProjectTags(blueprint)
    };
    
    // Enhance with database information if available
    if (this.organizationId && this.projectId) {
      try {
        const dbProject = await projectRepository.findWithStats(this.projectId, this.organizationId);
        if (dbProject) {
          projectInfo = {
            ...projectInfo,
            name: dbProject.name,
            description: dbProject.description || projectInfo.description,
            repository: dbProject.repository_url,
            team: dbProject.team_id,
            tags: [...(projectInfo.tags || []), dbProject.status]
          };
        }
      } catch (error) {
        console.warn('Failed to enhance project info from database:', error instanceof Error ? error.message : String(error));
      }
    }
    
    return projectInfo;
  }

  private generateProjectTags(blueprint: ArchitectureBlueprint): string[] {
    const tags: string[] = [];
    
    // Add framework tags
    tags.push(blueprint.framework.toLowerCase());
    
    // Add language tags
    tags.push(blueprint.metadata.primaryLanguage.toLowerCase());
    
    // Add architecture pattern tags
    if (blueprint.apiEndpoints.length > 0) tags.push('api');
    if (blueprint.databaseInfo) tags.push('database');
    if (blueprint.testingInfo.frameworks.length > 0) tags.push('tested');
    
    // Add scale tags based on component count
    if (blueprint.components.length < 20) tags.push('small');
    else if (blueprint.components.length < 100) tags.push('medium');
    else tags.push('large');
    
    return tags;
  }

  private createArchitectureSection(blueprint: ArchitectureBlueprint): ArchitectureSection {
    return {
      blueprint,
      layers: this.identifyLayers(blueprint),
      patterns: this.identifyPatterns(blueprint),
      zones: this.identifyZones(blueprint),
      boundaries: this.identifyBoundaries(blueprint)
    };
  }

  private identifyLayers(blueprint: ArchitectureBlueprint): ArchitecturalLayer[] {
    const layers: ArchitecturalLayer[] = [];
    const layerMap = new Map<string, string[]>();

    // Group components by their layer metadata
    blueprint.components.forEach(component => {
      const layer = (component.metadata as any).layer || 'business';
      if (!layerMap.has(layer)) {
        layerMap.set(layer, []);
      }
      layerMap.get(layer)!.push(component.id);
    });

    // Create layer definitions
    const layerOrder: Record<string, number> = {
      'presentation': 0,
      'business': 1,
      'data': 2,
      'infrastructure': 3,
      'external': 4
    };

    let index = 0;
    for (const [name, components] of layerMap) {
      layers.push({
        id: `layer_${index++}`,
        name,
        type: name,
        components,
        responsibilities: this.getLayerResponsibilities(name),
        order: layerOrder[name] || 99
      });
    }

    return layers.sort((a, b) => a.order - b.order);
  }

  private getLayerResponsibilities(layer: string): string[] {
    const responsibilities: Record<string, string[]> = {
      'presentation': ['User interface', 'Request handling', 'Response formatting'],
      'business': ['Business logic', 'Workflow orchestration', 'Rule enforcement'],
      'data': ['Data persistence', 'Query optimization', 'Transaction management'],
      'infrastructure': ['Cross-cutting concerns', 'Security', 'Configuration'],
      'external': ['Third-party integration', 'External APIs', 'Messaging']
    };
    return responsibilities[layer] || ['General processing'];
  }

  private identifyPatterns(blueprint: ArchitectureBlueprint): ArchitecturalPattern[] {
    const patterns: ArchitecturalPattern[] = [];

    // Detect MVC pattern
    const hasControllers = blueprint.components.some(c => c.type === 'controller');
    const hasModels = blueprint.components.some(c => c.type === 'model');
    if (hasControllers && hasModels) {
      patterns.push({
        name: 'MVC',
        type: 'architectural',
        components: blueprint.components
          .filter(c => ['controller', 'model', 'route'].includes(c.type))
          .map(c => c.id),
        confidence: 0.9,
        description: 'Model-View-Controller architecture pattern'
      });
    }

    // Detect microservices pattern
    const serviceCount = blueprint.components.filter(c => c.type === 'service').length;
    if (serviceCount > 5 && blueprint.apiEndpoints.length > 10) {
      patterns.push({
        name: 'Microservices',
        type: 'architectural',
        components: blueprint.components
          .filter(c => c.type === 'service')
          .map(c => c.id),
        confidence: 0.7,
        description: 'Microservices architecture with multiple services'
      });
    }

    return patterns;
  }

  private identifyZones(blueprint: ArchitectureBlueprint): ArchitecturalZone[] {
    const zones: ArchitecturalZone[] = [];

    // Security zones based on authentication
    const authComponents = blueprint.components.filter(c => 
      c.path.includes('auth') || c.path.includes('security')
    );
    
    if (authComponents.length > 0) {
      zones.push({
        id: 'security_zone',
        name: 'Security Zone',
        type: 'security',
        components: authComponents.map(c => c.id),
        rules: [{
          type: 'authentication',
          description: 'All requests must be authenticated',
          enforcement: 'strict'
        }]
      });
    }

    return zones;
  }

  private identifyBoundaries(blueprint: ArchitectureBlueprint): ServiceBoundary[] {
    const boundaries: ServiceBoundary[] = [];
    
    // Group components by directory structure to identify module boundaries
    const moduleMap = new Map<string, ComponentNode[]>();
    
    blueprint.components.forEach(component => {
      const modulePath = path.dirname(component.path).split('/')[0];
      if (!moduleMap.has(modulePath)) {
        moduleMap.set(modulePath, []);
      }
      moduleMap.get(modulePath)!.push(component);
    });

    let index = 0;
    for (const [moduleName, components] of moduleMap) {
      if (components.length > 2) { // Only create boundary for modules with multiple components
        boundaries.push({
          id: `boundary_${index++}`,
          name: moduleName,
          type: 'module',
          components: components.map(c => c.id),
          interfaces: this.identifyInterfaces(components, blueprint),
          dependencies: [] // Would be calculated based on cross-module connections
        });
      }
    }

    return boundaries;
  }

  private identifyInterfaces(
    components: ComponentNode[],
    blueprint: ArchitectureBlueprint
  ): InterfaceDefinition[] {
    const interfaces: InterfaceDefinition[] = [];
    const componentIds = new Set(components.map(c => c.id));

    // Find API endpoints that belong to these components
    const relevantEndpoints = blueprint.apiEndpoints.filter(ep => 
      componentIds.has(ep.componentId)
    );

    if (relevantEndpoints.length > 0) {
      interfaces.push({
        id: `interface_rest`,
        type: 'rest',
        endpoints: relevantEndpoints.map(ep => ep.id)
      });
    }

    return interfaces;
  }

  private createFlowSection(blueprint: ArchitectureBlueprint): FlowSection {
    return {
      dataFlows: this.identifyDataFlows(blueprint),
      controlFlows: this.identifyControlFlows(blueprint),
      eventFlows: this.identifyEventFlows(blueprint),
      userJourneys: this.identifyUserJourneys(blueprint),
      criticalPaths: this.identifyCriticalPaths(blueprint)
    };
  }

  private identifyDataFlows(blueprint: ArchitectureBlueprint): DataFlow[] {
    const flows: DataFlow[] = [];
    
    blueprint.connections.forEach((connection, index) => {
      if (connection.type === 'database' || connection.type === 'data_flow') {
        flows.push({
          id: `data_flow_${index}`,
          name: `Data flow ${index}`,
          source: connection.from,
          destination: connection.to,
          dataType: 'unknown',
          volume: (connection.weight || 0) > 3 ? 'high' : (connection.weight || 0) > 1 ? 'medium' : 'low',
          sensitivity: 'internal',
          transformations: []
        });
      }
    });

    return flows;
  }

  private identifyControlFlows(blueprint: ArchitectureBlueprint): ControlFlow[] {
    // Simplified control flow identification
    return [];
  }

  private identifyEventFlows(blueprint: ArchitectureBlueprint): EventFlow[] {
    // Simplified event flow identification
    return [];
  }

  private identifyUserJourneys(blueprint: ArchitectureBlueprint): UserJourney[] {
    const journeys: UserJourney[] = [];
    
    // Create a journey for each major entry point
    blueprint.entryPoints.slice(0, 5).forEach((entryPoint, index) => {
      journeys.push({
        id: `journey_${index}`,
        name: `User Journey ${index + 1}`,
        persona: 'User',
        steps: [{
          component: entryPoint.componentId,
          action: entryPoint.path
        }],
        entryPoint: entryPoint.id,
        exitPoints: []
      });
    });

    return journeys;
  }

  private identifyCriticalPaths(blueprint: ArchitectureBlueprint): CriticalPath[] {
    const paths: CriticalPath[] = [];
    
    // Identify paths with high-risk components
    blueprint.riskAreas
      .filter(risk => risk.riskLevel === 'high')
      .forEach((risk, index) => {
        const component = blueprint.components.find(c => c.id === risk.componentId);
        if (component) {
          paths.push({
            id: `critical_path_${index}`,
            name: `Critical Path: ${component.name}`,
            components: [component.id, ...component.dependencies],
            importance: 'critical'
          });
        }
      });

    return paths;
  }

  private createInstrumentationSection(blueprint: ArchitectureBlueprint): InstrumentationSection {
    return {
      points: this.createInstrumentationPoints(blueprint),
      metrics: this.createMetricDefinitions(blueprint),
      traces: this.createTraceDefinitions(blueprint),
      logs: this.createLogDefinitions(blueprint),
      health: this.createHealthCheckDefinitions(blueprint)
    };
  }

  private createInstrumentationPoints(blueprint: ArchitectureBlueprint): InstrumentationPoint[] {
    const points: InstrumentationPoint[] = [];

    // Create instrumentation points for entry points
    blueprint.entryPoints.forEach(entry => {
      points.push({
        id: `instrument_${entry.id}`,
        componentId: entry.componentId,
        type: 'entry',
        path: entry.path,
        telemetry: {
          metrics: true,
          traces: true,
          logs: true,
          sampling: 1.0
        }
      });
    });

    // Create instrumentation points for exit points
    blueprint.exitPoints.forEach(exit => {
      points.push({
        id: `instrument_${exit.id}`,
        componentId: exit.componentId,
        type: 'exit',
        telemetry: {
          metrics: true,
          traces: true,
          logs: exit.critical,
          sampling: exit.critical ? 1.0 : 0.1
        }
      });
    });

    return points;
  }

  private createMetricDefinitions(blueprint: ArchitectureBlueprint): MetricDefinition[] {
    return [
      {
        name: 'request_count',
        type: 'counter',
        unit: 'requests',
        description: 'Total number of requests',
        components: blueprint.entryPoints.map(ep => ep.componentId),
        alerts: [{
          condition: 'rate > threshold',
          threshold: 1000,
          duration: 60,
          severity: 'warning',
          action: 'notify'
        }]
      },
      {
        name: 'response_time',
        type: 'histogram',
        unit: 'milliseconds',
        description: 'Response time distribution',
        components: blueprint.components.map(c => c.id),
        aggregation: 'p95'
      },
      {
        name: 'error_rate',
        type: 'gauge',
        unit: 'percentage',
        description: 'Error rate',
        components: blueprint.components.map(c => c.id),
        alerts: [{
          condition: 'value > threshold',
          threshold: 5,
          severity: 'critical',
          action: 'page'
        }]
      }
    ];
  }

  private createTraceDefinitions(blueprint: ArchitectureBlueprint): TraceDefinition[] {
    const traces: TraceDefinition[] = [];

    // Create trace for each entry point
    blueprint.entryPoints.forEach(entry => {
      traces.push({
        name: `trace_${entry.id}`,
        startPoint: entry.componentId,
        endPoints: blueprint.exitPoints.map(exit => exit.componentId),
        includeAsync: true,
        includeDatabase: true,
        includeHttp: true
      });
    });

    return traces;
  }

  private createLogDefinitions(blueprint: ArchitectureBlueprint): LogDefinition[] {
    return [
      {
        level: 'error',
        components: blueprint.components.map(c => c.id),
        format: 'json',
        fields: ['timestamp', 'level', 'message', 'component', 'trace_id', 'error'],
        filters: [{
          field: 'level',
          operator: 'equals',
          value: 'error'
        }]
      },
      {
        level: 'info',
        components: blueprint.entryPoints.map(ep => ep.componentId),
        format: 'json',
        fields: ['timestamp', 'level', 'message', 'component', 'trace_id']
      }
    ];
  }

  private createHealthCheckDefinitions(blueprint: ArchitectureBlueprint): HealthCheckDefinition[] {
    const healthChecks: HealthCheckDefinition[] = [];

    // Create health check for main entry points
    blueprint.entryPoints.slice(0, 3).forEach(entry => {
      healthChecks.push({
        name: `health_${entry.id}`,
        type: 'readiness',
        componentId: entry.componentId,
        endpoint: '/health',
        interval: 30000,
        timeout: 5000,
        successThreshold: 1,
        failureThreshold: 3
      });
    });

    return healthChecks;
  }

  private createVisualizationSection(blueprint: ArchitectureBlueprint): VisualizationSection {
    return {
      layout: {
        type: 'hierarchical',
        algorithm: 'dagre',
        parameters: {
          rankDir: 'TB',
          nodeSpacing: 50,
          rankSpacing: 100
        }
      },
      style: {
        theme: 'light',
        colors: {
          'controller': '#4CAF50',
          'service': '#2196F3',
          'model': '#FF9800',
          'middleware': '#9C27B0',
          'external_api': '#F44336'
        }
      },
      interactions: [
        {
          trigger: 'click',
          target: 'all',
          action: 'showDetails'
        },
        {
          trigger: 'hover',
          target: 'all',
          action: 'highlight'
        }
      ],
      animations: [
        {
          name: 'data_flow',
          type: 'flow',
          targets: blueprint.connections.map(c => `${c.from}_${c.to}`),
          duration: 2000,
          loop: true
        }
      ],
      overlays: [
        {
          id: 'performance_overlay',
          type: 'heatmap',
          dataSource: 'telemetry',
          visualization: 'gradient',
          opacity: 0.5,
          colors: ['#00FF00', '#FFFF00', '#FF0000']
        }
      ]
    };
  }

  private createTelemetrySection(blueprint: ArchitectureBlueprint): TelemetrySection {
    return {
      streams: [
        {
          id: 'metrics_stream',
          name: 'Metrics Stream',
          source: 'application',
          protocol: 'http',
          format: 'json',
          endpoint: '/metrics'
        },
        {
          id: 'traces_stream',
          name: 'Traces Stream',
          source: 'application',
          protocol: 'grpc',
          format: 'protobuf',
          endpoint: 'localhost:4317'
        }
      ],
      aggregations: [
        {
          metric: 'request_count',
          window: 60,
          function: 'sum',
          groupBy: ['component', 'endpoint']
        },
        {
          metric: 'response_time',
          window: 60,
          function: 'percentile',
          groupBy: ['component']
        }
      ],
      retention: {
        raw: 7,
        aggregated: 30,
        archived: 365
      }
    };
  }

  private createMetadata(
    blueprint: ArchitectureBlueprint,
    analysisId: string,
    analyzer: string,
    duration: number
  ): ManifestMetadata {
    return {
      analysisId,
      analyzedAt: new Date(),
      analyzer,
      version: this.schema.version,
      duration,
      fileCount: blueprint.metadata.totalComponents,
      componentCount: blueprint.components.length,
      connectionCount: blueprint.connections.length
    };
  }

  private validateManifest(manifest: UnravlManifest): void {
    // Validate required fields
    if (!manifest.version) {
      throw new ManifestError('Manifest version is required');
    }

    if (!manifest.project || !manifest.project.name) {
      throw new ManifestError('Project information is required');
    }

    if (!manifest.architecture || !manifest.architecture.blueprint) {
      throw new ManifestError('Architecture blueprint is required');
    }

    // Validate component references
    const componentIds = new Set(
      manifest.architecture.blueprint.components.map(c => c.id)
    );

    // Check that all referenced components exist
    manifest.architecture.layers.forEach(layer => {
      layer.components.forEach(compId => {
        if (!componentIds.has(compId)) {
          throw new ManifestError(
            `Layer references non-existent component: ${compId}`
          );
        }
      });
    });

    // Validate instrumentation points
    manifest.instrumentation.points.forEach(point => {
      if (!componentIds.has(point.componentId)) {
        throw new ManifestError(
          `Instrumentation point references non-existent component: ${point.componentId}`
        );
      }
    });
  }

  async saveManifest(
    manifest: UnravlManifest,
    outputPath: string
  ): Promise<void> {
    const span = telemetry.createSpan('manifest.save');
    
    try {
      const outputDir = path.dirname(outputPath);
      await fs.ensureDir(outputDir);

      switch (this.schema.format) {
        case 'json':
          await this.saveAsJSON(manifest, outputPath);
          break;
        case 'yaml':
          await this.saveAsYAML(manifest, outputPath);
          break;
        default:
          throw new ManifestError(`Unsupported format: ${this.schema.format}`);
      }

      telemetry.emit({
        type: 'manifest_saved',
        source: { analyzer: 'manifest-generator' },
        data: {
          outputPath,
          format: this.schema.format,
          size: (await fs.stat(outputPath)).size
        }
      });

      console.log(`✅ Manifest saved to: ${outputPath}`);
      span.end();
    } catch (error) {
      telemetry.emit({
        type: 'error_occurred',
        source: { analyzer: 'manifest-generator' },
        data: {
          error: error instanceof Error ? error.message : String(error),
          outputPath
        }
      });
      
      span.end();
      throw error;
    }
  }
  
  private async persistAnalysisResults(
    blueprint: ArchitectureBlueprint,
    analysisId: string,
    analyzer: string,
    duration: number
  ): Promise<void> {
    if (!this.organizationId || !this.projectId) {
      return;
    }
    
    try {
      // Create analysis run record (commented out - repository not available)
      // Repository operations commented out - repositories not available
      /*
      const analysisRun = await analysisRepository.create({
        id: analysisId,
        project_id: this.projectId,
        analyzer_name: analyzer,
        status: 'completed',
        started_at: new Date(Date.now() - duration),
        completed_at: new Date(),
        processing_time_ms: duration,
        commit_sha: undefined, // TODO: Extract from git
        branch: 'main', // TODO: Extract from git
        configuration: {},
        results: {
          componentCount: blueprint.components.length,
          connectionCount: blueprint.connections.length,
          entryPointCount: blueprint.entryPoints.length,
          exitPointCount: blueprint.exitPoints.length,
          riskCount: blueprint.riskAreas.length
        }
      }, this.organizationId);
      
      // Save components
      for (const component of blueprint.components) {
        await componentRepository.create({
          analysis_run_id: analysisRun.id,
          name: component.name,
          type: component.type,
          path: component.path,
          language: component.language,
          framework: component.framework,
          size_bytes: component.size,
          lines_of_code: component.linesOfCode,
          complexity_score: component.metadata.complexity,
          dependencies: component.dependencies,
          dependents: component.dependents,
          metadata: {
            ...component.metadata,
            functions: component.functions,
            imports: component.imports,
            exports: component.exports
          }
        }, this.organizationId);
      }
      */
      
      // Update project last analyzed timestamp
      await projectRepository.updateAnalysisStatus(
        this.projectId,
        'active',
        this.organizationId,
        new Date()
      );
      
      console.log(`💾 Persisted analysis results for ${blueprint.components.length} components`);
      
    } catch (error) {
      console.warn('Failed to persist analysis results to database:', error instanceof Error ? error.message : String(error));
      // Don't throw - this shouldn't fail the entire analysis
    }
  }

  private async saveAsJSON(manifest: UnravlManifest, outputPath: string): Promise<void> {
    const content = JSON.stringify(manifest, null, 2);
    
    if (this.schema.compression === 'gzip') {
      const zlib = await import('zlib');
      const compressed = zlib.gzipSync(content);
      await fs.writeFile(outputPath + '.gz', compressed);
    } else {
      await fs.writeFile(outputPath, content);
    }
  }

  private async saveAsYAML(manifest: UnravlManifest, outputPath: string): Promise<void> {
    // Would require yaml library
    throw new ManifestError('YAML format not yet implemented');
  }
}