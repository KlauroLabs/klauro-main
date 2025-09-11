/**
 * Framework Detector Pattern Analyzer
 * Detects frameworks, libraries, and architectural patterns across multiple languages
 */

import { FrameworkInfo, FrameworkMetadata, TechnologyStack, LanguageInfo,
         BuildToolInfo, TestingFrameworkInfo, DatabaseInfo, MessageQueueInfo } from '../../types';
import { telemetry, PatternDetectedEvent } from '../../telemetry/telemetry-schema';
import * as path from 'path';
import * as fs from 'fs-extra';

export interface FrameworkPattern {
  name: string;
  language: string;
  type: 'web' | 'mobile' | 'desktop' | 'api' | 'library' | 'testing' | 'build' | 'database';
  confidence: number;
  filePatterns: string[];
  contentPatterns: RegExp[];
  dependencyPatterns: string[];
  structuralPatterns: StructuralPattern[];
  configFiles: string[];
  conventions: string[];
  metadata?: FrameworkMetadata;
}

export interface StructuralPattern {
  type: 'directory' | 'file' | 'import' | 'decorator' | 'annotation' | 'config';
  pattern: string | RegExp;
  required: boolean;
  weight: number;
}

export interface DetectionResult {
  framework: FrameworkInfo;
  confidence: number;
  indicators: string[];
  version?: string;
  configuration?: any;
}

export interface LanguageDetectionResult {
  language: LanguageInfo;
  confidence: number;
  fileCount: number;
  indicators: string[];
}

export class FrameworkDetector {
  private patterns: Map<string, FrameworkPattern[]> = new Map();
  private detectedFrameworks: DetectionResult[] = [];
  private detectedLanguages: LanguageDetectionResult[] = [];
  private projectPath: string = '';
  private fileCache: Map<string, string> = new Map();
  private packageCache: Map<string, any> = new Map();

  constructor() {
    this.initializePatterns();
  }

  private initializePatterns(): void {
    // JavaScript/TypeScript Frameworks
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

    // Python Frameworks
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

    // Java Frameworks
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

    // C# Frameworks
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

    // Go Frameworks
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

    // Rust Frameworks
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

    // PHP Frameworks
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

  public async detectFrameworks(projectPath: string): Promise<TechnologyStack> {
    const span = telemetry.createSpan('detectFrameworks');
    this.projectPath = projectPath;

    // Detect languages first
    await this.detectLanguages();

    // Detect frameworks for each language
    for (const lang of this.detectedLanguages) {
      await this.detectFrameworksForLanguage(lang.language.name.toLowerCase());
    }

    // Detect build tools
    const buildTools = await this.detectBuildTools();

    // Detect testing frameworks
    const testingFrameworks = await this.detectTestingFrameworks();

    // Detect databases
    const databases = await this.detectDatabases();

    // Detect message queues
    const messageQueues = await this.detectMessageQueues();

    // Sort by confidence
    this.detectedFrameworks.sort((a, b) => b.confidence - a.confidence);

    // Emit telemetry for each detected framework
    for (const result of this.detectedFrameworks) {
      telemetry.emit({
        type: 'framework_detected',
        source: { analyzer: 'framework-detector' },
        data: {
          pattern: result.framework.name,
          confidence: result.confidence,
          location: this.projectPath,
          indicators: result.indicators,
          implications: [`${result.framework.type} framework`, result.framework.name],
          category: 'architectural'
        }
      } as PatternDetectedEvent);
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
    } as TechnologyStack;
  }

  private async detectLanguages(): Promise<void> {
    const fileExtensions = new Map<string, number>();
    const files = await this.getAllFiles();

    // Count file extensions
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      fileExtensions.set(ext, (fileExtensions.get(ext) || 0) + 1);
    }

    // Map extensions to languages
    const languageMap: Record<string, string> = {
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

    const languageCounts = new Map<string, number>();
    for (const [ext, count] of fileExtensions) {
      const lang = languageMap[ext];
      if (lang) {
        languageCounts.set(lang, (languageCounts.get(lang) || 0) + count);
      }
    }

    // Convert to detection results
    const totalFiles = Array.from(languageCounts.values()).reduce((a, b) => a + b, 0);
    for (const [lang, count] of languageCounts) {
      this.detectedLanguages.push({
        language: {
          name: lang,
          fileCount: count,
          lineCount: 0, // Would need to count lines
          percentage: (count / totalFiles) * 100
        },
        confidence: Math.min(count / 10, 1), // Simple confidence based on file count
        fileCount: count,
        indicators: [`${count} ${lang} files found`]
      });
    }

    // Sort by file count
    this.detectedLanguages.sort((a, b) => b.fileCount - a.fileCount);
  }

  private async detectFrameworksForLanguage(language: string): Promise<void> {
    const patterns = this.patterns.get(language) || [];
    
    for (const pattern of patterns) {
      const result = await this.evaluateFrameworkPattern(pattern);
      if (result.confidence > 0.5) {
        this.detectedFrameworks.push(result);
      }
    }
  }

  private async evaluateFrameworkPattern(pattern: FrameworkPattern): Promise<DetectionResult> {
    let confidence = 0;
    const indicators: string[] = [];
    let totalWeight = 0;

    // Check file patterns
    const files = await this.getFilesByPattern(pattern.filePatterns);
    if (files.length > 0) {
      confidence += 0.2;
      indicators.push(`Found ${files.length} matching files`);
    }

    // Check content patterns
    const contentMatches = await this.checkContentPatterns(pattern.contentPatterns);
    if (contentMatches > 0) {
      confidence += Math.min(contentMatches * 0.1, 0.3);
      indicators.push(`Found ${contentMatches} code patterns`);
    }

    // Check dependencies
    const depMatches = await this.checkDependencies(pattern.dependencyPatterns);
    if (depMatches > 0) {
      confidence += Math.min(depMatches * 0.15, 0.3);
      indicators.push(`Found ${depMatches} dependencies`);
    }

    // Check structural patterns
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

    // Check config files
    const configFound = await this.checkConfigFiles(pattern.configFiles);
    if (configFound > 0) {
      confidence += Math.min(configFound * 0.1, 0.2);
      indicators.push(`Found ${configFound} config files`);
    }

    // Detect version
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

  private async getFilesByPattern(patterns: string[]): Promise<string[]> {
    const allFiles = await this.getAllFiles();
    const matchedFiles: string[] = [];

    for (const file of allFiles) {
      const fileName = path.basename(file);
      const relativePath = path.relative(this.projectPath, file);
      
      for (const pattern of patterns) {
        if (pattern.includes('*')) {
          // Handle glob patterns
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          if (regex.test(relativePath) || regex.test(fileName)) {
            matchedFiles.push(file);
          }
        } else {
          // Exact match
          if (fileName === pattern || relativePath.includes(pattern)) {
            matchedFiles.push(file);
          }
        }
      }
    }

    return matchedFiles;
  }

  private async checkContentPatterns(patterns: RegExp[]): Promise<number> {
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

  private async checkDependencies(dependencies: string[]): Promise<number> {
    let matches = 0;

    // Check package.json
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

    // Check requirements.txt
    const requirements = await this.readRequirements();
    if (requirements) {
      for (const dep of dependencies) {
        if (requirements.includes(dep)) {
          matches++;
        }
      }
    }

    // Check go.mod
    const goMod = await this.readGoMod();
    if (goMod) {
      for (const dep of dependencies) {
        if (goMod.includes(dep)) {
          matches++;
        }
      }
    }

    // Check Cargo.toml
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

  private async checkStructuralPattern(pattern: StructuralPattern): Promise<boolean> {
    switch (pattern.type) {
      case 'directory':
        return await this.directoryExists(pattern.pattern as string);
      
      case 'file':
        if (pattern.pattern instanceof RegExp) {
          const files = await this.getAllFiles();
          return files.some(f => pattern.pattern.test(path.basename(f)));
        }
        return await this.fileExists(pattern.pattern as string);
      
      case 'import':
      case 'decorator':
      case 'annotation':
        const files = await this.getSampleFiles();
        for (const file of files) {
          const content = await this.readFile(file);
          if (typeof pattern.pattern === 'string') {
            if (content.includes(pattern.pattern)) return true;
          } else {
            if (pattern.pattern.test(content)) return true;
          }
        }
        return false;
      
      case 'config':
        return await this.fileExists(pattern.pattern as string);
      
      default:
        return false;
    }
  }

  private async checkConfigFiles(configFiles: string[]): Promise<number> {
    let found = 0;
    for (const config of configFiles) {
      if (await this.fileExists(config)) {
        found++;
      }
    }
    return found;
  }

  private async detectFrameworkVersion(frameworkName: string): Promise<string | undefined> {
    // Check package.json
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

    // Check requirements.txt for Python
    if (frameworkName.toLowerCase() === 'django' || frameworkName.toLowerCase() === 'flask') {
      const requirements = await this.readRequirements();
      if (requirements) {
        const regex = new RegExp(`${frameworkName}==([0-9.]+)`, 'i');
        const match = requirements.match(regex);
        if (match) return match[1];
      }
    }

    return undefined;
  }

  private async detectBuildTools(): Promise<BuildToolInfo[]> {
    const buildTools: BuildToolInfo[] = [];

    // JavaScript/TypeScript build tools
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

      // Check for specific build tools
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

    // Java build tools
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

    // .NET build tools
    if (await this.fileExists('*.csproj')) {
      buildTools.push({
        name: 'dotnet',
        configFile: '*.csproj',
        scripts: ['build', 'test', 'publish']
      });
    }

    return buildTools;
  }

  private async detectTestingFrameworks(): Promise<TestingFrameworkInfo[]> {
    const testingFrameworks: TestingFrameworkInfo[] = [];

    // JavaScript testing frameworks
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

    // Python testing frameworks
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

  private async detectDatabases(): Promise<DatabaseInfo[]> {
    const databases: DatabaseInfo[] = [];
    const indicators = new Set<string>();

    // Check package.json
    const packageJson = await this.readPackageJson();
    if (packageJson) {
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };

      if (allDeps.pg || allDeps['pg-promise']) indicators.add('postgresql');
      if (allDeps.mysql || allDeps.mysql2) indicators.add('mysql');
      if (allDeps.mongodb || allDeps.mongoose) indicators.add('mongodb');
      if (allDeps.redis) indicators.add('redis');
      if (allDeps.sqlite3) indicators.add('sqlite');
    }

    // Check Docker Compose
    const dockerCompose = await this.readDockerCompose();
    if (dockerCompose) {
      if (dockerCompose.includes('postgres')) indicators.add('postgresql');
      if (dockerCompose.includes('mysql')) indicators.add('mysql');
      if (dockerCompose.includes('mongo')) indicators.add('mongodb');
      if (dockerCompose.includes('redis')) indicators.add('redis');
    }

    // Check environment files
    const envFile = await this.readEnvFile();
    if (envFile) {
      if (envFile.includes('postgres')) indicators.add('postgresql');
      if (envFile.includes('mysql')) indicators.add('mysql');
      if (envFile.includes('mongodb')) indicators.add('mongodb');
      if (envFile.includes('redis')) indicators.add('redis');
    }

    // Convert indicators to database info
    for (const db of indicators) {
      databases.push({
        type: db as any,
        name: db,
        usage: db === 'redis' ? 'cache' : 'primary'
      });
    }

    return databases;
  }

  private async detectMessageQueues(): Promise<MessageQueueInfo[]> {
    const queues: MessageQueueInfo[] = [];
    const indicators = new Set<string>();

    // Check package.json
    const packageJson = await this.readPackageJson();
    if (packageJson) {
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };

      if (allDeps.amqplib || allDeps['amqp-connection-manager']) indicators.add('rabbitmq');
      if (allDeps.bull || allDeps.bullmq) indicators.add('redis');
      if (allDeps.kafkajs) indicators.add('kafka');
      if (allDeps['aws-sdk'] && allDeps['@aws-sdk/client-sqs']) indicators.add('sqs');
    }

    // Convert to message queue info
    for (const queue of indicators) {
      queues.push({
        type: queue as any,
        name: queue,
        topics: [],
        usage: queue === 'redis' ? 'job-queue' : 'event-streaming'
      });
    }

    return queues;
  }

  private async detectCaching(): Promise<any[]> {
    const caching: any[] = [];

    // Check for Redis
    const packageJson = await this.readPackageJson();
    if (packageJson?.dependencies?.redis || packageJson?.devDependencies?.redis) {
      caching.push({
        type: 'redis',
        name: 'Redis',
        usage: 'primary'
      });
    }

    // Check for Memcached
    if (packageJson?.dependencies?.memcached || packageJson?.devDependencies?.memcached) {
      caching.push({
        type: 'memcached',
        name: 'Memcached',
        usage: 'primary'
      });
    }

    return caching;
  }

  private async detectAuthentication(): Promise<any[]> {
    const auth: any[] = [];

    // Check for auth libraries
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

  private async detectDeployment(): Promise<any[]> {
    const deployment: any[] = [];

    // Check for deployment files
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

  // Helper methods

  private addPattern(language: string, pattern: FrameworkPattern): void {
    if (!this.patterns.has(language)) {
      this.patterns.set(language, []);
    }
    this.patterns.get(language)!.push(pattern);
  }

  private async getAllFiles(): Promise<string[]> {
    const walk = async (dir: string): Promise<string[]> => {
      const files: string[] = [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && 
            entry.name !== 'node_modules' && entry.name !== 'dist' && 
            entry.name !== 'build' && entry.name !== 'target') {
          files.push(...await walk(fullPath));
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
      
      return files;
    };

    return await walk(this.projectPath);
  }

  private async getSampleFiles(maxFiles: number = 20): Promise<string[]> {
    const allFiles = await this.getAllFiles();
    const codeFiles = allFiles.filter(f => {
      const ext = path.extname(f);
      return ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cs', '.go', '.rs', '.php', '.rb'].includes(ext);
    });
    return codeFiles.slice(0, maxFiles);
  }

  private async readFile(filePath: string): Promise<string> {
    if (this.fileCache.has(filePath)) {
      return this.fileCache.get(filePath)!;
    }
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.fileCache.set(filePath, content);
      return content;
    } catch {
      return '';
    }
  }

  private async fileExists(fileName: string): Promise<boolean> {
    try {
      if (fileName.includes('*')) {
        const files = await this.getAllFiles();
        const regex = new RegExp(fileName.replace(/\*/g, '.*'));
        return files.some(f => regex.test(path.basename(f)));
      }
      await fs.access(path.join(this.projectPath, fileName));
      return true;
    } catch {
      return false;
    }
  }

  private async directoryExists(dirName: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(this.projectPath, dirName));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async readPackageJson(): Promise<any> {
    const key = 'package.json';
    if (this.packageCache.has(key)) {
      return this.packageCache.get(key);
    }
    try {
      const content = await fs.readJson(path.join(this.projectPath, 'package.json'));
      this.packageCache.set(key, content);
      return content;
    } catch {
      return null;
    }
  }

  private async readRequirements(): Promise<string | null> {
    try {
      return await this.readFile(path.join(this.projectPath, 'requirements.txt'));
    } catch {
      return null;
    }
  }

  private async readGoMod(): Promise<string | null> {
    try {
      return await this.readFile(path.join(this.projectPath, 'go.mod'));
    } catch {
      return null;
    }
  }

  private async readCargoToml(): Promise<string | null> {
    try {
      return await this.readFile(path.join(this.projectPath, 'Cargo.toml'));
    } catch {
      return null;
    }
  }

  private async readDockerCompose(): Promise<string | null> {
    try {
      return await this.readFile(path.join(this.projectPath, 'docker-compose.yml'));
    } catch {
      try {
        return await this.readFile(path.join(this.projectPath, 'docker-compose.yaml'));
      } catch {
        return null;
      }
    }
  }

  private async readEnvFile(): Promise<string | null> {
    try {
      return await this.readFile(path.join(this.projectPath, '.env'));
    } catch {
      return null;
    }
  }
}
