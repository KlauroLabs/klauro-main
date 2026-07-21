import { AnalyzerOrchestrator } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import type { CASOutput, IncrementalState, ChangeReport, ChangeHistoryEntry } from '../../../packages/analyzer-core/src/types/cas.types';
import { TypeScriptJavaScriptAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/typescript-javascript-analyzer';
import { PythonAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/python-analyzer';
import { JavaAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/java-analyzer';
import { CSharpAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/csharp-analyzer';
import { GoAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/go-analyzer';
import { RustAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/rust-analyzer';
import { PHPAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/php-analyzer';
import { RubyAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/ruby-analyzer';
import { ShellAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/shell-analyzer';
import { CliAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/cli-analyzer';
import { SolidityAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/solidity-analyzer';
import { CCppAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/c-cpp-analyzer';
import { SwiftAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/swift-analyzer';
import { KotlinAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/kotlin-analyzer';
import { ElixirAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/elixir-analyzer';
import { DartAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/dart-analyzer';
import { TerraformAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/terraform-analyzer';
import { CloudFormationAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/cloudformation-analyzer';
import { DockerComposeAnalyzer, DockerfileAnalyzer, KubernetesManifestAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/container-topology-analyzer';
import { AnsibleAnalyzer, PulumiAnalyzer, HelmAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/iac-analyzer';
import { CaddyAnalyzer, NginxAnalyzer, ApacheAnalyzer, HAProxyAnalyzer, TraefikAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/reverse-proxy-analyzer';
import { DistributionArtifactAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/distribution-artifact-analyzer';
import { GenericTreeSitterLanguageAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/generic-tree-sitter-language-analyzer';
import {
  NestJSAnalyzer,
  SpringBootAnalyzer,
  DjangoAnalyzer,
  FlaskAnalyzer,
  FastAPIAnalyzer,
  AiohttpAnalyzer,
  SanicAnalyzer,
  TornadoAnalyzer,
  StarletteAnalyzer,
  ExpressAnalyzer,
  FastifyAnalyzer,
  NodeHttpAnalyzer,
  ReactAnalyzer,
  VueAnalyzer,
  AngularAnalyzer,
  LaravelAnalyzer,
  SymfonyAnalyzer,
  RailsAnalyzer,
  NextJSAnalyzer,
  SinatraAnalyzer,
  SlimAnalyzer,
} from '../../../packages/analyzer-core/src/analyzer/frameworks/web';
import { CronAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/cron-analyzer';
import { JestAnalyzer, CypressAnalyzer, TestFrameworkAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/testing';
import { AirflowAnalyzer, DagsterAnalyzer, PrefectAnalyzer, LuigiAnalyzer, JupyterNotebookAnalyzer, MLTrainingAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/dataml';
import { CiPipelineAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/ci';
import { WPFAnalyzer, AspNetCoreAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/dotnet';
import { ActixAnalyzer, RocketAnalyzer, AxumAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/rust';
import { GinAnalyzer, EchoAnalyzer, FiberAnalyzer, ChiAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/go';
import { WarpAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/rust/warp-analyzer';
import { TonicAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/rust/tonic-analyzer';
import { DrogonAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/cpp/drogon-analyzer';
import { CrowAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/cpp/crow-analyzer';
import { VaporAnalyzer, SwiftPlatformAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/swift';
import { GoRouterAnalyzer, ShelfAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/dart';
import { Http4sAnalyzer, PlayAnalyzer, AkkaHttpAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/scala';
import { KemalAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/crystal';
import { GenieAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/julia';
import { CompojureAnalyzer, ReititAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/clojure';
import { DreamAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/ocaml';
import { ApexRestAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/apex';
import { MojoliciousAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/perl';
import { SvelteAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/web/svelte-analyzer';
import { AstroAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/javascript/astro-analyzer';
import { HonoAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/javascript/hono-analyzer';
import { AnchorAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/rust/anchor-analyzer';
import { PhoenixAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/elixir/phoenix-analyzer';
import { NuxtAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/web/nuxt-analyzer';
import { RemixAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/web/remix-analyzer';
import { ReactNativeAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/web/react-native-analyzer';
import { KtorAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/kotlin/ktor-analyzer';
import { ComposeAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/kotlin/compose-analyzer';
import { SoliditySecurityAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/solidity/security-analyzer';
import { WordPressAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/php/wordpress-analyzer';
import { BlazorAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/dotnet/blazor-analyzer';
import { UnityAnalyzer, UnrealAnalyzer, GodotAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/game';
import { EmbeddedCAnalyzer, ArduinoAnalyzer, LinuxKernelModuleAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/embedded';
import { QuarkusAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/java/quarkus-analyzer';
import { MicronautAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/java/micronaut-analyzer';
import { JaxRsAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/java/jaxrs-analyzer';
import { VertxAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/java/vertx-analyzer';
import { SolidStartAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/web/solidstart-analyzer';
import { QwikAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/web/qwik-analyzer';
import { OpenAPIAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/openapi-analyzer';
import { EFCoreAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/efcore-analyzer';
import { ElectronAnalyzer, TauriAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/desktop';
import {
  PrismaAnalyzer,
  SocketIOAnalyzer,
  ReactRouterAnalyzer,
  ReduxAnalyzer,
  ZustandAnalyzer,
  TanStackQueryAnalyzer,
  ReactiveStreamsAnalyzer,
  FrontendStateAnalyzer,
  ReqwestAnalyzer,
  OutboundHttpClientAnalyzer,
  ValidationSchemaAnalyzer,
  architectureLibraryAnalyzerDefinitions,
  McpToolRegistrationAnalyzer,
  AuthAnalyzer
} from '../../../packages/analyzer-core/src/analyzer/libraries';
import { MessagingAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/messaging';
import { ObservabilityAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/observability';
import { TRPCAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/trpc-analyzer';
import { GraphQLAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/graphql-analyzer';
import { GrpcHandlerAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/api';
import { AIStackAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/ai-stack-analyzer';
import { WorkflowAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/workflow-analyzer';
import { MediatorCqrsAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/mediator-cqrs-analyzer';
import { SQLAlchemyPydanticAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/sqlalchemy-pydantic-analyzer';
import { DiContainerBindingAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/architecture/di-container-analyzer';
import { MockingLibraryAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/testing';
import {
  DrizzleAnalyzer,
  TypeORMAnalyzer,
  MongooseAnalyzer,
  SequelizeAnalyzer,
  KnexAnalyzer,
  ObjectionAnalyzer,
  DieselAnalyzer,
  SeaOrmAnalyzer,
  GormAnalyzer,
  SqlxAnalyzer,
  EntAnalyzer,
  DapperAnalyzer,
  DoctrineAnalyzer,
} from '../../../packages/analyzer-core/src/analyzer/libraries/orm';
import { ProtobufAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/protobuf-analyzer';
import { SoapWsdlAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/soap-wsdl-analyzer';
import type { AnalyzerRegistration } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import { PackAnalyzer } from '../../../packages/analyzer-core/src/analyzer/packs';
import * as fs from 'fs-extra';
import * as nodeFs from 'fs';
import * as path from 'path';
import { fork, type ChildProcess } from 'child_process';
import {
  getAnalysisRunLogPath,
  readRecentRunRecords,
  type AnalysisRunFinalRecord,
  type AnalysisRunRecord,
  type AnalysisRunStartRecord,
} from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { resolveAnalysisHeapMb, type AnalysisHeapResolution } from './analysis-heap';
import { backfillIngestedTelemetry } from './telemetry-ingestion';
import {
  assertAnalysisVersionSupported,
  getAnalysisVersionInfo,
  saveAnalysis,
  loadAnalysis,
  saveIncrementalState,
  loadIncrementalState,
  saveChangeHistoryEntry,
  saveAnalysisSnapshot,
  listAnalysisSnapshots,
  saveFileCache,
  loadFileCache,
  getProjectStorageDir,
  withProjectAnalysisLock,
  withProjectAnalysisLockIfAvailable,
  writeJsonAtomic
} from './storage';
import { loadKlauroConfig, validateEmbeddingConfig, validateConventions, type KlauroConventions } from './klauro-config';
import { clearFreshnessSummaryCache } from './freshness';
import { createEmbeddingProvider } from '../../../packages/analyzer-core/src/analyzer/embedding/embedding-provider-factory';
import { createVectorStore } from '../../../packages/analyzer-core/src/analyzer/embedding/vector-store-factory';
import type { VectorStoreSetting } from '../../../packages/analyzer-core/src/analyzer/embedding/vector-store-factory';
import type { VectorStore } from '../../../packages/analyzer-core/src/analyzer/embedding/types';
import type { EmbeddingPhaseConfig } from '../../../packages/analyzer-core/src/analyzer/embedding/embedding-phase';
import { getPgPool, resolvePgConnectionString } from './pg-pool';
import { applyStoredElementDescriptions, validateDescription } from './description-enrichment';
import { isLanguageBuiltinName } from '../../../packages/analyzer-core/src/analyzer/core/language-builtins';

let orchestrator: AnalyzerOrchestrator | null = null;

export function createOrchestrator(): AnalyzerOrchestrator {
  const created = new AnalyzerOrchestrator();

  const languageRegistrations: AnalyzerRegistration[] = [
    {
      id: 'typescript-javascript',
      name: 'TypeScript/JavaScript Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['package.json', 'tsconfig.json', 'jsconfig.json'],
        content: [/\.ts$/, /\.js$/, /\.tsx$/, /\.jsx$/],
      },
      analyzer: new TypeScriptJavaScriptAnalyzer(),
    },
    {
      id: 'python',
      name: 'Python Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'],
        content: [/\.py$/],
      },
      analyzer: new PythonAnalyzer(),
    },
    {
      id: 'java',
      name: 'Java Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
        content: [/\.java$/],
      },
      analyzer: new JavaAnalyzer(),
    },
    {
      id: 'csharp',
      name: 'C# Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['*.csproj', '*.sln'],
        content: [/\.cs$/],
      },
      analyzer: new CSharpAnalyzer(),
    },
    {
      id: 'go',
      name: 'Go Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['go.mod', 'go.sum'],
        content: [/\.go$/],
      },
      analyzer: new GoAnalyzer(),
    },
    {
      id: 'rust',
      name: 'Rust Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Cargo.toml', 'Cargo.lock'],
        content: [/\.rs$/],
      },
      analyzer: new RustAnalyzer(),
    },
    {
      id: 'php',
      name: 'PHP Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['composer.json', 'composer.lock'],
        content: [/\.php$/],
      },
      analyzer: new PHPAnalyzer(),
    },
    {
      id: 'ruby',
      name: 'Ruby Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Gemfile', 'Gemfile.lock', 'Rakefile'],
        content: [/\.rb$/],
      },
      analyzer: new RubyAnalyzer(),
    },
    {
      id: 'shell',
      name: 'Shell/Bash Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.(sh|bash|zsh|ksh)$/],
      },
      analyzer: new ShellAnalyzer(),
    },
    {
      id: 'solidity',
      name: 'Solidity Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.sol$/],
      },
      analyzer: new SolidityAnalyzer(),
    },
    {
      id: 'c-cpp',
      name: 'C/C++ Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.(c|h|cpp|cc|cxx|hpp|hh|hxx)$/i],
      },
      analyzer: new CCppAnalyzer(),
    },
    {
      id: 'swift',
      name: 'Swift Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Package.swift'],
        content: [/\.swift$/],
      },
      analyzer: new SwiftAnalyzer(),
    },
    {
      id: 'kotlin',
      name: 'Kotlin Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.(kt|kts)$/],
      },
      analyzer: new KotlinAnalyzer(),
    },
    {
      id: 'elixir',
      name: 'Elixir Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['mix.exs'],
        content: [/\.(ex|exs)$/],
      },
      analyzer: new ElixirAnalyzer(),
    },
    {
      id: 'protobuf',
      name: 'Protobuf/gRPC Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.proto$/],
      },
      analyzer: new ProtobufAnalyzer(),
    },
    {
      id: 'soap-wsdl',
      name: 'SOAP/WSDL Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.wsdl$/i, /\.xsd$/i, /from\s+['"](?:soap|strong-soap)['"]/, /import\s+(?:zeep|suds)\b/, /@(WebServiceClient|WebService)\b/, /System\.ServiceModel/, /Savon\.client\b/],
      },
      analyzer: new SoapWsdlAnalyzer(),
    },
    {
      id: 'dart',
      name: 'Dart/Flutter Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['pubspec.yaml'],
        content: [/\.dart$/],
      },
      analyzer: new DartAnalyzer(),
    },
    {
      id: 'terraform',
      name: 'Terraform/HCL Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['*.tf', '*.tfvars'],
        content: [/\.tf$/, /\.tfvars$/],
      },
      analyzer: new TerraformAnalyzer(),
    },
    {
      id: 'cloudformation',
      name: 'CloudFormation Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/*.template', '**/*.yaml', '**/*.yml', '**/*.json'],
        content: [/AWSTemplateFormatVersion/, /Resources:\s*[\s\S]*Type:\s*AWS::/, /"Resources"\s*:\s*\{[\s\S]*"Type"\s*:\s*"AWS::/],
      },
      analyzer: new CloudFormationAnalyzer(),
    },
    {
      id: 'dockerfile',
      name: 'Dockerfile Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Dockerfile', 'Dockerfile.*', '*.Dockerfile'],
        content: [/^FROM\s+/m],
      },
      analyzer: new DockerfileAnalyzer(),
    },
    {
      id: 'docker-compose',
      name: 'Docker Compose Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml', 'docker-compose.*.yml', 'docker-compose.*.yaml'],
        content: [/^services:\s*$/m],
      },
      analyzer: new DockerComposeAnalyzer(),
    },
    {
      id: 'kubernetes-manifest',
      name: 'Kubernetes Manifest Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['k8s/**/*.yaml', 'k8s/**/*.yml', 'kubernetes/**/*.yaml', 'kubernetes/**/*.yml', 'deploy/**/*.yaml', 'deploy/**/*.yml'],
        content: [/^apiVersion:\s+/m, /^kind:\s+(Deployment|Service|Ingress|StatefulSet|Job|CronJob|ConfigMap|Secret)/m],
      },
      analyzer: new KubernetesManifestAnalyzer(),
    },
    {
      id: 'ansible',
      name: 'Ansible Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/playbook*.yml', '**/playbook*.yaml', '**/site.yml', '**/site.yaml', '**/roles/*/tasks/*.yml', '**/roles/*/tasks/*.yaml', '**/ansible.cfg'],
        content: [/^\s*-\s*hosts:\s*/m],
      },
      analyzer: new AnsibleAnalyzer(),
    },
    {
      id: 'pulumi',
      name: 'Pulumi Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/Pulumi.yaml', '**/Pulumi.yml'],
        content: [/^runtime:\s*(nodejs|python|go|dotnet)/m],
      },
      analyzer: new PulumiAnalyzer(),
    },
    {
      id: 'helm',
      name: 'Helm Chart Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/Chart.yaml', '**/Chart.yml'],
        content: [/^apiVersion:\s*v[12]\s*$/m],
      },
      analyzer: new HelmAnalyzer(),
    },
    {
      id: 'caddy',
      name: 'Caddy Reverse Proxy Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Caddyfile', '**/Caddyfile', '*.Caddyfile', '**/*.Caddyfile'],
        content: [/^\s*reverse_proxy\s+/m, /^\s*file_server\b/m, /^\s*handle(_path)?\s+/m],
      },
      analyzer: new CaddyAnalyzer(),
    },
    {
      id: 'nginx',
      name: 'Nginx Reverse Proxy Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['nginx.conf', '**/nginx.conf', '**/sites-available/*', '**/sites-enabled/*', '**/conf.d/*.conf'],
        content: [/^\s*(server|upstream|location)\b[^;]*\{/m, /\bproxy_pass\s+/m],
      },
      analyzer: new NginxAnalyzer(),
    },
    {
      id: 'apache-httpd',
      name: 'Apache HTTP Server Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['httpd.conf', 'apache2.conf', '**/httpd.conf', '**/apache2.conf', '**/sites-available/*.conf', '**/.htaccess'],
        content: [/<VirtualHost\b/i, /^\s*ProxyPass\b/im, /^\s*RewriteRule\b/im],
      },
      analyzer: new ApacheAnalyzer(),
    },
    {
      id: 'haproxy',
      name: 'HAProxy Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['haproxy.cfg', '**/haproxy.cfg', '**/haproxy/*.cfg'],
        content: [/^\s*(frontend|backend|listen)\s+/m, /^\s*(use_backend|default_backend)\s+/m],
      },
      analyzer: new HAProxyAnalyzer(),
    },
    {
      id: 'traefik',
      name: 'Traefik Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['traefik.yml', 'traefik.yaml', '**/traefik.yml', '**/traefik.yaml', '**/traefik/*.yml', '**/traefik/*.yaml', '**/dynamic/*.yml', '**/dynamic/*.yaml'],
        content: [/\brouters:\s*$/m, /\bloadBalancer:\s*$/m, /\brule:\s*.*(Host|PathPrefix)\(/m],
      },
      analyzer: new TraefikAnalyzer(),
    },
    {
      id: 'distribution-artifacts',
      name: 'Distribution Artifact Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['*.sh', '*.bash', '*.zsh', '*.ps1', '*.psm1', '*.bat', '*.cmd', '*.nsi', '*.wxs', '*.desktop', '*.service'],
        content: [/systemctl|launchctl|makensis|msiexec|pkgbuild|create-dmg|SERVICE_NAME|BINARY_NAME|DOWNLOAD_PREFIX|manifest\.json/i],
      },
      analyzer: new DistributionArtifactAnalyzer(),
    },
    {
      id: 'cli-frameworks',
      name: 'CLI/Script Entry Point Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/*.py', '**/*.ts', '**/*.js', '**/*.go', '**/*.rs', '**/*.rb'],
        content: [
          /@click\.(command|group)\b/, /argparse\.ArgumentParser\s*\(/, /\btyper\.Typer\s*\(/,
          /require\(\s*['"]commander['"]\s*\)|from\s+['"]commander['"]/,
          /require\(\s*['"]yargs['"]\s*\)|from\s+['"]yargs['"]/,
          /from\s+['"]@oclif\/core['"]/,
          /cobra\.Command\b/, /["']github\.com\/urfave\/cli(\/v2)?["']/,
          /\bclap::/,
          /class\s+\w+\s*<\s*Thor\b/,
        ],
      },
      analyzer: new CliAnalyzer(),
    },
    {
      // Breadth fallback: any grammar-backed language without a deep analyzer
      // (zig, haskell, lua, ocaml, erlang, clojure, julia, nim, fortran, …).
      // Detection is via canAnalyze, which covers ~130 registered extensions.
      id: 'generic-tree-sitter',
      name: 'Generic Tree-sitter Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        content: [/\.(zig|hs|lua|ml|erl|ex|exs|clj|jl|nim|f90|ada|d|cr|nix)$/i],
      },
      analyzer: new GenericTreeSitterLanguageAnalyzer(),
    },
  ];

  const frameworkRegistrations: AnalyzerRegistration[] = [
    { id: 'nestjs', name: 'NestJS Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@nestjs/core', '@nestjs/common'] }, requires: ['typescript-javascript'], analyzer: new NestJSAnalyzer() },
    { id: 'spring-boot', name: 'Spring Boot Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['spring-boot-starter', 'org.springframework.boot'], files: ['pom.xml', 'build.gradle'] }, requires: ['java'], analyzer: new SpringBootAnalyzer() },
    { id: 'django', name: 'Django Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Django', 'django'], files: ['manage.py', 'requirements.txt'] }, requires: ['python'], analyzer: new DjangoAnalyzer() },
    { id: 'flask', name: 'Flask Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Flask', 'flask'], files: ['requirements.txt'] }, requires: ['python'], analyzer: new FlaskAnalyzer() },
    { id: 'fastapi', name: 'FastAPI Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['fastapi', 'FastAPI'], files: ['requirements.txt'] }, requires: ['python'], analyzer: new FastAPIAnalyzer() },
    { id: 'aiohttp', name: 'aiohttp Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['aiohttp'], files: ['requirements.txt'], content: [/\bfrom\s+aiohttp\b/, /\bimport\s+aiohttp\b/] }, requires: ['python'], analyzer: new AiohttpAnalyzer() },
    { id: 'sanic', name: 'Sanic Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['sanic'], files: ['requirements.txt'], content: [/\bfrom\s+sanic\b/, /\bimport\s+sanic\b/, /\bSanic\s*\(/] }, requires: ['python'], analyzer: new SanicAnalyzer() },
    { id: 'tornado', name: 'Tornado Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['tornado'], files: ['requirements.txt'], content: [/\bfrom\s+tornado\b/, /\bimport\s+tornado\b/, /tornado\.web/] }, requires: ['python'], analyzer: new TornadoAnalyzer() },
    { id: 'starlette', name: 'Starlette Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['starlette'], files: ['requirements.txt'], content: [/\bfrom\s+starlette\b/, /\bimport\s+starlette\b/] }, requires: ['python'], analyzer: new StarletteAnalyzer() },
    { id: 'laravel', name: 'Laravel Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['artisan', 'composer.json'], dependencies: ['laravel/framework'] }, requires: ['php'], analyzer: new LaravelAnalyzer() },
    { id: 'symfony', name: 'Symfony Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['bin/console', 'composer.json'], dependencies: ['symfony/framework-bundle'] }, requires: ['php'], analyzer: new SymfonyAnalyzer() },
    { id: 'rails', name: 'Rails Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['Gemfile', 'config/routes.rb'], dependencies: ['rails'] }, requires: ['ruby'], analyzer: new RailsAnalyzer() },
    { id: 'express', name: 'Express.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['express'], files: ['package.json'] }, requires: ['typescript-javascript'], analyzer: new ExpressAnalyzer() },
    { id: 'fastify', name: 'Fastify Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['fastify', '@fastify/cors', '@fastify/jwt', '@fastify/cookie', '@fastify/multipart', '@fastify/swagger', '@fastify/type-provider-typebox'], files: ['package.json'] }, requires: ['typescript-javascript'], analyzer: new FastifyAnalyzer() },
    { id: 'node-http', name: 'Node.js Raw HTTP Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.{js,ts,mjs,cjs}'], content: [/\b(?:http|https)\.createServer\s*\(/, /(?<![.\w])createServer\s*\(/] }, requires: ['typescript-javascript'], analyzer: new NodeHttpAnalyzer() },
    { id: 'react', name: 'React Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['react', 'react-dom'], files: ['package.json'], content: [/\.jsx$/, /\.tsx$/] }, requires: ['typescript-javascript'], analyzer: new ReactAnalyzer() },
    { id: 'angular', name: 'Angular Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@angular/core', '@angular/common'], files: ['angular.json', 'package.json'], content: [/\.component\.ts$/] }, requires: ['typescript-javascript'], analyzer: new AngularAnalyzer() },
    { id: 'vue', name: 'Vue.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['vue', 'vue@'], files: ['package.json'], content: [/\.vue$/] }, requires: ['typescript-javascript'], analyzer: new VueAnalyzer() },
    { id: 'jest', name: 'Jest Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['jest', '@jest/core'], files: ['jest.config.js', 'jest.config.ts'], content: [/\.test\.(js|ts|jsx|tsx)$/, /\.spec\.(js|ts|jsx|tsx)$/] }, requires: ['typescript-javascript'], analyzer: new JestAnalyzer() },
    { id: 'cypress', name: 'Cypress Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['cypress'], files: ['cypress.json', 'cypress.config.js', 'cypress.config.ts'], content: [/\.cy\.(js|ts|jsx|tsx)$/] }, requires: ['typescript-javascript'], analyzer: new CypressAnalyzer() },
    { id: 'test-framework', name: 'Cross-Language Test Framework Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['vitest', 'mocha', 'jasmine', '@playwright/test', 'selenium-webdriver'], files: ['vitest.config.ts', 'playwright.config.ts', 'pytest.ini', 'phpunit.xml', '**/*_test.go', '**/*_spec.rb'], content: [/from\s+['"`]vitest['"`]/, /from\s+['"`]@playwright\/test['"`]/, /import\s+pytest/, /testing\.T\b/, /#\[(?:tokio::)?test\]/, /@Test\b/, /RSpec\.describe/, /PHPUnit\\Framework\\TestCase/] }, analyzer: new TestFrameworkAnalyzer() },
    { id: 'ci-pipeline', name: 'CI/CD Pipeline Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['.github/workflows/*.yml', '.github/workflows/*.yaml', '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'azure-pipelines.yaml', '.travis.yml', '.drone.yml', '.drone.yaml', '.buildkite/pipeline.yml', '.buildkite/pipeline.yaml', 'bitbucket-pipelines.yml', 'bitbucket-pipelines.yaml', '.teamcity/**/*.kt', '.teamcity/**/*.kts'] }, analyzer: new CiPipelineAnalyzer() },
    { id: 'airflow', name: 'Apache Airflow Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['apache-airflow'], files: ['requirements.txt', '**/dags/**/*.py'], content: [/from\s+airflow\b/, /import\s+airflow\b/, /@dag\b/, /@task\b/] }, requires: ['python'], analyzer: new AirflowAnalyzer() },
    { id: 'dagster', name: 'Dagster Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['dagster'], files: ['requirements.txt'], content: [/from\s+dagster\b/, /import\s+dagster\b/, /@asset\b/, /@op\b/] }, requires: ['python'], analyzer: new DagsterAnalyzer() },
    { id: 'prefect', name: 'Prefect Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['prefect'], files: ['requirements.txt'], content: [/from\s+prefect\b/, /import\s+prefect\b/, /@flow\b/, /@task\b/] }, requires: ['python'], analyzer: new PrefectAnalyzer() },
    { id: 'luigi', name: 'Luigi Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['luigi'], files: ['requirements.txt'], content: [/import\s+luigi\b/, /luigi\.Task\b/] }, requires: ['python'], analyzer: new LuigiAnalyzer() },
    { id: 'jupyter-notebook', name: 'Jupyter Notebook Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.ipynb'] }, analyzer: new JupyterNotebookAnalyzer() },
    { id: 'ml-training', name: 'ML Training Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['torch', 'tensorflow', 'keras'], files: ['requirements.txt', 'pyproject.toml'], content: [/import\s+torch\b/, /from\s+torch\b/, /import\s+tensorflow\b/, /\.fit\s*\(/] }, requires: ['python'], analyzer: new MLTrainingAnalyzer() },
    { id: 'wpf', name: 'WPF Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.xaml', '**/*.csproj'], content: [/PresentationFramework/, /System\.Windows/, /<UseWPF>true<\/UseWPF>/] }, requires: ['csharp'], analyzer: new WPFAnalyzer() },
    { id: 'electron', name: 'Electron Desktop Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['electron'], files: ['package.json'], content: [/\bipcMain\.(handle|on)\s*\(/, /\bipcRenderer\.(invoke|send)\s*\(/, /\bcontextBridge\.exposeInMainWorld\s*\(/, /new\s+BrowserWindow\s*\(/] }, requires: ['typescript-javascript'], analyzer: new ElectronAnalyzer() },
    { id: 'tauri', name: 'Tauri Desktop Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@tauri-apps/api', '@tauri-apps/cli'], files: ['src-tauri/Cargo.toml', 'Cargo.toml'], content: [/#\[tauri::command\]/, /tauri::generate_handler!/, /\binvoke\s*\(\s*['"`]/] }, analyzer: new TauriAnalyzer() },
    { id: 'aspnet-core', name: 'ASP.NET Core Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.csproj'], content: [/Microsoft\.AspNetCore/, /Microsoft\.NET\.Sdk\.Web/] }, requires: ['csharp'], analyzer: new AspNetCoreAnalyzer() },
    { id: 'nextjs', name: 'Next.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['next'], files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] }, requires: ['typescript-javascript'], analyzer: new NextJSAnalyzer() },
    { id: 'actix-web', name: 'Actix-web Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['actix-web', 'actix_web'], files: ['Cargo.toml'], content: [/actix_web::/, /#\[(get|post|put|delete|patch)\("/, /HttpServer::/] }, requires: ['rust'], analyzer: new ActixAnalyzer() },
    { id: 'rocket', name: 'Rocket Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['rocket', 'rocket_dyn_templates', 'rocket_sync'], files: ['Cargo.toml'], content: [/rocket::/, /#\[(get|post|put|delete|patch)\("/, /rocket::build/] }, requires: ['rust'], analyzer: new RocketAnalyzer() },
    { id: 'axum', name: 'Axum Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['axum'], files: ['Cargo.toml'], content: [/axum::/, /Router::new\s*\(/, /\.route\s*\(\s*"/] }, requires: ['rust'], analyzer: new AxumAnalyzer() },
    { id: 'warp', name: 'Warp Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['warp'], files: ['Cargo.toml'], content: [/warp::path\s*[!(]/, /\.and\s*\(\s*warp::(get|post|put|patch|delete)/] }, requires: ['rust'], analyzer: new WarpAnalyzer() },
    { id: 'tonic', name: 'Tonic gRPC Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['tonic'], files: ['Cargo.toml'], content: [/tonic::async_trait/, /tonic::(Request|Response)/] }, requires: ['rust'], analyzer: new TonicAnalyzer() },
    { id: 'drogon', name: 'Drogon Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['CMakeLists.txt', '**/*.cpp', '**/*.h'], content: [/#include\s*[<"]drogon\//, /ADD_METHOD_TO\s*\(/, /app\s*\(\s*\)\s*\.\s*registerHandler\s*\(/] }, requires: ['c-cpp'], analyzer: new DrogonAnalyzer() },
    { id: 'crow', name: 'Crow Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['CMakeLists.txt', '**/*.cpp', '**/*.h'], content: [/#include\s*[<"]crow(?:\.h|\/[^">]*)?[>"]/, /CROW_ROUTE\s*\(/] }, requires: ['c-cpp'], analyzer: new CrowAnalyzer() },
    { id: 'vapor', name: 'Vapor Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['vapor'], files: ['Package.swift', '**/*.swift'], content: [/import\s+Vapor/, /\.grouped\s*\(/, /\.(get|post|put|delete|patch)\s*\(/] }, requires: ['swift'], analyzer: new VaporAnalyzer() },
    { id: 'swift-platform', name: 'Swift Platform Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['Package.swift', '**/*.swift'], content: [/import\s+SwiftUI/, /import\s+AppKit/, /import\s+UIKit/, /platforms\s*:\s*\[/] }, requires: ['swift'], analyzer: new SwiftPlatformAnalyzer() },
    { id: 'mojolicious', name: 'Mojolicious Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Mojolicious'], files: ['cpanfile', 'Makefile.PL', '**/*.pl', '**/*.pm'], content: [/use\s+Mojolicious/, /^\s*(get|post|put|patch|del|options|any)\s+['"]/m, /->(get|post|put|patch|del|options|any|under)\s*\(/] }, requires: ['perl'], analyzer: new MojoliciousAnalyzer() },
    { id: 'gorouter', name: 'GoRouter Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['go_router'], files: ['pubspec.yaml', '**/*.dart'], content: [/GoRouter\s*\(/, /GoRoute\s*\(/, /package:go_router/] }, requires: ['dart'], analyzer: new GoRouterAnalyzer() },
    { id: 'shelf', name: 'Shelf/shelf_router Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['shelf', 'shelf_router'], files: ['pubspec.yaml', '**/*.dart'], content: [/package:shelf_router\//, /package:shelf\//, /Router\s*\(\s*\)/] }, requires: ['dart'], analyzer: new ShelfAnalyzer() },
    { id: 'http4s', name: 'http4s Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['http4s', 'http4s-dsl'], files: ['build.sbt', '**/*.scala'], content: [/org\.http4s/, /HttpRoutes\.of/, /AuthedRoutes\.of/] }, requires: ['scala'], analyzer: new Http4sAnalyzer() },
    { id: 'play', name: 'Play Framework Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['com.typesafe.play'], files: ['conf/routes', 'conf/*.routes', 'build.sbt'], content: [/^\s*(GET|POST|PUT|DELETE|PATCH)\s+\/\S*\s+[\w.]+\.\w+\(/m] }, requires: ['scala'], analyzer: new PlayAnalyzer() },
    { id: 'akka-http', name: 'Akka HTTP / Pekko HTTP Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['akka-http', 'pekko-http'], files: ['build.sbt', '**/*.scala'], content: [/import\s+akka\.http/, /import\s+org\.apache\.pekko\.http/, /\bpathPrefix\s*\(/] }, requires: ['scala'], analyzer: new AkkaHttpAnalyzer() },
    { id: 'kemal', name: 'Kemal Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['kemal'], files: ['shard.yml', '**/*.cr'], content: [/require\s+"kemal"/, /^\s*(get|post|put|patch|delete|options|head|ws)\s+"/m] }, requires: ['crystal'], analyzer: new KemalAnalyzer() },
    { id: 'genie', name: 'Genie Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Genie'], files: ['Project.toml', '**/*.jl'], content: [/Genie/, /\broute\s*\(/, /@(get|post|put|patch|delete)\s*\(/] }, requires: ['julia'], analyzer: new GenieAnalyzer() },
    { id: 'compojure', name: 'Compojure Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['compojure'], files: ['deps.edn', 'project.clj', '**/*.clj', '**/*.cljs', '**/*.cljc'], content: [/compojure\.core/, /\(defroutes\b/, /\(context\b/, /\((?:GET|POST|PUT|DELETE|PATCH|ANY)\s+"/] }, requires: ['clojure'], analyzer: new CompojureAnalyzer() },
    { id: 'reitit', name: 'Reitit/Ring Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['reitit', 'ring/ring-core', 'ring/ring-jetty-adapter'], files: ['deps.edn', 'project.clj', '**/*.clj', '**/*.cljs', '**/*.cljc'], content: [/reitit\.(ring|core)/, /ring\.adapter/, /\(:handler\b/] }, requires: ['clojure'], analyzer: new ReititAnalyzer() },
    { id: 'sinatra', name: 'Sinatra Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['sinatra'], files: ['Gemfile', '**/*.rb'], content: [/require\s+['"]sinatra['"]/, /class\s+\w+\s*<\s*Sinatra::Base/] }, requires: ['ruby'], analyzer: new SinatraAnalyzer() },
    { id: 'slim', name: 'Slim/CodeIgniter Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['slim/slim', 'codeigniter4/framework', 'codeigniter/framework'], files: ['composer.json', '**/*.php'], content: [/AppFactory::create\(\)/, /new\s+\\?Slim\\App\(/, /\$routes->(get|post|put|patch|delete)\s*\(/] }, requires: ['php'], analyzer: new SlimAnalyzer() },
    { id: 'dream', name: 'Dream Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['dream'], files: ['dune-project', 'dune', '**/*.ml'], content: [/Dream\.router/, /Dream\.(get|post|put|patch|delete|options|head)\s+"/, /Dream\.scope/] }, requires: ['ocaml'], analyzer: new DreamAnalyzer() },
    { id: 'apexrest', name: 'Apex REST Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: [], files: ['sfdx-project.json', '**/*.cls'], content: [/@RestResource\b/, /@Http(Get|Post|Put|Patch|Delete)\b/] }, requires: ['apex'], analyzer: new ApexRestAnalyzer() },
    { id: 'svelte', name: 'Svelte/SvelteKit Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['svelte', '@sveltejs/kit'], content: [/\.svelte$/] }, requires: ['typescript-javascript'], analyzer: new SvelteAnalyzer() },
    { id: 'astro', name: 'Astro Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['astro'], files: ['astro.config.mjs', 'astro.config.ts'], content: [/\.astro$/] }, requires: ['typescript-javascript'], analyzer: new AstroAnalyzer() },
    { id: 'hono', name: 'Hono Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['hono'] }, requires: ['typescript-javascript'], analyzer: new HonoAnalyzer() },
    { id: 'anchor', name: 'Anchor (Solana) Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['anchor-lang'], files: ['Anchor.toml'], content: [/#\[program\]/, /use anchor_lang/] }, requires: ['rust'], analyzer: new AnchorAnalyzer() },
    { id: 'phoenix', name: 'Phoenix Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['phoenix'], files: ['mix.exs'], content: [/use Phoenix\.Router/, /use Phoenix\.LiveView/] }, requires: ['elixir'], analyzer: new PhoenixAnalyzer() },
    { id: 'nuxt', name: 'Nuxt Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['nuxt'], files: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'] }, requires: ['typescript-javascript'], analyzer: new NuxtAnalyzer() },
    { id: 'remix', name: 'Remix Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@remix-run/react', '@remix-run/node'], files: ['remix.config.js'] }, requires: ['typescript-javascript'], analyzer: new RemixAnalyzer() },
    { id: 'react-native', name: 'React Native / Expo Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['react-native', 'expo'], files: ['app.json', 'app.config.js', 'app.config.ts'] }, requires: ['typescript-javascript'], analyzer: new ReactNativeAnalyzer() },
    { id: 'ktor', name: 'Ktor Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.ktor', 'ktor-server-core'], files: ['build.gradle.kts', 'build.gradle'], content: [/io\.ktor/, /routing\s*\{/, /embeddedServer\(/] }, requires: ['kotlin'], analyzer: new KtorAnalyzer() },
    { id: 'jetpack-compose', name: 'Jetpack Compose Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['androidx.compose', 'androidx.compose.runtime', 'compose.runtime'], files: ['build.gradle.kts', 'build.gradle'], content: [/@Composable/, /androidx\.compose/] }, requires: ['kotlin'], analyzer: new ComposeAnalyzer() },
    { id: 'solidity-security', name: 'Solidity Security Facts Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@openzeppelin/contracts', 'openzeppelin-solidity'], files: ['foundry.toml', 'hardhat.config.js', 'hardhat.config.ts', 'truffle-config.js'], content: [/onlyOwner/, /nonReentrant/] }, requires: ['solidity'], analyzer: new SoliditySecurityAnalyzer() },
    { id: 'wordpress', name: 'WordPress Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['wp-config.php', 'style.css'], content: [/add_action\s*\(/, /add_filter\s*\(/, /register_post_type\s*\(/, /Plugin Name:/, /Theme Name:/] }, requires: ['php'], analyzer: new WordPressAnalyzer() },
    { id: 'blazor', name: 'Blazor Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.razor'], content: [/Microsoft\.AspNetCore\.Components/, /@page\s/, /@code\b/] }, requires: ['csharp'], analyzer: new BlazorAnalyzer() },
    { id: 'quarkus', name: 'Quarkus Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.quarkus'], files: ['pom.xml', 'build.gradle'], content: [/quarkus\./, /jakarta\.ws\.rs/, /javax\.ws\.rs/] }, requires: ['java'], analyzer: new QuarkusAnalyzer() },
    { id: 'micronaut', name: 'Micronaut Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.micronaut'], files: ['pom.xml', 'build.gradle'], content: [/io\.micronaut/, /@Controller/] }, requires: ['java'], analyzer: new MicronautAnalyzer() },
    { id: 'jaxrs', name: 'JAX-RS / Jersey Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['jersey-server', 'jersey-core', 'jakarta.ws.rs-api', 'javax.ws.rs-api', 'resteasy'], files: ['pom.xml', 'build.gradle'], content: [/import\s+(?:jakarta|javax)\.ws\.rs/, /@Path\s*\(/] }, requires: ['java'], analyzer: new JaxRsAnalyzer() },
    { id: 'vertx', name: 'Vert.x Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.vertx', 'vertx-web', 'vertx-core'], files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], content: [/import\s+io\.vertx/, /Router\.router\s*\(/] }, requires: ['java'], analyzer: new VertxAnalyzer() },
    { id: 'solidstart', name: 'SolidStart Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['solid-start', '@solidjs/start'] }, requires: ['typescript-javascript'], analyzer: new SolidStartAnalyzer() },
    { id: 'qwik', name: 'Qwik Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@builder.io/qwik', '@builder.io/qwik-city'] }, requires: ['typescript-javascript'], analyzer: new QwikAnalyzer() },
    { id: 'gin', name: 'Gin Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['github.com/gin-gonic/gin'], files: ['go.mod'], content: [/"github\.com\/gin-gonic\/gin"/, /gin\.(Default|New)\s*\(/, /\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"/] }, requires: ['go'], analyzer: new GinAnalyzer() },
    { id: 'echo', name: 'Echo Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['github.com/labstack/echo'], files: ['go.mod'], content: [/"github\.com\/labstack\/echo(\/v4)?"/, /echo\.New\s*\(/] }, requires: ['go'], analyzer: new EchoAnalyzer() },
    { id: 'fiber', name: 'Fiber Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['github.com/gofiber/fiber'], files: ['go.mod'], content: [/"github\.com\/gofiber\/fiber\/v?\d*"/, /fiber\.New\s*\(/] }, requires: ['go'], analyzer: new FiberAnalyzer() },
    { id: 'chi', name: 'Chi Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['github.com/go-chi/chi'], files: ['go.mod'], content: [/"github\.com\/go-chi\/chi(\/v\d+)?"/, /chi\.NewRouter\s*\(/] }, requires: ['go'], analyzer: new ChiAnalyzer() },
    { id: 'unity', name: 'Unity Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['ProjectSettings/ProjectVersion.txt', '**/*.unity', '**/*.meta', '**/*.cs'], content: [/^\s*using\s+UnityEngine\s*;/m] }, requires: ['csharp'], analyzer: new UnityAnalyzer() },
    { id: 'unreal', name: 'Unreal Engine Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.uproject', '**/*.cpp', '**/*.h'], content: [/GENERATED_BODY\s*\(\s*\)/, /#include\s*"CoreMinimal\.h"/] }, requires: ['c-cpp'], analyzer: new UnrealAnalyzer() },
    { id: 'godot', name: 'Godot Engine Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['project.godot', '**/*.tscn', '**/*.gd'], content: [/\bfunc\s+_ready\s*\(/, /\bfunc\s+_process\s*\(/] }, analyzer: new GodotAnalyzer() },
    { id: 'embedded-c', name: 'Embedded C Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.c', '**/*.h', '**/*.ld'], content: [/#include\s*[<"]avr\/(io|interrupt)\.h[>"]/, /\bISR\s*\(/, /__attribute__\s*\(\s*\(\s*interrupt/] }, requires: ['c-cpp'], analyzer: new EmbeddedCAnalyzer() },
    { id: 'arduino', name: 'Arduino Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.ino', '**/*.cpp', '**/*.h'], content: [/#include\s*[<"]Arduino\.h[>"]/, /\bvoid\s+setup\s*\(/, /\bvoid\s+loop\s*\(/] }, analyzer: new ArduinoAnalyzer() },
    { id: 'linux-kernel-module', name: 'Linux Kernel Module Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.c', 'Kbuild', 'Makefile'], content: [/#include\s*[<"]linux\/module\.h[>"]/, /\bmodule_init\s*\(/, /\bmodule_exit\s*\(/] }, requires: ['c-cpp'], analyzer: new LinuxKernelModuleAnalyzer() },
  ];

  const libraryRegistrations: AnalyzerRegistration[] = [
    { id: 'prisma', name: 'Prisma ORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['prisma', '@prisma/client'], files: ['prisma/schema.prisma'] }, requires: ['typescript-javascript'], analyzer: new PrismaAnalyzer() },
    { id: 'socketio', name: 'Socket.io Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['socket.io', 'socket.io-client'] }, requires: ['typescript-javascript'], analyzer: new SocketIOAnalyzer() },
    { id: 'react-router', name: 'React Router Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['react-router-dom', 'react-router'] }, requires: ['typescript-javascript'], analyzer: new ReactRouterAnalyzer() },
    { id: 'redux', name: 'Redux/RTK Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@reduxjs/toolkit', 'redux'] }, requires: ['typescript-javascript'], analyzer: new ReduxAnalyzer() },
    { id: 'zustand', name: 'Zustand Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['zustand'] }, requires: ['typescript-javascript'], analyzer: new ZustandAnalyzer() },
    { id: 'tanstack-query', name: 'TanStack Query Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@tanstack/react-query', 'react-query', '@tanstack/vue-query', '@tanstack/svelte-query'] }, requires: ['typescript-javascript'], analyzer: new TanStackQueryAnalyzer() },
    { id: 'reactive-streams', name: 'Reactive Streams Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['rxjs'], content: [/import\s+reactor\.core\.publisher\.(Mono|Flux)/, /import\s+io\.reactivex[^;]*\.(Observable|Flowable|Single|Maybe|Completable)/, /import\s+Combine\b/] }, analyzer: new ReactiveStreamsAnalyzer() },
    { id: 'frontend-state', name: 'Frontend State Management Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['mobx', 'mobx-react', 'mobx-react-lite', 'recoil', 'jotai', 'valtio', 'pinia', '@ngrx/store', '@ngrx/effects'] }, requires: ['typescript-javascript'], analyzer: new FrontendStateAnalyzer() },
    { id: 'reqwest', name: 'Reqwest HTTP Client Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['reqwest'], files: ['Cargo.toml'] }, requires: ['rust'], analyzer: new ReqwestAnalyzer() },
    { id: 'outbound-http-client', name: 'Outbound HTTP Client Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['axios', 'got', 'ky', 'node-fetch', '@apollo/client', 'urql', 'requests', 'httpx', 'aiohttp', 'spring-web', 'spring-webflux', 'okhttp', 'feign-core', 'spring-cloud-starter-openfeign', 'github.com/go-resty/resty'], content: [/\bfetch\s*\(\s*['"`]https?:\/\//, /@FeignClient\b/, /\bhttp\.(Get|Post|NewRequest)/] }, analyzer: new OutboundHttpClientAnalyzer() },
    { id: 'validation-schema-contracts', name: 'Validation Schema Contract Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['zod', 'yup', 'class-validator', 'joi', '@hapi/joi', 'ajv', 'marshmallow', 'cerberus'], content: [/\bz\.object\s*\(/, /\byup\.object\b/, /\bJoi\.[a-z]+\s*\(/, /(?:from\s*|require\s*\(\s*)['"](?:joi|@hapi\/joi)['"]/, /\bnew\s+Ajv\b/, /@Is[A-Za-z]+\s*\(/, /\bfields\.[A-Za-z]+\s*\(/, /\bValidator\s*\(/] }, analyzer: new ValidationSchemaAnalyzer() },
    { id: 'trpc', name: 'tRPC API Contract Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@trpc/server', '@trpc/client'] }, requires: ['typescript-javascript'], analyzer: new TRPCAnalyzer() },
    { id: 'graphql', name: 'GraphQL API Contract Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['graphql', '@apollo/server', 'type-graphql', 'graphql-yoga', 'nexus', 'strawberry-graphql', 'graphene', 'ariadne', 'gqlgen', 'spring-graphql', 'graphql-java'], files: ['**/*.graphql', '**/*.gql'] }, requires: ['typescript-javascript'], analyzer: new GraphQLAnalyzer() },
    { id: 'grpc-handler', name: 'gRPC Handler Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@grpc/grpc-js', 'grpc', 'nice-grpc', '@nestjs/microservices', 'grpcio'], files: ['**/*_pb2_grpc.py'], content: [/\.addService\s*\(/, /@GrpcMethod\b/, /add_\w+Servicer_to_server/] }, analyzer: new GrpcHandlerAnalyzer() },
    { id: 'drizzle', name: 'Drizzle ORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['drizzle-orm'] }, requires: ['typescript-javascript'], analyzer: new DrizzleAnalyzer() },
    { id: 'typeorm', name: 'TypeORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['typeorm'] }, requires: ['typescript-javascript'], analyzer: new TypeORMAnalyzer() },
    { id: 'mongoose', name: 'Mongoose Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['mongoose'] }, requires: ['typescript-javascript'], analyzer: new MongooseAnalyzer() },
    { id: 'sqlalchemy-pydantic', name: 'SQLAlchemy/Pydantic Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sqlalchemy', 'pydantic', 'SQLAlchemy', 'sqlmodel'], files: ['requirements.txt', 'pyproject.toml', 'Pipfile'] }, requires: ['python'], analyzer: new SQLAlchemyPydanticAnalyzer() },
    { id: 'sequelize', name: 'Sequelize Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sequelize'] }, requires: ['typescript-javascript'], analyzer: new SequelizeAnalyzer() },
    { id: 'knex', name: 'Knex Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['knex'] }, requires: ['typescript-javascript'], analyzer: new KnexAnalyzer() },
    { id: 'objection', name: 'Objection.js Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['objection'] }, requires: ['typescript-javascript'], analyzer: new ObjectionAnalyzer() },
    { id: 'diesel', name: 'Diesel Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['diesel'], files: ['Cargo.toml'] }, requires: ['rust'], analyzer: new DieselAnalyzer() },
    { id: 'sea-orm', name: 'SeaORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sea-orm'], files: ['Cargo.toml'] }, requires: ['rust'], analyzer: new SeaOrmAnalyzer() },
    { id: 'gorm', name: 'GORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['gorm.io/gorm'], files: ['go.mod'] }, requires: ['go'], analyzer: new GormAnalyzer() },
    { id: 'sqlx', name: 'sqlx Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sqlx'], files: ['Cargo.toml'] }, requires: ['rust'], analyzer: new SqlxAnalyzer() },
    { id: 'ent', name: 'ent Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['entgo.io/ent'], files: ['go.mod'] }, requires: ['go'], analyzer: new EntAnalyzer() },
    { id: 'dapper', name: 'Dapper Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['Dapper'] }, requires: ['csharp'], analyzer: new DapperAnalyzer() },
    { id: 'doctrine', name: 'Doctrine ORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { files: ['composer.json'], dependencies: ['doctrine/orm', 'doctrine/doctrine-bundle', 'doctrine/persistence', 'doctrine/annotations'], content: [/ORM\\Entity\b/, /@ORM\\Entity\b/] }, requires: ['php'], analyzer: new DoctrineAnalyzer() },
    { id: 'ai-stack', name: 'AI/LLM Stack Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['langchain', '@langchain/core', 'llamaindex', 'ai', '@ai-sdk/openai', 'openai', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'langgraph', 'crewai', '@pinecone-database/pinecone', 'weaviate-ts-client', 'chromadb', 'qdrant'] }, requires: ['typescript-javascript'], analyzer: new AIStackAnalyzer() },
    { id: 'workflow', name: 'Workflow/Queue Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@temporalio/client', '@temporalio/worker', 'celery', 'sidekiq', 'bullmq', 'bull', 'kafkajs', 'amqplib', 'nats', 'kafka-python', 'confluent-kafka', 'kafka-go', 'nats.go', 'rdkafka', 'async-nats', 'spring-kafka', 'Confluent.Kafka'] }, requires: ['typescript-javascript'], analyzer: new WorkflowAnalyzer() },
    { id: 'async-messaging', name: 'Async Messaging Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['kafkajs', 'node-rdkafka', 'amqplib', 'amqp-connection-manager', '@nestjs/microservices', 'nats', 'ioredis', 'redis', 'bullmq', 'bee-queue', '@aws-sdk/client-sqs', '@aws-sdk/client-sns', 'confluent-kafka', 'kafka-python', 'pika', 'celery', 'spring-kafka', 'spring-rabbit', 'sidekiq', 'github.com/segmentio/kafka-go', 'github.com/nats-io/nats.go'], content: [/producer\.send\s*\(\s*\{[\s\S]{0,200}?topic\s*:/, /\.sendToQueue\s*\(/, /\.publish\s*\(\s*['"`][^'"`]+['"`]/, /@KafkaListener|@RabbitListener/, /@MessagePattern|@EventPattern/, /Sidekiq::Worker/] }, analyzer: new MessagingAnalyzer() },
    { id: 'observability-instrumentation', name: 'Observability Instrumentation Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@opentelemetry/api', '@opentelemetry/sdk-node', '@sentry/node', '@sentry/nextjs', '@sentry/browser', 'dd-trace', '@datadog/browser-logs', '@datadog/browser-rum', '@datadog/mobile-react-native', 'rollbar', '@bugsnag/js', '@bugsnag/node', 'prom-client', 'hot-shots', 'node-statsd', 'winston', 'pino', 'bunyan', 'sentry-sdk', 'structlog', 'opentelemetry-api', 'opentelemetry-sdk', 'io.opentelemetry', 'io.micrometer', 'micrometer-core', 'org.slf4j', 'log4j', 'logback-classic', 'go.uber.org/zap', 'github.com/rs/zerolog'], content: [/trace\.getTracer|startSpan\s*\(|@WithSpan/, /Sentry\.captureException|capture_exception\s*\(/, /new\s+(?:Counter|Gauge|Histogram)\s*\(/, /createLogger\s*\(|pino\s*\(|structlog\.get_logger|LoggerFactory\.getLogger/, /datadogRum\.init|datadogLogs\.init|DdSdkReactNative/] }, analyzer: new ObservabilityAnalyzer() },
    { id: 'mediator-cqrs-messaging', name: 'Mediator/CQRS Messaging Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['MediatR', 'MassTransit', 'NServiceBus', '@nestjs/cqrs', 'nestjs-cqrs', '@aws-sdk/client-sqs', 'aws-lambda', 'boto3'], content: [/IRequestHandler|INotificationHandler|IMediator/, /IConsumer<|IHandleMessages</, /@CommandHandler|@QueryHandler|@EventsHandler/, /SQSEvent|event\.Records|eventSourceARN/] }, analyzer: new MediatorCqrsAnalyzer() },
    { id: 'openapi', name: 'OpenAPI/Swagger Analyzer', type: 'library', version: '1.0.0', detectPatterns: { files: ['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml'], content: [/openapi\s*:/, /"openapi"\s*:/, /swagger\s*:/] }, analyzer: new OpenAPIAnalyzer() },
    { id: 'efcore', name: 'EF Core Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['Microsoft.EntityFrameworkCore'], content: [/:\s*DbContext/, /DbSet</] }, requires: ['csharp'], analyzer: new EFCoreAnalyzer() },
    { id: 'cron', name: 'Scheduled Job (Cron) Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['cron', 'node-cron', '@nestjs/schedule'] }, requires: ['typescript-javascript'], analyzer: new CronAnalyzer() },
    { id: 'mcp-tool-registration', name: 'MCP Tool Registration Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@modelcontextprotocol/sdk'], content: [/\.registerTool\s*\(/, /\.setRequestHandler\s*\(/] }, requires: ['typescript-javascript'], analyzer: new McpToolRegistrationAnalyzer() },
    { id: 'di-container-bindings', name: 'DI Container Binding Graph Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['inversify', 'tsyringe', 'Ninject', 'Autofac', 'Microsoft.Extensions.DependencyInjection', 'dagger', 'com.google.dagger', 'com.google.inject', 'guice', 'io.insert-koin', 'symfony/dependency-injection', 'php-di/php-di', 'dependency_injector', 'dependency-injector'] }, analyzer: new DiContainerBindingAnalyzer() },
    // Registration id MUST equal the analyzer's own id (MockingLibraryAnalyzer's
    // super() id, 'mocking-test-double-fixtures'): the orchestrator keys its
    // analyzer map on registration.id while every node/tag/contribution carries
    // the analyzer's self-id (analyzer_id, `analyzer:<id>` tag, source_analyzer).
    // A drift (plural 'doubles') left node-level consumers unable to correlate
    // mocking nodes back to the registered analyzer. See docs/CORPUS-DEPTH-SWEEP.md #5.
    { id: 'mocking-test-double-fixtures', name: 'Mocking, Test Double and Fixture Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sinon', 'jest', '@jest/globals', 'vitest', 'testdouble', 'responses', 'requests-mock', 'org.mockito:mockito-core', 'mockito-core', 'org.easymock:easymock', 'github.com/golang/mock', 'go.uber.org/mock', 'github.com/stretchr/testify', 'Moq', 'NSubstitute', 'rspec-mocks', 'fishery', 'factory-boy', '@faker-js/faker', 'factory_bot', 'factory_bot_rails'], content: [/\b(?:jest|vi)\.(?:mock|fn|spyOn)\s*\(/, /\bsinon\.(?:stub|spy|mock|fake)\s*\(/, /@Mock\b/, /\bNewMock[A-Z]/, /\bSubstitute\.For</, /\bMock\.Of</, /\bpatch\s*\(\s*['"]/, /\bmonkeypatch\./, /\bFactory\.define\b/, /\binstance_double\s*\(/] }, analyzer: new MockingLibraryAnalyzer() },
    { id: 'auth', name: 'Authentication and Authorization Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['passport', '@nestjs/passport', '@nestjs/jwt', 'passport-jwt', 'next-auth', '@auth/core', '@auth0/nextjs-auth0', '@auth0/auth0-react', 'auth0', 'express-oauth2-jwt-bearer', '@clerk/nextjs', '@clerk/clerk-react', '@clerk/clerk-sdk-node', '@clerk/express', 'firebase-admin', 'firebase', 'lucia', 'jsonwebtoken', 'express-jwt', 'spring-security', 'spring-boot-starter-security', 'Django', 'djangorestframework', 'Flask-Login', 'flask-login', 'PyJWT', 'Authlib', 'authlib', 'devise', 'pundit', 'cancancan', 'casbin', 'node-casbin', '@casl/ability', 'oso'], files: ['**/*.rego'], content: [/passport\.authenticate\s*\(/, /@(PreAuthorize|Secured|RolesAllowed)\b/, /\bpermission_classes\b/, /@login_required\b/, /\bauthorize!?\b/] }, analyzer: new AuthAnalyzer() },
    ...architectureLibraryAnalyzerDefinitions().map(definition => ({
      id: definition.id,
      name: definition.name,
      type: 'library' as const,
      version: '1.0.0',
      detectPatterns: { dependencies: definition.dependencies },
      analyzer: definition.analyzer,
    })),
  ];

  // Declarative analyzer-pack engine: ONE 'pattern'-type analyzer that runs
  // every applicable pack (built-in packs bundled in analyzer-core/analyzer/
  // packs/examples/*.pack.yaml + any local packs a project declares in
  // .klaurorc `packs:`, threaded in via orchestrateAnalysis({ packGlobs }) —
  // see analyzeProject below). A pack is a *.pack.yaml with tree-sitter queries
  // that emit real CAS entry_points/entities/edges, the declarative equivalent
  // of a hand-coded *-analyzer.ts (docs/SPEC-ANALYZER-PACKS.md). Additive and
  // evidence-gated: its canAnalyze() is false when no packs load, and each
  // pack's applies_when must match, so a repo with no applicable packs is
  // unaffected. A malformed pack degrades to a scoped load/rule error (surfaced
  // in the contribution metadata) and never crashes the analysis.
  const patternRegistrations: AnalyzerRegistration[] = [
    {
      id: 'analyzer-packs',
      name: 'Declarative Analyzer-Pack Engine',
      type: 'pattern',
      version: '0.1.0',
      detectPatterns: {},
      analyzer: new PackAnalyzer(),
    },
  ];

  for (const reg of [...languageRegistrations, ...frameworkRegistrations, ...libraryRegistrations, ...patternRegistrations]) {
    created.registerAnalyzer(reg);
  }

  return created;
}

/**
 * Process-wide orchestrator singleton for read-only introspection ONLY (e.g.
 * listRegisteredAnalyzers() in apps/mcp-server/src/gauntlet/coverage.ts).
 * Actual analysis runs (analyzeProject/analyzeProjectIncremental/
 * analyzeProjectDeferred below) each get their own dedicated orchestrator
 * instance via createOrchestrator() through the lane pool — see "Analysis
 * lane pool" below for why a shared instance is unsafe across concurrent runs.
 */
export function getOrchestrator(): AnalyzerOrchestrator {
  if (process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS === '1') {
    return createOrchestrator();
  }

  if (orchestrator) return orchestrator;

  orchestrator = createOrchestrator();
  return orchestrator;
}

/**
 * Load .klaurorc `conventions:` for a project, validated. A malformed
 * convention degrades to a logged warning and the whole section is dropped
 * (never crashes a real analysis run for a config typo) — declare_convention
 * and get_klauro_project_config are the surfaces that report validation
 * errors back to the caller before they ever reach here.
 */
/**
 * Load .klaurorc `packs:` globs for a project, mirroring how conventions are
 * discovered. These local declarative-pack globs are loaded IN ADDITION to the
 * built-in packs bundled with analyzer-core. Purely additive: absent/empty
 * config yields no local packs (built-ins still apply), and a config read
 * failure degrades to a logged warning rather than failing the analysis. Actual
 * pack validation happens in the pack loader (never throws), so a malformed
 * pack surfaces as a scoped load error in the contribution, not here.
 */
async function loadPackGlobsForAnalysis(projectPath: string): Promise<string[]> {
  try {
    const loaded = await loadKlauroConfig(projectPath);
    const packs = loaded.config.packs;
    if (!Array.isArray(packs)) return [];
    return packs.filter((glob): glob is string => typeof glob === 'string' && glob.trim().length > 0);
  } catch (error) {
    console.warn(`[Klauro] failed to load .klaurorc packs: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function loadConventionsForAnalysis(projectPath: string): Promise<KlauroConventions | undefined> {
  try {
    const loaded = await loadKlauroConfig(projectPath);
    const conventions = loaded.config.conventions;
    if (!conventions || Object.keys(conventions).length === 0) return undefined;
    const validation = validateConventions(conventions);
    if (validation.errors.length > 0) {
      console.warn(`[Klauro] .klaurorc conventions invalid, skipping declared conventions for this analysis: ${validation.errors.join('; ')}`);
      return undefined;
    }
    for (const warning of validation.warnings) {
      console.warn(`[Klauro] .klaurorc conventions warning: ${warning}`);
    }
    return conventions;
  } catch (error) {
    console.warn(`[Klauro] failed to load .klaurorc conventions: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function buildEmbeddingPhaseConfig(projectPath: string): Promise<EmbeddingPhaseConfig | null> {
  if (process.env.KLAURO_EMBEDDING_ENABLED === 'false' || process.env.KLAURO_EMBEDDING_ENABLED === '0') {
    return null;
  }

  const loaded = await loadKlauroConfig(projectPath);
  const embedding = loaded.config.embedding;
  if (!embedding.enabled) return null;

  const validation = validateEmbeddingConfig(loaded.config);
  for (const warning of validation.warnings) {
    console.warn(`[Klauro] embedding config: ${warning}`);
  }
  if (validation.errors.length > 0) {
    console.warn(`[Klauro] embedding disabled: ${validation.errors.join('; ')}`);
    return null;
  }

  try {
    const providerOptions = {
      model: embedding.model,
      dimensions: embedding.dimensions,
      maxBatch: 64,
      maxConcurrency: embedding.maxConcurrency,
      apiKeyEnv: embedding.apiKeyEnv,
    };
    // The local path prefers the real ONNX model and lazily falls back to the
    // hash embedding when it can't load, so the index is built with real
    // semantics wherever the model is present. The API path is unchanged.
    const provider = createEmbeddingProvider(embedding.provider, providerOptions);

    const store = buildVectorStore(
      projectPath,
      embedding.store,
      embedding.databaseUrlEnv,
      embedding.dimensions,
    );

    return {
      provider,
      store,
      maxDocumentChars: embedding.maxDocumentChars,
      phaseBudgetMs: embedding.phaseBudgetMs,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[Klauro] embedding disabled: ${reason}`);
    return null;
  }
}

function buildVectorStore(
  projectPath: string,
  setting: 'auto' | 'file' | 'pgvector',
  databaseUrlEnv: string,
  dimensions: number,
): VectorStore {
  const fileBaseDir = getProjectStorageDir(projectPath);
  const fileStore = (): VectorStore =>
    createVectorStore({ store: 'file', fileBaseDir, expectedDimensions: dimensions });

  let resolved: VectorStoreSetting;
  if (setting === 'auto') {
    // Availability decision, not a "mode": use pgvector when a database is actually
    // configured (the hosted server), otherwise the file store.
    resolved = process.env[databaseUrlEnv] ? 'pgvector' : 'file';
  } else {
    resolved = setting;
  }

  if (resolved !== 'pgvector') {
    return fileStore();
  }

  const pgPool = getPgPool(resolvePgConnectionString(databaseUrlEnv));
  if (!pgPool) {
    if (setting === 'pgvector') {
      console.warn(
        '[Klauro] embedding store "pgvector" requested but no Postgres connection is available; falling back to the file store',
      );
    }
    return fileStore();
  }

  return createVectorStore({
    store: 'pgvector',
    fileBaseDir,
    pgPool,
    expectedDimensions: dimensions,
  });
}

/**
 * True when the description in this output is deterministic because AI
 * interpretation never ran (disabled by env, no provider configured, feature
 * off, cooldown, or zero budget). AI-attempted-and-rejected/failed outputs
 * return false: those keep their deterministic description on purpose.
 */
function aiInterpretationWasUnavailable(output: CASOutput): boolean {
  const generation = output.enhanced_system_purpose?.description_generation;
  return generation?.status === 'ai_skipped' && generation.attempted === false;
}

/**
 * Full re-analyses that run with AI unavailable must not downgrade a stored
 * AI-enriched analysis to deterministic text. Mirrors the incremental reuse
 * hook in AnalyzerOrchestrator.orchestrateIncrementalAnalysis: carry the prior
 * AI system description/domain (and AI/manual capability descriptions) forward
 * with 'reused' provenance. The carried text is not re-validated against the
 * new state of the repo, so it is marked may_be_stale.
 */
export function preservePreviousAIDescriptions(
  previousOutput: CASOutput | null | undefined,
  output: CASOutput
): CASOutput {
  const previousPurpose = previousOutput?.enhanced_system_purpose;
  const purpose = output.enhanced_system_purpose;
  if (!previousPurpose || !purpose) return output;
  if (!aiInterpretationWasUnavailable(output)) return output;

  const previousCapabilities = new Map(
    (previousOutput?.system_capabilities || []).map(capability => [capability.id, capability])
  );
  for (const capability of output.system_capabilities || []) {
    const previous = previousCapabilities.get(capability.id);
    if (previous?.description &&
      capabilityReuseSubjectsMatch(previous, capability) &&
      !hasCapabilityDescriptionDomainMismatch(previous.description, output) &&
      validateDescription(previous.description, { kind: 'capability', name: capability.name, target: capability }, output).ok &&
      (previous.description_source === 'ai' || previous.description_source === 'manual' || previous.description_source === 'reused')) {
      capability.description = previous.description;
      capability.description_source = 'reused';
      capability.description_generation = {
        status: 'reused_previous',
        attempted: false,
        reason: previous.description_generation?.status,
        generated_at: new Date().toISOString(),
        may_be_stale: true,
      };
    }
  }

  if (!previousPurpose.inferred_description ||
    !(previousPurpose.description_source === 'ai' || previousPurpose.description_source === 'reused')) {
    return output;
  }
  if (hasLowLevelExternalServicePollution(previousPurpose.inferred_description) ||
    hasStaleNarrativePattern(previousPurpose.inferred_description, previousPurpose.primary_domain, output) ||
    hasProductDomainDescriptionMismatch(previousPurpose.inferred_description, output)) {
    return output;
  }
  purpose.inferred_description = previousPurpose.inferred_description;
  purpose.description_source = 'reused';
  purpose.description_generation = {
    status: 'reused_previous',
    attempted: false,
    reason: 'ai-unavailable-on-full-rebuild',
    generated_at: new Date().toISOString(),
    may_be_stale: true,
  };
  if (previousPurpose.primary_domain &&
    (previousPurpose.domain_source === 'ai' || previousPurpose.domain_source === 'reused')) {
    purpose.primary_domain = previousPurpose.primary_domain;
    purpose.domain_source = 'reused';
  }
  return output;
}

function capabilityReuseSubjectsMatch(previous: any, current: any): boolean {
  const previousName = normalizeCapabilityReuseSubject(previous?.name);
  const currentName = normalizeCapabilityReuseSubject(current?.name);
  if (!previousName || !currentName || previousName !== currentName) return false;
  const previousDomains = new Set((previous?.related_domains || []).map((domain: unknown) => normalizeCapabilityReuseSubject(domain)).filter(Boolean));
  const currentDomains = (current?.related_domains || []).map((domain: unknown) => normalizeCapabilityReuseSubject(domain)).filter(Boolean);
  if (previousDomains.size === 0 || currentDomains.length === 0) return true;
  return currentDomains.some((domain: string) => previousDomains.has(domain));
}

function hasCapabilityDescriptionDomainMismatch(description: string, output: CASOutput): boolean {
  const domain = String(output.enhanced_system_purpose?.primary_domain || '').toLowerCase();
  const text = String(description || '').toLowerCase();
  if (/zero-trust|network-access|webauthn/.test(domain) && /\b(commerce|cart|checkout|order fulfillment|merchandising)\b/.test(text)) {
    return true;
  }
  if (/website|marketing/.test(domain) && /\b(database schema|backend service|trading|portfolio holdings|wallet)\b/.test(text)) {
    return true;
  }
  if (/solana|trading|portfolio/.test(domain) && /\b(marketing page|careers|company page|contact page)\b/.test(text)) {
    return true;
  }
  return false;
}

function normalizeCapabilityReuseSubject(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(management|capability|workflow|reporting|analysis|generation|settlement|rebalancing|authentication|commands|handlers|tasks)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hasLowLevelExternalServicePollution(description: string): boolean {
  if (/\b(?:connects to|connected to|calls out to)\b[^.]*\b(?:Self|gtk|objc_sys|[A-Z][A-Za-z0-9]*(?:Data|Decl|Item|Pool|Size))\b/.test(description)) {
    return true;
  }
  if (/\bexternal services? like\b/i.test(description)) {
    const candidates = description
      .split(/[,\s.()]+/)
      .map(token => token.trim())
      .filter(Boolean);
    if (candidates.some(candidate => isLanguageBuiltinName(candidate))) return true;
  }
  return false;
}

function hasProductDomainDescriptionMismatch(description: string, output: CASOutput): boolean {
  const lower = description.toLowerCase();
  const productText = [
    output.enhanced_system_purpose?.primary_domain || '',
    ...(output.enhanced_system_purpose?.core_concepts || []),
    ...(output.system_capabilities || []).map(capability => capability.name),
  ].join(' ').toLowerCase();

  if (/\b(solana|arbitrage|dex|cex|liquidity|trading)\b/.test(productText) &&
    /\btoken authentication\b|\bauthentication tokens\b|\bidentity sessions?\b/.test(lower)) {
    return true;
  }

  return false;
}

function hasStaleNarrativePattern(description: string, previousDomain: string | undefined, output: CASOutput): boolean {
  const lower = description.toLowerCase();
  const nextDomain = output.enhanced_system_purpose?.primary_domain || '';
  if (/\b(?:manages|coordinates?)\s+[^.]{3,140}\s+workflows\b/i.test(description)) return true;
  if (/\bworkflows?\s+to\s+produce\s+and\s+manage\b/i.test(description)) return true;
  if (/\bmain (?:grounded |product )?concepts are\b/i.test(description)) return true;
  if (/\bservice records?\b/i.test(description)) return true;
  if (/\bzero[- ]trust security system\b/i.test(description) && !/\bzero[- ]trust|network-access|security\b/i.test(nextDomain)) return true;

  const previous = previousDomain || '';
  if (previous && nextDomain && previous !== nextDomain) {
    const previousTokens = new Set(previous.split(/[-_\s]+/).filter(Boolean));
    const nextTokens = nextDomain.split(/[-_\s]+/).filter(Boolean);
    const overlaps = nextTokens.some(token => previousTokens.has(token));
    if (!overlaps) return true;
  }

  if (nextDomain === 'user-identity-management' &&
    /\b(document collaboration|collection organization|knowledge base|wallet withdrawal|decrypt|encrypt|proxy)\b/i.test(description)) {
    return true;
  }
  if (/^(solana-trading|solana-arbitrage|portfolio-management)$/.test(nextDomain) &&
    /\bzero[- ]trust|commerce platform|product catalog|cart and checkout|order fulfillment|knowledge base\b/i.test(lower)) {
    return true;
  }
  if (nextDomain === 'fleet-management' &&
    /\bcommerce platform|product catalog|cart and checkout|order fulfillment|knowledge base\b/i.test(lower)) {
    return true;
  }

  return false;
}

export async function analyzeProject(projectPath: string, displayName?: string): Promise<CASOutput> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  // Measured BEFORE acquiring a lane permit so the queue can order by size —
  // acquiring first would defeat the point (the job would already be running).
  const sizeHint = await estimateProjectSizeHint(projectPath);
  return withProjectAnalysisLock(projectPath, () => withAnalysisLane(async (orch) => {
    orch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));
    const conventions = await loadConventionsForAnalysis(projectPath);
    const packGlobs = await loadPackGlobsForAnalysis(projectPath);
    const previousOutput = await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
    const result = await applyStoredElementDescriptions(projectPath, preservePreviousAIDescriptions(
      previousOutput,
      await orch.orchestrateAnalysis(projectPath, { displayName, conventions, packGlobs })
    ));

    await saveAnalysis(projectPath, result);
    clearFreshnessSummaryCache();
    await saveAnalysisSnapshot(projectPath, result);

    // Backfill: an analysis now exists, so re-correlate any runtime observations
    // that were persisted as `unmatched` before this project was analyzed and
    // upgrade the ones that now bind to a CAS node. Best-effort and non-blocking
    // to the returned CAS — telemetry backfill must never fail an analysis.
    await backfillIngestedTelemetry(result, projectPath).catch(() => undefined);

    return result;
  }, sizeHint, projectPath));
}

/**
 * Result of a deferred (progressive) analysis. `output` is the deterministic
 * CAS, already saved and safe to return to the caller immediately. `enrichment`
 * is a promise that resolves after the background AI enrichment has completed
 * and been re-saved (or immediately if there was nothing to enrich). Callers
 * that don't care can ignore it — errors are swallowed internally. Tests await
 * it to observe the 'ready' state deterministically.
 */
export interface DeferredAnalysisResult {
  output: CASOutput;
  enrichment: Promise<void>;
}

/**
 * Progressive-availability entrypoint: run the DETERMINISTIC analysis, save it
 * and return it immediately (ai_enrichment='pending'|'disabled'), then run the
 * slow AI enrichment in the background and re-save the upgraded CAS
 * (ai_enrichment='ready'). The next loadAnalysis picks up the enriched version.
 *
 * The background task re-uses the per-project file lock so the enrich re-save
 * never races a concurrent analysis of the same project, and re-acquires a
 * bounded lane permit (KLAURO_ANALYSIS_LANES) so deferred AI passes count
 * against the same concurrency cap as full analyses; it swallows all errors
 * (logging only) so a failed enrichment can never crash the process — the
 * deterministic CAS stays stored.
 */
export async function analyzeProjectDeferred(projectPath: string, displayName?: string): Promise<DeferredAnalysisResult> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  // enrichAnalysisAI(output) below must run on the SAME orchestrator instance
  // that produced `output`: orchestrateAnalysis stashes the deferred-enrichment
  // closure in a WeakMap keyed by the output object, held only on `this`
  // (packages/analyzer-core/src/analyzer/core/orchestrator.ts). So this call
  // owns one dedicated orchestrator instance across both phases, but only
  // holds a lane pool *permit* (the bounded-concurrency slot) while each phase
  // is actually running — the permit is released between the deterministic
  // phase and the background AI phase so other analyses can use that slot
  // while this one's enrichment is deferred/queued.
  const dedicatedOrch = createOrchestrator();
  // Measured BEFORE acquiring a lane permit so the queue can order by size.
  const sizeHint = await estimateProjectSizeHint(projectPath);

  const output = await withProjectAnalysisLock(projectPath, () => withLanePermit(async () => {
    dedicatedOrch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));
    const conventions = await loadConventionsForAnalysis(projectPath);
    const packGlobs = await loadPackGlobsForAnalysis(projectPath);
    const previousOutput = await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
    const result = await applyStoredElementDescriptions(projectPath, preservePreviousAIDescriptions(
      previousOutput,
      await dedicatedOrch.orchestrateAnalysis(projectPath, { deferAiEnrichment: true, displayName, conventions, packGlobs })
    ));

    await saveAnalysis(projectPath, result);
    clearFreshnessSummaryCache();
    await saveAnalysisSnapshot(projectPath, result);

    return result;
  }, sizeHint, projectPath));

  // Nothing to enrich (no AI provider, or already enriched) → done.
  if (output.ai_enrichment !== 'pending') {
    return { output, enrichment: Promise.resolve() };
  }

  // Fire-and-forget: run the AI phase in the background, then re-save the
  // upgraded CAS. Guarded by the project lock + a bounded lane permit + a
  // catch so it can never crash.
  const enrichment = withProjectAnalysisLock(projectPath, () => withLanePermit(async () => {
    await dedicatedOrch.enrichAnalysisAI(output);
    await saveAnalysis(projectPath, output);
    clearFreshnessSummaryCache();
    await saveAnalysisSnapshot(projectPath, output);
  }, output.nodes.length, projectPath)).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Comprehension is AI-only (docs/cas/DETERMINISM-BOUNDARY.md). A failed AI
    // pass is a VISIBLE terminal state, never a silent stay-pending: mark
    // ai_enrichment='error' and persist it so pollers see L5 failed instead of
    // waiting forever. There is NO deterministic comprehension substitute; the
    // Camp-B structure remains stored, comprehension fields stay unset.
    output.ai_enrichment = 'error';
    // Capture the UNDERLYING reason so it's queryable via the API (surfaced
    // onto layers_ready L5.error), not just in this container's stderr. This is
    // the difference between "AI comprehension pass failed" (generic) and the
    // real cause ("AI interpretation budget exceeded" / a provider 401/429 /
    // a grounding-gate rejection) an operator needs to act on.
    output.ai_enrichment_error = message;
    try {
      await withProjectAnalysisLock(projectPath, () => withLanePermit(async () => {
        await saveAnalysis(projectPath, output);
        clearFreshnessSummaryCache();
        await saveAnalysisSnapshot(projectPath, output);
      }, undefined, projectPath));
    } catch (saveError) {
      const saveMessage = saveError instanceof Error ? saveError.message : String(saveError);
      console.error(`[Klauro] failed to persist ai_enrichment='error' for ${projectPath} (${saveMessage})`);
    }
    console.error(`[Klauro] deferred AI enrichment FAILED for ${projectPath} (${message}); marked ai_enrichment='error' (comprehension is AI-only, no deterministic substitute)`);
  });

  return { output, enrichment };
}

/**
 * Result of the layered/progressive entrypoint. `l0` resolves in seconds (the
 * fast index/inventory pre-pass, persisted before the deterministic pipeline
 * runs) so callers who only need "has this project been touched yet" can act
 * immediately. `rest` resolves once L1-L4 (and, if configured, L5 AI
 * enrichment) have landed and been saved — the same DeferredAnalysisResult
 * analyzeProjectDeferred always returned. Both promises resolve against the
 * SAME saved analysis lineage: the L1-L4 save supersedes the L0-only stub,
 * and (if AI is configured) the enrichment save supersedes that in turn. A
 * caller that only awaits `l0` and returns has a valid, honestly-partial CAS
 * on disk the whole time — `layers_ready` on it says exactly what's missing.
 */
export interface LayeredAnalysisResult {
  l0: Promise<CASOutput>;
  rest: Promise<DeferredAnalysisResult>;
}

/**
 * Progressive-layering entrypoint (task #112): compute and PERSIST the L0
 * index/inventory first — a pure filesystem walk with no dependency on the
 * analyzer pipeline, so it lands in seconds — before the full deterministic
 * pass (L1-L4, still one entangled block inside AnalyzerOrchestrator) and the
 * existing L5 AI-enrichment deferral run to completion. Every intermediate
 * save is a fully honest CASOutput: `layers_ready` always reflects what has
 * actually landed on THIS stored copy, and no layer's fields are fabricated
 * ahead of that layer completing. The final saved CAS is byte-for-byte what
 * analyzeProjectDeferred/analyzeProject would have produced on their own —
 * this only changes WHEN facts become queryable, never what they are.
 */
export async function analyzeProjectLayered(projectPath: string, displayName?: string): Promise<LayeredAnalysisResult> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const { computeL0Index, buildL0OnlyCas } = await import('./layered-analysis');

  const l0Promise = (async () => {
    const l0Index = await computeL0Index(projectPath);
    const l0Cas = buildL0OnlyCas(projectPath, displayName, l0Index);
    // Best-effort, zero-wait: if a fuller analysis is already queued/running
    // under the project lock, skip the L0 stub immediately rather than block
    // seconds-scale availability on it (previously this waited out the FULL
    // lock timeout — up to 120s in prod — before giving up anyway, since the
    // fuller save always supersedes the L0 stub moments later regardless).
    // withProjectAnalysisLockIfAvailable only ever short-circuits a lock held
    // by a LIVE holder; a genuinely stale lock is still reclaimed as before.
    const lockAttempt = await withProjectAnalysisLockIfAvailable(projectPath, async () => {
      const existing = await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
      // Never regress a more-complete stored analysis back down to an L0-only
      // stub (e.g. a re-analyze racing an already-fresh CAS on disk).
      if (existing && (existing.layers_ready?.complete ?? true) && (existing.nodes?.length ?? 0) > 0) {
        return;
      }
      await saveAnalysis(projectPath, l0Cas);
      clearFreshnessSummaryCache();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Klauro] L0 index save failed for ${projectPath} (${message}); continuing to full analysis`);
      return { acquired: false as const };
    });
    if (!lockAttempt.acquired) {
      console.error(`[Klauro] L0 index save skipped for ${projectPath}: analysis.lock is already held by an in-progress analysis; the full analysis will supersede the L0 index anyway`);
    }
    return l0Cas;
  })();

  const restPromise = l0Promise.then(async () => {
    const { buildLayersReady } = await import('./layered-analysis');

    // WARM PATH: when a previous COMPLETE analysis exists for this workspace,
    // take the incremental pipeline instead of a full deferred pass. Change
    // detection is content-hash based, so a customer's warm re-push (snapshot
    // rewritten, few files actually different) analyzes only the changed files
    // — seconds instead of a full re-analysis. Falls through to the full
    // deferred pass on any doubt (no previous, L0-only stub, or incremental
    // throwing) so cold behavior is unchanged.
    const previous = await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
    const hasCompletePrevious = Boolean(
      previous && (previous.layers_ready?.complete ?? true) && (previous.nodes?.length ?? 0) > 0
    );
    let deferred: DeferredAnalysisResult;
    if (hasCompletePrevious) {
      try {
        const incremental = await analyzeProjectIncremental(projectPath, displayName);
        deferred = { output: incremental.output, enrichment: Promise.resolve() };
      } catch (error) {
        // The loop-breaker's refusal must NOT be swallowed by this fallback:
        // analyzeProjectDeferred always runs a full rebuild unconditionally,
        // with no version-mismatch guard of its own, so falling back here
        // would immediately repeat the exact doomed rebuild the guard just
        // refused — defeating it entirely. Propagate it as a hard failure of
        // this layered pass instead.
        if (error instanceof AnalysisLoopBreakerError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Klauro] warm incremental pass failed for ${projectPath} (${message}); falling back to full deferred analysis`);
        deferred = await analyzeProjectDeferred(projectPath, displayName);
      }
    } else {
      deferred = await analyzeProjectDeferred(projectPath, displayName);
    }

    // Stamp the full ladder onto the landed CAS: L1-L4 are ready the moment
    // orchestrateAnalysis returns (they're produced as one entangled block —
    // see layered-analysis.ts for why), L5 mirrors the pre-existing
    // ai_enrichment marker so `layers_ready` is a single place to read the
    // whole ladder instead of two fields with different vocabularies.
    const now = new Date().toISOString();
    // Anchor the ladder's generated_at to the CAS content timestamp so a no-op
    // incremental (which reuses previousOutput verbatim, keeping its older
    // analysis_timestamp) doesn't advertise a fresh generated_at over stale
    // content. Falls back to wall-clock only when the output lacks a timestamp.
    const contentGeneratedAt = deferred.output.analysis_timestamp || now;
    const aiConfigured = deferred.output.ai_enrichment !== undefined && deferred.output.ai_enrichment !== 'disabled';
    deferred.output.layers_ready = buildLayersReady({
      L0: { status: 'ready', completedAt: contentGeneratedAt },
      L1: { status: 'ready', completedAt: contentGeneratedAt },
      L2: { status: 'ready', completedAt: contentGeneratedAt },
      L3: { status: 'ready', completedAt: contentGeneratedAt },
      L4: { status: 'ready', completedAt: contentGeneratedAt },
      L5: { status: aiConfigured ? (deferred.output.ai_enrichment === 'ready' || deferred.output.ai_enrichment === 'synchronous' ? 'ready' : 'pending') : 'ready' },
    }, { generatedAt: contentGeneratedAt });
    await saveAnalysis(projectPath, deferred.output);
    clearFreshnessSummaryCache();

    // If L5 is still enriching in the background, re-stamp layers_ready once
    // that promise resolves and re-save — mirrors analyzeProjectDeferred's own
    // re-save-on-enrich, adding the manifest flip so a caller polling
    // layers_ready sees L5 flip too. Comprehension is AI-only
    // (docs/cas/DETERMINISM-BOUNDARY.md): L5 flips to 'ready' on success or
    // 'error' on a failed AI pass — it NEVER stays 'pending' forever, and the
    // failure is surfaced visibly (never a deterministic substitute).
    const enrichment = deferred.enrichment.then(async () => {
      const baseLayers = {
        L0: { status: 'ready' as const }, L1: { status: 'ready' as const }, L2: { status: 'ready' as const },
        L3: { status: 'ready' as const }, L4: { status: 'ready' as const },
      };
      // L5 landing IS a genuine content change, so anchor generated_at to the
      // (possibly refreshed) content timestamp rather than reverting to the
      // deterministic-pass time. Falls back to the L5 completion instant.
      const l5GeneratedAt = deferred.output.analysis_timestamp || new Date().toISOString();
      if (deferred.output.ai_enrichment === 'ready') {
        deferred.output.layers_ready = buildLayersReady({
          ...baseLayers,
          L5: { status: 'ready', completedAt: new Date().toISOString() },
        }, { generatedAt: l5GeneratedAt });
      } else if (deferred.output.ai_enrichment === 'error') {
        // Visible terminal failure: L5 'error', not a silent stay-pending.
        // Surface the UNDERLYING reason (captured on ai_enrichment_error by
        // analyzeProjectDeferred's catch) so the real cause is queryable via
        // the API, not just in container stderr; fall back to the generic
        // message only if the detail wasn't captured.
        const l5Detail = deferred.output.ai_enrichment_error
          ? `AI comprehension pass failed (comprehension is AI-only, no deterministic fallback): ${deferred.output.ai_enrichment_error}`
          : 'AI comprehension pass failed; comprehension is AI-only (no deterministic fallback)';
        deferred.output.layers_ready = buildLayersReady({
          ...baseLayers,
          L5: { status: 'error', completedAt: new Date().toISOString(), error: l5Detail },
        }, { generatedAt: l5GeneratedAt });
      } else {
        // 'disabled'/'synchronous' or nothing to enrich — leave the manifest as
        // the restPromise already stamped it (L5 'ready' when AI isn't coming).
        return;
      }
      await saveAnalysis(projectPath, deferred.output);
      clearFreshnessSummaryCache();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Klauro] layers_ready L5 re-stamp failed for ${projectPath} (${message})`);
    });

    return { output: deferred.output, enrichment };
  });

  return { l0: l0Promise, rest: restPromise };
}

export async function getAnalysis(
  projectPath: string,
  options?: { track?: import('./track').AnalysisTrack }
): Promise<CASOutput> {
  const cached = await loadAnalysis(projectPath, options?.track ? { track: options.track } : undefined);
  if (cached) {
    assertAnalysisVersionSupported(cached, projectPath);
    return applyStoredElementDescriptions(projectPath, cached);
  }
  throw new Error(`No analysis found for: ${projectPath}. Run analyze_codebase first.`);
}

export interface IncrementalAnalysisResult {
  output: CASOutput;
  state: IncrementalState;
  changeReport: ChangeReport;
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
  previousCasVersion?: string;
}

const DEFAULT_INCREMENTAL_SNAPSHOT_INTERVAL_MS = 60_000;

function getIncrementalSnapshotIntervalMs(): number {
  const raw = process.env.KLAURO_INCREMENTAL_SNAPSHOT_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_INCREMENTAL_SNAPSHOT_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_INCREMENTAL_SNAPSHOT_INTERVAL_MS;
}

async function shouldSaveIncrementalSnapshot(projectPath: string, result: IncrementalAnalysisResult): Promise<boolean> {
  if (result.wasFullRebuild) return true;
  const intervalMs = getIncrementalSnapshotIntervalMs();
  if (intervalMs === 0) return true;

  try {
    const snapshots = await listAnalysisSnapshots(projectPath);
    const latest = snapshots[0]?.timestamp ? new Date(snapshots[0].timestamp).getTime() : 0;
    if (!latest || Number.isNaN(latest)) return true;
    return Date.now() - latest >= intervalMs;
  } catch {
    return true;
  }
}

function makeEdgeId(edge: { id?: string; source: string; target: string; type: string }): string {
  return edge.id || `edge_${edge.source}_${edge.target}_${edge.type}`;
}

function hasReportChanges(report: ChangeReport): boolean {
  const summary = report.summary;
  return summary.filesAdded > 0 ||
    summary.filesModified > 0 ||
    summary.filesDeleted > 0 ||
    summary.nodesAdded > 0 ||
    summary.nodesModified > 0 ||
    summary.nodesDeleted > 0 ||
    summary.edgesAdded > 0 ||
    summary.edgesModified > 0 ||
    summary.edgesDeleted > 0 ||
    (report.details.addedEntryPoints?.length || 0) > 0 ||
    (report.details.modifiedEntryPoints?.length || 0) > 0 ||
    (report.details.deletedEntryPoints?.length || 0) > 0 ||
    (report.details.addedExitPoints?.length || 0) > 0 ||
    (report.details.deletedExitPoints?.length || 0) > 0;
}

function hasCasReportChanges(report: ChangeReport): boolean {
  const summary = report.summary;
  return summary.nodesAdded > 0 ||
    summary.nodesModified > 0 ||
    summary.nodesDeleted > 0 ||
    summary.edgesAdded > 0 ||
    summary.edgesModified > 0 ||
    summary.edgesDeleted > 0 ||
    (report.details.addedEntryPoints?.length || 0) > 0 ||
    (report.details.modifiedEntryPoints?.length || 0) > 0 ||
    (report.details.deletedEntryPoints?.length || 0) > 0 ||
    (report.details.addedExitPoints?.length || 0) > 0 ||
    (report.details.deletedExitPoints?.length || 0) > 0;
}

function buildChangeHistoryEntry(result: IncrementalAnalysisResult): ChangeHistoryEntry {
  const report = result.changeReport;
  const details = report.details;

  return {
    id: `change_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: report.timestamp,
    gitCommitHash: result.state.gitCommitHash,
    source: 'unknown',
    changes: {
      files: details.files || [],
      nodes: [
        ...details.addedNodes.map(node => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          file: node.file,
          changeType: 'added' as const,
        })),
        ...details.modifiedNodes.map(node => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type || 'unknown',
          file: node.file || 'unknown',
          changeType: 'modified' as const,
          semanticChange: node.changes.join(', '),
        })),
        ...details.deletedNodes.map(node => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          file: node.file || 'unknown',
          changeType: 'deleted' as const,
        })),
      ],
      edges: [
        ...details.addedEdges.map(edge => ({
          edgeId: makeEdgeId(edge),
          source: edge.source,
          target: edge.target,
          edgeType: edge.type,
          changeType: 'added' as const,
        })),
        ...details.deletedEdges.map(edge => ({
          edgeId: makeEdgeId(edge),
          source: edge.source,
          target: edge.target,
          edgeType: edge.type,
          changeType: 'deleted' as const,
        })),
      ],
      entryPoints: [
        ...(details.addedEntryPoints || []).map(entryPoint => ({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          changeType: 'added' as const,
        })),
        ...(details.modifiedEntryPoints || []).map(entryPoint => ({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          changeType: 'modified' as const,
          details: entryPoint.details,
        })),
        ...(details.deletedEntryPoints || []).map(entryPoint => ({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          changeType: 'deleted' as const,
        })),
      ],
      exitPoints: [
        ...(details.addedExitPoints || []).map(exitPoint => ({
          exitPointId: exitPoint.id,
          name: exitPoint.name,
          changeType: 'added' as const,
        })),
        ...(details.deletedExitPoints || []).map(exitPoint => ({
          exitPointId: exitPoint.id,
          name: exitPoint.name,
          changeType: 'deleted' as const,
        })),
      ],
    },
    semanticSummary: result.wasFullRebuild
      ? 'Full rebuild triggered'
      : `${report.summary.filesAdded + report.summary.filesModified + report.summary.filesDeleted} files changed; ${report.summary.nodesAdded} nodes added, ${report.summary.nodesModified} modified, ${report.summary.nodesDeleted} deleted`,
    intent: {
      type: 'unknown' as const,
      confidence: 0,
      evidence: [],
    },
    impact: report.impact,
    suggestedActions: [],
    breakingChanges: [],
    minimumTestSet: [],
  };
}

// --- Analysis lane pool ------------------------------------------------
//
// Each concurrent analysis must get its own orchestrator instance
// (createOrchestrator(), cheap: construction is just building/registering
// analyzer objects, no I/O) — a shared singleton carries per-analysis mutable
// state (active project path, discovery/inventory caches, embedding config),
// so concurrent analyses of different projects would interleave and clobber
// each other's state. withProjectAnalysisLock is the only serialization
// same-path runs need. Concurrency stays bounded by a small permit pool since
// analysis is CPU/memory-heavy; unbounded parallelism would thrash the VPS.
//
// Server-side config only (KLAURO_ANALYSIS_CONCURRENCY, with the older
// KLAURO_ANALYSIS_LANES name kept as a fallback) — not customer-facing.
const DEFAULT_ANALYSIS_LANES = 2;

function getAnalysisLaneCount(): number {
  const raw = process.env.KLAURO_ANALYSIS_CONCURRENCY ?? process.env.KLAURO_ANALYSIS_LANES;
  if (raw === undefined || raw === '') return DEFAULT_ANALYSIS_LANES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_ANALYSIS_LANES;
}

// --- Memory guard --------------------------------------------------------
//
// A whale analysis (tens of thousands of nodes) already holds significant
// heap; admitting a SECOND concurrent one under memory pressure risks an OOM
// that takes the whole process (and every in-flight analysis) down with it.
// This guard only ever reduces the effective lane count to 1 — it never
// blocks a lone in-flight analysis, so a single whale always makes forward
// progress regardless of memory pressure. Container cgroup usage is
// authoritative when readable (this process runs in a container with a real
// memory ceiling); RSS-vs-fixed-threshold is the fallback for environments
// (dev laptops, `tsc`/test runs) where cgroup files aren't present.
const DEFAULT_MEMORY_RSS_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
const DEFAULT_MEMORY_CONTAINER_RATIO = 0.7; // 70% of the container limit

function getMemoryRssLimitBytes(): number {
  const raw = process.env.KLAURO_ANALYSIS_MEMORY_RSS_LIMIT_BYTES;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MEMORY_RSS_LIMIT_BYTES;
}

function getMemoryContainerRatio(): number {
  const raw = process.env.KLAURO_ANALYSIS_MEMORY_CONTAINER_RATIO;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_MEMORY_CONTAINER_RATIO;
}

/** Reads cgroup v2 then v1 memory usage/limit. Returns null if neither is
 *  readable or the limit is effectively "unlimited" (cgroup v1 reports huge
 *  sentinel values for no limit) — callers fall back to the RSS check. */
function readContainerMemory(): { usage: number; limit: number } | null {
  try {
    const limit = Number(nodeFs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim());
    const usage = Number(nodeFs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(usage)) return { usage, limit };
  } catch { /* not cgroup v2, or unreadable outside a container */ }
  try {
    const limit = Number(nodeFs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
    const usage = Number(nodeFs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim());
    // cgroup v1's "no limit" sentinel is close to 2^63 bytes; anything above
    // 1TB is treated as unlimited so it falls through to the RSS check.
    if (Number.isFinite(limit) && limit > 0 && limit < 1024 ** 4 && Number.isFinite(usage)) {
      return { usage, limit };
    }
  } catch { /* not cgroup v1, or unreadable outside a container */ }
  return null;
}

/** Test-only override so tests can force tight/loose memory deterministically
 *  instead of depending on the actual host's memory state. */
let memoryGuardOverrideForTests: (() => boolean) | null = null;

function isMemoryTight(): boolean {
  if (memoryGuardOverrideForTests) return memoryGuardOverrideForTests();
  const container = readContainerMemory();
  if (container) return container.usage / container.limit > getMemoryContainerRatio();
  return process.memoryUsage().rss > getMemoryRssLimitBytes();
}

/** Test-only: force the memory guard to report tight (`true`), loose
 *  (`false`), or restore real measurement (`null`). */
export function __setMemoryGuardOverrideForTests(override: boolean | null): void {
  memoryGuardOverrideForTests = override === null ? null : () => override;
}

// --- Size-aware, starvation-bounded wait queue ---------------------------
//
// Counting semaphore: `permitsInUse` vs. the configured lane count. Callers
// beyond capacity queue with a size hint (smaller project = smaller hint) so
// a freed slot goes to the SMALLEST waiting job, not strict FIFO — a small
// repo's re-analyze should never sit behind a whale's 40-minute rebuild just
// because it asked second. Pure shortest-job-first can starve the whale
// forever if smaller jobs keep arriving, so any waiter old enough
// (KLAURO_ANALYSIS_QUEUE_MAX_WAIT_MS, default 15 minutes) is promoted ahead
// of size ordering — every waiter's worst case is bounded wait, not
// indefinite wait.
const DEFAULT_QUEUE_MAX_WAIT_MS = 15 * 60 * 1000;

function getQueueMaxWaitMs(): number {
  const raw = process.env.KLAURO_ANALYSIS_QUEUE_MAX_WAIT_MS;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUEUE_MAX_WAIT_MS;
}

interface LaneWaiter {
  resolve: () => void;
  /** Smaller = higher priority. Unknown-size jobs use +Infinity so known
   *  small jobs are never made to wait behind an unmeasured one; age-based
   *  promotion still bounds their worst-case wait. */
  sizeHint: number;
  enqueuedAt: number;
}

let permitsInUse = 0;
let laneWaiters: LaneWaiter[] = [];

/** Picks the waiter that should get the next freed permit: the oldest
 *  waiter past the starvation threshold if any, otherwise the smallest
 *  sizeHint (ties broken by earliest arrival). Returns -1 if the queue is
 *  empty. */
function pickNextWaiterIndex(): number {
  if (laneWaiters.length === 0) return -1;
  const now = Date.now();
  const maxWaitMs = getQueueMaxWaitMs();

  let promotedIdx = -1;
  let promotedEnqueuedAt = Infinity;
  for (let i = 0; i < laneWaiters.length; i++) {
    const waiter = laneWaiters[i];
    if (now - waiter.enqueuedAt >= maxWaitMs && waiter.enqueuedAt < promotedEnqueuedAt) {
      promotedIdx = i;
      promotedEnqueuedAt = waiter.enqueuedAt;
    }
  }
  if (promotedIdx !== -1) return promotedIdx;

  let bestIdx = 0;
  for (let i = 1; i < laneWaiters.length; i++) {
    const candidate = laneWaiters[i];
    const best = laneWaiters[bestIdx];
    if (
      candidate.sizeHint < best.sizeHint ||
      (candidate.sizeHint === best.sizeHint && candidate.enqueuedAt < best.enqueuedAt)
    ) {
      bestIdx = i;
    }
  }
  return bestIdx;
}

function acquireLanePermit(sizeHint: number): Promise<void> {
  const capacity = getAnalysisLaneCount();
  // The memory guard only ever caps the SECOND+ concurrent slot at 1 — a lone
  // in-flight analysis is never gated by it.
  const effectiveCapacity = permitsInUse >= 1 && isMemoryTight() ? 1 : capacity;
  if (permitsInUse < effectiveCapacity) {
    permitsInUse += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    laneWaiters.push({ resolve, sizeHint, enqueuedAt: Date.now() });
  });
}

function releaseLanePermit(): void {
  const idx = pickNextWaiterIndex();
  if (idx !== -1) {
    // Hand the freed permit straight to the chosen waiter (permitsInUse stays
    // the same — it never actually dropped below capacity).
    const [waiter] = laneWaiters.splice(idx, 1);
    waiter.resolve();
    return;
  }
  permitsInUse = Math.max(0, permitsInUse - 1);
}

/** Best-effort size hint for queue ordering: the previously-analyzed node
 *  count for this project (cheap cached read), or +Infinity when there is no
 *  previous analysis to measure from (a cold/first-ever analysis is never
 *  assumed small — see the queue-ordering comment above). Never throws: a
 *  failed read just falls back to the unknown-size default. */
async function estimateProjectSizeHint(projectPath: string): Promise<number> {
  try {
    const previous = await loadAnalysis(projectPath, { preferCache: true });
    const nodeCount = previous?.nodes?.length;
    if (typeof nodeCount === 'number' && Number.isFinite(nodeCount)) return nodeCount;
  } catch { /* no previous analysis, or unreadable — treat as unknown-size */ }
  return Number.POSITIVE_INFINITY;
}

// --- Wall-clock watchdog --------------------------------------------------
//
// Must make a hung analysis visible and non-permanent: a hang inside a lane
// otherwise leaves last_attempt reading 'in-progress' forever and starves every
// other queued analysis behind the occupied lane permits, with nothing alarming.
//
// Cannot preempt a hang caused by synchronous/native computation (e.g. a
// runaway regex) — there is no way to abort that from JS once started. It can
// only stop waiting on `fn`: free the lane permit and write a visible
// 'watchdog-timeout' failure. A later actual completion of `fn` is logged,
// never silently re-applied over the failure record already written.
//
// withLanePermit is normally called from inside withProjectAnalysisLock, so
// rejecting early here also unwinds that outer lock before the zombie
// computation has actually stopped touching the project's storage — accepted
// as better than holding analysis.lock hostage to an unpreemptable hang forever.
const DEFAULT_ANALYSIS_WATCHDOG_MS = 30 * 60_000; // 30 minutes

function getAnalysisWatchdogMs(): number {
  const raw = process.env.KLAURO_ANALYSIS_WATCHDOG_MS;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ANALYSIS_WATCHDOG_MS;
}

// --- Internal/boot rebuild attempt visibility ------------------------------
// An internal, version-triggered full rebuild (schemaRebuildReason branch)
// must leave a visible attempt record — unlike the HTTP-driven reanalyze
// paths, nothing else writes a sidecar for this internally-triggered path, so
// a poller would otherwise see only the old analysis with no sign a newer,
// possibly hung, attempt is in flight.
//
// Mirrors remote-analyzer-service.ts's ReanalyzeAttemptRecord shape and path
// convention so the existing last-attempt surface picks these up too, without
// this module importing from remote-analyzer-service.ts. Written only when a
// version mismatch is plausible — never on the common no-op incremental pass.
interface InternalRebuildAttemptRecord {
  state: 'in-progress' | 'succeeded' | 'failed';
  trigger: 'version-rebuild';
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  reason?: string;
  /**
   * The exact (stored -> current) cas_version pair this attempt was rebuilding
   * for. Recorded so a LATER attempt can tell whether it is about to retry the
   * SAME rebuild that already failed (loop-breaker below) versus a genuinely
   * new one (e.g. a subsequent deploy bumped the version again).
   */
  stored_version?: string;
  current_version?: string;
}

function internalRebuildAttemptPath(projectPath: string): string {
  return path.join(projectPath, '.reanalyze-attempt.json');
}

async function writeInternalRebuildAttempt(projectPath: string, record: InternalRebuildAttemptRecord): Promise<void> {
  try {
    await writeJsonAtomic(internalRebuildAttemptPath(projectPath), record);
  } catch {
    /* best-effort: attempt visibility must never mask or block the rebuild it describes */
  }
}

async function readInternalRebuildAttempt(projectPath: string): Promise<InternalRebuildAttemptRecord | null> {
  try {
    if (!nodeFs.existsSync(internalRebuildAttemptPath(projectPath))) return null;
    return await fs.readJson(internalRebuildAttemptPath(projectPath));
  } catch {
    return null;
  }
}

/**
 * Thrown when a version-bump full rebuild already failed with a
 * worker-oom/watchdog reason for this exact (stored_version -> current_version)
 * pair — the infinite-crash-loop breaker: without this, a restart-and-retrigger
 * cycle repeats the same doomed rebuild forever, reading as "in-progress" each
 * time rather than a repeating failure. Only trips on the memory/hang
 * signature; a real code bug or transient I/O error does not trip this guard.
 * Requires an explicit re-trigger (e.g. after raising KLAURO_ANALYSIS_HEAP_MB) to clear.
 */
export class AnalysisLoopBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisLoopBreakerError';
  }
}

function isDoomedRebuildReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /worker-oom|reached heap limit|javascript heap out of memory|fatal error|watchdog-timeout|killed by signal|exhausting its heap/i.test(reason);
}

async function guardAgainstDoomedVersionRebuild(
  projectPath: string,
  versionInfo: { stored_version?: string; current_version: string },
): Promise<void> {
  if (!versionInfo.stored_version || versionInfo.stored_version === versionInfo.current_version) return;
  const previousAttempt = await readInternalRebuildAttempt(projectPath);
  if (
    previousAttempt?.state === 'failed' &&
    previousAttempt.stored_version === versionInfo.stored_version &&
    previousAttempt.current_version === versionInfo.current_version &&
    isDoomedRebuildReason(previousAttempt.reason)
  ) {
    const message = [
      `loop-breaker: refusing to auto-retrigger the version-rebuild for ${projectPath}`,
      `(stored_version=${versionInfo.stored_version} -> current_version=${versionInfo.current_version}).`,
      `The previous attempt (finished ${previousAttempt.finished_at ?? previousAttempt.started_at}) already FAILED`,
      `with a worker-oom/watchdog reason: ${previousAttempt.reason}.`,
      `Auto-retriggering an identical rebuild would repeat the same crash indefinitely`,
      `(the 2026-07-18 infinite-crash-loop incident). Leaving the failed attempt record in place;`,
      `a human or agent must explicitly re-trigger (e.g. a force_full reanalyze) after addressing`,
      `the cause (raise KLAURO_ANALYSIS_HEAP_MB, reduce analysis_focus, or fix the hang).`,
    ].join(' ');
    console.error(`[Klauro] ${message}`);
    throw new AnalysisLoopBreakerError(message);
  }
}

/**
 * Pre-flight, side-effect-free check for callers that must know before
 * writing their own 'in-progress' attempt record whether the next rebuild is
 * a doomed repeat — those callers write the same sidecar file the loop-breaker
 * reads, so an unconditional overwrite would erase its evidence before it can
 * be read. Returns the loop-breaker's message when the next rebuild would be
 * doomed, or null when safe to proceed.
 */
export async function checkDoomedVersionRebuild(projectPath: string): Promise<string | null> {
  try {
    const previousOutput = await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
    if (!previousOutput) return null;
    const versionInfo = getAnalysisVersionInfo(previousOutput);
    await guardAgainstDoomedVersionRebuild(projectPath, versionInfo);
    return null;
  } catch (error) {
    if (error instanceof AnalysisLoopBreakerError) return error.message;
    return null;
  }
}

/** Thrown by withLanePermit when `fn` exceeds KLAURO_ANALYSIS_WATCHDOG_MS
 *  without settling. Callers' existing failure handling (writeAttemptRecord /
 *  markBackgroundAnalysisFailed in remote-analyzer-service.ts) treats this
 *  exactly like any other analysis failure — the message always contains the
 *  literal 'watchdog-timeout' so it's greppable in that reason field. */
export class AnalysisWatchdogTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisWatchdogTimeoutError';
  }
}

/** Best-effort "what was it last doing" signal for the watchdog's log line.
 *  The run log (packages/.../core/run-log.ts) only writes a run's `phases`
 *  array when the run finishes (complete or failed) — a hung run never gets
 *  there, so there is no live "current phase" to read. What IS available is
 *  the run-start record for this project, if one was written and no
 *  completion record for the same run_id has landed yet. Never throws. */
function describeLastRunLogState(projectPath: string): string {
  try {
    const records = readRecentRunRecords();
    const finishedRunIds = new Set(
      records.filter((r): r is AnalysisRunFinalRecord => r.event === 'run-complete' || r.event === 'run-failed')
        .map(r => r.run_id)
    );
    const openStarts = records
      .filter((r): r is AnalysisRunStartRecord => r.event === 'run-start' && r.project_path === projectPath && !finishedRunIds.has(r.run_id));
    const latest = openStarts[openStarts.length - 1];
    if (!latest) return 'no open run-log entry found (run log records phases only at completion, so a hung run has nothing further to show)';
    return `run ${latest.run_id} started at ${latest.started_at}, never reached run-complete/run-failed (run log has no live in-progress phase, only phases-at-completion)`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `run log unreadable (${message})`;
  }
}

/**
 * Runs fn bounded to KLAURO_ANALYSIS_CONCURRENCY concurrent analyses (default
 * 2), smallest-project-first with age-based starvation promotion. A crashing
 * analysis releases its permit like any other and never blocks the pool.
 * Also races fn against the wall-clock watchdog (see above). `projectPath`
 * (when passed) is used only in watchdog log lines and run-log lookups.
 */
async function withLanePermit<T>(
  fn: () => Promise<T>,
  sizeHint: number = Number.POSITIVE_INFINITY,
  projectPath: string = 'analysis'
): Promise<T> {
  await acquireLanePermit(sizeHint);
  let permitReleased = false;
  const releasePermitOnce = (): void => {
    if (permitReleased) return;
    permitReleased = true;
    releaseLanePermit();
  };

  const startedAtMs = Date.now();
  const watchdogMs = getAnalysisWatchdogMs();
  let watchdogFired = false;
  const innerPromise = fn();

  let rejectWatchdog!: (error: Error) => void;
  const watchdogPromise = new Promise<never>((_, reject) => { rejectWatchdog = reject; });
  const timer = setTimeout(() => {
    watchdogFired = true;
    const elapsedMinutes = Math.round((Date.now() - startedAtMs) / 60_000);
    console.error(
      `[Klauro] ANALYSIS WATCHDOG FIRED: ${projectPath} has been running ${elapsedMinutes}m, exceeding ` +
      `KLAURO_ANALYSIS_WATCHDOG_MS=${watchdogMs}ms. Last known state: ${describeLastRunLogState(projectPath)}. ` +
      `Releasing its lane permit and marking the attempt failed (reason contains 'watchdog-timeout'). ` +
      `NOTE: this does NOT stop the underlying computation — a JS process stuck in a synchronous/native ` +
      `hang (e.g. catastrophic regex) cannot be preempted from here; this only stops WAITING on it.`
    );
    releasePermitOnce();
    rejectWatchdog(new AnalysisWatchdogTimeoutError(
      `watchdog-timeout: ${projectPath} exceeded ${watchdogMs}ms without completing`
    ));
  }, watchdogMs);
  // Deliberately left ref'd (the default): this timer firing is exactly the
  // signal we need even when nothing else is keeping the process alive
  // (e.g. a lightweight one-off analysis run) — unref'd, an idle event loop
  // could "resolve" before a stuck fn() ever gets flagged.

  innerPromise
    .then(() => {
      if (watchdogFired) {
        console.error(`[Klauro] LATE COMPLETION: ${projectPath} finished successfully AFTER its watchdog already marked the attempt failed and freed the lane. Last-write-wins if this result is re-persisted, but the earlier failure was not silently overwritten.`);
      }
    }, () => {
      if (watchdogFired) {
        console.error(`[Klauro] LATE COMPLETION: ${projectPath} finished (with its own error) AFTER its watchdog already marked the attempt failed and freed the lane.`);
      }
    })
    .finally(() => {
      clearTimeout(timer);
      releasePermitOnce();
    });

  return Promise.race([innerPromise, watchdogPromise]);
}

/**
 * Run fn on a fresh, dedicated orchestrator instance, bounded by the same
 * lane permit pool as withLanePermit. Use this when the caller doesn't need
 * to retain the orchestrator instance beyond the call (analyzeProject,
 * analyzeProjectIncremental); analyzeProjectDeferred manages its own
 * dedicated instance across two phases and uses withLanePermit directly.
 */
function withAnalysisLane<T>(
  fn: (orch: AnalyzerOrchestrator) => Promise<T>,
  sizeHint?: number,
  describe?: string
): Promise<T> {
  return withLanePermit(() => fn(createOrchestrator()), sizeHint, describe);
}

/** Test-only: reset lane pool state (e.g. after changing
 *  KLAURO_ANALYSIS_CONCURRENCY / KLAURO_ANALYSIS_LANES). */
export function __resetAnalysisLanesForTests(): void {
  permitsInUse = 0;
  laneWaiters = [];
  memoryGuardOverrideForTests = null;
}

/** Test-only: exercise the lane pool directly without a real analysis
 *  pipeline (used to verify concurrency, ordering, and crash isolation with
 *  fake slow/failing functions). */
export function __withLanePermitForTests<T>(fn: () => Promise<T>, sizeHint?: number, describe?: string): Promise<T> {
  return withLanePermit(fn, sizeHint, describe);
}

/** Test-only: exercise the OUTER worker-dispatch watchdog directly, without a
 *  real forked child process (which cannot be made to hang deterministically
 *  from a test). Verifies the same fire/free/mark/late-completion semantics
 *  as withLanePermit's inner watchdog, one layer further out. */
export function __withOuterWorkerWatchdogForTests(
  projectPath: string,
  run: () => Promise<AnalysisRunSummary>
): Promise<AnalysisRunSummary> {
  return withOuterWorkerWatchdog(projectPath, run);
}

/** Test-only: read back whatever internal-rebuild attempt record (if any) is
 *  currently on disk for `projectPath`, without needing a real version-bumped
 *  CAS on disk to trigger one. */
export async function __readInternalRebuildAttemptForTests(projectPath: string): Promise<InternalRebuildAttemptRecord | null> {
  return readInternalRebuildAttempt(projectPath);
}

/** Test-only: current in-use permit count, for asserting overlap/exclusivity
 *  without timing-dependent sleeps. */
export function __getLanePermitsInUseForTests(): number {
  return permitsInUse;
}

export async function analyzeProjectIncremental(projectPath: string, displayName?: string): Promise<IncrementalAnalysisResult> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  // Measured BEFORE acquiring a lane permit so the queue can order by size.
  const sizeHint = await estimateProjectSizeHint(projectPath);
  return withProjectAnalysisLock(
    projectPath,
    () => withAnalysisLane((orch) => runIncrementalAnalysis(projectPath, orch, displayName), sizeHint, projectPath),
  );
}

async function runIncrementalAnalysis(projectPath: string, orch: AnalyzerOrchestrator, displayName?: string): Promise<IncrementalAnalysisResult> {
  const debugTimings = process.env.KLAURO_DEBUG_INCREMENTAL_TIMINGS === '1';
  const debug = (label: string, startedAt: number) => {
    if (debugTimings) {
      console.error(`[Klauro] incremental timing ${label}: ${Date.now() - startedAt}ms`);
    }
  };

  orch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));
  const conventions = await loadConventionsForAnalysis(projectPath);
  const packGlobs = await loadPackGlobsForAnalysis(projectPath);

  const previousOutput = await loadAnalysis(projectPath, { preferCache: true });
  const previousState = await loadIncrementalState(projectPath);
  const previousCasVersion = previousOutput
    ? getAnalysisVersionInfo(previousOutput).stored_version
    : undefined;

  if (!previousOutput) {
    let phaseStartedAt = Date.now();
    const result = await orch.orchestrateAnalysis(projectPath, { displayName, conventions, packGlobs });
    debug('initial-orchestrate-full', phaseStartedAt);
    phaseStartedAt = Date.now();
    await saveAnalysis(projectPath, result);
    clearFreshnessSummaryCache();
    debug('initial-save-analysis', phaseStartedAt);

    phaseStartedAt = Date.now();
    const freshResult = await orch.orchestrateIncrementalAnalysis(
      projectPath,
      result,
      null,
      {
        loadCache: (hash) => loadFileCache(projectPath, hash),
        saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult),
        displayName
      }
    );
    debug('initial-build-state', phaseStartedAt);

    phaseStartedAt = Date.now();
    await saveIncrementalState(projectPath, freshResult.state);
    debug('initial-save-state', phaseStartedAt);
    phaseStartedAt = Date.now();
    await saveAnalysisSnapshot(projectPath, freshResult.output);
    debug('initial-save-snapshot', phaseStartedAt);

    return freshResult;
  }

  // Additive attempt-record visibility (see the "Internal/boot rebuild attempt
  // visibility" comment above the Wall-clock watchdog section): if the stored
  // analysis predates the running server's cas_version, orchestrateIncrementalAnalysis
  // is about to enter its schemaRebuildReason branch and run a FULL rebuild —
  // exactly the case that was measured hanging 65+ minutes with zero visible
  // record anywhere. Only this (rare) predicted case pays for the sidecar
  // write; the common no-op incremental pass never touches it.
  const versionInfo = getAnalysisVersionInfo(previousOutput);
  const likelyVersionRebuild = versionInfo.stored_version !== versionInfo.current_version;
  const attemptStartedAt = new Date();
  if (likelyVersionRebuild) {
    // Loop-breaker (incident 2026-07-18): refuse to auto-retrigger the SAME
    // version-bump rebuild that already died from a worker-oom/watchdog cause
    // last time. Thrown BEFORE the 'in-progress' record below so a repeated
    // doomed rebuild never overwrites the informative 'failed' record with a
    // fresh 'in-progress' one that would just fail again — the failed record
    // stays exactly as it was until a human/agent clears the underlying cause.
    await guardAgainstDoomedVersionRebuild(projectPath, versionInfo);
    await writeInternalRebuildAttempt(projectPath, {
      state: 'in-progress',
      trigger: 'version-rebuild',
      started_at: attemptStartedAt.toISOString(),
      reason: `stored cas_version ${versionInfo.stored_version} differs from the running server's cas_version ${versionInfo.current_version}`,
      stored_version: versionInfo.stored_version,
      current_version: versionInfo.current_version,
    });
  }

  let phaseStartedAt = Date.now();
  let result: Awaited<ReturnType<typeof orch.orchestrateIncrementalAnalysis>>;
  try {
    result = await orch.orchestrateIncrementalAnalysis(
      projectPath,
      previousOutput,
      previousState,
      {
        loadCache: (hash) => loadFileCache(projectPath, hash),
        saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult),
        displayName
      }
    );
  } catch (error) {
    if (likelyVersionRebuild) {
      await writeInternalRebuildAttempt(projectPath, {
        state: 'failed',
        trigger: 'version-rebuild',
        started_at: attemptStartedAt.toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - attemptStartedAt.getTime(),
        reason: error instanceof Error ? error.message : String(error),
        stored_version: versionInfo.stored_version,
        current_version: versionInfo.current_version,
      });
    }
    throw error;
  }
  debug('orchestrate-incremental', phaseStartedAt);

  if (likelyVersionRebuild) {
    await writeInternalRebuildAttempt(projectPath, {
      state: 'succeeded',
      trigger: 'version-rebuild',
      started_at: attemptStartedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - attemptStartedAt.getTime(),
      reason: result.fullRebuildReason,
      stored_version: versionInfo.stored_version,
      current_version: versionInfo.current_version,
    });
  }

  if (result.wasFullRebuild && result.output !== previousOutput) {
    // A full rebuild inside the incremental path bypasses the orchestrator's
    // incremental description-reuse hook; keep prior AI descriptions when this
    // rebuild ran without AI instead of downgrading the stored analysis.
    preservePreviousAIDescriptions(previousOutput, result.output);
  }

  const casChanged = hasCasReportChanges(result.changeReport);
  const outputChanged = result.output !== previousOutput || casChanged;
  if (outputChanged) {
    phaseStartedAt = Date.now();
    await saveAnalysis(projectPath, result.output);
    clearFreshnessSummaryCache();
    debug('save-analysis', phaseStartedAt);
  }
  phaseStartedAt = Date.now();
  await saveIncrementalState(projectPath, result.state);
  debug('save-state', phaseStartedAt);

  if (hasReportChanges(result.changeReport)) {
    phaseStartedAt = Date.now();
    await saveChangeHistoryEntry(projectPath, buildChangeHistoryEntry(result));
    debug('save-change-history', phaseStartedAt);
    if (outputChanged && await shouldSaveIncrementalSnapshot(projectPath, result)) {
      phaseStartedAt = Date.now();
      await saveAnalysisSnapshot(projectPath, result.output);
      debug('save-snapshot', phaseStartedAt);
    } else if (outputChanged) {
      debug('skip-snapshot-throttled', Date.now());
    }
  }

  return { ...result, previousCasVersion };
}

export async function getIncrementalState(projectPath: string): Promise<IncrementalState | null> {
  return loadIncrementalState(projectPath);
}

export interface AnalysisChangeSummary {
  files_changed: number;
  nodes_added: number;
  nodes_modified: number;
  nodes_deleted: number;
  risk_level: string;
}

export interface AnalysisRunSummary {
  analysisType: 'full' | 'incremental';
  name: string;
  nodes: number;
  edges: number;
  entryPoints: number;
  analyzersRun: number;
  errors: number;
  phases: unknown[];
  casVersion?: string;
  previousCasVersion?: string;
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
  changeSummary?: AnalysisChangeSummary;
  changeReport?: ChangeReport;
}

function summarizeOutput(projectPath: string, output: CASOutput): Omit<AnalysisRunSummary, 'analysisType' | 'wasFullRebuild'> {
  return {
    name: output.system?.name || projectPath.split('/').pop() || projectPath,
    nodes: output.nodes?.length || 0,
    edges: output.edges?.length || 0,
    entryPoints: output.entry_points?.length || 0,
    analyzersRun: output.analyzer_contributions?.length || 0,
    errors: output.analysis_errors?.length || 0,
    phases: output.analysis_phases || [],
    casVersion: output.cas_version,
  };
}

export function summarizeFullAnalysis(projectPath: string, output: CASOutput): AnalysisRunSummary {
  return {
    ...summarizeOutput(projectPath, output),
    analysisType: 'full',
    wasFullRebuild: true,
  };
}

function trimChangeReportForTransfer(report: ChangeReport, wasFullRebuild: boolean): ChangeReport {
  if (!wasFullRebuild) return report;
  const emptiedDetails = Object.fromEntries(
    Object.entries(report.details || {}).map(([key, value]) => [key, Array.isArray(value) ? [] : value]),
  ) as unknown as ChangeReport['details'];
  return { ...report, details: emptiedDetails };
}

export function summarizeIncrementalAnalysis(projectPath: string, result: IncrementalAnalysisResult): AnalysisRunSummary {
  return {
    ...summarizeOutput(projectPath, result.output),
    analysisType: result.wasFullRebuild ? 'full' : 'incremental',
    wasFullRebuild: result.wasFullRebuild,
    fullRebuildReason: result.fullRebuildReason,
    previousCasVersion: result.previousCasVersion,
    changeReport: trimChangeReportForTransfer(result.changeReport, result.wasFullRebuild),
    changeSummary: result.wasFullRebuild ? undefined : {
      files_changed: result.changeReport.summary.filesAdded +
        result.changeReport.summary.filesModified +
        result.changeReport.summary.filesDeleted,
      nodes_added: result.changeReport.summary.nodesAdded,
      nodes_modified: result.changeReport.summary.nodesModified,
      nodes_deleted: result.changeReport.summary.nodesDeleted,
      risk_level: result.changeReport.impact.riskLevel,
    },
  };
}

/**
 * A phase-completion event for a dispatched 'layered' worker job. Deliberately
 * tiny — id, status, and (on failure) a truncated-free error string — never
 * the CASOutput itself: the worker persists every phase to storage as it
 * lands, so the parent reloads (getAnalysis) whatever it needs instead of
 * carrying it over IPC. `l0` = the fast index/inventory pre-pass; `rest` = the
 * L1-4 deterministic pipeline; `enrichment` = the L5 AI-comprehension tail.
 */
export interface LayeredJobPhaseEvent {
  phase: 'l0' | 'rest' | 'enrichment';
  status: 'succeeded' | 'failed';
  error?: string;
}

/** Small terminal summary for a completed 'layered' worker job — counts and
 *  the final AI-enrichment state, not the CAS itself (see LayeredJobPhaseEvent). */
export interface LayeredRunSummary {
  name: string;
  nodes: number;
  edges: number;
  entryPoints: number;
  analyzersRun: number;
  errors: number;
  casVersion?: string;
  aiEnrichment: CASOutput['ai_enrichment'];
  aiEnrichmentError?: string;
}

export function summarizeLayeredAnalysis(projectPath: string, output: CASOutput): LayeredRunSummary {
  const base = summarizeOutput(projectPath, output);
  return {
    name: base.name,
    nodes: base.nodes,
    edges: base.edges,
    entryPoints: base.entryPoints,
    analyzersRun: base.analyzersRun,
    errors: base.errors,
    casVersion: base.casVersion,
    aiEnrichment: output.ai_enrichment,
    aiEnrichmentError: output.ai_enrichment_error,
  };
}

export interface RunAnalysisOptions {
  forceFull?: boolean;
  /**
   * Real display name for this project, distinct from `projectPath`'s
   * basename when the workspace directory is a hash (e.g. the remote
   * analyzer service writes snapshots to a sha256-derived workspace dir).
   * Threaded through to orchestrateAnalysis so deployable/system names never
   * leak the hash workspace basename.
   */
  displayName?: string;
}

export async function runAnalysisInProcess(projectPath: string, options: RunAnalysisOptions = {}): Promise<AnalysisRunSummary> {
  if (options.forceFull) {
    const output = await analyzeProject(projectPath, options.displayName);
    return summarizeFullAnalysis(projectPath, output);
  }
  const result = await analyzeProjectIncremental(projectPath, options.displayName);
  return summarizeIncrementalAnalysis(projectPath, result);
}

export function analysisRunsInProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KLAURO_ANALYSIS_IN_PROCESS === '1' || env.KLAURO_ANALYSIS_IN_PROCESS === 'true';
}

interface WorkerAnalyzeRequest {
  type: 'analyze';
  id: number;
  projectPath: string;
  forceFull: boolean;
  displayName?: string;
  env: Record<string, string>;
}

// The 'layered' job kind dispatches analyzeProjectLayered's ENTIRE progressive
// pipeline (L0 -> L1-4 -> L5 AI enrichment) into the forked child — see
// analysis-worker.ts's executeLayeredAnalysis. The parent never receives the
// CASOutput itself over IPC, only the small phase-completion messages below
// plus a final LayeredRunSummary; it reloads from storage (getAnalysis) for
// anything it needs, exactly as the sync analyze/diff/sync routes already do
// (275e9dc7). This is what lets the whole layered pass — including the L5 AI
// tail, which can run for minutes — happen OUTSIDE the API process's heap.
interface WorkerLayeredRequest {
  type: 'layered';
  id: number;
  projectPath: string;
  displayName?: string;
  env: Record<string, string>;
}

interface WorkerResultMessage<T = AnalysisRunSummary> {
  type: 'result';
  id: number;
  summary: T;
}

interface WorkerErrorMessage {
  type: 'error';
  id: number;
  message: string;
  stackTop?: string;
}

// Sent zero or more times per 'layered' job, BEFORE its terminal
// result/error message — the parent uses these to drive attempt-record
// lifecycle transitions (queued -> in-progress -> succeeded/failed) without
// waiting for the whole pipeline (including L5 AI enrichment) to finish. Never
// removes the job from `pending`; only the terminal result/error message does.
interface WorkerPhaseMessage extends LayeredJobPhaseEvent {
  type: 'phase';
  id: number;
}

type WorkerResponse = WorkerResultMessage | WorkerErrorMessage | WorkerPhaseMessage;

interface PendingWorkerJob<T = AnalysisRunSummary> {
  projectPath: string;
  startedAtMs: number;
  resolve: (summary: T) => void;
  reject: (error: Error) => void;
  /** Only set for 'layered' jobs; invoked on each phase message, job stays pending. */
  onPhase?: (event: LayeredJobPhaseEvent) => void;
}

interface WorkerHandle {
  child: ChildProcess;
  heap: AnalysisHeapResolution;
  stderrTail: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- holds both
  // AnalysisRunSummary ('analyze' jobs) and LayeredRunSummary ('layered' jobs)
  // pending entries in one map keyed by job id; each dispatch site knows its
  // own concrete T via the resolve/reject closures it constructs.
  pending: Map<number, PendingWorkerJob<any>>;
}

const WORKER_STDERR_TAIL_CHARS = 4096;

let workerHandle: WorkerHandle | null = null;
let nextWorkerJobId = 1;
let workerJobChain: Promise<unknown> = Promise.resolve();

function resolveWorkerEntryPath(): string {
  for (const candidate of ['analysis-worker.cjs', 'analysis-worker.ts']) {
    const candidatePath = path.join(__dirname, candidate);
    if (nodeFs.existsSync(candidatePath)) return candidatePath;
  }
  throw new Error(`Analysis worker entry not found next to ${__dirname}; rebuild the bundle (npm run build).`);
}

function collectKlauroEnvSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('KLAURO_') && value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

function spawnAnalysisWorker(heap: AnalysisHeapResolution): WorkerHandle {
  const child = fork(resolveWorkerEntryPath(), [], {
    execArgv: [...process.execArgv, `--max-old-space-size=${heap.heapMb}`],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: process.env,
  });

  const handle: WorkerHandle = { child, heap, stderrTail: '', pending: new Map() };

  const captureOutput = (chunk: Buffer) => {
    process.stderr.write(chunk);
    handle.stderrTail = (handle.stderrTail + chunk.toString()).slice(-WORKER_STDERR_TAIL_CHARS);
  };
  child.stdout?.on('data', captureOutput);
  child.stderr?.on('data', captureOutput);

  child.on('message', (message: WorkerResponse) => {
    const job = handle.pending.get(message.id);
    if (!job) return;
    if (message.type === 'phase') {
      // Lifecycle update only — the job stays pending until a terminal
      // result/error message arrives (which may be long after, e.g. once L5
      // AI enrichment settles).
      job.onPhase?.({ phase: message.phase, status: message.status, error: message.error });
      return;
    }
    handle.pending.delete(message.id);
    if (message.type === 'result') {
      job.resolve(message.summary);
    } else {
      const error = new Error(message.message);
      if (message.stackTop) error.stack = `${message.message}\n${message.stackTop}`;
      job.reject(error);
    }
  });

  child.on('error', (error) => {
    failPendingWorkerJobs(handle, null, null, `worker process error: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    if (workerHandle === handle) workerHandle = null;
    failPendingWorkerJobs(handle, code, signal);
  });

  return handle;
}

function workerLooksOutOfMemory(handle: WorkerHandle, code: number | null, signal: NodeJS.Signals | null): boolean {
  if (/Reached heap limit|JavaScript heap out of memory|FATAL ERROR/i.test(handle.stderrTail)) return true;
  return signal === 'SIGABRT' || code === 134;
}

function buildWorkerCrashMessage(
  handle: WorkerHandle,
  job: PendingWorkerJob,
  code: number | null,
  signal: NodeJS.Signals | null,
  detail?: string,
): string {
  const exitDescription = detail
    ? detail
    : signal
      ? `killed by signal ${signal}`
      : `exited with code ${code}`;
  const oom = workerLooksOutOfMemory(handle, code, signal);
  const heap = handle.heap;
  const heapSource = heap.source === 'env' ? 'from KLAURO_ANALYSIS_HEAP_MB' : 'default';
  const suggestedHeap = Math.min(heap.totalRamMb, heap.heapMb * 2);
  return [
    `Analysis worker for ${job.projectPath} ${exitDescription}${oom ? ' after exhausting its heap' : ''}.`,
    `The worker heap was ${heap.heapMb} MB (${heapSource}).`,
    `Raise it with KLAURO_ANALYSIS_HEAP_MB=${suggestedHeap} in the MCP server environment and re-run analyze_codebase,`,
    `or use analysis_focus: "agent-fast" to reduce memory pressure.`,
    `The MCP server itself is unaffected; a run-failed record was written to ${getAnalysisRunLogPath()}.`,
  ].join(' ');
}

function failPendingWorkerJobs(
  handle: WorkerHandle,
  code: number | null,
  signal: NodeJS.Signals | null,
  detail?: string,
): void {
  for (const [id, job] of handle.pending) {
    handle.pending.delete(id);
    const message = buildWorkerCrashMessage(handle, job, code, signal, detail);
    try {
      finalizeWorkerRunFailure(job.projectPath, job.startedAtMs, message);
    } catch {
      // Run-log finalization is best effort; the error below still reaches the caller.
    }
    job.reject(new Error(message));
  }
}

function readRunLogRecords(): AnalysisRunRecord[] {
  const logPath = getAnalysisRunLogPath();
  if (!nodeFs.existsSync(logPath)) return [];
  const records: AnalysisRunRecord[] = [];
  for (const line of nodeFs.readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as AnalysisRunRecord);
    } catch {
      // Skip unparseable lines; rotation owns log hygiene.
    }
  }
  return records;
}

export function finalizeWorkerRunFailure(projectPath: string, jobStartedAtMs: number, message: string): void {
  const records = readRunLogRecords();
  const finalized = new Set(
    records
      .filter(record => record.event === 'run-complete' || record.event === 'run-failed')
      .map(record => record.run_id),
  );
  const orphans = records.filter((record): record is AnalysisRunStartRecord =>
    record.event === 'run-start' &&
    record.project_path === projectPath &&
    !finalized.has(record.run_id) &&
    Date.parse(record.started_at) >= jobStartedAtMs - 60_000,
  );

  const nowIso = new Date().toISOString();
  const failures: AnalysisRunFinalRecord[] = orphans.length > 0
    ? orphans.map(start => ({
      run_id: start.run_id,
      project_path: start.project_path,
      project_name: start.project_name,
      cas_version: start.cas_version,
      event: 'run-failed',
      started_at: start.started_at,
      ended_at: nowIso,
      duration_ms: Math.max(0, Date.now() - Date.parse(start.started_at)),
      phases: [],
      analyzers: [],
      warnings: [],
      warning_overflow: 0,
      error: { message },
    }))
    : [{
      run_id: `analysis_worker_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      project_path: projectPath,
      project_name: path.basename(projectPath),
      event: 'run-failed',
      started_at: new Date(jobStartedAtMs).toISOString(),
      ended_at: nowIso,
      duration_ms: Math.max(0, Date.now() - jobStartedAtMs),
      phases: [],
      analyzers: [],
      warnings: [],
      warning_overflow: 0,
      error: { message },
    }];

  const logPath = getAnalysisRunLogPath();
  nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
  nodeFs.appendFileSync(logPath, failures.map(record => `${JSON.stringify(record)}\n`).join(''));
}

function ensureAnalysisWorker(): WorkerHandle {
  const heap = resolveAnalysisHeapMb();
  if (workerHandle && workerHandle.heap.heapMb !== heap.heapMb) {
    shutdownAnalysisWorker();
  }
  if (!workerHandle) {
    workerHandle = spawnAnalysisWorker(heap);
  }
  return workerHandle;
}

export function shutdownAnalysisWorker(): void {
  if (!workerHandle) return;
  const handle = workerHandle;
  workerHandle = null;
  handle.child.removeAllListeners('exit');
  handle.child.kill();
  failPendingWorkerJobs(handle, null, 'SIGTERM', 'was shut down while a job was running');
}

function dispatchWorkerJob(projectPath: string, options: RunAnalysisOptions): Promise<AnalysisRunSummary> {
  const handle = ensureAnalysisWorker();
  const id = nextWorkerJobId++;
  return new Promise<AnalysisRunSummary>((resolve, reject) => {
    handle.pending.set(id, { projectPath, startedAtMs: Date.now(), resolve, reject });
    const request: WorkerAnalyzeRequest = {
      type: 'analyze',
      id,
      projectPath,
      forceFull: Boolean(options.forceFull),
      displayName: options.displayName,
      env: collectKlauroEnvSnapshot(),
    };
    handle.child.send(request, (error) => {
      if (error) {
        const job = handle.pending.get(id);
        if (job) {
          handle.pending.delete(id);
          reject(new Error(`Failed to dispatch analysis to worker: ${error.message}`));
        }
      }
    });
  });
}

export interface RunLayeredAnalysisOptions {
  displayName?: string;
  /** Fired on each phase-completion message (l0/rest/enrichment); see
   *  LayeredJobPhaseEvent. The job stays outstanding until the terminal
   *  result/error — callers use this purely for lifecycle bookkeeping
   *  (e.g. updating an attempt-record sidecar), never for the CAS itself. */
  onPhase?: (event: LayeredJobPhaseEvent) => void;
}

function dispatchLayeredWorkerJob(projectPath: string, options: RunLayeredAnalysisOptions): Promise<LayeredRunSummary> {
  const handle = ensureAnalysisWorker();
  const id = nextWorkerJobId++;
  return new Promise<LayeredRunSummary>((resolve, reject) => {
    handle.pending.set(id, { projectPath, startedAtMs: Date.now(), resolve, reject, onPhase: options.onPhase });
    const request: WorkerLayeredRequest = {
      type: 'layered',
      id,
      projectPath,
      displayName: options.displayName,
      env: collectKlauroEnvSnapshot(),
    };
    handle.child.send(request, (error) => {
      if (error) {
        const job = handle.pending.get(id);
        if (job) {
          handle.pending.delete(id);
          reject(new Error(`Failed to dispatch layered analysis to worker: ${error.message}`));
        }
      }
    });
  });
}

/**
 * Outer wall-clock watchdog for the worker-dispatch path, mirroring
 * withLanePermit's watchdog one layer further out — dispatchWorkerJob just
 * awaits the child's message with no timeout of its own, so a wedged child
 * whose own inner watchdog never reports back would otherwise hang the
 * caller indefinitely with no error, log, or attempt record. Same honesty
 * constraint as the inner watchdog: cannot preempt a genuinely wedged child,
 * only stops waiting and writes a best-effort failed attempt record. The
 * child process itself is left running, not killed.
 */
async function withOuterWorkerWatchdog<T>(
  projectPath: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAtMs = Date.now();
  const attemptStartedAtIso = new Date(startedAtMs).toISOString();
  const watchdogMs = getAnalysisWatchdogMs();
  let watchdogFired = false;
  const innerPromise = run();

  let rejectWatchdog!: (error: Error) => void;
  const watchdogPromise = new Promise<never>((_, reject) => { rejectWatchdog = reject; });
  const timer = setTimeout(() => {
    // Async IIFE so the attempt-record write can be AWAITED before rejecting
    // — a caller/test that awaits this watchdog's rejection must see the
    // terminal record already on disk, not racing a fire-and-forget write.
    (async () => {
      watchdogFired = true;
      const elapsedMinutes = Math.round((Date.now() - startedAtMs) / 60_000);
      console.error(
        `[Klauro] OUTER ANALYSIS WATCHDOG FIRED: ${projectPath} (worker-dispatched) has been running ${elapsedMinutes}m, ` +
        `exceeding KLAURO_ANALYSIS_WATCHDOG_MS=${watchdogMs}ms at the parent-process level. The forked analysis worker's ` +
        `OWN inner watchdog never reported back (message loss, or the child is wedged in a synchronous/native hang its ` +
        `own timer cannot preempt). Marking this attempt failed (reason contains 'watchdog-timeout') and writing a ` +
        `terminal attempt record so a poller sees the truth instead of a stale/absent one. NOTE: this does NOT stop the ` +
        `underlying child process — it is left running, matching the inner watchdog's own honesty constraint.`
      );
      await writeInternalRebuildAttempt(projectPath, {
        state: 'failed',
        trigger: 'version-rebuild',
        started_at: attemptStartedAtIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAtMs,
        reason: `watchdog-timeout: ${projectPath} (worker-dispatched) exceeded ${watchdogMs}ms without completing`,
      }).catch(() => undefined);
      rejectWatchdog(new AnalysisWatchdogTimeoutError(
        `watchdog-timeout: ${projectPath} (worker-dispatched) exceeded ${watchdogMs}ms without completing`
      ));
    })();
  }, watchdogMs);

  innerPromise
    .then(() => {
      if (watchdogFired) {
        console.error(`[Klauro] LATE COMPLETION: ${projectPath} (worker-dispatched) finished successfully AFTER the outer watchdog already marked the attempt failed.`);
      }
    }, () => {
      if (watchdogFired) {
        console.error(`[Klauro] LATE COMPLETION: ${projectPath} (worker-dispatched) finished (with its own error) AFTER the outer watchdog already marked the attempt failed.`);
      }
    })
    .finally(() => clearTimeout(timer));

  return Promise.race([innerPromise, watchdogPromise]);
}

export async function runAnalysis(projectPath: string, options: RunAnalysisOptions = {}): Promise<AnalysisRunSummary> {
  if (analysisRunsInProcess()) {
    return runAnalysisInProcess(projectPath, options);
  }
  const run = workerJobChain.then(() => withOuterWorkerWatchdog(projectPath, () => dispatchWorkerJob(projectPath, options)));
  workerJobChain = run.catch(() => undefined);
  return run;
}

/**
 * Worker-isolated entrypoint for the progressive/layered pipeline — the
 * layered counterpart of runAnalysis. The whole pipeline, including L5 AI
 * enrichment, runs inside the same heap-capped forked worker, so a full
 * rebuild can only exhaust the worker's bounded heap, never the API server's.
 * `options.onPhase` fires as each phase lands so callers can drive their own
 * attempt-record lifecycle without waiting on the full pipeline; the resolved
 * value is only the small LayeredRunSummary, never the CAS itself. Rides the
 * same outer watchdog and shared workerJobChain as runAnalysis, so a layered
 * job and a plain analyze job never run concurrently against one forked child.
 */
export async function runLayeredAnalysis(
  projectPath: string,
  options: RunLayeredAnalysisOptions = {},
): Promise<LayeredRunSummary> {
  if (analysisRunsInProcess()) {
    // In-process fallback (tests / KLAURO_ANALYSIS_IN_PROCESS=1): drive
    // analyzeProjectLayered directly in THIS process, still firing onPhase
    // for parity with the worker-dispatched path so callers don't need to
    // special-case which mode they're in.
    const layered = await analyzeProjectLayered(projectPath, options.displayName);
    try {
      await layered.l0;
      options.onPhase?.({ phase: 'l0', status: 'succeeded' });
    } catch (error) {
      options.onPhase?.({ phase: 'l0', status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
    let deferred: DeferredAnalysisResult;
    try {
      deferred = await layered.rest;
      options.onPhase?.({ phase: 'rest', status: 'succeeded' });
    } catch (error) {
      options.onPhase?.({ phase: 'rest', status: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await deferred.enrichment.catch(() => undefined);
    const aiEnrichment = deferred.output.ai_enrichment;
    options.onPhase?.({
      phase: 'enrichment',
      status: aiEnrichment === 'error' ? 'failed' : 'succeeded',
      error: aiEnrichment === 'error' ? deferred.output.ai_enrichment_error : undefined,
    });
    return summarizeLayeredAnalysis(projectPath, deferred.output);
  }
  const run = workerJobChain.then(() => withOuterWorkerWatchdog(projectPath, () => dispatchLayeredWorkerJob(projectPath, options)));
  workerJobChain = run.catch(() => undefined);
  return run;
}
