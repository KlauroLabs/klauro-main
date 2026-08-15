import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface BlazorParameter {
  name: string;
  type: string;
  cascading: boolean;
}

interface BlazorInject {
  type: string;
  name: string;
}

interface BlazorRoute {
  template: string;
  routeParams: Array<{ name: string; constraint?: string }>;
}

interface BlazorHandler {
  event: string;
  method: string;
  target: string;
}

interface BlazorUsage {
  component: string;
  passedParameters: string[];
  line: number;
}

interface BlazorLifecycle {
  name: string;
}

interface BlazorComponent {
  name: string;
  filePath: string;
  codeBehindPath?: string;
  routes: BlazorRoute[];
  parameters: BlazorParameter[];
  injects: BlazorInject[];
  lifecycle: BlazorLifecycle[];
  handlers: BlazorHandler[];
  usages: BlazorUsage[];
  methods: string[];
}

const FRAMEWORK = 'blazor';
const COMPONENT_TAG = 'blazor-component';

export class BlazorAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'blazor',
      'Blazor Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const razorFiles = await glob(['**/*.razor'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });
      if (razorFiles.length > 0) return true;

      const csprojFiles = await glob(['**/*.csproj'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });
      for (const csproj of csprojFiles) {
        const content = await fs.readFile(path.join(projectPath, csproj), 'utf-8');
        if (/Microsoft\.AspNetCore\.Components/.test(content)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.razor'], {
      cwd: projectPath,
      ignore: this.getBlazorIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.sort();
  }

  private getBlazorIgnorePatterns(context: AnalysisContext): string[] {
    return [
      ...this.getIgnorePatterns(context),
      '**/bin/**', '**/obj/**', '**/_Imports.razor', '**/*.razor.g.cs'
    ];
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    if (context.relativePath.endsWith('.razor')) {
      const component = await this.parseComponent(context.relativePath, context.filePath, context.projectPath);
      if (component) {
        this.emitComponentNodes(component, context.projectPath, nodes, edges, entryPoints, exitPoints);
        this.emitUsageEdges([component], nodes, edges);
      }
    }

    const exports = nodes.filter(n => n.type === COMPONENT_TAG).map(n => n.name);

    return this.createFileAnalysisResult(
      context.relativePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const newNodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];

    try {
      const razorFiles = await glob(['**/*.razor'], {
        cwd: context.projectPath,
        ignore: this.getBlazorIgnorePatterns(context),
        nodir: true
      });

      const components: BlazorComponent[] = [];
      for (const file of razorFiles) {
        const fullPath = path.join(context.projectPath, file);
        const component = await this.parseComponent(file, fullPath, context.projectPath);
        if (component) components.push(component);
      }

      let routeCount = 0;
      for (const component of components) {
        this.emitComponentNodes(component, context.projectPath, newNodes, edges, entryPoints, exitPoints);
        routeCount += component.routes.length;
      }

      this.emitUsageEdges(components, newNodes, edges);

      this.createPerspectives(perspectives, components, routeCount);

      const contribution = this.createContribution(newNodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          components_detected: components.length,
          routable_pages: components.filter(c => c.routes.length > 0).length,
          routes_detected: routeCount,
          parameters_detected: components.reduce((a, c) => a + c.parameters.length, 0),
          injected_services: components.reduce((a, c) => a + c.injects.length, 0),
          event_handlers: components.reduce((a, c) => a + c.handlers.length, 0),
          composition_edges: components.reduce((a, c) => a + c.usages.length, 0)
        }
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;
    } catch (error) {
      throw new AnalyzerError(
        `Blazor analysis failed: ${(error as Error).message}`,
        'BLAZOR_ANALYSIS_ERROR'
      );
    }
  }

  private async parseComponent(
    relativePath: string,
    fullPath: string,
    projectPath: string
  ): Promise<BlazorComponent | undefined> {
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      return undefined;
    }

    const name = path.basename(relativePath, '.razor');


    const codeBehindRel = `${relativePath}.cs`;
    let codeBehindContent = '';
    let codeBehindPath: string | undefined;
    try {
      const cbFull = path.join(projectPath, codeBehindRel);
      if (await fs.pathExists(cbFull)) {
        codeBehindContent = await fs.readFile(cbFull, 'utf-8');
        codeBehindPath = codeBehindRel;
      }
    } catch {}

    const codeBlock = this.extractCodeBlock(content);

    const memberSource = `${codeBlock}\n${codeBehindContent}`;

    const routes = this.extractRoutes(content);
    const parameters = this.extractParameters(memberSource);
    const injects = this.extractInjects(content, memberSource);
    const lifecycle = this.extractLifecycle(memberSource);
    const methods = this.extractMethods(memberSource);
    const handlers = this.extractHandlers(content);
    const usages = this.extractUsages(content, name);

    return {
      name,
      filePath: relativePath,
      codeBehindPath,
      routes,
      parameters,
      injects,
      lifecycle,
      handlers,
      usages,
      methods
    };
  }

  private extractCodeBlock(content: string): string {

    const blocks: string[] = [];
    const directive = /@(?:code|functions)\s*\{/g;
    let match;
    while ((match = directive.exec(content)) !== null) {
      let depth = 1;
      let i = match.index + match[0].length;
      const start = i;
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      blocks.push(content.substring(start, i - 1));
    }
    return blocks.join('\n');
  }

  private extractRoutes(content: string): BlazorRoute[] {
    const routes: BlazorRoute[] = [];
    const pagePattern = /@page\s+"([^"]+)"/g;
    let match;
    while ((match = pagePattern.exec(content)) !== null) {
      const template = match[1];
      const routeParams: Array<{ name: string; constraint?: string }> = [];
      const paramPattern = /\{([^}:]+)(?::([^}]+))?\}/g;
      let pm;
      while ((pm = paramPattern.exec(template)) !== null) {
        routeParams.push({ name: pm[1].replace(/\?$/, '').trim(), constraint: pm[2]?.trim() });
      }
      routes.push({ template, routeParams });
    }
    return routes;
  }

  private extractParameters(source: string): BlazorParameter[] {
    const parameters: BlazorParameter[] = [];

    const paramPattern = /\[(Parameter|CascadingParameter)(?:\([^)]*\))?\]\s*public\s+([\w<>?,.\[\]\s]+?)\s+(\w+)\s*\{\s*get;\s*set;/g;
    let match;
    while ((match = paramPattern.exec(source)) !== null) {
      parameters.push({
        cascading: match[1] === 'CascadingParameter',
        type: match[2].trim(),
        name: match[3]
      });
    }
    return parameters;
  }

  private extractInjects(content: string, memberSource: string): BlazorInject[] {
    const injects: BlazorInject[] = [];
    const seen = new Set<string>();


    const directivePattern = /@inject\s+([\w<>?,.\[\]]+)\s+(\w+)/g;
    let match;
    while ((match = directivePattern.exec(content)) !== null) {
      const key = `${match[1]}:${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        injects.push({ type: match[1].trim(), name: match[2] });
      }
    }


    const attrPattern = /\[Inject\]\s*(?:public|private|protected|internal)?\s*([\w<>?,.\[\]]+)\s+(\w+)\s*\{\s*get;\s*set;/g;
    while ((match = attrPattern.exec(memberSource)) !== null) {
      const key = `${match[1]}:${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        injects.push({ type: match[1].trim(), name: match[2] });
      }
    }

    return injects;
  }

  private extractLifecycle(source: string): BlazorLifecycle[] {
    const lifecycle: BlazorLifecycle[] = [];
    const known = [
      'OnInitialized', 'OnInitializedAsync',
      'OnParametersSet', 'OnParametersSetAsync',
      'OnAfterRender', 'OnAfterRenderAsync',
      'ShouldRender', 'SetParametersAsync', 'Dispose', 'DisposeAsync'
    ];
    for (const hook of known) {
      const pattern = new RegExp(`\\b(?:protected|public|private)\\s+(?:override\\s+)?(?:async\\s+)?[\\w<>.]+\\s+${hook}\\s*\\(`);
      if (pattern.test(source)) {
        lifecycle.push({ name: hook });
      }
    }
    return lifecycle;
  }

  private extractMethods(source: string): string[] {
    const methods = new Set<string>();
    const pattern = /(?:(?:public|private|protected|internal)\s+)?(?:async\s+|static\s+|override\s+|virtual\s+)*[\w<>?,.\[\]]+\s+(\w+)\s*\([^)]*\)\s*(?:=>|\{)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      methods.add(match[1]);
    }
    return Array.from(methods);
  }

  private extractHandlers(content: string): BlazorHandler[] {
    const handlers: BlazorHandler[] = [];


    const eventPattern = /@on(\w+)\s*=\s*"@?\(?([^"()]+)\)?"/g;
    let match;
    while ((match = eventPattern.exec(content)) !== null) {
      const method = match[2].trim().replace(/\(.*$/, '').replace(/^@/, '');
      handlers.push({ event: `on${match[1]}`, method, target: 'element' });
    }


    const bindPattern = /@bind(?:-(\w+))?\s*=\s*"@?([^"]+)"/g;
    while ((match = bindPattern.exec(content)) !== null) {
      const target = match[1] ? `bind-${match[1]}` : 'bind';
      handlers.push({ event: target, method: match[2].trim(), target: 'binding' });
    }

    return handlers;
  }

  private extractUsages(content: string, selfName: string): BlazorUsage[] {
    const usages: BlazorUsage[] = [];

    const tagPattern = /<([A-Z][A-Za-z0-9]*)((?:\s+[^>]*)?)\/?>/g;
    let match;
    while ((match = tagPattern.exec(content)) !== null) {
      const tag = match[1];
      if (tag === selfName) continue;

      const attrBlob = match[2] || '';
      const passedParameters: string[] = [];
      const attrPattern = /(?:^|\s)([A-Za-z][\w]*)\s*=/g;
      let am;
      while ((am = attrPattern.exec(attrBlob)) !== null) {
        if (!am[1].startsWith('@')) passedParameters.push(am[1]);
      }
      const line = content.substring(0, match.index).split('\n').length;
      usages.push({ component: tag, passedParameters, line });
    }
    return usages;
  }

  private emitComponentNodes(
    component: BlazorComponent,
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {
    const componentId = this.componentId(component.name, component.filePath);

    const isRoutable = component.routes.length > 0;

    const componentNode = this.createNodeBuilder(componentId, component.name, COMPONENT_TAG)
      .withLevel(2, this.getLevelName(2))
      .withSource({ file: component.filePath, line: 1 })
      .withMetadata({
        framework: FRAMEWORK,
        attributes: {
          is_routable: isRoutable,
          routes: component.routes.map(r => r.template),
          parameter_count: component.parameters.length,
          parameters: component.parameters.map(p => ({ name: p.name, type: p.type, cascading: p.cascading })),
          injected_services: component.injects.map(i => ({ type: i.type, name: i.name })),
          lifecycle_hooks: component.lifecycle.map(l => l.name),
          event_handler_count: component.handlers.length,
          has_code_behind: !!component.codeBehindPath,
          code_behind: component.codeBehindPath
        }
      })
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .build();
    nodes.push(componentNode);


    for (const param of component.parameters) {
      const paramId = this.generateId('blazor-param', component.filePath, `${component.name}_${param.name}`);
      const paramNode = this.createNodeBuilder(paramId, param.name, 'parameter')
        .withLevel(4, this.getLevelName(4))
        .withSource({ file: component.filePath })
        .withParent(componentId)
        .withMetadata({
          framework: FRAMEWORK,
          attributes: {
            parameter_type: param.type,
            cascading: param.cascading
          }
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();
      nodes.push(paramNode);

      edges.push(this.createEdgeBuilder(
        this.generateEdgeId(componentId, paramId, 'has-parameter'),
        componentId, paramId, 'has-parameter'
      ).build());
    }


    for (const route of component.routes) {
      const routeId = this.generateId('blazor-route', component.filePath, `${component.name}_${route.template}`);
      const routeNode = this.createNodeBuilder(routeId, route.template, 'route')
        .withLevel(3, this.getLevelName(3))
        .withSource({ file: component.filePath })
        .withParent(componentId)
        .withMetadata({
          framework: FRAMEWORK,
          attributes: {
            path: route.template,
            component: component.name,
            route_params: route.routeParams
          }
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();
      nodes.push(routeNode);

      edges.push(this.createEdgeBuilder(
        this.generateEdgeId(componentId, routeId, 'has-route'),
        componentId, routeId, 'has-route'
      ).build());

      entryPoints.push(this.createEntryPoint(
        this.generateId('entry', component.filePath, `page_${route.template}`),
        routeId,
        'http',
        `PAGE ${route.template}`,
        `Blazor routable page: ${component.name}`,
        { method: 'GET', path: route.template },
        undefined,
        {
          framework: FRAMEWORK,
          entry_type: 'blazor-page',
          path: route.template,
          component: component.name,
          route_params: route.routeParams
        }
      ));
    }


    for (const handler of component.handlers) {
      const isMethod = component.methods.includes(handler.method);
      const handlerId = this.generateId('blazor-handler', component.filePath, `${component.name}_${handler.event}_${handler.method}`);
      const handlerNode = this.createNodeBuilder(handlerId, `${handler.event}=${handler.method}`, 'event_handler')
        .withLevel(4, this.getLevelName(4))
        .withSource({ file: component.filePath })
        .withParent(componentId)
        .withMetadata({
          framework: FRAMEWORK,
          attributes: {
            event: handler.event,
            method: handler.method,
            binding_kind: handler.target,
            resolved_to_code_method: isMethod
          }
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();
      nodes.push(handlerNode);

      edges.push(this.createEdgeBuilder(
        this.generateEdgeId(componentId, handlerId, `handles-${handler.event}`),
        componentId, handlerId, 'handles-event'
      ).withMetadata({ attributes: { event: handler.event, method: handler.method } }).build());
    }


    for (const inject of component.injects) {
      exitPoints.push(this.createExitPoint(
        this.generateId('exit', component.filePath, `${component.name}_inject_${inject.name}`),
        componentId,
        'sdk',
        `${component.name} -> ${inject.type}`,
        `Blazor injected service ${inject.type}`,
        { service_id: inject.type },
        { action: 'inject', method: inject.name },
        { framework: FRAMEWORK, injected_type: inject.type, field: inject.name }
      ));
    }
  }

  private emitUsageEdges(
    components: BlazorComponent[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const byName = new Map<string, BlazorComponent>();
    for (const c of components) byName.set(c.name, c);

    for (const component of components) {
      const sourceId = this.componentId(component.name, component.filePath);
      for (const usage of component.usages) {
        const target = byName.get(usage.component);
        if (!target) continue;
        const targetId = this.componentId(target.name, target.filePath);
        const edgeId = this.generateEdgeId(sourceId, targetId, `uses-${usage.line}`);
        if (edges.find(e => e.id === edgeId)) continue;
        edges.push(this.createEdgeBuilder(edgeId, sourceId, targetId, 'uses')
          .withMetadata({
            attributes: {
              relationship: 'component-composition',
              child_component: usage.component,
              passed_parameters: usage.passedParameters,
              line: usage.line
            }
          }).build());
      }
    }
  }

  private componentId(name: string, filePath: string): string {
    return this.generateId('blazor-component', filePath, name);
  }

  private createPerspectives(
    perspectives: CASPerspective[],
    components: BlazorComponent[],
    routeCount: number
  ): void {
    perspectives.push({
      id: 'blazor-component-tree',
      name: 'Blazor Component Tree',
      description: 'Blazor components and their composition relationships',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: [COMPONENT_TAG, 'parameter', 'route', 'event_handler']
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'type'
      }
    });

    if (routeCount > 0) {
      perspectives.push({
        id: 'blazor-pages',
        name: 'Blazor Routable Pages',
        description: 'Routable Blazor pages and their @page routes',
        analyzer_id: this.analyzerId,
        type: 'flow',
        connection_rules: {
          visible_node_types: [COMPONENT_TAG, 'route']
        },
        layout_hints: {
          style: 'hierarchical',
          direction: 'LR',
          group_by: 'type'
        }
      });
    }
  }

  protected getCapabilities(): string[] {
    return [
      'blazor-components',
      'blazor-pages',
      'blazor-composition',
      'blazor-di'
    ];
  }

  protected getLevelName(level: number): string {
    const levels: Record<number, string> = {
      1: 'system',
      2: 'architectural',
      3: 'code',
      4: 'member',
      5: 'implementation'
    };
    return levels[level] || 'unknown';
  }
}
