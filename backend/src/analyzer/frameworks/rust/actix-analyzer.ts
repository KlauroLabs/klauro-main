import { BaseAnalyzer } from '../../core/base-analyzer';
import { AnalysisContext, CASContribution } from '../../types/cas.types';
import { RustAnalyzer } from '../../languages/rust-analyzer';
import { generateNodeId } from '../../utils/id-generator';

/**
 * Actix-web framework analyzer
 * Enhances Rust analysis with Actix-specific patterns and metadata
 */
export class ActixAnalyzer extends BaseAnalyzer {
  private rustAnalyzer: RustAnalyzer;
  
  constructor() {
    super();
    this.analyzerId = 'actix-web-analyzer';
    this.analyzerName = 'Actix-web Framework Analyzer';
    this.analyzerVersion = '1.0.0';
    this.analyzerType = 'framework';
    this.rustAnalyzer = new RustAnalyzer();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    // Check if this is a Rust project that uses Actix-web
    const hasCargoToml = await this.fileExists(`${projectPath}/Cargo.toml`);
    if (!hasCargoToml) return false;

    try {
      const cargoContent = await this.readFileContent(`${projectPath}/Cargo.toml`);
      const hasActixDep = cargoContent.includes('actix-web') || 
                             cargoContent.includes('actix_web') ||
                             cargoContent.includes('actix');
      if (!hasActixDep) return false;

      // Check for Actix-specific patterns in source files
      const rustFiles = await this.findRustFiles(projectPath);
      for (const file of rustFiles) {
        const content = await this.readFileContent(file);
        if (this.hasActixPatterns(content)) {
          return true;
        }
      }
    } catch (error) {
      return false;
    }

    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    // Get existing analysis from Rust analyzer
    const rustContribution = await this.rustAnalyzer.analyze(context);
    const nodes = [...rustContribution.nodes];
    const edges = [...rustContribution.edges];
    const entryPoints = [...(rustContribution.entry_points || [])];
    const exitPoints = [...(rustContribution.exit_points || [])];

    try {
      await this.enhanceNodesWithActixInfo(nodes, context.projectPath);
      await this.createActixRoutes(nodes, edges, entryPoints, context.projectPath);
      await this.createActixMiddlewares(nodes, edges, context.projectPath);
      await this.createActixServices(nodes, edges, context.projectPath);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'actix-web',
          route_count: entryPoints.filter(ep => ep.type === 'http').length,
          middleware_count: this.countActixMiddlewares(nodes),
          service_count: this.countActixServices(nodes),
          patterns_detected: this.detectActixPatterns(nodes, edges)
        }
      });
    } catch (error) {
      throw new Error(`Actix analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return [
      'route-extraction',
      'middleware-detection', 
      'service-patterns',
      'dependency-injection',
      'state-management'
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'actix-framework';
      case 2: return 'routes';
      case 3: return 'handlers';
      case 4: return 'middleware';
      default: return `actix-level-${level}`;
    }
  }

  /**
   * Enhance nodes with Actix-specific metadata
   */
  private async enhanceNodesWithActixInfo(nodes: any[], projectPath: string): Promise<void> {
    const rustFiles = await this.findRustFiles(projectPath);
    
    for (const file of rustFiles) {
      const content = await this.readFileContent(file);
      const actixPatterns = this.extractActixPatterns(content, file);
      
      actixPatterns.forEach(pattern => {
        const node = nodes.find(n => n.source?.file === file && 
                                       n.source?.line >= pattern.line && 
                                       n.source?.line <= pattern.line + 10);
        if (node) {
          this.enhanceNodeWithActixMetadata(node, pattern);
        }
      });
    }
  }

  /**
   * Extract Actix-specific patterns from source code
   */
  private extractActixPatterns(content: string, filePath: string): any[] {
    const patterns: any[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
      // Route decorators
      const routeMatch = line.match(/#\[get\("([^"]+)"\)\]|#\[post\("([^"]+)"\)\]|#\[put\("([^"]+)"\)\]|#\[delete\("([^"]+)"\)\]|#\[patch\("([^"]+)"\)/i);
      if (routeMatch) {
        patterns.push({
          type: 'route',
          method: routeMatch[1] ? 'GET' : routeMatch[2] ? 'POST' : routeMatch[3] ? 'PUT' : routeMatch[4] ? 'DELETE' : 'PATCH',
          path: routeMatch[1] || routeMatch[2] || routeMatch[3] || routeMatch[4] || routeMatch[5],
          line: index + 1
        });
      }

      // Route with parameters
      const paramRouteMatch = line.match(/#\[get\("([^"]+\/\{[^}]+\})"\)\]|#\[post\("([^"]+\/\{[^}]+\})"\)/i);
      if (paramRouteMatch) {
        patterns.push({
          type: 'param-route',
          method: paramRouteMatch[1] ? 'GET' : 'POST',
          path: paramRouteMatch[1] || paramRouteMatch[2],
          parameters: this.extractRouteParameters(paramRouteMatch[1] || paramRouteMatch[2]),
          line: index + 1
        });
      }

      // Middleware decorators
      const middlewareMatch = line.match(/#\[middleware\("([^"]+)"\)/i);
      if (middlewareMatch) {
        patterns.push({
          type: 'middleware',
          name: middlewareMatch[1],
          line: index + 1
        });
      }

      // Service markers
      const serviceMatch = line.match(/#\[derive\(Service\)\]|impl\s+(\w+)Service|impl\s+Service\s+for\s+(\w+)/);
      if (serviceMatch) {
        patterns.push({
          type: 'service',
          name: serviceMatch[1] || serviceMatch[2],
          line: index + 1
        });
      }

      // State management
      const stateMatch = line.match(/#\[derive\(.+State\.\)|Web::Data<(\w+)>|App::new\(\)\.data\(\w+\)/);
      if (stateMatch) {
        patterns.push({
          type: 'state',
          name: stateMatch[1] || stateMatch[2],
          line: index + 1
        });
      }
    });

    return patterns;
  }

  /**
   * Extract route parameters from path
   */
  private extractRouteParameters(path: string): string[] {
    const paramRegex = /\{([^}]+)\}/g;
    const parameters: string[] = [];
    let match;
    
    while ((match = paramRegex.exec(path)) !== null) {
      parameters.push(match[1]);
    }
    
    return parameters;
  }

  /**
   * Enhance node with Actix metadata
   */
  private enhanceNodeWithActixMetadata(node: any, pattern: any): void {
    if (!node.metadata) node.metadata = {};
    if (!node.metadata.actix) node.metadata.actix = {};

    switch (pattern.type) {
      case 'route':
      case 'param-route':
        node.tags = [...(node.tags || []), 'actix-route', 'http-handler', 'entry-point'];
        node.subcategories = [...(node.subcategories || []), 'route-handlers'];
        node.metadata.actix.route = {
          method: pattern.method,
          path: pattern.path,
          parameters: pattern.parameters || []
        };
        node.metadata.framework = 'actix-web';
        break;

      case 'middleware':
        node.tags = [...(node.tags || []), 'actix-middleware', 'middleware'];
        node.subcategories = [...(node.subcategories || []), 'request-pipeline'];
        node.metadata.actix.middleware = {
          name: pattern.name
        };
        break;

      case 'service':
        node.tags = [...(node.tags || []), 'actix-service', 'service'];
        node.subcategories = [...(node.subcategories || []), 'business-logic'];
        node.metadata.actix.service = {
          name: pattern.name
        };
        break;

      case 'state':
        node.tags = [...(node.tags || []), 'actix-state', 'state-management'];
        node.subcategories = [...(node.subcategories || []), 'application-state'];
        node.metadata.actix.state = {
          name: pattern.name
        };
        break;
    }
  }

  /**
   * Create Actix route entry points
   */
  private async createActixRoutes(nodes: any[], edges: any[], entryPoints: any[], projectPath: string): Promise<void> {
    const routeNodes = nodes.filter(n => n.tags?.includes('actix-route'));
    
    routeNodes.forEach(routeNode => {
      if (!routeNode.metadata?.actix?.route) return;

      const route = routeNode.metadata.actix.route;
      
      // Create entry point
      const entryPoint = {
        id: `entry_actix_route_${routeNode.id}`,
        type: 'http',
        name: `${route.method} ${route.path}`,
        description: `Actix-web ${route.method} handler for ${route.path}`,
        
        trigger: {
          method: route.method,
          path: route.path,
          parameters: (route.parameters || []).map(param => ({
            name: param,
            type: 'path',
            required: true,
            location: 'path'
          }))
        },
        
        handler: {
          node_id: routeNode.id,
          method_name: routeNode.name,
          file: routeNode.source?.file || '',
          line: routeNode.source?.line || 0
        },
        
        security: {
          authenticated: false, // Default, would be enhanced with auth detection
          guards: [],
          roles: [],
          permissions: []
        },
        
        metadata: {
          framework: 'actix-web',
          route_parameters: route.parameters || []
        }
      };

      entryPoints.push(entryPoint);
    });
  }

  /**
   * Detect and create Actix middleware
   */
  private async createActixMiddlewares(nodes: any[], edges: any[], projectPath: string): Promise<void> {
    const middlewareNodes = nodes.filter(n => n.tags?.includes('actix-middleware'));
    
    middlewareNodes.forEach(middlewareNode => {
      // Create relationships between middleware and other nodes
      // This would be enhanced with actual middleware chain analysis
    });
  }

  /**
   * Detect and create Actix services
   */
  private async createActixServices(nodes: any[], edges: any[], projectPath: string): Promise<void> {
    const serviceNodes = nodes.filter(n => n.tags?.includes('actix-service'));
    
    serviceNodes.forEach(serviceNode => {
      // Mark as injectable services
      if (!serviceNode.metadata) serviceNode.metadata = {};
      serviceNode.metadata.injectable = true;
      serviceNode.metadata.scope = 'singleton'; // Default scope
    });
  }

  /**
   * Count Actix middleware nodes
   */
  private countActixMiddlewares(nodes: any[]): number {
    return nodes.filter(n => n.tags?.includes('actix-middleware')).length;
  }

  /**
   * Count Actix service nodes
   */
  private countActixServices(nodes: any[]): number {
    return nodes.filter(n => n.tags?.includes('actix-service')).length;
  }

  /**
   * Detect high-level Actix patterns
   */
  private detectActixPatterns(nodes: any[], edges: any[]): string[] {
    const patterns: string[] = [];
    
    // Detect REST API pattern
    const routeNodes = nodes.filter(n => n.tags?.includes('actix-route'));
    if (routeNodes.length > 0) {
      patterns.push('REST API');
    }
    
    // Detect middleware usage
    const middlewareNodes = nodes.filter(n => n.tags?.includes('actix-middleware'));
    if (middlewareNodes.length > 0) {
      patterns.push('Request Pipeline');
    }
    
    // Detect service layer
    const serviceNodes = nodes.filter(n => n.tags?.includes('actix-service'));
    if (serviceNodes.length > 0) {
      patterns.push('Service Layer');
    }
    
    // Detect state management
    const stateNodes = nodes.filter(n => n.tags?.includes('actix-state'));
    if (stateNodes.length > 0) {
      patterns.push('State Management');
    }
    
    return patterns;
  }

  // Utility methods
  private hasActixPatterns(content: string): boolean {
    const actixPatterns = [
      /actix_web::/,
      /#\[get\("/,
      /#\[post\("/,
      /#\[put\("/,
      /#\[delete\("/,
      /HttpServer::/,
      /App::new/,
      /web::/,
      /HttpResponse::/,
      /web::Data</];
    
    return actixPatterns.some(pattern => pattern.test(content));
  }

  private async findRustFiles(projectPath: string): Promise<string[]> {
    const glob = require('glob');
    return new Promise((resolve, reject) => {
      glob('**/*.rs', { 
        cwd: projectPath, 
        ignore: ['**/target/**', '**/.git/**'] 
      }, (err, files) => {
        if (err) reject(err);
        else resolve(files.map(f => `${projectPath}/${f}`));
      });
    });
  }

  private async fileExists(filePath: string): Promise<boolean> {
    const fs = require('fs').promises;
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async readFileContent(filePath: string): Promise<string> {
    const fs = require('fs').promises;
    return await fs.readFile(filePath, 'utf-8');
  }
}