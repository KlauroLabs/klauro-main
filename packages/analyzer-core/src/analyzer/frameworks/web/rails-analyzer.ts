import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';

interface RailsAssociation {
  type: 'has_many' | 'has_one' | 'belongs_to' | 'has_and_belongs_to_many';
  name: string;
  className: string;
  foreignKey?: string;
  line: number;
}

interface RailsModel {
  name: string;
  filePath: string;
  tableName: string;
  associations: RailsAssociation[];
  validations: number;
  scopes: string[];
  callbacks: string[];
  abstract: boolean;
  stiParent?: string;
}

interface RailsModelAccess {
  model: string;
  access: 'reads' | 'creates' | 'updates' | 'deletes';
}

interface RailsControllerAction {
  name: string;
  line: number;
  modelAccesses: RailsModelAccess[];
}

interface RailsBeforeAction {
  name: string;
  only: string[];
  except: string[];
  line: number;
}

interface RailsController {
  name: string;
  filePath: string;
  controllerPath: string;
  actions: RailsControllerAction[];
  beforeActions: RailsBeforeAction[];
}

interface RailsRoute {
  method: string;
  path: string;
  controller: string;
  action: string;
  source: 'resources' | 'resource' | 'verb' | 'root';
}

interface RailsMigration {
  name: string;
  filePath: string;
  table?: string;
  action: 'create' | 'modify' | 'drop';
  columns: Array<{ name: string; type: string }>;
}

interface RailsWorker {
  name: string;
  filePath: string;
  kind: 'job' | 'mailer';
  queue?: string;
  methods: string[];
  modelAccesses: RailsModelAccess[];
}

interface RailsTestSuite {
  name: string;
  filePath: string;
  framework: 'rspec' | 'minitest';
  subject?: string;
  examples: number;
}

const RESTFUL_ACTIONS: Array<{ action: string; method: string; suffix: string }> = [
  { action: 'index', method: 'GET', suffix: '' },
  { action: 'create', method: 'POST', suffix: '' },
  { action: 'new', method: 'GET', suffix: '/new' },
  { action: 'edit', method: 'GET', suffix: '/:id/edit' },
  { action: 'show', method: 'GET', suffix: '/:id' },
  { action: 'update', method: 'PATCH', suffix: '/:id' },
  { action: 'destroy', method: 'DELETE', suffix: '/:id' },
];

const AUTH_FILTER_PATTERN = /auth|require_|logged_in|signed_in|login|verify_|authorize/i;

const ROOT_DISCOVERY_IGNORES = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/tmp/**',
  '**/log/**',
  '**/.git/**'
];

export class RailsAnalyzer extends BaseAnalyzer {
  readonly discoversNestedRoots = true;

  constructor() {
    super(
      'rails',
      'Rails Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const gemfilePath = path.join(projectPath, 'Gemfile');
      if (await fs.pathExists(gemfilePath)) {
        const content = await fs.readFile(gemfilePath, 'utf-8');
        if (/^\s*gem\s+['"]rails['"]/m.test(content)) return true;
      }

      if (await fs.pathExists(path.join(projectPath, 'config', 'routes.rb'))) return true;
      if (await fs.pathExists(path.join(projectPath, 'app', 'models')) &&
          await fs.pathExists(path.join(projectPath, 'app', 'controllers'))) return true;
      if (await fs.pathExists(path.join(projectPath, 'bin', 'rails'))) return true;

      return (await this.discoverRailsRoots(projectPath)).length > 0;
    } catch {
      return false;
    }
  }

  async discoverRailsRoots(projectPath: string): Promise<string[]> {
    const markerFiles = await glob(
      [
        '**/config/routes.rb',
        '**/app/models/**/*.rb',
        '**/app/controllers/**/*.rb',
        '**/app/jobs/**/*.rb',
        '**/app/mailers/**/*.rb'
      ],
      { cwd: projectPath, nodir: true, ignore: ROOT_DISCOVERY_IGNORES }
    );

    const roots = new Set<string>();
    for (const marker of markerFiles) {
      const normalized = marker.replace(/\\/g, '/');
      const routesMatch = normalized.match(/^(?:(.*)\/)?config\/routes\.rb$/);
      if (routesMatch) {
        roots.add(routesMatch[1] || '');
        continue;
      }
      const appMatch = normalized.match(/^(?:(.*)\/)?app\/(?:models|controllers|jobs|mailers)\/.+\.rb$/);
      if (appMatch) roots.add(appMatch[1] || '');
    }

    return [...roots].sort();
  }

  private toProjectRelative(root: string, file: string): string {
    const normalized = file.replace(/\\/g, '/');
    return root ? `${root}/${normalized}` : normalized;
  }

  private owningRoot(file: string, roots: string[]): string {
    let owner = '';
    for (const root of roots) {
      if (!root) continue;
      if (file.startsWith(`${root}/`) && root.length > owner.length) owner = root;
    }
    return owner;
  }

  private async globRootFiles(
    projectPath: string,
    root: string,
    patterns: string | string[],
    roots: string[]
  ): Promise<string[]> {
    const absRoot = root ? path.join(projectPath, root) : projectPath;
    const matches = await glob(patterns, { cwd: absRoot, nodir: true });
    return matches
      .map(match => this.toProjectRelative(root, match))
      .filter(file => this.owningRoot(file, roots) === root)
      .sort();
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
      'mvc-pattern-analysis',
      'activerecord-model-mapping',
      'association-mapping',
      'route-detection',
      'restful-resource-expansion',
      'before-action-security-analysis',
      'migration-parsing',
      'job-queue-analysis',
      'mailer-analysis',
      'test-suite-detection'
    ];
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const projectPath = context.projectPath;
      const roots = await this.discoverRailsRoots(projectPath);
      if (roots.length === 0) roots.push('');

      const allModels: RailsModel[] = [];
      const allControllers: RailsController[] = [];
      const allWorkers: RailsWorker[] = [];
      const allTestSuites: RailsTestSuite[] = [];
      const allMigrations: RailsMigration[] = [];
      let routesDetected = 0;

      for (const root of roots) {
        await this.analyzeApplication(projectPath, root, nodes);
        const models = await this.analyzeModels(projectPath, root, roots, nodes, exitPoints);
        const controllers = await this.analyzeControllers(projectPath, root, roots, nodes, edges);
        const routes = await this.analyzeRoutes(projectPath, root, controllers, nodes, edges, entryPoints);
        const migrations = await this.analyzeMigrations(projectPath, root, roots, nodes);
        const workers = await this.analyzeWorkers(projectPath, root, roots, nodes, entryPoints, exitPoints);
        const testSuites = await this.analyzeTestSuites(projectPath, root, roots, nodes);

        allModels.push(...models);
        allControllers.push(...controllers);
        allWorkers.push(...workers);
        allTestSuites.push(...testSuites);
        allMigrations.push(...migrations);
        routesDetected += routes.length;
      }

      await this.analyzeModelFields(projectPath, roots, allModels, allMigrations, nodes, edges);
      this.linkModelAssociations(allModels, edges);
      this.linkControllersToModels(allControllers, allModels, nodes, edges);
      this.linkModelAccesses(allControllers, allWorkers, allModels, edges);
      this.linkTestSuites(allTestSuites, allModels, allControllers, edges);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          rails_version: await this.detectRailsVersion(projectPath),
          rails_roots: roots.map(root => root || '.'),
          models_detected: allModels.length,
          controllers_detected: allControllers.length,
          routes_detected: routesDetected,
          migrations_detected: allMigrations.length,
          jobs_detected: allWorkers.filter(worker => worker.kind === 'job').length,
          mailers_detected: allWorkers.filter(worker => worker.kind === 'mailer').length,
          test_suites_detected: allTestSuites.length
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `Rails analysis failed: ${(error as Error).message}`,
        'RAILS_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeApplication(projectPath: string, root: string, nodes: CASNode[]): Promise<void> {
    const absRoot = root ? path.join(projectPath, root) : projectPath;

    let marker: string | undefined;
    if (await fs.pathExists(path.join(absRoot, 'Gemfile'))) {
      marker = 'Gemfile';
    } else {
      const gemspecs = await glob('*.gemspec', { cwd: absRoot, nodir: true });
      if (gemspecs.length > 0) {
        marker = gemspecs.sort()[0];
      } else if (await fs.pathExists(path.join(absRoot, 'config', 'routes.rb'))) {
        marker = 'config/routes.rb';
      }
    }
    if (!marker) return;

    const appName = root ? path.basename(root) : path.basename(projectPath);
    const markerRelative = this.toProjectRelative(root, marker);
    const appId = this.generateId('app', markerRelative, appName);
    const railsVersion = await this.detectRailsVersion(absRoot) || (root ? await this.detectRailsVersion(projectPath) : undefined);
    nodes.push(this.createNodeBuilder(appId, appName, 'rails_app')
      .withLevel(1, 'system')
      .withCategory('backend', ['rails', 'ruby', 'application'])
      .withSource({ file: path.join(projectPath, markerRelative), line: 1, end_line: 1 })
      .withDescription(root ? `Rails engine or application: ${appName}` : `Rails application: ${appName}`)
      .withMetadata({
        framework: 'rails',
        attributes: {
          rails_version: railsVersion,
          ...(root ? { root } : {})
        }
      })
      .build());
  }

  private async analyzeModels(
    projectPath: string,
    root: string,
    roots: string[],
    nodes: CASNode[],
    exitPoints: CASExitPoint[]
  ): Promise<RailsModel[]> {
    const modelFiles = await this.globRootFiles(projectPath, root, 'app/models/**/*.rb', roots);
    const sources: Array<{ file: string; content: string }> = [];
    for (const file of modelFiles) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      sources.push({ file, content });
    }

    const models = this.extractModels(sources);
    const contentByFile = new Map(sources.map(source => [source.file, source.content]));

    for (const model of models) {
      const fullPath = path.join(projectPath, model.filePath);
      const content = contentByFile.get(model.filePath) || '';
      const modelId = this.modelNodeId(model);
      nodes.push(this.createNodeBuilder(modelId, model.name, 'rails_model')
        .withLevel(2, 'architectural')
        .withCategory('model', model.abstract
          ? ['rails', 'activerecord', 'database', 'abstract']
          : ['rails', 'activerecord', 'database', 'entity'])
        .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
        .withDescription(`Rails ActiveRecord model: ${model.name}`)
        .withMetadata({
          framework: 'rails',
          attributes: {
            table: model.tableName,
            associations_count: model.associations.length,
            validations_count: model.validations,
            scopes: model.scopes,
            callbacks: model.callbacks,
            abstract: model.abstract,
            ...(model.stiParent ? { sti_parent: model.stiParent } : {})
          }
        })
        .build());

      exitPoints.push(this.createExitPoint(
        `exit_db_${modelId}`,
        modelId,
        'database',
        `ActiveRecord: ${model.tableName}`,
        `Database access through ActiveRecord model ${model.name}`,
        { resource: model.tableName },
        { action: 'read_write' }
      ));
    }

    return models;
  }

  private linkModelAssociations(models: RailsModel[], edges: CASEdge[]): void {
    for (const model of models) {
      const modelId = this.modelNodeId(model);
      for (const association of model.associations) {
        const related = models.find(candidate => candidate.name === association.className);
        if (!related) continue;
        const relatedId = this.modelNodeId(related);
        // Cardinality for the database_schema relation graph: has_many -> 1:N,
        // belongs_to -> N:1, has_one -> 1:1, HABTM -> N:M.
        const relationType = association.type === 'has_many' ? 'OneToMany' :
          association.type === 'belongs_to' ? 'ManyToOne' :
          association.type === 'has_and_belongs_to_many' ? 'ManyToMany' : 'OneToOne';
        edges.push(this.createEdge(
          this.generateEdgeId(modelId, relatedId, `relates_to_${association.type}_${association.name}`),
          modelId,
          relatedId,
          'relates_to',
          'data',
          {
            association_type: association.type,
            association_name: association.name,
            foreign_key: association.foreignKey,
            attributes: { relationType, field: association.name }
          }
        ));
      }
    }
  }

  private modelNodeId(model: RailsModel): string {
    return this.generateId('model', model.filePath, model.name);
  }

  extractModels(sources: Array<{ file: string; content: string }>): RailsModel[] {
    const models: RailsModel[] = [];
    const pending: Array<{ file: string; content: string; name: string; parentRef: string }> = [];

    for (const source of sources) {
      const baseModel = this.extractModel(source.content, source.file);
      if (baseModel) {
        models.push(baseModel);
        continue;
      }
      const classMatch = source.content.match(/^\s*class\s+([A-Z][\w:]*)\s*<\s*(?:::)?([A-Z][\w:]*(?:\.base_class)?)/m);
      if (classMatch) {
        pending.push({
          file: source.file,
          content: source.content,
          name: classMatch[1].split('::').pop()!,
          parentRef: classMatch[2]
        });
      }
    }

    const sourcePathKeys = new Set(sources.map(source => this.modelPathKey(source.file)));

    let resolvedSubclass = true;
    while (resolvedSubclass && pending.length > 0) {
      resolvedSubclass = false;
      const modelIndex = new Map(models.map(model => [this.modelPathKey(model.filePath), model]));
      for (let index = pending.length - 1; index >= 0; index--) {
        const candidate = pending[index];
        const resolution = this.resolveParentModel(candidate.file, candidate.parentRef, modelIndex, sourcePathKeys);
        const parent = resolution.parent;
        if (!parent) continue;
        const model = this.buildModel(candidate.content, candidate.file, candidate.name);
        if (!parent.abstract) {
          const tableOverride = candidate.content.match(/self\.table_name\s*=\s*['"](\w+)['"]/);
          model.tableName = tableOverride ? tableOverride[1] : parent.tableName;
          model.stiParent = parent.name;
        }
        models.push(model);
        pending.splice(index, 1);
        resolvedSubclass = true;
      }
    }

    return models;
  }

  private modelPathKey(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\.rb$/, '');
  }

  private parentRefPath(parentRef: string): string {
    const normalized = parentRef.endsWith('.base_class')
      ? parentRef.replace(/\.base_class$/, '::Base')
      : parentRef;
    return normalized
      .replace(/^::/, '')
      .split('::')
      .map(segment => segment
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase())
      .join('/');
  }

  private resolveParentModel(
    candidateFile: string,
    parentRef: string,
    modelsByPathKey: Map<string, RailsModel>,
    sourcePathKeys: Set<string>
  ): { parent?: RailsModel; shadowed?: boolean } {
    const refPath = this.parentRefPath(parentRef);
    const segments = this.modelPathKey(candidateFile).split('/');
    segments.pop();

    for (;;) {
      const prefix = segments.join('/');
      const candidatePath = prefix ? `${prefix}/${refPath}` : refPath;
      const parent = modelsByPathKey.get(candidatePath);
      if (parent) return { parent };
      if (sourcePathKeys.has(candidatePath)) return { shadowed: true };
      if (segments.length === 0) break;
      segments.pop();
    }

    if (refPath.includes('/')) {
      const suffix = `/${refPath}`;
      const matches = [...modelsByPathKey.entries()].filter(([key]) => key.endsWith(suffix));
      if (matches.length === 1) return { parent: matches[0][1] };
    }
    return {};
  }

  extractModel(content: string, filePath: string): RailsModel | null {
    const classMatch = content.match(/^\s*class\s+([A-Z][\w:]*)\s*<\s*(?:::)?(ApplicationRecord|ActiveRecord::Base)\b/m);
    if (!classMatch) return null;
    return this.buildModel(content, filePath, classMatch[1].split('::').pop()!);
  }

  private buildModel(content: string, filePath: string, name: string): RailsModel {
    const tableNameMatch = content.match(/self\.table_name\s*=\s*['"](\w+)['"]/);
    const associations: RailsAssociation[] = [];
    const lines = content.split('\n');

    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(/^\s*(has_many|has_one|belongs_to|has_and_belongs_to_many)\s+:(\w+)(.*)$/);
      if (!match) continue;
      const type = match[1] as RailsAssociation['type'];
      const associationName = match[2];
      const options = match[3] || '';
      const classNameMatch = options.match(/class_name:\s*['"]([\w:]+)['"]/);
      const foreignKeyMatch = options.match(/foreign_key:\s*['"]?(\w+)['"]?/);
      associations.push({
        type,
        name: associationName,
        className: classNameMatch ? classNameMatch[1].split('::').pop()! : this.classify(associationName, type),
        foreignKey: foreignKeyMatch ? foreignKeyMatch[1] : undefined,
        line: index + 1
      });
    }

    const validations = (content.match(/^\s*validates?\s+/gm) || []).length;
    const scopes = [...content.matchAll(/^\s*scope\s+:(\w+)/gm)].map(match => match[1]);
    const callbacks = [...content.matchAll(/^\s*(before_save|after_save|before_create|after_create|before_update|after_update|before_destroy|after_destroy|after_commit|before_validation|after_validation)\b/gm)]
      .map(match => match[1]);

    return {
      name,
      filePath,
      tableName: tableNameMatch ? tableNameMatch[1] : this.tableize(name),
      associations,
      validations,
      scopes,
      callbacks,
      abstract: /self\.abstract_class\s*=\s*true/.test(content)
    };
  }

  private async analyzeControllers(
    projectPath: string,
    root: string,
    roots: string[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<RailsController[]> {
    const controllers: RailsController[] = [];
    const controllerFiles = await this.globRootFiles(projectPath, root, 'app/controllers/**/*.rb', roots);

    for (const file of controllerFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const controller = this.extractController(content, file);
      if (!controller) continue;
      controllers.push(controller);

      const controllerId = this.controllerNodeId(controller);
      nodes.push(this.createNodeBuilder(controllerId, controller.name, 'rails_controller')
        .withLevel(2, 'architectural')
        .withCategory('controller', ['rails', 'mvc', 'http'])
        .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
        .withDescription(`Rails controller: ${controller.name}`)
        .withMetadata({
          framework: 'rails',
          attributes: {
            controller_path: controller.controllerPath,
            actions_count: controller.actions.length,
            before_actions: controller.beforeActions.map(filter => filter.name)
          }
        })
        .build());

      for (const action of controller.actions) {
        const actionId = this.actionNodeId(controller, action.name);
        nodes.push(this.createNodeBuilder(actionId, action.name, 'controller_method')
          .withLevel(4, 'member')
          .withCategory('method', ['rails', 'action'])
          .withSource({ file: fullPath, line: action.line, end_line: action.line })
          .withDescription(`Controller action in ${controller.name}: ${action.name}`)
          .withParent(controllerId)
          .withMetadata({ framework: 'rails' })
          .build());
        edges.push(this.createEdge(
          this.generateEdgeId(controllerId, actionId, 'contains'),
          controllerId,
          actionId,
          'contains',
          'structural'
        ));
      }

      for (const filter of controller.beforeActions) {
        if (!AUTH_FILTER_PATTERN.test(filter.name)) continue;
        const filterId = this.generateId('middleware', controller.filePath, `${controller.name}_${filter.name}`);
        nodes.push(this.createNodeBuilder(filterId, filter.name, 'middleware')
          .withLevel(3, 'code')
          .withCategory('security', ['rails', 'before_action', 'auth'])
          .withSource({ file: fullPath, line: filter.line, end_line: filter.line })
          .withDescription(`Rails before_action auth filter on ${controller.name}: ${filter.name}`)
          .withMetadata({
            framework: 'rails',
            attributes: {
              filter_type: 'before_action',
              only: filter.only,
              except: filter.except
            }
          })
          .build());
        edges.push(this.createEdge(
          this.generateEdgeId(controllerId, filterId, 'guarded_by'),
          controllerId,
          filterId,
          'guarded_by',
          'security',
          { filter: 'before_action' }
        ));
      }
    }

    return controllers;
  }

  private controllerNodeId(controller: RailsController): string {
    return this.generateId('controller', controller.filePath, controller.name);
  }

  private actionNodeId(controller: RailsController, action: string): string {
    return this.generateId('method', controller.filePath, `${controller.name}_${action}`);
  }

  extractController(content: string, filePath: string): RailsController | null {
    const classMatch = content.match(/^\s*class\s+((?:[A-Z]\w*::)*\w+Controller)\s*<\s*[\w:.]+/m);
    if (!classMatch) return null;

    const name = classMatch[1].split('::').pop()!;
    const lines = content.split('\n');
    const actions: RailsControllerAction[] = [];
    const beforeActions: RailsBeforeAction[] = [];
    const defLines: number[] = [];
    let visibility: 'public' | 'private' | 'protected' = 'public';

    for (let index = 0; index < lines.length; index++) {
      const trimmed = lines[index].trim();

      if (/^(private|protected)\s*$/.test(trimmed)) {
        visibility = trimmed as 'private' | 'protected';
        continue;
      }
      if (/^public\s*$/.test(trimmed)) {
        visibility = 'public';
        continue;
      }

      const beforeActionMatch = trimmed.match(/^(before_action|before_filter)\s+:(\w+[?!]?)(.*)$/);
      if (beforeActionMatch) {
        const options = beforeActionMatch[3] || '';
        beforeActions.push({
          name: beforeActionMatch[2],
          only: this.extractSymbolList(options, 'only'),
          except: this.extractSymbolList(options, 'except'),
          line: index + 1
        });
        continue;
      }

      const defMatch = trimmed.match(/^def\s+(\w+[?!]?)/);
      if (defMatch) {
        defLines.push(index + 1);
        if (visibility === 'public') {
          actions.push({ name: defMatch[1], line: index + 1, modelAccesses: [] });
        }
      }
    }

    for (const action of actions) {
      const nextDefLine = defLines.find(line => line > action.line);
      const body = lines.slice(action.line - 1, nextDefLine ? nextDefLine - 1 : lines.length).join('\n');
      action.modelAccesses = this.extractModelAccesses(body);
    }

    return {
      name,
      filePath,
      controllerPath: this.controllerPathFor(name, filePath),
      actions,
      beforeActions
    };
  }

  private extractSymbolList(options: string, key: string): string[] {
    const arrayMatch = options.match(new RegExp(`${key}:\\s*(?:%i\\[([^\\]]*)\\]|\\[([^\\]]*)\\]|:(\\w+))`));
    if (!arrayMatch) return [];
    if (arrayMatch[1] !== undefined) return arrayMatch[1].split(/\s+/).filter(Boolean);
    if (arrayMatch[2] !== undefined) return (arrayMatch[2].match(/:(\w+)/g) || []).map(symbol => symbol.slice(1));
    return [arrayMatch[3]];
  }

  private controllerPathFor(name: string, filePath: string): string {
    const withoutSuffix = name.replace(/Controller$/, '');
    const underscored = this.underscore(withoutSuffix);
    const directory = path.dirname(filePath).replace(/\\/g, '/');
    const namespaceMatch = directory.match(/app\/controllers\/(.+)$/);
    return namespaceMatch ? `${namespaceMatch[1]}/${underscored}` : underscored;
  }

  private async analyzeRoutes(
    projectPath: string,
    root: string,
    controllers: RailsController[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<RailsRoute[]> {
    const routesRelative = this.toProjectRelative(root, 'config/routes.rb');
    const routesPath = path.join(projectPath, routesRelative);
    if (!await fs.pathExists(routesPath)) return [];

    const content = await fs.readFile(routesPath, 'utf-8');
    const routes = this.extractRoutes(content);

    routes.forEach((route, index) => {
      const routeId = this.generateId('route', routesRelative, `${route.method}_${route.path}_${index}`);
      const controller = controllers.find(candidate => candidate.controllerPath === route.controller)
        || controllers.find(candidate => candidate.controllerPath.endsWith(`/${route.controller}`));
      const handlerNodeId = controller ? this.actionNodeId(controller, route.action) : '';
      const authenticated = controller
        ? controller.beforeActions.some(filter =>
          AUTH_FILTER_PATTERN.test(filter.name) &&
          (filter.only.length === 0 || filter.only.includes(route.action)) &&
          !filter.except.includes(route.action))
        : false;

      nodes.push(this.createNodeBuilder(routeId, `${route.method} ${route.path}`, 'rails_route')
        .withLevel(3, 'code')
        .withCategory('route', ['rails', 'http'])
        .withSource({ file: routesPath, line: 1, end_line: 1 })
        .withDescription(`Rails route: ${route.method} ${route.path} -> ${route.controller}#${route.action}`)
        .withMetadata({
          framework: 'rails',
          attributes: {
            method: route.method,
            path: route.path,
            controller: route.controller,
            action: route.action,
            source: route.source
          }
        })
        .build());

      entryPoints.push(this.createEntryPoint(
        `entry_${routeId}`,
        routeId,
        'http',
        `${route.method} ${route.path}`,
        `Rails HTTP endpoint: ${route.method} ${route.path} -> ${route.controller}#${route.action}`,
        {
          method: route.method,
          path: route.path
        },
        {
          authenticated,
          guards: authenticated && controller
            ? controller.beforeActions.filter(filter => AUTH_FILTER_PATTERN.test(filter.name)).map(filter => filter.name)
            : []
        },
        {
          controller: route.controller,
          action: route.action
        },
        {
          node_id: handlerNodeId,
          method_name: route.action,
          file: controller ? controller.filePath : undefined
        }
      ));

      if (controller) {
        edges.push(this.createEdge(
          this.generateEdgeId(routeId, this.controllerNodeId(controller), 'routes_to'),
          routeId,
          this.controllerNodeId(controller),
          'routes_to',
          'behavioral',
          { action: route.action }
        ));
      }
    });

    return routes;
  }

  extractRoutes(content: string): RailsRoute[] {
    const routes: RailsRoute[] = [];
    const lines = content.split('\n');
    const namespaceStack: string[] = [];
    const blockStack: Array<'namespace' | 'other'> = [];

    for (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      if (/^end\b/.test(trimmed)) {
        const popped = blockStack.pop();
        if (popped === 'namespace') namespaceStack.pop();
        continue;
      }

      const namespaceMatch = trimmed.match(/^namespace\s+:(\w+)\s+do\b/);
      if (namespaceMatch) {
        namespaceStack.push(namespaceMatch[1]);
        blockStack.push('namespace');
        continue;
      }

      const prefix = namespaceStack.length ? `/${namespaceStack.join('/')}` : '';
      const controllerPrefix = namespaceStack.length ? `${namespaceStack.join('/')}/` : '';

      const resourcesMatch = trimmed.match(/^resources\s+:(\w+)(.*)$/);
      if (resourcesMatch) {
        const resource = resourcesMatch[1];
        const options = resourcesMatch[2] || '';
        const only = this.extractRouteSymbolList(options, 'only');
        const except = this.extractRouteSymbolList(options, 'except');
        for (const restful of RESTFUL_ACTIONS) {
          if (only.length > 0 && !only.includes(restful.action)) continue;
          if (except.includes(restful.action)) continue;
          routes.push({
            method: restful.method,
            path: `${prefix}/${resource}${restful.suffix}`,
            controller: `${controllerPrefix}${resource}`,
            action: restful.action,
            source: 'resources'
          });
          if (restful.action === 'update') {
            routes.push({
              method: 'PUT',
              path: `${prefix}/${resource}${restful.suffix}`,
              controller: `${controllerPrefix}${resource}`,
              action: restful.action,
              source: 'resources'
            });
          }
        }
        if (TRAILING_DO.test(trimmed)) blockStack.push('other');
        continue;
      }

      const singularResourceMatch = trimmed.match(/^resource\s+:(\w+)(.*)$/);
      if (singularResourceMatch) {
        const resource = singularResourceMatch[1];
        const controllerName = `${controllerPrefix}${this.pluralize(resource)}`;
        const singularActions = [
          { action: 'show', method: 'GET', suffix: '' },
          { action: 'create', method: 'POST', suffix: '' },
          { action: 'new', method: 'GET', suffix: '/new' },
          { action: 'edit', method: 'GET', suffix: '/edit' },
          { action: 'update', method: 'PATCH', suffix: '' },
          { action: 'destroy', method: 'DELETE', suffix: '' },
        ];
        const only = this.extractRouteSymbolList(singularResourceMatch[2] || '', 'only');
        const except = this.extractRouteSymbolList(singularResourceMatch[2] || '', 'except');
        for (const item of singularActions) {
          if (only.length > 0 && !only.includes(item.action)) continue;
          if (except.includes(item.action)) continue;
          routes.push({
            method: item.method,
            path: `${prefix}/${resource}${item.suffix}`,
            controller: controllerName,
            action: item.action,
            source: 'resource'
          });
        }
        if (TRAILING_DO.test(trimmed)) blockStack.push('other');
        continue;
      }

      const rootMatch = trimmed.match(/^root\s+(?:to:\s*)?['"]([\w\/]+)#(\w+)['"]/);
      if (rootMatch) {
        routes.push({
          method: 'GET',
          path: prefix || '/',
          controller: `${controllerPrefix}${rootMatch[1]}`,
          action: rootMatch[2],
          source: 'root'
        });
        continue;
      }

      const verbMatch = trimmed.match(/^(get|post|put|patch|delete)\s+['"]([^'"]+)['"]\s*(?:,\s*to:\s*|\s*=>\s*)['"]([\w\/]+)#(\w+)['"]/);
      if (verbMatch) {
        const routePath = verbMatch[2].startsWith('/') ? verbMatch[2] : `/${verbMatch[2]}`;
        routes.push({
          method: verbMatch[1].toUpperCase(),
          path: `${prefix}${routePath}`,
          controller: `${controllerPrefix}${verbMatch[3]}`,
          action: verbMatch[4],
          source: 'verb'
        });
        continue;
      }

      if (TRAILING_DO.test(trimmed)) blockStack.push('other');
    }

    return routes;
  }

  private extractRouteSymbolList(options: string, key: string): string[] {
    const match = options.match(new RegExp(`${key}:\\s*(?:%i\\[([^\\]]*)\\]|\\[([^\\]]*)\\])`));
    if (!match) return [];
    if (match[1] !== undefined) return match[1].split(/\s+/).filter(Boolean);
    return (match[2].match(/:(\w+)/g) || []).map(symbol => symbol.slice(1));
  }

  private async analyzeMigrations(
    projectPath: string,
    root: string,
    roots: string[],
    nodes: CASNode[]
  ): Promise<RailsMigration[]> {
    const migrations: RailsMigration[] = [];
    const migrationFiles = await this.globRootFiles(projectPath, root, 'db/migrate/*.rb', roots);

    for (const file of migrationFiles) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const migration = this.extractMigration(content, file);
      if (!migration) continue;
      migrations.push(migration);

      const migrationId = this.generateId('migration', file, migration.name);
      nodes.push(this.createNodeBuilder(migrationId, migration.name, 'rails_migration')
        .withLevel(3, 'code')
        .withCategory('migration', ['rails', 'database', 'schema'])
        .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
        .withDescription(`Rails migration: ${migration.name}`)
        .withMetadata({
          framework: 'rails',
          attributes: {
            table: migration.table,
            action: migration.action,
            columns: migration.columns
          }
        })
        .build());
    }

    return migrations;
  }

  extractMigration(content: string, filePath: string): RailsMigration | null {
    const classMatch = content.match(/^\s*class\s+(\w+)\s*<\s*ActiveRecord::Migration/m);
    if (!classMatch) return null;

    const createMatch = content.match(/create_table\s+:(\w+)/);
    const dropMatch = content.match(/drop_table\s+:(\w+)/);
    const modifyMatch = content.match(/(?:add_column|remove_column|change_column|add_index|add_reference)\s+:(\w+)/);

    const columns: Array<{ name: string; type: string }> = [];
    for (const match of content.matchAll(/^\s*t\.(\w+)\s+:(\w+)/gm)) {
      if (match[1] === 'timestamps' || match[1] === 'index' || match[1] === 'references' || match[1] === 'belongs_to') continue;
      columns.push({ name: match[2], type: match[1] });
    }
    for (const match of content.matchAll(/^\s*t\.references\s+:(\w+)/gm)) {
      columns.push({ name: `${match[1]}_id`, type: 'references' });
    }

    return {
      name: classMatch[1],
      filePath,
      table: createMatch?.[1] || dropMatch?.[1] || modifyMatch?.[1],
      action: createMatch ? 'create' : dropMatch ? 'drop' : 'modify',
      columns
    };
  }

  private async analyzeModelFields(
    projectPath: string,
    roots: string[],
    models: RailsModel[],
    migrations: RailsMigration[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<void> {
    const columnsByTable = await this.collectSchemaColumns(projectPath, roots);

    for (const migration of migrations) {
      if (migration.action === 'drop') continue;
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, migration.filePath), 'utf-8');
      } catch {
        continue;
      }
      for (const [table, columns] of this.parseMigrationColumns(content)) {
        if (!columnsByTable.has(table)) columnsByTable.set(table, new Map());
        const tableColumns = columnsByTable.get(table)!;
        for (const [columnName, columnType] of columns) {
          if (!tableColumns.has(columnName)) tableColumns.set(columnName, columnType);
        }
      }
    }

    for (const model of models) {
      const tableColumns = columnsByTable.get(model.tableName)
        || this.findNamespacePrefixedTable(columnsByTable, model);
      if (!tableColumns || tableColumns.size === 0) continue;
      const modelId = this.modelNodeId(model);
      const modelFile = path.join(projectPath, model.filePath);

      for (const [columnName, columnType] of tableColumns) {
        const fieldId = this.generateId('field', model.filePath, `${model.name}_${columnName}`);
        nodes.push(this.createNodeBuilder(fieldId, columnName, 'field')
          .withLevel(4, 'member')
          .withCategory('field', ['rails', 'data'])
          .withSource({ file: modelFile, line: 1, end_line: 1 })
          .withSignature({ parameters: [], return_type: columnType })
          .withParent(modelId)
          .withMetadata({
            framework: 'rails',
            attributes: {
              table: model.tableName,
              fieldType: columnType,
              sensitive: this.isSensitiveModelField(columnName, columnType)
            }
          })
          .build());

        edges.push(this.createEdge(
          this.generateEdgeId(modelId, fieldId, 'has_field'),
          modelId,
          fieldId,
          'has_field',
          'structural'
        ));
      }
    }
  }

  parseMigrationColumns(content: string): Map<string, Map<string, string>> {
    const tables = new Map<string, Map<string, string>>();
    const ensureTable = (table: string): Map<string, string> => {
      if (!tables.has(table)) tables.set(table, new Map());
      return tables.get(table)!;
    };

    let currentTable: Map<string, string> | undefined;
    for (const raw of content.split('\n')) {
      const line = raw.trim();

      const blockMatch = line.match(/^(?:create_table|change_table)\s+(?::(\w+)|["'](\w+)["'])/);
      if (blockMatch) {
        currentTable = ensureTable(blockMatch[1] || blockMatch[2]);
        continue;
      }
      if (/^end\b/.test(line)) {
        currentTable = undefined;
        continue;
      }

      const addColumnMatch = line.match(/^add_column\s+(?::(\w+)|["'](\w+)["'])\s*,\s*:(\w+)\s*,\s*:(\w+)/);
      if (addColumnMatch) {
        const columns = ensureTable(addColumnMatch[1] || addColumnMatch[2]);
        if (!columns.has(addColumnMatch[3])) columns.set(addColumnMatch[3], addColumnMatch[4]);
        continue;
      }

      const addReferenceMatch = line.match(/^add_reference\s+(?::(\w+)|["'](\w+)["'])\s*,\s*:(\w+)/);
      if (addReferenceMatch) {
        const columns = ensureTable(addReferenceMatch[1] || addReferenceMatch[2]);
        const columnName = `${addReferenceMatch[3]}_id`;
        if (!columns.has(columnName)) columns.set(columnName, 'references');
        continue;
      }

      if (!currentTable) continue;

      const referencesMatch = line.match(/^t\.(?:references|belongs_to)\s+(?::(\w+)|["'](\w+)["'])/);
      if (referencesMatch) {
        const columnName = `${referencesMatch[1] || referencesMatch[2]}_id`;
        if (!currentTable.has(columnName)) currentTable.set(columnName, 'references');
        continue;
      }

      const columnMatch = line.match(/^t\.(\w+)\s+(?::(\w+)|["'](\w+)["'])/);
      if (!columnMatch) continue;
      if (columnMatch[1] === 'timestamps' || columnMatch[1] === 'index') continue;
      const columnName = columnMatch[2] || columnMatch[3];
      if (!currentTable.has(columnName)) currentTable.set(columnName, columnMatch[1]);
    }

    return tables;
  }

  private findNamespacePrefixedTable(
    columnsByTable: Map<string, Map<string, string>>,
    model: RailsModel
  ): Map<string, string> | undefined {
    const directory = path.dirname(model.filePath).replace(/\\/g, '/');
    const namespaceMatch = directory.match(/app\/models\/(.+)$/);
    if (namespaceMatch) {
      const namespacePrefix = namespaceMatch[1].split('/').join('_');
      const namespaced = columnsByTable.get(`${namespacePrefix}_${model.tableName}`);
      if (namespaced) return namespaced;
    }

    const candidates = [...columnsByTable.keys()].filter(table => table.endsWith(`_${model.tableName}`));
    return candidates.length === 1 ? columnsByTable.get(candidates[0]) : undefined;
  }

  private async collectSchemaColumns(projectPath: string, roots: string[]): Promise<Map<string, Map<string, string>>> {
    const columnsByTable = new Map<string, Map<string, string>>();

    for (const root of roots) {
      const schemaPath = path.join(projectPath, this.toProjectRelative(root, 'db/schema.rb'));
      if (!await fs.pathExists(schemaPath)) continue;

      const content = await fs.readFile(schemaPath, 'utf-8');
      let currentTable: Map<string, string> | undefined;

      for (const raw of content.split('\n')) {
        const line = raw.trim();
        const tableMatch = line.match(/^create_table\s+"(\w+)"/);
        if (tableMatch) {
          currentTable = columnsByTable.get(tableMatch[1]) || new Map();
          columnsByTable.set(tableMatch[1], currentTable);
          continue;
        }
        if (!currentTable) continue;
        if (/^end\b/.test(line)) {
          currentTable = undefined;
          continue;
        }
        const columnMatch = line.match(/^t\.(\w+)\s+"(\w+)"/);
        if (!columnMatch || columnMatch[1] === 'index') continue;
        currentTable.set(columnMatch[2], columnMatch[1]);
      }
    }

    return columnsByTable;
  }

  isSensitiveModelField(name: string, type: string): boolean {
    const nameLower = name.toLowerCase();
    const tokens = nameLower.split(/[^a-z0-9]+/).filter(Boolean);
    const substringPatterns = [
      'password', 'passwd', 'secret', 'token', 'credential',
      'social_security', 'date_of_birth', 'account_number',
      'routing_number', 'email', 'phone', 'address', 'salary'
    ];
    const tokenPatterns = ['ssn', 'card', 'cvv', 'iban', 'dob', 'pin', 'tax_id'];

    if (type === 'digest') return true;
    if (substringPatterns.some(pattern => nameLower.includes(pattern))) return true;
    return tokenPatterns.some(pattern =>
      pattern.includes('_') ? nameLower.includes(pattern) : tokens.includes(pattern)
    );
  }

  private async analyzeWorkers(
    projectPath: string,
    root: string,
    roots: string[],
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): Promise<RailsWorker[]> {
    const workers: RailsWorker[] = [];
    const jobFiles = await this.globRootFiles(projectPath, root, 'app/jobs/**/*.rb', roots);
    const mailerFiles = await this.globRootFiles(projectPath, root, 'app/mailers/**/*.rb', roots);

    for (const file of [...jobFiles, ...mailerFiles]) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const worker = this.extractWorker(content, file);
      if (!worker) continue;
      workers.push(worker);

      const workerId = this.generateId('worker', file, worker.name);
      nodes.push(this.createNodeBuilder(workerId, worker.name, worker.kind === 'job' ? 'rails_job' : 'rails_mailer')
        .withLevel(2, 'architectural')
        .withCategory('worker', ['rails', worker.kind === 'job' ? 'background_job' : 'mailer'])
        .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
        .withDescription(worker.kind === 'job'
          ? `Rails background job: ${worker.name}`
          : `Rails mailer: ${worker.name}`)
        .withMetadata({
          framework: 'rails',
          attributes: {
            kind: worker.kind,
            queue: worker.queue,
            methods: worker.methods
          }
        })
        .build());

      if (worker.kind === 'job') {
        entryPoints.push(this.createEntryPoint(
          `entry_job_${workerId}`,
          workerId,
          'message',
          `job:${worker.name}`,
          `Background job execution: ${worker.name}#perform`,
          { event: 'perform' },
          undefined,
          { queue: worker.queue }
        ));
      } else {
        exitPoints.push(this.createExitPoint(
          `exit_mail_${workerId}`,
          workerId,
          'message',
          `mail:${worker.name}`,
          `Outbound email through mailer ${worker.name}`,
          { service_id: 'smtp' },
          { action: 'send', async: true }
        ));
      }
    }

    return workers;
  }

  extractWorker(content: string, filePath: string): RailsWorker | null {
    const jobMatch = content.match(/^\s*class\s+(\w+)\s*<\s*(ApplicationJob|ActiveJob::Base)/m);
    const mailerMatch = content.match(/^\s*class\s+(\w+)\s*<\s*(ApplicationMailer|ActionMailer::Base)/m);
    const sidekiqMatch = !jobMatch && !mailerMatch && content.includes('include Sidekiq::Worker')
      ? content.match(/^\s*class\s+(\w+)/m)
      : null;
    if (!jobMatch && !mailerMatch && !sidekiqMatch) return null;

    const queueMatch = content.match(/queue_as\s+:(\w+)|sidekiq_options[^\n]*queue:\s*['":]+(\w+)/);
    const methods = [...content.matchAll(/^\s*def\s+(\w+[?!]?)/gm)].map(match => match[1]);

    return {
      name: (jobMatch || mailerMatch || sidekiqMatch)![1],
      filePath,
      kind: mailerMatch ? 'mailer' : 'job',
      queue: queueMatch ? (queueMatch[1] || queueMatch[2]) : undefined,
      methods,
      modelAccesses: this.extractModelAccesses(content)
    };
  }

  private async analyzeTestSuites(
    projectPath: string,
    root: string,
    roots: string[],
    nodes: CASNode[]
  ): Promise<RailsTestSuite[]> {
    const testSuites: RailsTestSuite[] = [];
    const specFiles = await this.globRootFiles(projectPath, root, 'spec/**/*_spec.rb', roots);
    const testFiles = await this.globRootFiles(projectPath, root, 'test/**/*_test.rb', roots);

    for (const file of [...specFiles, ...testFiles]) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      const suite = this.extractTestSuite(content, file);
      if (!suite) continue;
      testSuites.push(suite);

      const suiteId = this.generateId('test', file, suite.name);
      nodes.push(this.createNodeBuilder(suiteId, suite.name, 'test_suite')
        .withLevel(3, 'code')
        .withCategory('testing', ['rails', suite.framework])
        .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
        .withDescription(`Rails ${suite.framework} test suite: ${suite.name}`)
        .withMetadata({
          framework: 'rails',
          attributes: {
            test_framework: suite.framework,
            subject: suite.subject,
            examples_count: suite.examples
          }
        })
        .build());

    }

    return testSuites;
  }

  private linkTestSuites(
    testSuites: RailsTestSuite[],
    models: RailsModel[],
    controllers: RailsController[],
    edges: CASEdge[]
  ): void {
    for (const suite of testSuites) {
      if (!suite.subject) continue;
      const suiteId = this.generateId('test', suite.filePath, suite.name);
      const subjectController = controllers.find(controller => controller.name === suite.subject);
      const subjectModel = models.find(model => model.name === suite.subject);
      const subjectId = subjectController
        ? this.controllerNodeId(subjectController)
        : subjectModel
          ? this.modelNodeId(subjectModel)
          : undefined;
      if (subjectId) {
        edges.push(this.createEdge(
          this.generateEdgeId(suiteId, subjectId, 'tests'),
          suiteId,
          subjectId,
          'tests',
          'testing',
          { test_framework: suite.framework }
        ));
      }
    }
  }

  extractTestSuite(content: string, filePath: string): RailsTestSuite | null {
    const isSpec = filePath.endsWith('_spec.rb');
    const isTest = filePath.endsWith('_test.rb');
    if (!isSpec && !isTest) return null;

    const describeMatch = content.match(/(?:RSpec\.)?describe\s+([A-Z][\w:]*)/);
    const minitestClassMatch = content.match(/^\s*class\s+(\w+)\s*<\s*(ActiveSupport::TestCase|ActionDispatch::IntegrationTest|ActionController::TestCase|Minitest::Test)/m);
    const stringDescribeMatch = content.match(/(?:RSpec\.)?describe\s+['"]([^'"]+)['"]/);

    const name = describeMatch?.[1]
      || minitestClassMatch?.[1]
      || stringDescribeMatch?.[1]
      || path.basename(filePath, '.rb');

    const examples = isSpec
      ? (content.match(/^\s*(it|specify|scenario)\s+/gm) || []).length
      : (content.match(/^\s*(test\s+['"]|def\s+test_)/gm) || []).length;

    return {
      name,
      filePath,
      framework: isSpec ? 'rspec' : 'minitest',
      subject: describeMatch?.[1] || minitestClassMatch?.[1]?.replace(/Test$/, ''),
      examples
    };
  }

  extractModelAccesses(scopeContent: string): RailsModelAccess[] {
    const classMethodAccess: Record<string, RailsModelAccess['access']> = {
      'create': 'creates',
      'create!': 'creates',
      'insert': 'creates',
      'insert_all': 'creates',
      'find_or_create_by': 'creates',
      'find_or_create_by!': 'creates',
      'update': 'updates',
      'update!': 'updates',
      'update_all': 'updates',
      'upsert': 'updates',
      'upsert_all': 'updates',
      'destroy': 'deletes',
      'destroy!': 'deletes',
      'delete': 'deletes',
      'delete_all': 'deletes',
      'destroy_all': 'deletes',
      'find': 'reads',
      'find_by': 'reads',
      'find_by!': 'reads',
      'find_each': 'reads',
      'where': 'reads',
      'all': 'reads',
      'includes': 'reads',
      'order': 'reads',
      'joins': 'reads',
      'select': 'reads',
      'pluck': 'reads',
      'first': 'reads',
      'last': 'reads',
      'count': 'reads',
      'exists?': 'reads'
    };
    const fetchMethods = /(?:find|find_by!?|find_each|where|all|includes|order|joins|first|last)/;
    const instanceWriteAccess: Record<string, 'updates' | 'deletes'> = {
      'save': 'updates',
      'save!': 'updates',
      'update': 'updates',
      'update!': 'updates',
      'update_attributes': 'updates',
      'update_attributes!': 'updates',
      'destroy': 'deletes',
      'destroy!': 'deletes',
      'delete': 'deletes'
    };

    const accesses = new Map<string, RailsModelAccess>();
    const record = (model: string, access: RailsModelAccess['access']) => {
      accesses.set(`${model}:${access}`, { model, access });
    };

    const classCallPattern = /\b(?:[A-Z]\w*::)*([A-Z]\w*)\.(\w+[!?]?)/g;
    let match;
    while ((match = classCallPattern.exec(scopeContent)) !== null) {
      const access = classMethodAccess[match[2]];
      if (access) record(match[1], access);
    }

    const chainedWritePattern = new RegExp(
      `\\b(?:[A-Z]\\w*::)*([A-Z]\\w*)\\.${fetchMethods.source}\\b[^\\n]*?\\.(update_all|delete_all|destroy_all|update!?|destroy!?|delete)\\b`,
      'g'
    );
    while ((match = chainedWritePattern.exec(scopeContent)) !== null) {
      const method = match[2];
      record(match[1], method.startsWith('update') ? 'updates' : 'deletes');
    }

    const builtVariableToModel = new Map<string, string>();
    const buildPattern = /(@?[a-z_]\w*)\s*=\s*(?:[A-Z]\w*::)*([A-Z]\w*)\.new\b/g;
    while ((match = buildPattern.exec(scopeContent)) !== null) {
      builtVariableToModel.set(match[1], match[2]);
    }

    const associationBuildPattern = /(@?[a-z_]\w*)\s*=\s*@?[a-z_]\w*\.([a-z_]\w*)\.(?:new|build)\b/g;
    while ((match = associationBuildPattern.exec(scopeContent)) !== null) {
      builtVariableToModel.set(match[1], this.camelize(this.singularize(match[2])));
    }

    const fetchedVariableToModel = new Map<string, string>();
    const fetchPattern = new RegExp(
      `(@?[a-z_]\\w*)\\s*=\\s*(?:[A-Z]\\w*::)*([A-Z]\\w*)\\.${fetchMethods.source}\\b`,
      'g'
    );
    while ((match = fetchPattern.exec(scopeContent)) !== null) {
      fetchedVariableToModel.set(match[1], match[2]);
    }

    const instanceWritePattern = /(@?[a-z_]\w*)\.(save!?|update!?|update_attributes!?|destroy!?|delete)\b/g;
    while ((match = instanceWritePattern.exec(scopeContent)) !== null) {
      const access = instanceWriteAccess[match[2]];
      if (!access) continue;
      const builtModel = builtVariableToModel.get(match[1]);
      if (builtModel) {
        record(builtModel, match[2].startsWith('save') ? 'creates' : access);
        continue;
      }
      const fetchedModel = fetchedVariableToModel.get(match[1]);
      if (fetchedModel) record(fetchedModel, access);
    }

    const inlineSavePattern = /\b(?:[A-Z]\w*::)*([A-Z]\w*)\.new\([^\n]*\)\.save!?\b/g;
    while ((match = inlineSavePattern.exec(scopeContent)) !== null) {
      record(match[1], 'creates');
    }

    const associationWritePattern = /\b@?[a-z_]\w*\.([a-z_]\w*)\.(create!?|update_all|delete_all|destroy_all)\b/g;
    while ((match = associationWritePattern.exec(scopeContent)) !== null) {
      const candidate = this.camelize(this.singularize(match[1]));
      const method = match[2];
      record(candidate, method.startsWith('create') ? 'creates' : method === 'update_all' ? 'updates' : 'deletes');
    }

    return [...accesses.values()];
  }

  private linkModelAccesses(
    controllers: RailsController[],
    workers: RailsWorker[],
    models: RailsModel[],
    edges: CASEdge[]
  ): void {
    const modelByName = new Map(models.map(model => [model.name, model]));
    const emit = (sourceId: string, modelAccesses: RailsModelAccess[]) => {
      for (const access of modelAccesses) {
        const model = modelByName.get(access.model);
        if (!model) continue;
        const modelId = this.modelNodeId(model);
        edges.push(this.createEdge(
          this.generateEdgeId(sourceId, modelId, access.access),
          sourceId,
          modelId,
          access.access,
          'data',
          { reason: 'code_level_model_access' }
        ));
      }
    };

    for (const controller of controllers) {
      for (const action of controller.actions) {
        emit(this.actionNodeId(controller, action.name), action.modelAccesses);
      }
    }
    for (const worker of workers) {
      emit(this.generateId('worker', worker.filePath, worker.name), worker.modelAccesses);
    }
  }

  private linkControllersToModels(
    controllers: RailsController[],
    models: RailsModel[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    for (const controller of controllers) {
      const resourceName = controller.name.replace(/Controller$/, '');
      const model = models.find(candidate =>
        this.pluralize(candidate.name) === resourceName ||
        candidate.name === this.singularize(resourceName));
      if (!model) continue;
      edges.push(this.createEdge(
        this.generateEdgeId(this.controllerNodeId(controller), this.modelNodeId(model), 'uses'),
        this.controllerNodeId(controller),
        this.modelNodeId(model),
        'uses',
        'behavioral',
        { reason: 'restful_resource_convention' }
      ));
    }
  }

  private async detectRailsVersion(projectPath: string): Promise<string | undefined> {
    try {
      const lockPath = path.join(projectPath, 'Gemfile.lock');
      if (await fs.pathExists(lockPath)) {
        const lockContent = await fs.readFile(lockPath, 'utf-8');
        const lockMatch = lockContent.match(/^\s{4}rails\s+\(([^)]+)\)/m);
        if (lockMatch) return lockMatch[1];
      }
      const gemfilePath = path.join(projectPath, 'Gemfile');
      if (await fs.pathExists(gemfilePath)) {
        const content = await fs.readFile(gemfilePath, 'utf-8');
        const gemMatch = content.match(/gem\s+['"]rails['"]\s*,\s*['"]([^'"]+)['"]/);
        if (gemMatch) return gemMatch[1];
      }
    } catch {
    }
    return undefined;
  }

  private classify(associationName: string, type: RailsAssociation['type']): string {
    const singular = type === 'has_many' || type === 'has_and_belongs_to_many'
      ? this.singularize(associationName)
      : associationName;
    return this.camelize(singular);
  }

  private camelize(value: string): string {
    return value.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  }

  private underscore(value: string): string {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase();
  }

  private singularize(value: string): string {
    if (/ies$/.test(value)) return value.replace(/ies$/, 'y');
    if (/ses$/.test(value) || /xes$/.test(value) || /ches$/.test(value) || /shes$/.test(value)) return value.replace(/es$/, '');
    if (/s$/.test(value) && !/ss$/.test(value)) return value.replace(/s$/, '');
    return value;
  }

  private pluralize(value: string): string {
    if (/y$/.test(value) && !/[aeiou]y$/.test(value)) return value.replace(/y$/, 'ies');
    if (/(s|x|ch|sh)$/.test(value)) return `${value}es`;
    return `${value}s`;
  }

  private tableize(modelName: string): string {
    return this.pluralize(this.underscore(modelName));
  }
}

const TRAILING_DO = /\bdo\s*$/;
