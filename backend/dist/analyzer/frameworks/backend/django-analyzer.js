"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DjangoAnalyzer = void 0;
const python_analyzer_1 = require("../../languages/python-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class DjangoAnalyzer extends python_analyzer_1.PythonAnalyzer {
    constructor() {
        super(...arguments);
        this.djangoVersion = '';
        this.apps = new Map();
        this.models = new Map();
        this.views = new Map();
        this.urls = [];
        this.settings = {};
        this.hasRestFramework = false;
        this.hasCelery = false;
        this.hasChannels = false;
        this.databases = [];
    }
    getAnalyzerName() {
        return 'Django Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['django', 'django-rest-framework', 'django-channels'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        const managePyPath = path.join(this.projectPath, 'manage.py');
        const settingsPath = await this.findSettingsFile();
        if (await fs.pathExists(managePyPath)) {
            await this.detectDjangoVersion();
            if (settingsPath) {
                await this.loadSettings(settingsPath);
            }
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
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('django-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverDjangoApps();
        await this.discoverModels();
        await this.discoverViews();
        await this.discoverURLs();
        const components = new Map();
        for (const [id, model] of this.models) {
            const node = {
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
                    djangoType: 'model',
                    app: model.app,
                    meta: model.meta,
                    isAbstract: model.isAbstract
                }
            };
            components.set(id, node);
        }
        for (const [id, view] of this.views) {
            const node = {
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
                    djangoType: view.type,
                    app: view.app,
                    permissions: view.permissions,
                    authentication: view.authentication
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildDjangoConnections();
        const apiEndpoints = this.extractDjangoAPIEndpoints();
        await this.extractDatabaseConnections();
        telemetry_schema_1.telemetry.emit({
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
    async detectDjangoVersionInternal() {
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
    async findSettingsFile() {
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
        const files = await this.findFiles(['**/settings.py'], this.options.excludePatterns);
        return files.length > 0 ? files[0] : null;
    }
    async loadSettings(settingsPath) {
        const content = await fs.readFile(settingsPath, 'utf-8');
        const installedAppsMatch = content.match(/INSTALLED_APPS\s*=\s*\[([^\]]+)\]/s);
        if (installedAppsMatch) {
            const apps = installedAppsMatch[1];
            this.settings.INSTALLED_APPS = this.parseStringList(apps);
        }
        const databasesMatch = content.match(/DATABASES\s*=\s*{([^}]+)}/s);
        if (databasesMatch) {
            this.settings.DATABASES = this.parseDatabaseConfig(databasesMatch[1]);
        }
        const middlewareMatch = content.match(/MIDDLEWARE\s*=\s*\[([^\]]+)\]/s);
        if (middlewareMatch) {
            this.settings.MIDDLEWARE = this.parseStringList(middlewareMatch[1]);
        }
        const restFrameworkMatch = content.match(/REST_FRAMEWORK\s*=\s*{([^}]+)}/s);
        if (restFrameworkMatch) {
            this.settings.REST_FRAMEWORK = {};
            this.hasRestFramework = true;
        }
        if (content.includes('CELERY_')) {
            this.hasCelery = true;
        }
    }
    parseStringList(content) {
        const items = [];
        const regex = /['"]([^'"]+)['"]/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            items.push(match[1]);
        }
        return items;
    }
    parseDatabaseConfig(content) {
        const config = {};
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
    async detectPackage(packageName) {
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
    async discoverDjangoApps() {
        const installedApps = this.settings.INSTALLED_APPS || [];
        const localApps = installedApps.filter((app) => !app.startsWith('django.'));
        for (const appName of localApps) {
            const appPath = appName.replace(/\./g, '/');
            const fullPath = path.join(this.projectPath, appPath);
            if (await fs.pathExists(fullPath)) {
                const app = {
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
    async discoverModels() {
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
    parseDjangoModels(content, filePath, appName) {
        const models = [];
        const modelRegex = /class\s+(\w+)\s*\(([^)]+)\)\s*:/g;
        let match;
        while ((match = modelRegex.exec(content)) !== null) {
            const className = match[1];
            const baseClass = match[2];
            if (baseClass.includes('Model')) {
                const model = {
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
    parseModelFields(content, className) {
        const fields = [];
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
    parseFieldValidators(params) {
        const validators = [];
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
    parseModelMeta(content, className) {
        const meta = {
            ordering: [],
            indexes: [],
            constraints: [],
            abstract: false,
            managed: true
        };
        const metaRegex = new RegExp(`class\\s+${className}[^}]+class\\s+Meta\\s*:([^\\n]*(?:\\n(?!\\s*class)[^\\n]*)*)`, 's');
        const metaMatch = content.match(metaRegex);
        if (metaMatch) {
            const metaContent = metaMatch[1];
            const tableMatch = metaContent.match(/db_table\s*=\s*['"]([^'"]+)['"]/);
            if (tableMatch) {
                meta.dbTable = tableMatch[1];
            }
            const orderingMatch = metaContent.match(/ordering\s*=\s*\[([^\]]+)\]/);
            if (orderingMatch) {
                meta.ordering = this.parseStringList(orderingMatch[1]);
            }
            meta.abstract = metaContent.includes('abstract = True');
            meta.managed = !metaContent.includes('managed = False');
        }
        return meta;
    }
    parseModelManagers(content, className) {
        const managers = [];
        const managerRegex = /(\w+)\s*=\s*(?:models\.)?Manager\s*\(/g;
        let match;
        while ((match = managerRegex.exec(content)) !== null) {
            managers.push(match[1]);
        }
        return managers;
    }
    parseModelMethods(content, className) {
        const methods = [];
        const methodRegex = /def\s+(\w+)\s*\(self[^)]*\)/g;
        let match;
        while ((match = methodRegex.exec(content)) !== null) {
            if (!match[1].startsWith('_')) {
                methods.push(match[1]);
            }
        }
        return methods;
    }
    parseModelProperties(content, className) {
        const properties = [];
        const propertyRegex = /@property\s+def\s+(\w+)/g;
        let match;
        while ((match = propertyRegex.exec(content)) !== null) {
            properties.push(match[1]);
        }
        return properties;
    }
    parseModelRelationships(content, className) {
        const relationships = [];
        const relationRegex = /(\w+)\s*=\s*models\.(ForeignKey|OneToOneField|ManyToManyField)\s*\(([^)]+)\)/g;
        let match;
        while ((match = relationRegex.exec(content)) !== null) {
            const field = match[1];
            const type = match[2];
            const params = match[3];
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
    isAbstractModel(content, className) {
        const metaRegex = new RegExp(`class\\s+${className}[^}]+class\\s+Meta[^}]+abstract\\s*=\\s*True`);
        return metaRegex.test(content);
    }
    async discoverViews() {
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
    parseDjangoViews(content, filePath, appName) {
        const views = [];
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
    parseDjangoViewsets(content, filePath, appName) {
        const viewsets = [];
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
    parseViewMethods(content, viewName) {
        const methods = [];
        const decoratorRegex = /@(?:api_view|require_http_methods)\s*\(\s*\[([^\]]+)\]/;
        const match = content.match(decoratorRegex);
        if (match) {
            const methodList = match[1];
            const methodRegex = /['"](\w+)['"]/g;
            let methodMatch;
            while ((methodMatch = methodRegex.exec(methodList)) !== null) {
                methods.push(methodMatch[1]);
            }
        }
        else {
            methods.push('GET');
        }
        return methods;
    }
    parseClassViewMethods(content, className) {
        const methods = [];
        const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
        for (const method of httpMethods) {
            const methodRegex = new RegExp(`def\\s+${method}\\s*\\(self`);
            if (methodRegex.test(content)) {
                methods.push(method.toUpperCase());
            }
        }
        return methods.length > 0 ? methods : ['GET'];
    }
    parseViewPermissions(content, viewName) {
        const permissions = [];
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
    parseViewAuthentication(content, viewName) {
        const auth = [];
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
    parseViewSerializers(content, viewName) {
        const serializers = [];
        const serializerRegex = /serializer_class\s*=\s*(\w+)/;
        const match = content.match(serializerRegex);
        if (match) {
            serializers.push(match[1]);
        }
        return serializers;
    }
    parseViewQuerysets(content, viewName) {
        const querysets = [];
        const querysetRegex = /queryset\s*=\s*(\w+)\.objects/;
        const match = content.match(querysetRegex);
        if (match) {
            querysets.push(match[1]);
        }
        return querysets;
    }
    parseViewDecorators(content, viewName) {
        const decorators = [];
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
    async discoverURLs() {
        const mainUrlsPath = path.join(this.projectPath, 'urls.py');
        if (await fs.pathExists(mainUrlsPath)) {
            const content = await fs.readFile(mainUrlsPath, 'utf-8');
            const urls = this.parseURLPatterns(content, '', 'main');
            this.urls.push(...urls);
        }
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
    parseURLPatterns(content, namespace, app) {
        const urls = [];
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
    extractModelDependencies(model) {
        const deps = [];
        for (const rel of model.relationships) {
            deps.push(rel.toModel);
        }
        return deps;
    }
    calculateModelComplexity(model) {
        let complexity = 1;
        complexity += model.fields.length;
        complexity += model.relationships.length * 2;
        complexity += model.methods.length;
        complexity += model.properties.length;
        if (model.meta.indexes.length > 0)
            complexity += 2;
        if (model.meta.constraints.length > 0)
            complexity += 3;
        return complexity;
    }
    calculateModelMaintainability(model) {
        let score = 100;
        const complexity = this.calculateModelComplexity(model);
        score -= Math.min(complexity * 2, 40);
        if (model.fields.length > 20)
            score -= 10;
        if (model.relationships.length > 10)
            score -= 10;
        if (model.meta.indexes.length > 0)
            score += 5;
        if (model.isAbstract)
            score += 3;
        return Math.max(score, 0);
    }
    calculateModelTechnicalDebt(model) {
        let debt = 0;
        const fkWithoutIndex = model.relationships.filter(r => r.type === 'ForeignKey' && !model.meta.indexes.includes(r.field)).length;
        debt += fkWithoutIndex * 3;
        if (model.fields.length > 30)
            debt += 5;
        if (!model.meta.ordering || model.meta.ordering.length === 0)
            debt += 2;
        return debt;
    }
    async countLinesOfCode(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return content.split('\n').length;
        }
        catch {
            return 0;
        }
    }
    async buildDjangoConnections() {
        const connections = [];
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
    extractDjangoAPIEndpoints() {
        const endpoints = [];
        for (const url of this.urls) {
            if (url.view) {
                const view = this.views.get(url.view);
                if (view) {
                    for (const method of view.methods) {
                        const endpointId = `${url.view}_${method}`;
                        endpoints.push({
                            id: endpointId,
                            path: url.pattern,
                            method: method,
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
    async extractDatabaseConnections() {
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
    mapDatabaseEngine(engine) {
        if (engine.includes('postgresql'))
            return 'postgresql';
        if (engine.includes('mysql'))
            return 'mysql';
        if (engine.includes('sqlite'))
            return 'sqlite';
        if (engine.includes('mongodb'))
            return 'mongodb';
        return 'postgresql';
    }
    getDefaultPort(engine) {
        if (engine.includes('postgresql'))
            return 5432;
        if (engine.includes('mysql'))
            return 3306;
        if (engine.includes('oracle'))
            return 1521;
        return 0;
    }
    countRelationships() {
        let count = 0;
        for (const model of this.models.values()) {
            count += model.relationships.length;
        }
        return count;
    }
    countIndexes() {
        let count = 0;
        for (const model of this.models.values()) {
            count += model.meta.indexes.length;
            count += model.fields.filter(f => f.indexed || f.unique).length;
        }
        return count;
    }
    findDjangoEntryPoints() {
        const entryPoints = [
            'manage.py',
            'wsgi.py',
            'asgi.py',
            'urls.py'
        ];
        for (const app of this.apps.keys()) {
            entryPoints.push(`${app}.urls`);
        }
        return entryPoints;
    }
    buildDjangoLayers() {
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
    async analyzePerformance() {
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
    calculateAverageFields() {
        const models = Array.from(this.models.values());
        if (models.length === 0)
            return 0;
        const totalFields = models.reduce((sum, m) => sum + m.fields.length, 0);
        return totalFields / models.length;
    }
    calculateAverageRelationships() {
        const models = Array.from(this.models.values());
        if (models.length === 0)
            return 0;
        const totalRels = models.reduce((sum, m) => sum + m.relationships.length, 0);
        return totalRels / models.length;
    }
}
exports.DjangoAnalyzer = DjangoAnalyzer;
