


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
export { JsonFileStoreAnalyzer } from './json-file-store-analyzer';
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


export const LanguageAnalyzers = {
  python: 'PythonAnalyzer',
  javascript: 'TypeScriptJavaScriptAnalyzer',
  typescript: 'TypeScriptJavaScriptAnalyzer',
  java: 'JavaAnalyzer',








  csharp: 'CSharpAnalyzer',












  vb: 'CSharpAnalyzer',
  go: 'GoAnalyzer',
  rust: 'RustAnalyzer',
  php: 'PHPAnalyzer',
  ruby: 'RubyAnalyzer',
  dart: 'DartAnalyzer',
  terraform: 'TerraformAnalyzer',






  cloudformation: 'CloudFormationAnalyzer',









  sql: 'SqlSchemaAnalyzer',
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






export const SUPPORTED_LANGUAGES = Object.keys(LanguageAnalyzers);


export const FrameworkLanguageMap = {

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


  rails: 'ruby',
  sinatra: 'ruby',


  laravel: 'php',
  symfony: 'php',
  codeigniter: 'php',
  wordpress: 'php'
} as const;


export function getAnalyzerByLanguage(language: string): string | undefined {
  return LanguageAnalyzers[language.toLowerCase() as keyof typeof LanguageAnalyzers];
}


export function getLanguageByFramework(framework: string): string | undefined {
  return FrameworkLanguageMap[framework.toLowerCase() as keyof typeof FrameworkLanguageMap];
}


export function isLanguageSupported(language: string): boolean {
  return SUPPORTED_LANGUAGES.includes(language.toLowerCase());
}


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



    languages: ['java'],
    frameworks: ['spring-boot', 'spring-mvc', 'hibernate', 'junit', 'maven', 'gradle'],
    priority: 90,
    category: 'language'
  },
  {
    name: 'CSharpAnalyzer',




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




    name: 'SqlSchemaAnalyzer',
    languages: ['sql'],
    frameworks: ['sql-ddl'],
    priority: 85,
    category: 'language'
  },
  {






    name: 'JsonFileStoreAnalyzer',
    languages: ['javascript', 'typescript'],
    frameworks: ['json-file-store'],
    priority: 40,
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
