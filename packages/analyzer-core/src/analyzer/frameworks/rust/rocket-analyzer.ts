import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution } from '../../../types/cas.types';
import { RustAnalyzer } from '../../languages/rust-analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';





export class RocketAnalyzer extends BaseAnalyzer {
  private rustAnalyzer: RustAnalyzer;

  constructor() {
    super('rocket', 'Rocket Framework Analyzer', '1.0.0', 'framework');
    this.rustAnalyzer = new RustAnalyzer();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const hasCargoToml = await this.fileExists(path.join(projectPath, 'Cargo.toml'));
    if (!hasCargoToml) return false;

    try {
      const cargoContent = await this.readFileContent(path.join(projectPath, 'Cargo.toml'));
      const hasRocketDep = cargoContent.includes('rocket') ||
                            cargoContent.includes('rocket_dyn_templates') ||
                            cargoContent.includes('rocket_sync');
      if (!hasRocketDep) return false;

      const rustFiles = await this.findRustFiles(projectPath);
      for (const file of rustFiles) {
        const content = await this.readFileContent(file);
        if (this.hasRocketPatterns(content)) {
          return true;
        }
      }
    } catch (error) {
      return false;
    }

    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const rustContribution = await this.rustAnalyzer.analyze(context);
    const nodes = [...(rustContribution.nodes || [])];
    const edges = [...(rustContribution.edges || [])];
    const entryPoints = [...(rustContribution.entry_points || [])];
    const exitPoints = [...(rustContribution.exit_points || [])];

    try {
      await this.enhanceNodesWithRocketInfo(nodes, context.projectPath);
      await this.createRocketRoutes(nodes, edges, entryPoints, context.projectPath);
      await this.createRocketFairings(nodes, edges, context.projectPath);
      await this.createRocketState(nodes, edges, context.projectPath);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'rocket',
          route_count: entryPoints.filter(ep => ep.type === 'http').length,
          fairing_count: this.countRocketFairings(nodes),
          state_guard_count: this.countRocketStateGuards(nodes),
          patterns_detected: this.detectRocketPatterns(nodes, edges)
        }
      });
    } catch (error) {
      throw new Error(`Rocket analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return [
      'route-extraction',
      'fairing-detection',
      'state-guards',
      'template-detection',
      'error-handling'
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'rocket-framework';
      case 2: return 'routes';
      case 3: return 'handlers';
      case 4: return 'fairings';
      default: return `rocket-level-${level}`;
    }
  }

  private async enhanceNodesWithRocketInfo(nodes: any[], projectPath: string): Promise<void> {
    const rustFiles = await this.findRustFiles(projectPath);

    for (const file of rustFiles) {
      const content = await this.readFileContent(file);
      const rocketPatterns = this.extractRocketPatterns(content, file);

      rocketPatterns.forEach(pattern => {
        const node = nodes.find(n => n.source?.file === file &&
                                         n.source?.line >= pattern.line &&
                                         n.source?.line <= pattern.line + 10);
        if (node) {
          this.enhanceNodeWithRocketMetadata(node, pattern);
        }
      });
    }
  }

  private extractRocketPatterns(content: string, filePath: string): any[] {
    const patterns: any[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {

      const routeMatch = line.match(/#\[get\("([^"]+)"\)\]|#\[post\("([^"]+)"\)\]|#\[put\("([^"]+)"\)\]|#\[delete\("([^"]+)"\)\]|#\[patch\("([^"]+)"\)/i);
      if (routeMatch) {
        patterns.push({
          type: 'route',
          method: routeMatch[1] ? 'GET' : routeMatch[2] ? 'POST' : routeMatch[3] ? 'PUT' : routeMatch[4] ? 'DELETE' : 'PATCH',
          path: routeMatch[1] || routeMatch[2] || routeMatch[3] || routeMatch[4] || routeMatch[5],
          line: index + 1
        });
      }


      const dynamicRouteMatch = line.match(/#\[get\("([^"]+\/<\w+>)"\)\]|#\[post\("([^"]+\/<\w+>)"\)/i);
      if (dynamicRouteMatch) {
        patterns.push({
          type: 'dynamic-route',
          method: dynamicRouteMatch[1] ? 'GET' : 'POST',
          path: dynamicRouteMatch[1] || dynamicRouteMatch[2],
          parameters: this.extractDynamicRouteParameters(dynamicRouteMatch[1] || dynamicRouteMatch[2]),
          line: index + 1
        });
      }


      const fairingMatch = line.match(/#\[launch\(|#\[attach\(as\s+(\w+)\)|impl\s+Fairing\s+for\s+(\w+)/);
      if (fairingMatch) {
        patterns.push({
          type: 'fairing',
          name: fairingMatch[1] || fairingMatch[2],
          line: index + 1
        });
      }


      const stateGuardMatch = line.match(/State<(\w+)>|request_guard\(<(\w+)>/);
      if (stateGuardMatch) {
        patterns.push({
          type: 'state-guard',
          name: stateGuardMatch[1] || stateGuardMatch[2],
          line: index + 1
        });
      }


      const templateMatch = line.match(/Template::render\(|\.html\(\)|rocket_dyn_templates::Template/);
      if (templateMatch) {
        patterns.push({
          type: 'template',
          line: index + 1
        });
      }
    });

    return patterns;
  }

  private extractDynamicRouteParameters(path: string): string[] {
    const paramRegex = /<(\w+)>/g;
    const parameters: string[] = [];
    let match;

    while ((match = paramRegex.exec(path)) !== null) {
      parameters.push(match[1]);
    }

    return parameters;
  }

  private enhanceNodeWithRocketMetadata(node: any, pattern: any): void {
    if (!node.metadata) node.metadata = {};
    if (!node.metadata.rocket) node.metadata.rocket = {};

    switch (pattern.type) {
      case 'route':
      case 'dynamic-route':
        node.tags = [...(node.tags || []), 'rocket-route', 'http-handler', 'entry-point'];
        node.subcategories = [...(node.subcategories || []), 'route-handlers'];
        node.metadata.rocket.route = {
          method: pattern.method,
          path: pattern.path,
          parameters: pattern.parameters || []
        };
        node.metadata.framework = 'rocket';
        break;

      case 'fairing':
        node.tags = [...(node.tags || []), 'rocket-fairing', 'middleware'];
        node.subcategories = [...(node.subcategories || []), 'request-pipeline'];
        node.metadata.rocket.fairing = {
          name: pattern.name
        };
        break;

      case 'state-guard':
        node.tags = [...(node.tags || []), 'rocket-state-guard', 'state-management'];
        node.subcategories = [...(node.subcategories || []), 'application-state'];
        node.metadata.rocket.stateGuard = {
          name: pattern.name
        };
        break;

      case 'template':
        node.tags = [...(node.tags || []), 'rocket-template', 'view-layer'];
        node.subcategories = [...(node.subcategories || []), 'presentation'];
        node.metadata.rocket.template = true;
        break;
    }
  }

  private async createRocketRoutes(nodes: any[], edges: any[], entryPoints: any[], projectPath: string): Promise<void> {
    const routeNodes = nodes.filter(n => n.tags?.includes('rocket-route'));

    routeNodes.forEach(routeNode => {
      if (!routeNode.metadata?.rocket?.route) return;

      const route = routeNode.metadata.rocket.route;

      const entryPoint = {
        id: `entry_rocket_route_${routeNode.id}`,
        type: 'http',
        name: `${route.method} ${route.path}`,
        description: `Rocket ${route.method} handler for ${route.path}`,

        trigger: {
          method: route.method,
          path: route.path,
          parameters: (route.parameters || []).map((param: string) => ({
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
          authenticated: false,
          guards: [],
          roles: [],
          permissions: []
        },

        metadata: {
          framework: 'rocket',
          route_parameters: route.parameters || []
        }
      };

      entryPoints.push(entryPoint);
    });
  }

  private async createRocketFairings(nodes: any[], edges: any[], projectPath: string): Promise<void> {
    const fairingNodes = nodes.filter(n => n.tags?.includes('rocket-fairing'));

    fairingNodes.forEach(fairingNode => {
      if (!fairingNode.metadata?.rocket?.fairing) return;

      if (!fairingNode.metadata) fairingNode.metadata = {};
      fairingNode.metadata.middleware_type = 'fairing';
      fairingNode.metadata.execution_order = 'launch';
    });
  }

  private async createRocketState(nodes: any[], edges: any[], projectPath: string): Promise<void> {
    const stateGuardNodes = nodes.filter(n => n.tags?.includes('rocket-state-guard'));

    stateGuardNodes.forEach(stateNode => {
      if (!stateNode.metadata?.rocket?.stateGuard) return;

      const stateGuard = stateNode.metadata.rocket.stateGuard;


      if (!stateNode.metadata) stateNode.metadata = {};
      stateNode.metadata.state_type = 'request-guard';
      stateNode.metadata.managed_state = stateGuard.name;
    });
  }

  private countRocketFairings(nodes: any[]): number {
    return nodes.filter(n => n.tags?.includes('rocket-fairing')).length;
  }

  private countRocketStateGuards(nodes: any[]): number {
    return nodes.filter(n => n.tags?.includes('rocket-state-guard')).length;
  }

  private detectRocketPatterns(nodes: any[], edges: any[]): string[] {
    const patterns: string[] = [];

    const routeNodes = nodes.filter(n => n.tags?.includes('rocket-route'));
    if (routeNodes.length > 0) patterns.push('REST API');

    const fairingNodes = nodes.filter(n => n.tags?.includes('rocket-fairing'));
    if (fairingNodes.length > 0) patterns.push('Request Pipeline');

    const stateGuardNodes = nodes.filter(n => n.tags?.includes('rocket-state-guard'));
    if (stateGuardNodes.length > 0) patterns.push('State Management');

    const templateNodes = nodes.filter(n => n.tags?.includes('rocket-template'));
    if (templateNodes.length > 0) patterns.push('Template Rendering');

    return patterns;
  }

  private hasRocketPatterns(content: string): boolean {
    const rocketPatterns = [
      /rocket::/,
      /#\[get\("/,
      /#\[post\("/,
      /#\[put\("/,
      /#\[delete\("/,
      /#\[patch\("/,
      /rocket::build/,
      /rocket::launch/,
      /rocket::ignite/,
      /State</,
      /request_guard</,
      /Template::render/,
      /rocket_dyn_templates::/
    ];

    return rocketPatterns.some(pattern => pattern.test(content));
  }

  private async findRustFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.rs', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.map(file => path.join(projectPath, file));
  }

  private async fileExists(filePath: string): Promise<boolean> {
    return fs.pathExists(filePath);
  }

  private async readFileContent(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }
}
