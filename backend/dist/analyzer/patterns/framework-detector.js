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
exports.FrameworkDetector = void 0;
const telemetry_schema_1 = require("../../telemetry/telemetry-schema");
const path = __importStar(require("path"));
const fs = __importStar(require("fs-extra"));
class FrameworkDetector {
    constructor() {
        this.patterns = new Map();
        this.detectedFrameworks = [];
        this.detectedLanguages = [];
        this.projectPath = '';
        this.fileCache = new Map();
        this.packageCache = new Map();
        this.initializePatterns();
    }
    initializePatterns() {
        this.addPattern('javascript', {
            name: 'React',
            language: 'javascript',
            type: 'web',
            confidence: 0,
            filePatterns: ['*.jsx', '*.tsx', 'App.js', 'App.tsx'],
            contentPatterns: [
                /import\s+(?:React|\{[^}]*\})\s+from\s+['"]react['"]/,
                /from\s+['"]react['"]/,
                /React\.Component/,
                /React\.createElement/,
                /useState\s*\(/,
                /useEffect\s*\(/,
                /useContext\s*\(/,
                /useReducer\s*\(/
            ],
            dependencyPatterns: ['react', 'react-dom'],
            structuralPatterns: [
                { type: 'directory', pattern: 'components', required: false, weight: 0.2 },
                { type: 'directory', pattern: 'pages', required: false, weight: 0.15 },
                { type: 'file', pattern: /App\.(jsx?|tsx?)$/, required: false, weight: 0.3 },
                { type: 'import', pattern: 'react-router', required: false, weight: 0.1 }
            ],
            configFiles: ['.eslintrc', 'tsconfig.json', 'jsconfig.json'],
            conventions: ['JSX syntax', 'Component-based architecture', 'Virtual DOM'],
            metadata: {
                packageManager: 'npm',
                bundler: 'webpack',
                stateManagement: 'context',
                router: 'react-router'
            }
        });
        this.addPattern('javascript', {
            name: 'Next.js',
            language: 'javascript',
            type: 'web',
            confidence: 0,
            filePatterns: ['pages/**/*', 'app/**/*', 'next.config.js'],
            contentPatterns: [
                /from\s+['"]next\//,
                /getServerSideProps/,
                /getStaticProps/,
                /getStaticPaths/,
                /_app\.(jsx?|tsx?)/,
                /_document\.(jsx?|tsx?)/
            ],
            dependencyPatterns: ['next', 'react', 'react-dom'],
            structuralPatterns: [
                { type: 'directory', pattern: 'pages', required: false, weight: 0.4 },
                { type: 'directory', pattern: 'app', required: false, weight: 0.4 },
                { type: 'directory', pattern: 'public', required: false, weight: 0.1 },
                { type: 'file', pattern: 'next.config.js', required: false, weight: 0.3 }
            ],
            configFiles: ['next.config.js', 'next.config.mjs'],
            conventions: ['File-based routing', 'Server-side rendering', 'API routes'],
            metadata: {
                packageManager: 'npm',
                bundler: 'webpack',
                stateManagement: 'context',
                router: 'file-based'
            }
        });
        this.addPattern('javascript', {
            name: 'Vue.js',
            language: 'javascript',
            type: 'web',
            confidence: 0,
            filePatterns: ['*.vue', 'App.vue', 'main.js'],
            contentPatterns: [
                /from\s+['"]vue['"]/,
                /Vue\.createApp/,
                /new\s+Vue\(/,
                /<template>/,
                /<script\s+setup>/,
                /defineComponent/,
                /ref\s*\(/,
                /reactive\s*\(/
            ],
            dependencyPatterns: ['vue', '@vue/cli'],
            structuralPatterns: [
                { type: 'directory', pattern: 'components', required: false, weight: 0.2 },
                { type: 'directory', pattern: 'views', required: false, weight: 0.15 },
                { type: 'file', pattern: /\.vue$/, required: true, weight: 0.5 },
                { type: 'import', pattern: 'vue-router', required: false, weight: 0.1 }
            ],
            configFiles: ['vue.config.js', 'vite.config.js'],
            conventions: ['Single-file components', 'Template syntax', 'Reactive data'],
            metadata: {
                packageManager: 'npm',
                bundler: 'vite',
                stateManagement: 'vuex',
                router: 'vue-router'
            }
        });
        this.addPattern('javascript', {
            name: 'Angular',
            language: 'typescript',
            type: 'web',
            confidence: 0,
            filePatterns: ['*.component.ts', '*.module.ts', '*.service.ts', 'angular.json'],
            contentPatterns: [
                /@Component\(/,
                /@Injectable\(/,
                /@NgModule\(/,
                /@Directive\(/,
                /@Pipe\(/,
                /from\s+['"]@angular\//
            ],
            dependencyPatterns: ['@angular/core', '@angular/cli'],
            structuralPatterns: [
                { type: 'file', pattern: 'angular.json', required: true, weight: 0.5 },
                { type: 'directory', pattern: 'src/app', required: true, weight: 0.3 },
                { type: 'file', pattern: /\.component\.ts$/, required: true, weight: 0.2 }
            ],
            configFiles: ['angular.json', 'tsconfig.json', '.angular-cli.json'],
            conventions: ['Component-based', 'Dependency injection', 'TypeScript'],
            metadata: {
                packageManager: 'npm',
                bundler: 'webpack',
                stateManagement: 'services',
                router: '@angular/router'
            }
        });
        this.addPattern('javascript', {
            name: 'Express.js',
            language: 'javascript',
            type: 'api',
            confidence: 0,
            filePatterns: ['app.js', 'server.js', 'index.js', 'routes/*.js'],
            contentPatterns: [
                /require\(['"]express['"]\)/,
                /from\s+['"]express['"]/,
                /express\(\)/,
                /app\.use\(/,
                /app\.(get|post|put|delete|patch)\(/,
                /Router\(\)/
            ],
            dependencyPatterns: ['express'],
            structuralPatterns: [
                { type: 'directory', pattern: 'routes', required: false, weight: 0.3 },
                { type: 'directory', pattern: 'middleware', required: false, weight: 0.2 },
                { type: 'file', pattern: /app\.(js|ts)$/, required: false, weight: 0.3 }
            ],
            configFiles: ['package.json'],
            conventions: ['Middleware pattern', 'Routing', 'RESTful APIs'],
            metadata: {
                packageManager: 'npm',
                orm: 'mongoose',
                templateEngine: 'ejs',
                httpClient: 'axios'
            }
        });
        this.addPattern('javascript', {
            name: 'NestJS',
            language: 'typescript',
            type: 'api',
            confidence: 0,
            filePatterns: ['*.module.ts', '*.controller.ts', '*.service.ts', 'main.ts'],
            contentPatterns: [
                /@Module\(/,
                /@Controller\(/,
                /@Injectable\(/,
                /@Get\(/,
                /@Post\(/,
                /from\s+['"]@nestjs\//,
                /NestFactory\.create/
            ],
            dependencyPatterns: ['@nestjs/core', '@nestjs/common'],
            structuralPatterns: [
                { type: 'file', pattern: 'main.ts', required: true, weight: 0.3 },
                { type: 'file', pattern: /\.module\.ts$/, required: true, weight: 0.4 },
                { type: 'decorator', pattern: '@Module', required: true, weight: 0.3 }
            ],
            configFiles: ['nest-cli.json', 'tsconfig.json'],
            conventions: ['Dependency injection', 'Decorators', 'Module-based'],
            metadata: {
                packageManager: 'npm',
                orm: 'typeorm',
                httpClient: 'axios'
            }
        });
        this.addPattern('python', {
            name: 'Django',
            language: 'python',
            type: 'web',
            confidence: 0,
            filePatterns: ['manage.py', 'settings.py', 'urls.py', 'wsgi.py', 'models.py'],
            contentPatterns: [
                /from\s+django/,
                /import\s+django/,
                /django\.contrib/,
                /path\(/,
                /urlpatterns/,
                /INSTALLED_APPS/,
                /class.*\(models\.Model\)/
            ],
            dependencyPatterns: ['django'],
            structuralPatterns: [
                { type: 'file', pattern: 'manage.py', required: true, weight: 0.4 },
                { type: 'file', pattern: 'settings.py', required: true, weight: 0.3 },
                { type: 'file', pattern: 'urls.py', required: true, weight: 0.2 },
                { type: 'directory', pattern: 'templates', required: false, weight: 0.1 }
            ],
            configFiles: ['requirements.txt', 'Pipfile', 'pyproject.toml'],
            conventions: ['MVT pattern', 'ORM', 'Admin interface'],
            metadata: {
                packageManager: 'pip',
                orm: 'django-orm',
                templateEngine: 'django-templates'
            }
        });
        this.addPattern('python', {
            name: 'FastAPI',
            language: 'python',
            type: 'api',
            confidence: 0,
            filePatterns: ['main.py', 'app.py', 'api/*.py'],
            contentPatterns: [
                /from\s+fastapi/,
                /import\s+fastapi/,
                /FastAPI\(/,
                /@app\.(get|post|put|delete|patch)/,
                /async\s+def/,
                /Depends\(/,
                /HTTPException/
            ],
            dependencyPatterns: ['fastapi', 'uvicorn'],
            structuralPatterns: [
                { type: 'import', pattern: 'fastapi', required: true, weight: 0.5 },
                { type: 'decorator', pattern: '@app.', required: true, weight: 0.3 },
                { type: 'directory', pattern: 'routers', required: false, weight: 0.2 }
            ],
            configFiles: ['requirements.txt', 'Pipfile', 'pyproject.toml'],
            conventions: ['Async/await', 'Type hints', 'OpenAPI'],
            metadata: {
                packageManager: 'pip',
                orm: 'sqlalchemy',
                server: 'uvicorn'
            }
        });
        this.addPattern('python', {
            name: 'Flask',
            language: 'python',
            type: 'web',
            confidence: 0,
            filePatterns: ['app.py', 'application.py', 'wsgi.py'],
            contentPatterns: [
                /from\s+flask/,
                /import\s+flask/,
                /Flask\(__name__\)/,
                /@app\.route/,
                /render_template/,
                /jsonify/
            ],
            dependencyPatterns: ['flask'],
            structuralPatterns: [
                { type: 'import', pattern: 'flask', required: true, weight: 0.5 },
                { type: 'decorator', pattern: '@app.route', required: false, weight: 0.3 },
                { type: 'directory', pattern: 'templates', required: false, weight: 0.1 },
                { type: 'directory', pattern: 'static', required: false, weight: 0.1 }
            ],
            configFiles: ['requirements.txt', 'Pipfile'],
            conventions: ['Lightweight', 'Flexible', 'Microframework'],
            metadata: {
                packageManager: 'pip',
                orm: 'sqlalchemy',
                templateEngine: 'jinja2'
            }
        });
        this.addPattern('java', {
            name: 'Spring Boot',
            language: 'java',
            type: 'api',
            confidence: 0,
            filePatterns: ['pom.xml', 'build.gradle', 'Application.java', '*Controller.java'],
            contentPatterns: [
                /@SpringBootApplication/,
                /@RestController/,
                /@Controller/,
                /@Service/,
                /@Repository/,
                /@Component/,
                /@Autowired/,
                /import\s+org\.springframework/
            ],
            dependencyPatterns: ['spring-boot-starter'],
            structuralPatterns: [
                { type: 'file', pattern: 'pom.xml', required: false, weight: 0.3 },
                { type: 'file', pattern: 'build.gradle', required: false, weight: 0.3 },
                { type: 'annotation', pattern: '@SpringBootApplication', required: true, weight: 0.4 },
                { type: 'directory', pattern: 'src/main/java', required: true, weight: 0.2 }
            ],
            configFiles: ['application.properties', 'application.yml', 'application.yaml'],
            conventions: ['Dependency injection', 'Auto-configuration', 'Embedded server'],
            metadata: {
                packageManager: 'maven',
                buildSystem: 'maven',
                orm: 'spring-data-jpa'
            }
        });
        this.addPattern('csharp', {
            name: 'ASP.NET Core',
            language: 'csharp',
            type: 'web',
            confidence: 0,
            filePatterns: ['*.csproj', 'Program.cs', 'Startup.cs', '*Controller.cs'],
            contentPatterns: [
                /using\s+Microsoft\.AspNetCore/,
                /WebApplication\.CreateBuilder/,
                /\[ApiController\]/,
                /\[HttpGet\]/,
                /\[HttpPost\]/,
                /IActionResult/,
                /ControllerBase/
            ],
            dependencyPatterns: ['Microsoft.AspNetCore'],
            structuralPatterns: [
                { type: 'file', pattern: '.csproj', required: true, weight: 0.3 },
                { type: 'file', pattern: 'Program.cs', required: true, weight: 0.3 },
                { type: 'directory', pattern: 'Controllers', required: false, weight: 0.2 },
                { type: 'directory', pattern: 'Models', required: false, weight: 0.1 }
            ],
            configFiles: ['appsettings.json', 'appsettings.Development.json'],
            conventions: ['MVC pattern', 'Dependency injection', 'Middleware pipeline'],
            metadata: {
                packageManager: 'nuget',
                orm: 'entity-framework',
                buildSystem: 'dotnet'
            }
        });
        this.addPattern('go', {
            name: 'Gin',
            language: 'go',
            type: 'api',
            confidence: 0,
            filePatterns: ['go.mod', 'main.go', '*.go'],
            contentPatterns: [
                /import.*github\.com\/gin-gonic\/gin/,
                /gin\.Default\(\)/,
                /gin\.New\(\)/,
                /router\.(GET|POST|PUT|DELETE)/,
                /c\.JSON\(/,
                /c\.Bind\(/
            ],
            dependencyPatterns: ['github.com/gin-gonic/gin'],
            structuralPatterns: [
                { type: 'file', pattern: 'go.mod', required: true, weight: 0.4 },
                { type: 'import', pattern: 'gin-gonic/gin', required: true, weight: 0.4 },
                { type: 'directory', pattern: 'handlers', required: false, weight: 0.1 },
                { type: 'directory', pattern: 'models', required: false, weight: 0.1 }
            ],
            configFiles: ['go.mod', 'go.sum'],
            conventions: ['HTTP router', 'Middleware', 'JSON binding'],
            metadata: {
                packageManager: 'go',
                orm: 'gorm'
            }
        });
        this.addPattern('go', {
            name: 'Echo',
            language: 'go',
            type: 'api',
            confidence: 0,
            filePatterns: ['go.mod', 'main.go', '*.go'],
            contentPatterns: [
                /import.*github\.com\/labstack\/echo/,
                /echo\.New\(\)/,
                /e\.(GET|POST|PUT|DELETE)/,
                /echo\.Context/,
                /c\.JSON\(/
            ],
            dependencyPatterns: ['github.com/labstack/echo'],
            structuralPatterns: [
                { type: 'file', pattern: 'go.mod', required: true, weight: 0.4 },
                { type: 'import', pattern: 'labstack/echo', required: true, weight: 0.4 }
            ],
            configFiles: ['go.mod', 'go.sum'],
            conventions: ['High performance', 'Middleware', 'WebSocket support'],
            metadata: {
                packageManager: 'go',
                orm: 'gorm'
            }
        });
        this.addPattern('rust', {
            name: 'Actix-web',
            language: 'rust',
            type: 'api',
            confidence: 0,
            filePatterns: ['Cargo.toml', 'main.rs', 'lib.rs'],
            contentPatterns: [
                /use\s+actix_web/,
                /actix_web::main/,
                /HttpServer::new/,
                /#\[get\(/,
                /#\[post\(/,
                /web::Data/
            ],
            dependencyPatterns: ['actix-web'],
            structuralPatterns: [
                { type: 'file', pattern: 'Cargo.toml', required: true, weight: 0.4 },
                { type: 'import', pattern: 'actix_web', required: true, weight: 0.4 }
            ],
            configFiles: ['Cargo.toml', 'Cargo.lock'],
            conventions: ['Actor model', 'Async/await', 'Type safe'],
            metadata: {
                packageManager: 'cargo',
                orm: 'diesel'
            }
        });
        this.addPattern('rust', {
            name: 'Rocket',
            language: 'rust',
            type: 'api',
            confidence: 0,
            filePatterns: ['Cargo.toml', 'main.rs', 'lib.rs'],
            contentPatterns: [
                /use\s+rocket/,
                /#\[launch\]/,
                /#\[get\(/,
                /#\[post\(/,
                /rocket::build\(\)/
            ],
            dependencyPatterns: ['rocket'],
            structuralPatterns: [
                { type: 'file', pattern: 'Cargo.toml', required: true, weight: 0.4 },
                { type: 'import', pattern: 'rocket', required: true, weight: 0.4 }
            ],
            configFiles: ['Cargo.toml', 'Rocket.toml'],
            conventions: ['Type safe', 'Code generation', 'Request guards'],
            metadata: {
                packageManager: 'cargo',
                orm: 'diesel'
            }
        });
        this.addPattern('php', {
            name: 'Laravel',
            language: 'php',
            type: 'web',
            confidence: 0,
            filePatterns: ['composer.json', 'artisan', 'routes/web.php', 'app/Http/Controllers/*.php'],
            contentPatterns: [
                /namespace\s+App\\Http\\Controllers/,
                /use\s+Illuminate\\/,
                /extends\s+Controller/,
                /Route::/,
                /return\s+view\(/
            ],
            dependencyPatterns: ['laravel/framework'],
            structuralPatterns: [
                { type: 'file', pattern: 'artisan', required: true, weight: 0.4 },
                { type: 'file', pattern: 'composer.json', required: true, weight: 0.2 },
                { type: 'directory', pattern: 'app', required: true, weight: 0.2 },
                { type: 'directory', pattern: 'routes', required: true, weight: 0.2 }
            ],
            configFiles: ['.env', 'config/app.php'],
            conventions: ['MVC pattern', 'Eloquent ORM', 'Blade templates'],
            metadata: {
                packageManager: 'composer',
                orm: 'eloquent',
                templateEngine: 'blade'
            }
        });
        this.addPattern('php', {
            name: 'Symfony',
            language: 'php',
            type: 'web',
            confidence: 0,
            filePatterns: ['composer.json', 'symfony.lock', 'config/bundles.php'],
            contentPatterns: [
                /use\s+Symfony\\/,
                /extends\s+AbstractController/,
                /#\[Route\(/,
                /return\s+\$this->render\(/
            ],
            dependencyPatterns: ['symfony/framework-bundle'],
            structuralPatterns: [
                { type: 'file', pattern: 'symfony.lock', required: false, weight: 0.3 },
                { type: 'directory', pattern: 'config', required: true, weight: 0.3 },
                { type: 'directory', pattern: 'src', required: true, weight: 0.2 }
            ],
            configFiles: ['.env', 'config/packages/*.yaml'],
            conventions: ['Bundles', 'Dependency injection', 'Twig templates'],
            metadata: {
                packageManager: 'composer',
                orm: 'doctrine',
                templateEngine: 'twig'
            }
        });
    }
    async detectFrameworks(projectPath) {
        const span = telemetry_schema_1.telemetry.createSpan('detectFrameworks');
        this.projectPath = projectPath;
        await this.detectLanguages();
        for (const lang of this.detectedLanguages) {
            await this.detectFrameworksForLanguage(lang.language.name.toLowerCase());
        }
        const buildTools = await this.detectBuildTools();
        const testingFrameworks = await this.detectTestingFrameworks();
        const databases = await this.detectDatabases();
        const messageQueues = await this.detectMessageQueues();
        this.detectedFrameworks.sort((a, b) => b.confidence - a.confidence);
        for (const result of this.detectedFrameworks) {
            telemetry_schema_1.telemetry.emit({
                type: 'framework_detected',
                source: { analyzer: 'framework-detector' },
                data: {
                    framework: result.framework.name,
                    version: result.framework.version,
                    confidence: result.confidence,
                    indicators: result.indicators
                }
            });
        }
        span.end();
        return {
            primaryFramework: this.detectedFrameworks[0]?.framework || null,
            additionalFrameworks: this.detectedFrameworks.slice(1).map(r => r.framework),
            languages: this.detectedLanguages.map(r => r.language),
            buildTools,
            testingFrameworks,
            databases,
            messageQueues,
            caching: await this.detectCaching(),
            authentication: await this.detectAuthentication(),
            deployment: await this.detectDeployment()
        };
    }
    async detectLanguages() {
        const fileExtensions = new Map();
        const files = await this.getAllFiles();
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            fileExtensions.set(ext, (fileExtensions.get(ext) || 0) + 1);
        }
        const languageMap = {
            '.js': 'JavaScript',
            '.jsx': 'JavaScript',
            '.ts': 'TypeScript',
            '.tsx': 'TypeScript',
            '.py': 'Python',
            '.java': 'Java',
            '.cs': 'C#',
            '.go': 'Go',
            '.rs': 'Rust',
            '.php': 'PHP',
            '.rb': 'Ruby',
            '.swift': 'Swift',
            '.kt': 'Kotlin',
            '.scala': 'Scala',
            '.cpp': 'C++',
            '.c': 'C',
            '.h': 'C/C++',
            '.hpp': 'C++'
        };
        const languageCounts = new Map();
        for (const [ext, count] of fileExtensions) {
            const lang = languageMap[ext];
            if (lang) {
                languageCounts.set(lang, (languageCounts.get(lang) || 0) + count);
            }
        }
        const totalFiles = Array.from(languageCounts.values()).reduce((a, b) => a + b, 0);
        for (const [lang, count] of languageCounts) {
            this.detectedLanguages.push({
                language: {
                    name: lang,
                    fileCount: count,
                    lineCount: 0,
                    percentage: (count / totalFiles) * 100
                },
                confidence: Math.min(count / 10, 1),
                fileCount: count,
                indicators: [`${count} ${lang} files found`]
            });
        }
        this.detectedLanguages.sort((a, b) => b.fileCount - a.fileCount);
    }
    async detectFrameworksForLanguage(language) {
        const patterns = this.patterns.get(language) || [];
        for (const pattern of patterns) {
            const result = await this.evaluateFrameworkPattern(pattern);
            if (result.confidence > 0.5) {
                this.detectedFrameworks.push(result);
            }
        }
    }
    async evaluateFrameworkPattern(pattern) {
        let confidence = 0;
        const indicators = [];
        let totalWeight = 0;
        const files = await this.getFilesByPattern(pattern.filePatterns);
        if (files.length > 0) {
            confidence += 0.2;
            indicators.push(`Found ${files.length} matching files`);
        }
        const contentMatches = await this.checkContentPatterns(pattern.contentPatterns);
        if (contentMatches > 0) {
            confidence += Math.min(contentMatches * 0.1, 0.3);
            indicators.push(`Found ${contentMatches} code patterns`);
        }
        const depMatches = await this.checkDependencies(pattern.dependencyPatterns);
        if (depMatches > 0) {
            confidence += Math.min(depMatches * 0.15, 0.3);
            indicators.push(`Found ${depMatches} dependencies`);
        }
        for (const structural of pattern.structuralPatterns) {
            const found = await this.checkStructuralPattern(structural);
            if (found) {
                confidence += structural.weight;
                indicators.push(`Found ${structural.type}: ${structural.pattern}`);
            }
            if (structural.required) {
                totalWeight += structural.weight;
            }
        }
        const configFound = await this.checkConfigFiles(pattern.configFiles);
        if (configFound > 0) {
            confidence += Math.min(configFound * 0.1, 0.2);
            indicators.push(`Found ${configFound} config files`);
        }
        const version = await this.detectFrameworkVersion(pattern.name);
        return {
            framework: {
                name: pattern.name,
                version: version || 'unknown',
                type: pattern.type,
                usage: confidence > 0.8 ? 'primary' : 'secondary',
                conventions: pattern.conventions,
                patterns: indicators,
                configFiles: pattern.configFiles,
                detectionConfidence: confidence,
                metadata: pattern.metadata
            },
            confidence,
            indicators,
            version
        };
    }
    async getFilesByPattern(patterns) {
        const allFiles = await this.getAllFiles();
        const matchedFiles = [];
        for (const file of allFiles) {
            const fileName = path.basename(file);
            const relativePath = path.relative(this.projectPath, file);
            for (const pattern of patterns) {
                if (pattern.includes('*')) {
                    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
                    if (regex.test(relativePath) || regex.test(fileName)) {
                        matchedFiles.push(file);
                    }
                }
                else {
                    if (fileName === pattern || relativePath.includes(pattern)) {
                        matchedFiles.push(file);
                    }
                }
            }
        }
        return matchedFiles;
    }
    async checkContentPatterns(patterns) {
        const files = await this.getSampleFiles();
        let matches = 0;
        for (const file of files) {
            const content = await this.readFile(file);
            for (const pattern of patterns) {
                if (pattern.test(content)) {
                    matches++;
                }
            }
        }
        return matches;
    }
    async checkDependencies(dependencies) {
        let matches = 0;
        const packageJson = await this.readPackageJson();
        if (packageJson) {
            const allDeps = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies,
                ...packageJson.peerDependencies
            };
            for (const dep of dependencies) {
                if (allDeps[dep]) {
                    matches++;
                }
            }
        }
        const requirements = await this.readRequirements();
        if (requirements) {
            for (const dep of dependencies) {
                if (requirements.includes(dep)) {
                    matches++;
                }
            }
        }
        const goMod = await this.readGoMod();
        if (goMod) {
            for (const dep of dependencies) {
                if (goMod.includes(dep)) {
                    matches++;
                }
            }
        }
        const cargoToml = await this.readCargoToml();
        if (cargoToml) {
            for (const dep of dependencies) {
                if (cargoToml.includes(dep)) {
                    matches++;
                }
            }
        }
        return matches;
    }
    async checkStructuralPattern(pattern) {
        switch (pattern.type) {
            case 'directory':
                return await this.directoryExists(pattern.pattern);
            case 'file':
                if (pattern.pattern instanceof RegExp) {
                    const files = await this.getAllFiles();
                    return files.some(f => pattern.pattern.test(path.basename(f)));
                }
                return await this.fileExists(pattern.pattern);
            case 'import':
            case 'decorator':
            case 'annotation':
                const files = await this.getSampleFiles();
                for (const file of files) {
                    const content = await this.readFile(file);
                    if (typeof pattern.pattern === 'string') {
                        if (content.includes(pattern.pattern))
                            return true;
                    }
                    else {
                        if (pattern.pattern.test(content))
                            return true;
                    }
                }
                return false;
            case 'config':
                return await this.fileExists(pattern.pattern);
            default:
                return false;
        }
    }
    async checkConfigFiles(configFiles) {
        let found = 0;
        for (const config of configFiles) {
            if (await this.fileExists(config)) {
                found++;
            }
        }
        return found;
    }
    async detectFrameworkVersion(frameworkName) {
        const packageJson = await this.readPackageJson();
        if (packageJson) {
            const allDeps = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies
            };
            const frameworkKey = frameworkName.toLowerCase().replace(/\s+/g, '-');
            if (allDeps[frameworkKey]) {
                return allDeps[frameworkKey].replace(/[\^~]/, '');
            }
        }
        if (frameworkName.toLowerCase() === 'django' || frameworkName.toLowerCase() === 'flask') {
            const requirements = await this.readRequirements();
            if (requirements) {
                const regex = new RegExp(`${frameworkName}==([0-9.]+)`, 'i');
                const match = requirements.match(regex);
                if (match)
                    return match[1];
            }
        }
        return undefined;
    }
    async detectBuildTools() {
        const buildTools = [];
        const packageJson = await this.readPackageJson();
        if (packageJson) {
            if (packageJson.scripts) {
                buildTools.push({
                    name: 'npm',
                    version: packageJson.engines?.npm,
                    configFile: 'package.json',
                    scripts: Object.keys(packageJson.scripts)
                });
            }
            const devDeps = packageJson.devDependencies || {};
            if (devDeps.webpack) {
                buildTools.push({
                    name: 'webpack',
                    version: devDeps.webpack,
                    configFile: 'webpack.config.js',
                    scripts: []
                });
            }
            if (devDeps.vite) {
                buildTools.push({
                    name: 'vite',
                    version: devDeps.vite,
                    configFile: 'vite.config.js',
                    scripts: []
                });
            }
            if (devDeps.parcel) {
                buildTools.push({
                    name: 'parcel',
                    version: devDeps.parcel,
                    configFile: 'package.json',
                    scripts: []
                });
            }
        }
        if (await this.fileExists('pom.xml')) {
            buildTools.push({
                name: 'maven',
                configFile: 'pom.xml',
                scripts: ['compile', 'test', 'package', 'install']
            });
        }
        if (await this.fileExists('build.gradle')) {
            buildTools.push({
                name: 'gradle',
                configFile: 'build.gradle',
                scripts: ['build', 'test', 'run']
            });
        }
        if (await this.fileExists('*.csproj')) {
            buildTools.push({
                name: 'dotnet',
                configFile: '*.csproj',
                scripts: ['build', 'test', 'publish']
            });
        }
        return buildTools;
    }
    async detectTestingFrameworks() {
        const testingFrameworks = [];
        const packageJson = await this.readPackageJson();
        if (packageJson) {
            const allDeps = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies
            };
            if (allDeps.jest) {
                testingFrameworks.push({
                    name: 'Jest',
                    version: allDeps.jest,
                    type: 'unit',
                    configFile: 'jest.config.js'
                });
            }
            if (allDeps.mocha) {
                testingFrameworks.push({
                    name: 'Mocha',
                    version: allDeps.mocha,
                    type: 'unit',
                    configFile: '.mocharc.json'
                });
            }
            if (allDeps.cypress) {
                testingFrameworks.push({
                    name: 'Cypress',
                    version: allDeps.cypress,
                    type: 'e2e',
                    configFile: 'cypress.config.js'
                });
            }
            if (allDeps['@playwright/test']) {
                testingFrameworks.push({
                    name: 'Playwright',
                    version: allDeps['@playwright/test'],
                    type: 'e2e',
                    configFile: 'playwright.config.js'
                });
            }
        }
        const requirements = await this.readRequirements();
        if (requirements) {
            if (requirements.includes('pytest')) {
                testingFrameworks.push({
                    name: 'pytest',
                    version: 'latest',
                    type: 'unit',
                    configFile: 'pytest.ini'
                });
            }
            if (requirements.includes('unittest')) {
                testingFrameworks.push({
                    name: 'unittest',
                    version: 'built-in',
                    type: 'unit'
                });
            }
        }
        return testingFrameworks;
    }
    async detectDatabases() {
        const databases = [];
        const indicators = new Set();
        const packageJson = await this.readPackageJson();
        if (packageJson) {
            const allDeps = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies
            };
            if (allDeps.pg || allDeps['pg-promise'])
                indicators.add('postgresql');
            if (allDeps.mysql || allDeps.mysql2)
                indicators.add('mysql');
            if (allDeps.mongodb || allDeps.mongoose)
                indicators.add('mongodb');
            if (allDeps.redis)
                indicators.add('redis');
            if (allDeps.sqlite3)
                indicators.add('sqlite');
        }
        const dockerCompose = await this.readDockerCompose();
        if (dockerCompose) {
            if (dockerCompose.includes('postgres'))
                indicators.add('postgresql');
            if (dockerCompose.includes('mysql'))
                indicators.add('mysql');
            if (dockerCompose.includes('mongo'))
                indicators.add('mongodb');
            if (dockerCompose.includes('redis'))
                indicators.add('redis');
        }
        const envFile = await this.readEnvFile();
        if (envFile) {
            if (envFile.includes('postgres'))
                indicators.add('postgresql');
            if (envFile.includes('mysql'))
                indicators.add('mysql');
            if (envFile.includes('mongodb'))
                indicators.add('mongodb');
            if (envFile.includes('redis'))
                indicators.add('redis');
        }
        for (const db of indicators) {
            databases.push({
                type: db,
                name: db,
                usage: db === 'redis' ? 'cache' : 'primary'
            });
        }
        return databases;
    }
    async detectMessageQueues() {
        const queues = [];
        const indicators = new Set();
        const packageJson = await this.readPackageJson();
        if (packageJson) {
            const allDeps = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies
            };
            if (allDeps.amqplib || allDeps['amqp-connection-manager'])
                indicators.add('rabbitmq');
            if (allDeps.bull || allDeps.bullmq)
                indicators.add('redis');
            if (allDeps.kafkajs)
                indicators.add('kafka');
            if (allDeps['aws-sdk'] && allDeps['@aws-sdk/client-sqs'])
                indicators.add('sqs');
        }
        for (const queue of indicators) {
            queues.push({
                type: queue,
                name: queue,
                topics: [],
                usage: queue === 'redis' ? 'job-queue' : 'event-streaming'
            });
        }
        return queues;
    }
    async detectCaching() {
        const caching = [];
        const packageJson = await this.readPackageJson();
        if (packageJson?.dependencies?.redis || packageJson?.devDependencies?.redis) {
            caching.push({
                type: 'redis',
                name: 'Redis',
                usage: 'primary'
            });
        }
        if (packageJson?.dependencies?.memcached || packageJson?.devDependencies?.memcached) {
            caching.push({
                type: 'memcached',
                name: 'Memcached',
                usage: 'primary'
            });
        }
        return caching;
    }
    async detectAuthentication() {
        const auth = [];
        const packageJson = await this.readPackageJson();
        if (packageJson) {
            const allDeps = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies
            };
            if (allDeps.passport) {
                auth.push({
                    type: 'oauth',
                    provider: 'Passport.js',
                    scopes: [],
                    required: true
                });
            }
            if (allDeps.jsonwebtoken) {
                auth.push({
                    type: 'jwt',
                    provider: 'jsonwebtoken',
                    scopes: [],
                    required: true
                });
            }
            if (allDeps['@auth0/nextjs-auth0'] || allDeps['auth0-js']) {
                auth.push({
                    type: 'oauth',
                    provider: 'Auth0',
                    scopes: [],
                    required: true
                });
            }
        }
        return auth;
    }
    async detectDeployment() {
        const deployment = [];
        if (await this.fileExists('Dockerfile')) {
            deployment.push({
                platform: 'Docker',
                containerization: { type: 'docker' }
            });
        }
        if (await this.fileExists('docker-compose.yml')) {
            deployment.push({
                platform: 'Docker Compose',
                orchestration: { platform: 'docker-compose' }
            });
        }
        if (await this.fileExists('kubernetes.yml') || await this.directoryExists('k8s')) {
            deployment.push({
                platform: 'Kubernetes',
                orchestration: { platform: 'kubernetes' }
            });
        }
        if (await this.fileExists('.github/workflows')) {
            deployment.push({
                platform: 'GitHub Actions',
                cicd: { platform: 'github-actions' }
            });
        }
        if (await this.fileExists('.gitlab-ci.yml')) {
            deployment.push({
                platform: 'GitLab CI',
                cicd: { platform: 'gitlab-ci' }
            });
        }
        return deployment;
    }
    addPattern(language, pattern) {
        if (!this.patterns.has(language)) {
            this.patterns.set(language, []);
        }
        this.patterns.get(language).push(pattern);
    }
    async getAllFiles() {
        const walk = async (dir) => {
            const files = [];
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.') &&
                    entry.name !== 'node_modules' && entry.name !== 'dist' &&
                    entry.name !== 'build' && entry.name !== 'target') {
                    files.push(...await walk(fullPath));
                }
                else if (entry.isFile()) {
                    files.push(fullPath);
                }
            }
            return files;
        };
        return await walk(this.projectPath);
    }
    async getSampleFiles(maxFiles = 20) {
        const allFiles = await this.getAllFiles();
        const codeFiles = allFiles.filter(f => {
            const ext = path.extname(f);
            return ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cs', '.go', '.rs', '.php', '.rb'].includes(ext);
        });
        return codeFiles.slice(0, maxFiles);
    }
    async readFile(filePath) {
        if (this.fileCache.has(filePath)) {
            return this.fileCache.get(filePath);
        }
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            this.fileCache.set(filePath, content);
            return content;
        }
        catch {
            return '';
        }
    }
    async fileExists(fileName) {
        try {
            if (fileName.includes('*')) {
                const files = await this.getAllFiles();
                const regex = new RegExp(fileName.replace(/\*/g, '.*'));
                return files.some(f => regex.test(path.basename(f)));
            }
            await fs.access(path.join(this.projectPath, fileName));
            return true;
        }
        catch {
            return false;
        }
    }
    async directoryExists(dirName) {
        try {
            const stat = await fs.stat(path.join(this.projectPath, dirName));
            return stat.isDirectory();
        }
        catch {
            return false;
        }
    }
    async readPackageJson() {
        const key = 'package.json';
        if (this.packageCache.has(key)) {
            return this.packageCache.get(key);
        }
        try {
            const content = await fs.readJson(path.join(this.projectPath, 'package.json'));
            this.packageCache.set(key, content);
            return content;
        }
        catch {
            return null;
        }
    }
    async readRequirements() {
        try {
            return await this.readFile(path.join(this.projectPath, 'requirements.txt'));
        }
        catch {
            return null;
        }
    }
    async readGoMod() {
        try {
            return await this.readFile(path.join(this.projectPath, 'go.mod'));
        }
        catch {
            return null;
        }
    }
    async readCargoToml() {
        try {
            return await this.readFile(path.join(this.projectPath, 'Cargo.toml'));
        }
        catch {
            return null;
        }
    }
    async readDockerCompose() {
        try {
            return await this.readFile(path.join(this.projectPath, 'docker-compose.yml'));
        }
        catch {
            try {
                return await this.readFile(path.join(this.projectPath, 'docker-compose.yaml'));
            }
            catch {
                return null;
            }
        }
    }
    async readEnvFile() {
        try {
            return await this.readFile(path.join(this.projectPath, '.env'));
        }
        catch {
            return null;
        }
    }
}
exports.FrameworkDetector = FrameworkDetector;
