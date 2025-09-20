import { Injectable, Logger } from '@nestjs/common';
import { ComponentNode, Connection } from '../../types';

export interface Pattern {
  id: string;
  name: string;
  type: 'architectural' | 'design' | 'anti-pattern';
  confidence: number;
  description: string;
  components: string[];
  metadata?: Record<string, any>;
}

export interface PatternDetectionResult {
  projectId: string;
  patterns: Pattern[];
  antiPatterns: Pattern[];
  architectureType: string;
  confidenceScore: number;
  recommendations: string[];
  timestamp: Date;
}

@Injectable()
export class PatternDetector {
  private readonly logger = new Logger(PatternDetector.name);

  async detectPatterns(
    components: ComponentNode[],
    connections: Connection[],
    projectId: string
  ): Promise<PatternDetectionResult> {
    const patterns: Pattern[] = [];
    const antiPatterns: Pattern[] = [];
    let architectureType = 'unknown';
    const recommendations: string[] = [];

    try {
      this.detectMVCPattern(components, connections, patterns);
      this.detectRepositoryPattern(components, connections, patterns);
      this.detectServiceLayerPattern(components, connections, patterns);
      this.detectControllerPattern(components, connections, patterns);
      this.detectMiddlewarePattern(components, connections, patterns);
      this.detectDependencyInjectionPattern(components, connections, patterns);

      this.detectGodObjectAntiPattern(components, antiPatterns);
      this.detectCircularDependencyAntiPattern(components, connections, antiPatterns);

      architectureType = this.determineArchitectureType(components, connections, patterns);
      recommendations.push(...this.generateRecommendations(patterns, antiPatterns));

      const confidenceScore = this.calculateOverallConfidence(patterns, antiPatterns);

      return {
        projectId,
        patterns,
        antiPatterns,
        architectureType,
        confidenceScore,
        recommendations,
        timestamp: new Date()
      };
    } catch (error) {
      this.logger.error(`Pattern detection failed: ${(error as Error).message}`);
      return {
        projectId,
        patterns: [],
        antiPatterns: [],
        architectureType: 'unknown',
        confidenceScore: 0,
        recommendations: ['Pattern detection failed - manual review recommended'],
        timestamp: new Date()
      };
    }
  }

  private detectMVCPattern(
    components: ComponentNode[],
    connections: Connection[],
    patterns: Pattern[]
  ): void {
    const controllers = components.filter(c => c.type === 'controller');
    const services = components.filter(c => c.type === 'service');
    const models = components.filter(c => c.type === 'model');

    if (controllers.length > 0 && services.length > 0) {
      patterns.push({
        id: 'mvc-pattern',
        name: 'Model-View-Controller (MVC)',
        type: 'architectural',
        confidence: 0.8,
        description: 'Application follows MVC architectural pattern with clear separation of concerns',
        components: [...controllers.map(c => c.id), ...services.map(c => c.id), ...models.map(c => c.id)],
        metadata: {
          controllerCount: controllers.length,
          serviceCount: services.length,
          modelCount: models.length
        }
      });
    }
  }

  private detectRepositoryPattern(
    components: ComponentNode[],
    connections: Connection[],
    patterns: Pattern[]
  ): void {
    const repositories = components.filter(c =>
      c.type === 'repository' || c.name.toLowerCase().includes('repository')
    );

    if (repositories.length > 0) {
      patterns.push({
        id: 'repository-pattern',
        name: 'Repository Pattern',
        type: 'design',
        confidence: 0.9,
        description: 'Data access abstraction through repository pattern',
        components: repositories.map(c => c.id),
        metadata: {
          repositoryCount: repositories.length
        }
      });
    }
  }

  private detectServiceLayerPattern(
    components: ComponentNode[],
    connections: Connection[],
    patterns: Pattern[]
  ): void {
    const services = components.filter(c => c.type === 'service');
    const controllers = components.filter(c => c.type === 'controller');

    const serviceLayerConnections = connections.filter(conn =>
      controllers.some(c => c.id === conn.from) &&
      services.some(s => s.id === conn.to)
    );

    if (services.length > 0 && serviceLayerConnections.length > 0) {
      patterns.push({
        id: 'service-layer-pattern',
        name: 'Service Layer Pattern',
        type: 'architectural',
        confidence: 0.85,
        description: 'Business logic encapsulated in service layer',
        components: services.map(c => c.id),
        metadata: {
          serviceCount: services.length,
          serviceConnections: serviceLayerConnections.length
        }
      });
    }
  }

  private detectControllerPattern(
    components: ComponentNode[],
    connections: Connection[],
    patterns: Pattern[]
  ): void {
    const controllers = components.filter(c => c.type === 'controller');

    if (controllers.length > 0) {
      patterns.push({
        id: 'controller-pattern',
        name: 'Controller Pattern',
        type: 'design',
        confidence: 0.9,
        description: 'Request handling through controller pattern',
        components: controllers.map(c => c.id),
        metadata: {
          controllerCount: controllers.length
        }
      });
    }
  }

  private detectMiddlewarePattern(
    components: ComponentNode[],
    connections: Connection[],
    patterns: Pattern[]
  ): void {
    const middleware = components.filter(c => c.type === 'middleware');

    if (middleware.length > 0) {
      patterns.push({
        id: 'middleware-pattern',
        name: 'Middleware Pattern',
        type: 'design',
        confidence: 0.8,
        description: 'Request processing pipeline through middleware',
        components: middleware.map(c => c.id),
        metadata: {
          middlewareCount: middleware.length
        }
      });
    }
  }

  private detectDependencyInjectionPattern(
    components: ComponentNode[],
    connections: Connection[],
    patterns: Pattern[]
  ): void {
    const diConnections = connections.filter(conn =>
      conn.type.toString().toLowerCase().includes('dependency')
    );

    if (diConnections.length > 0) {
      patterns.push({
        id: 'dependency-injection-pattern',
        name: 'Dependency Injection Pattern',
        type: 'design',
        confidence: 0.9,
        description: 'Dependencies managed through injection pattern',
        components: [...new Set([...diConnections.map(c => c.from), ...diConnections.map(c => c.to)])],
        metadata: {
          injectionCount: diConnections.length
        }
      });
    }
  }

  private detectGodObjectAntiPattern(
    components: ComponentNode[],
    antiPatterns: Pattern[]
  ): void {
    const godObjects = components.filter(c =>
      (c.metadata?.lineCount || 0) > 1000 ||
      (c.metadata?.complexity || 0) > 50 ||
      ((c.metadata as any)?.methodCount || 0) > 20
    );

    godObjects.forEach(obj => {
      antiPatterns.push({
        id: `god-object-${obj.id}`,
        name: 'God Object Anti-Pattern',
        type: 'anti-pattern',
        confidence: 0.7,
        description: `Component ${obj.name} has excessive complexity or size`,
        components: [obj.id],
        metadata: {
          lineCount: obj.metadata?.lineCount,
          complexity: obj.metadata?.complexity,
          methodCount: (obj.metadata as any)?.methodCount
        }
      });
    });
  }

  private detectCircularDependencyAntiPattern(
    components: ComponentNode[],
    connections: Connection[],
    antiPatterns: Pattern[]
  ): void {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const cycles: string[][] = [];

    const detectCycle = (componentId: string, path: string[]): boolean => {
      if (visiting.has(componentId)) {
        const cycleStart = path.indexOf(componentId);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart));
        }
        return true;
      }

      if (visited.has(componentId)) {
        return false;
      }

      visiting.add(componentId);
      path.push(componentId);

      const dependencies = connections
        .filter(conn => conn.from === componentId)
        .map(conn => conn.to);

      for (const dep of dependencies) {
        if (detectCycle(dep, [...path])) {
          visiting.delete(componentId);
          return true;
        }
      }

      visiting.delete(componentId);
      visited.add(componentId);
      return false;
    };

    components.forEach(component => {
      if (!visited.has(component.id)) {
        detectCycle(component.id, []);
      }
    });

    cycles.forEach((cycle, index) => {
      antiPatterns.push({
        id: `circular-dependency-${index}`,
        name: 'Circular Dependency Anti-Pattern',
        type: 'anti-pattern',
        confidence: 0.9,
        description: `Circular dependency detected in components: ${cycle.join(' -> ')}`,
        components: cycle,
        metadata: {
          cycleLength: cycle.length
        }
      });
    });
  }

  private determineArchitectureType(
    components: ComponentNode[],
    connections: Connection[],
    patterns: Pattern[]
  ): string {
    const hasControllers = components.some(c => c.type === 'controller');
    const hasServices = components.some(c => c.type === 'service');
    const hasModules = components.some(c => c.type === 'module');
    const hasMVC = patterns.some(p => p.id === 'mvc-pattern');

    if (hasModules && hasControllers && hasServices) {
      return 'modular-mvc';
    } else if (hasMVC) {
      return 'mvc';
    } else if (hasServices) {
      return 'service-oriented';
    } else if (hasControllers) {
      return 'controller-based';
    } else {
      return 'monolithic';
    }
  }

  private generateRecommendations(patterns: Pattern[], antiPatterns: Pattern[]): string[] {
    const recommendations: string[] = [];

    if (antiPatterns.some(p => p.name.includes('God Object'))) {
      recommendations.push('Consider breaking down large components into smaller, more focused units');
    }

    if (antiPatterns.some(p => p.name.includes('Circular Dependency'))) {
      recommendations.push('Resolve circular dependencies by introducing interfaces or refactoring component relationships');
    }

    if (patterns.length === 0) {
      recommendations.push('Consider implementing common design patterns like Repository or Service Layer for better code organization');
    }

    if (!patterns.some(p => p.name.includes('Repository'))) {
      recommendations.push('Consider implementing Repository pattern for data access abstraction');
    }

    return recommendations;
  }

  private calculateOverallConfidence(patterns: Pattern[], antiPatterns: Pattern[]): number {
    if (patterns.length === 0 && antiPatterns.length === 0) {
      return 0;
    }

    const totalPatterns = patterns.length + antiPatterns.length;
    const weightedConfidence = patterns.reduce((sum, p) => sum + p.confidence, 0) +
                             antiPatterns.reduce((sum, p) => sum + p.confidence, 0);

    return Math.round((weightedConfidence / totalPatterns) * 100) / 100;
  }
}