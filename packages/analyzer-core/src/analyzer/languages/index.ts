// Language Analyzers Index - Export all Phase 2 language base analyzers
// This file exports all production-ready language analyzers for the Klauro platform

export { PythonAnalyzer } from './python-analyzer';
export { TypeScriptJavaScriptAnalyzer } from './typescript-javascript-analyzer';
export { JavaAnalyzer } from './java-analyzer';
export { CSharpAnalyzer } from './csharp-analyzer';
export { GoAnalyzer } from './go-analyzer';
export { RustAnalyzer } from './rust-analyzer';
export { PHPAnalyzer } from './php-analyzer';
export { RubyAnalyzer } from './ruby-analyzer';
export { DartAnalyzer } from './dart-analyzer';
export { TerraformAnalyzer } from './terraform-analyzer';
export { CCppAnalyzer } from './c-cpp-analyzer';
export { KotlinAnalyzer } from './kotlin-analyzer';
export { SwiftAnalyzer } from './swift-analyzer';
export { SolidityAnalyzer } from './solidity-analyzer';
export { ElixirAnalyzer } from './elixir-analyzer';
export { ShellAnalyzer } from './shell-analyzer';
export { ProtobufAnalyzer } from './protobuf-analyzer';

// Language analyzer mappings for easy lookup
export const LanguageAnalyzers = {
  python: 'PythonAnalyzer',
  javascript: 'TypeScriptJavaScriptAnalyzer',
  typescript: 'TypeScriptJavaScriptAnalyzer',
  java: 'JavaAnalyzer',
  scala: 'JavaAnalyzer',
  csharp: 'CSharpAnalyzer',
  fsharp: 'CSharpAnalyzer',
  vb: 'CSharpAnalyzer',
  go: 'GoAnalyzer',
  rust: 'RustAnalyzer',
  php: 'PHPAnalyzer',
  ruby: 'RubyAnalyzer',
  dart: 'DartAnalyzer',
  terraform: 'TerraformAnalyzer',
  hcl: 'TerraformAnalyzer',
  c: 'CCppAnalyzer',
  cpp: 'CCppAnalyzer',
  kotlin: 'KotlinAnalyzer',
  swift: 'SwiftAnalyzer',
  solidity: 'SolidityAnalyzer',
  elixir: 'ElixirAnalyzer',
  shell: 'ShellAnalyzer',
  bash: 'ShellAnalyzer',
  protobuf: 'ProtobufAnalyzer',
  proto: 'ProtobufAnalyzer'
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
  
  // Ruby frameworks
  rails: 'ruby',
  sinatra: 'ruby',

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
    languages: ['java', 'scala'],
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
    name: 'RubyAnalyzer',
    languages: ['ruby'],
    frameworks: ['rails', 'sinatra', 'sidekiq', 'rspec', 'minitest'],
    priority: 90,
    category: 'language'
  },
  {
    name: 'DartAnalyzer',
    languages: ['dart'],
    frameworks: ['flutter', 'dart'],
    priority: 90,
    category: 'language'
  },
  {
    name: 'TerraformAnalyzer',
    languages: ['terraform', 'hcl'],
    frameworks: ['terraform', 'opentofu'],
    priority: 85,
    category: 'language'
  },
  {
    name: 'CCppAnalyzer',
    languages: ['c', 'cpp'],
    frameworks: ['cmake', 'make', 'native'],
    priority: 90,
    category: 'language'
  },
  {
    name: 'KotlinAnalyzer',
    languages: ['kotlin'],
    frameworks: ['ktor', 'android', 'gradle'],
    priority: 90,
    category: 'language'
  },
  {
    name: 'SwiftAnalyzer',
    languages: ['swift'],
    frameworks: ['swiftui', 'vapor', 'spm'],
    priority: 90,
    category: 'language'
  },
  {
    name: 'SolidityAnalyzer',
    languages: ['solidity'],
    frameworks: ['hardhat', 'foundry', 'truffle'],
    priority: 90,
    category: 'language'
  },
  {
    name: 'ElixirAnalyzer',
    languages: ['elixir'],
    frameworks: ['phoenix', 'ecto', 'otp'],
    priority: 90,
    category: 'language'
  },
  {
    name: 'ShellAnalyzer',
    languages: ['shell', 'bash', 'zsh'],
    frameworks: ['shell'],
    priority: 80,
    category: 'language'
  },
  {
    name: 'ProtobufAnalyzer',
    languages: ['protobuf', 'proto'],
    frameworks: ['grpc', 'buf'],
    priority: 85,
    category: 'language'
  }
] as const;
