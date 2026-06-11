import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus, CASPerspective
} from "../../../types/cas.types";
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface DjangoProject {
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

interface DjangoMiddleware {
  name: string;
  filePath: string;
  methods: Array<{ name: string; parameters: string[] }>;
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

export class DjangoAnalyzer extends BaseAnalyzer {
  private todoCounter = 0;
  private commentCounter = 0;

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
        if (pyproject.includes('Django') || pyproject.includes('django')) return true;
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

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];

    try {
      const pythonFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: [...this.getIgnorePatterns(context), '**/migrations/**'],
        nodir: true
      });

      const project = await this.analyzeProject(context.projectPath, nodes);
      const apps = await this.analyzeApps(pythonFiles, context.projectPath, nodes, edges, entryPoints, exitPoints);
      const middleware = await this.analyzeMiddleware(pythonFiles, context.projectPath, nodes, edges);

      this.buildDjangoRelationships(project, apps, nodes, edges);
      this.identifyDatabaseConnections(apps, nodes, exitPoints);

      this.tagNodesWithPerspectives(nodes, edges);
      this.createPerspectives(perspectives);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'django',
        version: await this.detectDjangoVersion(context.projectPath),
        projectName: project?.name || 'Unknown',
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

  private async analyzeProject(projectPath: string, nodes: CASNode[]): Promise<DjangoProject | null> {
    const settingsFiles = await glob(['**/settings.py', '**/settings/*.py'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true
    });

    if (settingsFiles.length === 0) return null;

    const settingsPath = settingsFiles[0];
    const fullSettingsPath = path.join(projectPath, settingsPath);
    const settingsContent = await fs.readFile(fullSettingsPath, 'utf-8');

    const settings = this.extractSettings(settingsContent, settingsPath);
    const projectName = path.basename(path.dirname(settingsPath));

    const project: DjangoProject = {
      name: projectName,
      filePath: settingsPath,
      apps: settings.installedApps.filter(app => !app.startsWith('django.')),
      settings,
      urlconf: this.extractRootUrlconf(settingsContent)
    };

    const projectId = `project_${this.sanitizeId(projectName)}`;
    const documentation = this.extractDocumentation(settingsContent, fullSettingsPath);
    const comments = this.extractComments(settingsContent, fullSettingsPath);
    const todos = this.extractTodos(comments);
    const implementationStatus = this.determineImplementationStatus(settingsContent, comments);

    const projectNode = this.createNodeBuilder(projectId, projectName, 'application')
      .withLevel(1, 'system')
      .withCategory('application', ['framework', 'django'])
      .withSource({ file: fullSettingsPath, line: 1, end_line: settingsContent.split('\n').length })
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
          fileSet.has(path.join(dir, 'models.py'))) {
        markerDirs.add(dir);
      }
    });

    const hasMarkerAncestor = (dir: string): boolean => {
      let current = path.dirname(dir);
      while (current && current !== '.' && current !== path.dirname(current)) {
        if (markerDirs.has(current)) return true;
        current = path.dirname(current);
      }
      return false;
    };
    const hasMarkerDescendant = (dir: string): boolean => {
      for (const marker of markerDirs) {
        if (marker.startsWith(dir + '/')) return true;
      }
      return false;
    };

    const appDirs = [...packageDirs].sort().filter(dir => {
      const name = path.basename(dir);
      if (name === '.' || name.startsWith('__')) return false;
      if (markerDirs.has(dir)) return true;
      if (hasMarkerAncestor(dir)) return false;
      if (hasMarkerDescendant(dir)) return false;
      return true;
    });

    const appDirsDeepestFirst = appDirs.slice().sort((a, b) => b.length - a.length);
    const owningAppDir = (file: string): string | undefined =>
      appDirsDeepestFirst.find(dir => file.startsWith(dir + '/'));

    const usedAppIds = new Set<string>();

    for (const appDir of appDirs) {
      const appName = path.basename(appDir);
      let appId = `app_${this.sanitizeId(appName)}`;
      if (usedAppIds.has(appId)) {
        appId = `app_${this.sanitizeId(appDir.split('/').join('_'))}`;
      }
      usedAppIds.add(appId);

      const appFiles = files.filter(f => owningAppDir(f) === appDir);
      const models = await this.analyzeModels(appFiles, projectPath, appDir);
      const views = await this.analyzeViews(appFiles, projectPath, appDir);
      const urls = await this.analyzeUrls(appFiles, projectPath, appDir);
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
        .withSource({ file: path.join(projectPath, appDir), line: 1, end_line: 1 })
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
          .withSource({ file: path.join(projectPath, mutation.filePath), line: 1, end_line: 1 })
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

        const entryPointId = `entry_graphql_mutation_${this.sanitizeId(mutation.name)}`;
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
          .withSource({ file: path.join(projectPath, query.filePath), line: 1, end_line: 1 })
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

        const entryPointId = `entry_graphql_query_${this.sanitizeId(query.name)}`;
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
          .withSource({ file: path.join(projectPath, gqlType.filePath), line: 1, end_line: 1 })
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

        if (gqlType.model) {
          const modelId = `model_${appId}_${this.sanitizeId(gqlType.model)}`;
          edges.push(this.createEdge(
            `${typeId}_maps_to_${modelId}`,
            typeId,
            modelId,
            'maps_to'
          ));
        }
      }

      for (const task of celeryTasks) {
        if (!task.name) continue;

        const taskId = `celery_task_${appId}_${this.sanitizeId(task.name)}`;
        const taskNode = this.createNodeBuilder(taskId, task.name, 'task')
          .withLevel(3, 'code')
          .withCategory('task', ['async', 'celery'])
          .withSource({ file: path.join(projectPath, task.filePath), line: 1, end_line: 1 })
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

      for (const [index, model] of models.entries()) {
        if (!model.name) continue;

        const modelId = `model_${appId}_${this.sanitizeId(model.name)}`;
        const modelContent = await this.readModelContent(projectPath, model.filePath);
        const modelDocumentation = this.extractDocumentation(modelContent, path.join(projectPath, model.filePath));
        const modelComments = this.extractComments(modelContent, path.join(projectPath, model.filePath));
        const modelTodos = this.extractTodos(modelComments);
        const modelImplementationStatus = this.determineImplementationStatus(modelContent, modelComments);

        const modelNode = this.createNodeBuilder(modelId, model.name, 'model')
          .withLevel(3, 'code')
          .withCategory('model', ['data', 'entity'])
          .withSource({ file: path.join(projectPath, model.filePath), line: 1, end_line: 1 })
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
              dbTable: model.meta.dbTable || model.name.toLowerCase()
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
            .withSource({ file: path.join(projectPath, model.filePath), line: 1, end_line: 1 })
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

      for (const [index, view] of views.entries()) {
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
          .withSource({ file: path.join(projectPath, view.filePath), line: 1, end_line: 1 })
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
          .withSource({ file: path.join(projectPath, serializer.filePath), line: 1, end_line: 1 })
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
        if (!url.pattern || !url.view) return;

        const urlId = `url_${appId}_${index}`;
        const urlName = url.pattern || `route_${index}`;
        const urlNode = this.createNodeBuilder(urlId, urlName, 'route')
          .withLevel(4, 'member')
          .withCategory('route', ['http', 'endpoint'])
          .withSource({
            file: path.join(projectPath, appDir, 'urls.py'),
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

        const httpMethods = matchingView?.type === 'class'
          ? (matchingView.methods.length > 0 ? matchingView.methods : ['GET'])
          : ['GET', 'POST'];

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
              authenticated: this.hasAuthDecorator(matchingView?.decorators || []),
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

  private async analyzeModels(files: string[], projectPath: string, appDir: string): Promise<DjangoModel[]> {
    const models: DjangoModel[] = [];
    const modelsPackagePrefix = path.join(appDir, 'models') + '/';
    const modelFiles = files.filter(f =>
      f === path.join(appDir, 'models.py') ||
      (f.startsWith(modelsPackagePrefix) && f.endsWith('.py'))
    );

    for (const modelsFile of modelFiles) {
      const content = await fs.readFile(path.join(projectPath, modelsFile), 'utf-8');
      const extractedModels = this.extractModels(content, modelsFile);
      models.push(...extractedModels);
    }

    return models;
  }

  private async analyzeViews(files: string[], projectPath: string, appDir: string): Promise<DjangoView[]> {
    const views: DjangoView[] = [];
    const viewsFiles = files.filter(f =>
      f.startsWith(appDir + '/') &&
      (f.endsWith('/views.py') || f === path.join(appDir, 'views.py'))
    );

    for (const viewsFile of viewsFiles) {
      const content = await fs.readFile(path.join(projectPath, viewsFile), 'utf-8');
      const extractedViews = this.extractViews(content, viewsFile);
      views.push(...extractedViews);
    }

    return views;
  }

  private async analyzeUrls(files: string[], projectPath: string, appDir: string): Promise<DjangoUrl[]> {
    const urls: DjangoUrl[] = [];
    const urlsFiles = files.filter(f =>
      f.startsWith(appDir + '/') &&
      (f.endsWith('/urls.py') || f === path.join(appDir, 'urls.py'))
    );

    for (const urlsFile of urlsFiles) {
      const content = await fs.readFile(path.join(projectPath, urlsFile), 'utf-8');
      const extractedUrls = this.extractUrls(content);
      urls.push(...extractedUrls);
    }

    return urls;
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
      f.startsWith(appDir + '/') &&
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
      (f.includes('mutations.py') && f.startsWith(appDir))
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
      (f.includes('queries.py') && f.startsWith(appDir))
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
      (f.includes('types.py') && f.startsWith(appDir) && !f.includes('__pycache__'))
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
      (f.includes('tasks.py') && f.startsWith(appDir))
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

  private async analyzeMiddleware(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<DjangoMiddleware[]> {
    const middleware: DjangoMiddleware[] = [];
    const middlewareFiles = files.filter(f => f.includes('middleware'));

    for (const file of middlewareFiles) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      const extractedMiddleware = this.extractMiddleware(content, file);
      middleware.push(...extractedMiddleware);

      extractedMiddleware.forEach(mw => {
        const middlewareId = `middleware_${this.sanitizeId(mw.name)}`;
        const middlewareContent = content;
        const middlewareDocumentation = this.extractDocumentation(middlewareContent, path.join(projectPath, mw.filePath));
        const middlewareComments = this.extractComments(middlewareContent, path.join(projectPath, mw.filePath));
        const middlewareTodos = this.extractTodos(middlewareComments);
        const middlewareImplementationStatus = this.determineImplementationStatus(middlewareContent, middlewareComments);

        const middlewareNode = this.createNodeBuilder(middlewareId, mw.name, 'middleware')
          .withLevel(3, 'code')
          .withCategory('middleware', ['framework', 'django'])
          .withSource({ file: path.join(projectPath, mw.filePath), line: 1, end_line: 1 })
          .withDescription(`Django middleware: ${mw.name}`)
          .withDocumentation(middlewareDocumentation)
          .withComments(middlewareComments)
          .withTodos(middlewareTodos)
          .withImplementationStatus(middlewareImplementationStatus)
          .withMetadata({
            framework: 'django',
            attributes: {
              methods: mw.methods.map(m => m.name)
            }
          })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build();
        nodes.push(middlewareNode);
      });
    }

    return middleware;
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

  private extractModels(content: string, filePath: string): DjangoModel[] {
    const models: DjangoModel[] = [];
    const classPattern = /class\s+(\w+)\s*\(([^)]*)\)\s*:/g;
    const modelBasePattern = /\bmodels\.Model\b|\b\w*Model\b|\bAbstractUser\b|\bAbstractBaseUser\b/;
    const nonModelBasePattern = /\b(?:TextChoices|IntegerChoices|Choices|Enum|Serializer|Form|Admin|TestCase)\b/;

    let match;
    while ((match = classPattern.exec(content)) !== null) {
      const modelName = match[1];
      const bases = match[2];
      if (!modelBasePattern.test(bases) || nonModelBasePattern.test(bases)) continue;
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const fields = this.extractModelFields(classContent);
      const relationships = this.extractModelRelationships(classContent).map(relationship =>
        relationship.target === 'self' ? { ...relationship, target: modelName } : relationship
      );
      const meta = this.extractModelMeta(classContent);
      const methods = this.extractModelMethods(classContent);

      models.push({
        name: modelName,
        filePath,
        fields,
        relationships,
        meta,
        methods
      });
    }

    return models;
  }

  private extractViews(content: string, filePath: string): DjangoView[] {
    const views: DjangoView[] = [];

    const functionViews = this.extractFunctionViews(content, filePath);
    const classViews = this.extractClassViews(content, filePath);

    views.push(...functionViews, ...classViews);
    return views;
  }

  private extractUrls(content: string): DjangoUrl[] {
    const urls: DjangoUrl[] = [];
    const urlPattern = /path\s*\(\s*['"](.*?)['"],\s*([^,]+)(?:,\s*name=['"]([^'"]+)['"])?\s*\)/g;

    let match;
    while ((match = urlPattern.exec(content)) !== null) {
      const pattern = match[1];
      const view = match[2].trim();
      const name = match[3];

      urls.push({
        pattern,
        view,
        name,
        included: view.includes('include(')
      });
    }

    return urls;
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

  private extractMiddleware(content: string, filePath: string): DjangoMiddleware[] {
    const middleware: DjangoMiddleware[] = [];
    const middlewarePattern = /class\s+(\w+)(?:\s*\([^)]*\))?:/g;

    let match;
    while ((match = middlewarePattern.exec(content)) !== null) {
      const middlewareName = match[1];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const methods = this.extractMiddlewareMethods(classContent);

      if (methods.length > 0) {
        middleware.push({
          name: middlewareName,
          filePath,
          methods
        });
      }
    }

    return middleware;
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
        engine: 'postgresql', // Default assumption
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
        methods: [],
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
        const decoratorMatch = line.match(/@(\w+)/);
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

  private extractMiddlewareMethods(content: string): Array<{ name: string; parameters: string[] }> {
    const methods: Array<{ name: string; parameters: string[] }> = [];
    const methodPattern = /def\s+(process_request|process_view|process_template_response|process_response|process_exception)\s*\([^)]*\)/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      methods.push({
        name: match[1],
        parameters: []
      });
    }

    return methods;
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
      // Continue with other methods
    }

    return 'unknown';
  }

  private buildDjangoRelationships(
    project: DjangoProject | null,
    apps: DjangoApp[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    if (!project) return;

    const projectId = `project_${this.sanitizeId(project.name)}`;
    const allModels = apps.flatMap(app => app.models.map(m => ({ ...m, appId: app.id })));
    const allSerializers = apps.flatMap(app => app.serializers.map(s => ({ ...s, appId: app.id })));
    const allGraphQLTypes = apps.flatMap(app => app.graphqlTypes);

    apps.forEach(app => {
      const appId = app.id;

      edges.push(this.createEdge(
        `${projectId}_contains_${appId}`,
        projectId,
        appId,
        'contains'
      ));

      app.models.forEach(model => {
        const modelId = `model_${appId}_${this.sanitizeId(model.name)}`;

        model.relationships.forEach(relationship => {
          const targetModel = allModels.find(m => m.name === relationship.target);
          const targetModelId = targetModel
            ? `model_${targetModel.appId}_${this.sanitizeId(relationship.target)}`
            : `model_${appId}_${this.sanitizeId(relationship.target)}`;

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
          const targetModel = allModels.find(m => m.name === serializer.meta?.model);
          const modelId = targetModel
            ? `model_${targetModel.appId}_${this.sanitizeId(serializer.meta.model)}`
            : `model_${appId}_${this.sanitizeId(serializer.meta.model)}`;

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
          const serializer = allSerializers.find(s => s.name === view.serializerClass);
          const serializerId = serializer
            ? `serializer_${serializer.appId}_${this.sanitizeId(view.serializerClass)}`
            : `serializer_${appId}_${this.sanitizeId(view.serializerClass)}`;

          edges.push(this.createEdge(
            `${viewId}_uses_serializer_${this.sanitizeId(view.serializerClass)}`,
            viewId,
            serializerId,
            'uses'
          ));
        }

        for (const serializerName of view.serializerReferences || []) {
          if (serializerName === view.serializerClass) continue;
          const serializer = allSerializers.find(s => s.name === serializerName);
          const serializerId = serializer
            ? `serializer_${serializer.appId}_${this.sanitizeId(serializerName)}`
            : `serializer_${appId}_${this.sanitizeId(serializerName)}`;

          edges.push(this.createEdge(
            `${viewId}_uses_serializer_${this.sanitizeId(serializerName)}`,
            viewId,
            serializerId,
            'uses'
          ));
        }

        for (const modelName of view.modelReferences || []) {
          const targetModel = allModels.find(m => m.name === modelName);
          const modelId = targetModel
            ? `model_${targetModel.appId}_${this.sanitizeId(modelName)}`
            : `model_${appId}_${this.sanitizeId(modelName)}`;

          edges.push(this.createEdge(
            `${viewId}_queries_${modelId}`,
            viewId,
            modelId,
            'queries'
          ));
        }

        if (view.querysetModel) {
          const targetModel = allModels.find(m => m.name === view.querysetModel);
          const modelId = targetModel
            ? `model_${targetModel.appId}_${this.sanitizeId(view.querysetModel)}`
            : `model_${appId}_${this.sanitizeId(view.querysetModel)}`;

          if (!view.modelReferences?.includes(view.querysetModel)) {
            edges.push(this.createEdge(
              `${viewId}_queries_${modelId}`,
              viewId,
              modelId,
              'queries'
            ));
          }
        }

        for (const access of view.modelAccesses || []) {
          const targetModel = allModels.find(m => m.name === access.model);
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
          const serializer = allSerializers.find(s => s.name === write.serializer);
          const modelName = serializer?.meta?.model;
          if (!modelName) continue;
          const targetModel = allModels.find(m => m.name === modelName);
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
          const targetModel = allModels.find(m => m.name === access.model);
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
        const targetModel = allModels.find(m => m.name === modelName);
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

  // CAS v1.4.0 Documentation and Comment extraction methods
  private extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');

    // Look for Django-specific documentation patterns

    // 1. Model field help_text attributes
    const helpTextPattern = /help_text\s*=\s*['"]([^'"]+)['"]/g;
    const fieldDocs: string[] = [];
    let helpMatch;
    while ((helpMatch = helpTextPattern.exec(content)) !== null) {
      fieldDocs.push(helpMatch[1]);
    }

    // 2. Class docstrings
    const classDocStringMatch = content.match(/class\s+\w+[^:]*:\s*['""]([\s\S]*?)['""]/);

    // 3. Function docstrings
    const functionDocStrings: string[] = [];
    const funcDocPattern = /def\s+\w+[^:]*:\s*['""]([\s\S]*?)['""]/g;
    let funcMatch;
    while ((funcMatch = funcDocPattern.exec(content)) !== null) {
      functionDocStrings.push(funcMatch[1].trim());
    }

    // 4. Module-level docstring
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
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Python single-line comments
      if (trimmedLine.startsWith('#')) {
        const commentText = trimmedLine.substring(1).trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${++this.commentCounter}`,
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

      // Multi-line string comments (docstrings used as comments)
      const docstringMatch = line.match(/^\s*['""]([\s\S]*?)['""]/);
      if (docstringMatch && !line.includes('def ') && !line.includes('class ')) {
        const commentText = docstringMatch[1].trim();
        if (commentText.length > 0) {
          const comment: CASComment = {
            id: `comment_${++this.commentCounter}`,
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

    for (const comment of comments) {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const text = comment.text;
        const typeMatch = text.match(/(TODO|FIXME|HACK|NOTE|WARNING|XXX)/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';

        // Extract assignee from patterns like "TODO(username):"
        const assigneeMatch = text.match(/TODO\s*\(\s*([^)]+)\s*\)/i);
        const assignee = assigneeMatch ? assigneeMatch[1].trim() : undefined;

        // Extract priority from patterns like "TODO [HIGH]:" or "TODO: [CRITICAL]"
        const priorityMatch = text.match(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]/i);
        let priority: CASTodo['priority'] = 'medium';
        if (priorityMatch) {
          priority = priorityMatch[1].toLowerCase() as CASTodo['priority'];
        }

        const todo: CASTodo = {
          id: `todo_${++this.todoCounter}`,
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
