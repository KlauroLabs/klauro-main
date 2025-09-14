// Django Framework Analyzer - Specialized analysis for Django applications
// Phase 3: Framework Sub-Analyzers - Production-ready Django analyzer

import { PythonAnalyzer } from '../../languages/python-analyzer';
import { ComponentNode, ComponentType, Connection, APIEndpoint, DatabaseConnection, ComponentMetadata } from '../../../types';
import { telemetry } from '../../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface DjangoModel {
  name: string;
  app: string;
  filePath: string;
  fields: DjangoField[];
  meta: DjangoModelMeta;
  managers: string[];
  methods: string[];
  properties: string[];
  relationships: DjangoRelationship[];
  isAbstract: boolean;
}

export interface DjangoField {
  name: string;
  type: string;
  nullable: boolean;
  blank: boolean;
  default?: any;
  unique: boolean;
  indexed: boolean;
  validators: string[];
}

export interface DjangoModelMeta {
  dbTable?: string;
  ordering: string[];
  indexes: string[];
  constraints: string[];
  abstract: boolean;
  managed: boolean;
}

export interface DjangoRelationship {
  field: string;
  type: 'ForeignKey' | 'OneToOneField' | 'ManyToManyField';
  toModel: string;
  relatedName?: string;
  onDelete?: string;
}

export interface DjangoView {
  name: string;
  type: 'function' | 'class' | 'viewset';
  filePath: string;
  app: string;
  urlPattern?: string;
  methods: string[];
  permissions: string[];
  authentication: string[];
  serializers: string[];
  querysets: string[];
  decorators: string[];
}

export interface DjangoApp {
  name: string;
  path: string;
  models: string[];
  views: string[];
  urls: string[];
  serializers: string[];
  forms: string[];
  admin: string[];
  middleware: string[];
  templateTags: string[];
  management: string[];
}

export interface DjangoURL {
  pattern: string;
  view: string;
  name?: string;
  namespace?: string;
  includes?: string;
  app: string;
}

export class DjangoAnalyzer extends PythonAnalyzer {
  private djangoVersion: string = '';
  private apps: Map<string, DjangoApp> = new Map();
  private models: Map<string, DjangoModel> = new Map();
  private views: Map<string, DjangoView> = new Map();
  private urls: DjangoURL[] = [];
  private settings: Record<string, any> = {};
  private hasRestFramework: boolean = false;
  private hasCelery: boolean = false;
  private hasChannels: boolean = false;
  private databases: DatabaseConnection[] = [];
  
  getAnalyzerName(): string {
    return 'Django Framework Analyzer';
  }

  getSupportedFrameworks(): string[] {
    return ['django', 'django-rest-framework', 'django-channels'];
  }

  protected async detectLanguageAndFramework(): Promise<any> {
    const baseDetection = await super.detectLanguageAndFramework();
    
    // Check for Django specific files
    const managePyPath = path.join(this.projectPath, 'manage.py');
    const settingsPath = await this.findSettingsFile();
    
    if (await fs.pathExists(managePyPath)) {
      // Parse requirements for Django version
      // Django version will be set from requirements.txt parsing
      
      // Load settings
      if (settingsPath) {
        await this.loadSettings(settingsPath);
      }
      
      // Detect Django extensions
      this.hasRestFramework = await this.detectPackage('djangorestframework');
      this.hasCelery = await this.detectPackage('celery');
      this.hasChannels = await this.detectPackage('channels');
    }
    
    return {
      ...baseDetection,
      frameworks: [...baseDetection.frameworks.filter(f => f.name !== 'django'), {
        name: 'django',
        version: this.djangoVersion,
        confidence: 0.98,
        patterns: ['Django project structure detected'],
        configFiles: ['manage.py', 'settings.py', 'urls.py', 'wsgi.py', 'asgi.py'],
        dependencies: ['django']
      }]
    };
  }

  protected async discoverComponents(): Promise<any> {
    const span = telemetry.createSpan('django-analyzer.discoverComponents');
    const baseDiscovery = await super.discoverComponents();
    
    // Discover Django apps
    await this.discoverDjangoApps();
    
    // Discover models
    await this.discoverModels();
    
    // Discover views
    await this.discoverViews();
    
    // Discover URLs
    await this.discoverURLs();
    
    // Build component nodes
    const components = new Map<string, ComponentNode>();
    
    // Add models as components
    for (const [id, model] of this.models) {
      const node: ComponentNode = {
        id,
        name: model.name,
        type: 'model',
        path: model.filePath,
        dependencies: this.extractModelDependencies(model),
        dependents: [],
        metrics: {
          linesOfCode: await this.countLinesOfCode(model.filePath),
          complexity: this.calculateModelComplexity(model),
          maintainability: this.calculateModelMaintainability(model),
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: this.calculateModelTechnicalDebt(model)
        },
        metadata: {
          lineCount: await this.countLinesOfCode(model.filePath),
          complexity: this.calculateModelComplexity(model),
          lastModified: new Date(),
          exports: model.fields.map(f => f.name),
          imports: this.extractModelDependencies(model),
          layer: 'data',
          responsibilities: ['Data modeling', 'Database entity'],
          // Framework-specific properties
          djangoType: 'model',
          app: model.app,
          meta: model.meta,
          isAbstract: model.isAbstract
        } as ComponentMetadata & { djangoType: string; app: string; meta: any; isAbstract: boolean }
      };
      components.set(id, node);
    }
    
    // Add views as components
    for (const [id, view] of this.views) {
      const node: ComponentNode = {
        id,
        name: view.name,
        type: 'controller',
        path: view.filePath,
        dependencies: [],
        dependents: [],
        metrics: {
          linesOfCode: await this.countLinesOfCode(view.filePath),
          complexity: view.methods.length + view.decorators.length,
          maintainability: 100 - (view.methods.length * 3),
          testCoverage: 0,
          duplicateCode: 0,
          technicalDebt: 0
        },
        metadata: {
          lineCount: 0,
          complexity: view.methods.length,
          lastModified: new Date(),
          exports: view.methods,
          imports: view.serializers,
          layer: 'presentation',
          responsibilities: ['HTTP request handling', 'API endpoints'],
          // Framework-specific properties
          djangoType: view.type,
          app: view.app,
          permissions: view.permissions,
          authentication: view.authentication
        } as ComponentMetadata & { djangoType: string; app: string; permissions: string[]; authentication: string[] }
      };
      components.set(id, node);
    }
    
    // Build connections
    const connections = await this.buildDjangoConnections();
    
    // Extract API endpoints
    const apiEndpoints = this.extractDjangoAPIEndpoints();
    
    // Extract database connections
    await this.extractDatabaseConnections();
    
    telemetry.emit({
      type: 'component_discovered',
      source: { analyzer: this.getAnalyzerName() },
      data: {
        totalComponents: components.size,
        apps: this.apps.size,
        models: this.models.size,
        views: this.views.size,
        urls: this.urls.length,
        hasRestFramework: this.hasRestFramework,
        hasCelery: this.hasCelery
      }
    });
    
    span.end();
    return {
      components: Array.from(components.values()),
      entryPoints: this.findDjangoEntryPoints(),
      connections,
      layers: this.buildDjangoLayers(),
      apiEndpoints,
      databaseConnections: this.databases
    };
  }

  private async detectDjangoVersionInternal(): Promise<string | undefined> {
    const requirementsPaths = [
      'requirements.txt',
      'requirements/base.txt',
      'requirements/production.txt',
      'Pipfile',
      'pyproject.toml'
    ];
    
    for (const reqPath of requirementsPaths) {
      const fullPath = path.join(this.projectPath, reqPath);
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        const versionMatch = content.match(/[Dd]jango(?:==|>=|~=|>)?([\d.]+)/);
        if (versionMatch) {
          this.djangoVersion = versionMatch[1];
          return this.djangoVersion;
        }
      }
    }
    return this.djangoVersion || undefined;
  }

  private async findSettingsFile(): Promise<string | null> {
    const settingsPaths = [
      'settings.py',
      'config/settings.py',
      'config/settings/base.py',
      'project/settings.py'
    ];
    
    for (const settingsPath of settingsPaths) {
      const fullPath = path.join(this.projectPath, settingsPath);
      if (await fs.pathExists(fullPath)) {
        return fullPath;
      }
    }
    
    // Search for settings.py in any directory
    const files = await this.findFiles(['**/settings.py'], this.options.excludePatterns);
    return files.length > 0 ? files[0] : null;
  }

  private async loadSettings(settingsPath: string): Promise<void> {
    const content = await fs.readFile(settingsPath, 'utf-8');
    
    // Parse INSTALLED_APPS
    const installedAppsMatch = content.match(/INSTALLED_APPS\s*=\s*\[([^\]]+)\]/s);
    if (installedAppsMatch) {
      const apps = installedAppsMatch[1];
      this.settings.INSTALLED_APPS = this.parseStringList(apps);
    }
    
    // Parse DATABASES
    const databasesMatch = content.match(/DATABASES\s*=\s*{([^}]+)}/s);
    if (databasesMatch) {
      this.settings.DATABASES = this.parseDatabaseConfig(databasesMatch[1]);
    }
    
    // Parse MIDDLEWARE
    const middlewareMatch = content.match(/MIDDLEWARE\s*=\s*\[([^\]]+)\]/s);
    if (middlewareMatch) {
      this.settings.MIDDLEWARE = this.parseStringList(middlewareMatch[1]);
    }
    
    // Parse REST_FRAMEWORK settings
    const restFrameworkMatch = content.match(/REST_FRAMEWORK\s*=\s*{([^}]+)}/s);
    if (restFrameworkMatch) {
      this.settings.REST_FRAMEWORK = {};
      this.hasRestFramework = true;
    }
    
    // Parse CELERY settings
    if (content.includes('CELERY_')) {
      this.hasCelery = true;
    }
  }

  private parseStringList(content: string): string[] {
    const items: string[] = [];
    const regex = /['"]([^'"]+)['"]/g;
    let match;
    
    while ((match = regex.exec(content)) !== null) {
      items.push(match[1]);
    }
    
    return items;
  }

  private parseDatabaseConfig(content: string): any {
    const config: any = {};
    
    // Simple parsing for default database
    if (content.includes("'ENGINE'")) {
      const engineMatch = content.match(/['"]ENGINE['"]\s*:\s*['"]([^'"]+)['"]/);
      const nameMatch = content.match(/['"]NAME['"]\s*:\s*['"]([^'"]+)['"]/);
      
      if (engineMatch) {
        config.default = {
          ENGINE: engineMatch[1],
          NAME: nameMatch ? nameMatch[1] : ''
        };
      }
    }
    
    return config;
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

  private async discoverDjangoApps(): Promise<void> {
    // Get app directories from INSTALLED_APPS
    const installedApps = this.settings.INSTALLED_APPS || [];
    const localApps = installedApps.filter((app: string) => !app.startsWith('django.'));
    
    for (const appName of localApps) {
      const appPath = appName.replace(/\./g, '/');
      const fullPath = path.join(this.projectPath, appPath);
      
      if (await fs.pathExists(fullPath)) {
        const app: DjangoApp = {
          name: appName,
          path: fullPath,
          models: [],
          views: [],
          urls: [],
          serializers: [],
          forms: [],
          admin: [],
          middleware: [],
          templateTags: [],
          management: []
        };
        
        // Check for app components
        if (await fs.pathExists(path.join(fullPath, 'models.py'))) {
          app.models.push('models.py');
        }
        
        if (await fs.pathExists(path.join(fullPath, 'views.py'))) {
          app.views.push('views.py');
        }
        
        if (await fs.pathExists(path.join(fullPath, 'urls.py'))) {
          app.urls.push('urls.py');
        }
        
        if (await fs.pathExists(path.join(fullPath, 'serializers.py'))) {
          app.serializers.push('serializers.py');
        }
        
        if (await fs.pathExists(path.join(fullPath, 'forms.py'))) {
          app.forms.push('forms.py');
        }
        
        if (await fs.pathExists(path.join(fullPath, 'admin.py'))) {
          app.admin.push('admin.py');
        }
        
        this.apps.set(appName, app);
      }
    }
  }

  private async discoverModels(): Promise<void> {
    for (const [appName, app] of this.apps) {
      for (const modelFile of app.models) {
        const filePath = path.join(app.path, modelFile);
        if (await fs.pathExists(filePath)) {
          const content = await fs.readFile(filePath, 'utf-8');
          const models = this.parseDjangoModels(content, filePath, appName);
          
          for (const model of models) {
            this.models.set(`${appName}.${model.name}`, model);
          }
        }
      }
    }
  }

  private parseDjangoModels(content: string, filePath: string, appName: string): DjangoModel[] {
    const models: DjangoModel[] = [];
    const modelRegex = /class\s+(\w+)\s*\(([^)]+)\)\s*:/g;
    let match;
    
    while ((match = modelRegex.exec(content)) !== null) {
      const className = match[1];
      const baseClass = match[2];
      
      // Check if it's a Django model
      if (baseClass.includes('Model')) {
        const model: DjangoModel = {
          name: className,
          app: appName,
          filePath,
          fields: this.parseModelFields(content, className),
          meta: this.parseModelMeta(content, className),
          managers: this.parseModelManagers(content, className),
          methods: this.parseModelMethods(content, className),
          properties: this.parseModelProperties(content, className),
          relationships: this.parseModelRelationships(content, className),
          isAbstract: baseClass.includes('abstract') || this.isAbstractModel(content, className)
        };
        
        models.push(model);
      }
    }
    
    return models;
  }

  private parseModelFields(content: string, className: string): DjangoField[] {
    const fields: DjangoField[] = [];
    
    // Find the class definition
    const classRegex = new RegExp(`class\\s+${className}\\s*\\([^)]+\\)\\s*:([^\\n]*(?:\\n(?!class)[^\\n]*)*)`, 's');
    const classMatch = content.match(classRegex);
    
    if (classMatch) {
      const classContent = classMatch[1];
      const fieldRegex = /(\w+)\s*=\s*models\.(\w+Field)\s*\(([^)]*)\)/g;
      let match;
      
      while ((match = fieldRegex.exec(classContent)) !== null) {
        const fieldName = match[1];
        const fieldType = match[2];
        const fieldParams = match[3];
        
        fields.push({
          name: fieldName,
          type: fieldType,
          nullable: fieldParams.includes('null=True'),
          blank: fieldParams.includes('blank=True'),
          unique: fieldParams.includes('unique=True'),
          indexed: fieldParams.includes('db_index=True'),
          validators: this.parseFieldValidators(fieldParams)
        });
      }
    }
    
    return fields;
  }

  private parseFieldValidators(params: string): string[] {
    const validators: string[] = [];
    
    if (params.includes('validators=')) {
      const validatorMatch = params.match(/validators=\[([^\]]+)\]/);
      if (validatorMatch) {
        const validatorList = validatorMatch[1];
        const validatorRegex = /(\w+)\(/g;
        let match;
        
        while ((match = validatorRegex.exec(validatorList)) !== null) {
          validators.push(match[1]);
        }
      }
    }
    
    return validators;
  }

  private parseModelMeta(content: string, className: string): DjangoModelMeta {
    const meta: DjangoModelMeta = {
      ordering: [],
      indexes: [],
      constraints: [],
      abstract: false,
      managed: true
    };
    
    // Find Meta class
    const metaRegex = new RegExp(`class\\s+${className}[^}]+class\\s+Meta\\s*:([^\\n]*(?:\\n(?!\\s*class)[^\\n]*)*)`, 's');
    const metaMatch = content.match(metaRegex);
    
    if (metaMatch) {
      const metaContent = metaMatch[1];
      
      // Parse db_table
      const tableMatch = metaContent.match(/db_table\s*=\s*['"]([^'"]+)['"]/);
      if (tableMatch) {
        meta.dbTable = tableMatch[1];
      }
      
      // Parse ordering
      const orderingMatch = metaContent.match(/ordering\s*=\s*\[([^\]]+)\]/);
      if (orderingMatch) {
        meta.ordering = this.parseStringList(orderingMatch[1]);
      }
      
      // Parse abstract
      meta.abstract = metaContent.includes('abstract = True');
      
      // Parse managed
      meta.managed = !metaContent.includes('managed = False');
    }
    
    return meta;
  }

  private parseModelManagers(content: string, className: string): string[] {
    const managers: string[] = [];
    const managerRegex = /(\w+)\s*=\s*(?:models\.)?Manager\s*\(/g;
    let match;
    
    while ((match = managerRegex.exec(content)) !== null) {
      managers.push(match[1]);
    }
    
    return managers;
  }

  private parseModelMethods(content: string, className: string): string[] {
    const methods: string[] = [];
    const methodRegex = /def\s+(\w+)\s*\(self[^)]*\)/g;
    let match;
    
    while ((match = methodRegex.exec(content)) !== null) {
      if (!match[1].startsWith('_')) {
        methods.push(match[1]);
      }
    }
    
    return methods;
  }

  private parseModelProperties(content: string, className: string): string[] {
    const properties: string[] = [];
    const propertyRegex = /@property\s+def\s+(\w+)/g;
    let match;
    
    while ((match = propertyRegex.exec(content)) !== null) {
      properties.push(match[1]);
    }
    
    return properties;
  }

  private parseModelRelationships(content: string, className: string): DjangoRelationship[] {
    const relationships: DjangoRelationship[] = [];
    const relationRegex = /(\w+)\s*=\s*models\.(ForeignKey|OneToOneField|ManyToManyField)\s*\(([^)]+)\)/g;
    let match;
    
    while ((match = relationRegex.exec(content)) !== null) {
      const field = match[1];
      const type = match[2] as DjangoRelationship['type'];
      const params = match[3];
      
      // Parse target model
      const toModelMatch = params.match(/['"]?(\w+)['"]?/);
      const relatedNameMatch = params.match(/related_name=['"]([^'"]+)['"]/);
      const onDeleteMatch = params.match(/on_delete=models\.(\w+)/);
      
      relationships.push({
        field,
        type,
        toModel: toModelMatch ? toModelMatch[1] : '',
        relatedName: relatedNameMatch ? relatedNameMatch[1] : undefined,
        onDelete: onDeleteMatch ? onDeleteMatch[1] : undefined
      });
    }
    
    return relationships;
  }

  private isAbstractModel(content: string, className: string): boolean {
    const metaRegex = new RegExp(`class\\s+${className}[^}]+class\\s+Meta[^}]+abstract\\s*=\\s*True`);
    return metaRegex.test(content);
  }

  private async discoverViews(): Promise<void> {
    for (const [appName, app] of this.apps) {
      for (const viewFile of app.views) {
        const filePath = path.join(app.path, viewFile);
        if (await fs.pathExists(filePath)) {
          const content = await fs.readFile(filePath, 'utf-8');
          const views = this.parseDjangoViews(content, filePath, appName);
          
          for (const view of views) {
            this.views.set(`${appName}.${view.name}`, view);
          }
        }
      }
      
      // Also check for viewsets in serializers.py (DRF pattern)
      if (this.hasRestFramework && app.serializers.length > 0) {
        for (const serializerFile of app.serializers) {
          const filePath = path.join(app.path, 'viewsets.py');
          if (await fs.pathExists(filePath)) {
            const content = await fs.readFile(filePath, 'utf-8');
            const viewsets = this.parseDjangoViewsets(content, filePath, appName);
            
            for (const viewset of viewsets) {
              this.views.set(`${appName}.${viewset.name}`, viewset);
            }
          }
        }
      }
    }
  }

  private parseDjangoViews(content: string, filePath: string, appName: string): DjangoView[] {
    const views: DjangoView[] = [];
    
    // Parse function-based views
    const funcViewRegex = /def\s+(\w+)\s*\(request[^)]*\)/g;
    let match;
    
    while ((match = funcViewRegex.exec(content)) !== null) {
      const viewName = match[1];
      
      views.push({
        name: viewName,
        type: 'function',
        filePath,
        app: appName,
        methods: this.parseViewMethods(content, viewName),
        permissions: this.parseViewPermissions(content, viewName),
        authentication: this.parseViewAuthentication(content, viewName),
        serializers: [],
        querysets: [],
        decorators: this.parseViewDecorators(content, viewName)
      });
    }
    
    // Parse class-based views
    const classViewRegex = /class\s+(\w+)\s*\(([^)]+View[^)]*)\)/g;
    
    while ((match = classViewRegex.exec(content)) !== null) {
      const viewName = match[1];
      const baseClass = match[2];
      
      views.push({
        name: viewName,
        type: 'class',
        filePath,
        app: appName,
        methods: this.parseClassViewMethods(content, viewName),
        permissions: this.parseViewPermissions(content, viewName),
        authentication: this.parseViewAuthentication(content, viewName),
        serializers: this.parseViewSerializers(content, viewName),
        querysets: this.parseViewQuerysets(content, viewName),
        decorators: []
      });
    }
    
    return views;
  }

  private parseDjangoViewsets(content: string, filePath: string, appName: string): DjangoView[] {
    const viewsets: DjangoView[] = [];
    const viewsetRegex = /class\s+(\w+)\s*\(([^)]*ViewSet[^)]*)\)/g;
    let match;
    
    while ((match = viewsetRegex.exec(content)) !== null) {
      const viewsetName = match[1];
      
      viewsets.push({
        name: viewsetName,
        type: 'viewset',
        filePath,
        app: appName,
        methods: ['list', 'create', 'retrieve', 'update', 'destroy'],
        permissions: this.parseViewPermissions(content, viewsetName),
        authentication: this.parseViewAuthentication(content, viewsetName),
        serializers: this.parseViewSerializers(content, viewsetName),
        querysets: this.parseViewQuerysets(content, viewsetName),
        decorators: []
      });
    }
    
    return viewsets;
  }

  private parseViewMethods(content: string, viewName: string): string[] {
    const methods: string[] = [];
    
    // Check for HTTP method decorators
    const decoratorRegex = /@(?:api_view|require_http_methods)\s*\(\s*\[([^\]]+)\]/;
    const match = content.match(decoratorRegex);
    
    if (match) {
      const methodList = match[1];
      const methodRegex = /['"](\w+)['"]/g;
      let methodMatch;
      
      while ((methodMatch = methodRegex.exec(methodList)) !== null) {
        methods.push(methodMatch[1]);
      }
    } else {
      // Default to GET for function views
      methods.push('GET');
    }
    
    return methods;
  }

  private parseClassViewMethods(content: string, className: string): string[] {
    const methods: string[] = [];
    const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    
    for (const method of httpMethods) {
      const methodRegex = new RegExp(`def\\s+${method}\\s*\\(self`);
      if (methodRegex.test(content)) {
        methods.push(method.toUpperCase());
      }
    }
    
    return methods.length > 0 ? methods : ['GET'];
  }

  private parseViewPermissions(content: string, viewName: string): string[] {
    const permissions: string[] = [];
    const permissionRegex = /permission_classes\s*=\s*\[([^\]]+)\]/;
    const match = content.match(permissionRegex);
    
    if (match) {
      const permList = match[1];
      const permRegex = /(\w+)/g;
      let permMatch;
      
      while ((permMatch = permRegex.exec(permList)) !== null) {
        permissions.push(permMatch[1]);
      }
    }
    
    return permissions;
  }

  private parseViewAuthentication(content: string, viewName: string): string[] {
    const auth: string[] = [];
    const authRegex = /authentication_classes\s*=\s*\[([^\]]+)\]/;
    const match = content.match(authRegex);
    
    if (match) {
      const authList = match[1];
      const authItemRegex = /(\w+)/g;
      let authMatch;
      
      while ((authMatch = authItemRegex.exec(authList)) !== null) {
        auth.push(authMatch[1]);
      }
    }
    
    return auth;
  }

  private parseViewSerializers(content: string, viewName: string): string[] {
    const serializers: string[] = [];
    const serializerRegex = /serializer_class\s*=\s*(\w+)/;
    const match = content.match(serializerRegex);
    
    if (match) {
      serializers.push(match[1]);
    }
    
    return serializers;
  }

  private parseViewQuerysets(content: string, viewName: string): string[] {
    const querysets: string[] = [];
    const querysetRegex = /queryset\s*=\s*(\w+)\.objects/;
    const match = content.match(querysetRegex);
    
    if (match) {
      querysets.push(match[1]);
    }
    
    return querysets;
  }

  private parseViewDecorators(content: string, viewName: string): string[] {
    const decorators: string[] = [];
    
    // Find the function definition
    const funcRegex = new RegExp(`(@\\w+[^\\n]*\\n)*def\\s+${viewName}`);
    const match = content.match(funcRegex);
    
    if (match && match[1]) {
      const decoratorRegex = /@(\w+)/g;
      let decMatch;
      
      while ((decMatch = decoratorRegex.exec(match[0])) !== null) {
        decorators.push(decMatch[1]);
      }
    }
    
    return decorators;
  }

  private async discoverURLs(): Promise<void> {
    // Discover main URLs
    const mainUrlsPath = path.join(this.projectPath, 'urls.py');
    if (await fs.pathExists(mainUrlsPath)) {
      const content = await fs.readFile(mainUrlsPath, 'utf-8');
      const urls = this.parseURLPatterns(content, '', 'main');
      this.urls.push(...urls);
    }
    
    // Discover app URLs
    for (const [appName, app] of this.apps) {
      for (const urlFile of app.urls) {
        const filePath = path.join(app.path, urlFile);
        if (await fs.pathExists(filePath)) {
          const content = await fs.readFile(filePath, 'utf-8');
          const urls = this.parseURLPatterns(content, appName, appName);
          this.urls.push(...urls);
        }
      }
    }
  }

  private parseURLPatterns(content: string, namespace: string, app: string): DjangoURL[] {
    const urls: DjangoURL[] = [];
    
    // Parse path() patterns
    const pathRegex = /path\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^,)]+)/g;
    let match;
    
    while ((match = pathRegex.exec(content)) !== null) {
      const pattern = match[1];
      const view = match[2].trim();
      
      urls.push({
        pattern,
        view,
        namespace,
        app
      });
    }
    
    // Parse re_path() patterns
    const rePathRegex = /re_path\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([^,)]+)/g;
    
    while ((match = rePathRegex.exec(content)) !== null) {
      const pattern = match[1];
      const view = match[2].trim();
      
      urls.push({
        pattern,
        view,
        namespace,
        app
      });
    }
    
    // Parse include() patterns
    const includeRegex = /path\s*\(\s*['"]([^'"]+)['"]\s*,\s*include\s*\(\s*['"]([^'"]+)['"]/g;
    
    while ((match = includeRegex.exec(content)) !== null) {
      const pattern = match[1];
      const includes = match[2];
      
      urls.push({
        pattern,
        view: '',
        includes,
        namespace,
        app
      });
    }
    
    return urls;
  }

  private extractModelDependencies(model: DjangoModel): string[] {
    const deps: string[] = [];
    
    for (const rel of model.relationships) {
      deps.push(rel.toModel);
    }
    
    return deps;
  }

  private calculateModelComplexity(model: DjangoModel): number {
    let complexity = 1;
    
    complexity += model.fields.length;
    complexity += model.relationships.length * 2;
    complexity += model.methods.length;
    complexity += model.properties.length;
    
    if (model.meta.indexes.length > 0) complexity += 2;
    if (model.meta.constraints.length > 0) complexity += 3;
    
    return complexity;
  }

  private calculateModelMaintainability(model: DjangoModel): number {
    let score = 100;
    
    const complexity = this.calculateModelComplexity(model);
    score -= Math.min(complexity * 2, 40);
    
    if (model.fields.length > 20) score -= 10;
    if (model.relationships.length > 10) score -= 10;
    
    // Bonus for best practices
    if (model.meta.indexes.length > 0) score += 5;
    if (model.isAbstract) score += 3;
    
    return Math.max(score, 0);
  }

  private calculateModelTechnicalDebt(model: DjangoModel): number {
    let debt = 0;
    
    // Debt for missing indexes on foreign keys
    const fkWithoutIndex = model.relationships.filter(r => 
      r.type === 'ForeignKey' && !model.meta.indexes.includes(r.field)
    ).length;
    debt += fkWithoutIndex * 3;
    
    // Debt for too many fields
    if (model.fields.length > 30) debt += 5;
    
    // Debt for missing Meta options
    if (!model.meta.ordering || model.meta.ordering.length === 0) debt += 2;
    
    return debt;
  }

  private async countLinesOfCode(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.split('\n').length;
    } catch {
      return 0;
    }
  }

  private async buildDjangoConnections(): Promise<Connection[]> {
    const connections: Connection[] = [];
    
    // Model relationships
    for (const [modelId, model] of this.models) {
      for (const rel of model.relationships) {
        connections.push({
          from: modelId,
          to: `${model.app}.${rel.toModel}`,
          type: 'data_flow',
          weight: 1,
          metadata: {
            callSites: 1,
            dataFlow: rel.field
          }
        });
      }
    }
    
    // View to Model connections
    for (const [viewId, view] of this.views) {
      for (const queryset of view.querysets) {
        connections.push({
          from: viewId,
          to: `${view.app}.${queryset}`,
          type: 'database',
          weight: 1,
          metadata: {
            callSites: 1
          }
        });
      }
    }
    
    // URL to View connections
    for (const url of this.urls) {
      if (url.view) {
        connections.push({
          from: url.pattern,
          to: url.view,
          type: 'http_call',
          weight: 1,
          metadata: {
            callSites: 1,
            httpMethod: 'GET'
          }
        });
      }
    }
    
    return connections;
  }

  private extractDjangoAPIEndpoints(): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];
    
    for (const url of this.urls) {
      if (url.view) {
        const view = this.views.get(url.view);
        
        if (view) {
          for (const method of view.methods) {
            const endpointId = `${url.view}_${method}`;
            endpoints.push({
              id: endpointId,
              path: url.pattern,
              method: method as APIEndpoint['method'],
              description: `${method} ${url.pattern}`,
              handler: view.name,
              parameters: [],
              statusCodes: [{ code: 200, description: 'Success' }],
              middleware: [],
              authentication: view.authentication.length > 0 ? { type: 'jwt', required: true } : { type: 'none', required: false },
              rateLimit: undefined,
              deprecated: false,
              componentId: url.view || 'unknown'
            });
          }
        }
      }
    }
    
    return endpoints;
  }

  private async extractDatabaseConnections(): Promise<void> {
    if (this.settings.DATABASES?.default) {
      const dbConfig = this.settings.DATABASES.default;
      
      this.databases.push({
        id: 'default',
        name: dbConfig.NAME || 'default',
        type: this.mapDatabaseEngine(dbConfig.ENGINE),
        host: dbConfig.HOST || 'localhost',
        port: dbConfig.PORT || this.getDefaultPort(dbConfig.ENGINE),
        database: dbConfig.NAME,
        usage: [{ componentId: 'django-models', operations: [{ type: 'read', tables: [], complexity: 1, optimized: true }], frequency: 1, critical: true }],
        componentIds: ['django-models']
      });
    }
  }

  private mapDatabaseEngine(engine: string): DatabaseConnection['type'] {
    if (engine.includes('postgresql')) return 'postgresql';
    if (engine.includes('mysql')) return 'mysql';
    if (engine.includes('sqlite')) return 'sqlite';
    if (engine.includes('mongodb')) return 'mongodb';
    return 'postgresql'; // Default to postgresql for unknown engines
  }

  private getDefaultPort(engine: string): number {
    if (engine.includes('postgresql')) return 5432;
    if (engine.includes('mysql')) return 3306;
    if (engine.includes('oracle')) return 1521;
    return 0;
  }

  private countRelationships(): number {
    let count = 0;
    for (const model of this.models.values()) {
      count += model.relationships.length;
    }
    return count;
  }

  private countIndexes(): number {
    let count = 0;
    for (const model of this.models.values()) {
      count += model.meta.indexes.length;
      count += model.fields.filter(f => f.indexed || f.unique).length;
    }
    return count;
  }

  private findDjangoEntryPoints(): string[] {
    const entryPoints: string[] = [
      'manage.py',
      'wsgi.py',
      'asgi.py',
      'urls.py'
    ];
    
    // Add app entry points
    for (const app of this.apps.keys()) {
      entryPoints.push(`${app}.urls`);
    }
    
    return entryPoints;
  }

  private buildDjangoLayers(): Record<string, string[]> {
    return {
      'models': Array.from(this.models.keys()),
      'views': Array.from(this.views.keys()),
      'serializers': Array.from(this.apps.values()).flatMap(app => app.serializers),
      'forms': Array.from(this.apps.values()).flatMap(app => app.forms),
      'admin': Array.from(this.apps.values()).flatMap(app => app.admin),
      'urls': this.urls.map(u => u.pattern),
      'middleware': this.settings.MIDDLEWARE || [],
      'apps': Array.from(this.apps.keys())
    };
  }

  async analyzePerformance(): Promise<any> {
    // Base performance metrics
    
    return {
      django: {
        appsCount: this.apps.size,
        modelsCount: this.models.size,
        viewsCount: this.views.size,
        urlPatternsCount: this.urls.length,
        fieldsPerModel: this.calculateAverageFields(),
        relationshipsPerModel: this.calculateAverageRelationships(),
        features: {
          hasRestFramework: this.hasRestFramework,
          hasCelery: this.hasCelery,
          hasChannels: this.hasChannels
        },
        databases: this.databases
      }
    };
  }

  private calculateAverageFields(): number {
    const models = Array.from(this.models.values());
    if (models.length === 0) return 0;
    
    const totalFields = models.reduce((sum, m) => sum + m.fields.length, 0);
    return totalFields / models.length;
  }

  private calculateAverageRelationships(): number {
    const models = Array.from(this.models.values());
    if (models.length === 0) return 0;
    
    const totalRels = models.reduce((sum, m) => sum + m.relationships.length, 0);
    return totalRels / models.length;
  }
}