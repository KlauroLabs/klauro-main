import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface DjangoProject {
  id?: string;
  name: string;
  filePath: string;
  apps: string[];
  settings: DjangoSettings;
  urlconf: string;
}

interface DjangoSettings {
  filePath: string;
  debug: boolean;
  installedApps: string[];
  middleware: string[];
  databases: Array<{ name: string; engine: string; config: Record<string, any> }>;
  staticUrl: string;
  mediaUrl: string;
  allowedHosts: string[];
}

interface DjangoApp {
  id: string;
  name: string;
  path: string;
  models: DjangoModel[];
  views: DjangoView[];
  urls: DjangoUrl[];
  admin: DjangoAdmin[];
  forms: DjangoForm[];
  serializers: DjangoSerializer[];
  graphqlMutations: GraphQLMutation[];
  graphqlQueries: GraphQLQuery[];
  graphqlTypes: GraphQLType[];
  celeryTasks: CeleryTask[];
}

interface DjangoModel {
  name: string;
  filePath: string;
  fields: Array<{ name: string; type: string; options: Record<string, any> }>;
  relationships: Array<{ type: string; target: string; relatedName?: string }>;
  meta: { dbTable?: string; ordering?: string[]; verbose?: string };
  methods: Array<{ name: string; isProperty: boolean; isClassMethod: boolean }>;
  abstract?: boolean;
  parentModel?: string;
}

interface DjangoView {
  name: string;
  filePath: string;
  type: 'function' | 'class';
  owningClass?: string;
  baseClass?: string;
  methods: string[];
  decorators: string[];
  permissions: string[];
  templateName?: string;
  contextObject?: string;
  serializerClass?: string;
  serializerReferences: string[];
  serializerWrites: DjangoSerializerWrite[];
  modelReferences: string[];
  modelAccesses: DjangoModelAccess[];
  querysetModel?: string;
}

export interface DjangoSerializerWrite {
  serializer: string;
  access: 'creates' | 'updates';
}

interface DjangoUrl {
  pattern: string;
  name?: string;
  view: string;
  namespace?: string;
  included?: boolean;
  methods?: string[];
  sourceFile?: string;
  authRequired?: boolean;
}

interface DjangoUrlModule {
  file: string;
  module: string;
  routes: Array<{ pattern: string; viewExpr: string; name?: string }>;
  includes: Array<{ pattern: string; module?: string; namespace?: string; raw: string }>;
  adminMounts: Array<{ pattern: string }>;
  routerMounts: Array<{ pattern: string; router: string }>;
  routers: Map<string, Array<{ prefix: string; viewset: string; kind: 'drf' | 'endpoint' }>>;
}

interface DjangoModelClassDecl {
  name: string;
  bases: string[];
  filePath: string;
  appDir: string;
  classContent: string;
  abstract: boolean;
  imports: Map<string, string>;
}

interface DjangoAdmin {
  name: string;
  filePath: string;
  model: string;
  listDisplay: string[];
  listFilter: string[];
  searchFields: string[];
  readonly: string[];
  inlines: string[];
}

interface DjangoForm {
  name: string;
  filePath: string;
  baseClass: string;
  fields: Array<{ name: string; type: string; required: boolean; widget?: string }>;
  meta?: { model?: string; fields?: string[]; exclude?: string[] };
}

interface DjangoSerializer {
  name: string;
  filePath: string;
  baseClass: string;
  fields: Array<{ name: string; type: string; readOnly: boolean; required: boolean }>;
  meta?: { model?: string; fields?: string[]; depth?: number };
}


interface GraphQLMutation {
  name: string;
  filePath: string;
  className: string;
  baseClass: string;
  mutationType: 'custom' | 'crud-create' | 'crud-update' | 'crud-delete';
  arguments: Array<{ name: string; type: string; required: boolean }>;
  returnType?: string;
  resolverMethod?: string;
  modelAccesses?: DjangoModelAccess[];
}

interface GraphQLQuery {
  name: string;
  filePath: string;
  className: string;
  queryType: 'single' | 'batch' | 'custom';
  returnType?: string;
  arguments: Array<{ name: string; type: string; required: boolean }>;
}

interface GraphQLType {
  name: string;
  filePath: string;
  baseClass: string;
  model?: string;
  fields: Array<{ name: string; type: string }>;
  resolvers: string[];
  excludeFields: string[];
}

interface CeleryTask {
  name: string;
  filePath: string;
  decorators: string[];
  isBound: boolean;
  arguments: Array<{ name: string; type?: string; default?: string }>;
  description?: string;
  retryPolicy?: { maxRetries?: number; countdown?: number };
  modelAccesses?: DjangoModelAccess[];
}

export interface DjangoModelAccess {
  model: string;
  access: 'reads' | 'creates' | 'updates' | 'deletes';
}

const SCAFFOLD_SEGMENT_PATTERN = /(^|\/)(project_template|app_template|\{\{[^/]*\}\})(\/|$)/;

export class DjangoAnalyzer extends BaseAnalyzer {
  readonly discoversNestedRoots = true;


  constructor() {
    super(
      'django',
      'Django Framework Analyzer',
      '1.0.0',
      'framework'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      const pipfilePath = path.join(projectPath, 'Pipfile');
      const pyprojectPath = path.join(projectPath, 'pyproject.toml');

      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (requirements.includes('Django') || requirements.includes('django')) return true;
      }

      if (await fs.pathExists(pipfilePath)) {
        const pipfile = await fs.readFile(pipfilePath, 'utf-8');
        if (pipfile.includes('Django') || pipfile.includes('django')) return true;
      }

      if (await fs.pathExists(pyprojectPath)) {
        const pyproject = await fs.readFile(pyprojectPath, 'utf-8');



        if (this.pyprojectHasRealDependency(pyproject, 'django')) return true;
      }

      const managePyPath = path.join(projectPath, 'manage.py');
      if (await fs.pathExists(managePyPath)) {
        const manageContent = await fs.readFile(managePyPath, 'utf-8');
        if (manageContent.includes('django.core.management')) return true;
      }

      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      for (const file of pythonFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (content.includes('from django') || content.includes('import django')) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private async findScaffoldDirs(projectPath: string): Promise<string[]> {
    try {
      const templateMarkerFiles = await glob('**/*-tpl', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });

      const dirs = new Set<string>();
      for (const file of templateMarkerFiles) {
        const dir = path.dirname(file.replace(/\\/g, '/'));
        if (dir && dir !== '.') dirs.add(dir);
      }
      return [...dirs].sort();
    } catch {
      return [];
    }
  }

  private isScaffoldPath(relativePath: string, scaffoldDirs: string[]): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    if (SCAFFOLD_SEGMENT_PATTERN.test(normalized)) return true;
    return scaffoldDirs.some(dir => normalized === dir || normalized.startsWith(dir + '/'));
  }

  async discoverDjangoRoots(projectPath: string): Promise<string[]> {
    const scaffoldDirs = await this.findScaffoldDirs(projectPath);
    const markerFiles = await glob(
      ['**/manage.py', '**/settings.py', '**/settings/__init__.py', '**/urls.py', '**/apps.py', '**/models.py'],
      { cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true }
    );

    const files = markerFiles
      .map(file => file.replace(/\\/g, '/'))
      .filter(file => !this.isScaffoldPath(file, scaffoldDirs));
    const fileSet = new Set(files);

    const asRoot = (dir: string): string => (dir === '.' ? '' : dir);
    const roots = new Set<string>();

    for (const file of files) {
      const base = path.basename(file);
      if (base === 'manage.py') {
        roots.add(asRoot(path.dirname(file)));
        continue;
      }

      let packageDir: string | undefined;
      if (file.endsWith('settings/__init__.py')) {
        packageDir = path.dirname(path.dirname(file));
      } else if (base === 'settings.py') {
        packageDir = path.dirname(file);
      }
      if (packageDir !== undefined) {
        const hasUrls = fileSet.has(packageDir === '.' ? 'urls.py' : `${packageDir}/urls.py`);
        if (hasUrls) {
          roots.add(asRoot(packageDir === '.' ? '.' : path.dirname(packageDir)));
        }
      }
    }

    if (roots.size === 0 && files.some(file => file.endsWith('apps.py') || file.endsWith('models.py'))) {
      roots.add('');
    }

    return [...roots].sort();
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];

    try {
      const scaffoldDirs = await this.findScaffoldDirs(context.projectPath);
      const rawPythonFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/migrations/**'],
        nodir: true
      });
      const pythonFiles = rawPythonFiles
        .map(file => file.replace(/\\/g, '/'))
        .filter(file => !this.isScaffoldPath(file, scaffoldDirs));

      const roots = await this.discoverDjangoRoots(context.projectPath);
      const projects = await this.analyzeProjects(context.projectPath, pythonFiles, nodes);
      const project = projects[0] || null;
      const apps = await this.analyzeApps(pythonFiles, context.projectPath, nodes, edges, entryPoints, exitPoints);

      this.buildDjangoRelationships(projects, apps, nodes, edges);
      this.identifyDatabaseConnections(apps, nodes, exitPoints);

      this.tagNodesWithPerspectives(nodes, edges);
      this.createPerspectives(perspectives);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'django',
        version: await this.detectDjangoVersion(context.projectPath),
        projectName: project?.name || 'Unknown',
        djangoRoots: roots.map(root => root || '.'),
        projectsFound: projects.length,
        appsFound: apps.length,
        modelsFound: apps.reduce((sum, app) => sum + app.models.length, 0),
        viewsFound: apps.reduce((sum, app) => sum + app.views.length, 0),
        urlsFound: apps.reduce((sum, app) => sum + app.urls.length, 0),
        graphqlMutationsFound: apps.reduce((sum, app) => sum + app.graphqlMutations.length, 0),
        graphqlQueriesFound: apps.reduce((sum, app) => sum + app.graphqlQueries.length, 0),
        graphqlTypesFound: apps.reduce((sum, app) => sum + app.graphqlTypes.length, 0),
        celeryTasksFound: apps.reduce((sum, app) => sum + app.celeryTasks.length, 0)
      });

      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);

      return contribution;

    } catch (error) {
      throw new AnalyzerError(
        `Django analysis failed: ${(error as Error).message}`,
        'DJANGO_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeProjects(projectPath: string, pythonFiles: string[], nodes: CASNode[]): Promise<DjangoProject[]> {
    const settingsFiles = pythonFiles.filter(file =>
      /(^|\/)settings\.py$/.test(file) || /(^|\/)settings\/[^/]+\.py$/.test(file)
    );

    const settingsByPackage = new Map<string, string>();
    for (const file of settingsFiles.slice().sort()) {
      const packageDir = /(^|\/)settings\.py$/.test(file)
        ? path.dirname(file)
        : path.dirname(path.dirname(file));
      if (!settingsByPackage.has(packageDir)) {
        settingsByPackage.set(packageDir, file);
      }
    }

    const projects: DjangoProject[] = [];
    const usedProjectIds = new Set<string>();
    for (const [packageDir, settingsPath] of [...settingsByPackage.entries()].sort()) {
      const project = await this.analyzeProjectSettings(projectPath, packageDir, settingsPath, usedProjectIds, nodes);
      if (project) projects.push(project);
    }

    return projects;
  }

  private async analyzeProjectSettings(
    projectPath: string,
    packageDir: string,
    settingsPath: string,
    usedProjectIds: Set<string>,
    nodes: CASNode[]
  ): Promise<DjangoProject | null> {
    const fullSettingsPath = path.join(projectPath, settingsPath);
    let settingsContent: string;
    try {
      settingsContent = await fs.readFile(fullSettingsPath, 'utf-8');
    } catch {
      return null;
    }

    const settings = this.extractSettings(settingsContent, settingsPath);
    const projectName = packageDir === '.' ? path.basename(projectPath) : path.basename(packageDir);

    const project: DjangoProject = {
      name: projectName,
      filePath: settingsPath,
      apps: settings.installedApps.filter(app => !app.startsWith('django.')),
      settings,
      urlconf: this.extractRootUrlconf(settingsContent)
    };

    let projectId = `project_${this.sanitizeId(projectName)}`;
    if (usedProjectIds.has(projectId)) {
      projectId = `project_${this.sanitizeId(packageDir.split('/').join('_'))}`;
    }
    usedProjectIds.add(projectId);
    project.id = projectId;
    const documentation = this.extractDocumentation(settingsContent, fullSettingsPath);
    const comments = this.extractComments(settingsContent, fullSettingsPath);
    const todos = this.extractTodos(comments);
    const implementationStatus = this.determineImplementationStatus(settingsContent, comments);

    const projectNode = this.createNodeBuilder(projectId, projectName, 'application')
      .withLevel(1, 'system')
      .withCategory('application', ['framework', 'django'])
      .withSource({ file: settingsPath, line: 1, end_line: settingsContent.split('\n').length })
      .withDescription(`Django project: ${projectName}`)
      .withDocumentation(documentation)
      .withComments(comments)
      .withTodos(todos)
      .withImplementationStatus(implementationStatus)
      .withMetadata({
        framework: 'django',
        attributes: {
          debug: settings.debug,
          installedApps: settings.installedApps.length,
          databases: settings.databases.length,
          allowedHosts: settings.allowedHosts
        }
      })
      .withAnalyzers([this.analyzerId], this.analyzerId)
      .build();
    nodes.push(projectNode);

    return project;
  }

  private async analyzeApps(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[],
    exitPoints: any[]
  ): Promise<DjangoApp[]> {
    const apps: DjangoApp[] = [];
    const fileSet = new Set(files);
    const packageDirs = new Set<string>();
    const markerDirs = new Set<string>();

    files.forEach(file => {
      const dir = path.dirname(file);
      if (fileSet.has(path.join(dir, '__init__.py')) ||
          fileSet.has(path.join(dir, 'apps.py'))) {
        packageDirs.add(dir);
      }
      if (fileSet.has(path.join(dir, 'apps.py')) ||
          fileSet.has(path.join(dir, 'models.py')) ||
          (dir !== '.' && fileSet.has(path.join(dir, 'models', '__init__.py')))) {
        markerDirs.add(dir);
      }
    });

    if (fileSet.has('apps.py') || fileSet.has('models.py') || fileSet.has('models/__init__.py')) {
      packageDirs.add('.');
      markerDirs.add('.');
    }

    const hasMarkerAncestor = (dir: string): boolean => {
      let current = path.dirname(dir);
      for (;;) {
        if (markerDirs.has(current)) return true;
        if (!current || current === '.' || current === path.dirname(current)) return false;
        current = path.dirname(current);
      }
    };
    const hasMarkerDescendant = (dir: string): boolean => {
      for (const marker of markerDirs) {
        if (marker.startsWith(dir + '/')) return true;
      }
      return false;
    };

    const appDirs = [...packageDirs].sort().filter(dir => {
      const name = path.basename(dir);
      if (name.startsWith('__')) return false;
      if (name === '.') return markerDirs.has('.');
      if (markerDirs.has(dir)) return true;
      if (hasMarkerAncestor(dir)) return false;
      if (hasMarkerDescendant(dir)) return false;
      return true;
    });

    const appDirsDeepestFirst = appDirs.slice().sort((a, b) => b.length - a.length);
    const owningAppDir = (file: string): string | undefined =>
      appDirsDeepestFirst.find(dir => dir === '.' || file.startsWith(dir + '/'));

    const usedAppIds = new Set<string>();
    const appIdByDir = new Map<string, string>();
    const appFilesByDir = new Map<string, string[]>();
    for (const appDir of appDirs) {
      const appName = appDir === '.' ? path.basename(projectPath) : path.basename(appDir);
      let appId = `app_${this.sanitizeId(appName)}`;
      if (usedAppIds.has(appId)) {
        appId = `app_${this.sanitizeId(appDir.split('/').join('_'))}`;
      }
      usedAppIds.add(appId);
      appIdByDir.set(appDir, appId);
      appFilesByDir.set(appDir, files.filter(f => owningAppDir(f) === appDir));
    }

    const modelsByApp = await this.analyzeModelsAcrossApps(appFilesByDir, projectPath);
    const urlsByFile = await this.analyzeUrlGraph(files, projectPath);

    for (const appDir of appDirs) {
      const appName = appDir === '.' ? path.basename(projectPath) : path.basename(appDir);
      const appId = appIdByDir.get(appDir)!;
      const appFiles = appFilesByDir.get(appDir) || [];
      const models = modelsByApp.get(appDir) || [];
      const views = await this.analyzeViews(appFiles, projectPath, appDir);
      const urls = appFiles.flatMap(file => urlsByFile.get(file) || []);
      const admin = await this.analyzeAdmin(appFiles, projectPath, appDir);
      const forms = await this.analyzeForms(appFiles, projectPath, appDir);
      const serializers = await this.analyzeSerializers(appFiles, projectPath, appDir);
      const graphqlMutations = await this.analyzeGraphQLMutations(appFiles, projectPath, appDir);
      const graphqlQueries = await this.analyzeGraphQLQueries(appFiles, projectPath, appDir);
      const graphqlTypes = await this.analyzeGraphQLTypes(appFiles, projectPath, appDir);
      const celeryTasks = await this.analyzeCeleryTasks(appFiles, projectPath, appDir);

      const app: DjangoApp = {
        id: appId,
        name: appName,
        path: appDir,
        models,
        views,
        urls,
        admin,
        forms,
        serializers,
        graphqlMutations,
        graphqlQueries,
        graphqlTypes,
        celeryTasks
      };

      apps.push(app);

      const appComments = this.extractComments('', path.join(projectPath, appDir));
      const appTodos = this.extractTodos(appComments);
      const appImplementationStatus = this.determineImplementationStatus('', appComments);

      const appNode = this.createNodeBuilder(appId, appName, 'module')
        .withLevel(2, 'architectural')
        .withCategory('module', ['framework', 'django'])
        .withSource({ file: appDir, line: 1, end_line: 1 })
        .withDescription(`Django app module: ${appName}`)
        .withComments(appComments)
        .withTodos(appTodos)
        .withImplementationStatus(appImplementationStatus)
        .withMetadata({
          framework: 'django',
          attributes: {
            models: models.length,
            views: views.length,
            urls: urls.length,
            admin: admin.length,
            forms: forms.length,
            serializers: serializers.length,
            graphqlMutations: graphqlMutations.length,
            graphqlQueries: graphqlQueries.length,
            graphqlTypes: graphqlTypes.length,
            celeryTasks: celeryTasks.length
          }
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();
      nodes.push(appNode);

      for (const mutation of graphqlMutations) {
        if (!mutation.name) continue;

        const mutationId = `graphql_mutation_${appId}_${this.sanitizeId(mutation.name)}`;
        const mutationNode = this.createNodeBuilder(mutationId, mutation.name, 'mutation')
          .withLevel(3, 'code')
          .withCategory('mutation', ['graphql', 'api'])
          .withSource({ file: mutation.filePath, line: 1, end_line: 1 })
          .withDescription(`GraphQL mutation: ${mutation.name}`)
          .withMetadata({
            framework: 'graphene',
            attributes: {
              className: mutation.className,
              baseClass: mutation.baseClass,
              mutationType: mutation.mutationType,
              arguments: mutation.arguments,
              returnType: mutation.returnType
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(mutationNode);

        edges.push(this.createEdge(
          `${appId}_contains_${mutationId}`,
          appId,
          mutationId,
          'contains'
        ));







        const entryPointId = `entry_${mutationId}`;
        const resolverMethodName = mutation.resolverMethod || 'mutate';
        entryPoints.push(this.createEntryPoint(
          entryPointId,
          mutationId,
          'http',
          `mutation ${mutation.name}`,
          `GraphQL mutation: ${mutation.name} (${mutation.mutationType})`,
          {
            method: 'POST',
            path: '/graphql/',
            pattern: `mutation { ${mutation.name} }`,
            parameters: mutation.arguments.map(arg => ({
              name: arg.name,
              type: arg.type,
              required: arg.required,
              location: 'body'
            }))
          },
          {
            authenticated: true,
            guards: [],
            roles: [],
            permissions: []
          },
          {
            controller: mutation.className,
            handler: resolverMethodName,
            app: appName,
            base_class: mutation.baseClass,
            mutation_type: mutation.mutationType,
            graphql_operation: mutation.name,
            graphql_operation_type: 'mutation'
          },
          {
            node_id: mutationId,
            method_name: resolverMethodName,
            file: mutation.filePath
          }
        ));
      }

      for (const query of graphqlQueries) {
        if (!query.name) continue;

        const queryId = `graphql_query_${appId}_${this.sanitizeId(query.name)}`;
        const queryNode = this.createNodeBuilder(queryId, query.name, 'query')
          .withLevel(3, 'code')
          .withCategory('query', ['graphql', 'api'])
          .withSource({ file: query.filePath, line: 1, end_line: 1 })
          .withDescription(`GraphQL query: ${query.name}`)
          .withMetadata({
            framework: 'graphene',
            attributes: {
              className: query.className,
              queryType: query.queryType,
              returnType: query.returnType,
              arguments: query.arguments
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(queryNode);

        edges.push(this.createEdge(
          `${appId}_contains_${queryId}`,
          appId,
          queryId,
          'contains'
        ));



        const entryPointId = `entry_${queryId}`;
        const resolverMethodName = 'resolve';
        entryPoints.push(this.createEntryPoint(
          entryPointId,
          queryId,
          'http',
          `query ${query.name}`,
          `GraphQL query: ${query.name} (${query.queryType})`,
          {
            method: 'POST',
            path: '/graphql/',
            pattern: `query { ${query.name} }`,
            parameters: query.arguments.map(arg => ({
              name: arg.name,
              type: arg.type,
              required: arg.required,
              location: 'body'
            }))
          },
          {
            authenticated: true,
            guards: [],
            roles: [],
            permissions: []
          },
          {
            controller: query.className,
            handler: resolverMethodName,
            app: appName,
            query_type: query.queryType,
            graphql_operation: query.name,
            graphql_operation_type: 'query'
          },
          {
            node_id: queryId,
            method_name: resolverMethodName,
            file: query.filePath
          }
        ));
      }

      for (const gqlType of graphqlTypes) {
        if (!gqlType.name) continue;

        const typeId = `graphql_type_${appId}_${this.sanitizeId(gqlType.name)}`;
        const typeNode = this.createNodeBuilder(typeId, gqlType.name, 'type')
          .withLevel(3, 'code')
          .withCategory('type', ['graphql', 'schema'])
          .withSource({ file: gqlType.filePath, line: 1, end_line: 1 })
          .withDescription(`GraphQL type: ${gqlType.name}`)
          .withMetadata({
            framework: 'graphene',
            attributes: {
              baseClass: gqlType.baseClass,
              model: gqlType.model,
              fields: gqlType.fields.length,
              resolvers: gqlType.resolvers,
              excludeFields: gqlType.excludeFields
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(typeNode);

        edges.push(this.createEdge(
          `${appId}_contains_${typeId}`,
          appId,
          typeId,
          'contains'
        ));

      }

      for (const task of celeryTasks) {
        if (!task.name) continue;

        const taskId = `celery_task_${appId}_${this.sanitizeId(task.name)}`;
        const taskNode = this.createNodeBuilder(taskId, task.name, 'task')
          .withLevel(3, 'code')
          .withCategory('task', ['async', 'celery'])
          .withSource({ file: task.filePath, line: 1, end_line: 1 })
          .withDescription(`Celery task: ${task.name}`)
          .withMetadata({
            framework: 'celery',
            attributes: {
              decorators: task.decorators,
              isBound: task.isBound,
              arguments: task.arguments,
              description: task.description,
              retryPolicy: task.retryPolicy
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(taskNode);

        edges.push(this.createEdge(
          `${appId}_contains_${taskId}`,
          appId,
          taskId,
          'contains'
        ));

        const entryPointId = `entry_celery_task_${this.sanitizeId(task.name)}`;
        entryPoints.push(this.createEntryPoint(
          entryPointId,
          taskId,
          'message',
          `task ${task.name}`,
          `Celery task: ${task.name}`,
          {
            event: `celery.task.${task.name}`,
            path: `celery://${task.name}`,
            pattern: `@shared_task ${task.name}`,
            parameters: task.arguments.map(arg => ({
              name: arg.name,
              type: arg.type || 'any',
              required: !arg.default,
              location: 'argument'
            }))
          },
          {
            authenticated: false,
            guards: [],
            roles: [],
            permissions: []
          },
          {
            controller: task.name,
            handler: task.name,
            app: appName,
            is_bound: task.isBound,
            decorators: task.decorators,
            task_operation: task.name,
            task_type: 'celery'
          },
          {
            node_id: taskId,
            method_name: task.name,
            file: task.filePath
          }
        ));
      }

      for (const [, model] of models.entries()) {
        if (!model.name) continue;

        const modelId = `model_${appId}_${this.sanitizeId(model.name)}`;
        const modelContent = await this.readModelContent(projectPath, model.filePath);
        const modelDocumentation = this.extractDocumentation(modelContent, path.join(projectPath, model.filePath));
        const modelComments = this.extractComments(modelContent, path.join(projectPath, model.filePath));
        const modelTodos = this.extractTodos(modelComments);
        const modelImplementationStatus = this.determineImplementationStatus(modelContent, modelComments);

        const modelNode = this.createNodeBuilder(modelId, model.name, 'model')
          .withLevel(3, 'code')
          .withCategory('model', model.abstract ? ['data', 'abstract'] : ['data', 'entity'])
          .withSource({ file: model.filePath, line: 1, end_line: 1 })
          .withDescription(`Django model: ${model.name}`)
          .withDocumentation(modelDocumentation)
          .withComments(modelComments)
          .withTodos(modelTodos)
          .withImplementationStatus(modelImplementationStatus)
          .withMetadata({
            framework: 'django',
            attributes: {
              fields: model.fields.length,
              relationships: model.relationships.length,
              dbTable: model.meta.dbTable || model.name.toLowerCase(),
              abstract: model.abstract === true,
              ...(model.parentModel ? { parent_model: model.parentModel } : {})
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(modelNode);

        edges.push(this.createEdge(
          `${appId}_contains_${modelId}`,
          appId,
          modelId,
          'contains'
        ));

        for (const field of model.fields) {
          const fieldId = `${modelId}_field_${this.sanitizeId(field.name)}`;
          nodes.push(this.createNodeBuilder(fieldId, field.name, 'field')
            .withLevel(4, 'member')
            .withCategory('field', ['data'])
            .withSource({ file: model.filePath, line: 1, end_line: 1 })
            .withSignature({ parameters: [], return_type: field.type })
            .withMetadata({
              framework: 'django',
              attributes: {
                fieldType: field.type,
                sensitive: this.isSensitiveModelField(field.name, field.type)
              }
            })
            .withParent(modelId)
            .withAnalyzers([this.analyzerId], this.analyzerId)
            .build());

          edges.push(this.createEdge(
            `${modelId}_has_field_${fieldId}`,
            modelId,
            fieldId,
            'has_field'
          ));
        }
      }

      for (const [, view] of views.entries()) {
        if (!view.name) continue;

        const viewId = this.viewNodeId(appId, view);
        const viewContent = await this.readViewContent(projectPath, view.filePath);
        const viewDocumentation = this.extractDocumentation(viewContent, path.join(projectPath, view.filePath));
        const viewComments = this.extractComments(viewContent, path.join(projectPath, view.filePath));
        const viewTodos = this.extractTodos(viewComments);
        const viewImplementationStatus = this.determineImplementationStatus(viewContent, viewComments);

        const viewDisplayName = view.owningClass ? `${view.owningClass}.${view.name}` : view.name;
        const viewNode = this.createNodeBuilder(viewId, viewDisplayName, 'controller')
          .withLevel(3, 'code')
          .withCategory('controller', ['api', 'rest'])
          .withSource({ file: view.filePath, line: 1, end_line: 1 })
          .withDescription(`Django view: ${viewDisplayName}`)
          .withDocumentation(viewDocumentation)
          .withComments(viewComments)
          .withTodos(viewTodos)
          .withImplementationStatus(viewImplementationStatus)
          .withMetadata({
            framework: 'django',
            attributes: {
              type: view.type,
              owningClass: view.owningClass,
              baseClass: view.baseClass,
              methods: view.methods,
              decorators: view.decorators,
              permissions: view.permissions,
              templateName: view.templateName
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(viewNode);

        edges.push(this.createEdge(
          `${appId}_contains_${viewId}`,
          appId,
          viewId,
          'contains'
        ));
      }

      for (const serializer of serializers) {
        const serializerId = `serializer_${appId}_${this.sanitizeId(serializer.name)}`;
        const serializerNode = this.createNodeBuilder(serializerId, serializer.name, 'serializer')
          .withLevel(3, 'code')
          .withCategory('serializer', ['api', 'rest', 'dto'])
          .withSource({ file: serializer.filePath, line: 1, end_line: 1 })
          .withDescription(`Django REST Framework serializer: ${serializer.name}`)
          .withMetadata({
            framework: 'django-rest-framework',
            attributes: {
              baseClass: serializer.baseClass,
              model: serializer.meta?.model,
              fields: serializer.fields.map(f => f.name)
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(serializerNode);

        edges.push(this.createEdge(
          `${appId}_contains_${serializerId}`,
          appId,
          serializerId,
          'contains'
        ));
      }

      urls.forEach((url, index) => {
        if (!url.view) return;
        if (!url.pattern && url.included) return;

        const urlId = `url_${appId}_${index}`;
        const urlName = url.pattern || `route_${index}`;
        const urlNode = this.createNodeBuilder(urlId, urlName, 'route')
          .withLevel(4, 'member')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({
            file: url.sourceFile || path.join(appDir, 'urls.py'),
            line: 1,
            end_line: 1
          })
          .withDescription(`Django URL pattern: ${url.pattern}`)
          .withMetadata({
            attributes: {
              pattern: url.pattern,
              name: url.name,
              view: url.view,
              namespace: url.namespace
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(urlNode);

        edges.push(this.createEdge(
          `${appId}_exposes_${urlId}`,
          appId,
          urlId,
          'exposes'
        ));

        const matchingView = views.find(v => {
          const viewClassName = url.view.replace('.as_view()', '').split('.').pop() || '';
          return v.name === viewClassName || url.view.includes(v.name);
        });

        const viewId = matchingView ? this.viewNodeId(appId, matchingView) : undefined;

        const httpMethods = url.methods && url.methods.length > 0
          ? url.methods
          : matchingView?.type === 'class'
            ? (matchingView.methods.length > 0 ? matchingView.methods : ['GET'])


            : (matchingView?.methods && matchingView.methods.length > 0
                ? matchingView.methods
                : ['GET', 'POST']);

        for (const method of httpMethods) {
          const entryPointId = `entry_${urlId}_${method.toLowerCase()}`;
          const fullPath = url.pattern.startsWith('/') ? url.pattern : `/${url.pattern}`;

          entryPoints.push(this.createEntryPoint(
            entryPointId,
            viewId || urlId,
            'http',
            `${method.toUpperCase()} ${fullPath}`,
            `Django ${matchingView?.type === 'class' ? 'class-based' : 'function'} view: ${url.view}`,
            {
              method: method.toUpperCase(),
              path: fullPath,
              parameters: this.extractUrlParameters(url.pattern)
            },
            {
              authenticated: url.authRequired === true || this.hasAuthDecorator(matchingView?.decorators || []),
              guards: this.extractGuardsFromDecorators(matchingView?.decorators || []),
              roles: matchingView?.permissions || [],
              permissions: matchingView?.permissions || []
            },
            {
              controller: matchingView?.name || url.view,
              handler: method.toLowerCase(),
              app: appName,
              base_path: `/${appName}`,
              url_name: url.name,
              view_type: matchingView?.type || 'unknown',
              base_class: matchingView?.baseClass,
              decorators: matchingView?.decorators || []
            }
          ));
        }

        if (viewId) {
          edges.push(this.createEdge(
            `${urlId}_maps_to_${viewId}`,
            urlId,
            viewId,
            'maps_to'
          ));
        }
      });
    }

    return apps;
  }

  private inAppDir(file: string, appDir: string): boolean {
    return appDir === '.' || file.startsWith(appDir + '/');
  }

  private async analyzeModelsAcrossApps(
    appFilesByDir: Map<string, string[]>,
    projectPath: string
  ): Promise<Map<string, DjangoModel[]>> {
    const declarations: DjangoModelClassDecl[] = [];

    for (const [appDir, appFiles] of appFilesByDir) {
      const modelsPackagePrefix = path.join(appDir, 'models') + '/';
      const modelFiles = appFiles.filter(f =>
        f === path.join(appDir, 'models.py') ||
        (f.startsWith(modelsPackagePrefix) && f.endsWith('.py'))
      );

      for (const modelsFile of modelFiles) {
        let content: string;
        try {
          content = await fs.readFile(path.join(projectPath, modelsFile), 'utf-8');
        } catch {
          continue;
        }
        declarations.push(...this.collectModelClassDecls(content, modelsFile, appDir));
      }
    }

    const models = this.resolveModelHierarchy(declarations);
    const modelsByApp = new Map<string, DjangoModel[]>();
    for (const { model, appDir } of models) {
      let bucket = modelsByApp.get(appDir);
      if (!bucket) {
        bucket = [];
        modelsByApp.set(appDir, bucket);
      }
      bucket.push(model);
    }
    return modelsByApp;
  }

  private collectModelClassDecls(content: string, filePath: string, appDir: string): DjangoModelClassDecl[] {
    const decls: DjangoModelClassDecl[] = [];
    const classPattern = /class\s+(\w+)\s*\(([^)]*)\)\s*:/g;
    const imports = this.extractModuleImports(content);

    let match;
    while ((match = classPattern.exec(content)) !== null) {
      const name = match[1];
      const bases = match[2]
        .split(',')
        .map(base => base.trim())
        .filter(base => base.length > 0 && !base.startsWith('metaclass'))
        .map(base => base.split('.').pop() || base)
        .map(base => base.replace(/\[.*$/, ''));
      const classStart = match.index;
      const lineStart = content.lastIndexOf('\n', classStart) + 1;
      const headerIndent = classStart - lineStart;
      const classEnd = this.findIndentedBlockEnd(content, classStart + match[0].length, headerIndent);
      const classContent = content.substring(classStart, classEnd);

      decls.push({
        name,
        bases,
        filePath,
        appDir,
        classContent,
        abstract: /\babstract\s*=\s*True\b/.test(classContent),
        imports
      });
    }

    return decls;
  }

  private findIndentedBlockEnd(content: string, bodyStart: number, headerIndent: number): number {
    let lineStart = content.indexOf('\n', bodyStart) + 1;
    if (lineStart === 0) return content.length;

    while (lineStart < content.length) {
      const lineEnd = content.indexOf('\n', lineStart);
      const line = content.substring(lineStart, lineEnd === -1 ? content.length : lineEnd);
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('#')) {
        const indent = line.length - line.trimStart().length;
        if (indent <= headerIndent) return lineStart;
      }
      if (lineEnd === -1) break;
      lineStart = lineEnd + 1;
    }
    return content.length;
  }

  private extractModuleImports(content: string): Map<string, string> {
    const imports = new Map<string, string>();

    const fromImportPattern = /^[ \t]*from\s+([\w.]+)\s+import\s+(?:\(([^)]*)\)|([^\n]+))/gm;
    let match;
    while ((match = fromImportPattern.exec(content)) !== null) {
      const module = match[1];
      const importedNames = (match[2] !== undefined ? match[2] : match[3]).replace(/#[^\n]*/g, '');
      const names = importedNames.split(',').map(part => part.trim()).filter(Boolean);
      for (const namePart of names) {
        const [original, alias] = namePart.split(/\s+as\s+/).map(part => part.trim());
        if (!original || !/^\w+$/.test(original)) continue;
        imports.set(alias || original, `${module}.${original}`);
      }
    }

    const plainImportPattern = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
    while ((match = plainImportPattern.exec(content)) !== null) {
      const module = match[1];
      const alias = match[2] || module.split('.')[0];
      imports.set(alias, module);
    }

    return imports;
  }

  private moduleNameForFile(filePath: string): string {
    return filePath
      .replace(/\\/g, '/')
      .replace(/\.py$/, '')
      .split('/')
      .join('.')
      .replace(/\.__init__$/, '');
  }

  private resolveModelHierarchy(
    declarations: DjangoModelClassDecl[]
  ): Array<{ model: DjangoModel; appDir: string }> {
    const modelBasePattern = /\bmodels\.Model\b|\b\w*Model\b|\bAbstractUser\b|\bAbstractBaseUser\b|\bMP_Node\b|\bNS_Node\b|\bAL_Node\b/;
    const nonModelBasePattern = /\b(?:TextChoices|IntegerChoices|Choices|Enum|Serializer|Form|Admin|TestCase)\b/;

    const resolved = new Map<DjangoModelClassDecl, { parent?: DjangoModelClassDecl }>();
    const pending: DjangoModelClassDecl[] = [];

    for (const decl of declarations) {
      const baseText = decl.bases.join(', ');
      if (nonModelBasePattern.test(baseText)) continue;
      if (modelBasePattern.test(baseText)) {
        resolved.set(decl, {});
      } else {
        pending.push(decl);
      }
    }

    const declsByName = new Map<string, DjangoModelClassDecl[]>();
    for (const decl of declarations) {
      let bucket = declsByName.get(decl.name);
      if (!bucket) {
        bucket = [];
        declsByName.set(decl.name, bucket);
      }
      bucket.push(decl);
    }

    const resolveBase = (decl: DjangoModelClassDecl, baseName: string): DjangoModelClassDecl | undefined => {
      const candidates = (declsByName.get(baseName) || []).filter(candidate => resolved.has(candidate));
      if (candidates.length === 0) return undefined;
      const sameFile = candidates.find(candidate => candidate.filePath === decl.filePath);
      if (sameFile) return sameFile;
      const sameApp = candidates.find(candidate => candidate.appDir === decl.appDir);
      if (sameApp) return sameApp;

      const importedFrom = decl.imports.get(baseName);
      if (importedFrom) {
        const importedModule = importedFrom.split('.').slice(0, -1).join('.');
        const byModule = candidates.find(candidate => {
          const declModule = this.moduleNameForFile(candidate.filePath);
          return declModule === importedModule ||
            declModule.endsWith(`.${importedModule}`) ||
            importedModule.endsWith(`.${declModule}`) ||
            (declModule === '' && importedModule.length > 0);
        });
        if (byModule) return byModule;
      }

      return candidates.length === 1 ? candidates[0] : undefined;
    };

    const resolveParent = (decl: DjangoModelClassDecl): DjangoModelClassDecl | undefined => {
      for (const base of decl.bases) {
        const parent = resolveBase(decl, base);
        if (parent && parent !== decl) return parent;
      }
      return undefined;
    };

    let progressed = true;
    while (progressed && pending.length > 0) {
      progressed = false;
      for (let index = pending.length - 1; index >= 0; index--) {
        const decl = pending[index];
        const parent = resolveParent(decl);
        if (!parent) continue;
        resolved.set(decl, { parent });
        pending.splice(index, 1);
        progressed = true;
      }
    }

    for (const [decl, info] of resolved) {
      if (info.parent) continue;
      const parent = resolveParent(decl);
      if (parent) info.parent = parent;
    }

    const builtByDecl = new Map<DjangoModelClassDecl, DjangoModel>();
    const buildModel = (decl: DjangoModelClassDecl): DjangoModel => {
      const existing = builtByDecl.get(decl);
      if (existing) return existing;

      const fields = this.extractModelFields(decl.classContent);
      const relationships = this.extractModelRelationships(decl.classContent).map(relationship =>
        relationship.target === 'self' ? { ...relationship, target: decl.name } : relationship
      );
      const meta = this.extractModelMeta(decl.classContent);
      const methods = this.extractModelMethods(decl.classContent);

      const model: DjangoModel = {
        name: decl.name,
        filePath: decl.filePath,
        fields,
        relationships,
        meta,
        methods,
        abstract: decl.abstract
      };
      builtByDecl.set(decl, model);

      const parent = resolved.get(decl)?.parent;
      if (parent) {
        const parentModel = buildModel(parent);
        model.parentModel = parentModel.name;
        const ownFieldNames = new Set(model.fields.map(field => field.name));
        for (const inherited of parentModel.fields) {
          if (ownFieldNames.has(inherited.name)) continue;
          ownFieldNames.add(inherited.name);
          model.fields.push(inherited);
        }
        if (!model.meta.dbTable && !parentModel.abstract && parentModel.meta.dbTable) {
          model.meta.dbTable = parentModel.meta.dbTable;
        }
      }

      return model;
    };

    const results: Array<{ model: DjangoModel; appDir: string }> = [];
    for (const decl of declarations) {
      if (!resolved.has(decl)) continue;
      results.push({ model: buildModel(decl), appDir: decl.appDir });
    }
    return results;
  }

  private async analyzeViews(files: string[], projectPath: string, appDir: string): Promise<DjangoView[]> {
    const views: DjangoView[] = [];
    const viewsFiles = files.filter(f =>
      this.inAppDir(f, appDir) &&
      (f.endsWith('/views.py') || f === path.join(appDir, 'views.py') || /(^|\/)views\/[^/]+\.py$/.test(f))
    );

    for (const viewsFile of viewsFiles) {
      const content = await fs.readFile(path.join(projectPath, viewsFile), 'utf-8');
      const extractedViews = this.extractViews(content, viewsFile);
      views.push(...extractedViews);
    }

    return views;
  }

  async analyzeUrlGraph(files: string[], projectPath: string): Promise<Map<string, DjangoUrl[]>> {
    const urlFiles = files.filter(f =>
      /(^|\/)urls\.py$/.test(f) || /(^|\/)urls\/[^/]+\.py$/.test(f)
    );

    const modules = new Map<string, DjangoUrlModule>();
    for (const file of urlFiles) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      const parsed = this.parseUrlModule(content, file);
      modules.set(parsed.module, parsed);
    }

    return this.resolveUrlGraph(modules);
  }

  parseUrlModule(content: string, filePath: string): DjangoUrlModule {
    const imports = this.extractModuleImports(content);
    const module: DjangoUrlModule = {
      file: filePath,
      module: this.moduleNameForFile(filePath),
      routes: [],
      includes: [],
      adminMounts: [],
      routerMounts: [],
      routers: new Map()
    };

    const routerDefPattern = /(\w+)\s*=\s*(?:[\w.]+\.)?(\w*Router)\s*\(/g;
    let match;
    while ((match = routerDefPattern.exec(content)) !== null) {
      if (!module.routers.has(match[1])) module.routers.set(match[1], []);
    }

    const registerPattern = /(\w+)\.register(_endpoint)?\s*\(/g;
    while ((match = registerPattern.exec(content)) !== null) {
      const routerVar = match[1];
      if (!module.routers.has(routerVar)) continue;
      const args = this.splitTopLevelArgs(this.extractBalancedParens(content, match.index + match[0].length - 1));
      if (args.length < 2) continue;
      const prefix = this.unquotePattern(args[0]);
      if (prefix === undefined) continue;
      const viewset = (args[1].split('.').pop() || args[1]).trim();
      if (!/^\w+$/.test(viewset)) continue;
      module.routers.get(routerVar)!.push({
        prefix,
        viewset,
        kind: match[2] ? 'endpoint' : 'drf'
      });
    }

    const resolveIncludeTarget = (expr: string): { module?: string; namespace?: string } => {
      let inner = expr.trim();
      let namespace: string | undefined;

      const tupleMatch = inner.match(/^\(\s*([^,]+),\s*['"](\w+)['"]\s*\)$/s);
      if (tupleMatch) {
        inner = tupleMatch[1].trim();
        namespace = tupleMatch[2];
      }

      const literal = this.unquotePattern(inner);
      if (literal !== undefined) return { module: literal, namespace };

      const identifier = inner.match(/^[\w.]+$/) ? inner : undefined;
      if (identifier) {
        const head = identifier.split('.')[0];
        const mapped = imports.get(head) || imports.get(identifier);
        if (mapped) {
          const rest = identifier.split('.').slice(1).join('.');
          return { module: rest && mapped !== identifier ? `${mapped}.${rest}` : mapped, namespace };
        }
        return { module: identifier, namespace };
      }

      return { namespace };
    };

    const urlCallPattern = /\b(path|re_path|url)\s*\(/g;
    while ((match = urlCallPattern.exec(content)) !== null) {
      const kind = match[1];
      const argsRaw = this.extractBalancedParens(content, match.index + match[0].length - 1);
      if (argsRaw === undefined) continue;
      const args = this.splitTopLevelArgs(argsRaw);
      if (args.length < 2) continue;

      const rawPattern = this.unquotePattern(args[0]);
      if (rawPattern === undefined) continue;
      const pattern = kind === 'path' ? rawPattern : this.cleanRegexPattern(rawPattern);
      const viewExpr = args[1].trim();
      const nameArg = args.find(arg => /^name\s*=/.test(arg.trim()));
      const name = nameArg ? this.unquotePattern(nameArg.replace(/^name\s*=\s*/, '').trim()) : undefined;

      if (/^include\s*\(/.test(viewExpr)) {
        const includeArgsRaw = this.extractBalancedParens(viewExpr, viewExpr.indexOf('(')) || '';
        const includeArgs = this.splitTopLevelArgs(includeArgsRaw);
        const namespaceArg = [...args, ...includeArgs].find(arg => /^namespace\s*=/.test(arg.trim()));
        const namespace = namespaceArg
          ? this.unquotePattern(namespaceArg.replace(/^namespace\s*=\s*/, '').trim())
          : undefined;
        const target = resolveIncludeTarget(includeArgs[0] || '');

        if (includeArgs[0] && /admin\.site\.urls/.test(includeArgs[0])) {
          module.adminMounts.push({ pattern });
          continue;
        }
        const routerFromInclude = (includeArgs[0] || '').match(/^(\w+)\.urls$/);
        if (routerFromInclude && module.routers.has(routerFromInclude[1])) {
          module.routerMounts.push({ pattern, router: routerFromInclude[1] });
          continue;
        }

        module.includes.push({
          pattern,
          module: target.module,
          namespace: target.namespace || namespace,
          raw: viewExpr
        });
        continue;
      }

      if (/admin\.site\.urls/.test(viewExpr)) {
        module.adminMounts.push({ pattern });
        continue;
      }

      const routerUrls = viewExpr.match(/^(\w+)\.urls$/);
      if (routerUrls && module.routers.has(routerUrls[1])) {
        module.routerMounts.push({ pattern, router: routerUrls[1] });
        continue;
      }

      module.routes.push({ pattern, viewExpr, name });
    }

    const bareRouterPattern = /urlpatterns\s*\+?=\s*(\w+)\.urls\b/g;
    while ((match = bareRouterPattern.exec(content)) !== null) {
      if (module.routers.has(match[1])) {
        module.routerMounts.push({ pattern: '', router: match[1] });
      }
    }

    return module;
  }

  private resolveUrlGraph(modules: Map<string, DjangoUrlModule>): Map<string, DjangoUrl[]> {
    const moduleNames = [...modules.keys()];
    const lookupModule = (target?: string): DjangoUrlModule | undefined => {
      if (!target) return undefined;
      const direct = modules.get(target);
      if (direct) return direct;
      const suffixMatches = moduleNames.filter(name =>
        name.endsWith(`.${target}`) || target.endsWith(`.${name}`) || (name === '' && target.length > 0)
      );
      if (suffixMatches.length === 1) return modules.get(suffixMatches[0]);
      return undefined;
    };

    const includedModules = new Set<string>();
    for (const urlModule of modules.values()) {
      for (const include of urlModule.includes) {
        const target = lookupModule(include.module);
        if (target) includedModules.add(target.module);
      }
    }

    const urlsByFile = new Map<string, DjangoUrl[]>();
    const emit = (file: string, url: DjangoUrl) => {
      let bucket = urlsByFile.get(file);
      if (!bucket) {
        bucket = [];
        urlsByFile.set(file, bucket);
      }
      bucket.push(url);
    };

    const expandRouter = (
      urlModule: DjangoUrlModule,
      routerVar: string,
      prefix: string,
      namespace?: string
    ) => {
      const registrations = urlModule.routers.get(routerVar) || [];
      for (const registration of registrations) {
        const base = this.joinUrlPatterns(prefix, registration.prefix.replace(/\/?$/, '/'));
        if (registration.kind === 'drf') {
          emit(urlModule.file, {
            pattern: base,
            view: registration.viewset,
            name: namespace,
            namespace,
            methods: ['GET', 'POST'],
            sourceFile: urlModule.file
          });
          emit(urlModule.file, {
            pattern: this.joinUrlPatterns(base, '<pk>/'),
            view: registration.viewset,
            name: namespace,
            namespace,
            methods: ['GET', 'PUT', 'PATCH', 'DELETE'],
            sourceFile: urlModule.file
          });
        } else {
          emit(urlModule.file, {
            pattern: base,
            view: registration.viewset,
            namespace,
            methods: ['GET'],
            sourceFile: urlModule.file
          });
          emit(urlModule.file, {
            pattern: this.joinUrlPatterns(base, '<id>/'),
            view: registration.viewset,
            namespace,
            methods: ['GET'],
            sourceFile: urlModule.file
          });
        }
      }
    };

    const walk = (urlModule: DjangoUrlModule, prefix: string, namespace: string | undefined, visited: Set<string>) => {
      if (visited.has(urlModule.module) || visited.size > 50) return;
      visited.add(urlModule.module);

      for (const route of urlModule.routes) {
        emit(urlModule.file, {
          pattern: this.joinUrlPatterns(prefix, route.pattern),
          view: route.viewExpr,
          name: namespace && route.name ? `${namespace}:${route.name}` : route.name,
          namespace,
          sourceFile: urlModule.file
        });
      }

      for (const adminMount of urlModule.adminMounts) {
        emit(urlModule.file, {
          pattern: this.joinUrlPatterns(prefix, adminMount.pattern),
          view: 'django.contrib.admin.site',
          name: 'django-admin',
          namespace,
          methods: ['GET', 'POST'],
          authRequired: true,
          sourceFile: urlModule.file
        });
      }

      for (const routerMount of urlModule.routerMounts) {
        expandRouter(urlModule, routerMount.router, this.joinUrlPatterns(prefix, routerMount.pattern), namespace);
      }

      for (const include of urlModule.includes) {
        const target = lookupModule(include.module);
        const childPrefix = this.joinUrlPatterns(prefix, include.pattern);
        if (target) {
          walk(target, childPrefix, include.namespace || namespace, visited);
        } else {
          emit(urlModule.file, {
            pattern: childPrefix,
            view: include.raw,
            namespace: include.namespace || namespace,
            included: true,
            sourceFile: urlModule.file
          });
        }
      }

      visited.delete(urlModule.module);
    };

    for (const urlModule of modules.values()) {
      if (includedModules.has(urlModule.module)) continue;
      walk(urlModule, '', undefined, new Set());
    }

    for (const urlModule of modules.values()) {
      if (!includedModules.has(urlModule.module)) continue;
      if (urlsByFile.has(urlModule.file)) continue;
      walk(urlModule, '', undefined, new Set());
    }

    return urlsByFile;
  }

  private extractBalancedParens(content: string, openParenIndex: number): string | undefined {
    if (content[openParenIndex] !== '(') return undefined;
    let depth = 0;
    let inString: string | undefined;
    for (let index = openParenIndex; index < content.length; index++) {
      const char = content[index];
      if (inString) {
        if (char === '\\') {
          index++;
        } else if (char === inString) {
          inString = undefined;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        inString = char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') depth++;
      if (char === ')' || char === ']' || char === '}') {
        depth--;
        if (depth === 0) return content.substring(openParenIndex + 1, index);
      }
    }
    return undefined;
  }

  private splitTopLevelArgs(argsRaw: string | undefined): string[] {
    if (argsRaw === undefined) return [];
    const args: string[] = [];
    let depth = 0;
    let inString: string | undefined;
    let current = '';
    for (let index = 0; index < argsRaw.length; index++) {
      const char = argsRaw[index];
      if (inString) {
        current += char;
        if (char === '\\') {
          current += argsRaw[index + 1] || '';
          index++;
        } else if (char === inString) {
          inString = undefined;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        inString = char;
        current += char;
        continue;
      }
      if (char === '(' || char === '[' || char === '{') depth++;
      if (char === ')' || char === ']' || char === '}') depth--;
      if (char === ',' && depth === 0) {
        if (current.trim()) args.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim()) args.push(current.trim());
    return args;
  }

  private unquotePattern(expr: string): string | undefined {
    const match = expr.trim().match(/^[rbu]{0,2}(['"])([\s\S]*)\1$/);
    return match ? match[2] : undefined;
  }

  private cleanRegexPattern(pattern: string): string {
    return pattern
      .replace(/^\^/, '')
      .replace(/\$$/, '')
      .replace(/\(\?P<(\w+)>[^)]*\)/g, '<$1>')
      .replace(/\\\./g, '.')
      .replace(/\\\//g, '/');
  }

  private joinUrlPatterns(prefix: string, pattern: string): string {
    const left = prefix || '';
    const right = pattern || '';
    if (!left) return right;
    if (!right) return left;
    return `${left.replace(/\/+$/, '/')}${right.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  }

  private async analyzeAdmin(files: string[], projectPath: string, appDir: string): Promise<DjangoAdmin[]> {
    const admin: DjangoAdmin[] = [];
    const adminFile = files.find(f => f === path.join(appDir, 'admin.py'));

    if (adminFile) {
      const content = await fs.readFile(path.join(projectPath, adminFile), 'utf-8');
      const extractedAdmin = this.extractAdmin(content, adminFile);
      admin.push(...extractedAdmin);
    }

    return admin;
  }

  private async analyzeForms(files: string[], projectPath: string, appDir: string): Promise<DjangoForm[]> {
    const forms: DjangoForm[] = [];
    const formsFile = files.find(f => f === path.join(appDir, 'forms.py'));

    if (formsFile) {
      const content = await fs.readFile(path.join(projectPath, formsFile), 'utf-8');
      const extractedForms = this.extractForms(content, formsFile);
      forms.push(...extractedForms);
    }

    return forms;
  }

  private async analyzeSerializers(files: string[], projectPath: string, appDir: string): Promise<DjangoSerializer[]> {
    const serializers: DjangoSerializer[] = [];
    const serializersFiles = files.filter(f =>
      this.inAppDir(f, appDir) &&
      (f.endsWith('/serializers.py') || f === path.join(appDir, 'serializers.py'))
    );

    for (const serializersFile of serializersFiles) {
      const content = await fs.readFile(path.join(projectPath, serializersFile), 'utf-8');
      const extractedSerializers = this.extractSerializers(content, serializersFile);
      serializers.push(...extractedSerializers);
    }

    return serializers;
  }

  private async analyzeGraphQLMutations(files: string[], projectPath: string, appDir: string): Promise<GraphQLMutation[]> {
    const mutations: GraphQLMutation[] = [];

    const mutationsFiles = files.filter(f =>
      f.includes('schemas/mutations.py') ||
      f.includes('graphql/mutations.py') ||
      (f.includes('mutations.py') && this.inAppDir(f, appDir))
    );

    for (const file of mutationsFiles) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      const extracted = this.extractGraphQLMutations(content, file);
      mutations.push(...extracted);
    }

    return mutations;
  }

  private async analyzeGraphQLQueries(files: string[], projectPath: string, appDir: string): Promise<GraphQLQuery[]> {
    const queries: GraphQLQuery[] = [];

    const queryFiles = files.filter(f =>
      f.includes('schemas/queries.py') ||
      f.includes('graphql/queries.py') ||
      (f.includes('queries.py') && this.inAppDir(f, appDir))
    );

    for (const file of queryFiles) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      const extracted = this.extractGraphQLQueries(content, file);
      queries.push(...extracted);
    }

    return queries;
  }

  private async analyzeGraphQLTypes(files: string[], projectPath: string, appDir: string): Promise<GraphQLType[]> {
    const types: GraphQLType[] = [];

    const typeFiles = files.filter(f =>
      f.includes('schemas/types.py') ||
      f.includes('graphql/types.py') ||
      (f.includes('types.py') && this.inAppDir(f, appDir) && !f.includes('__pycache__'))
    );

    for (const file of typeFiles) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      const extracted = this.extractGraphQLTypes(content, file);
      types.push(...extracted);
    }

    return types;
  }

  private async analyzeCeleryTasks(files: string[], projectPath: string, appDir: string): Promise<CeleryTask[]> {
    const tasks: CeleryTask[] = [];

    const taskFiles = files.filter(f =>
      f === path.join(appDir, 'tasks.py') ||
      (f.includes('tasks.py') && this.inAppDir(f, appDir))
    );

    for (const file of taskFiles) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      const extracted = this.extractCeleryTasks(content, file);
      tasks.push(...extracted);
    }

    return tasks;
  }

  private extractGraphQLMutations(content: string, filePath: string): GraphQLMutation[] {
    const mutations: GraphQLMutation[] = [];

    const customMutationPattern = /class\s+(\w+)\s*\(\s*(graphene\.Mutation|CustomMutation|Mutation)\s*\):/g;
    let match;
    while ((match = customMutationPattern.exec(content)) !== null) {
      const className = match[1];
      const baseClass = match[2];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const args = this.extractGraphQLArguments(classContent);
      const returnType = this.extractGraphQLReturnType(classContent);
      const resolverMethod = classContent.includes('resolve_mutation') ? 'resolve_mutation' : 'mutate';

      mutations.push({
        name: this.camelToSnakeCase(className),
        filePath,
        className,
        baseClass,
        mutationType: 'custom',
        arguments: args,
        returnType,
        resolverMethod,
        modelAccesses: this.extractModelAccesses(classContent, content)
      });
    }

    const objectTypePattern = /class\s+(\w+)\s*\(\s*graphene\.ObjectType\s*\):/g;
    while ((match = objectTypePattern.exec(content)) !== null) {
      const containerClassName = match[1];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const createFieldPattern = /(\w+)\s*=\s*(\w+)\.CreateField\(\)/g;
      let fieldMatch;
      while ((fieldMatch = createFieldPattern.exec(classContent)) !== null) {
        const fieldName = fieldMatch[1];
        const typeName = fieldMatch[2];
        mutations.push({
          name: fieldName,
          filePath,
          className: containerClassName,
          baseClass: typeName,
          mutationType: 'crud-create',
          arguments: [{ name: 'input', type: `${typeName}Input`, required: true }],
          returnType: typeName,
          resolverMethod: 'create'
        });
      }

      const updateFieldPattern = /(\w+)\s*=\s*(\w+)\.UpdateField\(\)/g;
      while ((fieldMatch = updateFieldPattern.exec(classContent)) !== null) {
        const fieldName = fieldMatch[1];
        const typeName = fieldMatch[2];
        mutations.push({
          name: fieldName,
          filePath,
          className: containerClassName,
          baseClass: typeName,
          mutationType: 'crud-update',
          arguments: [
            { name: 'id', type: 'ID', required: true },
            { name: 'input', type: `${typeName}Input`, required: true }
          ],
          returnType: typeName,
          resolverMethod: 'update'
        });
      }

      const deleteFieldPattern = /(\w+)\s*=\s*(\w+)\.DeleteField\(\)/g;
      while ((fieldMatch = deleteFieldPattern.exec(classContent)) !== null) {
        const fieldName = fieldMatch[1];
        const typeName = fieldMatch[2];
        mutations.push({
          name: fieldName,
          filePath,
          className: containerClassName,
          baseClass: typeName,
          mutationType: 'crud-delete',
          arguments: [{ name: 'id', type: 'ID', required: true }],
          returnType: 'Boolean',
          resolverMethod: 'delete'
        });
      }

      const customFieldPattern = /(\w+)\s*=\s*(\w+)\.Field\(\)/g;
      while ((fieldMatch = customFieldPattern.exec(classContent)) !== null) {
        const fieldName = fieldMatch[1];
        const typeName = fieldMatch[2];
        if (!mutations.find(m => m.name === fieldName)) {
          mutations.push({
            name: fieldName,
            filePath,
            className: containerClassName,
            baseClass: typeName,
            mutationType: 'custom',
            arguments: [],
            returnType: typeName,
            resolverMethod: 'mutate'
          });
        }
      }
    }

    return mutations;
  }

  private extractGraphQLQueries(content: string, filePath: string): GraphQLQuery[] {
    const queries: GraphQLQuery[] = [];

    const objectTypePattern = /class\s+(\w+)\s*\(\s*graphene\.ObjectType\s*\):/g;
    let match;
    while ((match = objectTypePattern.exec(content)) !== null) {
      const containerClassName = match[1];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const readFieldPattern = /(\w+)\s*=\s*(\w+)\.ReadField\(\)/g;
      let fieldMatch;
      while ((fieldMatch = readFieldPattern.exec(classContent)) !== null) {
        const fieldName = fieldMatch[1];
        const typeName = fieldMatch[2];
        queries.push({
          name: fieldName,
          filePath,
          className: containerClassName,
          queryType: 'single',
          returnType: typeName,
          arguments: [{ name: 'id', type: 'ID', required: true }]
        });
      }

      const batchReadPattern = /(\w+)\s*=\s*(\w+)\.BatchReadField\(\)/g;
      while ((fieldMatch = batchReadPattern.exec(classContent)) !== null) {
        const fieldName = fieldMatch[1];
        const typeName = fieldMatch[2];
        queries.push({
          name: fieldName,
          filePath,
          className: containerClassName,
          queryType: 'batch',
          returnType: `[${typeName}]`,
          arguments: [
            { name: 'first', type: 'Int', required: false },
            { name: 'after', type: 'String', required: false },
            { name: 'filters', type: 'JSON', required: false }
          ]
        });
      }

      const customFieldPattern = /(\w+)\s*=\s*graphene\.Field\s*\(\s*(\w+)/g;
      while ((fieldMatch = customFieldPattern.exec(classContent)) !== null) {
        const fieldName = fieldMatch[1];
        const typeName = fieldMatch[2];
        if (!queries.find(q => q.name === fieldName)) {
          queries.push({
            name: fieldName,
            filePath,
            className: containerClassName,
            queryType: 'custom',
            returnType: typeName,
            arguments: []
          });
        }
      }

      const listFieldPattern = /(\w+)\s*=\s*graphene\.List\s*\(\s*(\w+)/g;
      while ((fieldMatch = listFieldPattern.exec(classContent)) !== null) {
        const fieldName = fieldMatch[1];
        const typeName = fieldMatch[2];
        if (!queries.find(q => q.name === fieldName)) {
          queries.push({
            name: fieldName,
            filePath,
            className: containerClassName,
            queryType: 'batch',
            returnType: `[${typeName}]`,
            arguments: []
          });
        }
      }
    }

    return queries;
  }

  private extractGraphQLTypes(content: string, filePath: string): GraphQLType[] {
    const types: GraphQLType[] = [];

    const typeBaseClasses = [
      'DjangoObjectType',
      'DjangoCRUDObjectType',
      'DjangoCRUDObjectTypeWithRoles',
      'graphene.ObjectType',
      'ObjectType'
    ];

    const typePattern = /class\s+(\w+)\s*\(\s*([^)]+)\s*\):/g;
    let match;
    while ((match = typePattern.exec(content)) !== null) {
      const typeName = match[1];
      const baseClass = match[2].trim();

      const isGraphQLType = typeBaseClasses.some(base => baseClass.includes(base));
      if (!isGraphQLType) continue;

      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const model = this.extractMetaModel(classContent);
      const fields = this.extractGraphQLTypeFields(classContent);
      const resolvers = this.extractGraphQLResolvers(classContent);
      const excludeFields = this.extractMetaExcludeFields(classContent);

      types.push({
        name: typeName,
        filePath,
        baseClass,
        model,
        fields,
        resolvers,
        excludeFields
      });
    }

    return types;
  }

  private extractCeleryTasks(content: string, filePath: string): CeleryTask[] {
    const tasks: CeleryTask[] = [];

    const taskPattern = /@shared_task\s*(?:\([^)]*\))?\s*\n\s*def\s+(\w+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = taskPattern.exec(content)) !== null) {
      const taskName = match[1];
      const argsStr = match[2];
      const decoratorStart = content.lastIndexOf('@shared_task', match.index);
      const decoratorLine = content.substring(decoratorStart, match.index + match[0].length);

      const isBound = decoratorLine.includes('bind=True');
      const args = this.parseTaskArguments(argsStr, isBound);

      const funcStart = match.index;
      const funcEnd = this.findFunctionEnd(content, funcStart);
      const funcContent = content.substring(funcStart, funcEnd);

      const docstringMatch = funcContent.match(/"""([\s\S]*?)"""/);
      const description = docstringMatch ? docstringMatch[1].trim().split('\n')[0] : undefined;

      const retryMatch = funcContent.match(/retry\s*\([^)]*countdown\s*=\s*(\d+)/);
      const maxRetriesMatch = funcContent.match(/max_retries\s*=\s*(\d+)/);

      tasks.push({
        name: taskName,
        filePath,
        decorators: ['shared_task'],
        isBound,
        arguments: args,
        description,
        retryPolicy: (retryMatch || maxRetriesMatch) ? {
          countdown: retryMatch ? parseInt(retryMatch[1]) : undefined,
          maxRetries: maxRetriesMatch ? parseInt(maxRetriesMatch[1]) : undefined
        } : undefined,
        modelAccesses: this.extractModelAccesses(funcContent, content)
      });
    }

    const appTaskPattern = /@app\.task\s*(?:\([^)]*\))?\s*\n\s*def\s+(\w+)\s*\(([^)]*)\)/g;
    while ((match = appTaskPattern.exec(content)) !== null) {
      const taskName = match[1];
      const argsStr = match[2];
      const decoratorStart = content.lastIndexOf('@app.task', match.index);
      const decoratorLine = content.substring(decoratorStart, match.index + match[0].length);

      const isBound = decoratorLine.includes('bind=True');
      const args = this.parseTaskArguments(argsStr, isBound);
      const funcStart = match.index;
      const funcEnd = this.findFunctionEnd(content, funcStart);
      const funcContent = content.substring(funcStart, funcEnd);

      tasks.push({
        name: taskName,
        filePath,
        decorators: ['app.task'],
        isBound,
        arguments: args,
        modelAccesses: this.extractModelAccesses(funcContent, content)
      });
    }

    const celeryTaskPattern = /@celery_app\.task\s*(?:\([^)]*\))?\s*\n\s*def\s+(\w+)\s*\(([^)]*)\)/g;
    while ((match = celeryTaskPattern.exec(content)) !== null) {
      const taskName = match[1];
      const argsStr = match[2];
      const decoratorStart = content.lastIndexOf('@celery_app.task', match.index);
      const decoratorLine = content.substring(decoratorStart, match.index + match[0].length);

      const isBound = decoratorLine.includes('bind=True');
      const args = this.parseTaskArguments(argsStr, isBound);

      tasks.push({
        name: taskName,
        filePath,
        decorators: ['celery_app.task'],
        isBound,
        arguments: args
      });
    }

    return tasks;
  }

  private extractGraphQLArguments(content: string): Array<{ name: string; type: string; required: boolean }> {
    const args: Array<{ name: string; type: string; required: boolean }> = [];

    const argsClassPattern = /class\s+Arguments\s*:([^}]*?)(?=\n\s*\n|\n\s*def|\n\s*@|\n\s*class|\Z)/s;
    const argsMatch = argsClassPattern.exec(content);

    if (argsMatch) {
      const argsContent = argsMatch[1];
      const argPattern = /(\w+)\s*=\s*graphene\.(\w+)\s*\(([^)]*)\)/g;
      let argMatch;
      while ((argMatch = argPattern.exec(argsContent)) !== null) {
        const argName = argMatch[1];
        const argType = argMatch[2];
        const argOptions = argMatch[3];
        const required = argOptions.includes('required=True');
        args.push({ name: argName, type: argType, required });
      }
    }

    return args;
  }

  private extractGraphQLReturnType(content: string): string | undefined {
    const responseTypePattern = /def\s+response_type\s*\([^)]*\):\s*return\s+(\w+)/;
    const match = responseTypePattern.exec(content);
    if (match) return match[1];

    const fieldPattern = /(\w+)\s*=\s*graphene\.Field\s*\(\s*(\w+)/;
    const fieldMatch = fieldPattern.exec(content);
    if (fieldMatch) return fieldMatch[2];

    return undefined;
  }

  private extractMetaModel(content: string): string | undefined {
    const modelPattern = /class\s+Meta\s*:[\s\S]*?model\s*=\s*(\w+)/;
    const match = modelPattern.exec(content);
    return match ? match[1] : undefined;
  }

  private extractMetaExcludeFields(content: string): string[] {
    const excludePattern = /exclude_fields\s*=\s*\(([^)]+)\)/;
    const match = excludePattern.exec(content);
    if (match) {
      return match[1].split(',').map(f => f.trim().replace(/['"]/g, '')).filter(f => f.length > 0);
    }
    return [];
  }

  private extractGraphQLTypeFields(content: string): Array<{ name: string; type: string }> {
    const fields: Array<{ name: string; type: string }> = [];

    const fieldPattern = /(\w+)\s*=\s*graphene\.(\w+)\s*\(/g;
    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      if (!match[1].startsWith('_') && match[1] !== 'Meta') {
        fields.push({ name: match[1], type: match[2] });
      }
    }

    return fields;
  }

  private extractGraphQLResolvers(content: string): string[] {
    const resolvers: string[] = [];
    const resolverPattern = /def\s+(resolve_\w+)\s*\(/g;
    let match;
    while ((match = resolverPattern.exec(content)) !== null) {
      resolvers.push(match[1]);
    }
    return resolvers;
  }

  private parseTaskArguments(argsStr: string, isBound: boolean): Array<{ name: string; type?: string; default?: string }> {
    const args: Array<{ name: string; type?: string; default?: string }> = [];

    const parts = argsStr.split(',').map(p => p.trim()).filter(p => p.length > 0);

    for (const part of parts) {
      if (isBound && part === 'self') continue;

      const [nameAndType, defaultVal] = part.split('=').map(s => s.trim());
      const colonIndex = nameAndType.indexOf(':');

      let name: string;
      let type: string | undefined;

      if (colonIndex !== -1) {
        name = nameAndType.substring(0, colonIndex).trim();
        type = nameAndType.substring(colonIndex + 1).trim();
      } else {
        name = nameAndType;
      }

      if (name && name !== 'self') {
        args.push({
          name,
          type,
          default: defaultVal
        });
      }
    }

    return args;
  }

  private camelToSnakeCase(str: string): string {
    return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
  }


  private extractSettings(content: string, filePath: string): DjangoSettings {
    const debug = content.includes('DEBUG = True');
    const installedApps = this.extractListVariable(content, 'INSTALLED_APPS');
    const middleware = this.extractListVariable(content, 'MIDDLEWARE');
    const databases = this.extractDatabases(content);
    const staticUrl = this.extractStringVariable(content, 'STATIC_URL') || '/static/';
    const mediaUrl = this.extractStringVariable(content, 'MEDIA_URL') || '/media/';
    const allowedHosts = this.extractListVariable(content, 'ALLOWED_HOSTS');

    return {
      filePath,
      debug,
      installedApps,
      middleware,
      databases,
      staticUrl,
      mediaUrl,
      allowedHosts
    };
  }

  private extractViews(content: string, filePath: string): DjangoView[] {
    const views: DjangoView[] = [];

    const functionViews = this.extractFunctionViews(content, filePath);
    const classViews = this.extractClassViews(content, filePath);

    views.push(...functionViews, ...classViews);
    return views;
  }

  private extractAdmin(content: string, filePath: string): DjangoAdmin[] {
    const admin: DjangoAdmin[] = [];
    const adminPattern = /class\s+(\w+)\s*\(\s*admin\.ModelAdmin\s*\):/g;

    let match;
    while ((match = adminPattern.exec(content)) !== null) {
      const adminName = match[1];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const model = this.extractAdminModel(content, adminName);
      const listDisplay = this.extractListVariable(classContent, 'list_display');
      const listFilter = this.extractListVariable(classContent, 'list_filter');
      const searchFields = this.extractListVariable(classContent, 'search_fields');
      const readonly = this.extractListVariable(classContent, 'readonly_fields');
      const inlines = this.extractListVariable(classContent, 'inlines');

      admin.push({
        name: adminName,
        filePath,
        model,
        listDisplay,
        listFilter,
        searchFields,
        readonly,
        inlines
      });
    }

    return admin;
  }

  private extractForms(content: string, filePath: string): DjangoForm[] {
    const forms: DjangoForm[] = [];
    const formPattern = /class\s+(\w+)\s*\(\s*(forms\.\w+)\s*\):/g;

    let match;
    while ((match = formPattern.exec(content)) !== null) {
      const formName = match[1];
      const baseClass = match[2];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const fields = this.extractFormFields(classContent);
      const meta = this.extractFormMeta(classContent);

      forms.push({
        name: formName,
        filePath,
        baseClass,
        fields,
        meta
      });
    }

    return forms;
  }

  private extractSerializers(content: string, filePath: string): DjangoSerializer[] {
    const serializers: DjangoSerializer[] = [];
    const serializerPattern = /class\s+(\w+)\s*\(\s*((?:[\w.]+\s*,\s*)*[\w.]*Serializer\w*(?:\s*,\s*[\w.]+)*)\s*\):/g;

    let match;
    while ((match = serializerPattern.exec(content)) !== null) {
      const serializerName = match[1];
      const baseClass = match[2];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const fields = this.extractSerializerFields(classContent);
      const meta = this.extractSerializerMeta(classContent);

      serializers.push({
        name: serializerName,
        filePath,
        baseClass,
        fields,
        meta
      });
    }

    return serializers;
  }


  private extractListVariable(content: string, varName: string): string[] {
    const pattern = new RegExp(`${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'g');
    const match = pattern.exec(content);

    if (match) {
      const listContent = match[1];
      const items = listContent.split(',').map(item =>
        item.trim().replace(/['"]/g, '').trim()
      ).filter(item => item.length > 0);
      return items;
    }

    return [];
  }

  private extractStringVariable(content: string, varName: string): string | null {
    const pattern = new RegExp(`${varName}\\s*=\\s*['"]([^'"]+)['"]`);
    const match = pattern.exec(content);
    return match ? match[1] : null;
  }

  private extractDatabases(content: string): Array<{ name: string; engine: string; config: Record<string, any> }> {
    const databases: Array<{ name: string; engine: string; config: Record<string, any> }> = [];
    const dbPattern = /DATABASES\s*=\s*{([^}]+)}/;
    const match = dbPattern.exec(content);

    if (match) {
      databases.push({
        name: 'default',
        engine: 'postgresql',
        config: {}
      });
    }

    return databases;
  }

  private extractRootUrlconf(content: string): string {
    const pattern = /ROOT_URLCONF\s*=\s*['"]([^'"]+)['"]/;
    const match = pattern.exec(content);
    return match ? match[1] : 'urls';
  }

  private extractModelFields(content: string): Array<{ name: string; type: string; options: Record<string, any> }> {
    const fields: Array<{ name: string; type: string; options: Record<string, any> }> = [];
    const fieldPattern = /^\s+(\w+)\s*=\s*(?:\w+\.)?(\w*Field|ForeignKey|OneToOneField|ManyToManyField)\s*\(/gm;
    const seen = new Set<string>();

    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      const name = match[1];
      const type = match[2];
      if (seen.has(name)) continue;
      seen.add(name);

      fields.push({
        name,
        type,
        options: {}
      });
    }

    return fields;
  }

  private extractModelRelationships(content: string): Array<{ type: string; target: string; relatedName?: string }> {
    const relationships: Array<{ type: string; target: string; relatedName?: string }> = [];
    const relationPattern = /(\w+)\s*=\s*(?:\w+\.)?(ForeignKey|OneToOneField|ManyToManyField)\s*\(\s*(?:to\s*=\s*)?(settings\.AUTH_USER_MODEL|['"][\w.]+['"]|\w+)/g;

    let match;
    while ((match = relationPattern.exec(content)) !== null) {
      const type = match[2];
      const rawTarget = match[3].replace(/['"]/g, '');

      let target = rawTarget;
      if (rawTarget === 'settings.AUTH_USER_MODEL' || rawTarget === 'AUTH_USER_MODEL') {
        target = 'User';
      } else if (rawTarget.includes('.')) {
        target = rawTarget.split('.').pop() || rawTarget;
      }

      relationships.push({
        type,
        target
      });
    }

    return relationships;
  }

  private extractModelMeta(content: string): { dbTable?: string; ordering?: string[]; verbose?: string } {
    const meta: { dbTable?: string; ordering?: string[]; verbose?: string } = {};
    const metaPattern = /class\s+Meta\s*:([^}]*?)(?=class|\Z)/;
    const metaMatch = metaPattern.exec(content);

    if (metaMatch) {
      const metaContent = metaMatch[1];

      const dbTableMatch = /db_table\s*=\s*['"]([^'"]+)['"]/;
      const dbTableResult = dbTableMatch.exec(metaContent);
      if (dbTableResult) meta.dbTable = dbTableResult[1];
    }

    return meta;
  }

  private extractModelMethods(content: string): Array<{ name: string; isProperty: boolean; isClassMethod: boolean }> {
    const methods: Array<{ name: string; isProperty: boolean; isClassMethod: boolean }> = [];
    const methodPattern = /def\s+(\w+)\s*\(/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const name = match[1];
      if (name !== '__init__' && name !== '__str__' && name !== '__repr__') {
        methods.push({
          name,
          isProperty: content.includes(`@property\n    def ${name}`),
          isClassMethod: content.includes(`@classmethod\n    def ${name}`)
        });
      }
    }

    return methods;
  }

  private extractFunctionViews(content: string, filePath: string): DjangoView[] {
    const views: DjangoView[] = [];
    const functionPattern = /def\s+(\w+)\s*\([^)]*request[^)]*\):/g;

    let match;
    while ((match = functionPattern.exec(content)) !== null) {
      const viewName = match[1];
      const functionStart = match.index;
      const functionEnd = this.findFunctionEnd(content, functionStart);
      const functionContent = content.substring(functionStart, functionEnd);

      const decorators = this.extractDecorators(content, functionStart);
      const serializerReferences = this.extractSerializerInstantiations(functionContent, content);
      const serializerWrites = this.extractSerializerWrites(functionContent);
      const modelReferences = this.extractModelReferences(functionContent, content);
      const modelAccesses = this.extractModelAccesses(functionContent, content);
      const owningClass = this.findOwningClass(content, functionStart);

      views.push({
        name: viewName,
        filePath,
        type: 'function',
        owningClass,


        methods: this.extractApiViewMethods(content, functionStart),
        decorators,
        permissions: this.extractPermissions(decorators),
        serializerReferences,
        serializerWrites,
        modelReferences,
        modelAccesses
      });
    }

    return views;
  }

  private findOwningClass(content: string, functionStart: number): string | undefined {
    const lineStart = content.lastIndexOf('\n', functionStart - 1) + 1;
    const indent = content.substring(lineStart, functionStart);
    if (indent.length === 0 || /\S/.test(indent)) {
      return undefined;
    }

    const classPattern = /^([ \t]*)class\s+(\w+)/gm;
    let owningClass: string | undefined;
    let match;
    while ((match = classPattern.exec(content)) !== null) {
      if (match.index >= functionStart) break;
      if (match[1].length >= indent.length) continue;
      const classEnd = this.findClassEnd(content, match.index);
      if (classEnd > functionStart) {
        owningClass = match[2];
      }
    }

    return owningClass;
  }

  private viewNodeId(appId: string, view: DjangoView): string {
    return view.owningClass
      ? `view_${appId}_${this.sanitizeId(view.owningClass)}_${this.sanitizeId(view.name)}`
      : `view_${appId}_${this.sanitizeId(view.name)}`;
  }

  private extractClassViews(content: string, filePath: string): DjangoView[] {
    const views: DjangoView[] = [];
    const classPattern = /class\s+(\w+)\s*\(\s*([^)]+)\s*\):/g;

    const viewBaseClasses = [
      'View', 'APIView', 'GenericAPIView', 'ViewSet', 'ModelViewSet',
      'GenericViewSet', 'ReadOnlyModelViewSet', 'CreateAPIView',
      'ListAPIView', 'RetrieveAPIView', 'DestroyAPIView', 'UpdateAPIView',
      'ListCreateAPIView', 'RetrieveUpdateAPIView', 'RetrieveDestroyAPIView',
      'RetrieveUpdateDestroyAPIView', 'TemplateView', 'ListView', 'DetailView',
      'CreateView', 'UpdateView', 'DeleteView', 'FormView', 'RedirectView'
    ];

    let match;
    while ((match = classPattern.exec(content)) !== null) {
      const viewName = match[1];
      const baseClass = match[2].trim();

      const isView = viewBaseClasses.some(base =>
        baseClass.includes(base) ||
        baseClass.split(',').some(b => b.trim().endsWith(base))
      );

      if (isView) {
        const classStart = match.index;
        const classEnd = this.findClassEnd(content, classStart);
        const classContent = content.substring(classStart, classEnd);

        const methods = this.extractViewMethods(classContent);
        const decorators = this.extractDecorators(content, classStart);
        const classDecorators = this.extractClassDecorators(content, classStart);
        const allDecorators = [...new Set([...decorators, ...classDecorators])];

        const permissionClasses = this.extractPermissionClasses(classContent);
        const authenticationClasses = this.extractAuthenticationClasses(classContent);

        const serializerClass = this.extractSerializerClassAttribute(classContent);
        const serializerReferences = this.extractSerializerInstantiations(classContent, content);
        const serializerWrites = this.extractSerializerWrites(classContent, baseClass, serializerClass);
        const modelReferences = this.extractModelReferences(classContent, content);
        const modelAccesses = this.extractModelAccesses(classContent, content);
        const querysetModel = this.extractQuerysetModel(classContent);

        views.push({
          name: viewName,
          filePath,
          type: 'class',
          baseClass,
          methods: methods.length > 0 ? methods : this.inferMethodsFromBaseClass(baseClass),
          decorators: allDecorators,
          permissions: [...this.extractPermissions(allDecorators), ...permissionClasses, ...authenticationClasses],
          serializerClass,
          serializerReferences,
          serializerWrites,
          modelReferences,
          modelAccesses,
          querysetModel
        });
      }
    }

    return views;
  }



  private extractApiViewMethods(content: string, functionStart: number): string[] {
    const before = content.substring(Math.max(0, functionStart - 600), functionStart);


    const matches = [...before.matchAll(/@api_view\s*\(\s*\[([^\]]*)\]/g)];
    if (matches.length === 0) return [];
    return matches[matches.length - 1][1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, '').toUpperCase())
      .filter(Boolean);
  }

  private extractClassDecorators(content: string, classStart: number): string[] {
    const decorators: string[] = [];
    const lines = content.substring(0, classStart).split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('@')) {
        const decoratorMatch = line.match(/@(\w+)(?:\([^)]*\))?/);
        if (decoratorMatch) {
          decorators.unshift(decoratorMatch[1]);
        }
      } else if (line && !line.startsWith('#') && !line.startsWith('@')) {
        break;
      }
    }

    return decorators;
  }

  private extractPermissionClasses(content: string): string[] {
    const permissions: string[] = [];
    const permissionPattern = /permission_classes\s*=\s*\[([^\]]+)\]/;
    const match = permissionPattern.exec(content);

    if (match) {
      const classList = match[1];
      const classNames = classList.split(',').map(c => c.trim()).filter(c => c.length > 0);
      permissions.push(...classNames);
    }

    return permissions;
  }

  private extractAuthenticationClasses(content: string): string[] {
    const authClasses: string[] = [];
    const authPattern = /authentication_classes\s*=\s*\[([^\]]+)\]/;
    const match = authPattern.exec(content);

    if (match) {
      const classList = match[1];
      const classNames = classList.split(',').map(c => c.trim()).filter(c => c.length > 0);
      authClasses.push(...classNames);
    }

    return authClasses;
  }

  private extractSerializerClassAttribute(classContent: string): string | undefined {
    const pattern = /serializer_class\s*=\s*(\w+)/;
    const match = pattern.exec(classContent);
    return match ? match[1] : undefined;
  }

  private extractSerializerInstantiations(scopeContent: string, fullContent: string): string[] {
    const serializers: string[] = [];
    const importedSerializers = this.extractImportedSerializers(fullContent);
    const instantiationPattern = /(\w+Serializer)\s*\(/g;

    let match;
    while ((match = instantiationPattern.exec(scopeContent)) !== null) {
      const serializerName = match[1];
      if (importedSerializers.includes(serializerName) || serializerName.endsWith('Serializer')) {
        if (!serializers.includes(serializerName)) {
          serializers.push(serializerName);
        }
      }
    }

    return serializers;
  }

  extractSerializerWrites(scopeContent: string, baseClass?: string, serializerClass?: string): DjangoSerializerWrite[] {
    const writes = new Map<string, DjangoSerializerWrite>();
    const record = (serializer: string, access: DjangoSerializerWrite['access']) => {
      writes.set(`${serializer}:${access}`, { serializer, access });
    };

    if (/\.save\s*\(/.test(scopeContent)) {
      const createPattern = /(\w+Serializer)\s*\(\s*data\s*=/g;
      let match;
      while ((match = createPattern.exec(scopeContent)) !== null) {
        record(match[1], 'creates');
      }

      const updatePattern = /(\w+Serializer)\s*\(\s*(?:instance\s*=\s*)?(?!data\s*=)[\w.]+(?:\(\s*\))?(?:\[[^\]]*\])?\s*,\s*data\s*=/g;
      while ((match = updatePattern.exec(scopeContent)) !== null) {
        record(match[1], 'updates');
      }
    }

    if (serializerClass && baseClass) {
      const bases = baseClass.split(',').map(b => (b.trim().split('.').pop() || '').trim());
      if (bases.includes('ModelViewSet')) {
        record(serializerClass, 'creates');
        record(serializerClass, 'updates');
      }
      if (bases.some(b => b === 'CreateAPIView' || b === 'ListCreateAPIView' || b === 'CreateModelMixin')) {
        record(serializerClass, 'creates');
      }
      if (bases.some(b => b === 'UpdateAPIView' || b === 'RetrieveUpdateAPIView' || b === 'RetrieveUpdateDestroyAPIView' || b === 'UpdateModelMixin')) {
        record(serializerClass, 'updates');
      }
    }

    return [...writes.values()];
  }

  private extractImportedSerializers(content: string): string[] {
    const serializers: string[] = [];
    const importPattern = /from\s+[\w.]+serializers?\s+import\s+\(?\s*([^)]+)\)?/g;
    const singleImportPattern = /from\s+[\w.]+\s+import\s+.*?(\w+Serializer)/g;

    let match;
    while ((match = importPattern.exec(content)) !== null) {
      const imports = match[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
      for (const imp of imports) {
        const cleanName = imp.split(/\s+as\s+/)[0].trim();
        if (cleanName.endsWith('Serializer') || cleanName.includes('Serializer')) {
          serializers.push(cleanName);
        }
      }
    }

    while ((match = singleImportPattern.exec(content)) !== null) {
      if (!serializers.includes(match[1])) {
        serializers.push(match[1]);
      }
    }

    return serializers;
  }

  private extractModelReferences(scopeContent: string, fullContent: string): string[] {
    const models: string[] = [];
    const importedModels = this.extractImportedModels(fullContent);
    const objectsPattern = /(\w+)\.objects\./g;

    let match;
    while ((match = objectsPattern.exec(scopeContent)) !== null) {
      const modelName = match[1];
      if (importedModels.includes(modelName) && !models.includes(modelName)) {
        models.push(modelName);
      }
    }

    return models;
  }

  isSensitiveModelField(name: string, type: string): boolean {
    const sensitiveTypes = new Set(['EmailField']);
    if (sensitiveTypes.has(type)) return true;

    const nameLower = name.toLowerCase();
    const tokens = nameLower.split(/[^a-z0-9]+/).filter(Boolean);
    const substringPatterns = [
      'password', 'passwd', 'secret', 'token', 'credential',
      'social_security', 'date_of_birth', 'account_number',
      'routing_number', 'email', 'phone', 'address', 'salary'
    ];
    const tokenPatterns = ['ssn', 'card', 'cvv', 'iban', 'dob', 'tax_id'];

    if (substringPatterns.some(pattern => nameLower.includes(pattern))) return true;
    return tokenPatterns.some(pattern =>
      pattern.includes('_') ? nameLower.includes(pattern) : tokens.includes(pattern)
    );
  }

  extractModelAccesses(scopeContent: string, fullContent: string): DjangoModelAccess[] {
    const knownModels = new Set([
      ...this.extractImportedModels(fullContent),
      ...this.extractLocalModelDefinitions(fullContent)
    ]);
    const isCandidate = (name: string) => knownModels.has(name) || /^[A-Z]/.test(name);

    const managerAccessByMethod: Record<string, DjangoModelAccess['access']> = {
      create: 'creates',
      bulk_create: 'creates',
      get_or_create: 'creates',
      save: 'creates',
      update: 'updates',
      bulk_update: 'updates',
      update_or_create: 'updates',
      delete: 'deletes',
    };

    const accesses = new Map<string, DjangoModelAccess>();
    const record = (model: string, access: DjangoModelAccess['access']) => {
      accesses.set(`${model}:${access}`, { model, access });
    };

    const managerCallPattern = /(\w+)\.objects\.(\w+)/g;
    let match;
    while ((match = managerCallPattern.exec(scopeContent)) !== null) {
      const model = match[1];
      if (!isCandidate(model)) continue;
      record(model, managerAccessByMethod[match[2]] || 'reads');
    }

    const chainedWritePattern = /(\w+)\.objects\b[^\n]*?\.(update|delete)\s*\(/g;
    while ((match = chainedWritePattern.exec(scopeContent)) !== null) {
      const model = match[1];
      if (!isCandidate(model)) continue;
      record(model, match[2] === 'delete' ? 'deletes' : 'updates');
    }

    const querysetVariablePattern = /(\w+)\s*=\s*(\w+)\.objects\b/g;
    const fetchedVariableToModel = new Map<string, string>();
    while ((match = querysetVariablePattern.exec(scopeContent)) !== null) {
      if (!knownModels.has(match[2])) continue;
      fetchedVariableToModel.set(match[1], match[2]);
    }

    const instanceWritePattern = /(\w+)\.(save|delete)\s*\(/g;
    while ((match = instanceWritePattern.exec(scopeContent)) !== null) {
      const model = fetchedVariableToModel.get(match[1]);
      if (!model) continue;
      record(model, match[2] === 'delete' ? 'deletes' : 'updates');
    }

    if (/\.save\s*\(/.test(scopeContent)) {
      const constructionPattern = /(?:^|[^.\w])([A-Z]\w*)\s*\(/g;
      while ((match = constructionPattern.exec(scopeContent)) !== null) {
        const model = match[1];
        if (!knownModels.has(model)) continue;
        record(model, 'creates');
      }
    }

    return [...accesses.values()];
  }

  private extractLocalModelDefinitions(content: string): string[] {
    const models: string[] = [];
    const classPattern = /class\s+(\w+)\s*\(([^)]*)\)\s*:/g;

    let match;
    while ((match = classPattern.exec(content)) !== null) {
      const bases = match[2];
      if (/\bmodels\.Model\b/.test(bases) || /\b\w*Model\b/.test(bases) || /\bAbstractUser\b/.test(bases) || /\bAbstractBaseUser\b/.test(bases)) {
        models.push(match[1]);
      }
    }

    return models;
  }

  private extractImportedModels(content: string): string[] {
    const models: string[] = [];
    const importPattern = /from\s+[\w.]+models?\s+import\s+\(?\s*([^)]+)\)?/g;

    let match;
    while ((match = importPattern.exec(content)) !== null) {
      const imports = match[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
      for (const imp of imports) {
        const cleanName = imp.split(/\s+as\s+/)[0].trim();
        if (cleanName && !cleanName.startsWith('#') && cleanName !== 'models') {
          models.push(cleanName);
        }
      }
    }

    return models;
  }

  private extractQuerysetModel(classContent: string): string | undefined {
    const patterns = [
      /queryset\s*=\s*(\w+)\.objects/,
      /model\s*=\s*(\w+)/
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(classContent);
      if (match) {
        return match[1];
      }
    }

    return undefined;
  }

  private inferMethodsFromBaseClass(baseClass: string): string[] {
    const baseClassMethods: Record<string, string[]> = {
      'CreateAPIView': ['POST'],
      'ListAPIView': ['GET'],
      'RetrieveAPIView': ['GET'],
      'DestroyAPIView': ['DELETE'],
      'UpdateAPIView': ['PUT', 'PATCH'],
      'ListCreateAPIView': ['GET', 'POST'],
      'RetrieveUpdateAPIView': ['GET', 'PUT', 'PATCH'],
      'RetrieveDestroyAPIView': ['GET', 'DELETE'],
      'RetrieveUpdateDestroyAPIView': ['GET', 'PUT', 'PATCH', 'DELETE'],
      'ModelViewSet': ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      'ReadOnlyModelViewSet': ['GET'],
      'View': ['GET', 'POST'],
      'APIView': ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      'TemplateView': ['GET'],
      'ListView': ['GET'],
      'DetailView': ['GET'],
      'CreateView': ['GET', 'POST'],
      'UpdateView': ['GET', 'POST'],
      'DeleteView': ['GET', 'POST'],
      'FormView': ['GET', 'POST']
    };

    for (const [base, methods] of Object.entries(baseClassMethods)) {
      if (baseClass.includes(base)) {
        return methods;
      }
    }

    return ['GET', 'POST'];
  }

  private extractFormFields(content: string): Array<{ name: string; type: string; required: boolean; widget?: string }> {
    const fields: Array<{ name: string; type: string; required: boolean; widget?: string }> = [];
    const fieldPattern = /(\w+)\s*=\s*forms\.(\w+)\s*\([^)]*\)/g;

    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      const name = match[1];
      const type = match[2];

      fields.push({
        name,
        type,
        required: !content.includes(`${name} = forms.${type}(`) || content.includes('required=True')
      });
    }

    return fields;
  }

  private extractFormMeta(content: string): { model?: string; fields?: string[]; exclude?: string[] } | undefined {
    const metaPattern = /class\s+Meta\s*:([^}]*?)(?=class|\Z)/;
    const metaMatch = metaPattern.exec(content);

    if (metaMatch) {
      const metaContent = metaMatch[1];
      const meta: { model?: string; fields?: string[]; exclude?: string[] } = {};

      const modelMatch = /model\s*=\s*(\w+)/;
      const modelResult = modelMatch.exec(metaContent);
      if (modelResult) meta.model = modelResult[1];

      return meta;
    }

    return undefined;
  }

  private extractSerializerFields(content: string): Array<{ name: string; type: string; readOnly: boolean; required: boolean }> {
    const fields: Array<{ name: string; type: string; readOnly: boolean; required: boolean }> = [];
    const fieldPattern = /(\w+)\s*=\s*serializers\.(\w+)\s*\([^)]*\)/g;

    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      const name = match[1];
      const type = match[2];

      fields.push({
        name,
        type,
        readOnly: content.includes('read_only=True'),
        required: !content.includes('required=False')
      });
    }

    return fields;
  }

  private extractSerializerMeta(content: string): { model?: string; fields?: string[]; depth?: number } | undefined {
    const metaPattern = /class\s+Meta\s*:([\s\S]*?)(?=\n\s*(?:def\s|class\s)|$)/;
    const metaMatch = metaPattern.exec(content);

    if (metaMatch) {
      const metaContent = metaMatch[1];
      const meta: { model?: string; fields?: string[]; depth?: number } = {};

      const modelMatch = /model\s*=\s*(\w+)/;
      const modelResult = modelMatch.exec(metaContent);
      if (modelResult) meta.model = modelResult[1];

      return meta;
    }

    return undefined;
  }

  private extractAdminModel(content: string, adminName: string): string {
    const registerPattern = new RegExp(`admin\\.site\\.register\\s*\\(\\s*(\\w+)\\s*,\\s*${adminName}\\s*\\)`);
    const match = registerPattern.exec(content);
    return match ? match[1] : 'Unknown';
  }

  private extractViewMethods(content: string): string[] {
    const methods: string[] = [];
    const methodPattern = /def\s+(get|post|put|patch|delete|head|options|list|create|retrieve|update|partial_update|destroy)\s*\(/gi;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const methodName = match[1].toLowerCase();
      const mappedMethod = this.mapDRFMethodToHTTP(methodName);
      if (!methods.includes(mappedMethod)) {
        methods.push(mappedMethod);
      }
    }

    return methods;
  }

  private mapDRFMethodToHTTP(method: string): string {
    const drfMapping: Record<string, string> = {
      'list': 'GET',
      'create': 'POST',
      'retrieve': 'GET',
      'update': 'PUT',
      'partial_update': 'PATCH',
      'destroy': 'DELETE',
      'get': 'GET',
      'post': 'POST',
      'put': 'PUT',
      'patch': 'PATCH',
      'delete': 'DELETE',
      'head': 'HEAD',
      'options': 'OPTIONS'
    };
    return drfMapping[method] || method.toUpperCase();
  }

  private extractDecorators(content: string, position: number): string[] {
    const decorators: string[] = [];
    const lines = content.substring(0, position).split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('@')) {




        const decoratorMatch = line.match(/@(\w+(?:\s*\([\s\S]*?\))?)/);
        if (decoratorMatch) {
          decorators.unshift(decoratorMatch[1]);
        }
      } else if (line && !line.startsWith('#')) {
        break;
      }
    }

    return decorators;
  }

  private extractPermissions(decorators: string[]): string[] {
    return decorators.filter(d =>
      d.includes('permission') ||
      d.includes('login') ||
      d.includes('auth') ||
      d.includes('staff') ||
      d.includes('superuser')
    );
  }


  private findClassEnd(content: string, classStart: number): number {
    const lines = content.substring(classStart).split('\n');
    let indentLevel = 0;
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('class ') && !found) {
        indentLevel = line.length - line.trimLeft().length;
        found = true;
        continue;
      }

      if (found && line.trim() && line.length - line.trimLeft().length <= indentLevel && !line.trimLeft().startsWith('#')) {
        return classStart + lines.slice(0, i).join('\n').length;
      }
    }

    return content.length;
  }

  private findFunctionEnd(content: string, functionStart: number): number {
    const lines = content.substring(functionStart).split('\n');
    let indentLevel = 0;
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('def ') && !found) {
        indentLevel = line.length - line.trimLeft().length;
        found = true;
        continue;
      }

      if (found && line.trim() && line.length - line.trimLeft().length <= indentLevel && !line.trimLeft().startsWith('#')) {
        return functionStart + lines.slice(0, i).join('\n').length;
      }
    }

    return content.length;
  }

  private async detectDjangoVersion(projectPath: string): Promise<string> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        const versionMatch = requirements.match(/Django==([^\s\n]+)/i);
        if (versionMatch) return versionMatch[1];
      }
    } catch {

    }

    return 'unknown';
  }

  private buildDjangoRelationships(
    projects: DjangoProject[],
    apps: DjangoApp[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    if (projects.length === 0) return;

    const projectRoot = (project: DjangoProject): string => {
      const packageDir = /(^|\/)settings\.py$/.test(project.filePath)
        ? path.dirname(project.filePath)
        : path.dirname(path.dirname(project.filePath));
      const root = path.dirname(packageDir);
      return root === '.' ? '' : root;
    };
    const projectForApp = (appDir: string): DjangoProject => {
      let best: DjangoProject | undefined;
      let bestRootLength = -1;
      for (const project of projects) {
        const root = projectRoot(project);
        const contains = root === '' || appDir === root || appDir.startsWith(root + '/');
        if (contains && root.length > bestRootLength) {
          best = project;
          bestRootLength = root.length;
        }
      }
      return best || projects[0];
    };

    const allModels = apps.flatMap(app => app.models.map(m => ({ ...m, appId: app.id })));
    const allSerializers = apps.flatMap(app => app.serializers.map(s => ({ ...s, appId: app.id })));
    const allGraphQLTypes = apps.flatMap(app => app.graphqlTypes);
    const modelForName = (name: string, preferredAppId: string) => {
      const matches = allModels.filter(model => model.name === name);
      return matches.find(model => model.appId === preferredAppId) || (matches.length === 1 ? matches[0] : undefined);
    };
    const serializerForName = (name: string, preferredAppId: string) => {
      const matches = allSerializers.filter(serializer => serializer.name === name);
      return matches.find(serializer => serializer.appId === preferredAppId) || (matches.length === 1 ? matches[0] : undefined);
    };

    apps.forEach(app => {
      const appId = app.id;
      const owningProject = projectForApp(app.path);
      const projectId = owningProject.id || `project_${this.sanitizeId(owningProject.name)}`;

      edges.push(this.createEdge(
        `${projectId}_contains_${appId}`,
        projectId,
        appId,
        'contains'
      ));

      app.models.forEach(model => {
        const modelId = `model_${appId}_${this.sanitizeId(model.name)}`;

        model.relationships.forEach(relationship => {
          const targetModel = modelForName(relationship.target, appId);
          if (!targetModel) return;
          const targetModelId = `model_${targetModel.appId}_${this.sanitizeId(relationship.target)}`;

          edges.push(this.createEdge(
            `${modelId}_${relationship.type}_${targetModelId}`,
            modelId,
            targetModelId,
            relationship.type.toLowerCase()
          ));
        });
      });

      app.serializers.forEach(serializer => {
        const serializerId = `serializer_${appId}_${this.sanitizeId(serializer.name)}`;

        if (serializer.meta?.model) {
          const targetModel = modelForName(serializer.meta.model, appId);
          if (!targetModel) return;
          const modelId = `model_${targetModel.appId}_${this.sanitizeId(serializer.meta.model)}`;

          edges.push(this.createEdge(
            `${serializerId}_wraps_${modelId}`,
            serializerId,
            modelId,
            'wraps'
          ));
        }
      });

      app.views.forEach(view => {
        const viewId = this.viewNodeId(appId, view);

        if (view.serializerClass) {
          const serializer = serializerForName(view.serializerClass, appId);
          const serializerId = serializer && `serializer_${serializer.appId}_${this.sanitizeId(view.serializerClass)}`;

          if (serializerId) edges.push(this.createEdge(
            `${viewId}_uses_serializer_${this.sanitizeId(view.serializerClass)}`,
            viewId,
            serializerId,
            'uses'
          ));
        }

        for (const serializerName of view.serializerReferences || []) {
          if (serializerName === view.serializerClass) continue;
          const serializer = serializerForName(serializerName, appId);
          if (!serializer) continue;
          const serializerId = `serializer_${serializer.appId}_${this.sanitizeId(serializerName)}`;

          edges.push(this.createEdge(
            `${viewId}_uses_serializer_${this.sanitizeId(serializerName)}`,
            viewId,
            serializerId,
            'uses'
          ));
        }

        for (const modelName of view.modelReferences || []) {
          const targetModel = modelForName(modelName, appId);
          if (!targetModel) continue;
          const modelId = `model_${targetModel.appId}_${this.sanitizeId(modelName)}`;

          edges.push(this.createEdge(
            `${viewId}_queries_${modelId}`,
            viewId,
            modelId,
            'queries'
          ));
        }

        if (view.querysetModel) {
          const targetModel = modelForName(view.querysetModel, appId);
          const modelId = targetModel && `model_${targetModel.appId}_${this.sanitizeId(view.querysetModel)}`;

          if (modelId && !view.modelReferences?.includes(view.querysetModel)) {
            edges.push(this.createEdge(
              `${viewId}_queries_${modelId}`,
              viewId,
              modelId,
              'queries'
            ));
          }
        }

        for (const access of view.modelAccesses || []) {
          const targetModel = modelForName(access.model, appId);
          if (!targetModel) continue;
          const modelId = `model_${targetModel.appId}_${this.sanitizeId(access.model)}`;

          edges.push(this.createEdge(
            `${viewId}_${access.access}_${modelId}`,
            viewId,
            modelId,
            access.access
          ));
        }

        for (const write of view.serializerWrites || []) {
          const serializer = serializerForName(write.serializer, appId);
          const modelName = serializer?.meta?.model;
          if (!modelName) continue;
          const targetModel = modelForName(modelName, appId);
          if (!targetModel) continue;
          const modelId = `model_${targetModel.appId}_${this.sanitizeId(modelName)}`;
          const edgeId = `${viewId}_${write.access}_${modelId}`;
          if (edges.some(e => e.id === edgeId)) continue;

          edges.push(this.createEdge(
            edgeId,
            viewId,
            modelId,
            write.access,
            undefined,
            { serializer: write.serializer }
          ));
        }

        if (view.templateName) {
          app.models.forEach(model => {
            const modelId = `model_${appId}_${this.sanitizeId(model.name)}`;
            if (view.templateName?.includes(model.name.toLowerCase())) {
              edges.push(this.createEdge(
                `${viewId}_uses_${modelId}`,
                viewId,
                modelId,
                'uses'
              ));
            }
          });
        }
      });

      app.celeryTasks.forEach(task => {
        const taskId = `celery_task_${appId}_${this.sanitizeId(task.name)}`;

        for (const access of task.modelAccesses || []) {
          const targetModel = modelForName(access.model, appId);
          if (!targetModel) continue;
          const modelId = `model_${targetModel.appId}_${this.sanitizeId(access.model)}`;

          edges.push(this.createEdge(
            `${taskId}_${access.access}_${modelId}`,
            taskId,
            modelId,
            access.access
          ));
        }
      });

      const modelIdForName = (modelName: string): string | undefined => {
        const targetModel = modelForName(modelName, appId);
        return targetModel ? `model_${targetModel.appId}_${this.sanitizeId(modelName)}` : undefined;
      };
      const modelIdForTypeName = (typeName: string): string | undefined => {
        const gqlType = allGraphQLTypes.find(t => t.name === typeName);
        return gqlType?.model ? modelIdForName(gqlType.model) : undefined;
      };
      const crudMutationAccess: Record<string, DjangoModelAccess['access']> = {
        'crud-create': 'creates',
        'crud-update': 'updates',
        'crud-delete': 'deletes'
      };

      app.graphqlTypes.forEach(graphqlType => {
        if (!graphqlType.model) return;
        const modelId = modelIdForName(graphqlType.model);
        if (!modelId) return;
        const typeId = `graphql_type_${appId}_${this.sanitizeId(graphqlType.name)}`;
        edges.push(this.createEdge(`${typeId}_maps_to_${modelId}`, typeId, modelId, 'maps_to'));
      });

      app.graphqlMutations.forEach(mutation => {
        if (!mutation.name) return;
        const mutationId = `graphql_mutation_${appId}_${this.sanitizeId(mutation.name)}`;

        const crudAccess = crudMutationAccess[mutation.mutationType];
        if (crudAccess) {
          const modelId = modelIdForTypeName(mutation.baseClass);
          if (modelId) {
            edges.push(this.createEdge(
              `${mutationId}_${crudAccess}_${modelId}`,
              mutationId,
              modelId,
              crudAccess
            ));
          }
        }

        for (const access of mutation.modelAccesses || []) {
          const modelId = modelIdForName(access.model);
          if (!modelId) continue;
          edges.push(this.createEdge(
            `${mutationId}_${access.access}_${modelId}`,
            mutationId,
            modelId,
            access.access
          ));
        }
      });

      app.graphqlQueries.forEach(query => {
        if (!query.name || !query.returnType) return;
        const queryId = `graphql_query_${appId}_${this.sanitizeId(query.name)}`;
        const typeName = query.returnType.replace(/[[\]]/g, '');
        const modelId = modelIdForTypeName(typeName);
        if (!modelId) return;

        edges.push(this.createEdge(
          `${queryId}_reads_${modelId}`,
          queryId,
          modelId,
          'reads'
        ));
      });
    });
  }

  private identifyDatabaseConnections(apps: DjangoApp[], nodes: CASNode[], exitPoints: any[]): void {
    const allModels = apps.flatMap(app => app.models);

    if (allModels.length > 0) {
      const dbId = 'database_django_orm';
      const dbNode = this.createNodeBuilder(dbId, 'Django ORM', 'database')
        .withLevel(1, 'system')
        .withCategory('database', ['storage', 'orm'])
        .withDescription('Django ORM database connection')
        .withMetadata({
          attributes: {
            models: allModels.map(m => m.name),
            tables: allModels.map(m => m.meta.dbTable || m.name.toLowerCase()),
            orm: 'Django ORM'
          }
        })
        .withAnalyzers([this.analyzerId], this.analyzerId)
        .build();
      nodes.push(dbNode);

      exitPoints.push({
        id: 'exit_django_database',
        name: 'Django Database Connection',
        type: 'database',
        source_node: dbId,
        metadata: {
          models: allModels.map(m => m.name),
          tables: allModels.map(m => m.meta.dbTable || m.name.toLowerCase()),
          orm: 'Django ORM'
        }
      });
    }
  }

  protected getCapabilities(): string[] {
    return [
      'django-analysis',
      'model-extraction',
      'view-analysis',
      'url-pattern-detection',
      'template-discovery',
      'admin-detection',
      'middleware-analysis',
      'forms-detection',
      'graphql-mutation-detection',
      'graphql-query-detection',
      'graphql-type-detection',
      'graphene-support',
      'celery-task-detection'
    ];
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

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'django-mvt',
      name: 'Django Model-View-Template',
      description: 'Django MVT architecture showing Models, Views, and Templates',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['django_model', 'django_view', 'django_template', 'django_url'],
        relevant_edge_types: ['uses', 'renders', 'maps_to'],
        node_connections: [
          {
            from_type: 'django_view',
            to_types: ['django_model'],
            edge_type: 'uses'
          },
          {
            from_type: 'django_view',
            to_types: ['django_template'],
            edge_type: 'renders'
          },
          {
            from_type: 'django_url',
            to_types: ['django_view'],
            edge_type: 'maps_to'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'TB',
        group_by: 'component_type'
      },
      metadata: {
        show_relationships: true,
        show_templates: true
      }
    });

    perspectives.push({
      id: 'django-urls',
      name: 'Django URL Routing',
      description: 'URL routing patterns and view mappings',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['django_url', 'django_view', 'django_app'],
        relevant_edge_types: ['maps_to', 'includes', 'contains'],
        node_connections: [
          {
            from_type: 'django_app',
            to_types: ['django_url'],
            edge_type: 'contains'
          },
          {
            from_type: 'django_url',
            to_types: ['django_view'],
            edge_type: 'maps_to'
          }
        ]
      },
      layout_hints: {
        style: 'hierarchical',
        direction: 'LR'
      },
      metadata: {
        show_url_patterns: true,
        show_namespaces: true
      }
    });

    perspectives.push({
      id: 'django-apps',
      name: 'Django Application Boundaries',
      description: 'Django app structure and inter-app dependencies',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['django_project', 'django_app', 'django_model'],
        relevant_edge_types: ['contains', 'depends_on'],
        node_connections: [
          {
            from_type: 'django_project',
            to_types: ['django_app'],
            edge_type: 'contains'
          },
          {
            from_type: 'django_app',
            to_types: ['django_model'],
            edge_type: 'contains'
          }
        ]
      },
      layout_hints: {
        style: 'force',
        group_by: 'app'
      },
      metadata: {
        show_installed_apps: true,
        highlight_custom_apps: true
      }
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;

      if (!node.perspectives) {
        node.perspectives = {};
      }

      if (node.type === 'django_model' || node.type === 'django_view' ||
          node.type === 'django_template' || node.type === 'django_url') {
        node.perspectives['django-mvt'] = {
          hierarchy: ['django', 'mvt'],
          level: node.level || 1,
          priority: 1
        };
      }

      if (node.type === 'django_url' || node.type === 'django_view' || node.type === 'django_app') {
        node.perspectives['django-urls'] = {
          hierarchy: ['django', 'urls'],
          level: node.level || 1,
          priority: 2
        };
      }

      if (node.type === 'django_project' || node.type === 'django_app' || node.type === 'django_model') {
        node.perspectives['django-apps'] = {
          hierarchy: ['django', 'apps'],
          level: node.level || 1,
          priority: 3
        };
      }

      if (!node.metadata) {
        node.metadata = {};
      }
      node.metadata.perspective_data = {
        'django-mvt': {
          component_type: this.getDjangoComponentType(node.type),
          mvt_role: this.getMVTRole(node.type)
        },
        'django-urls': {
          routing_role: node.type === 'django_url' ? 'pattern' : 'handler',
          url_pattern: node.metadata?.attributes?.pattern || ''
        },
        'django-apps': {
          app_boundary: node.type === 'django_app' ? 'boundary' : 'component',
          is_custom: node.metadata?.attributes?.custom || true
        }
      };
    });

    edges.forEach(edge => {
      edge.perspectives = [];

      if (edge.type === 'uses' || edge.type === 'renders' || edge.type === 'maps_to') {
        edge.perspectives.push('django-mvt');
      }

      if (edge.type === 'maps_to' || edge.type === 'includes' || edge.type === 'contains') {
        edge.perspectives.push('django-urls');
      }

      if (edge.type === 'contains' || edge.type === 'depends_on') {
        edge.perspectives.push('django-apps');
      }

      if (!edge.metadata) {
        edge.metadata = {};
      }
      edge.metadata.perspective_data = {
        'django-mvt': {
          mvt_relationship: edge.type,
          is_data_flow: edge.type === 'uses'
        },
        'django-urls': {
          routing_relationship: edge.type,
          is_url_mapping: edge.type === 'maps_to'
        },
        'django-apps': {
          app_relationship: edge.type,
          boundary_crossing: edge.type === 'depends_on'
        }
      };
    });
  }

  private getDjangoComponentType(nodeType: string): string {
    switch (nodeType) {
      case 'django_model': return 'model';
      case 'django_view': return 'view';
      case 'django_template': return 'template';
      case 'django_url': return 'url';
      default: return 'component';
    }
  }

  private getMVTRole(nodeType: string): string {
    switch (nodeType) {
      case 'django_model': return 'data';
      case 'django_view': return 'logic';
      case 'django_template': return 'presentation';
      default: return 'routing';
    }
  }


  private extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');




    const helpTextPattern = /help_text\s*=\s*['"]([^'"]+)['"]/g;
    const fieldDocs: string[] = [];
    let helpMatch;
    while ((helpMatch = helpTextPattern.exec(content)) !== null) {
      fieldDocs.push(helpMatch[1]);
    }


    const classDocStringMatch = content.match(/class\s+\w+[^:]*:\s*['""]([\s\S]*?)['""]/);


    const functionDocStrings: string[] = [];
    const funcDocPattern = /def\s+\w+[^:]*:\s*['""]([\s\S]*?)['""]/g;
    let funcMatch;
    while ((funcMatch = funcDocPattern.exec(content)) !== null) {
      functionDocStrings.push(funcMatch[1].trim());
    }


    const moduleDocMatch = content.match(/^\s*['""]([\s\S]*?)['""]/);

    if (classDocStringMatch || functionDocStrings.length > 0 || moduleDocMatch || fieldDocs.length > 0) {
      const doc: CASDocumentation = {
        type: 'django_docstring',
        raw: content,
        location: { start_line: 1, end_line: lines.length }
      };

      if (moduleDocMatch) {
        doc.summary = moduleDocMatch[1].split('\n')[0].trim();
        doc.description = moduleDocMatch[1].trim();
      } else if (classDocStringMatch) {
        doc.summary = classDocStringMatch[1].split('\n')[0].trim();
        doc.description = classDocStringMatch[1].trim();
      } else if (functionDocStrings.length > 0) {
        doc.summary = functionDocStrings[0].split('\n')[0].trim();
      }

      if (fieldDocs.length > 0) {
        doc.framework_docs = {
          django: {
            field_help_texts: fieldDocs
          }
        };
      }

      return doc;
    }

    return undefined;
  }

  private extractComments(content: string, filePath: string): CASComment[] {
    if (!content || content.trim().length === 0) return [];

    const comments: CASComment[] = [];
    let commentSeq = 0;
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();


      if (trimmedLine.startsWith('#')) {
        const commentText = trimmedLine.substring(1).trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${filePath}_${++commentSeq}`,
            type: 'single-line',
            style: '#',
            text: commentText,
            purpose: this.classifyCommentPurpose(commentText),
            location: {
              file: filePath,
              line: i + 1
            },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          };
          comments.push(comment);
        }
      }


      const docstringMatch = line.match(/^\s*['""]([\s\S]*?)['""]/);
      if (docstringMatch && !line.includes('def ') && !line.includes('class ')) {
        const commentText = docstringMatch[1].trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${filePath}_${++commentSeq}`,
            type: 'docstring',
            style: '"""',
            text: commentText,
            purpose: this.classifyCommentPurpose(commentText),
            location: {
              file: filePath,
              line: i + 1
            },
            markers: {
              is_todo: commentText.toUpperCase().includes('TODO'),
              is_fixme: commentText.toUpperCase().includes('FIXME'),
              is_hack: commentText.toUpperCase().includes('HACK'),
              is_warning: commentText.toUpperCase().includes('WARNING'),
              is_note: commentText.toUpperCase().includes('NOTE')
            }
          };
          comments.push(comment);
        }
      }
    }

    return comments;
  }

  private extractTodos(comments: CASComment[]): CASTodo[] {
    const todos: CASTodo[] = [];
    let todoSeq = 0;

    for (const comment of comments) {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const text = comment.text;
        const typeMatch = text.match(/(TODO|FIXME|HACK|NOTE|WARNING|XXX)/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';


        const assigneeMatch = text.match(/TODO\s*\(\s*([^)]+)\s*\)/i);
        const assignee = assigneeMatch ? assigneeMatch[1].trim() : undefined;


        const priorityMatch = text.match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i);
        let priority: CASTodo['priority'] = 'medium';
        if (priorityMatch) {
          priority = priorityMatch[1].toLowerCase() as CASTodo['priority'];
        }

        const todo: CASTodo = {
          id: `todo_${comment.location.file}_${comment.location.line}_${++todoSeq}`,
          type,
          text: text.replace(/^(TODO|FIXME|HACK|NOTE|WARNING|XXX)\s*(\([^)]+\))?\s*:?\s*/i, '').trim(),
          priority,
          location: {
            file: comment.location.file,
            line: comment.location.line
          },
          assignee,
          classification: {
            category: this.classifyTodoCategory(text),
            technical_debt: type === 'TODO' || type === 'FIXME' || type === 'HACK'
          }
        };

        todos.push(todo);
      }
    }

    return todos;
  }

  private determineImplementationStatus(content: string, comments: CASComment[]): CASImplementationStatus {
    const indicators = {
      has_todo_markers: comments.some(c => c.markers?.is_todo),
      has_not_implemented_exceptions: content.includes('NotImplementedError') || content.includes('raise NotImplemented'),
      has_stub_returns: content.includes('pass') && (content.includes('def ') || content.includes('class ')),
      has_placeholder_code: content.includes('# TODO') || content.includes('# FIXME') || content.includes('# PLACEHOLDER'),
      has_hardcoded_values: /['"](localhost|127\.0\.0\.1|test|example|demo|placeholder)['"]/.test(content),
      has_commented_out_code: comments.some(c => c.text.includes('def ') || c.text.includes('class ') || c.text.includes('import '))
    };

    const indicatorCount = Object.values(indicators).filter(Boolean).length;
    let status: CASImplementationStatus['status'];
    let confidence = 0.8;

    if (content.includes('NotImplementedError') || content.includes('raise NotImplemented')) {
      status = 'not-implemented';
      confidence = 0.95;
    } else if (indicatorCount >= 3) {
      status = 'stub';
      confidence = 0.7;
    } else if (indicatorCount >= 1) {
      status = 'partial';
      confidence = 0.6;
    } else if (content.includes('@deprecated') || content.includes('# deprecated')) {
      status = 'deprecated';
      confidence = 0.9;
    } else if (content.includes('experimental') || content.includes('beta')) {
      status = 'experimental';
      confidence = 0.8;
    } else {
      status = 'complete';
      confidence = 0.7;
    }

    const missingFeatures = [];
    if (indicators.has_not_implemented_exceptions) missingFeatures.push('Core implementation');
    if (indicators.has_todo_markers) missingFeatures.push('TODO items');
    if (indicators.has_stub_returns) missingFeatures.push('Method implementations');

    return {
      status,
      indicators,
      confidence,
      completeness: {
        estimated_percentage: status === 'complete' ? 90 : status === 'partial' ? 60 : status === 'stub' ? 30 : 10,
        missing_features: missingFeatures,
        implemented_features: status === 'complete' ? ['Core functionality'] : []
      }
    };
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const upperText = text.toUpperCase();
    if (upperText.includes('TODO') || upperText.includes('FIXME')) return 'todo';
    if (upperText.includes('WARNING') || upperText.includes('WARN')) return 'warning';
    if (upperText.includes('HACK') || upperText.includes('WORKAROUND')) return 'hack';
    if (upperText.includes('NOTE') || upperText.includes('INFO')) return 'note';
    if (upperText.includes('DISABLED') || upperText.includes('COMMENTED')) return 'disabled-code';
    return 'explanation';
  }

  private classifyTodoCategory(text: string): 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' | undefined {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('bug') || lowerText.includes('fix') || lowerText.includes('error')) return 'bug';
    if (lowerText.includes('security') || lowerText.includes('auth') || lowerText.includes('permission')) return 'security';
    if (lowerText.includes('performance') || lowerText.includes('optimize') || lowerText.includes('slow')) return 'performance';
    if (lowerText.includes('test') || lowerText.includes('spec') || lowerText.includes('coverage')) return 'test';
    if (lowerText.includes('refactor') || lowerText.includes('cleanup') || lowerText.includes('reorganize')) return 'refactor';
    if (lowerText.includes('doc') || lowerText.includes('comment') || lowerText.includes('explain')) return 'documentation';
    return 'feature';
  }

  private async readModelContent(projectPath: string, filePath: string): Promise<string> {
    try {
      return await fs.readFile(path.join(projectPath, filePath), 'utf-8');
    } catch {
      return '';
    }
  }

  private async readViewContent(projectPath: string, filePath: string): Promise<string> {
    try {
      return await fs.readFile(path.join(projectPath, filePath), 'utf-8');
    } catch {
      return '';
    }
  }

  private extractUrlParameters(pattern: string): Array<{ name: string; type: string; required: boolean; location: string }> {
    const params: Array<{ name: string; type: string; required: boolean; location: string }> = [];

    const djangoParamPattern = /<(\w+):(\w+)>/g;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = djangoParamPattern.exec(pattern)) !== null) {
      params.push({
        name: paramMatch[2],
        type: this.djangoTypeToGenericType(paramMatch[1]),
        required: true,
        location: 'path'
      });
    }

    const simpleParamPattern = /<(\w+)>/g;
    let simpleMatch: RegExpExecArray | null;
    while ((simpleMatch = simpleParamPattern.exec(pattern)) !== null) {
      if (!params.find(p => p.name === simpleMatch![1])) {
        params.push({
          name: simpleMatch[1],
          type: 'string',
          required: true,
          location: 'path'
        });
      }
    }

    const regexParamPattern = /\?P<(\w+)>/g;
    let regexMatch: RegExpExecArray | null;
    while ((regexMatch = regexParamPattern.exec(pattern)) !== null) {
      if (!params.find(p => p.name === regexMatch![1])) {
        params.push({
          name: regexMatch[1],
          type: 'string',
          required: true,
          location: 'path'
        });
      }
    }

    return params;
  }

  private djangoTypeToGenericType(djangoType: string): string {
    const typeMap: Record<string, string> = {
      'int': 'integer',
      'str': 'string',
      'slug': 'string',
      'uuid': 'string',
      'path': 'string'
    };
    return typeMap[djangoType] || 'string';
  }

  private hasAuthDecorator(decorators: string[]): boolean {
    const authDecorators = [
      'login_required',
      'permission_required',
      'user_passes_test',
      'staff_member_required',
      'superuser_required',
      'credentials_required',
      'authenticated',
      'IsAuthenticated',
      'IsAdminUser',
      'AllowAny'
    ];
    return decorators.some(d => authDecorators.some(auth => d.includes(auth)));
  }

  private extractGuardsFromDecorators(decorators: string[]): string[] {
    const guards: string[] = [];

    for (const decorator of decorators) {
      if (decorator.includes('login_required')) {
        guards.push('LoginRequired');
      }
      if (decorator.includes('permission_required')) {
        guards.push('PermissionRequired');
      }
      if (decorator.includes('staff_member_required')) {
        guards.push('StaffMemberRequired');
      }
      if (decorator.includes('superuser_required')) {
        guards.push('SuperuserRequired');
      }
      if (decorator.includes('credentials_required')) {
        guards.push('CredentialsRequired');
      }
      if (decorator.includes('user_passes_test')) {
        guards.push('UserPassesTest');
      }
    }

    return guards;
  }
}
