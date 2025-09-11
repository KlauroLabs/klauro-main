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
exports.FlaskAnalyzer = void 0;
const python_analyzer_1 = require("../../languages/python-analyzer");
const telemetry_schema_1 = require("../../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class FlaskAnalyzer extends python_analyzer_1.PythonAnalyzer {
    constructor() {
        super(...arguments);
        this.flaskVersion = '';
        this.routes = new Map();
        this.blueprints = new Map();
        this.extensions = new Map();
        this.templates = new Map();
        this.forms = new Map();
        this.appInstances = [];
        this.configuration = {};
        this.hasSQLAlchemy = false;
        this.hasLogin = false;
        this.hasAdmin = false;
        this.hasMail = false;
        this.hasWTForms = false;
        this.hasCelery = false;
        this.hasSocketIO = false;
    }
    getAnalyzerName() {
        return 'Flask Framework Analyzer';
    }
    getSupportedFrameworks() {
        return ['flask', 'flask-sqlalchemy', 'flask-login', 'flask-wtf', 'flask-admin'];
    }
    async detectLanguageAndFramework() {
        const baseDetection = await super.detectLanguageAndFramework();
        await this.detectFlaskVersion();
        this.hasSQLAlchemy = await this.detectPackage('flask-sqlalchemy');
        this.hasLogin = await this.detectPackage('flask-login');
        this.hasAdmin = await this.detectPackage('flask-admin');
        this.hasMail = await this.detectPackage('flask-mail');
        this.hasWTForms = await this.detectPackage('flask-wtf');
        this.hasCelery = await this.detectPackage('celery');
        this.hasSocketIO = await this.detectPackage('flask-socketio');
        await this.findAppInstances();
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
    async discoverComponents() {
        const span = telemetry_schema_1.telemetry.createSpan('flask-analyzer.discoverComponents');
        const baseDiscovery = await super.discoverComponents();
        await this.discoverRoutes();
        await this.discoverBlueprints();
        await this.discoverExtensions();
        await this.discoverTemplates();
        await this.discoverForms();
        const components = new Map();
        for (const [id, route] of this.routes) {
            const node = {
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
                }
            };
            components.set(id, node);
        }
        for (const [id, blueprint] of this.blueprints) {
            const node = {
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
                }
            };
            components.set(id, node);
        }
        for (const [id, form] of this.forms) {
            const node = {
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
                }
            };
            components.set(id, node);
        }
        const connections = await this.buildFlaskConnections();
        const apiEndpoints = this.extractFlaskEndpoints();
        const databaseConnections = await this.extractDatabaseConnections();
        telemetry_schema_1.telemetry.emit({
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
    async detectFlaskVersion() {
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
    async findAppInstances() {
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
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles.slice(0, 30)) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('Flask(__name__)') && !this.appInstances.includes(file)) {
                this.appInstances.push(file);
            }
        }
    }
    async loadConfiguration() {
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
    parseConfiguration(content) {
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
    async discoverRoutes() {
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
    parseFlaskRoutes(content, filePath) {
        const routes = [];
        const routeRegex = /@(?:app|bp|blueprint)\.route\s*\(\s*["']([^"']+)["']/g;
        const lines = content.split('\n');
        let match;
        while ((match = routeRegex.exec(content)) !== null) {
            const path = match[1];
            const decoratorIndex = content.substring(0, match.index).split('\n').length;
            let handler = '';
            let methods = ['GET'];
            let decorators = [];
            const decoratorEndIndex = content.indexOf(')', match.index) + 1;
            const decoratorContent = content.substring(match.index, decoratorEndIndex);
            const methodsMatch = decoratorContent.match(/methods\s*=\s*\[([^\]]+)\]/);
            if (methodsMatch) {
                methods = this.parseStringList(methodsMatch[1]).map(m => m.toUpperCase());
            }
            for (let i = decoratorIndex; i < Math.min(decoratorIndex + 10, lines.length); i++) {
                const line = lines[i];
                const funcMatch = line.match(/^def\s+(\w+)/);
                if (funcMatch) {
                    handler = funcMatch[1];
                    for (let j = decoratorIndex - 1; j >= Math.max(0, decoratorIndex - 10); j--) {
                        const decoratorLine = lines[j].trim();
                        if (decoratorLine.startsWith('@')) {
                            decorators.push(decoratorLine.substring(1).split('(')[0]);
                        }
                        else if (!decoratorLine.startsWith('#') && decoratorLine.length > 0) {
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
    async discoverBlueprints() {
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('Blueprint(')) {
                const blueprints = this.parseBlueprints(content, file);
                for (const blueprint of blueprints) {
                    this.blueprints.set(blueprint.name, blueprint);
                    const bpRoutes = this.parseBlueprintRoutes(content, file, blueprint.name);
                    blueprint.routes.push(...bpRoutes);
                }
            }
        }
    }
    parseBlueprints(content, filePath) {
        const blueprints = [];
        const bpRegex = /(\w+)\s*=\s*Blueprint\s*\(\s*["']([^"']+)["']\s*,\s*__name__([^)]*)\)/g;
        let match;
        while ((match = bpRegex.exec(content)) !== null) {
            const varName = match[1];
            const bpName = match[2];
            const params = match[3];
            const blueprint = {
                name: bpName,
                filePath,
                routes: [],
                errorHandlers: new Map()
            };
            const prefixMatch = params.match(/url_prefix\s*=\s*["']([^"']+)["']/);
            if (prefixMatch) {
                blueprint.urlPrefix = prefixMatch[1];
            }
            const staticMatch = params.match(/static_folder\s*=\s*["']([^"']+)["']/);
            if (staticMatch) {
                blueprint.staticFolder = staticMatch[1];
            }
            const templateMatch = params.match(/template_folder\s*=\s*["']([^"']+)["']/);
            if (templateMatch) {
                blueprint.templateFolder = templateMatch[1];
            }
            blueprints.push(blueprint);
        }
        return blueprints;
    }
    parseBlueprintRoutes(content, filePath, blueprintName) {
        const routes = [];
        const bpVar = this.findBlueprintVariable(content, blueprintName);
        if (!bpVar)
            return routes;
        const routeRegex = new RegExp(`@${bpVar}\\.route\\s*\\(\\s*["']([^"']+)["']`, 'g');
        let match;
        while ((match = routeRegex.exec(content)) !== null) {
            const path = match[1];
            const route = {
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
    findBlueprintVariable(content, blueprintName) {
        const regex = new RegExp(`(\\w+)\\s*=\\s*Blueprint\\s*\\(\\s*["']${blueprintName}["']`);
        const match = content.match(regex);
        return match ? match[1] : null;
    }
    async discoverExtensions() {
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles.slice(0, 30)) {
            const content = await fs.readFile(file, 'utf-8');
            const extensions = this.parseExtensions(content);
            for (const ext of extensions) {
                this.extensions.set(ext.name, ext);
            }
        }
    }
    parseExtensions(content) {
        const extensions = [];
        const extensionPatterns = [
            { name: 'SQLAlchemy', pattern: /(\w+)\s*=\s*SQLAlchemy\s*\(/, type: 'database' },
            { name: 'LoginManager', pattern: /(\w+)\s*=\s*LoginManager\s*\(/, type: 'auth' },
            { name: 'Admin', pattern: /(\w+)\s*=\s*Admin\s*\(/, type: 'admin' },
            { name: 'Mail', pattern: /(\w+)\s*=\s*Mail\s*\(/, type: 'mail' },
            { name: 'Cache', pattern: /(\w+)\s*=\s*Cache\s*\(/, type: 'cache' },
            { name: 'Session', pattern: /(\w+)\s*=\s*Session\s*\(/, type: 'session' }
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
    async discoverTemplates() {
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
    parseTemplate(content, filePath) {
        const template = {
            name: path.basename(filePath),
            path: filePath,
            blocks: [],
            includes: [],
            macros: [],
            filters: []
        };
        const extendsMatch = content.match(/\{%\s*extends\s+["']([^"']+)["']\s*%\}/);
        if (extendsMatch) {
            template.extends = extendsMatch[1];
        }
        const blockRegex = /\{%\s*block\s+(\w+)\s*%\}/g;
        let match;
        while ((match = blockRegex.exec(content)) !== null) {
            template.blocks.push(match[1]);
        }
        const includeRegex = /\{%\s*include\s+["']([^"']+)["']\s*%\}/g;
        while ((match = includeRegex.exec(content)) !== null) {
            template.includes.push(match[1]);
        }
        const macroRegex = /\{%\s*macro\s+(\w+)\s*\(/g;
        while ((match = macroRegex.exec(content)) !== null) {
            template.macros.push(match[1]);
        }
        return template;
    }
    async discoverForms() {
        if (!this.hasWTForms)
            return;
        const pythonFiles = await this.findFiles(['**/*.py'], this.options.excludePatterns);
        for (const file of pythonFiles) {
            const content = await fs.readFile(file, 'utf-8');
            if (content.includes('from flask_wtf') || content.includes('from wtforms')) {
                const forms = this.parseForms(content, file);
                for (const form of forms) {
                    this.forms.set(form.name, form);
                }
            }
        }
    }
    parseForms(content, filePath) {
        const forms = [];
        const formRegex = /class\s+(\w+)\s*\(([^)]*Form[^)]*)\)\s*:/g;
        let match;
        while ((match = formRegex.exec(content)) !== null) {
            const name = match[1];
            const baseClass = match[2].trim();
            const form = {
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
    parseFormFields(content, className) {
        const fields = [];
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
                const field = {
                    name,
                    type,
                    validators: this.parseFieldValidators(params),
                    required: !params.includes('optional=True')
                };
                const labelMatch = params.match(/["']([^"']+)["']/);
                if (labelMatch) {
                    field.label = labelMatch[1];
                }
                fields.push(field);
            }
        }
        return fields;
    }
    parseFieldValidators(params) {
        const validators = [];
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
    parseStringList(content) {
        const items = [];
        const regex = /["']([^"']+)["']/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            items.push(match[1]);
        }
        return items;
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
    async buildFlaskConnections() {
        const connections = [];
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
        for (const [formId, form] of this.forms) {
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
    extractFlaskEndpoints() {
        const endpoints = [];
        for (const [id, route] of this.routes) {
            for (const method of route.methods) {
                endpoints.push({
                    id: `${id}-${method.toLowerCase()}`,
                    path: route.blueprint ? `${this.blueprints.get(route.blueprint)?.urlPrefix || ''}${route.path}` : route.path,
                    method: method,
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
    async extractDatabaseConnections() {
        const connections = [];
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
    extractDatabaseType(uri) {
        if (uri.includes('postgresql'))
            return 'postgresql';
        if (uri.includes('mysql'))
            return 'mysql';
        if (uri.includes('sqlite'))
            return 'sqlite';
        if (uri.includes('mongodb'))
            return 'mongodb';
        if (uri.includes('redis'))
            return 'redis';
        return 'postgresql';
    }
    extractHost(uri) {
        const match = uri.match(/@([^:/]+)/);
        return match ? match[1] : 'localhost';
    }
    extractPort(uri, dbType) {
        const match = uri.match(/:(\d+)\//);
        if (match)
            return parseInt(match[1]);
        switch (dbType) {
            case 'postgresql': return 5432;
            case 'mysql': return 3306;
            default: return 0;
        }
    }
    extractDatabase(uri) {
        const match = uri.match(/\/([^?]+)(\?|$)/);
        return match ? match[1] : 'app';
    }
    findFlaskEntryPoints() {
        const entryPoints = [];
        entryPoints.push(...this.appInstances);
        if (this.appInstances.includes('wsgi.py')) {
            entryPoints.push('wsgi:app');
        }
        entryPoints.push('app:create_app', 'application:app');
        return entryPoints;
    }
    buildFlaskLayers() {
        return {
            'routes': Array.from(this.routes.keys()),
            'blueprints': Array.from(this.blueprints.keys()),
            'extensions': Array.from(this.extensions.keys()),
            'templates': Array.from(this.templates.keys()),
            'forms': Array.from(this.forms.keys()),
            'models': this.hasSQLAlchemy ? ['SQLAlchemy Models'] : []
        };
    }
    async analyzePerformance() {
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
    calculateAverageRoutesPerBlueprint() {
        const blueprints = Array.from(this.blueprints.values());
        if (blueprints.length === 0)
            return 0;
        const totalRoutes = blueprints.reduce((sum, bp) => sum + bp.routes.length, 0);
        return totalRoutes / blueprints.length;
    }
}
exports.FlaskAnalyzer = FlaskAnalyzer;
