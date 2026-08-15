import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';



interface PhoenixRoute {
  method: string;
  routePath: string;
  controller: string;
  action?: string;
  kind: 'verb' | 'live' | 'resources';
  pipelines: string[];
  line: number;
}

interface PhoenixRouter {
  module: string;
  filePath: string;
  routes: PhoenixRoute[];
}

interface PhoenixActionFn {
  name: string;
  line: number;
}

interface PhoenixController {
  module: string;
  name: string;
  filePath: string;
  kind: 'controller' | 'liveview';
  actions: PhoenixActionFn[];
  lineEnd: number;
}

interface EctoAssociation {
  type: 'belongs_to' | 'has_many' | 'has_one' | 'many_to_many';
  name: string;
  targetSchema: string;
  line: number;
}

interface EctoField {
  name: string;
  type: string;
  line: number;
}

interface EctoSchema {
  module: string;
  name: string;
  filePath: string;
  table: string;
  fields: EctoField[];
  associations: EctoAssociation[];
  lineEnd: number;
}

interface PhoenixContext {
  module: string;
  name: string;
  filePath: string;
  publicFunctions: string[];
  lineEnd: number;
}

const ELIXIR_GLOBS = ['**/*.ex', '**/*.exs'];

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);


const AUTH_PIPELINE = /auth|require_|logged_in|ensure_|protect|admin|verified|authenticate/i;

const IGNORE_DIRS = [
  '**/node_modules/**',
  '**/deps/**',
  '**/_build/**',
  '**/priv/static/**',
  '**/.git/**',
];

export class PhoenixAnalyzer extends BaseAnalyzer {
  constructor() {
    super('phoenix', 'Phoenix Analyzer', '1.0.0', 'framework');
  }



  async canAnalyze(projectPath: string): Promise<boolean> {
    try {

      const mixPath = path.join(projectPath, 'mix.exs');
      if (await fs.pathExists(mixPath)) {
        const mix = await fs.readFile(mixPath, 'utf-8');
        if (/[:{]\s*phoenix\b/.test(mix) || /\{\s*:phoenix\b/.test(mix)) return true;
      }

      const files = await glob(ELIXIR_GLOBS, { cwd: projectPath, nodir: true, ignore: IGNORE_DIRS });
      for (const rel of files) {
        let content = '';
        try {
          content = await fs.readFile(path.join(projectPath, rel), 'utf-8');
        } catch {
          continue;
        }
        if (this.hasPhoenixUse(content)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private hasPhoenixUse(content: string): boolean {
    return (
      /\buse\s+Phoenix\.Router\b/.test(content) ||
      /\buse\s+Phoenix\.LiveView\b/.test(content) ||
      /\buse\s+Phoenix\.Controller\b/.test(content) ||
      /\buse\s+\w+Web\s*,\s*:(controller|router|live_view|live_component)\b/.test(content)
    );
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return [
      'phoenix-routes',
      'phoenix-controllers',
      'phoenix-liveview',
      'phoenix-contexts',
      'ecto-schemas',
    ];
  }



  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const projectPath = context.projectPath;
      const ignore = [...this.getIgnorePatterns(context), ...IGNORE_DIRS];
      let files = await glob(ELIXIR_GLOBS, { cwd: projectPath, nodir: true, ignore });
      files.sort();
      files = this.capAndPrioritizeSourceFiles(files, 'phoenix source files');

      const sources: Array<{ file: string; content: string }> = [];
      for (const rel of files) {
        try {
          sources.push({ file: rel, content: await fs.readFile(path.join(projectPath, rel), 'utf-8') });
        } catch {

        }
      }

      const routers: PhoenixRouter[] = [];
      const controllers: PhoenixController[] = [];
      const schemas: EctoSchema[] = [];
      const contexts: PhoenixContext[] = [];

      for (const src of sources) {
        const fullPath = path.join(projectPath, src.file);
        const lines = src.content.split('\n');

        if (this.isRouterFile(src.content)) {
          const router = this.extractRouter(src.file, src.content, lines);
          if (router) routers.push(router);
        }

        for (const ctrl of this.extractControllers(src.file, src.content, lines)) {
          controllers.push(ctrl);
        }

        for (const schema of this.extractSchemas(src.file, src.content, lines)) {
          schemas.push(schema);
        }

        const ctx = this.extractContext(projectPath, src.file, src.content, lines);
        if (ctx) contexts.push(ctx);


        void fullPath;
      }


      const controllerByName = new Map<string, PhoenixController>();
      for (const c of controllers) {
        controllerByName.set(c.name, c);
        controllerByName.set(c.module, c);
      }
      const schemaByName = new Map<string, EctoSchema>();
      for (const s of schemas) {
        schemaByName.set(s.name, s);
        schemaByName.set(s.module, s);
      }

      for (const ctrl of controllers) {
        this.emitController(projectPath, ctrl, nodes, edges, entryPoints);
      }
      for (const schema of schemas) {
        this.emitSchema(projectPath, schema, nodes, edges, exitPoints);
      }
      this.linkSchemaAssociations(schemas, schemaByName, edges);

      for (const ctx of contexts) {
        this.emitContext(projectPath, ctx, nodes);
      }

      let routeCount = 0;
      for (const router of routers) {
        this.emitRouter(projectPath, router, controllerByName, nodes, edges, entryPoints);
        routeCount += router.routes.length;
      }

      this.linkControllersToContexts(projectPath, controllers, contexts, sources, edges);

      const warnings = this.collectAnalysisWarnings();
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          framework: 'phoenix',
          language: 'elixir',
          routers_detected: routers.length,
          routes_detected: routeCount,
          controllers_detected: controllers.filter(c => c.kind === 'controller').length,
          liveviews_detected: controllers.filter(c => c.kind === 'liveview').length,
          contexts_detected: contexts.length,
          ecto_schemas_detected: schemas.length,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Phoenix analysis failed: ${(error as Error).message}`,
        'PHOENIX_ANALYSIS_ERROR'
      );
    }
  }



  private isRouterFile(content: string): boolean {
    return /\buse\s+Phoenix\.Router\b/.test(content) ||
      /\buse\s+\w+Web\s*,\s*:router\b/.test(content);
  }

  private extractRouter(filePath: string, content: string, lines: string[]): PhoenixRouter | null {
    const moduleMatch = content.match(/^\s*defmodule\s+([A-Z][\w.]*)\s+do\b/m);
    const module = moduleMatch ? moduleMatch[1] : path.basename(filePath, path.extname(filePath));

    const routes: PhoenixRoute[] = [];

    const scopePrefixStack: string[] = [];
    const pipelineStack: string[][] = [];

    const blockStack: Array<'scope' | 'pipeline-def' | 'other'> = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = this.stripComment(lines[i]).trim();
      if (!trimmed) continue;
      const lineNo = i + 1;

      if (/^end\b/.test(trimmed)) {
        const frame = blockStack.pop();
        if (frame === 'scope') {
          scopePrefixStack.pop();
          pipelineStack.pop();
        }
        continue;
      }


      const scopeMatch = trimmed.match(/^scope\s+("(?:[^"]*)"|[^\s,]+)?(.*)\bdo\b\s*$/);
      if (scopeMatch && /^scope\b/.test(trimmed)) {
        const rawPrefix = scopeMatch[1] ? scopeMatch[1].replace(/['"]/g, '') : '';
        const prefix = rawPrefix.startsWith('/') || rawPrefix === '' ? rawPrefix : `/${rawPrefix}`;
        scopePrefixStack.push(prefix);

        pipelineStack.push([...(pipelineStack[pipelineStack.length - 1] || [])]);
        blockStack.push('scope');
        continue;
      }


      if (/^pipeline\s+:\w+\s+do\b/.test(trimmed)) {
        blockStack.push('pipeline-def');
        continue;
      }


      const pipeMatch = trimmed.match(/^pipe_through\s+(.+)$/);
      if (pipeMatch && pipelineStack.length > 0) {
        const names = [...pipeMatch[1].matchAll(/:(\w+)/g)].map(m => m[1]);
        pipelineStack[pipelineStack.length - 1].push(...names);
        continue;
      }

      const prefix = scopePrefixStack.join('');
      const pipelines = pipelineStack[pipelineStack.length - 1] || [];


      const liveMatch = trimmed.match(/^live\s+("[^"]*"|'[^']*'|[^\s,]+)\s*,\s*([A-Z][\w.]*)(.*)$/);
      if (liveMatch) {
        routes.push({
          method: 'LIVE',
          routePath: this.joinPath(prefix, liveMatch[1].replace(/['"]/g, '')),
          controller: liveMatch[2].split('.').pop()!,
          kind: 'live',
          pipelines: [...pipelines],
          line: lineNo,
        });
        continue;
      }


      const resourcesMatch = trimmed.match(/^resources\s+("[^"]*"|'[^']*'|[^\s,]+)\s*,\s*([A-Z][\w.]*)(.*)$/);
      if (resourcesMatch) {
        routes.push({
          method: 'RESOURCES',
          routePath: this.joinPath(prefix, resourcesMatch[1].replace(/['"]/g, '')),
          controller: resourcesMatch[2].split('.').pop()!,
          kind: 'resources',
          pipelines: [...pipelines],
          line: lineNo,
        });

        if (/\bdo\s*$/.test(trimmed)) blockStack.push('other');
        continue;
      }


      const verbMatch = trimmed.match(
        /^(get|post|put|patch|delete|options|head)\s+("[^"]*"|'[^']*'|[^\s,]+)\s*,\s*([A-Z][\w.]*)\s*,\s*:(\w+)/
      );
      if (verbMatch && ROUTE_VERBS.has(verbMatch[1])) {
        routes.push({
          method: verbMatch[1].toUpperCase(),
          routePath: this.joinPath(prefix, verbMatch[2].replace(/['"]/g, '')),
          controller: verbMatch[3].split('.').pop()!,
          action: verbMatch[4],
          kind: 'verb',
          pipelines: [...pipelines],
          line: lineNo,
        });
        continue;
      }


      if (/\bdo\s*$/.test(trimmed) && !/,\s*do:/.test(trimmed)) {
        blockStack.push('other');
      }
    }

    return { module, filePath, routes };
  }

  private joinPath(prefix: string, routePath: string): string {
    const a = prefix.replace(/\/+$/, '');
    const b = routePath.startsWith('/') ? routePath : `/${routePath}`;
    const joined = `${a}${b}`.replace(/\/{2,}/g, '/');
    return joined === '' ? '/' : joined;
  }



  private extractControllers(filePath: string, content: string, lines: string[]): PhoenixController[] {
    const results: PhoenixController[] = [];

    const modules = this.findModules(lines);
    for (const mod of modules) {
      const body = lines.slice(mod.start - 1, mod.end).join('\n');
      const isController =
        /\buse\s+\w+Web\s*,\s*:controller\b/.test(body) ||
        /\buse\s+Phoenix\.Controller\b/.test(body);
      const isLiveView =
        /\buse\s+\w+Web\s*,\s*:live_view\b/.test(body) ||
        /\buse\s+Phoenix\.LiveView\b/.test(body);
      if (!isController && !isLiveView) continue;

      const actions: PhoenixActionFn[] = [];
      for (let i = mod.start - 1; i < mod.end && i < lines.length; i++) {
        const trimmed = this.stripComment(lines[i]).trim();


        const defMatch = trimmed.match(/^def\s+([a-z_][\w?!]*)\s*\(/);
        if (defMatch) {
          if (!actions.some(a => a.name === defMatch[1])) {
            actions.push({ name: defMatch[1], line: i + 1 });
          }
        }
      }

      results.push({
        module: mod.name,
        name: mod.name.split('.').pop()!,
        filePath,
        kind: isLiveView ? 'liveview' : 'controller',
        actions,
        lineEnd: mod.end,
      });
    }
    return results;
  }



  private extractSchemas(filePath: string, content: string, lines: string[]): EctoSchema[] {
    const results: EctoSchema[] = [];
    const modules = this.findModules(lines);
    for (const mod of modules) {
      const body = lines.slice(mod.start - 1, mod.end);
      const bodyText = body.join('\n');
      if (!/\buse\s+Ecto\.Schema\b/.test(bodyText)) continue;

      const tableMatch = bodyText.match(/\bschema\s+"([^"]+)"\s+do\b/);
      const table = tableMatch ? tableMatch[1] : this.tableizeFromModule(mod.name);

      const fields: EctoField[] = [];
      const associations: EctoAssociation[] = [];
      for (let i = mod.start - 1; i < mod.end && i < lines.length; i++) {
        const trimmed = this.stripComment(lines[i]).trim();

        const fieldMatch = trimmed.match(/^field\s+:(\w+)\s*,\s*:(\w+)/);
        if (fieldMatch) {
          fields.push({ name: fieldMatch[1], type: fieldMatch[2], line: i + 1 });
          continue;
        }

        const fieldNoType = trimmed.match(/^field\s+:(\w+)\s*$/);
        if (fieldNoType) {
          fields.push({ name: fieldNoType[1], type: 'string', line: i + 1 });
          continue;
        }

        const assocMatch = trimmed.match(/^(belongs_to|has_many|has_one|many_to_many)\s+:(\w+)\s*,\s*([A-Z][\w.]*)/);
        if (assocMatch) {
          associations.push({
            type: assocMatch[1] as EctoAssociation['type'],
            name: assocMatch[2],
            targetSchema: assocMatch[3].split('.').pop()!,
            line: i + 1,
          });
        }
      }

      results.push({
        module: mod.name,
        name: mod.name.split('.').pop()!,
        filePath,
        table,
        fields,
        associations,
        lineEnd: mod.end,
      });
    }
    return results;
  }





  private extractContext(
    projectPath: string,
    filePath: string,
    content: string,
    lines: string[]
  ): PhoenixContext | null {
    const normalized = filePath.replace(/\\/g, '/');

    if (!/(^|\/)lib\//.test(normalized)) return null;
    if (/(^|\/)lib\/[^/]*_web\//.test(normalized)) return null;

    if (
      /\buse\s+Ecto\.Schema\b/.test(content) ||
      /\buse\s+Phoenix\.Router\b/.test(content) ||
      /\buse\s+\w+Web\s*,\s*:(controller|router|live_view|live_component)\b/.test(content) ||
      /\buse\s+Phoenix\.(Controller|LiveView)\b/.test(content) ||
      /\buse\s+Application\b/.test(content)
    ) {
      return null;
    }

    const modules = this.findModules(lines);
    if (modules.length === 0) return null;

    const mod = modules[0];

    const publicFunctions: string[] = [];
    for (let i = mod.start - 1; i < mod.end && i < lines.length; i++) {
      const trimmed = this.stripComment(lines[i]).trim();
      const defMatch = trimmed.match(/^def\s+([a-z_][\w?!]*)/);
      if (defMatch && !publicFunctions.includes(defMatch[1])) {
        publicFunctions.push(defMatch[1]);
      }
    }

    if (publicFunctions.length === 0) return null;

    return {
      module: mod.name,
      name: mod.name.split('.').pop()!,
      filePath,
      publicFunctions,
      lineEnd: mod.end,
    };
  }



  private emitController(
    projectPath: string,
    ctrl: PhoenixController,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const controllerId = this.controllerId(ctrl);
    const nodeType = ctrl.kind === 'liveview' ? 'phoenix_liveview' : 'phoenix_controller';

    nodes.push(this.createNodeBuilder(controllerId, ctrl.name, nodeType)
      .withLevel(2, 'architectural')
      .withCategory(ctrl.kind === 'liveview' ? 'liveview' : 'controller',
        ctrl.kind === 'liveview' ? ['phoenix', 'liveview', 'web'] : ['phoenix', 'mvc', 'http'])
      .withSource({ file: ctrl.filePath, line: 1, end_line: ctrl.lineEnd })
      .withDescription(ctrl.kind === 'liveview'
        ? `Phoenix LiveView: ${ctrl.module}`
        : `Phoenix controller: ${ctrl.module}`)
      .withMetadata({
        framework: 'phoenix',
        language: 'elixir',
        attributes: {
          qualified_name: ctrl.module,
          kind: ctrl.kind,
          actions: ctrl.actions.map(a => a.name),
        },
      })
      .build());

    for (const action of ctrl.actions) {
      const actionId = this.actionId(ctrl, action.name);
      nodes.push(this.createNodeBuilder(actionId, action.name, ctrl.kind === 'liveview' ? 'liveview_callback' : 'controller_action')
        .withLevel(4, 'member')
        .withCategory('method', ['phoenix', ctrl.kind === 'liveview' ? 'callback' : 'action'])
        .withSource({ file: ctrl.filePath, line: action.line, end_line: action.line })
        .withDescription(`${ctrl.module}.${action.name}`)
        .withParent(controllerId)
        .withMetadata({ framework: 'phoenix', language: 'elixir' })
        .build());

      edges.push(this.createEdge(
        this.generateEdgeId(controllerId, actionId, 'contains'),
        controllerId, actionId, 'contains', 'structural'
      ));


      if (ctrl.kind === 'liveview' &&
          (action.name === 'mount' || action.name === 'handle_event' || action.name === 'handle_info' || action.name === 'handle_params')) {
        entryPoints.push(this.createEntryPoint(
          `entry_live_${actionId}`,
          actionId,
          action.name === 'mount' ? 'lifecycle' : 'event',
          `${ctrl.name}.${action.name}`,
          `Phoenix LiveView ${action.name} callback in ${ctrl.module}`,
          { event: action.name },
          undefined,
          { module: ctrl.module, callback: action.name, line: action.line, language: 'elixir' },
          { node_id: actionId, method_name: action.name, file: ctrl.filePath, line: action.line }
        ));
      }
    }
  }

  private emitSchema(
    projectPath: string,
    schema: EctoSchema,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[]
  ): void {
    const schemaId = this.schemaId(schema);

    nodes.push(this.createNodeBuilder(schemaId, schema.name, 'ecto_schema')
      .withLevel(2, 'architectural')
      .withCategory('model', ['phoenix', 'ecto', 'database', 'entity'])
      .withSource({ file: schema.filePath, line: 1, end_line: schema.lineEnd })
      .withDescription(`Ecto schema: ${schema.module} (table "${schema.table}")`)
      .withMetadata({
        framework: 'phoenix',
        language: 'elixir',
        attributes: {
          qualified_name: schema.module,
          table: schema.table,
          fields: schema.fields.map(f => ({ name: f.name, type: f.type })),
          associations: schema.associations.map(a => ({ type: a.type, name: a.name, target: a.targetSchema })),
          field_count: schema.fields.length,
          association_count: schema.associations.length,
        },
      })
      .build());

    for (const field of schema.fields) {
      const fieldId = this.generateId('field', schema.filePath, `${schema.name}_${field.name}`);
      nodes.push(this.createNodeBuilder(fieldId, field.name, 'field')
        .withLevel(4, 'member')
        .withCategory('field', ['phoenix', 'ecto', 'data'])
        .withSource({ file: schema.filePath, line: field.line, end_line: field.line })
        .withSignature({ parameters: [], return_type: field.type })
        .withParent(schemaId)
        .withMetadata({
          framework: 'phoenix',
          language: 'elixir',
          attributes: { table: schema.table, fieldType: field.type },
        })
        .build());

      edges.push(this.createEdge(
        this.generateEdgeId(schemaId, fieldId, 'has_field'),
        schemaId, fieldId, 'has_field', 'structural'
      ));
    }

    exitPoints.push(this.createExitPoint(
      `exit_db_${schemaId}`,
      schemaId,
      'database',
      `Ecto: ${schema.table}`,
      `Database access through Ecto schema ${schema.module}`,
      { resource: schema.table },
      { action: 'read_write' }
    ));
  }

  private linkSchemaAssociations(
    schemas: EctoSchema[],
    schemaByName: Map<string, EctoSchema>,
    edges: CASEdge[]
  ): void {
    for (const schema of schemas) {
      const schemaId = this.schemaId(schema);
      for (const assoc of schema.associations) {
        const target = schemaByName.get(assoc.targetSchema);
        if (!target) continue;
        const targetId = this.schemaId(target);
        const edgeType = assoc.type === 'belongs_to' ? 'ManyToOne'
          : assoc.type === 'has_one' ? 'OneToOne'
          : assoc.type === 'many_to_many' ? 'ManyToMany'
          : 'OneToMany';
        edges.push(this.createEdge(
          this.generateEdgeId(schemaId, targetId, `relates_to_${assoc.type}_${assoc.name}`),
          schemaId, targetId, 'relates_to', 'data',
          { association_type: assoc.type, association_name: assoc.name, relationship: edgeType }
        ));
      }
    }
  }

  private emitContext(projectPath: string, ctx: PhoenixContext, nodes: CASNode[]): void {
    const contextId = this.contextId(ctx);
    nodes.push(this.createNodeBuilder(contextId, ctx.name, 'phoenix_context')
      .withLevel(2, 'architectural')
      .withCategory('service', ['phoenix', 'context', 'domain'])
      .withSource({ file: ctx.filePath, line: 1, end_line: ctx.lineEnd })
      .withDescription(`Phoenix context (domain boundary): ${ctx.module}`)
      .withMetadata({
        framework: 'phoenix',
        language: 'elixir',
        attributes: {
          qualified_name: ctx.module,
          public_functions: ctx.publicFunctions,
          public_function_count: ctx.publicFunctions.length,
        },
      })
      .build());
  }

  private emitRouter(
    projectPath: string,
    router: PhoenixRouter,
    controllerByName: Map<string, PhoenixController>,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const routerId = this.generateId('router', router.filePath, router.module);

    nodes.push(this.createNodeBuilder(routerId, router.module.split('.').pop()!, 'phoenix_router')
      .withLevel(2, 'architectural')
      .withCategory('router', ['phoenix', 'http', 'routing'])
      .withSource({ file: router.filePath, line: 1, end_line: 1 })
      .withDescription(`Phoenix router: ${router.module}`)
      .withMetadata({
        framework: 'phoenix',
        language: 'elixir',
        attributes: { qualified_name: router.module, routes_count: router.routes.length },
      })
      .build());

    router.routes.forEach((route, index) => {
      const routeId = this.generateId('route', router.filePath, `${route.method}_${route.routePath}_${index}`);
      const controller = controllerByName.get(route.controller);
      const authenticated = route.pipelines.some(p => AUTH_PIPELINE.test(p));
      const label = `${route.method} ${route.routePath}`;
      const handlerDesc = route.action
        ? `${route.controller}#${route.action}`
        : route.controller;

      nodes.push(this.createNodeBuilder(routeId, label, 'phoenix_route')
        .withLevel(3, 'code')
        .withCategory('route', ['phoenix', 'http'])
        .withSource({ file: router.filePath, line: route.line, end_line: route.line })
        .withDescription(`Phoenix route: ${label} -> ${handlerDesc}`)
        .withMetadata({
          framework: 'phoenix',
          language: 'elixir',
          attributes: {
            method: route.method,
            path: route.routePath,
            controller: route.controller,
            action: route.action,
            kind: route.kind,
            pipelines: route.pipelines,
            authenticated,
          },
        })
        .build());

      const epType: CASEntryPoint['type'] = route.kind === 'live' ? 'page' : 'http';
      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        epType,
        label,
        `Phoenix ${route.kind === 'live' ? 'LiveView route' : 'HTTP endpoint'}: ${label} -> ${handlerDesc}`,
        { method: route.method === 'LIVE' || route.method === 'RESOURCES' ? undefined : route.method, path: route.routePath },
        {
          authenticated,
          guards: route.pipelines.filter(p => AUTH_PIPELINE.test(p)),
        },
        {
          controller: route.controller,
          action: route.action,
          pipelines: route.pipelines,
          kind: route.kind,
          language: 'elixir',
        },
        controller
          ? { node_id: this.controllerId(controller), method_name: route.action || 'mount', file: controller.filePath }
          : undefined
      ));

      edges.push(this.createEdge(
        this.generateEdgeId(routerId, routeId, 'defines_route'),
        routerId, routeId, 'defines_route', 'structural'
      ));

      if (controller) {
        const controllerId = this.controllerId(controller);
        edges.push(this.createEdge(
          this.generateEdgeId(routeId, controllerId, 'routes_to'),
          routeId, controllerId, 'routes_to', 'behavioral',
          { action: route.action, kind: route.kind }
        ));

        if (route.action) {
          const action = controller.actions.find(a => a.name === route.action);
          if (action) {
            const actionId = this.actionId(controller, action.name);
            edges.push(this.createEdge(
              this.generateEdgeId(routeId, actionId, 'invokes'),
              routeId, actionId, 'invokes', 'behavioral'
            ));
          }
        }
      }
    });
  }


  private linkControllersToContexts(
    projectPath: string,
    controllers: PhoenixController[],
    contexts: PhoenixContext[],
    sources: Array<{ file: string; content: string }>,
    edges: CASEdge[]
  ): void {
    if (contexts.length === 0) return;
    const contentByFile = new Map(sources.map(s => [s.file, s.content]));
    const contextByName = new Map<string, PhoenixContext>();
    for (const ctx of contexts) {
      contextByName.set(ctx.name, ctx);
      contextByName.set(ctx.module, ctx);
    }

    for (const ctrl of controllers) {
      const content = contentByFile.get(ctrl.filePath);
      if (!content) continue;
      const controllerId = this.controllerId(ctrl);
      const referenced = new Set<string>();

      for (const m of content.matchAll(/\b([A-Z][\w.]*)\.[a-z_]\w*\s*\(/g)) {
        const ref = m[1];
        const ctx = contextByName.get(ref) || contextByName.get(ref.split('.').pop()!);
        if (ctx && ctx.module !== ctrl.module && !referenced.has(ctx.module)) {
          referenced.add(ctx.module);
          edges.push(this.createEdge(
            this.generateEdgeId(controllerId, this.contextId(ctx), 'uses'),
            controllerId, this.contextId(ctx), 'uses', 'behavioral',
            { reason: 'context_api_call' }
          ));
        }
      }
    }
  }




  private findModules(lines: string[]): Array<{ name: string; start: number; end: number }> {
    const modules: Array<{ name: string; start: number; end: number }> = [];
    interface Frame { kind: 'module' | 'block'; idx?: number; }
    const stack: Frame[] = [];
    const nameStack: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = this.stripComment(lines[i]).trim();
      if (!trimmed) continue;

      const modMatch = trimmed.match(/^defmodule\s+([A-Z][\w.]*)\s+do\b/);
      if (modMatch) {
        const declared = modMatch[1];
        const qualified = nameStack.length ? `${nameStack[nameStack.length - 1]}.${declared}` : declared;
        nameStack.push(qualified);
        modules.push({ name: qualified, start: i + 1, end: lines.length });
        stack.push({ kind: 'module', idx: modules.length - 1 });
        continue;
      }

      const opens = this.countDoOpeners(trimmed);
      const closes = this.countEnds(trimmed);
      for (let o = 0; o < opens; o++) stack.push({ kind: 'block' });
      for (let c = 0; c < closes; c++) {
        const frame = stack.pop();
        if (frame?.kind === 'module' && frame.idx !== undefined) {
          modules[frame.idx].end = i + 1;
          nameStack.pop();
        }
      }
    }
    return modules;
  }

  private countDoOpeners(trimmed: string): number {
    let count = 0;
    if (/(^|\s)do\s*$/.test(trimmed) && !/,\s*do:/.test(trimmed)) count++;
    const fnOpeners = trimmed.match(/\bfn\b/g);
    if (fnOpeners) count += fnOpeners.length;
    return count;
  }

  private countEnds(trimmed: string): number {
    const m = trimmed.match(/\bend\b/g);
    return m ? m.length : 0;
  }

  private stripComment(line: string): string {
    let inDouble = false;
    let result = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i - 1] !== '\\') inDouble = !inDouble;
      if (ch === '#' && !inDouble) break;
      result += ch;
    }
    return result;
  }

  private tableizeFromModule(module: string): string {
    const base = module.split('.').pop()!;
    const underscored = base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    return underscored.endsWith('s') ? underscored : `${underscored}s`;
  }



  private controllerId(ctrl: PhoenixController): string {
    return this.generateId(ctrl.kind === 'liveview' ? 'liveview' : 'controller', ctrl.filePath, ctrl.module);
  }

  private actionId(ctrl: PhoenixController, action: string): string {
    return this.generateId('action', ctrl.filePath, `${ctrl.module}_${action}`);
  }

  private schemaId(schema: EctoSchema): string {
    return this.generateId('schema', schema.filePath, schema.module);
  }

  private contextId(ctx: PhoenixContext): string {
    return this.generateId('context', ctx.filePath, ctx.module);
  }
}

export default { PhoenixAnalyzer };
