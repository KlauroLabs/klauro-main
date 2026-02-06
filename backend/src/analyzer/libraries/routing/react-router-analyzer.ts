import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

const JSX_ROUTE_V5 = /<Route[^>]*path=["']([^"']+)["'][^>]*component=\{?([^}\s>]+)\}?/g;
const JSX_ROUTE_V6_ELEMENT = /<Route[^>]*path=["']([^"']+)["'][^>]*element=\{[^}]*<(\w+)/g;
const OBJECT_ROUTE = /\{\s*path:\s*['"]([^'"]+)['"]\s*,\s*(?:element|component)\s*:\s*(?:<(\w+)|(\w+))/g;
const NAVIGATE_CALL = /(?:navigate|push|replace)\s*\(\s*['"]([^'"]+)['"]/g;
const LINK_TO = /<(?:Link|NavLink)[^>]*to=["']([^"']+)["']/g;
const LOADER_PATTERN = /loader\s*:\s*(\w+)/g;
const ACTION_PATTERN = /action\s*:\s*(\w+)/g;

export class ReactRouterAnalyzer extends BaseAnalyzer {
  constructor() {
    super('react-router', 'React Router Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return 'react-router-dom' in deps || 'react-router' in deps;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { projectPath } = context;
    const ignorePatterns = this.getIgnorePatterns(context);

    const sourceFiles = await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: projectPath,
      ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*'],
      absolute: false
    });

    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const seenRoutes = new Set<string>();
    const seenExitIds = new Set<string>();

    for (const relativePath of sourceFiles) {
      const absolutePath = path.join(projectPath, relativePath);
      const content = await fs.readFile(absolutePath, 'utf-8');

      if (!this.hasRouterUsage(content)) continue;

      const fileNodeId = this.findFileNodeId(relativePath, context.existingAnalysis);
      const sanitizedPath = relativePath.replace(/[^a-zA-Z0-9]/g, '_');

      this.extractRouteDefinitions(content, relativePath, sanitizedPath, fileNodeId, context, nodes, edges, entryPoints, seenRoutes);
      this.extractNavigationCalls(content, relativePath, sanitizedPath, fileNodeId, exitPoints, seenExitIds);
      this.extractLinkUsages(content, relativePath, sanitizedPath, fileNodeId, exitPoints, seenExitIds);
      this.extractLoaderActions(content, relativePath, sanitizedPath, fileNodeId, nodes, edges);
    }

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      library: 'react-router',
      routesFound: seenRoutes.size,
      navigationCallsFound: exitPoints.filter(e => e.type === 'navigation').length
    });
  }

  private hasRouterUsage(content: string): boolean {
    return content.includes('Route') || content.includes('Router') ||
           content.includes('useNavigate') || content.includes('useParams') ||
           content.includes('Link') || content.includes('createBrowserRouter');
  }

  private extractRouteDefinitions(
    content: string,
    relativePath: string,
    sanitizedPath: string,
    fileNodeId: string | undefined,
    context: AnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    seenRoutes: Set<string>
  ): void {
    const patterns = [JSX_ROUTE_V5, JSX_ROUTE_V6_ELEMENT, OBJECT_ROUTE];

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const routePath = match[1];
        const component = match[2] || match[3] || 'Unknown';

        if (seenRoutes.has(routePath)) continue;
        seenRoutes.add(routePath);

        const sanitizedRoute = routePath.replace(/[^a-zA-Z0-9]/g, '_');
        const nodeId = `route_react_${sanitizedRoute}`;
        const isLazy = this.isLazyRoute(content, routePath);

        nodes.push(this.createNode(
          nodeId,
          routePath,
          'route',
          3,
          relativePath,
          undefined,
          undefined,
          {
            library: 'react-router',
            path: routePath,
            component,
            lazy: isLazy,
            params: this.extractRouteParams(routePath)
          }
        ));

        if (fileNodeId) {
          edges.push(this.createEdge(
            `edge_${nodeId}_${fileNodeId}`,
            nodeId,
            fileNodeId,
            'defined_in',
            'structural'
          ));
        }

        const componentNodeId = this.findComponentNode(component, context);
        if (componentNodeId) {
          edges.push(this.createEdge(
            `edge_${nodeId}_${componentNodeId}`,
            nodeId,
            componentNodeId,
            'renders',
            'structural',
            { route_path: routePath }
          ));
        }

        entryPoints.push(this.createEntryPoint(
          `entry_route_${sanitizedRoute}`,
          fileNodeId || nodeId,
          'route',
          `GET ${routePath}`,
          undefined,
          { path: routePath, method: 'GET' },
          undefined,
          { framework: 'react-router', component, lazy: isLazy, sourceFile: relativePath }
        ));
      }
    }
  }

  private extractNavigationCalls(
    content: string,
    relativePath: string,
    sanitizedPath: string,
    fileNodeId: string | undefined,
    exitPoints: CASExitPoint[],
    seenExitIds: Set<string>
  ): void {
    NAVIGATE_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NAVIGATE_CALL.exec(content)) !== null) {
      const target = match[1];
      const sanitizedTarget = target.replace(/[^a-zA-Z0-9]/g, '_');
      const exitId = `exit_nav_${sanitizedPath}_${sanitizedTarget}`;

      if (seenExitIds.has(exitId)) continue;
      seenExitIds.add(exitId);

      exitPoints.push(this.createExitPoint(
        exitId,
        fileNodeId || `file_${sanitizedPath}`,
        'navigation',
        `Navigate to ${target}`,
        undefined,
        { endpoint: target },
        undefined,
        { framework: 'react-router', method: 'useNavigate', sourceFile: relativePath }
      ));
    }
  }

  private extractLinkUsages(
    content: string,
    relativePath: string,
    sanitizedPath: string,
    fileNodeId: string | undefined,
    exitPoints: CASExitPoint[],
    seenExitIds: Set<string>
  ): void {
    LINK_TO.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_TO.exec(content)) !== null) {
      const target = match[1];
      const sanitizedTarget = target.replace(/[^a-zA-Z0-9]/g, '_');
      const exitId = `exit_link_${sanitizedPath}_${sanitizedTarget}`;

      if (seenExitIds.has(exitId)) continue;
      seenExitIds.add(exitId);

      exitPoints.push(this.createExitPoint(
        exitId,
        fileNodeId || `file_${sanitizedPath}`,
        'navigation',
        `Link to ${target}`,
        undefined,
        { endpoint: target },
        undefined,
        { framework: 'react-router', method: 'Link', sourceFile: relativePath }
      ));
    }
  }

  private extractLoaderActions(
    content: string,
    relativePath: string,
    sanitizedPath: string,
    fileNodeId: string | undefined,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    LOADER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LOADER_PATTERN.exec(content)) !== null) {
      const loaderName = match[1];
      const nodeId = `loader_${sanitizedPath}_${loaderName}`;
      nodes.push(this.createNode(
        nodeId,
        loaderName,
        'route_loader',
        4,
        relativePath,
        undefined,
        undefined,
        { library: 'react-router', type: 'loader' }
      ));
    }

    ACTION_PATTERN.lastIndex = 0;
    while ((match = ACTION_PATTERN.exec(content)) !== null) {
      const actionName = match[1];
      const nodeId = `route_action_${sanitizedPath}_${actionName}`;
      nodes.push(this.createNode(
        nodeId,
        actionName,
        'route_action',
        4,
        relativePath,
        undefined,
        undefined,
        { library: 'react-router', type: 'action' }
      ));
    }
  }

  private extractRouteParams(routePath: string): string[] {
    const params: string[] = [];
    const paramPattern = /:(\w+)/g;
    let match;
    while ((match = paramPattern.exec(routePath)) !== null) {
      params.push(match[1]);
    }
    return params;
  }

  private isLazyRoute(content: string, routePath: string): boolean {
    const idx = content.indexOf(routePath);
    if (idx === -1) return false;
    const nearbyContent = content.substring(Math.max(0, idx - 200), idx + 200);
    return nearbyContent.includes('lazy') || nearbyContent.includes('React.lazy') ||
           nearbyContent.includes('loadable');
  }

  private findFileNodeId(relativePath: string, existingAnalysis?: CASContribution[]): string | undefined {
    const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!existingAnalysis) return undefined;
    for (const contribution of existingAnalysis) {
      const found = contribution.nodes?.find(n => n.id === fileId);
      if (found) return found.id;
    }
    return undefined;
  }

  private findComponentNode(componentName: string, context: AnalysisContext): string | undefined {
    if (!context.existingAnalysis) return undefined;
    for (const contribution of context.existingAnalysis) {
      const found = contribution.nodes?.find(n =>
        n.name === componentName && (n.type === 'functional_component' || n.type === 'class_component')
      );
      if (found) return found.id;
    }
    return undefined;
  }

  protected getCapabilities(): string[] {
    return ['route-detection', 'navigation-tracking', 'route-params', 'loader-action-detection', 'lazy-route-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}
