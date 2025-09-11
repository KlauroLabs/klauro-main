// Flask Framework Analyzer - Specialized analysis for Flask applications
// Phase 3: Framework Sub-Analyzers - Production-ready Flask analyzer

import { PythonAnalyzer } from '../../languages/python-analyzer';
import { ComponentNode, ComponentType, Connection, APIEndpoint, DatabaseConnection, ComponentMetadata } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface FlaskRoute {
  path: string;
  methods: string[];
  handler: string;
  blueprint?: string;
  decorators: string[];
  middleware: string[];
  beforeRequest: string[];
  afterRequest: string[];
}

export interface FlaskBlueprint {
  name: string;
  filePath: string;
  urlPrefix?: string;
  routes: FlaskRoute[];
  staticFolder?: string;
  templateFolder?: string;
  errorHandlers: Map<number, string>;
}

export interface FlaskExtension {
  name: string;
  type: 'database' | 'auth' | 'admin' | 'mail' | 'cache' | 'session' | 'other';
  initialized: boolean;
  configKeys: string[];
}

export interface FlaskTemplate {
  name: string;
  path: string;
  extends?: string;
  blocks: string[];
  includes: string[];
  macros: string[];
  filters: string[];
}

export interface FlaskForm {
  name: string;
  filePath: string;
  fields: FlaskFormField[];
  validators: string[];
  baseClass: string;
}

export interface FlaskFormField {
  name: string;
  type: string;
  validators: string[];
  required: boolean;
  label?: string;
}

export class FlaskAnalyzer extends PythonAnalyzer {
  private flaskVersion: string = '';
  private routes: Map<string, FlaskRoute> = new Map();
  private blueprints: Map<string, FlaskBlueprint> = new Map();
  private extensions: Map<string, FlaskExtension> = new Map();
  private templates: Map<string, FlaskTemplate> = new Map();
  private forms: Map<string, FlaskForm> = new Map();
  private appInstances: string[] = [];
  private configuration: Record<string, any> = {};
  private hasSQLAlchemy: boolean = false;
  private hasLogin: boolean = false;
  private hasAdmin: boolean = false;
  private hasMail: boolean = false;
  private hasWTForms: boolean = false;
  private hasCelery: boolean = false;
  private hasSocketIO: boolean = false;
  
  getAnalyzerName(): string {
    return 'Flask Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['flask', 'flask-sqlalchemy', 'flask-login', 'flask-wtf', 'flask-admin'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Check for Flask in requirements
    await this.detectFlaskVersion();
    
    // Detect Flask ecosystem
    this.hasSQLAlchemy = await this.detectPackage('flask-sqlalchemy');
    this.hasLogin = await this.detectPackage('flask-login');
    this.hasAdmin = await this.detectPackage('flask-admin');
    this.hasMail = await this.detectPackage('flask-mail');
    this.hasWTForms = await this.detectPackage('flask-wtf');
    this.hasCelery = await this.detectPackage('celery');
    this.hasSocketIO = await this.detectPackage('flask-socketio');
    
    // Find Flask app files
    await this.findAppInstances();
    
    // Load configuration
    await this.loadConfiguration();
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks.filter(f => f.name !== 'flask'), {
        name: 'flask',
        version: this.flaskVersion,
        confidence: 0.95,
        patterns: ['Flask application detected'],
        configFiles: ['app.py', 'application.py', 'config.py', '__init__.py'],
        dependencies: ['flask']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('flask-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    
    // Discover Flask components
    await this.discoverRoutes();
    await this.discoverBlueprints();
    await this.discoverExtensions();
    await this.discoverTemplates();
    await this.discoverForms();
    
    // Build component nodes
    const components = new Map<string, ComponentNode>();
    
    // Add routes as components
    for (const [id, route] of this.routes) {
      const node: ComponentNode = {
        id,
        name: `${route.methods.join(',')} ${route.path}`,
        type: 'controller',
        path: route.handler,
        language: 'python',
        framework: 'flask',
        dependencies: [],
        dependents: [],
        metrics: {
          linesOfCode: 0,
          complexity: route.methods.length + route.decorators.length,
          maintainability: 100 - route.decorators.length * 3,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        metadata: {
          lineCount: 0,
          complexity: route.methods.length + route.decorators.length,
          lastModified: new Date(),
          exports: [],
          imports: [],
          httpMethods: route.methods,
          layer: 'presentation',
          responsibilities: [`Handle requests to ${route.path}`],
          frameworkType: 'route',
          path: route.path
        } as ComponentMetadata & { frameworkType: string; path: string }
      };
      components.set(id, node);
    }
    
    // Add blueprints as components
    for (const [id, blueprint] of this.blueprints) {
      const node: ComponentNode = {
        id,
        name: blueprint.name,
        type: 'utility',
        path: blueprint.filePath,
        language: 'python',
        framework: 'flask',
        dependencies: [],
        dependents: [],
        metrics: {
          linesOfCode: await this.countLinesOfCode(blueprint.filePath),
          complexity: blueprint.routes.length,
          maintainability: 100 - blueprint.routes.length * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        metadata: {
          lineCount: 0,
          complexity: blueprint.routes.length,
          lastModified: new Date(),
          exports: [],
          imports: [],
          layer: 'infrastructure',
          responsibilities: ['Blueprint routing and organization'],
          frameworkType: 'blueprint',
          urlPrefix: blueprint.urlPrefix
        } as ComponentMetadata & { frameworkType: string; urlPrefix?: string }
      };
      components.set(id, node);
    }
    
    // Add forms as components
    for (const [id, form] of this.forms) {
      const node: ComponentNode = {
        id,
        name: form.name,
        type: 'model',
        path: form.filePath,
        language: 'python',
        framework: 'flask',
        dependencies: [],
        dependents: [],
        metrics: {
          linesOfCode: await this.countLinesOfCode(form.filePath),
          complexity: form.fields.length + form.validators.length,
          maintainability: 100 - form.fields.length * 2,
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        metadata: {
          lineCount: 0,
          complexity: form.fields.length + form.validators.length,
          lastModified: new Date(),
          exports: [],
          imports: [],
          layer: 'presentation',
          responsibilities: ['Form validation and handling'],
          frameworkType: 'form',
          baseClass: form.baseClass,
          fields: form.fields.map(f => f.name)
        } as ComponentMetadata & { frameworkType: string; baseClass: string; fields: string[] }
      };
      components.set(id, node);
    }
    
    // Build connections
    const connections = await this.buildFlaskConnections();
    
    // Extract API endpoints
    const apiEndpoints = this.extractFlaskEndpoints();
    
    // Extract database connections
    const databaseConnections = await this.extractDatabaseConnections();
    
    telemetry.emit({
      type: 'component_discovery_completed',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        routes: this.routes.size,
        blueprints: this.blueprints.size,
        extensions: this.extensions.size,
        templates: this.templates.size,
        forms: this.forms.size,
        hasSQLAlchemy: this.hasSQLAlchemy,
        hasLogin: this.hasLogin
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: this.findFlaskEntryPoints(),
      connections,
      layers: this.buildFlaskLayers(),
      apiEndpoints,
      databaseConnections
    };
  }

  private async detectFlaskVersion(): Promise<void> {
    const requirementsPaths = [
      'requirements.txt',
      'requirements/base.txt',
      'Pipfile',
      'pyproject.toml'
    ];
    
    for (const reqPath of requirementsPaths) {
      const fullPath = path.join(this.projectPath, reqPath);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        const versionMatch = content.match(/[Ff]lask(?:==|>=|~=|>)?([\d.]+)/);
        if (versionMatch) {
          this.flaskVersion = versionMatch[1];
          break;
        }
      }
    }
  }

  private async detectPackage(packageName: string): Promise<boolean> {
    const requirementsPaths = [
      'requirements.txt',
      'requirements/base.txt',
      'Pipfile',
      'pyproject.toml'
    ];
    
    for (const reqPath of requirementsPaths) {
      const fullPath = path.join(this.projectPath, reqPath);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        if (content.toLowerCase().includes(packageName.toLowerCase())) {
          return true;
        }
      }
    }
    
    return false;
  }

  private async findAppInstances(): Promise<void> {
    const appFiles = ['app.py', 'application.py', '__init__.py', 'run.py', 'wsgi.py'];
    
    for (const appFile of appFiles) {
      const fullPath = path.join(this.projectPath, appFile);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        if (content.includes('Flask(__name__)') || content.includes('Flask(')) {
          this.appInstances.push(appFile);
        }
      }
    }
    
    // Search for Flask instances in Python files
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    for (const file of pythonFiles.slice(0, 30)) {
      const content = await fs.readFile(file, 'utf-8');
      if (content.includes('Flask(__name__)') && !this.appInstances.includes(file)) {
        this.appInstances.push(file);
      }
    }
  }

  private async loadConfiguration(): Promise<void> {
    const configFiles = ['config.py', 'settings.py', 'configuration.py'];
    
    for (const configFile of configFiles) {
      const fullPath = path.join(this.projectPath, configFile);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        this.parseConfiguration(content);
        break;
      }
    }
  }

  private parseConfiguration(content: string): void {
    // Parse common Flask config variables
    const configPatterns = [
      { key: 'SECRET_KEY', pattern: /SECRET_KEY\s*=\s*["']([^"']+)["']/ },
      { key: 'DEBUG', pattern: /DEBUG\s*=\s*(True|False)/ },
      { key: 'TESTING', pattern: /TESTING\s*=\s*(True|False)/ },
      { key: 'DATABASE_URI', pattern: /DATABASE_URI\s*=\s*["']([^"']+)["']/ },
      { key: 'SQLALCHEMY_DATABASE_URI', pattern: /SQLALCHEMY_DATABASE_URI\s*=\s*["']([^"']+)["']/ }
    ];
    
    for (const { key, pattern } of configPatterns) {
      const match = content.match(pattern);
      if (match) {
        this.configuration[key] = match[1];
      }
    }
  }

  private async discoverRoutes(): Promise<void> {
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles) {
      const content = await fs.readFile(file, 'utf-8');
      const routes = this.parseFlaskRoutes(content, file);
      
      for (const route of routes) {
        const id = `${route.methods.join('_')}_${route.path.replace(/[/<>]/g, '_')}`;
        this.routes.set(id, route);
      }
    }
  }

  private parseFlaskRoutes(content: string, filePath: string): FlaskRoute[] {
    const routes: FlaskRoute[] = [];
    
    // Match route decorators
    const routeRegex = /@(?:app|bp|blueprint)\.route\s*\(\s*["']([^"']+)["']/g;
    const lines = content.split('\n');
    
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const path = match[1];
      
      // Find the function definition after the decorator
      const decoratorIndex = content.substring(0, match.index).split('\n').length;
      let handler = '';
      let methods: string[] = ['GET'];
      let decorators: string[] = [];
      
      // Extract methods from decorator
      const decoratorEndIndex = content.indexOf(')', match.index) + 1;
      const decoratorContent = content.substring(match.index, decoratorEndIndex);
      
      const methodsMatch = decoratorContent.match(/methods\s*=\s*\[([^\]]+)\]/);
      if (methodsMatch) {
        methods = this.parseStringList(methodsMatch[1]).map(m => m.toUpperCase());
      }
      
      // Look for the function definition
      for (let i = decoratorIndex; i < Math.min(decoratorIndex + 10, lines.length); i++) {
        const line = lines[i];
        const funcMatch = line.match(/^def\s+(\w+)/);
        if (funcMatch) {
          handler = funcMatch[1];
          
          // Collect decorators
          for (let j = decoratorIndex - 1; j >= Math.max(0, decoratorIndex - 10); j--) {
            const decoratorLine = lines[j].trim();
            if (decoratorLine.startsWith('@')) {
              decorators.push(decoratorLine.substring(1).split('(')[0]);
            } else if (!decoratorLine.startsWith('#') && decoratorLine.length > 0) {
              break;
            }
          }
          break;
        }
      }
      
      routes.push({
        path,
        methods,
        handler: `${filePath}::${handler}`,
        decorators: decorators.reverse(),
        middleware: [],
        beforeRequest: [],
        afterRequest: []
      });
    }
    
    // Also parse add_url_rule patterns
    const addUrlRuleRegex = /app\.add_url_rule\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*,\s*(\w+)/g;
    
    while ((match = addUrlRuleRegex.exec(content)) !== null) {
      routes.push({
        path: match[1],
        methods: ['GET'],
        handler: `${filePath}::${match[3]}`,
        decorators: [],
        middleware: [],
        beforeRequest: [],
        afterRequest: []
      });
    }
    
    return routes;
  }

  private async discoverBlueprints(): Promise<void> {
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for Blueprint definitions
      if (content.includes('Blueprint(')) {
        const blueprints = this.parseBlueprints(content, file);
        
        for (const blueprint of blueprints) {
          this.blueprints.set(blueprint.name, blueprint);
          
          // Parse blueprint routes
          const bpRoutes = this.parseBlueprintRoutes(content, file, blueprint.name);
          blueprint.routes.push(...bpRoutes);
        }
      }
    }
  }

  private parseBlueprints(content: string, filePath: string): FlaskBlueprint[] {
    const blueprints: FlaskBlueprint[] = [];
    const bpRegex = /(\w+)\s*=\s*Blueprint\s*\(\s*["']([^"']+)["']\s*,\s*__name__([^)]*)\)/g;
    let match;
    
    while ((match = bpRegex.exec(content)) !== null) {
      const varName = match[1];
      const bpName = match[2];
      const params = match[3];
      
      const blueprint: FlaskBlueprint = {
        name: bpName,
        filePath,
        routes: [],
        errorHandlers: new Map()
      };
      
      // Extract url_prefix
      const prefixMatch = params.match(/url_prefix\s*=\s*["']([^"']+)["']/);
      if (prefixMatch) {
        blueprint.urlPrefix = prefixMatch[1];
      }
      
      // Extract static_folder
      const staticMatch = params.match(/static_folder\s*=\s*["']([^"']+)["']/);
      if (staticMatch) {
        blueprint.staticFolder = staticMatch[1];
      }
      
      // Extract template_folder
      const templateMatch = params.match(/template_folder\s*=\s*["']([^"']+)["']/);
      if (templateMatch) {
        blueprint.templateFolder = templateMatch[1];
      }
      
      blueprints.push(blueprint);
    }
    
    return blueprints;
  }

  private parseBlueprintRoutes(content: string, filePath: string, blueprintName: string): FlaskRoute[] {
    const routes: FlaskRoute[] = [];
    const bpVar = this.findBlueprintVariable(content, blueprintName);
    
    if (!bpVar) return routes;
    
    const routeRegex = new RegExp(`@${bpVar}\\.route\\s*\\(\\s*["']([^"']+)["']`, 'g');
    let match;
    
    while ((match = routeRegex.exec(content)) !== null) {
      const path = match[1];
      const route: FlaskRoute = {
        path,
        methods: ['GET'],
        handler: `${filePath}::${blueprintName}`,
        blueprint: blueprintName,
        decorators: [],
        middleware: [],
        beforeRequest: [],
        afterRequest: []
      };
      
      routes.push(route);
    }
    
    return routes;
  }

  private findBlueprintVariable(content: string, blueprintName: string): string | null {
    const regex = new RegExp(`(\\w+)\\s*=\\s*Blueprint\\s*\\(\\s*["']${blueprintName}["']`);
    const match = content.match(regex);
    return match ? match[1] : null;
  }

  private async discoverExtensions(): Promise<void> {
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles.slice(0, 30)) {
      const content = await fs.readFile(file, 'utf-8');
      const extensions = this.parseExtensions(content);
      
      for (const ext of extensions) {
        this.extensions.set(ext.name, ext);
      }
    }
  }

  private parseExtensions(content: string): FlaskExtension[] {
    const extensions: FlaskExtension[] = [];
    
    const extensionPatterns = [
      { name: 'SQLAlchemy', pattern: /(\w+)\s*=\s*SQLAlchemy\s*\(/, type: 'database' as const },
      { name: 'LoginManager', pattern: /(\w+)\s*=\s*LoginManager\s*\(/, type: 'auth' as const },
      { name: 'Admin', pattern: /(\w+)\s*=\s*Admin\s*\(/, type: 'admin' as const },
      { name: 'Mail', pattern: /(\w+)\s*=\s*Mail\s*\(/, type: 'mail' as const },
      { name: 'Cache', pattern: /(\w+)\s*=\s*Cache\s*\(/, type: 'cache' as const },
      { name: 'Session', pattern: /(\w+)\s*=\s*Session\s*\(/, type: 'session' as const }
    ];
    
    for (const { name, pattern, type } of extensionPatterns) {
      const match = content.match(pattern);
      if (match) {
        extensions.push({
          name,
          type,
          initialized: content.includes(`${match[1]}.init_app`),
          configKeys: []
        });
      }
    }
    
    return extensions;
  }

  private async discoverTemplates(): Promise<void> {
    const templatePaths = ['templates', 'app/templates', 'application/templates'];
    
    for (const templatePath of templatePaths) {
      const fullPath = path.join(this.projectPath, templatePath);
      if (await fs.pathExists(fullPath)) {
        const htmlFiles = await this.findFiles([`${templatePath}/**/*.html`, `${templatePath}/**/*.jinja2`], []);
        
        for (const file of htmlFiles) {
          const content = await fs.readFile(file, 'utf-8');
          const template = this.parseTemplate(content, file);
          this.templates.set(template.name, template);
        }
      }
    }
  }

  private parseTemplate(content: string, filePath: string): FlaskTemplate {
    const template: FlaskTemplate = {
      name: path.basename(filePath),
      path: filePath,
      blocks: [],
      includes: [],
      macros: [],
      filters: []
    };
    
    // Extract extends
    const extendsMatch = content.match(/\{%\s*extends\s+["']([^"']+)["']\s*%\}/);
    if (extendsMatch) {
      template.extends = extendsMatch[1];
    }
    
    // Extract blocks
    const blockRegex = /\{%\s*block\s+(\w+)\s*%\}/g;
    let match;
    while ((match = blockRegex.exec(content)) !== null) {
      template.blocks.push(match[1]);
    }
    
    // Extract includes
    const includeRegex = /\{%\s*include\s+["']([^"']+)["']\s*%\}/g;
    while ((match = includeRegex.exec(content)) !== null) {
      template.includes.push(match[1]);
    }
    
    // Extract macros
    const macroRegex = /\{%\s*macro\s+(\w+)\s*\(/g;
    while ((match = macroRegex.exec(content)) !== null) {
      template.macros.push(match[1]);
    }
    
    return template;
  }

  private async discoverForms(): Promise<void> {
    if (!this.hasWTForms) return;
    
    const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
    
    for (const file of pythonFiles) {
      const content = await fs.readFile(file, 'utf-8');
      
      // Check for WTForms imports
      if (content.includes('from flask_wtf') || content.includes('from wtforms')) {
        const forms = this.parseForms(content, file);
        
        for (const form of forms) {
          this.forms.set(form.name, form);
        }
      }
    }
  }

  private parseForms(content: string, filePath: string): FlaskForm[] {
    const forms: FlaskForm[] = [];
    const formRegex = /class\s+(\w+)\s*\(([^)]*Form[^)]*)\)\s*:/g;
    let match;
    
    while ((match = formRegex.exec(content)) !== null) {
      const name = match[1];
      const baseClass = match[2].trim();
      
      const form: FlaskForm = {
        name,
        filePath,
        baseClass,
        fields: this.parseFormFields(content, name),
        validators: []
      };
      
      forms.push(form);
    }
    
    return forms;
  }

  private parseFormFields(content: string, className: string): FlaskFormField[] {
    const fields: FlaskFormField[] = [];
    
    // Find class definition
    const classRegex = new RegExp(`class\\s+${className}\\s*\\([^)]+\\)\\s*:([^\\n]*(?:\\n(?!class)[^\\n]*)*)`, 's');
    const classMatch = content.match(classRegex);
    
    if (classMatch) {
      const classContent = classMatch[1];
      const fieldRegex = /(\w+)\s*=\s*(\w+Field)\s*\(([^)]*)\)/g;
      let match;
      
      while ((match = fieldRegex.exec(classContent)) !== null) {
        const name = match[1];
        const type = match[2];
        const params = match[3];
        
        const field: FlaskFormField = {
          name,
          type,
          validators: this.parseFieldValidators(params),
          required: !params.includes('optional=True')
        };
        
        // Extract label
        const labelMatch = params.match(/["']([^"']+)["']/);
        if (labelMatch) {
          field.label = labelMatch[1];
        }
        
        fields.push(field);
      }
    }
    
    return fields;
  }

  private parseFieldValidators(params: string): string[] {
    const validators: string[] = [];
    const validatorRegex = /(\w+)\s*\(/g;
    let match;
    
    while ((match = validatorRegex.exec(params)) !== null) {
      const validator = match[1];
      if (['DataRequired', 'Email', 'Length', 'NumberRange', 'Optional', 'Regexp'].includes(validator)) {
        validators.push(validator);
      }
    }
    
    return validators;
  }

  private parseStringList(content: string): string[] {
    const items: string[] = [];
    const regex = /["']([^"']+)["']/g;
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      items.push(match[1]);
    }
    
    return items;
  }

  private async countLinesOfCode(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.split('\n').length;
    } catch {
      return 0;
    }
  }

  private async buildFlaskConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Blueprint to Route connections
    for (const [routeId, route] of this.routes) {
      if (route.blueprint) {
        connections.push({
          from: route.blueprint,
          to: routeId,
          type: 'contains',
          protocol: 'flask',
          metadata: {
            callSites: 1,
            routePath: route.path
          }
        });
      }
    }
    
    // Form to Route connections (form handling)
    for (const [formId, form] of this.forms) {
      // Try to find routes that might use this form
      for (const [routeId, route] of this.routes) {
        if (route.methods.includes('POST')) {
          connections.push({
            from: routeId,
            to: formId,
            type: 'form-handling',
            protocol: 'flask-wtf',
            metadata: {
              callSites: 1,
              formName: form.name
            }
          });
        }
      }
    }
    
    // Template relationships
    for (const [templateId, template] of this.templates) {
      if (template.extends) {
        connections.push({
          from: templateId,
          to: template.extends,
          type: 'template-inheritance',
          protocol: 'jinja2',
          metadata: {
            callSites: 1,
            relationship: 'extends'
          }
        });
      }
      
      for (const include of template.includes) {
        connections.push({
          from: templateId,
          to: include,
          type: 'template-include',
          protocol: 'jinja2',
          metadata: {
            callSites: 1,
            relationship: 'includes'
          }
        });
      }
    }
    
    return connections;
  }

  private extractFlaskEndpoints(): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    
    for (const [id, route] of this.routes) {
      for (const method of route.methods) {
        endpoints.push({
          id: `${id}-${method.toLowerCase()}`,
          path: route.blueprint ? `${this.blueprints.get(route.blueprint)?.urlPrefix || ''}${route.path}` : route.path,
          method: method as APIEndpoint['method'],
          description: `Flask ${method} endpoint for ${route.path}`,
          handler: route.handler,
          parameters: [],
          statusCodes: [{ code: 200, description: 'Success' }],
          middleware: route.middleware,
          authentication: {
            type: route.decorators.includes('login_required') ? 'jwt' : 'none',
            required: route.decorators.includes('login_required')
          },
          rateLimit: undefined,
          deprecated: false,
          componentId: id
        });
      }
    }
    
    return endpoints;
  }

  private async extractDatabaseConnections(): Promise<DatabaseConnection[]> {
    const connections: DatabaseConnection[] = [];
    
    // Check for SQLAlchemy
    if (this.hasSQLAlchemy && this.configuration.SQLALCHEMY_DATABASE_URI) {
      const uri = this.configuration.SQLALCHEMY_DATABASE_URI;
      const dbType = this.extractDatabaseType(uri);
      
      connections.push({
        id: 'flask-sqlalchemy',
        name: 'Flask-SQLAlchemy',
        type: dbType,
        host: this.extractHost(uri),
        port: this.extractPort(uri, dbType),
        database: this.extractDatabase(uri),
        schema: 'public',
        tables: [],
        usage: [],
        componentIds: []
      });
    }
    
    return connections;
  }

  private extractDatabaseType(uri: string): DatabaseConnection['type'] {
    if (uri.includes('postgresql')) return 'postgresql';
    if (uri.includes('mysql')) return 'mysql';
    if (uri.includes('sqlite')) return 'sqlite';
    if (uri.includes('mongodb')) return 'mongodb';
    if (uri.includes('redis')) return 'redis';
    return 'postgresql'; // Default fallback
  }

  private extractHost(uri: string): string {
    const match = uri.match(/@([^:/]+)/);
    return match ? match[1] : 'localhost';
  }

  private extractPort(uri: string, dbType: DatabaseConnection['type']): number {
    const match = uri.match(/:(\d+)\//);
    if (match) return parseInt(match[1]);
    
    switch (dbType) {
      case 'postgresql': return 5432;
      case 'mysql': return 3306;
      default: return 0;
    }
  }

  private extractDatabase(uri: string): string {
    const match = uri.match(/\/([^?]+)(\?|$)/);
    return match ? match[1] : 'app';
  }

  private findFlaskEntryPoints(): string[] {
    const entryPoints: string[] = [];
    
    // Add main app files
    entryPoints.push(...this.appInstances);
    
    // Add WSGI entry points
    if (this.appInstances.includes('wsgi.py')) {
      entryPoints.push('wsgi:app');
    }
    
    // Add common Flask patterns
    entryPoints.push('app:create_app', 'application:app');
    
    return entryPoints;
  }

  private buildFlaskLayers(): Record<string, string[]> {
    return {
      'routes': Array.from(this.routes.keys()),
      'blueprints': Array.from(this.blueprints.keys()),
      'extensions': Array.from(this.extensions.keys()),
      'templates': Array.from(this.templates.keys()),
      'forms': Array.from(this.forms.keys()),
      'models': this.hasSQLAlchemy ? ['SQLAlchemy Models'] : []
    };
  }

  async analyzePerformance(): Promise<any> {
    // Base performance metrics
    
    return {
      flask: {
        routesCount: this.routes.size,
        blueprintsCount: this.blueprints.size,
        extensionsCount: this.extensions.size,
        templatesCount: this.templates.size,
        formsCount: this.forms.size,
        averageRoutesPerBlueprint: this.calculateAverageRoutesPerBlueprint(),
        features: {
          hasSQLAlchemy: this.hasSQLAlchemy,
          hasLogin: this.hasLogin,
          hasAdmin: this.hasAdmin,
          hasMail: this.hasMail,
          hasWTForms: this.hasWTForms,
          hasCelery: this.hasCelery,
          hasSocketIO: this.hasSocketIO
        }
      }
    };
  }

  private calculateAverageRoutesPerBlueprint(): number {
    const blueprints = Array.from(this.blueprints.values());
    if (blueprints.length === 0) return 0;
    
    const totalRoutes = blueprints.reduce((sum, bp) => sum + bp.routes.length, 0);
    return totalRoutes / blueprints.length;
  }
}