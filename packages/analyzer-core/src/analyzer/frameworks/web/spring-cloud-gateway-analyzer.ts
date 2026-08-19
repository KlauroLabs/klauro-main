import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASContribution, CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { cachedGlob as glob } from '../../core/glob-cache';

interface GatewayRoute {
  id: string;
  uri: string;
  paths: string[];
  methods: string[];
  predicates: unknown[];
  filters: unknown[];
  file: string;
  line: number;
}

interface GatewayConfiguration {
  file: string;
  routes: GatewayRoute[];
}

const CONFIGURATION_GLOBS = [
  '**/src/main/resources/application*.yml',
  '**/src/main/resources/application*.yaml',
  '**/src/main/resources/bootstrap*.yml',
  '**/src/main/resources/bootstrap*.yaml',
];

export class SpringCloudGatewayAnalyzer extends BaseAnalyzer {
  constructor() {
    super('spring-cloud-gateway', 'Spring Cloud Gateway Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.loadConfigurations({ projectPath })).some(configuration => configuration.routes.length > 0);
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const configurations = await this.loadConfigurations(context);

    for (const configuration of configurations) {
      const configurationId = this.generateId('spring_gateway_configuration', configuration.file, 'gateway');
      nodes.push(this.createNodeBuilder(configurationId, path.basename(configuration.file), 'gateway')
        .withLevel(2, this.getLevelName(2))
        .withCategory('gateway', ['spring-cloud-gateway', 'configuration'])
        .withSource({ file: configuration.file, line: 1 })
        .withDescription('Spring Cloud Gateway routing configuration')
        .withMetadata({ framework: 'spring-cloud-gateway', attributes: { route_count: configuration.routes.length } })
        .build());

      for (const route of configuration.routes) {
        const routeId = this.generateId('spring_gateway_route', route.file, route.id);
        const serviceId = this.serviceId(route.uri) || route.id;
        nodes.push(this.createNodeBuilder(routeId, route.id, 'gateway_route')
          .withLevel(3, this.getLevelName(3))
          .withCategory('gateway', ['spring-cloud-gateway', 'routing'])
          .withSource({ file: route.file, line: route.line })
          .withDescription(`Spring Cloud Gateway route to ${serviceId}`)
          .withMetadata({
            framework: 'spring-cloud-gateway',
            attributes: {
              uri: route.uri,
              paths: route.paths,
              methods: route.methods,
              predicates: route.predicates,
              filters: route.filters,
              service_id: serviceId,
            },
          })
          .build());
        edges.push(this.createEdge(
          this.generateEdgeId(configurationId, routeId, 'contains'),
          configurationId,
          routeId,
          'contains',
          'structural'
        ));
        this.addBoundaries(route, routeId, serviceId, entryPoints, exitPoints);
      }
    }

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework_specific: {
        framework: 'spring-cloud-gateway',
        configurations_detected: configurations.length,
        routes_detected: configurations.reduce((sum, configuration) => sum + configuration.routes.length, 0),
      },
    });
  }

  protected getCapabilities(): string[] {
    return ['spring-cloud-gateway-routes', 'load-balanced-service-boundaries', 'gateway-predicates', 'gateway-filters'];
  }

  protected getLevelName(level: number): string {
    return level === 2 ? 'Spring Cloud Gateway configuration' : 'Spring Cloud Gateway route';
  }

  private async loadConfigurations(context: AnalysisContext | { projectPath: string }): Promise<GatewayConfiguration[]> {
    const files = await glob(CONFIGURATION_GLOBS, {
      cwd: context.projectPath,
      ignore: this.getIgnorePatterns(context as AnalysisContext),
      nodir: true,
    });
    const configurations: GatewayConfiguration[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(context.projectPath, file), 'utf8');
      } catch {
        continue;
      }
      const routes = this.parseRoutes(content, file);
      if (routes.length > 0) configurations.push({ file, routes });
    }
    return configurations;
  }

  private parseRoutes(content: string, file: string): GatewayRoute[] {
    const documents: unknown[] = [];
    try {
      yaml.loadAll(content, document => documents.push(document));
    } catch {
      return [];
    }
    const routes: GatewayRoute[] = [];
    const seen = new Set<string>();
    for (const document of documents) {
      for (const definition of this.collectDefinitions(document)) {
        const id = String(definition.id || '').trim();
        const uri = String(definition.uri || '').trim();
        const key = `${id}\0${uri}`;
        if (!id || !uri || seen.has(key)) continue;
        seen.add(key);
        const predicates = Array.isArray(definition.predicates) ? definition.predicates : [];
        routes.push({
          id,
          uri,
          paths: this.predicateValues(predicates, 'Path'),
          methods: this.predicateValues(predicates, 'Method').map(method => method.toUpperCase()),
          predicates,
          filters: Array.isArray(definition.filters) ? definition.filters : [],
          file,
          line: this.routeLine(content, id, uri),
        });
      }
    }
    return routes;
  }

  private collectDefinitions(value: unknown): Array<Record<string, any>> {
    const routes: Array<Record<string, any>> = [];
    const stack: Array<{ value: unknown; path: string[] }> = [{ value, path: [] }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (!current.value || typeof current.value !== 'object') continue;
      if (Array.isArray(current.value)) {
        for (const item of current.value) stack.push({ value: item, path: current.path });
        continue;
      }
      for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
        const childPath = [...current.path, key.toLowerCase()];
        if (key === 'routes' && current.path.includes('gateway') && Array.isArray(child)) {
          for (const candidate of child) {
            if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && 'uri' in candidate) {
              routes.push(candidate as Record<string, any>);
            }
          }
        }
        stack.push({ value: child, path: childPath });
      }
    }
    return routes;
  }

  private predicateValues(predicates: unknown[], name: string): string[] {
    const values = new Set<string>();
    for (const predicate of predicates) {
      if (typeof predicate === 'string') {
        const match = predicate.match(new RegExp(`^${name}\\s*=\\s*(.+)$`, 'i'));
        if (match) this.addValues(values, match[1]);
        continue;
      }
      if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) continue;
      const record = predicate as Record<string, any>;
      if (String(record.name || '').toLowerCase() !== name.toLowerCase()) continue;
      const args = record.args && typeof record.args === 'object' ? Object.values(record.args) : [];
      for (const value of args) if (typeof value === 'string') this.addValues(values, value);
    }
    return [...values];
  }

  private addValues(values: Set<string>, raw: string): void {
    for (const value of raw.split(',')) if (value.trim()) values.add(value.trim());
  }

  private addBoundaries(
    route: GatewayRoute,
    routeId: string,
    serviceId: string,
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {
    const paths = route.paths.length > 0 ? route.paths : ['/'];
    const methods = route.methods.length > 0 ? route.methods : ['ALL'];
    for (const gatewayPath of paths) {
      for (const method of methods) {
        entryPoints.push(this.createEntryPoint(
          this.generateId('entry_spring_gateway', route.file, `${route.id}_${method}_${gatewayPath}`),
          routeId,
          'http',
          `${method} ${gatewayPath}`,
          `Spring Cloud Gateway route ${gatewayPath} to ${serviceId}`,
          { method, path: gatewayPath },
          undefined,
          { framework: 'spring-cloud-gateway', route_id: route.id, target_uri: route.uri },
          { node_id: routeId, method_name: route.id, file: route.file, line: route.line }
        ));
      }
    }
    exitPoints.push(this.createExitPoint(
      this.generateId('exit_spring_gateway', route.file, `${route.id}_${route.uri}`),
      routeId,
      'api',
      `ROUTE ${route.paths.join(', ') || '/'} to ${serviceId}`,
      `Spring Cloud Gateway forwards matching requests to ${serviceId}`,
      { service_id: serviceId, endpoint: route.paths[0], resource: route.uri },
      { action: 'route', method: route.methods.join(',') || 'ALL', async: false },
      {
        framework: 'spring-cloud-gateway',
        route_id: route.id,
        service_aliases: [serviceId],
        predicates: route.predicates,
        filters: route.filters,
        line: route.line,
      }
    ));
  }

  private serviceId(uri: string): string | undefined {
    const loadBalanced = uri.match(/^lb:\/\/([^/?#]+)/i)?.[1];
    if (loadBalanced) return loadBalanced;
    try {
      return new URL(uri).hostname || undefined;
    } catch {
      return undefined;
    }
  }

  private routeLine(content: string, id: string, uri: string): number {
    const lines = content.split(/\r?\n/);
    const idPattern = new RegExp(`^\\s*-?\\s*id\\s*:\\s*['"]?${escapeRegex(id)}['"]?\\s*$`);
    const idLine = lines.findIndex(line => idPattern.test(line));
    if (idLine >= 0) return idLine + 1;
    const uriLine = lines.findIndex(line => line.includes(uri));
    return uriLine >= 0 ? uriLine + 1 : 1;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
