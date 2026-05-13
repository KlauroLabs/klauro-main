// Language Analyzers Index - Export all Phase 2 language base analyzers
// This file exports all production-ready language analyzers for the Unravl platform

export { PythonAnalyzer } from './python-analyzer';
export { TypeScriptJavaScriptAnalyzer } from './typescript-javascript-analyzer';
export { JavaAnalyzer } from './java-analyzer';
export { CSharpAnalyzer } from './csharp-analyzer';
export { GoAnalyzer } from './go-analyzer';
export { RustAnalyzer } from './rust-analyzer';
export { PHPAnalyzer } from './php-analyzer';
export { DartAnalyzer } from './dart-analyzer';

// Language analyzer mappings for easy lookup
export const LanguageAnalyzers = {
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
  php: 'PHPAnalyzer',
  dart: 'DartAnalyzer'
} as const;

// Supported languages list
export const SUPPORTED_LANGUAGES = Object.keys(LanguageAnalyzers);

// Framework to language mappings
export const FrameworkLanguageMap = {
  // Python frameworks
  django: 'python',
  flask: 'python',
  fastapi: 'python',
  pyramid: 'python',
  tornado: 'python',
  
  // JavaScript/TypeScript frameworks
  react: 'javascript',
  vue: 'javascript',
  angular: 'typescript',
  express: 'javascript',
  nestjs: 'typescript',
  next: 'javascript',
  nuxt: 'javascript',
  
  // Java frameworks
  'spring-boot': 'java',
  'spring-mvc': 'java',
  hibernate: 'java',
  
  // C# frameworks
  'asp.net-core': 'csharp',
  'entity-framework': 'csharp',
  blazor: 'csharp',
  
  // Go frameworks
  gin: 'go',
  echo: 'go',
  fiber: 'go',
  
  // Rust frameworks
  'actix-web': 'rust',
  rocket: 'rust',
  warp: 'rust',
  
  // PHP frameworks
  laravel: 'php',
  symfony: 'php',
  codeigniter: 'php',
  wordpress: 'php'
} as const;

// Get analyzer class name by language
export function getAnalyzerByLanguage(language: string): string | undefined {
  return LanguageAnalyzers[language.toLowerCase() as keyof typeof LanguageAnalyzers];
}

// Get language by framework
export function getLanguageByFramework(framework: string): string | undefined {
  return FrameworkLanguageMap[framework.toLowerCase() as keyof typeof FrameworkLanguageMap];
}

// Check if language is supported
export function isLanguageSupported(language: string): boolean {
  return SUPPORTED_LANGUAGES.includes(language.toLowerCase());
}

// Get all analyzers metadata for registration
export const ANALYZER_METADATA = [
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
  },
  {
    name: 'DartAnalyzer',
    languages: ['dart'],
    frameworks: ['flutter', 'dart'],
    priority: 90,
    category: 'language'
  }
] as const;
