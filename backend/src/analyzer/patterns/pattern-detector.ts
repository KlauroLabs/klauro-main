import { Injectable, Logger } from '@nestjs/common';
import { ComponentNode, Connection } from '../../types';

export interface PatternDetectionResult {
  projectId: string;
  patterns: DetectedPattern[];
  antiPatterns: DetectedAntiPattern[];
  architectureType: ArchitectureType;
  confidenceScore: number;
  recommendations: string[];
  timestamp: Date;
}

export interface DetectedPattern {
  type: PatternType;
  confidence: number;
  components: string[];
  description: string;
  location?: string;
  metadata?: Record<string, any>;
}

export interface DetectedAntiPattern {
  type: AntiPatternType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  components: string[];
  description: string;
  recommendation: string;
  impact: string;
}

export enum PatternType {
  MICROSERVICES = 'microservices',
  LAYERED = 'layered',
  EVENT_DRIVEN = 'event_driven',
  MVC = 'mvc',
  REPOSITORY = 'repository',
  FACTORY = 'factory',
  SINGLETON = 'singleton',
  OBSERVER = 'observer',
  STRATEGY = 'strategy',
  CQRS = 'cqrs',
  SAGA = 'saga',
  API_GATEWAY = 'api_gateway',
  SERVICE_MESH = 'service_mesh',
  DEPENDENCY_INJECTION = 'dependency_injection',
  HEXAGONAL = 'hexagonal'
}

export enum AntiPatternType {
  GOD_CLASS = 'god_class',
  CIRCULAR_DEPENDENCY = 'circular_dependency',
  SPAGHETTI_CODE = 'spaghetti_code',
  COPY_PASTE = 'copy_paste',
  DEAD_CODE = 'dead_code',
  LONG_METHOD = 'long_method',
  FEATURE_ENVY = 'feature_envy',
  DATA_CLUMP = 'data_clump',
  PRIMITIVE_OBSESSION = 'primitive_obsession',
  SWITCH_STATEMENTS = 'switch_statements',
  LAZY_CLASS = 'lazy_class',
  SPECULATIVE_GENERALITY = 'speculative_generality',
  MESSAGE_CHAINS = 'message_chains',
  MIDDLE_MAN = 'middle_man'
}

export enum ArchitectureType {
  MONOLITHIC = 'monolithic',
  MICROSERVICES = 'microservices',
  LAYERED = 'layered',
  EVENT_DRIVEN = 'event_driven',
  SERVICE_ORIENTED = 'service_oriented',
  SERVERLESS = 'serverless',
  HEXAGONAL = 'hexagonal',
  MIXED = 'mixed',
  UNKNOWN = 'unknown'
}

export interface PerformanceHotspot {
  componentId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  type: 'complexity' | 'size' | 'coupling' | 'performance' | 'memory';
  description: string;
  impact: number; // 1-10
  recommendation: string;
  metrics?: Record<string, number>;
}

@Injectable()
export class PatternDetector {
  private readonly logger = new Logger(PatternDetector.name);
  private readonly MICROSERVICE_THRESHOLD = 0.7;
  private readonly LAYERED_THRESHOLD = 0.6;
  private readonly GOD_CLASS_THRESHOLD = 500; // lines of code
  private readonly CIRCULAR_DEP_MAX_DEPTH = 3;
  private readonly LONG_METHOD_THRESHOLD = 50; // lines
  private readonly PERFORMANCE_COMPLEXITY_THRESHOLD = 20;
  private readonly HIGH_COUPLING_THRESHOLD = 15;

  async detectPatterns(
    components: ComponentNode[],
    connections: Connection[],
    projectId: string
  ): Promise<PatternDetectionResult> {
    const patterns: DetectedPattern[] = [];
    const antiPatterns: DetectedAntiPattern[] = [];
    const performanceHotspots: PerformanceHotspot[] = [];

    // Detect architectural patterns
    const microservicesScore = this.detectMicroservices(components, connections);
    if (microservicesScore.confidence > this.MICROSERVICE_THRESHOLD) {
      patterns.push(microservicesScore);
    }

    const layeredScore = this.detectLayeredArchitecture(components, connections);
    if (layeredScore.confidence > this.LAYERED_THRESHOLD) {
      patterns.push(layeredScore);
    }

    const eventDrivenScore = this.detectEventDrivenPattern(components, connections);
    if (eventDrivenScore.confidence > 0.5) {
      patterns.push(eventDrivenScore);
    }

    // Detect framework-specific patterns
    patterns.push(...this.detectFrameworkPatterns(components, connections));

    // Detect design patterns
    patterns.push(...this.detectDesignPatterns(components));

    // Detect anti-patterns with enhanced framework support
    antiPatterns.push(...this.detectGodClasses(components));
    antiPatterns.push(...this.detectCircularDependencies(components, connections));
    antiPatterns.push(...this.detectCodeSmells(components));
    antiPatterns.push(...this.detectFrameworkAntiPatterns(components, connections));

    // Detect performance hotspots
    performanceHotspots.push(...this.detectPerformanceHotspots(components, connections));

    // Determine architecture type
    const architectureType = this.determineArchitectureType(patterns, components);

    // Calculate overall confidence
    const confidenceScore = this.calculateConfidence(patterns, antiPatterns);

    // Generate recommendations
    const recommendations = this.generateRecommendations(patterns, antiPatterns, architectureType);

    return {
      projectId,
      patterns,
      antiPatterns: [...antiPatterns, ...this.convertHotspotsToAntiPatterns(performanceHotspots)],
      architectureType,
      confidenceScore,
      recommendations,
      timestamp: new Date()
    };
  }

  private detectMicroservices(
    components: ComponentNode[],
    connections: Connection[]
  ): DetectedPattern {
    let score = 0;
    const indicators: string[] = [];
    const serviceComponents: string[] = [];

    // Check for service boundaries
    const services = components.filter(c => 
      c.type === 'service' || 
      c.name.toLowerCase().includes('service') ||
      c.metadata.layer === 'business'
    );
    
    if (services.length > 3) {
      score += 0.3;
      indicators.push(`Found ${services.length} service components`);
      serviceComponents.push(...services.map(s => s.id));
    }

    // Check for API gateways
    const apiGateways = components.filter(c => 
      c.name.toLowerCase().includes('gateway') ||
      c.name.toLowerCase().includes('proxy') ||
      c.metadata.isEntry
    );
    
    if (apiGateways.length > 0) {
      score += 0.2;
      indicators.push('API Gateway pattern detected');
    }

    // Check for message queues
    const hasMessageQueue = components.some(c => 
      c.metadata.externalCalls?.some((call: string) => 
        call.includes('kafka') || 
        call.includes('rabbitmq') || 
        call.includes('sqs') ||
        call.includes('pubsub')
      )
    );
    
    if (hasMessageQueue) {
      score += 0.2;
      indicators.push('Message queue communication detected');
    }

    // Check for database per service
    const databaseConnections = new Map<string, Set<string>>();
    for (const component of components) {
      if (component.metadata.dbQueries && component.metadata.dbQueries.length > 0) {
        const dbNames = new Set(component.metadata.dbQueries.map((q: any) => q.database || 'default'));
        databaseConnections.set(component.id, dbNames);
      }
    }
    
    if (databaseConnections.size > 1) {
      const uniqueDatabases = new Set<string>();
      databaseConnections.forEach(dbs => dbs.forEach(db => uniqueDatabases.add(db)));
      
      if (uniqueDatabases.size > 1) {
        score += 0.2;
        indicators.push(`Multiple databases detected (${uniqueDatabases.size})`);
      }
    }

    // Check for containerization
    const hasDocker = components.some(c => 
      c.path.includes('Dockerfile') || 
      c.path.includes('docker-compose')
    );
    
    if (hasDocker) {
      score += 0.1;
      indicators.push('Containerization detected');
    }

    return {
      type: PatternType.MICROSERVICES,
      confidence: Math.min(score, 1),
      components: serviceComponents,
      description: `Microservices architecture detected with ${indicators.join(', ')}`,
      metadata: { indicators, serviceCount: services.length }
    };
  }

  private detectLayeredArchitecture(
    components: ComponentNode[],
    connections: Connection[]
  ): DetectedPattern {
    let score = 0;
    const layers = new Map<string, ComponentNode[]>();
    const layerComponents: string[] = [];

    // Group components by layer
    for (const component of components) {
      const layer = component.metadata.layer || this.inferLayer(component);
      if (!layers.has(layer)) {
        layers.set(layer, []);
      }
      layers.get(layer)!.push(component);
      layerComponents.push(component.id);
    }

    // Check for typical layers
    const expectedLayers = ['presentation', 'controller', 'service', 'repository', 'data'];
    const foundLayers = Array.from(layers.keys());
    const matchedLayers = expectedLayers.filter(l => foundLayers.includes(l));
    
    if (matchedLayers.length >= 3) {
      score += 0.4 * (matchedLayers.length / expectedLayers.length);
    }

    // Check for proper layer dependencies
    const layerDependencies = this.analyzeLayerDependencies(components, connections, layers);
    if (layerDependencies.proper) {
      score += 0.4;
    }
    
    if (layerDependencies.violations === 0) {
      score += 0.2;
    } else {
      score -= 0.1 * Math.min(layerDependencies.violations, 3);
    }

    return {
      type: PatternType.LAYERED,
      confidence: Math.max(0, Math.min(score, 1)),
      components: layerComponents,
      description: `Layered architecture with ${layers.size} layers: ${Array.from(layers.keys()).join(', ')}`,
      metadata: {
        layers: Array.from(layers.keys()),
        layerSizes: Object.fromEntries(
          Array.from(layers.entries()).map(([k, v]) => [k, v.length])
        ),
        violations: layerDependencies.violations
      }
    };
  }

  private detectEventDrivenPattern(
    components: ComponentNode[],
    connections: Connection[]
  ): DetectedPattern {
    let score = 0;
    const eventComponents: string[] = [];

    // Check for event emitters/listeners
    const eventPatterns = ['emit', 'publish', 'subscribe', 'listener', 'handler', 'event'];
    
    for (const component of components) {
      const hasEventPattern = eventPatterns.some(pattern => 
        component.name.toLowerCase().includes(pattern) ||
        component.metadata.functions?.some((f: any) => 
          f.name.toLowerCase().includes(pattern)
        )
      );
      
      if (hasEventPattern) {
        score += 0.1;
        eventComponents.push(component.id);
      }
    }

    // Check for message brokers
    const messageBrokers = ['kafka', 'rabbitmq', 'redis', 'nats', 'eventbridge', 'sns', 'sqs'];
    const hasBroker = components.some(c => 
      messageBrokers.some(broker => 
        c.name.toLowerCase().includes(broker) ||
        c.metadata.imports?.some((imp: string) => imp.includes(broker))
      )
    );
    
    if (hasBroker) {
      score += 0.3;
    }

    // Check for async patterns
    const asyncCount = components.reduce((count, c) => 
      count + (c.metadata.functions?.filter((f: any) => f.isAsync).length || 0), 0
    );
    
    if (asyncCount > 10) {
      score += 0.2;
    }

    return {
      type: PatternType.EVENT_DRIVEN,
      confidence: Math.min(score, 1),
      components: eventComponents,
      description: `Event-driven architecture detected with ${eventComponents.length} event-handling components`,
      metadata: {
        eventHandlers: eventComponents.length,
        hasMessageBroker: hasBroker,
        asyncMethods: asyncCount
      }
    };
  }

  private detectDesignPatterns(components: ComponentNode[]): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // Detect Repository pattern
    const repositories = components.filter(c => 
      c.name.toLowerCase().includes('repository') ||
      c.name.toLowerCase().includes('repo') ||
      c.metadata.layer === 'data'
    );
    
    if (repositories.length > 0) {
      patterns.push({
        type: PatternType.REPOSITORY,
        confidence: Math.min(repositories.length * 0.2, 1),
        components: repositories.map(r => r.id),
        description: `Repository pattern with ${repositories.length} repositories`
      });
    }

    // Detect Factory pattern
    const factories = components.filter(c => 
      c.name.toLowerCase().includes('factory') ||
      c.metadata.functions?.some((f: any) => 
        f.name.toLowerCase().includes('create') ||
        f.name.toLowerCase().includes('build')
      )
    );
    
    if (factories.length > 0) {
      patterns.push({
        type: PatternType.FACTORY,
        confidence: Math.min(factories.length * 0.25, 1),
        components: factories.map(f => f.id),
        description: `Factory pattern detected in ${factories.length} components`
      });
    }

    // Detect Singleton pattern
    const singletons = components.filter(c => {
      const hasSingleton = c.metadata.functions?.some((f: any) => 
        f.name.toLowerCase().includes('getinstance') ||
        f.name.toLowerCase().includes('singleton')
      );
      const hasStaticInstance = c.metadata.exports?.some((e: string) => 
        e.toLowerCase().includes('instance')
      );
      return hasSingleton || hasStaticInstance;
    });
    
    if (singletons.length > 0) {
      patterns.push({
        type: PatternType.SINGLETON,
        confidence: Math.min(singletons.length * 0.3, 1),
        components: singletons.map(s => s.id),
        description: `Singleton pattern in ${singletons.length} components`
      });
    }

    // Detect Dependency Injection
    const diIndicators = components.filter(c => 
      c.metadata.functions?.some((f: any) => 
        f.name === 'constructor' && f.parameters.length > 0
      )
    );
    
    if (diIndicators.length > 3) {
      patterns.push({
        type: PatternType.DEPENDENCY_INJECTION,
        confidence: Math.min(diIndicators.length * 0.1, 1),
        components: diIndicators.map(d => d.id),
        description: `Dependency injection pattern detected in ${diIndicators.length} components`
      });
    }

    return patterns;
  }

  private detectGodClasses(components: ComponentNode[]): DetectedAntiPattern[] {
    const antiPatterns: DetectedAntiPattern[] = [];

    for (const component of components) {
      const lineCount = component.metadata.lineCount || 0;
      const methodCount = component.metadata.functions?.length || 0;
      const complexity = component.metadata.complexity || 0;

      // Check for god class indicators
      if (lineCount > this.GOD_CLASS_THRESHOLD || 
          methodCount > 20 || 
          complexity > 50) {
        
        const severity = this.calculateSeverity(lineCount, methodCount, complexity);
        
        antiPatterns.push({
          type: AntiPatternType.GOD_CLASS,
          severity,
          components: [component.id],
          description: `God class detected: ${component.name} has ${lineCount} lines, ${methodCount} methods, complexity ${complexity}`,
          recommendation: 'Consider breaking this class into smaller, more focused classes following Single Responsibility Principle',
          impact: 'Difficult to maintain, test, and understand. High coupling and low cohesion.'
        });
      }
    }

    return antiPatterns;
  }

  private detectCircularDependencies(
    components: ComponentNode[],
    connections: Connection[]
  ): DetectedAntiPattern[] {
    const antiPatterns: DetectedAntiPattern[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[][] = [];

    // Build adjacency list
    const graph = new Map<string, string[]>();
    for (const connection of connections) {
      if (!graph.has(connection.from)) {
        graph.set(connection.from, []);
      }
      graph.get(connection.from)!.push(connection.to);
    }

    // DFS to detect cycles
    const detectCycle = (node: string, path: string[] = []): boolean => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const neighbors = graph.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (detectCycle(neighbor, [...path])) {
            return true;
          }
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = path.indexOf(neighbor);
          if (cycleStart !== -1) {
            const cycle = path.slice(cycleStart);
            cycle.push(neighbor);
            cycles.push(cycle);
          }
          return true;
        }
      }

      recursionStack.delete(node);
      return false;
    };

    // Check all components for cycles
    for (const component of components) {
      if (!visited.has(component.id)) {
        detectCycle(component.id);
      }
    }

    // Create anti-patterns for detected cycles
    for (const cycle of cycles) {
      if (cycle.length <= this.CIRCULAR_DEP_MAX_DEPTH) {
        antiPatterns.push({
          type: AntiPatternType.CIRCULAR_DEPENDENCY,
          severity: cycle.length === 2 ? 'medium' : 'high',
          components: cycle,
          description: `Circular dependency detected: ${cycle.join(' -> ')}`,
          recommendation: 'Refactor to remove circular dependencies. Consider using dependency inversion or introducing an interface.',
          impact: 'Creates tight coupling, makes testing difficult, and can cause initialization problems.'
        });
      }
    }

    return antiPatterns;
  }

  private detectCodeSmells(components: ComponentNode[]): DetectedAntiPattern[] {
    const antiPatterns: DetectedAntiPattern[] = [];

    for (const component of components) {
      // Long methods
      if (component.metadata.functions) {
        for (const func of component.metadata.functions) {
          const methodLines = func.lineCount || 0;
          if (methodLines > this.LONG_METHOD_THRESHOLD) {
            antiPatterns.push({
              type: AntiPatternType.LONG_METHOD,
              severity: methodLines > 100 ? 'high' : 'medium',
              components: [component.id],
              description: `Long method '${func.name}' in ${component.name} (${methodLines} lines)`,
              recommendation: 'Extract method into smaller, more focused methods',
              impact: 'Difficult to understand, test, and maintain'
            });
          }
        }
      }

      // Dead code (components with no connections)
      if (component.dependencies.length === 0 && 
          component.dependents.length === 0 &&
          !component.metadata.isEntry) {
        antiPatterns.push({
          type: AntiPatternType.DEAD_CODE,
          severity: 'low',
          components: [component.id],
          description: `Potentially dead code: ${component.name} has no dependencies or dependents`,
          recommendation: 'Review if this component is still needed, remove if unused',
          impact: 'Increases codebase size and maintenance burden unnecessarily'
        });
      }

      // Feature envy (high coupling to other components)
      const externalCalls = component.metadata.externalCalls?.length || 0;
      const internalCalls = component.metadata.functions?.reduce((sum: number, f: any) => 
        sum + (f.calls?.length || 0), 0
      ) || 0;
      
      if (externalCalls > internalCalls * 2 && externalCalls > 10) {
        antiPatterns.push({
          type: AntiPatternType.FEATURE_ENVY,
          severity: 'medium',
          components: [component.id],
          description: `Feature envy in ${component.name}: makes ${externalCalls} external calls vs ${internalCalls} internal`,
          recommendation: 'Consider moving this functionality closer to the data it operates on',
          impact: 'High coupling, violates principle of locality'
        });
      }
    }

    return antiPatterns;
  }

  private inferLayer(component: ComponentNode): string {
    const name = component.name.toLowerCase();
    const path = component.path.toLowerCase();

    if (name.includes('controller') || path.includes('controller')) return 'controller';
    if (name.includes('service') || path.includes('service')) return 'service';
    if (name.includes('repository') || name.includes('dao') || path.includes('repository')) return 'repository';
    if (name.includes('model') || name.includes('entity') || path.includes('model')) return 'model';
    if (name.includes('view') || name.includes('component') || path.includes('view')) return 'presentation';
    if (name.includes('util') || name.includes('helper') || path.includes('util')) return 'utility';
    
    return 'unknown';
  }

  private analyzeLayerDependencies(
    components: ComponentNode[],
    connections: Connection[],
    layers: Map<string, ComponentNode[]>
  ): { proper: boolean; violations: number } {
    const layerHierarchy = ['presentation', 'controller', 'service', 'repository', 'model', 'data'];
    let violations = 0;

    for (const connection of connections) {
      const fromComponent = components.find(c => c.id === connection.from);
      const toComponent = components.find(c => c.id === connection.to);

      if (fromComponent && toComponent) {
        const fromLayer = fromComponent.metadata.layer || this.inferLayer(fromComponent);
        const toLayer = toComponent.metadata.layer || this.inferLayer(toComponent);

        const fromIndex = layerHierarchy.indexOf(fromLayer);
        const toIndex = layerHierarchy.indexOf(toLayer);

        // Check if dependency goes upward (violation)
        if (fromIndex > toIndex && fromIndex !== -1 && toIndex !== -1) {
          violations++;
        }
      }
    }

    return {
      proper: violations === 0,
      violations
    };
  }

  private calculateSeverity(
    lineCount: number,
    methodCount: number,
    complexity: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    let score = 0;

    if (lineCount > 1000) score += 3;
    else if (lineCount > 500) score += 2;
    else if (lineCount > 300) score += 1;

    if (methodCount > 30) score += 3;
    else if (methodCount > 20) score += 2;
    else if (methodCount > 15) score += 1;

    if (complexity > 100) score += 3;
    else if (complexity > 50) score += 2;
    else if (complexity > 30) score += 1;

    if (score >= 7) return 'critical';
    if (score >= 5) return 'high';
    if (score >= 3) return 'medium';
    return 'low';
  }

  private determineArchitectureType(
    patterns: DetectedPattern[],
    components: ComponentNode[]
  ): ArchitectureType {
    const patternScores = new Map<ArchitectureType, number>();

    for (const pattern of patterns) {
      switch (pattern.type) {
        case PatternType.MICROSERVICES:
          patternScores.set(
            ArchitectureType.MICROSERVICES,
            (patternScores.get(ArchitectureType.MICROSERVICES) || 0) + pattern.confidence
          );
          break;
        case PatternType.LAYERED:
          patternScores.set(
            ArchitectureType.LAYERED,
            (patternScores.get(ArchitectureType.LAYERED) || 0) + pattern.confidence
          );
          break;
        case PatternType.EVENT_DRIVEN:
          patternScores.set(
            ArchitectureType.EVENT_DRIVEN,
            (patternScores.get(ArchitectureType.EVENT_DRIVEN) || 0) + pattern.confidence
          );
          break;
        case PatternType.HEXAGONAL:
          patternScores.set(
            ArchitectureType.HEXAGONAL,
            (patternScores.get(ArchitectureType.HEXAGONAL) || 0) + pattern.confidence
          );
          break;
      }
    }

    // Check for serverless indicators
    const hasServerless = components.some(c => 
      c.path.includes('lambda') || 
      c.path.includes('functions') ||
      c.name.toLowerCase().includes('function') || c.name.toLowerCase().includes('lambda')
    );
    
    if (hasServerless) {
      patternScores.set(ArchitectureType.SERVERLESS, 0.5);
    }

    // Default to monolithic if no clear patterns
    if (patternScores.size === 0 && components.length > 0) {
      return ArchitectureType.MONOLITHIC;
    }

    // Find highest scoring architecture
    let maxScore = 0;
    let architecture = ArchitectureType.UNKNOWN;
    
    for (const [type, score] of patternScores.entries()) {
      if (score > maxScore) {
        maxScore = score;
        architecture = type;
      }
    }

    // If multiple high scores, it's mixed
    const highScores = Array.from(patternScores.values()).filter(s => s > 0.5);
    if (highScores.length > 1) {
      return ArchitectureType.MIXED;
    }

    return architecture;
  }

  private calculateConfidence(
    patterns: DetectedPattern[],
    antiPatterns: DetectedAntiPattern[]
  ): number {
    if (patterns.length === 0) return 0;

    const avgPatternConfidence = patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length;
    
    // Reduce confidence based on anti-patterns
    const antiPatternPenalty = antiPatterns.reduce((penalty, ap) => {
      switch (ap.severity) {
        case 'critical': return penalty + 0.15;
        case 'high': return penalty + 0.1;
        case 'medium': return penalty + 0.05;
        case 'low': return penalty + 0.02;
        default: return penalty;
      }
    }, 0);

    return Math.max(0, Math.min(1, avgPatternConfidence - antiPatternPenalty));
  }

  private generateRecommendations(
    patterns: DetectedPattern[],
    antiPatterns: DetectedAntiPattern[],
    architectureType: ArchitectureType
  ): string[] {
    const recommendations: string[] = [];

    // Architecture-specific recommendations
    switch (architectureType) {
      case ArchitectureType.MICROSERVICES:
        if (!patterns.some(p => p.type === PatternType.API_GATEWAY)) {
          recommendations.push('Consider implementing an API Gateway for centralized routing and cross-cutting concerns');
        }
        if (!patterns.some(p => p.type === PatternType.SERVICE_MESH)) {
          recommendations.push('Consider adopting a service mesh for better observability and traffic management');
        }
        break;
      
      case ArchitectureType.LAYERED:
        if (antiPatterns.some(ap => ap.type === AntiPatternType.CIRCULAR_DEPENDENCY)) {
          recommendations.push('Enforce strict layer boundaries to prevent circular dependencies');
        }
        recommendations.push('Consider implementing dependency injection for better testability');
        break;
      
      case ArchitectureType.MONOLITHIC:
        if (antiPatterns.filter(ap => ap.type === AntiPatternType.GOD_CLASS).length > 3) {
          recommendations.push('Consider breaking down the monolith into modules or microservices');
        }
        break;
    }

    // Pattern-specific recommendations
    if (!patterns.some(p => p.type === PatternType.REPOSITORY) && 
        patterns.some(p => p.components.length > 10)) {
      recommendations.push('Implement Repository pattern to abstract data access logic');
    }

    // Anti-pattern specific (top 3 most critical)
    const criticalAntiPatterns = antiPatterns
      .filter(ap => ap.severity === 'critical' || ap.severity === 'high')
      .slice(0, 3);
    
    for (const ap of criticalAntiPatterns) {
      recommendations.push(ap.recommendation);
    }

    // General best practices
    if (patterns.length < 3) {
      recommendations.push('Consider adopting more design patterns for better code organization');
    }

    if (antiPatterns.length > 10) {
      recommendations.push('Prioritize refactoring efforts on high-severity anti-patterns');
    }

    return recommendations;
  }

  // Framework-specific pattern detection
  private detectFrameworkPatterns(
    components: ComponentNode[],
    connections: Connection[]
  ): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // React-specific patterns
    patterns.push(...this.detectReactPatterns(components, connections));
    
    // NestJS-specific patterns
    patterns.push(...this.detectNestJSPatterns(components, connections));
    
    // Express-specific patterns
    patterns.push(...this.detectExpressPatterns(components, connections));

    return patterns;
  }

  private detectReactPatterns(
    components: ComponentNode[],
    connections: Connection[]
  ): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
    const reactComponents = components.filter(c => c.framework === 'react');

    if (reactComponents.length === 0) return patterns;

    // Component composition pattern
    const compositionComponents = reactComponents.filter(c => 
      c.metadata.tags?.includes('has-children') || 
      c.dependencies.some(dep => reactComponents.find(rc => rc.id === dep))
    );
    
    if (compositionComponents.length > 3) {
      patterns.push({
        type: PatternType.FACTORY, // Using factory as closest match
        confidence: Math.min(compositionComponents.length * 0.1, 1),
        components: compositionComponents.map(c => c.id),
        description: `React Component Composition pattern with ${compositionComponents.length} composed components`,
        metadata: { 
          pattern: 'react-composition',
          composedComponents: compositionComponents.length
        }
      });
    }

    // Hooks pattern
    const hooksComponents = reactComponents.filter(c => 
      c.metadata.hooks && (c.metadata.hooks as string[]).length > 0
    );
    
    if (hooksComponents.length > 0) {
      patterns.push({
        type: PatternType.OBSERVER, // Hooks are similar to observer pattern
        confidence: Math.min(hooksComponents.length * 0.15, 1),
        components: hooksComponents.map(c => c.id),
        description: `React Hooks pattern with ${hooksComponents.length} components using hooks`,
        metadata: {
          pattern: 'react-hooks',
          totalHooks: hooksComponents.reduce((sum, c) => 
            sum + ((c.metadata.hooks as string[])?.length || 0), 0
          )
        }
      });
    }

    // Higher-Order Component pattern
    const hocComponents = reactComponents.filter(c => 
      c.name.startsWith('with') || c.name.includes('HOC') || 
      c.metadata.responsibilities?.some(r => r.includes('Higher-Order'))
    );
    
    if (hocComponents.length > 0) {
      patterns.push({
        type: PatternType.STRATEGY,
        confidence: Math.min(hocComponents.length * 0.2, 1),
        components: hocComponents.map(c => c.id),
        description: `Higher-Order Component pattern with ${hocComponents.length} HOCs`,
        metadata: { pattern: 'react-hoc' }
      });
    }

    return patterns;
  }

  private detectNestJSPatterns(
    components: ComponentNode[],
    connections: Connection[]
  ): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
    const nestComponents = components.filter(c => c.framework === 'nestjs');

    if (nestComponents.length === 0) return patterns;

    // Module pattern
    const modules = nestComponents.filter(c => c.metadata.frameworkType === 'module');
    if (modules.length > 0) {
      patterns.push({
        type: PatternType.DEPENDENCY_INJECTION,
        confidence: Math.min(modules.length * 0.2, 1),
        components: modules.map(c => c.id),
        description: `NestJS Module pattern with ${modules.length} modules`,
        metadata: { pattern: 'nestjs-modules' }
      });
    }

    // Controller-Service pattern
    const controllers = nestComponents.filter(c => c.type === 'controller');
    const services = nestComponents.filter(c => c.type === 'service');
    
    if (controllers.length > 0 && services.length > 0) {
      patterns.push({
        type: PatternType.MVC,
        confidence: 0.9,
        components: [...controllers.map(c => c.id), ...services.map(c => c.id)],
        description: `NestJS Controller-Service pattern with ${controllers.length} controllers and ${services.length} services`,
        metadata: { 
          pattern: 'nestjs-controller-service',
          controllers: controllers.length,
          services: services.length
        }
      });
    }

    // Repository pattern (if entities present)
    const entities = nestComponents.filter(c => c.metadata.frameworkType === 'entity');
    const repositories = nestComponents.filter(c => c.metadata.frameworkType === 'repository');
    
    if (entities.length > 0 && repositories.length > 0) {
      patterns.push({
        type: PatternType.REPOSITORY,
        confidence: Math.min((entities.length + repositories.length) * 0.1, 1),
        components: [...entities.map(c => c.id), ...repositories.map(c => c.id)],
        description: `Repository pattern with ${repositories.length} repositories for ${entities.length} entities`,
        metadata: { 
          pattern: 'nestjs-repository',
          entities: entities.length,
          repositories: repositories.length
        }
      });
    }

    // Guard pattern
    const guards = nestComponents.filter(c => c.metadata.frameworkType === 'guard');
    if (guards.length > 0) {
      patterns.push({
        type: PatternType.STRATEGY,
        confidence: Math.min(guards.length * 0.25, 1),
        components: guards.map(c => c.id),
        description: `NestJS Guard pattern with ${guards.length} guards`,
        metadata: { pattern: 'nestjs-guards' }
      });
    }

    return patterns;
  }

  private detectExpressPatterns(
    components: ComponentNode[],
    connections: Connection[]
  ): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
    const expressComponents = components.filter(c => c.framework === 'express');

    if (expressComponents.length === 0) return patterns;

    // Middleware chain pattern
    const middlewareComponents = expressComponents.filter(c => 
      c.type === 'middleware' || c.metadata.frameworkType === 'middleware'
    );
    
    if (middlewareComponents.length > 2) {
      patterns.push({
        type: PatternType.STRATEGY,
        confidence: Math.min(middlewareComponents.length * 0.15, 1),
        components: middlewareComponents.map(c => c.id),
        description: `Express Middleware Chain pattern with ${middlewareComponents.length} middleware`,
        metadata: { 
          pattern: 'express-middleware-chain',
          middlewareCount: middlewareComponents.length
        }
      });
    }

    // Router pattern
    const routers = expressComponents.filter(c => 
      c.name.toLowerCase().includes('router') || c.metadata.frameworkType === 'router'
    );
    
    if (routers.length > 0) {
      patterns.push({
        type: PatternType.MVC,
        confidence: Math.min(routers.length * 0.2, 1),
        components: routers.map(c => c.id),
        description: `Express Router pattern with ${routers.length} routers`,
        metadata: { pattern: 'express-router' }
      });
    }

    return patterns;
  }

  // Framework-specific anti-patterns
  private detectFrameworkAntiPatterns(
    components: ComponentNode[],
    connections: Connection[]
  ): DetectedAntiPattern[] {
    const antiPatterns: DetectedAntiPattern[] = [];

    // React anti-patterns
    antiPatterns.push(...this.detectReactAntiPatterns(components));
    
    // NestJS anti-patterns
    antiPatterns.push(...this.detectNestJSAntiPatterns(components));
    
    // Express anti-patterns
    antiPatterns.push(...this.detectExpressAntiPatterns(components));

    return antiPatterns;
  }

  private detectReactAntiPatterns(components: ComponentNode[]): DetectedAntiPattern[] {
    const antiPatterns: DetectedAntiPattern[] = [];
    const reactComponents = components.filter(c => c.framework === 'react');

    // Prop drilling anti-pattern
    const propsComponents = reactComponents.filter(c => 
      c.metadata.props && (c.metadata.props as string[]).length > 15
    );
    
    for (const component of propsComponents) {
      antiPatterns.push({
        type: AntiPatternType.DATA_CLUMP,
        severity: 'medium',
        components: [component.id],
        description: `Potential prop drilling in ${component.name} with ${(component.metadata.props as string[]).length} props`,
        recommendation: 'Consider using Context API or state management library to reduce prop drilling',
        impact: 'Increases coupling and makes components harder to maintain'
      });
    }

    // Unnecessary re-renders
    const nonMemoizedComponents = reactComponents.filter(c => 
      c.metadata.tags && !(c.metadata.tags as string[]).includes('memoized') &&
      c.metadata.hooks && (c.metadata.hooks as string[]).includes('useEffect')
    );
    
    for (const component of nonMemoizedComponents) {
      if (component.metadata.complexity > 10) {
        antiPatterns.push({
          type: AntiPatternType.PRIMITIVE_OBSESSION,
          severity: 'low',
          components: [component.id],
          description: `${component.name} may cause unnecessary re-renders (complex component without memoization)`,
          recommendation: 'Consider using React.memo, useMemo, or useCallback for optimization',
          impact: 'Poor performance due to unnecessary re-renders'
        });
      }
    }

    return antiPatterns;
  }

  private detectNestJSAntiPatterns(components: ComponentNode[]): DetectedAntiPattern[] {
    const antiPatterns: DetectedAntiPattern[] = [];
    const nestComponents = components.filter(c => c.framework === 'nestjs');

    // Fat controllers
    const controllers = nestComponents.filter(c => c.type === 'controller');
    for (const controller of controllers) {
      const methodCount = (controller.metadata.methods as string[])?.length || 0;
      if (methodCount > 15) {
        antiPatterns.push({
          type: AntiPatternType.GOD_CLASS,
          severity: methodCount > 25 ? 'high' : 'medium',
          components: [controller.id],
          description: `Fat controller: ${controller.name} has ${methodCount} methods`,
          recommendation: 'Split large controllers into smaller, focused controllers',
          impact: 'Violates Single Responsibility Principle, hard to maintain and test'
        });
      }
    }

    // Service without interface
    const services = nestComponents.filter(c => c.type === 'service');
    for (const service of services) {
      if (service.dependencies.length > 8) {
        antiPatterns.push({
          type: AntiPatternType.FEATURE_ENVY,
          severity: 'medium',
          components: [service.id],
          description: `${service.name} has too many dependencies (${service.dependencies.length})`,
          recommendation: 'Consider breaking this service into smaller services or using facades',
          impact: 'High coupling, difficult to test and maintain'
        });
      }
    }

    return antiPatterns;
  }

  private detectExpressAntiPatterns(components: ComponentNode[]): DetectedAntiPattern[] {
    const antiPatterns: DetectedAntiPattern[] = [];
    const expressComponents = components.filter(c => c.framework === 'express');

    // Callback hell in middleware
    const middlewareComponents = expressComponents.filter(c => c.type === 'middleware');
    for (const middleware of middlewareComponents) {
      if (middleware.metadata.complexity > 15) {
        antiPatterns.push({
          type: AntiPatternType.SPAGHETTI_CODE,
          severity: 'medium',
          components: [middleware.id],
          description: `Complex middleware: ${middleware.name} has high complexity (${middleware.metadata.complexity})`,
          recommendation: 'Break complex middleware into smaller, focused middleware functions',
          impact: 'Difficult to debug and maintain middleware chain'
        });
      }
    }

    return antiPatterns;
  }

  // Performance hotspot detection
  private detectPerformanceHotspots(
    components: ComponentNode[],
    connections: Connection[]
  ): PerformanceHotspot[] {
    const hotspots: PerformanceHotspot[] = [];

    // High complexity components
    for (const component of components) {
      if (component.metadata.complexity > this.PERFORMANCE_COMPLEXITY_THRESHOLD) {
        const severity = this.calculateHotspotSeverity(component.metadata.complexity, 50);
        hotspots.push({
          componentId: component.id,
          severity,
          type: 'complexity',
          description: `High complexity component (${component.metadata.complexity})`,
          impact: Math.min(Math.floor(component.metadata.complexity / 5), 10),
          recommendation: 'Refactor to reduce complexity by extracting methods or splitting responsibilities',
          metrics: {
            complexity: component.metadata.complexity,
            threshold: this.PERFORMANCE_COMPLEXITY_THRESHOLD
          }
        });
      }
    }

    // High coupling components
    for (const component of components) {
      const couplingScore = component.dependencies.length + component.dependents.length;
      if (couplingScore > this.HIGH_COUPLING_THRESHOLD) {
        const severity = this.calculateHotspotSeverity(couplingScore, 25);
        hotspots.push({
          componentId: component.id,
          severity,
          type: 'coupling',
          description: `Highly coupled component (${couplingScore} connections)`,
          impact: Math.min(Math.floor(couplingScore / 3), 10),
          recommendation: 'Reduce coupling by introducing interfaces, dependency injection, or event-driven patterns',
          metrics: {
            coupling: couplingScore,
            dependencies: component.dependencies.length,
            dependents: component.dependents.length,
            threshold: this.HIGH_COUPLING_THRESHOLD
          }
        });
      }
    }

    // Large components (size-based hotspots)
    for (const component of components) {
      if (component.metadata.lineCount > 1000) {
        const severity = this.calculateHotspotSeverity(component.metadata.lineCount, 2000);
        hotspots.push({
          componentId: component.id,
          severity,
          type: 'size',
          description: `Large component (${component.metadata.lineCount} lines)`,
          impact: Math.min(Math.floor(component.metadata.lineCount / 200), 10),
          recommendation: 'Break large component into smaller, focused components',
          metrics: {
            lines: component.metadata.lineCount,
            threshold: 1000
          }
        });
      }
    }

    // Framework-specific performance hotspots
    hotspots.push(...this.detectFrameworkHotspots(components, connections));

    return hotspots;
  }

  private detectFrameworkHotspots(
    components: ComponentNode[],
    connections: Connection[]
  ): PerformanceHotspot[] {
    const hotspots: PerformanceHotspot[] = [];

    // React performance hotspots
    const reactComponents = components.filter(c => c.framework === 'react');
    for (const component of reactComponents) {
      // Components with many hooks
      const hookCount = (component.metadata.hooks as string[])?.length || 0;
      if (hookCount > 10) {
        hotspots.push({
          componentId: component.id,
          severity: this.calculateHotspotSeverity(hookCount, 15),
          type: 'performance',
          description: `React component with many hooks (${hookCount})`,
          impact: Math.min(hookCount, 8),
          recommendation: 'Consider splitting component or using custom hooks to reduce complexity',
          metrics: { hookCount }
        });
      }

      // Non-memoized components with high prop count
      const propCount = (component.metadata.props as string[])?.length || 0;
      const isMemoized = (component.metadata.tags as string[])?.includes('memoized') || false;
      
      if (propCount > 10 && !isMemoized) {
        hotspots.push({
          componentId: component.id,
          severity: 'medium',
          type: 'performance',
          description: `Non-memoized React component with many props (${propCount})`,
          impact: Math.min(propCount, 7),
          recommendation: 'Consider using React.memo or useMemo to prevent unnecessary re-renders',
          metrics: { propCount }
        });
      }
    }

    // NestJS performance hotspots
    const nestComponents = components.filter(c => c.framework === 'nestjs');
    for (const component of nestComponents) {
      // Controllers with many endpoints
      if (component.type === 'controller') {
        const methodCount = (component.metadata.methods as string[])?.length || 0;
        if (methodCount > 20) {
          hotspots.push({
            componentId: component.id,
            severity: this.calculateHotspotSeverity(methodCount, 30),
            type: 'performance',
            description: `NestJS controller with many endpoints (${methodCount})`,
            impact: Math.min(Math.floor(methodCount / 3), 9),
            recommendation: 'Split large controller into smaller, domain-focused controllers',
            metrics: { methodCount }
          });
        }
      }
    }

    return hotspots;
  }

  private calculateHotspotSeverity(value: number, criticalThreshold: number): PerformanceHotspot['severity'] {
    const ratio = value / criticalThreshold;
    if (ratio >= 1) return 'critical';
    if (ratio >= 0.75) return 'high';
    if (ratio >= 0.5) return 'medium';
    return 'low';
  }

  private convertHotspotsToAntiPatterns(hotspots: PerformanceHotspot[]): DetectedAntiPattern[] {
    return hotspots.map(hotspot => ({
      type: this.mapHotspotTypeToAntiPattern(hotspot.type),
      severity: hotspot.severity,
      components: [hotspot.componentId],
      description: hotspot.description,
      recommendation: hotspot.recommendation,
      impact: `Performance impact: ${hotspot.impact}/10`
    }));
  }

  private mapHotspotTypeToAntiPattern(type: PerformanceHotspot['type']): AntiPatternType {
    switch (type) {
      case 'complexity': return AntiPatternType.SPAGHETTI_CODE;
      case 'size': return AntiPatternType.GOD_CLASS;
      case 'coupling': return AntiPatternType.FEATURE_ENVY;
      case 'performance': return AntiPatternType.LAZY_CLASS;
      case 'memory': return AntiPatternType.SPECULATIVE_GENERALITY;
      default: return AntiPatternType.SPAGHETTI_CODE;
    }
  }
}