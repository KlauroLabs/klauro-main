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
export { CloudFormationAnalyzer } from './cloudformation-analyzer';
export { SqlSchemaAnalyzer } from './sql-schema-analyzer';
export { CCppAnalyzer } from './c-cpp-analyzer';
export { KotlinAnalyzer } from './kotlin-analyzer';
export { SwiftAnalyzer } from './swift-analyzer';
export { SolidityAnalyzer } from './solidity-analyzer';
export { ElixirAnalyzer } from './elixir-analyzer';
export { ShellAnalyzer } from './shell-analyzer';
export { ProtobufAnalyzer } from './protobuf-analyzer';
export { SoapWsdlAnalyzer } from './soap-wsdl-analyzer';
export { CliAnalyzer } from './cli-analyzer';
export { CaddyAnalyzer, NginxAnalyzer, ApacheAnalyzer, HAProxyAnalyzer, TraefikAnalyzer } from './reverse-proxy-analyzer';

// Language analyzer mappings for easy lookup
export const LanguageAnalyzers = {
  python: 'PythonAnalyzer',
  javascript: 'TypeScriptJavaScriptAnalyzer',
  typescript: 'TypeScriptJavaScriptAnalyzer',
  java: 'JavaAnalyzer',
  // scala intentionally NOT mapped here: it used to point at JavaAnalyzer, which
  // only globs **/*.java — that made extensionToGrammar() (in
  // generic-tree-sitter-language-analyzer.ts) treat scala as deep-owned and exclude
  // it from the breadth walker, while JavaAnalyzer never picked it up either, so
  // .scala/.sc/.sbt produced ZERO nodes anywhere. Scala has its own
  // LANGUAGE_REGISTRY entry + LANGUAGE_SPECS grammar and is JVM-family-safe-ignore
  // aware (JVM_FAMILY_GRAMMAR_IDS in the breadth analyzer) — leaving it unmapped
  // here lets the generic tree-sitter walker own it for real.
  csharp: 'CSharpAnalyzer',
  // fsharp intentionally NOT mapped here: same defect class as scala above —
  // CSharpAnalyzer only globs **/*.cs, never **/*.fs/.fsi/.fsx, so mapping fsharp
  // to it as "deep-owned" excluded it from the breadth walker while never
  // analyzing it either (zero coverage). fsharp has its own registry entry +
  // LANGUAGE_SPECS grammar, so leaving it unmapped routes it to the breadth
  // walker instead.
  // vb is deliberately left deep-owned to CSharpAnalyzer below even though
  // CSharpAnalyzer never globs *.vb either (also zero coverage today): vb has NO
  // LANGUAGE_REGISTRY entry / tree-sitter grammar, so unmapping it would not
  // route it anywhere — it would just silently disappear from
  // SUPPORTED_LANGUAGES. Needs a real vb grammar before this can be fixed the
  // same way; tracked as a known gap, not fixed here.
  vb: 'CSharpAnalyzer',
  go: 'GoAnalyzer',
  rust: 'RustAnalyzer',
  php: 'PHPAnalyzer',
  ruby: 'RubyAnalyzer',
  dart: 'DartAnalyzer',
  terraform: 'TerraformAnalyzer',
  // hcl intentionally NOT mapped here: same defect class again — TerraformAnalyzer's
  // file walk only matches .tf/.tfvars/.tfplan (plus backend .conf), never
  // .hcl/.nomad, so mapping hcl to it as "deep-owned" excluded it from the breadth
  // walker while never analyzing it either (zero coverage). hcl has its own
  // registry entry + LANGUAGE_SPECS grammar, so leaving it unmapped routes it to
  // the breadth walker instead.
  cloudformation: 'CloudFormationAnalyzer',
  'sql-schema': 'SqlSchemaAnalyzer',
  c: 'CCppAnalyzer',
  cpp: 'CCppAnalyzer',
  kotlin: 'KotlinAnalyzer',
  swift: 'SwiftAnalyzer',
  solidity: 'SolidityAnalyzer',
  elixir: 'ElixirAnalyzer',
  shell: 'ShellAnalyzer',
  bash: 'ShellAnalyzer',
  protobuf: 'ProtobufAnalyzer',
  proto: 'ProtobufAnalyzer',
  wsdl: 'SoapWsdlAnalyzer',
  xsd: 'SoapWsdlAnalyzer'
} as const;

// Note: CliAnalyzer is a cross-language framework analyzer (Click/argparse/Typer,
// Commander/yargs/oclif, cobra/urfave-cli, clap, Thor) and is intentionally not
// keyed by a single language here — see ANALYZER_METADATA and cas-analyzer.service.ts.

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
    // 'scala' intentionally excluded — see the comment on LanguageAnalyzers above;
    // JavaAnalyzer never globbed *.scala, so scala routes to the generic
    // tree-sitter breadth walker instead of being falsely claimed here.
    languages: ['java'],
    frameworks: ['spring-boot', 'spring-mvc', 'hibernate', 'junit', 'maven', 'gradle'],
    priority: 90,
    category: 'language'
  },
  {
    name: 'CSharpAnalyzer',
    // 'fsharp' intentionally excluded — see the comment on LanguageAnalyzers above;
    // CSharpAnalyzer never globbed *.fs/.fsi/.fsx, so fsharp routes to the generic
    // tree-sitter breadth walker instead of being falsely claimed here. 'vb' stays
    // (no breadth grammar exists for it yet, so it remains a known zero-coverage gap).
    languages: ['csharp', 'vb'],
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
    // 'hcl' intentionally excluded — see the comment on LanguageAnalyzers above;
    // TerraformAnalyzer's file walk never matched *.hcl/.nomad, so hcl routes to
    // the generic tree-sitter breadth walker instead of being falsely claimed here.
    languages: ['terraform'],
    frameworks: ['terraform', 'opentofu'],
    priority: 85,
    category: 'language'
  },
  {
    name: 'CloudFormationAnalyzer',
    languages: ['cloudformation'],
    frameworks: ['aws-cloudformation'],
    priority: 85,
    category: 'language'
  },
  {
    // A CREATE TABLE is the strongest entity evidence a repo can offer, so this
    // runs at ORM-analyzer priority rather than as an afterthought: a raw-SQL
    // backend previously produced ZERO entities, which collapsed
    // capability<->flow linkage to 0/38 on a real repo.
    name: 'SqlSchemaAnalyzer',
    languages: ['sql'],
    frameworks: ['sql-ddl'],
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
  },
  {
    name: 'SoapWsdlAnalyzer',
    languages: ['wsdl', 'xsd'],
    frameworks: ['soap', 'wsdl', 'jax-ws', 'svcutil', 'savon', 'zeep'],
    priority: 85,
    category: 'language'
  },
  {
    name: 'CliAnalyzer',
    languages: ['python', 'javascript', 'typescript', 'go', 'rust', 'ruby'],
    frameworks: ['click', 'argparse', 'typer', 'commander', 'yargs', 'oclif', 'cobra', 'urfave-cli', 'clap', 'thor'],
    priority: 80,
    category: 'language'
  }
] as const;
