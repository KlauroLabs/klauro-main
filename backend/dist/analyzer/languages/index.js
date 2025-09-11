"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANALYZER_METADATA = exports.FrameworkLanguageMap = exports.SUPPORTED_LANGUAGES = exports.LanguageAnalyzers = exports.PHPAnalyzer = exports.RustAnalyzer = exports.GoAnalyzer = exports.CSharpAnalyzer = exports.JavaAnalyzer = exports.TypeScriptJavaScriptAnalyzer = exports.PythonAnalyzer = void 0;
exports.getAnalyzerByLanguage = getAnalyzerByLanguage;
exports.getLanguageByFramework = getLanguageByFramework;
exports.isLanguageSupported = isLanguageSupported;
var python_analyzer_1 = require("./python-analyzer");
Object.defineProperty(exports, "PythonAnalyzer", { enumerable: true, get: function () { return python_analyzer_1.PythonAnalyzer; } });
var typescript_javascript_analyzer_1 = require("./typescript-javascript-analyzer");
Object.defineProperty(exports, "TypeScriptJavaScriptAnalyzer", { enumerable: true, get: function () { return typescript_javascript_analyzer_1.TypeScriptJavaScriptAnalyzer; } });
var java_analyzer_1 = require("./java-analyzer");
Object.defineProperty(exports, "JavaAnalyzer", { enumerable: true, get: function () { return java_analyzer_1.JavaAnalyzer; } });
var csharp_analyzer_1 = require("./csharp-analyzer");
Object.defineProperty(exports, "CSharpAnalyzer", { enumerable: true, get: function () { return csharp_analyzer_1.CSharpAnalyzer; } });
var go_analyzer_1 = require("./go-analyzer");
Object.defineProperty(exports, "GoAnalyzer", { enumerable: true, get: function () { return go_analyzer_1.GoAnalyzer; } });
var rust_analyzer_1 = require("./rust-analyzer");
Object.defineProperty(exports, "RustAnalyzer", { enumerable: true, get: function () { return rust_analyzer_1.RustAnalyzer; } });
var php_analyzer_1 = require("./php-analyzer");
Object.defineProperty(exports, "PHPAnalyzer", { enumerable: true, get: function () { return php_analyzer_1.PHPAnalyzer; } });
exports.LanguageAnalyzers = {
    python: 'PythonAnalyzer',
    javascript: 'TypeScriptJavaScriptAnalyzer',
    typescript: 'TypeScriptJavaScriptAnalyzer',
    java: 'JavaAnalyzer',
    kotlin: 'JavaAnalyzer',
    scala: 'JavaAnalyzer',
    csharp: 'CSharpAnalyzer',
    fsharp: 'CSharpAnalyzer',
    vb: 'CSharpAnalyzer',
    go: 'GoAnalyzer',
    rust: 'RustAnalyzer',
    php: 'PHPAnalyzer'
};
exports.SUPPORTED_LANGUAGES = Object.keys(exports.LanguageAnalyzers);
exports.FrameworkLanguageMap = {
    django: 'python',
    flask: 'python',
    fastapi: 'python',
    pyramid: 'python',
    tornado: 'python',
    react: 'javascript',
    vue: 'javascript',
    angular: 'typescript',
    express: 'javascript',
    nestjs: 'typescript',
    next: 'javascript',
    nuxt: 'javascript',
    'spring-boot': 'java',
    'spring-mvc': 'java',
    hibernate: 'java',
    'asp.net-core': 'csharp',
    'entity-framework': 'csharp',
    blazor: 'csharp',
    gin: 'go',
    echo: 'go',
    fiber: 'go',
    'actix-web': 'rust',
    rocket: 'rust',
    warp: 'rust',
    laravel: 'php',
    symfony: 'php',
    codeigniter: 'php',
    wordpress: 'php'
};
function getAnalyzerByLanguage(language) {
    return exports.LanguageAnalyzers[language.toLowerCase()];
}
function getLanguageByFramework(framework) {
    return exports.FrameworkLanguageMap[framework.toLowerCase()];
}
function isLanguageSupported(language) {
    return exports.SUPPORTED_LANGUAGES.includes(language.toLowerCase());
}
exports.ANALYZER_METADATA = [
    {
        name: 'PythonAnalyzer',
        languages: ['python'],
        frameworks: ['django', 'flask', 'fastapi', 'pyramid', 'tornado', 'bottle', 'celery', 'pytest'],
        priority: 90,
        category: 'language'
    },
    {
        name: 'TypeScriptJavaScriptAnalyzer',
        languages: ['javascript', 'typescript'],
        frameworks: ['react', 'vue', 'angular', 'express', 'nestjs', 'next', 'nuxt', 'svelte', 'gatsby'],
        priority: 90,
        category: 'language'
    },
    {
        name: 'JavaAnalyzer',
        languages: ['java', 'kotlin', 'scala'],
        frameworks: ['spring-boot', 'spring-mvc', 'hibernate', 'junit', 'maven', 'gradle'],
        priority: 90,
        category: 'language'
    },
    {
        name: 'CSharpAnalyzer',
        languages: ['csharp', 'fsharp', 'vb'],
        frameworks: ['asp.net-core', 'entity-framework', 'blazor', 'xamarin', 'maui', 'xunit', 'nunit'],
        priority: 90,
        category: 'language'
    },
    {
        name: 'GoAnalyzer',
        languages: ['go'],
        frameworks: ['gin', 'echo', 'fiber', 'beego', 'gorilla-mux', 'grpc', 'testify', 'gorm'],
        priority: 90,
        category: 'language'
    },
    {
        name: 'RustAnalyzer',
        languages: ['rust'],
        frameworks: ['actix-web', 'rocket', 'warp', 'axum', 'tokio', 'diesel', 'sqlx', 'serde'],
        priority: 90,
        category: 'language'
    },
    {
        name: 'PHPAnalyzer',
        languages: ['php'],
        frameworks: ['laravel', 'symfony', 'codeigniter', 'slim', 'wordpress', 'drupal', 'phpunit'],
        priority: 90,
        category: 'language'
    }
];
