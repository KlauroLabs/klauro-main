import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, CASExitPoint, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import {
  CASContribution, CASEntryPoint,
  CASDocumentation, CASComment, CASTodo, CASImplementationStatus
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface FlaskApplication {
  name: string;
  filePath: string;
  appVariable: string;
  config: FlaskConfig;
  blueprints: string[];
  extensions: string[];
}

interface FlaskConfig {
  debug: boolean;
  testing: boolean;
  secretKey?: string;
  database?: string;
  customSettings: Record<string, any>;
}

interface FlaskRoute {
  pattern: string;
  methods: string[];
  endpoint: string;
  viewFunction: string;
  decorators: string[];
  parameters: Array<{ name: string; type: string; converter?: string }>;
  blueprint?: string;
}

interface FlaskBlueprint {
  name: string;
  filePath: string;
  urlPrefix?: string;
  routes: FlaskRoute[];
  beforeRequests: string[];
  afterRequests: string[];
  errorHandlers: Array<{ code: number | string; handler: string }>;
}

interface FlaskView {
  name: string;
  filePath: string;
  type: 'function' | 'class';
  routes: FlaskRoute[];
  decorators: string[];
  templateName?: string;
  methods?: string[];
}

interface FlaskModel {
  name: string;
  filePath: string;
  baseClass: string;
  tableName?: string;
  columns: Array<{ name: string; type: string; constraints: string[] }>;
  relationships: Array<{ name: string; target: string; type: string; backref?: string }>;
  methods: Array<{ name: string; isClassMethod: boolean; isStaticMethod: boolean }>;
}

interface FlaskExtension {
  name: string;
  importName: string;
  configKeys: string[];
  initMethod?: string;
}

interface FlaskTemplate {
  name: string;
  filePath: string;
  extends?: string;
  blocks: string[];
  includes: string[];
  variables: string[];
}

interface FlaskForm {
  name: string;
  filePath: string;
  baseClass: string;
  fields: Array<{ name: string; type: string; validators: string[] }>;
  methods: string[];
}

export class FlaskAnalyzer extends BaseAnalyzer {

  constructor() {
    super(
      'flask',
      'Flask Framework Analyzer',
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
        if (requirements.includes('Flask') || requirements.includes('flask')) return true;
      }

      if (await fs.pathExists(pipfilePath)) {
        const pipfile = await fs.readFile(pipfilePath, 'utf-8');
        if (pipfile.includes('Flask') || pipfile.includes('flask')) return true;
      }

      if (await fs.pathExists(pyprojectPath)) {
        const pyproject = await fs.readFile(pyprojectPath, 'utf-8');
        // Real-dependency-only: a pyproject.toml [project.optional-dependencies]
        // extras group named "flask" (an integration target the package can
        // instrument) is not evidence the project itself is built with Flask.
        if (this.pyprojectHasRealDependency(pyproject, 'flask')) return true;
      }

      const pythonFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/src/analyzer/**', '**/analyzer/**', '**/analyzers/**'],
        nodir: true
      });

      for (const file of pythonFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        // Require an actual Flask APPLICATION shape (app construction or a
        // route/blueprint registration) — never a bare `from flask import`/
        // `import flask` alone. A lazy, function-scoped `from flask import g,
        // request` inside a framework-agnostic integration/telemetry helper
        // (duck-typed so it "imports nothing from the framework at module
        // load", instrumenting a CALLER's Flask app rather than being one) is
        // exactly this shape and must not, by itself, mark the analyzed repo
        // as a Flask application.
        if (
          /\bFlask\s*\(/.test(content) ||
          /@\s*(?:app|blueprint|bp)\.route\s*\(/.test(content) ||
          /\bBlueprint\s*\(/.test(content)
        ) {
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
    return glob(['**/*.py'], {
      cwd: projectPath,
      ignore: [
        ...this.getIgnorePatterns({ projectPath }),
        '**/venv/**',
        '**/.venv/**',
        '**/env/**',
        '**/__pycache__/**'
      ],
      nodir: true
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const file = context.relativePath;
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const application = await this.analyzeApplication([file], context.projectPath, nodes);
    const blueprints = await this.analyzeBlueprints([file], context.projectPath, nodes, edges, entryPoints);
    const views = await this.analyzeViews([file], context.projectPath, nodes, edges, entryPoints);
    const models = await this.analyzeModels([file], context.projectPath, nodes, edges, exitPoints);
    const forms = await this.analyzeFormsImpl([file], context.projectPath, nodes, edges);
    const extensions = await this.analyzeExtensionsImpl([file], context.projectPath, nodes);

    this.buildFlaskRelationshipsImpl(application, blueprints, views, models, [], nodes, edges);
    this.identifyDatabaseConnectionsImpl(application, models, extensions, exitPoints);

    return this.createFileAnalysisResult(
      context.filePath,
      file,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      this.extractPythonImports(content),
      [...new Set([...nodes.map(node => node.name), ...forms.map(form => form.name)])]
    );
  }

  async analyze(context: AnalysisContext): Promise<CASAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: any[] = [];
    const exitPoints: any[] = [];

    try {
      const ignorePatterns = this.getIgnorePatterns(context);
      const pythonIgnorePatterns = [...ignorePatterns, '**/venv/**', '**/.venv/**', '**/env/**', '**/__pycache__/**'];
      const pythonFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: pythonIgnorePatterns,
        nodir: true
      });

      const htmlFiles = await glob(['**/templates/**/*.html'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      });

      const application = await this.analyzeApplication(pythonFiles, context.projectPath, nodes);
      const blueprints = await this.analyzeBlueprints(pythonFiles, context.projectPath, nodes, edges, entryPoints);
      const views = await this.analyzeViews(pythonFiles, context.projectPath, nodes, edges, entryPoints);
      const models = await this.analyzeModels(pythonFiles, context.projectPath, nodes, edges, exitPoints);
      const templates = await this.analyzeTemplates(htmlFiles, context.projectPath, nodes, edges);
      const forms = await this.analyzeFormsImpl(pythonFiles, context.projectPath, nodes, edges);
      const extensions = await this.analyzeExtensionsImpl(pythonFiles, context.projectPath, nodes);

      this.buildFlaskRelationshipsImpl(application, blueprints, views, models, templates, nodes, edges);
      this.identifyDatabaseConnectionsImpl(application, models, extensions, exitPoints);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'flask',
        version: await this.detectFlaskVersionImpl(context.projectPath),
        applicationFound: application !== null,
        blueprintsFound: blueprints.length,
        viewsFound: views.length,
        modelsFound: models.length,
        templatesFound: templates.length,
        formsFound: forms.length,
        extensionsFound: extensions.length
      });

    } catch (error) {
      throw new AnalyzerError(
        `Flask analysis failed: ${(error as Error).message}`,
        'FLASK_ANALYSIS_ERROR'
      );
    }
  }

  private async analyzeApplication(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<FlaskApplication | null> {
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('Flask(__name__)') || content.includes('Flask(')) {
        const appVariable = this.extractAppVariableImpl(content);
        if (appVariable) {
          const config = this.extractConfigImpl(content);
          const blueprints = this.extractBlueprintRegistrationsImpl(content);
          const extensions = this.extractExtensionInitializationsImpl(content);

          const application: FlaskApplication = {
            name: path.basename(file, '.py'),
            filePath: file,
            appVariable,
            config,
            blueprints,
            extensions
          };

          const appId = `app_${this.sanitizeId(application.name)}`;
          const documentation = this.extractDocumentation(content, fullPath);
          const comments = this.extractComments(content, fullPath);
          const todos = this.extractTodos(comments);
          const implementationStatus = this.determineImplementationStatus(content, comments);

          const appNode = this.createNodeBuilder(appId, application.name, 'application')
            .withLevel(1, 'system')
            .withCategory('application', ['framework', 'flask'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Flask application: ${application.name}`)
            .withDocumentation(documentation)
            .withComments(comments)
            .withTodos(todos)
            .withImplementationStatus(implementationStatus)
            .withMetadata({
              framework: 'flask',
              attributes: {
                appVariable,
                debug: config.debug,
                blueprints: blueprints.length,
                extensions: extensions.length,
                customSettings: Object.keys(config.customSettings).length
              }
            })
            .build();
          nodes.push(appNode);

          return application;
        }
      }
    }
    return null;
  }

  private async analyzeBlueprints(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<FlaskBlueprint[]> {
    const blueprints: FlaskBlueprint[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('Blueprint(')) {
        const blueprintName = this.extractBlueprintNameImpl(content);
        if (blueprintName) {
          const urlPrefix = this.extractBlueprintUrlPrefixImpl(content);
          const routes = this.extractRoutesImpl(content, blueprintName);
          const beforeRequests = this.extractBeforeRequestsImpl(content);
          const afterRequests = this.extractAfterRequestsImpl(content);
          const errorHandlers = this.extractErrorHandlersImpl(content);

          const blueprint: FlaskBlueprint = {
            name: blueprintName,
            filePath: file,
            urlPrefix,
            routes,
            beforeRequests,
            afterRequests,
            errorHandlers
          };

          blueprints.push(blueprint);

          const blueprintId = `blueprint_${this.sanitizeId(blueprintName)}`;
          const blueprintDocumentation = this.extractDocumentation(content, fullPath);
          const blueprintComments = this.extractComments(content, fullPath);
          const blueprintTodos = this.extractTodos(blueprintComments);
          const blueprintImplementationStatus = this.determineImplementationStatus(content, blueprintComments);

          const blueprintNode = this.createNodeBuilder(blueprintId, blueprintName, 'module')
            .withLevel(2, 'component')
            .withCategory('module', ['blueprint'])
            .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
            .withDescription(`Flask blueprint: ${blueprintName}`)
            .withDocumentation(blueprintDocumentation)
            .withComments(blueprintComments)
            .withTodos(blueprintTodos)
            .withImplementationStatus(blueprintImplementationStatus)
            .withMetadata({
              attributes: {
                urlPrefix: urlPrefix || '/',
                routes: routes.length,
                beforeRequests: beforeRequests.length,
                afterRequests: afterRequests.length,
                errorHandlers: errorHandlers.length
              }
            })
            .build();
          nodes.push(blueprintNode);

          routes.forEach((route, index) => {
            const routeId = `route_${blueprintId}_${index}`;
            const fullPath = `${urlPrefix || ''}${route.pattern}`.replace('//', '/');

            const routeNode = this.createNodeBuilder(routeId, `${route.methods.join('|')} ${fullPath}`, 'route')
              .withLevel(3, 'code')
              .withCategory('route', ['http', 'endpoint'])
              .withSource({ file: fullPath, line: 1, end_line: 1 })
              .withDescription(`Flask route: ${fullPath}`)
              .withMetadata({
                attributes: {
                  pattern: route.pattern,
                  methods: route.methods,
                  endpoint: route.endpoint,
                  viewFunction: route.viewFunction,
                  decorators: route.decorators,
                  parameters: route.parameters
                }
              })
              .build();
            nodes.push(routeNode);

            edges.push(this.createEdge(
              `${blueprintId}_exposes_${routeId}`,
              blueprintId,
              routeId,
              'exposes'
            ));

            route.methods.forEach(method => {
              // Canonical HTTP entry point: buildRouteTable filters type==='http'
              // and reads trigger.method/path (not metadata) — without trigger it
              // defaulted every route to "GET /".
              entryPoints.push(this.createEntryPoint(
                `entry_${routeId}_${method}`,
                routeId,
                'http',
                `${method.toUpperCase()} ${fullPath}`,
                `Flask route: ${method.toUpperCase()} ${fullPath}`,
                { method: method.toUpperCase(), path: fullPath },
                this.flaskSecurity(route.decorators),
                { method: method.toUpperCase(), path: fullPath, blueprint: blueprintName, endpoint: route.endpoint, handler: route.viewFunction }
              ));
            });
          });
        }
      }
    }

    return blueprints;
  }

  private async analyzeViews(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: any[]
  ): Promise<FlaskView[]> {
    const views: FlaskView[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const functionViews = this.extractFunctionViewsImpl(content, file);
      const classViews = this.extractClassViewsImpl(content, file);

      views.push(...functionViews, ...classViews);

      [...functionViews, ...classViews].forEach(view => {
        const viewId = `view_${this.sanitizeId(view.name)}`;
        const viewDocumentation = this.extractDocumentation(content, fullPath);
        const viewComments = this.extractComments(content, fullPath);
        const viewTodos = this.extractTodos(viewComments);
        const viewImplementationStatus = this.determineImplementationStatus(content, viewComments);

        const viewNode = this.createNodeBuilder(viewId, view.name, 'controller')
          .withLevel(3, 'code')
          .withCategory('controller', ['api', 'rest'])
          .withSource({ file: fullPath, line: 1, end_line: 1 })
          .withDescription(`Flask ${view.type} view: ${view.name}`)
          .withDocumentation(viewDocumentation)
          .withComments(viewComments)
          .withTodos(viewTodos)
          .withImplementationStatus(viewImplementationStatus)
          .withMetadata({
            attributes: {
              viewType: view.type,
              routes: view.routes.length,
              decorators: view.decorators,
              templateName: view.templateName,
              methods: view.methods
            }
          })
          .build();
        nodes.push(viewNode);

        view.routes.forEach((route, index) => {
          const routeId = `route_${viewId}_${index}`;

          const routeNode = this.createNodeBuilder(routeId, `${route.methods.join('|')} ${route.pattern}`, 'route')
            .withLevel(4, 'member')
            .withCategory('route', ['http', 'endpoint'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
            .withDescription(`Flask route: ${route.pattern}`)
            .withMetadata({
              attributes: {
                pattern: route.pattern,
                methods: route.methods,
                endpoint: route.endpoint,
                viewFunction: route.viewFunction,
                decorators: route.decorators
              }
            })
            .build();
          nodes.push(routeNode);

          edges.push(this.createEdge(
            `${viewId}_handles_${routeId}`,
            viewId,
            routeId,
            'handles'
          ));

          route.methods.forEach(method => {
            // Canonical HTTP entry point (trigger, not metadata) so buildRouteTable
            // surfaces the real method+path instead of defaulting to "GET /".
            entryPoints.push(this.createEntryPoint(
              `entry_${routeId}_${method}`,
              routeId,
              'http',
              `${method.toUpperCase()} ${route.pattern}`,
              `Flask route: ${method.toUpperCase()} ${route.pattern}`,
              { method: method.toUpperCase(), path: route.pattern },
              this.flaskSecurity(route.decorators),
              { method: method.toUpperCase(), path: route.pattern, handler: route.viewFunction, endpoint: route.endpoint }
            ));
          });
        });
      });
    }

    return views;
  }

  private async analyzeModels(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: any[]
  ): Promise<FlaskModel[]> {
    const models: FlaskModel[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('db.Model') || content.includes('SQLAlchemy')) {
        const extractedModels = this.extractModelsImpl(content, file);
        models.push(...extractedModels);

        extractedModels.forEach(model => {
          const modelId = `model_${this.sanitizeId(model.name)}`;
          const modelDocumentation = this.extractDocumentation(content, fullPath);
          const modelComments = this.extractComments(content, fullPath);
          const modelTodos = this.extractTodos(modelComments);
          const modelImplementationStatus = this.determineImplementationStatus(content, modelComments);

          const modelNode = this.createNodeBuilder(modelId, model.name, 'model')
            .withLevel(3, 'code')
            .withCategory('model', ['data', 'entity'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
            .withDescription(`Flask SQLAlchemy model: ${model.name}`)
            .withDocumentation(modelDocumentation)
            .withComments(modelComments)
            .withTodos(modelTodos)
            .withImplementationStatus(modelImplementationStatus)
            .withMetadata({
              attributes: {
                baseClass: model.baseClass,
                tableName: model.tableName,
                columns: model.columns.length,
                relationships: model.relationships.length,
                methods: model.methods.length
              }
            })
            .build();
          nodes.push(modelNode);

          exitPoints.push({
            id: `exit_db_${modelId}`,
            name: `Database table: ${model.tableName || model.name.toLowerCase()}`,
            type: 'database_table',
            source_node: modelId,
            metadata: {
              table: model.tableName || model.name.toLowerCase(),
              model: model.name,
              columns: model.columns.map(c => c.name)
            }
          });
        });
      }
    }

    return models;
  }

  private async analyzeTemplates(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<FlaskTemplate[]> {
    const templates: FlaskTemplate[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      const templateName = path.basename(file);
      const extendsTemplate = this.extractTemplateExtends(content);
      const blocks = this.extractTemplateBlocks(content);
      const includes = this.extractTemplateIncludes(content);
      const variables = this.extractTemplateVariables(content);

      const template: FlaskTemplate = {
        name: templateName,
        filePath: file,
        extends: extendsTemplate,
        blocks,
        includes,
        variables
      };

      templates.push(template);

      const templateId = `template_${this.sanitizeId(templateName)}`;
      const templateNode = this.createNodeBuilder(templateId, templateName, 'component')
        .withLevel(4, 'member')
        .withCategory('component', ['ui', 'template'])
        .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
        .withDescription(`Jinja template: ${templateName}`)
        .withMetadata({
          framework: 'flask',
          attributes: {
            extends: extendsTemplate,
            blocks: blocks.length,
            includes: includes.length,
            variables: variables.length
          }
        })
        .build();
      nodes.push(templateNode);

      if (extendsTemplate) {
        const parentTemplateId = `template_${this.sanitizeId(extendsTemplate)}`;
        edges.push(this.createEdge(
          `${templateId}_extends_${parentTemplateId}`,
          templateId,
          parentTemplateId,
          'extends'
        ));
      }

      includes.forEach(include => {
        const includedTemplateId = `template_${this.sanitizeId(include)}`;
        edges.push(this.createEdge(
          `${templateId}_includes_${includedTemplateId}`,
          templateId,
          includedTemplateId,
          'includes'
        ));
      });
    }

    return templates;
  }

  private async analyzeForms(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<FlaskForm[]> {
    const forms: FlaskForm[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('FlaskForm') || content.includes('Form') && content.includes('wtforms')) {
        const extractedForms = this.extractForms(content, file);
        forms.push(...extractedForms);

        extractedForms.forEach(form => {
          const formId = `form_${this.sanitizeId(form.name)}`;
          const formNode = this.createNodeBuilder(formId, form.name, 'component')
            .withLevel(3, 'code')
            .withCategory('component', ['ui', 'form'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
            .withDescription(`Flask form component: ${form.name}`)
            .withMetadata({
              framework: 'flask',
              attributes: {
                baseClass: form.baseClass,
                fields: form.fields.length,
                methods: form.methods.length
              }
            })
            .build();
          nodes.push(formNode);
        });
      }
    }

    return forms;
  }

  private async analyzeExtensions(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<FlaskExtension[]> {
    const extensions: FlaskExtension[] = [];
    const commonExtensions = [
      'SQLAlchemy', 'Migrate', 'Login', 'Mail', 'Cache', 'Bcrypt',
      'CORS', 'Limiter', 'Principal', 'Admin', 'Compress', 'Debug'
    ];

    for (const file of files) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');

      commonExtensions.forEach(ext => {
        if (content.includes(`flask_${ext.toLowerCase()}`) || content.includes(`Flask-${ext}`)) {
          const extensionName = ext.toLowerCase();
          if (!extensions.find(e => e.name === extensionName)) {
            const extension: FlaskExtension = {
              name: extensionName,
              importName: `flask_${ext.toLowerCase()}`,
              configKeys: [],
              initMethod: `init_app`
            };

            extensions.push(extension);

            const extensionId = `extension_${this.sanitizeId(extensionName)}`;
            const extensionNode = this.createNodeBuilder(extensionId, extensionName, 'service')
              .withLevel(2, 'architectural')
              .withCategory('service', ['framework', 'flask'])
              .withSource({ file: path.join(projectPath, file), line: 1, end_line: 1 })
              .withDescription(`Flask extension: ${extensionName}`)
              .withMetadata({
                framework: 'flask',
                attributes: {
                  importName: extension.importName,
                  initMethod: extension.initMethod
                }
              })
              .build();
            nodes.push(extensionNode);
          }
        }
      });
    }

    return extensions;
  }

  private extractAppVariable(content: string): string | null {
    const appPattern = /(\w+)\s*=\s*Flask\s*\(/;
    const match = appPattern.exec(content);
    return match ? match[1] : null;
  }

  private extractPythonImports(content: string): string[] {
    const imports: string[] = [];
    const importPattern = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let match;

    while ((match = importPattern.exec(content)) !== null) {
      imports.push(match[1] || match[2]);
    }

    return imports;
  }

  private extractConfig(content: string): FlaskConfig {
    const config: FlaskConfig = {
      debug: content.includes('debug=True') || content.includes('DEBUG = True'),
      testing: content.includes('testing=True') || content.includes('TESTING = True'),
      customSettings: {}
    };

    const secretKeyMatch = content.match(/SECRET_KEY\s*=\s*['"]([^'"]+)['"]/);
    if (secretKeyMatch) config.secretKey = secretKeyMatch[1];

    const databaseMatch = content.match(/SQLALCHEMY_DATABASE_URI\s*=\s*['"]([^'"]+)['"]/);
    if (databaseMatch) config.database = databaseMatch[1];

    return config;
  }

  private extractBlueprintRegistrations(content: string): string[] {
    const blueprints: string[] = [];
    const registerPattern = /\.register_blueprint\s*\(\s*(\w+)/g;

    let match;
    while ((match = registerPattern.exec(content)) !== null) {
      blueprints.push(match[1]);
    }

    return blueprints;
  }

  private extractExtensionInitializations(content: string): string[] {
    const extensions: string[] = [];
    const initPattern = /(\w+)\.init_app\s*\(/g;

    let match;
    while ((match = initPattern.exec(content)) !== null) {
      extensions.push(match[1]);
    }

    return extensions;
  }

  private extractBlueprintName(content: string): string | null {
    const blueprintPattern = /(\w+)\s*=\s*Blueprint\s*\(\s*['"]([^'"]+)['"]/;
    const match = blueprintPattern.exec(content);
    return match ? match[1] : null;
  }

  private extractBlueprintUrlPrefix(content: string): string | null {
    const prefixPattern = /Blueprint\s*\([^)]*url_prefix\s*=\s*['"]([^'"]+)['"]/;
    const match = prefixPattern.exec(content);
    return match ? match[1] : null;
  }

  private extractRoutes(content: string, blueprintName?: string): FlaskRoute[] {
    const routes: FlaskRoute[] = [];
    const routePattern = /@(?:(\w+)\.)?route\s*\(\s*['"]([^'"]+)['"](?:,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const routeBlueprintName = match[1];
      const pattern = match[2];
      const methodsStr = match[3];
      const viewFunction = match[4];

      const methods = methodsStr
        ? methodsStr.split(',').map(m => m.trim().replace(/['"]/g, '').toLowerCase())
        : ['get'];

      const decorators = this.extractRouteDecorators(content, match.index);
      const parameters = this.extractRouteParameters(pattern);

      routes.push({
        pattern,
        methods,
        endpoint: `${blueprintName || routeBlueprintName || 'main'}.${viewFunction}`,
        viewFunction,
        decorators,
        parameters,
        blueprint: blueprintName || routeBlueprintName
      });
    }

    return routes;
  }

  private extractFunctionViews(content: string, filePath: string): FlaskView[] {
    const views: FlaskView[] = [];
    const functionPattern = /@(?:\w+\.)?route[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = functionPattern.exec(content)) !== null) {
      const viewName = match[1];
      const decorators = this.extractRouteDecorators(content, match.index);
      const routes = this.extractRoutes(content);
      const viewRoutes = routes.filter(r => r.viewFunction === viewName);
      const templateName = this.extractTemplateUsage(content, viewName);

      views.push({
        name: viewName,
        filePath,
        type: 'function',
        routes: viewRoutes,
        decorators,
        templateName
      });
    }

    return views;
  }

  private extractClassViews(content: string, filePath: string): FlaskView[] {
    const views: FlaskView[] = [];
    const classPattern = /class\s+(\w+)\s*\(\s*(?:MethodView|View)\s*\):/g;

    let match;
    while ((match = classPattern.exec(content)) !== null) {
      const viewName = match[1];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const methods = this.extractViewMethods(classContent);
      const decorators = this.extractClassDecorators(content, classStart);

      views.push({
        name: viewName,
        filePath,
        type: 'class',
        routes: [],
        decorators,
        methods
      });
    }

    return views;
  }

  private extractModels(content: string, filePath: string): FlaskModel[] {
    const models: FlaskModel[] = [];
    const modelPattern = /class\s+(\w+)\s*\(\s*(db\.Model|Model)\s*\):/g;

    let match;
    while ((match = modelPattern.exec(content)) !== null) {
      const modelName = match[1];
      const baseClass = match[2];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const tableName = this.extractTableName(classContent);
      const columns = this.extractModelColumns(classContent);
      const relationships = this.extractModelRelationships(classContent);
      const methods = this.extractModelMethods(classContent);

      models.push({
        name: modelName,
        filePath,
        baseClass,
        tableName,
        columns,
        relationships,
        methods
      });
    }

    return models;
  }

  private extractForms(content: string, filePath: string): FlaskForm[] {
    const forms: FlaskForm[] = [];
    const formPattern = /class\s+(\w+)\s*\(\s*(FlaskForm|Form)\s*\):/g;

    let match;
    while ((match = formPattern.exec(content)) !== null) {
      const formName = match[1];
      const baseClass = match[2];
      const classStart = match.index;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const fields = this.extractFormFields(classContent);
      const methods = this.extractFormMethods(classContent);

      forms.push({
        name: formName,
        filePath,
        baseClass,
        fields,
        methods
      });
    }

    return forms;
  }

  /** Per-view auth from Flask decorators (flask-login / flask-jwt-extended / flask-security). */
  private flaskSecurity(decorators: string[] = []): { authenticated: boolean; guards: string[] } {
    const AUTH = /^(login_required|fresh_login_required|jwt_required|jwt_optional|roles_required|roles_accepted|permission_required|auth_required|token_required|requires_auth)$/i;
    const guards = decorators.filter(d => AUTH.test(d));
    return { authenticated: guards.length > 0, guards };
  }

  private extractRouteDecorators(content: string, position: number): string[] {
    const decorators: string[] = [];
    const lines = content.substring(0, position).split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('@')) {
        const decoratorMatch = line.match(/@(\w+)/);
        if (decoratorMatch) {
          decorators.unshift(decoratorMatch[1]);
        }
      } else if (line && !line.startsWith('#') && !line.startsWith('def')) {
        break;
      }
    }

    // Decorators stacked BELOW @app.route but above the `def` (e.g.
    // `@app.route(...)` then `@login_required` then `def`) also apply to the
    // view — scan forward to the handler so auth/guard decorators aren't lost.
    const forward = content.substring(position).split('\n');
    for (let i = 1; i < forward.length; i++) {
      const line = forward[i].trim();
      if (line.startsWith('def') || line.startsWith('async def')) break;
      if (line.startsWith('@')) {
        const m = line.match(/@[\w.]*?(\w+)\s*(?:\(|$)/);
        if (m) decorators.push(m[1]);
      }
      // Other lines (multiline @app.route args) are skipped, not terminal.
    }

    return [...new Set(decorators)];
  }

  private extractRouteParameters(pattern: string): Array<{ name: string; type: string; converter?: string }> {
    const parameters: Array<{ name: string; type: string; converter?: string }> = [];
    const paramPattern = /<(?:(\w+):)?(\w+)>/g;

    let match;
    while ((match = paramPattern.exec(pattern)) !== null) {
      const converter = match[1];
      const name = match[2];

      parameters.push({
        name,
        type: converter || 'string',
        converter
      });
    }

    return parameters;
  }

  private extractBeforeRequests(content: string): string[] {
    const beforeRequests: string[] = [];
    const pattern = /@(?:\w+\.)?before_request[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      beforeRequests.push(match[1]);
    }

    return beforeRequests;
  }

  private extractAfterRequests(content: string): string[] {
    const afterRequests: string[] = [];
    const pattern = /@(?:\w+\.)?after_request[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      afterRequests.push(match[1]);
    }

    return afterRequests;
  }

  private extractErrorHandlers(content: string): Array<{ code: number | string; handler: string }> {
    const errorHandlers: Array<{ code: number | string; handler: string }> = [];
    const pattern = /@(?:\w+\.)?errorhandler\s*\(\s*(\w+)\s*\)[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const code = match[1];
      const handler = match[2];

      errorHandlers.push({
        code: isNaN(Number(code)) ? code : Number(code),
        handler
      });
    }

    return errorHandlers;
  }

  private extractTemplateUsage(content: string, functionName: string): string | undefined {
    const functionPattern = new RegExp(`def\\s+${functionName}[\\s\\S]*?return[\\s\\S]*?render_template\\s*\\(\\s*['"]([^'"]+)['"]`, 'g');
    const match = functionPattern.exec(content);
    return match ? match[1] : undefined;
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

  private extractClassDecorators(content: string, position: number): string[] {
    const decorators: string[] = [];
    const lines = content.substring(0, position).split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('@')) {
        const decoratorMatch = line.match(/@(\w+)/);
        if (decoratorMatch) {
          decorators.unshift(decoratorMatch[1]);
        }
      } else if (line && !line.startsWith('#') && !line.startsWith('class')) {
        break;
      }
    }

    return decorators;
  }

  private extractTableName(content: string): string | undefined {
    const tablePattern = /__tablename__\s*=\s*['"]([^'"]+)['"]/;
    const match = tablePattern.exec(content);
    return match ? match[1] : undefined;
  }

  private extractModelColumns(content: string): Array<{ name: string; type: string; constraints: string[] }> {
    const columns: Array<{ name: string; type: string; constraints: string[] }> = [];
    const columnPattern = /(\w+)\s*=\s*db\.Column\s*\(\s*db\.(\w+)/g;

    let match;
    while ((match = columnPattern.exec(content)) !== null) {
      const name = match[1];
      const type = match[2];

      columns.push({
        name,
        type,
        constraints: []
      });
    }

    return columns;
  }

  private extractModelRelationships(content: string): Array<{ name: string; target: string; type: string; backref?: string }> {
    const relationships: Array<{ name: string; target: string; type: string; backref?: string }> = [];
    const relationPattern = /(\w+)\s*=\s*db\.relationship\s*\(\s*['"]([^'"]+)['"]/g;

    let match;
    while ((match = relationPattern.exec(content)) !== null) {
      const name = match[1];
      const target = match[2];

      relationships.push({
        name,
        target,
        type: 'relationship'
      });
    }

    return relationships;
  }

  private extractModelMethods(content: string): Array<{ name: string; isClassMethod: boolean; isStaticMethod: boolean }> {
    const methods: Array<{ name: string; isClassMethod: boolean; isStaticMethod: boolean }> = [];
    const methodPattern = /def\s+(\w+)\s*\(/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      const name = match[1];
      if (name !== '__init__' && name !== '__str__' && name !== '__repr__') {
        methods.push({
          name,
          isClassMethod: content.includes(`@classmethod\n    def ${name}`),
          isStaticMethod: content.includes(`@staticmethod\n    def ${name}`)
        });
      }
    }

    return methods;
  }

  private extractFormFields(content: string): Array<{ name: string; type: string; validators: string[] }> {
    const fields: Array<{ name: string; type: string; validators: string[] }> = [];
    const fieldPattern = /(\w+)\s*=\s*(\w+Field)\s*\(/g;

    let match;
    while ((match = fieldPattern.exec(content)) !== null) {
      const name = match[1];
      const type = match[2];

      fields.push({
        name,
        type,
        validators: []
      });
    }

    return fields;
  }

  private extractFormMethods(content: string): string[] {
    const methods: string[] = [];
    const methodPattern = /def\s+(validate_\w+)\s*\(/g;

    let match;
    while ((match = methodPattern.exec(content)) !== null) {
      methods.push(match[1]);
    }

    return methods;
  }

  private extractTemplateExtends(content: string): string | undefined {
    const extendsPattern = /{%\s*extends\s+['"]([^'"]+)['"]\s*%}/;
    const match = extendsPattern.exec(content);
    return match ? match[1] : undefined;
  }

  private extractTemplateBlocks(content: string): string[] {
    const blocks: string[] = [];
    const blockPattern = /{%\s*block\s+(\w+)\s*%}/g;

    let match;
    while ((match = blockPattern.exec(content)) !== null) {
      blocks.push(match[1]);
    }

    return blocks;
  }

  private extractTemplateIncludes(content: string): string[] {
    const includes: string[] = [];
    const includePattern = /{%\s*include\s+['"]([^'"]+)['"]\s*%}/g;

    let match;
    while ((match = includePattern.exec(content)) !== null) {
      includes.push(match[1]);
    }

    return includes;
  }

  private extractTemplateVariables(content: string): string[] {
    const variables: string[] = [];
    const variablePattern = /{{\s*(\w+)(?:\.\w+)*\s*}}/g;

    let match;
    while ((match = variablePattern.exec(content)) !== null) {
      if (!variables.includes(match[1])) {
        variables.push(match[1]);
      }
    }

    return variables;
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

  private async detectFlaskVersion(projectPath: string): Promise<string> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        const versionMatch = requirements.match(/Flask==([^\s\n]+)/i);
        if (versionMatch) return versionMatch[1];
      }
    } catch {
      // Continue with other methods
    }

    return 'unknown';
  }

  private buildFlaskRelationships(
    application: FlaskApplication | null,
    blueprints: FlaskBlueprint[],
    views: FlaskView[],
    models: FlaskModel[],
    templates: FlaskTemplate[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    if (!application) return;

    const appId = `app_${this.sanitizeId(application.name)}`;

    blueprints.forEach(blueprint => {
      const blueprintId = `blueprint_${this.sanitizeId(blueprint.name)}`;
      edges.push(this.createEdge(
        `${appId}_registers_${blueprintId}`,
        appId,
        blueprintId,
        'registers'
      ));
    });

    views.forEach(view => {
      const viewId = `view_${this.sanitizeId(view.name)}`;

      if (view.templateName) {
        const templateId = `template_${this.sanitizeId(view.templateName)}`;
        edges.push(this.createEdge(
          `${viewId}_renders_${templateId}`,
          viewId,
          templateId,
          'renders'
        ));
      }

      models.forEach(model => {
        const modelId = `model_${this.sanitizeId(model.name)}`;
        if (view.name.toLowerCase().includes(model.name.toLowerCase()) ||
            view.templateName?.includes(model.name.toLowerCase())) {
          edges.push(this.createEdge(
            `${viewId}_uses_${modelId}`,
            viewId,
            modelId,
            'uses'
          ));
        }
      });
    });

    models.forEach(model => {
      const modelId = `model_${this.sanitizeId(model.name)}`;

      model.relationships.forEach(relationship => {
        const targetModelId = `model_${this.sanitizeId(relationship.target)}`;
        edges.push(this.createEdge(
          `${modelId}_${relationship.type}_${targetModelId}`,
          modelId,
          targetModelId,
          relationship.type
        ));
      });
    });
  }

  private identifyDatabaseConnections(models: FlaskModel[], extensions: FlaskExtension[], exitPoints: any[]): void {
    if (models.length > 0) {
      exitPoints.push({
        id: 'exit_flask_database',
        name: 'Flask Database Connection',
        type: 'database_connection',
        source_node: 'flask_sqlalchemy',
        metadata: {
          models: models.map(m => m.name),
          tables: models.map(m => m.tableName || m.name.toLowerCase()),
          orm: 'SQLAlchemy'
        }
      });
    }
  }

  protected getCapabilities(): string[] {
    return [
      'flask-analysis',
      'blueprint-extraction',
      'route-analysis',
      'view-function-detection',
      'model-discovery',
      'template-analysis',
      'form-detection',
      'extension-analysis'
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

  private async analyzeFormsImpl(
    files: string[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<FlaskForm[]> {
    const forms: FlaskForm[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');

      if (content.includes('FlaskForm') || (content.includes('Form') && content.includes('wtforms'))) {
        const extractedForms = this.extractFormsImpl(content, file);
        forms.push(...extractedForms);

        extractedForms.forEach(form => {
          const formId = `form_${this.sanitizeId(form.name)}`;
          const formNode = this.createNodeBuilder(formId, form.name, 'component')
            .withLevel(3, 'code')
            .withCategory('component', ['ui', 'form'])
            .withSource({ file: fullPath, line: 1, end_line: 1 })
            .withDescription(`Flask form component: ${form.name}`)
            .withMetadata({
              framework: 'flask',
              attributes: {
                baseClass: form.baseClass,
                fields: form.fields.length,
                methods: form.methods.length
              }
            })
            .build();
          nodes.push(formNode);
        });
      }
    }

    return forms;
  }

  private async analyzeExtensionsImpl(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<FlaskExtension[]> {
    const extensions: FlaskExtension[] = [];
    const commonExtensions = [
      'SQLAlchemy', 'Migrate', 'Login', 'Mail', 'Cache', 'Bcrypt',
      'CORS', 'Limiter', 'Principal', 'Admin', 'Compress', 'Debug'
    ];

    for (const file of files) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');

      commonExtensions.forEach(ext => {
        if (content.includes(`flask_${ext.toLowerCase()}`) || content.includes(`Flask-${ext}`)) {
          const extensionName = ext.toLowerCase();
          if (!extensions.find(e => e.name === extensionName)) {
            const extension: FlaskExtension = {
              name: extensionName,
              importName: `flask_${ext.toLowerCase()}`,
              configKeys: [],
              initMethod: `init_app`
            };

            extensions.push(extension);

            const extensionId = `extension_${this.sanitizeId(extensionName)}`;
            const extensionNode = this.createNodeBuilder(extensionId, extensionName, 'service')
              .withLevel(2, 'architectural')
              .withCategory('service', ['framework', 'flask'])
              .withSource({ file: path.join(projectPath, file), line: 1, end_line: 1 })
              .withDescription(`Flask extension: ${extensionName}`)
              .withMetadata({
                framework: 'flask',
                attributes: {
                  importName: extension.importName,
                  initMethod: extension.initMethod
                }
              })
              .build();
            nodes.push(extensionNode);
          }
        }
      });
    }

    return extensions;
  }

  private buildFlaskRelationshipsImpl(
    application: FlaskApplication | null,
    blueprints: FlaskBlueprint[],
    views: FlaskView[],
    models: FlaskModel[],
    templates: FlaskTemplate[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    if (!application) return;

    const appId = `app_${this.sanitizeId(application.name)}`;

    blueprints.forEach(blueprint => {
      const blueprintId = `blueprint_${this.sanitizeId(blueprint.name)}`;
      edges.push(this.createEdge(
        `${appId}_registers_${blueprintId}`,
        appId,
        blueprintId,
        'registers'
      ));
    });

    views.forEach(view => {
      const viewId = `view_${this.sanitizeId(view.name)}`;

      if (view.templateName) {
        const templateId = `template_${this.sanitizeId(view.templateName)}`;
        edges.push(this.createEdge(
          `${viewId}_renders_${templateId}`,
          viewId,
          templateId,
          'renders'
        ));
      }

      models.forEach(model => {
        const modelId = `model_${this.sanitizeId(model.name)}`;
        if (view.name.toLowerCase().includes(model.name.toLowerCase()) ||
            view.templateName?.includes(model.name.toLowerCase())) {
          edges.push(this.createEdge(
            `${viewId}_uses_${modelId}`,
            viewId,
            modelId,
            'uses'
          ));
        }
      });
    });

    models.forEach(model => {
      const modelId = `model_${this.sanitizeId(model.name)}`;

      model.relationships.forEach(relationship => {
        const targetModelId = `model_${this.sanitizeId(relationship.target)}`;
        edges.push(this.createEdge(
          `${modelId}_${relationship.type}_${targetModelId}`,
          modelId,
          targetModelId,
          relationship.type
        ));
      });
    });
  }

  private identifyDatabaseConnectionsImpl(application: FlaskApplication | null, models: FlaskModel[], extensions: FlaskExtension[], exitPoints: CASExitPoint[]): void {
    if (models.length > 0) {
      const sourceNode = application ? `app_${this.sanitizeId(application.name)}` : `model_${this.sanitizeId(models[0].name)}`;
      exitPoints.push(this.createExitPoint(
        'exit_flask_database',
        sourceNode,
        'database',
        'Flask Database Connection',
        'SQLAlchemy database connection',
        {
          service_id: 'sqlalchemy-database',
          resource: 'database'
        },
        {
          action: 'read_write',
          async: false
        },
        {
          models: models.map(m => m.name),
          tables: models.map(m => m.tableName || m.name.toLowerCase()),
          orm: 'SQLAlchemy'
        }
      ));
    }
  }

  private async detectFlaskVersionImpl(projectPath: string): Promise<string> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        const versionMatch = requirements.match(/Flask==([^\s\n]+)/i);
        if (versionMatch) return versionMatch[1];
      }
    } catch {
      // Continue with other methods
    }

    return 'unknown';
  }

  private extractAppVariableImpl(content: string): string | undefined {
    const appPattern = /(\w+)\s*=\s*Flask\s*\(/;
    const match = appPattern.exec(content);
    return match ? match[1] : undefined;
  }

  private extractConfigImpl(content: string): FlaskConfig {
    const config: FlaskConfig = {
      debug: content.includes('debug=True') || content.includes('DEBUG = True'),
      testing: content.includes('testing=True') || content.includes('TESTING = True'),
      customSettings: {}
    };

    const secretKeyMatch = content.match(/SECRET_KEY\s*=\s*['"]([^'"]+)['"]/);
    if (secretKeyMatch) config.secretKey = secretKeyMatch[1];

    const databaseMatch = content.match(/SQLALCHEMY_DATABASE_URI\s*=\s*['"]([^'"]+)['"]/);
    if (databaseMatch) config.database = databaseMatch[1];

    return config;
  }

  private extractBlueprintRegistrationsImpl(content: string): string[] {
    const blueprints: string[] = [];
    const registerPattern = /\.register_blueprint\s*\(\s*(\w+)/g;

    let match;
    while ((match = registerPattern.exec(content)) !== null) {
      blueprints.push(match[1]);
    }

    return blueprints;
  }

  private extractExtensionInitializationsImpl(content: string): string[] {
    const extensions: string[] = [];
    const initPattern = /(\w+)\.init_app\s*\(/g;

    let match;
    while ((match = initPattern.exec(content)) !== null) {
      extensions.push(match[1]);
    }

    return extensions;
  }

  private extractBlueprintNameImpl(content: string): string | undefined {
    const blueprintPattern = /(\w+)\s*=\s*Blueprint\s*\(\s*['"]([^'"]+)['"]/;
    const match = blueprintPattern.exec(content);
    return match ? match[1] : undefined;
  }

  private extractBlueprintUrlPrefixImpl(content: string): string | undefined {
    const prefixPattern = /Blueprint\s*\([^)]*url_prefix\s*=\s*['"]([^'"]+)['"]/;
    const match = prefixPattern.exec(content);
    return match ? match[1] : undefined;
  }

  private extractBeforeRequestsImpl(content: string): string[] {
    const beforeRequests: string[] = [];
    const pattern = /@(?:\w+\.)?before_request[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      beforeRequests.push(match[1]);
    }

    return beforeRequests;
  }

  private extractAfterRequestsImpl(content: string): string[] {
    const afterRequests: string[] = [];
    const pattern = /@(?:\w+\.)?after_request[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      afterRequests.push(match[1]);
    }

    return afterRequests;
  }

  private extractErrorHandlersImpl(content: string): Array<{ code: number | string; handler: string }> {
    const errorHandlers: Array<{ code: number | string; handler: string }> = [];
    const pattern = /@(?:\w+\.)?errorhandler\s*\(\s*(\w+)\s*\)[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const code = match[1];
      const handler = match[2];

      errorHandlers.push({
        code: isNaN(Number(code)) ? code : Number(code),
        handler
      });
    }

    return errorHandlers;
  }

  private extractRoutesImpl(content: string, blueprintName?: string): FlaskRoute[] {
    const routes: FlaskRoute[] = [];
    const routePattern = /@(?:(\w+)\.)?route\s*\(\s*['"]([^'"]+)['"](?:,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const routeBlueprintName = match[1];
      const pattern = match[2];
      const methodsStr = match[3];
      const viewFunction = match[4];

      const methods = methodsStr
        ? methodsStr.split(',').map(m => m.trim().replace(/['"]/g, '').toLowerCase())
        : ['get'];

      const decorators = this.extractRouteDecorators(content, match.index!);
      const parameters = this.extractRouteParameters(pattern);

      routes.push({
        pattern,
        methods,
        endpoint: `${blueprintName || routeBlueprintName || 'main'}.${viewFunction}`,
        viewFunction,
        decorators,
        parameters,
        blueprint: blueprintName || routeBlueprintName
      });
    }

    return routes;
  }

  private extractFunctionViewsImpl(content: string, filePath: string): FlaskView[] {
    const views: FlaskView[] = [];
    const functionPattern = /@(?:\w+\.)?route[\s\S]*?def\s+(\w+)\s*\(/g;

    let match;
    while ((match = functionPattern.exec(content)) !== null) {
      const viewName = match[1];
      const decorators = this.extractRouteDecorators(content, match.index!);
      const routes = this.extractRoutesImpl(content);
      const viewRoutes = routes.filter(r => r.viewFunction === viewName);
      const templateName = this.extractTemplateUsage(content, viewName);

      views.push({
        name: viewName,
        filePath,
        type: 'function',
        routes: viewRoutes,
        decorators,
        templateName
      });
    }

    return views;
  }

  private extractClassViewsImpl(content: string, filePath: string): FlaskView[] {
    const views: FlaskView[] = [];
    const classPattern = /class\s+(\w+)\s*\(\s*(?:MethodView|View)\s*\):/g;

    let match;
    while ((match = classPattern.exec(content)) !== null) {
      const viewName = match[1];
      const classStart = match.index!;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const methods = this.extractViewMethods(classContent);
      const decorators = this.extractClassDecorators(content, classStart);

      views.push({
        name: viewName,
        filePath,
        type: 'class',
        routes: [],
        decorators,
        methods
      });
    }

    return views;
  }

  private extractModelsImpl(content: string, filePath: string): FlaskModel[] {
    const models: FlaskModel[] = [];
    const modelPattern = /class\s+(\w+)\s*\(\s*(db\.Model|Model)\s*\):/g;

    let match;
    while ((match = modelPattern.exec(content)) !== null) {
      const modelName = match[1];
      const baseClass = match[2];
      const classStart = match.index!;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const tableName = this.extractTableName(classContent);
      const columns = this.extractModelColumns(classContent);
      const relationships = this.extractModelRelationships(classContent);
      const methods = this.extractModelMethods(classContent);

      models.push({
        name: modelName,
        filePath,
        baseClass,
        tableName,
        columns,
        relationships,
        methods
      });
    }

    return models;
  }

  private extractFormsImpl(content: string, filePath: string): FlaskForm[] {
    const forms: FlaskForm[] = [];
    const formPattern = /class\s+(\w+)\s*\(\s*(FlaskForm|Form)\s*\):/g;

    let match;
    while ((match = formPattern.exec(content)) !== null) {
      const formName = match[1];
      const baseClass = match[2];
      const classStart = match.index!;
      const classEnd = this.findClassEnd(content, classStart);
      const classContent = content.substring(classStart, classEnd);

      const fields = this.extractFormFields(classContent);
      const methods = this.extractFormMethods(classContent);

      forms.push({
        name: formName,
        filePath,
        baseClass,
        fields,
        methods
      });
    }

    return forms;
  }

  // CAS v1.4.0 Documentation and Comment extraction methods
  private extractDocumentation(content: string, filePath: string): CASDocumentation | undefined {
    if (!content || content.trim().length === 0) return undefined;

    const lines = content.split('\n');

    // Look for Flask-specific documentation patterns

    // 1. Route decorator documentation
    const routeDocMatches = content.matchAll(/@app\.route\([^)]*\)\s*\n\s*def\s+\w+[^:]*:\s*['"""]([^'"]*?)['"""]/g);
    const routeDocs = [];
    for (const match of routeDocMatches) {
      routeDocs.push(match[1].trim());
    }

    // 2. Blueprint configuration documentation
    const blueprintDocMatches = content.matchAll(/Blueprint\([^)]*\)\s*#\s*(.+)/g);
    const blueprintDocs = [];
    for (const match of blueprintDocMatches) {
      blueprintDocs.push(match[1].trim());
    }

    // 3. Template helper documentation
    const templateHelperMatches = content.matchAll(/@app\.template_filter\([^)]*\)\s*\n\s*def\s+\w+[^:]*:\s*['"""]([^'"]*?)['"""]/g);
    const templateHelpers = [];
    for (const match of templateHelperMatches) {
      templateHelpers.push(match[1].trim());
    }

    // 4. Function and class docstrings
    const functionDocStrings = [];
    const functionMatches = content.matchAll(/def\s+\w+[^:]*:\s*['"""]([^'"]*?)['"""]/g);
    for (const match of functionMatches) {
      functionDocStrings.push(match[1].trim());
    }

    if (routeDocs.length > 0 || blueprintDocs.length > 0 || templateHelpers.length > 0 || functionDocStrings.length > 0) {
      const doc: CASDocumentation = {
        type: 'flask_documentation',
        raw: content,
        location: { start_line: 1, end_line: lines.length }
      };

      if (functionDocStrings.length > 0) {
        doc.summary = functionDocStrings[0].split('\n')[0].trim();
        doc.description = functionDocStrings[0].trim();
      }

      doc.framework_docs = {
        flask: {}
      };

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

      // Python single-line comments
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

      // Multi-line string comments (docstrings used as comments)
      const docstringMatch = line.match(/^\s*['"]{3}([^'"]*?)['"]{3}/);
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
      has_hardcoded_values: /['\"](localhost|127\.0\.0\.1|test|example|demo|placeholder)['\"]/.test(content),
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
}
