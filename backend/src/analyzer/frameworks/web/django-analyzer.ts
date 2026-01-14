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
  name: string;
  path: string;
  models: DjangoModel[];
  views: DjangoView[];
  urls: DjangoUrl[];
  admin: DjangoAdmin[];
  forms: DjangoForm[];
  serializers: DjangoSerializer[];
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
  baseClass?: string;
  methods: string[];
  decorators: string[];
  permissions: string[];
  templateName?: string;
  contextObject?: string;
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

export class DjangoAnalyzer extends BaseAnalyzer {
  private todoCounter = 0;
  private commentCounter = 0;

  constructor() {
    super(
      'django-analyzer',
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
        ignore: ['**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**', '**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**']
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
        ignore: ['**/venv/**', '**/env/**', '**/__pycache__/**', '.git/**', '**/migrations/**']
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
        urlsFound: apps.reduce((sum, app) => sum + app.urls.length, 0)
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
      ignore: ['**/venv/**', '**/env/**']
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
    const appDirs = new Set<string>();

    files.forEach(file => {
      const dir = path.dirname(file);
      if (files.some(f => f === path.join(dir, '__init__.py')) ||
          files.some(f => f === path.join(dir, 'apps.py'))) {
        appDirs.add(dir);
      }
    });

    for (const appDir of appDirs) {
      const appName = path.basename(appDir);
      if (appName === '.' || appName.startsWith('__')) continue;

      const appFiles = files.filter(f => f.startsWith(appDir + '/'));
      const models = await this.analyzeModels(appFiles, projectPath, appDir);
      const views = await this.analyzeViews(appFiles, projectPath, appDir);
      const urls = await this.analyzeUrls(appFiles, projectPath, appDir);
      const admin = await this.analyzeAdmin(appFiles, projectPath, appDir);
      const forms = await this.analyzeForms(appFiles, projectPath, appDir);
      const serializers = await this.analyzeSerializers(appFiles, projectPath, appDir);

      const app: DjangoApp = {
        name: appName,
        path: appDir,
        models,
        views,
        urls,
        admin,
        forms,
        serializers
      };

      apps.push(app);

      const appId = `app_${this.sanitizeId(appName)}`;
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
            serializers: serializers.length
          }
        })
        .build();
      nodes.push(appNode);

      for (const [index, model] of models.entries()) {
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
          .build();
        nodes.push(modelNode);

        edges.push(this.createEdge(
          `${appId}_contains_${modelId}`,
          appId,
          modelId,
          'contains'
        ));
      }

      for (const [index, view] of views.entries()) {
        const viewId = `view_${appId}_${this.sanitizeId(view.name)}`;
        const viewContent = await this.readViewContent(projectPath, view.filePath);
        const viewDocumentation = this.extractDocumentation(viewContent, path.join(projectPath, view.filePath));
        const viewComments = this.extractComments(viewContent, path.join(projectPath, view.filePath));
        const viewTodos = this.extractTodos(viewComments);
        const viewImplementationStatus = this.determineImplementationStatus(viewContent, viewComments);

        const viewNode = this.createNodeBuilder(viewId, view.name, 'controller')
          .withLevel(3, 'code')
          .withCategory('controller', ['api', 'rest'])
          .withSource({ file: path.join(projectPath, view.filePath), line: 1, end_line: 1 })
          .withDescription(`Django view: ${view.name}`)
          .withDocumentation(viewDocumentation)
          .withComments(viewComments)
          .withTodos(viewTodos)
          .withImplementationStatus(viewImplementationStatus)
          .withMetadata({
            framework: 'django',
            attributes: {
              type: view.type,
              baseClass: view.baseClass,
              methods: view.methods,
              decorators: view.decorators,
              permissions: view.permissions,
              templateName: view.templateName
            }
          })
          .build();
        nodes.push(viewNode);

        edges.push(this.createEdge(
          `${appId}_contains_${viewId}`,
          appId,
          viewId,
          'contains'
        ));
      }

      urls.forEach((url, index) => {
        const urlId = `url_${appId}_${index}`;
        const urlNode = this.createNodeBuilder(urlId, url.pattern, 'route')
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
          .build();
        nodes.push(urlNode);

        edges.push(this.createEdge(
          `${appId}_exposes_${urlId}`,
          appId,
          urlId,
          'exposes'
        ));

        entryPoints.push({
          id: `entry_${urlId}`,
          name: `${url.pattern} -> ${url.view}`,
          type: 'http',
          source_node: urlId,
          metadata: {
            pattern: url.pattern,
            view: url.view,
            app: appName,
            name: url.name
          }
        });
      });
    }

    return apps;
  }

  private async analyzeModels(files: string[], projectPath: string, appDir: string): Promise<DjangoModel[]> {
    const models: DjangoModel[] = [];
    const modelsFile = files.find(f => f === path.join(appDir, 'models.py'));

    if (modelsFile) {
      const content = await fs.readFile(path.join(projectPath, modelsFile), 'utf-8');
      const extractedModels = this.extractModels(content, modelsFile);
      models.push(...extractedModels);
    }

    return models;
  }

  private async analyzeViews(files: string[], projectPath: string, appDir: string): Promise<DjangoView[]> {
    const views: DjangoView[] = [];
    const viewsFile = files.find(f => f === path.join(appDir, 'views.py'));

    if (viewsFile) {
      const content = await fs.readFile(path.join(projectPath, viewsFile), 'utf-8');
      const extractedViews = this.extractViews(content, viewsFile);
      views.push(...extractedViews);
    }

    return views;
  }

  private async analyzeUrls(files: string[], projectPath: string, appDir: string): Promise<DjangoUrl[]> {
    const urls: DjangoUrl[] = [];
    const urlsFile = files.find(f => f === path.join(appDir, 'urls.py'));

    if (urlsFile) {
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
    const serializersFile = files.find(f => f === path.join(appDir, 'serializers.py'));

    if (serializersFile) {
      const content = await fs.readFile(path.join(projectPath, serializersFile), 'utf-8');
      const extractedSerializers = this.extractSerializers(content, serializersFile);
      serializers.push(...extractedSerializers);
    }

    return serializers;
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
    const classPattern = /class\s+(\w+)\s*\(\s*(?:models\.)?Model\s*\):/g;

    let match;
    while ((match = classPattern.exec(content)) !== null) {
      const modelName = match[1];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const fields = this.extractModelFields(classContent);
      const relationships = this.extractModelRelationships(classContent);
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
    const serializerPattern = /class\s+(\w+)\s*\(\s*(serializers\.\w+)\s*\):/g;

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
    const fieldPattern = /(\w+)\s*=\s*models\.(\w+)\s*\([^)]*\)/g;

    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      const name = match[1];
      const type = match[2];

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
    const relationPattern = /(\w+)\s*=\s*models\.(ForeignKey|OneToOneField|ManyToManyField)\s*\(\s*['"]?(\w+)['"]?/g;

    let match;
    while ((match = relationPattern.exec(content)) !== null) {
      const type = match[2];
      const target = match[3];

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

      views.push({
        name: viewName,
        filePath,
        type: 'function',
        methods: [],
        decorators,
        permissions: this.extractPermissions(decorators)
      });
    }

    return views;
  }

  private extractClassViews(content: string, filePath: string): DjangoView[] {
    const views: DjangoView[] = [];
    const classPattern = /class\s+(\w+)\s*\(\s*([^)]+)\s*\):/g;

    let match;
    while ((match = classPattern.exec(content)) !== null) {
      const viewName = match[1];
      const baseClass = match[2];

      if (baseClass.includes('View') || baseClass.includes('APIView')) {
        const classStart = match.index;
        const classEnd = this.findClassEnd(content, classStart);
        const classContent = content.substring(classStart, classEnd);

        const methods = this.extractViewMethods(classContent);
        const decorators = this.extractDecorators(content, classStart);

        views.push({
          name: viewName,
          filePath,
          type: 'class',
          baseClass,
          methods,
          decorators,
          permissions: this.extractPermissions(decorators)
        });
      }
    }

    return views;
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
    const metaPattern = /class\s+Meta\s*:([^}]*?)(?=class|\Z)/;
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
    const methodPattern = /def\s+(get|post|put|patch|delete|head|options)\s*\(/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      methods.push(match[1]);
    }

    return methods;
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

    apps.forEach(app => {
      const appId = `app_${this.sanitizeId(app.name)}`;

      edges.push(this.createEdge(
        `${projectId}_contains_${appId}`,
        projectId,
        appId,
        'contains'
      ));

      app.models.forEach(model => {
        const modelId = `model_${appId}_${this.sanitizeId(model.name)}`;

        model.relationships.forEach(relationship => {
          const targetModelId = `model_${appId}_${this.sanitizeId(relationship.target)}`;
          edges.push(this.createEdge(
            `${modelId}_${relationship.type}_${targetModelId}`,
            modelId,
            targetModelId,
            relationship.type.toLowerCase()
          ));
        });
      });

      app.views.forEach(view => {
        const viewId = `view_${appId}_${this.sanitizeId(view.name)}`;

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
      'forms-detection'
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
      node.perspectives = [];

      if (!node || typeof node !== 'object') return;

      if (node.type === 'django_model' || node.type === 'django_view' ||
          node.type === 'django_template' || node.type === 'django_url') {
        node.perspectives.push('django-mvt');
      }

      if (!node || typeof node !== 'object') return;

      if (node.type === 'django_url' || node.type === 'django_view' || node.type === 'django_app') {
        node.perspectives.push('django-urls');
      }

      if (!node || typeof node !== 'object') return;

      if (node.type === 'django_project' || node.type === 'django_app' || node.type === 'django_model') {
        node.perspectives.push('django-apps');
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
    const helpTextMatches = content.matchAll(/help_text\s*=\s*['"]([^'"]+)['"]/g);
    const fieldDocs = [];
    for (const match of helpTextMatches) {
      fieldDocs.push(match[1]);
    }

    // 2. Class docstrings
    const classDocStringMatch = content.match(/class\s+\w+[^:]*:\s*['""]([\s\S]*?)['""]/);

    // 3. Function docstrings
    const functionDocStrings = [];
    const functionMatches = content.matchAll(/def\s+\w+[^:]*:\s*['""]([\s\S]*?)['""]/);
    for (const match of functionMatches) {
      functionDocStrings.push(match[1].trim());
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
}
