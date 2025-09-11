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
exports.LanguageDetector = void 0;
const fs = __importStar(require("fs-extra"));
const path = __importStar(require("path"));
const errors_1 = require("./errors");
class LanguageDetector {
    constructor() {
        this.languageProfiles = new Map();
        this.extensionMap = new Map();
        this.frameworkMap = new Map();
        this.projectPath = '';
        this.fileCache = new Map();
        this.detectionCache = new Map();
        this.initializeProfiles();
        this.buildMaps();
    }
    async detectProject(projectPath) {
        this.projectPath = projectPath;
        this.fileCache.clear();
        this.detectionCache.clear();
        console.log(`🔍 Detecting languages and frameworks in: ${projectPath}`);
        const strategies = [
            this.detectByManifestFiles.bind(this),
            this.detectByFileExtensions.bind(this),
            this.detectByFileContent.bind(this),
            this.detectByProjectStructure.bind(this)
        ];
        const allSignals = [];
        const languageScores = new Map();
        const frameworkScores = new Map();
        const buildTools = [];
        for (const strategy of strategies) {
            try {
                const result = await strategy();
                allSignals.push(...result.signals);
                result.languages.forEach(lang => {
                    const current = languageScores.get(lang.name) || 0;
                    languageScores.set(lang.name, current + lang.confidence * lang.percentage);
                });
                result.frameworks.forEach(fw => {
                    const existing = frameworkScores.get(fw.name);
                    if (!existing || fw.confidence > existing.confidence) {
                        frameworkScores.set(fw.name, fw);
                    }
                });
                buildTools.push(...result.buildTools);
            }
            catch (error) {
                console.warn(`Detection strategy failed: ${error.message}`);
            }
        }
        const languages = this.rankLanguages(languageScores);
        const primary = languages[0] || this.createUnknownLanguage();
        const secondary = languages.slice(1);
        const frameworks = Array.from(frameworkScores.values())
            .sort((a, b) => b.confidence - a.confidence);
        const confidence = this.calculateOverallConfidence(primary, frameworks, allSignals);
        return {
            primary,
            secondary,
            frameworks,
            buildTools: this.deduplicateBuildTools(buildTools),
            confidence,
            strategy: 'multi-strategy',
            signals: allSignals
        };
    }
    async detectByManifestFiles() {
        const languages = [];
        const frameworks = [];
        const buildTools = [];
        const signals = [];
        const packageJsonPath = path.join(this.projectPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
            try {
                const packageJson = await fs.readJson(packageJsonPath);
                signals.push({
                    type: 'file',
                    source: 'package.json',
                    value: 'Node.js project',
                    weight: 10
                });
                const hasTypeScript = packageJson.devDependencies?.typescript ||
                    packageJson.dependencies?.typescript ||
                    await fs.pathExists(path.join(this.projectPath, 'tsconfig.json'));
                languages.push({
                    name: hasTypeScript ? 'TypeScript' : 'JavaScript',
                    confidence: 0.95,
                    fileCount: 0,
                    lineCount: 0,
                    percentage: 0,
                    ecosystem: 'npm'
                });
                const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
                const frameworkDetectors = {
                    'express': { name: 'Express', language: 'JavaScript', confidence: 0.9, type: 'web', signals: ['express'] },
                    '@nestjs/core': { name: 'NestJS', language: 'TypeScript', confidence: 0.95, type: 'web', signals: ['@nestjs/core'] },
                    'react': { name: 'React', language: 'JavaScript', confidence: 0.9, type: 'web', signals: ['react'] },
                    'vue': { name: 'Vue', language: 'JavaScript', confidence: 0.9, type: 'web', signals: ['vue'] },
                    '@angular/core': { name: 'Angular', language: 'TypeScript', confidence: 0.95, type: 'web', signals: ['@angular/core'] },
                    'next': { name: 'Next.js', language: 'JavaScript', confidence: 0.9, type: 'web', signals: ['next'] },
                    'nuxt': { name: 'Nuxt', language: 'JavaScript', confidence: 0.9, type: 'web', signals: ['nuxt'] },
                    'fastify': { name: 'Fastify', language: 'JavaScript', confidence: 0.85, type: 'web', signals: ['fastify'] },
                    'koa': { name: 'Koa', language: 'JavaScript', confidence: 0.85, type: 'web', signals: ['koa'] },
                    'electron': { name: 'Electron', language: 'JavaScript', confidence: 0.9, type: 'desktop', signals: ['electron'] },
                    'react-native': { name: 'React Native', language: 'JavaScript', confidence: 0.9, type: 'mobile', signals: ['react-native'] },
                    'jest': { name: 'Jest', language: 'JavaScript', confidence: 0.85, type: 'testing', signals: ['jest'] },
                    'mocha': { name: 'Mocha', language: 'JavaScript', confidence: 0.85, type: 'testing', signals: ['mocha'] }
                };
                for (const [dep, framework] of Object.entries(frameworkDetectors)) {
                    if (deps[dep]) {
                        frameworks.push({ ...framework, version: deps[dep] });
                        signals.push({
                            type: 'dependency',
                            source: 'package.json',
                            value: dep,
                            weight: 8
                        });
                    }
                }
                if (packageJson.scripts) {
                    buildTools.push({
                        name: 'npm',
                        version: packageJson.engines?.npm,
                        configFile: 'package.json',
                        commands: Object.keys(packageJson.scripts)
                    });
                }
            }
            catch (error) {
                console.warn('Failed to parse package.json:', error);
            }
        }
        const pythonFiles = ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'];
        for (const file of pythonFiles) {
            const filePath = path.join(this.projectPath, file);
            if (await fs.pathExists(filePath)) {
                signals.push({
                    type: 'file',
                    source: file,
                    value: 'Python project',
                    weight: 10
                });
                languages.push({
                    name: 'Python',
                    confidence: 0.95,
                    fileCount: 0,
                    lineCount: 0,
                    percentage: 0,
                    ecosystem: 'pip'
                });
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const pythonFrameworks = {
                        'django': { name: 'Django', language: 'Python', confidence: 0.9, type: 'web', signals: ['django'] },
                        'flask': { name: 'Flask', language: 'Python', confidence: 0.85, type: 'web', signals: ['flask'] },
                        'fastapi': { name: 'FastAPI', language: 'Python', confidence: 0.9, type: 'web', signals: ['fastapi'] },
                        'pyramid': { name: 'Pyramid', language: 'Python', confidence: 0.8, type: 'web', signals: ['pyramid'] },
                        'tornado': { name: 'Tornado', language: 'Python', confidence: 0.8, type: 'web', signals: ['tornado'] },
                        'pytest': { name: 'Pytest', language: 'Python', confidence: 0.85, type: 'testing', signals: ['pytest'] },
                        'scrapy': { name: 'Scrapy', language: 'Python', confidence: 0.85, type: 'library', signals: ['scrapy'] },
                        'pandas': { name: 'Pandas', language: 'Python', confidence: 0.8, type: 'library', signals: ['pandas'] },
                        'numpy': { name: 'NumPy', language: 'Python', confidence: 0.8, type: 'library', signals: ['numpy'] },
                        'tensorflow': { name: 'TensorFlow', language: 'Python', confidence: 0.85, type: 'library', signals: ['tensorflow'] },
                        'pytorch': { name: 'PyTorch', language: 'Python', confidence: 0.85, type: 'library', signals: ['torch'] }
                    };
                    for (const [dep, framework] of Object.entries(pythonFrameworks)) {
                        if (content.toLowerCase().includes(dep)) {
                            frameworks.push(framework);
                            signals.push({
                                type: 'dependency',
                                source: file,
                                value: dep,
                                weight: 8
                            });
                        }
                    }
                    if (file === 'setup.py') {
                        buildTools.push({
                            name: 'setuptools',
                            configFile: 'setup.py'
                        });
                    }
                    else if (file === 'Pipfile') {
                        buildTools.push({
                            name: 'pipenv',
                            configFile: 'Pipfile'
                        });
                    }
                }
                catch (error) {
                    console.warn(`Failed to parse ${file}:`, error);
                }
                break;
            }
        }
        const javaFiles = ['pom.xml', 'build.gradle', 'build.gradle.kts'];
        for (const file of javaFiles) {
            const filePath = path.join(this.projectPath, file);
            if (await fs.pathExists(filePath)) {
                signals.push({
                    type: 'file',
                    source: file,
                    value: 'Java project',
                    weight: 10
                });
                languages.push({
                    name: 'Java',
                    confidence: 0.95,
                    fileCount: 0,
                    lineCount: 0,
                    percentage: 0,
                    ecosystem: file.includes('pom') ? 'maven' : 'gradle'
                });
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const javaFrameworks = {
                        'spring-boot': { name: 'Spring Boot', language: 'Java', confidence: 0.95, type: 'web', signals: ['spring-boot'] },
                        'spring-framework': { name: 'Spring', language: 'Java', confidence: 0.9, type: 'web', signals: ['spring'] },
                        'hibernate': { name: 'Hibernate', language: 'Java', confidence: 0.85, type: 'library', signals: ['hibernate'] },
                        'junit': { name: 'JUnit', language: 'Java', confidence: 0.85, type: 'testing', signals: ['junit'] },
                        'android': { name: 'Android', language: 'Java', confidence: 0.9, type: 'mobile', signals: ['android'] }
                    };
                    for (const [dep, framework] of Object.entries(javaFrameworks)) {
                        if (content.includes(dep)) {
                            frameworks.push(framework);
                            signals.push({
                                type: 'dependency',
                                source: file,
                                value: dep,
                                weight: 8
                            });
                        }
                    }
                    buildTools.push({
                        name: file.includes('pom') ? 'Maven' : 'Gradle',
                        configFile: file
                    });
                }
                catch (error) {
                    console.warn(`Failed to parse ${file}:`, error);
                }
                break;
            }
        }
        const dotnetFiles = await this.findFiles(['*.csproj', '*.sln']);
        if (dotnetFiles.length > 0) {
            signals.push({
                type: 'file',
                source: path.basename(dotnetFiles[0]),
                value: '.NET project',
                weight: 10
            });
            languages.push({
                name: 'C#',
                confidence: 0.95,
                fileCount: 0,
                lineCount: 0,
                percentage: 0,
                ecosystem: 'nuget'
            });
            try {
                const content = await fs.readFile(dotnetFiles[0], 'utf-8');
                if (content.includes('Microsoft.AspNetCore')) {
                    frameworks.push({
                        name: 'ASP.NET Core',
                        language: 'C#',
                        confidence: 0.95,
                        type: 'web',
                        signals: ['Microsoft.AspNetCore']
                    });
                }
                if (content.includes('Microsoft.EntityFrameworkCore')) {
                    frameworks.push({
                        name: 'Entity Framework Core',
                        language: 'C#',
                        confidence: 0.9,
                        type: 'library',
                        signals: ['Microsoft.EntityFrameworkCore']
                    });
                }
                if (content.includes('Xamarin')) {
                    frameworks.push({
                        name: 'Xamarin',
                        language: 'C#',
                        confidence: 0.9,
                        type: 'mobile',
                        signals: ['Xamarin']
                    });
                }
                buildTools.push({
                    name: 'dotnet',
                    configFile: path.basename(dotnetFiles[0])
                });
            }
            catch (error) {
                console.warn('Failed to parse .NET project file:', error);
            }
        }
        const goModPath = path.join(this.projectPath, 'go.mod');
        if (await fs.pathExists(goModPath)) {
            signals.push({
                type: 'file',
                source: 'go.mod',
                value: 'Go project',
                weight: 10
            });
            languages.push({
                name: 'Go',
                confidence: 0.95,
                fileCount: 0,
                lineCount: 0,
                percentage: 0,
                ecosystem: 'go'
            });
            try {
                const content = await fs.readFile(goModPath, 'utf-8');
                const goFrameworks = {
                    'gin-gonic/gin': { name: 'Gin', language: 'Go', confidence: 0.9, type: 'web', signals: ['gin'] },
                    'labstack/echo': { name: 'Echo', language: 'Go', confidence: 0.9, type: 'web', signals: ['echo'] },
                    'gofiber/fiber': { name: 'Fiber', language: 'Go', confidence: 0.9, type: 'web', signals: ['fiber'] },
                    'gorilla/mux': { name: 'Gorilla Mux', language: 'Go', confidence: 0.85, type: 'web', signals: ['gorilla/mux'] },
                    'beego/beego': { name: 'Beego', language: 'Go', confidence: 0.85, type: 'web', signals: ['beego'] }
                };
                for (const [dep, framework] of Object.entries(goFrameworks)) {
                    if (content.includes(dep)) {
                        frameworks.push(framework);
                        signals.push({
                            type: 'dependency',
                            source: 'go.mod',
                            value: dep,
                            weight: 8
                        });
                    }
                }
                buildTools.push({
                    name: 'go',
                    configFile: 'go.mod'
                });
            }
            catch (error) {
                console.warn('Failed to parse go.mod:', error);
            }
        }
        const cargoTomlPath = path.join(this.projectPath, 'Cargo.toml');
        if (await fs.pathExists(cargoTomlPath)) {
            signals.push({
                type: 'file',
                source: 'Cargo.toml',
                value: 'Rust project',
                weight: 10
            });
            languages.push({
                name: 'Rust',
                confidence: 0.95,
                fileCount: 0,
                lineCount: 0,
                percentage: 0,
                ecosystem: 'cargo'
            });
            try {
                const content = await fs.readFile(cargoTomlPath, 'utf-8');
                const rustFrameworks = {
                    'actix-web': { name: 'Actix-web', language: 'Rust', confidence: 0.9, type: 'web', signals: ['actix-web'] },
                    'rocket': { name: 'Rocket', language: 'Rust', confidence: 0.9, type: 'web', signals: ['rocket'] },
                    'warp': { name: 'Warp', language: 'Rust', confidence: 0.85, type: 'web', signals: ['warp'] },
                    'axum': { name: 'Axum', language: 'Rust', confidence: 0.9, type: 'web', signals: ['axum'] },
                    'tokio': { name: 'Tokio', language: 'Rust', confidence: 0.85, type: 'library', signals: ['tokio'] }
                };
                for (const [dep, framework] of Object.entries(rustFrameworks)) {
                    if (content.includes(dep)) {
                        frameworks.push(framework);
                        signals.push({
                            type: 'dependency',
                            source: 'Cargo.toml',
                            value: dep,
                            weight: 8
                        });
                    }
                }
                buildTools.push({
                    name: 'cargo',
                    configFile: 'Cargo.toml'
                });
            }
            catch (error) {
                console.warn('Failed to parse Cargo.toml:', error);
            }
        }
        const composerJsonPath = path.join(this.projectPath, 'composer.json');
        if (await fs.pathExists(composerJsonPath)) {
            signals.push({
                type: 'file',
                source: 'composer.json',
                value: 'PHP project',
                weight: 10
            });
            languages.push({
                name: 'PHP',
                confidence: 0.95,
                fileCount: 0,
                lineCount: 0,
                percentage: 0,
                ecosystem: 'composer'
            });
            try {
                const composerJson = await fs.readJson(composerJsonPath);
                const deps = { ...composerJson.require, ...composerJson['require-dev'] };
                const phpFrameworks = {
                    'laravel/framework': { name: 'Laravel', language: 'PHP', confidence: 0.95, type: 'web', signals: ['laravel'] },
                    'symfony/symfony': { name: 'Symfony', language: 'PHP', confidence: 0.95, type: 'web', signals: ['symfony'] },
                    'codeigniter/framework': { name: 'CodeIgniter', language: 'PHP', confidence: 0.85, type: 'web', signals: ['codeigniter'] },
                    'slim/slim': { name: 'Slim', language: 'PHP', confidence: 0.85, type: 'web', signals: ['slim'] },
                    'wordpress/wordpress': { name: 'WordPress', language: 'PHP', confidence: 0.9, type: 'web', signals: ['wordpress'] }
                };
                for (const [dep, framework] of Object.entries(phpFrameworks)) {
                    if (deps[dep]) {
                        frameworks.push({ ...framework, version: deps[dep] });
                        signals.push({
                            type: 'dependency',
                            source: 'composer.json',
                            value: dep,
                            weight: 8
                        });
                    }
                }
                buildTools.push({
                    name: 'composer',
                    configFile: 'composer.json'
                });
            }
            catch (error) {
                console.warn('Failed to parse composer.json:', error);
            }
        }
        return { languages, frameworks, buildTools, signals };
    }
    async detectByFileExtensions() {
        const languages = new Map();
        const signals = [];
        const files = await this.findFiles(['**/*'], [
            'node_modules/**',
            'vendor/**',
            '.git/**',
            'dist/**',
            'build/**',
            'target/**'
        ]);
        const extensionCounts = new Map();
        const languageFiles = new Map();
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (ext) {
                extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);
                const langs = this.extensionMap.get(ext);
                if (langs) {
                    langs.forEach(lang => {
                        if (!languageFiles.has(lang)) {
                            languageFiles.set(lang, []);
                        }
                        languageFiles.get(lang).push(file);
                    });
                }
            }
        }
        const totalFiles = files.length;
        for (const [lang, files] of languageFiles) {
            const fileCount = files.length;
            const percentage = (fileCount / totalFiles) * 100;
            if (percentage > 1) {
                languages.set(lang, {
                    name: lang,
                    confidence: Math.min(percentage / 100, 0.8),
                    fileCount,
                    lineCount: 0,
                    percentage
                });
                signals.push({
                    type: 'file',
                    source: 'extensions',
                    value: `${lang}: ${fileCount} files`,
                    weight: Math.min(percentage / 10, 5)
                });
            }
        }
        return {
            languages: Array.from(languages.values()),
            frameworks: [],
            buildTools: [],
            signals
        };
    }
    async detectByFileContent() {
        const frameworks = [];
        const signals = [];
        const sampleFiles = await this.findFiles([
            '**/*.{js,ts,jsx,tsx,py,java,cs,go,rs,php,rb,swift,kt}',
            '**/main.*',
            '**/app.*',
            '**/index.*',
            '**/server.*'
        ], [
            'node_modules/**',
            'vendor/**',
            '.git/**'
        ]);
        for (const file of sampleFiles.slice(0, 20)) {
            try {
                const content = await this.readFile(file);
                for (const [lang, profile] of this.languageProfiles) {
                    for (const framework of profile.frameworks) {
                        let score = 0;
                        const matchedSignals = [];
                        for (const indicator of framework.indicators) {
                            if (indicator.type === 'import' || indicator.type === 'pattern') {
                                const pattern = indicator.value instanceof RegExp
                                    ? indicator.value
                                    : new RegExp(indicator.value.toString());
                                if (pattern.test(content)) {
                                    score += indicator.weight;
                                    matchedSignals.push(indicator.value.toString());
                                }
                            }
                        }
                        if (score > 5) {
                            const existing = frameworks.find(f => f.name === framework.name);
                            if (!existing || score > existing.confidence * 10) {
                                const confidence = Math.min(score / 20, 0.95);
                                frameworks.push({
                                    name: framework.name,
                                    language: lang,
                                    confidence,
                                    type: 'web',
                                    signals: matchedSignals
                                });
                                signals.push({
                                    type: 'content',
                                    source: file,
                                    value: framework.name,
                                    weight: confidence * 5
                                });
                            }
                        }
                    }
                }
            }
            catch (error) {
            }
        }
        return {
            languages: [],
            frameworks,
            buildTools: [],
            signals
        };
    }
    async detectByProjectStructure() {
        const frameworks = [];
        const signals = [];
        const structurePatterns = {
            'src/main/java': { framework: 'Java/Maven', language: 'Java', confidence: 0.9 },
            'src/main/kotlin': { framework: 'Kotlin', language: 'Kotlin', confidence: 0.9 },
            'src/app': { framework: 'Angular', language: 'TypeScript', confidence: 0.8 },
            'pages': { framework: 'Next.js', language: 'JavaScript', confidence: 0.7 },
            'app/controllers': { framework: 'Rails', language: 'Ruby', confidence: 0.8 },
            'app/models': { framework: 'MVC Framework', language: 'unknown', confidence: 0.6 },
            'lib': { framework: 'Library Project', language: 'unknown', confidence: 0.5 },
            'tests': { framework: 'Test Suite', language: 'unknown', confidence: 0.4 },
            'spec': { framework: 'RSpec/Jest', language: 'unknown', confidence: 0.5 },
            'Sources': { framework: 'Swift Package', language: 'Swift', confidence: 0.8 },
            'cmd': { framework: 'Go CLI', language: 'Go', confidence: 0.7 }
        };
        for (const [pattern, info] of Object.entries(structurePatterns)) {
            const exists = await fs.pathExists(path.join(this.projectPath, pattern));
            if (exists) {
                if (info.framework !== 'unknown') {
                    frameworks.push({
                        name: info.framework,
                        language: info.language,
                        confidence: info.confidence,
                        type: 'web',
                        signals: [pattern]
                    });
                }
                signals.push({
                    type: 'structure',
                    source: 'directory',
                    value: pattern,
                    weight: info.confidence * 5
                });
            }
        }
        return {
            languages: [],
            frameworks,
            buildTools: [],
            signals
        };
    }
    initializeProfiles() {
        this.languageProfiles.set('JavaScript', {
            name: 'JavaScript',
            extensions: ['.js', '.jsx', '.mjs', '.cjs'],
            keywords: ['const', 'let', 'var', 'function', 'async', 'await', 'class', 'import', 'export'],
            frameworks: [
                {
                    name: 'React',
                    indicators: [
                        { type: 'import', value: /from ['"]react['"]/, weight: 10 },
                        { type: 'pattern', value: /React\.Component/, weight: 8 },
                        { type: 'pattern', value: /useState|useEffect|useContext/, weight: 8 },
                        { type: 'file', value: 'package.json', weight: 2 }
                    ]
                },
                {
                    name: 'Express',
                    indicators: [
                        { type: 'import', value: /require\(['"]express['"]\)/, weight: 10 },
                        { type: 'pattern', value: /app\.(get|post|put|delete)\(/, weight: 8 },
                        { type: 'pattern', value: /express\(\)/, weight: 10 }
                    ]
                }
            ],
            packageManagers: [
                { name: 'npm', lockFile: 'package-lock.json', manifestFile: 'package.json', commands: ['npm'] },
                { name: 'yarn', lockFile: 'yarn.lock', manifestFile: 'package.json', commands: ['yarn'] },
                { name: 'pnpm', lockFile: 'pnpm-lock.yaml', manifestFile: 'package.json', commands: ['pnpm'] }
            ],
            patterns: [
                /module\.exports/,
                /require\(/,
                /console\.log/
            ]
        });
        this.languageProfiles.set('TypeScript', {
            name: 'TypeScript',
            extensions: ['.ts', '.tsx', '.d.ts'],
            keywords: ['interface', 'type', 'enum', 'namespace', 'declare', 'implements', 'extends'],
            frameworks: [
                {
                    name: 'NestJS',
                    indicators: [
                        { type: 'import', value: /@nestjs\//, weight: 10 },
                        { type: 'pattern', value: /@Controller|@Injectable|@Module/, weight: 10 },
                        { type: 'file', value: 'nest-cli.json', weight: 15 }
                    ]
                },
                {
                    name: 'Angular',
                    indicators: [
                        { type: 'import', value: /@angular\//, weight: 10 },
                        { type: 'pattern', value: /@Component|@Injectable|@NgModule/, weight: 10 },
                        { type: 'file', value: 'angular.json', weight: 15 }
                    ]
                }
            ],
            packageManagers: [],
            patterns: [
                /interface\s+\w+/,
                /type\s+\w+\s*=/,
                /:\s*(string|number|boolean|any)/
            ]
        });
        this.languageProfiles.set('Python', {
            name: 'Python',
            extensions: ['.py', '.pyw', '.pyx'],
            keywords: ['def', 'class', 'import', 'from', 'if', 'elif', 'else', 'try', 'except', 'lambda'],
            frameworks: [
                {
                    name: 'Django',
                    indicators: [
                        { type: 'import', value: /from django/, weight: 10 },
                        { type: 'file', value: 'manage.py', weight: 15 },
                        { type: 'pattern', value: /INSTALLED_APPS/, weight: 8 }
                    ]
                },
                {
                    name: 'Flask',
                    indicators: [
                        { type: 'import', value: /from flask/, weight: 10 },
                        { type: 'pattern', value: /@app\.route/, weight: 10 },
                        { type: 'pattern', value: /Flask\(__name__\)/, weight: 10 }
                    ]
                },
                {
                    name: 'FastAPI',
                    indicators: [
                        { type: 'import', value: /from fastapi/, weight: 10 },
                        { type: 'pattern', value: /FastAPI\(\)/, weight: 10 },
                        { type: 'pattern', value: /@app\.(get|post|put|delete)/, weight: 8 }
                    ]
                }
            ],
            packageManagers: [
                { name: 'pip', lockFile: 'requirements.txt', manifestFile: 'setup.py', commands: ['pip'] },
                { name: 'pipenv', lockFile: 'Pipfile.lock', manifestFile: 'Pipfile', commands: ['pipenv'] },
                { name: 'poetry', lockFile: 'poetry.lock', manifestFile: 'pyproject.toml', commands: ['poetry'] }
            ],
            patterns: [
                /def\s+\w+\(/,
                /class\s+\w+/,
                /if\s+__name__\s*==\s*['"]__main__['"]/
            ]
        });
    }
    buildMaps() {
        for (const [lang, profile] of this.languageProfiles) {
            for (const ext of profile.extensions) {
                if (!this.extensionMap.has(ext)) {
                    this.extensionMap.set(ext, []);
                }
                this.extensionMap.get(ext).push(lang);
            }
            this.frameworkMap.set(lang, profile.frameworks);
        }
    }
    rankLanguages(scores) {
        const totalScore = Array.from(scores.values()).reduce((sum, score) => sum + score, 0);
        return Array.from(scores.entries())
            .map(([name, score]) => ({
            name,
            confidence: Math.min(score / Math.max(totalScore, 1), 0.95),
            fileCount: 0,
            lineCount: 0,
            percentage: (score / Math.max(totalScore, 1)) * 100
        }))
            .sort((a, b) => b.confidence - a.confidence);
    }
    createUnknownLanguage() {
        return {
            name: 'Unknown',
            confidence: 0,
            fileCount: 0,
            lineCount: 0,
            percentage: 0
        };
    }
    calculateOverallConfidence(primary, frameworks, signals) {
        let confidence = primary.confidence * 0.5;
        if (frameworks.length > 0) {
            confidence += frameworks[0].confidence * 0.3;
        }
        const signalWeight = Math.min(signals.reduce((sum, s) => sum + s.weight, 0) / 100, 0.2);
        confidence += signalWeight;
        return Math.min(confidence, 0.95);
    }
    deduplicateBuildTools(tools) {
        const seen = new Set();
        return tools.filter(tool => {
            if (seen.has(tool.name)) {
                return false;
            }
            seen.add(tool.name);
            return true;
        });
    }
    async findFiles(patterns, excludePatterns = []) {
        const { glob } = await Promise.resolve().then(() => __importStar(require('glob')));
        const allFiles = [];
        for (const pattern of patterns) {
            const files = await glob(pattern, {
                cwd: this.projectPath,
                ignore: excludePatterns,
                absolute: true
            });
            allFiles.push(...files);
        }
        return [...new Set(allFiles)];
    }
    async readFile(filePath) {
        if (this.fileCache.has(filePath)) {
            return this.fileCache.get(filePath);
        }
        const content = await fs.readFile(filePath, 'utf-8');
        this.fileCache.set(filePath, content);
        return content;
    }
    async routeToAnalyzer(projectPath) {
        const detection = await this.detectProject(projectPath);
        if (detection.confidence < 0.3) {
            throw new errors_1.LanguageDetectionError('Could not detect project language with sufficient confidence', { detection });
        }
        const language = detection.primary.name.toLowerCase();
        const framework = detection.frameworks[0]?.name.toLowerCase();
        if (language === 'typescript' || language === 'javascript') {
            if (framework === 'nestjs') {
                return 'nestjs-analyzer';
            }
            else if (framework === 'react' || framework === 'vue' || framework === 'angular') {
                return 'frontend-analyzer';
            }
            else {
                return 'javascript-analyzer';
            }
        }
        else if (language === 'python') {
            if (framework === 'django') {
                return 'django-analyzer';
            }
            else if (framework === 'fastapi' || framework === 'flask') {
                return 'python-web-analyzer';
            }
            else {
                return 'python-analyzer';
            }
        }
        else if (language === 'java') {
            if (framework === 'spring boot' || framework === 'spring') {
                return 'spring-analyzer';
            }
            else {
                return 'java-analyzer';
            }
        }
        else if (language === 'c#') {
            return 'dotnet-analyzer';
        }
        else if (language === 'go') {
            return 'go-analyzer';
        }
        else if (language === 'rust') {
            return 'rust-analyzer';
        }
        else if (language === 'php') {
            if (framework === 'laravel') {
                return 'laravel-analyzer';
            }
            else {
                return 'php-analyzer';
            }
        }
        return 'generic-analyzer';
    }
}
exports.LanguageDetector = LanguageDetector;
