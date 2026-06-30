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
import { SolidityAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/solidity-analyzer';
import { CCppAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/c-cpp-analyzer';
import { SwiftAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/swift-analyzer';
import { KotlinAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/kotlin-analyzer';
import { ElixirAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/elixir-analyzer';
import { DartAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/dart-analyzer';
import { TerraformAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/terraform-analyzer';
import { DockerComposeAnalyzer, DockerfileAnalyzer, KubernetesManifestAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/container-topology-analyzer';
import { DistributionArtifactAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/distribution-artifact-analyzer';
import {
  NestJSAnalyzer,
  SpringBootAnalyzer,
  DjangoAnalyzer,
  FlaskAnalyzer,
  FastAPIAnalyzer,
  ExpressAnalyzer,
  ReactAnalyzer,
  VueAnalyzer,
  AngularAnalyzer,
  LaravelAnalyzer,
  SymfonyAnalyzer,
  RailsAnalyzer,
  NextJSAnalyzer,
} from '../../../packages/analyzer-core/src/analyzer/frameworks/web';
import { JestAnalyzer, CypressAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/testing';
import { WPFAnalyzer, AspNetCoreAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/dotnet';
import { ActixAnalyzer, RocketAnalyzer, AxumAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/rust';
import { VaporAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/swift';
import { GoRouterAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/dart';
import { Http4sAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/scala';
import { KemalAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/crystal';
import { GenieAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/julia';
import { CompojureAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/clojure';
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
import { WordPressAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/php/wordpress-analyzer';
import { BlazorAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/dotnet/blazor-analyzer';
import { QuarkusAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/java/quarkus-analyzer';
import { MicronautAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/java/micronaut-analyzer';
import { SolidStartAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/web/solidstart-analyzer';
import { QwikAnalyzer } from '../../../packages/analyzer-core/src/analyzer/frameworks/web/qwik-analyzer';
import { OpenAPIAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/openapi-analyzer';
import { EFCoreAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/efcore-analyzer';
import {
  PrismaAnalyzer,
  SocketIOAnalyzer,
  ReactRouterAnalyzer,
  ReduxAnalyzer,
  ZustandAnalyzer,
  TanStackQueryAnalyzer,
  ReqwestAnalyzer,
  architectureLibraryAnalyzerDefinitions
} from '../../../packages/analyzer-core/src/analyzer/libraries';
import { TRPCAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/trpc-analyzer';
import { GraphQLAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/graphql-analyzer';
import { AIStackAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/ai-stack-analyzer';
import { WorkflowAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/workflow-analyzer';
import { SQLAlchemyPydanticAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/sqlalchemy-pydantic-analyzer';
import { DrizzleAnalyzer, TypeORMAnalyzer, MongooseAnalyzer } from '../../../packages/analyzer-core/src/analyzer/libraries/orm';
import { ProtobufAnalyzer } from '../../../packages/analyzer-core/src/analyzer/languages/protobuf-analyzer';
import type { AnalyzerRegistration } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import * as fs from 'fs-extra';
import * as nodeFs from 'fs';
import * as path from 'path';
import { fork, type ChildProcess } from 'child_process';
import {
  getAnalysisRunLogPath,
  type AnalysisRunFinalRecord,
  type AnalysisRunRecord,
  type AnalysisRunStartRecord,
} from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { resolveAnalysisHeapMb, type AnalysisHeapResolution } from './analysis-heap';
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
  withProjectAnalysisLock
} from './storage';
import { loadKlauroConfig, validateEmbeddingConfig } from './klauro-config';
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
  ];

  const frameworkRegistrations: AnalyzerRegistration[] = [
    { id: 'nestjs', name: 'NestJS Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@nestjs/core', '@nestjs/common'] }, requires: ['typescript-javascript'], analyzer: new NestJSAnalyzer() },
    { id: 'spring-boot', name: 'Spring Boot Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['spring-boot-starter', 'org.springframework.boot'], files: ['pom.xml', 'build.gradle'] }, requires: ['java'], analyzer: new SpringBootAnalyzer() },
    { id: 'django', name: 'Django Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Django', 'django'], files: ['manage.py', 'requirements.txt'] }, requires: ['python'], analyzer: new DjangoAnalyzer() },
    { id: 'flask', name: 'Flask Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Flask', 'flask'], files: ['requirements.txt'] }, requires: ['python'], analyzer: new FlaskAnalyzer() },
    { id: 'fastapi', name: 'FastAPI Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['fastapi', 'FastAPI'], files: ['requirements.txt'] }, requires: ['python'], analyzer: new FastAPIAnalyzer() },
    { id: 'laravel', name: 'Laravel Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['artisan', 'composer.json'], dependencies: ['laravel/framework'] }, requires: ['php'], analyzer: new LaravelAnalyzer() },
    { id: 'symfony', name: 'Symfony Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['bin/console', 'composer.json'], dependencies: ['symfony/framework-bundle'] }, requires: ['php'], analyzer: new SymfonyAnalyzer() },
    { id: 'rails', name: 'Rails Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['Gemfile', 'config/routes.rb'], dependencies: ['rails'] }, requires: ['ruby'], analyzer: new RailsAnalyzer() },
    { id: 'express', name: 'Express.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['express'], files: ['package.json'] }, requires: ['typescript-javascript'], analyzer: new ExpressAnalyzer() },
    { id: 'react', name: 'React Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['react', 'react-dom'], files: ['package.json'], content: [/\.jsx$/, /\.tsx$/] }, requires: ['typescript-javascript'], analyzer: new ReactAnalyzer() },
    { id: 'angular', name: 'Angular Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@angular/core', '@angular/common'], files: ['angular.json', 'package.json'], content: [/\.component\.ts$/] }, requires: ['typescript-javascript'], analyzer: new AngularAnalyzer() },
    { id: 'vue', name: 'Vue.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['vue', 'vue@'], files: ['package.json'], content: [/\.vue$/] }, requires: ['typescript-javascript'], analyzer: new VueAnalyzer() },
    { id: 'jest', name: 'Jest Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['jest', '@jest/core'], files: ['jest.config.js', 'jest.config.ts'], content: [/\.test\.(js|ts|jsx|tsx)$/, /\.spec\.(js|ts|jsx|tsx)$/] }, requires: ['typescript-javascript'], analyzer: new JestAnalyzer() },
    { id: 'cypress', name: 'Cypress Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['cypress'], files: ['cypress.json', 'cypress.config.js', 'cypress.config.ts'], content: [/\.cy\.(js|ts|jsx|tsx)$/] }, requires: ['typescript-javascript'], analyzer: new CypressAnalyzer() },
    { id: 'wpf', name: 'WPF Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.xaml', '**/*.csproj'], content: [/PresentationFramework/, /System\.Windows/, /<UseWPF>true<\/UseWPF>/] }, requires: ['csharp'], analyzer: new WPFAnalyzer() },
    { id: 'aspnet-core', name: 'ASP.NET Core Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.csproj'], content: [/Microsoft\.AspNetCore/, /Microsoft\.NET\.Sdk\.Web/] }, requires: ['csharp'], analyzer: new AspNetCoreAnalyzer() },
    { id: 'nextjs', name: 'Next.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['next'], files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] }, requires: ['typescript-javascript'], analyzer: new NextJSAnalyzer() },
    { id: 'actix-web', name: 'Actix-web Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['actix-web', 'actix_web'], files: ['Cargo.toml'], content: [/actix_web::/, /#\[(get|post|put|delete|patch)\("/, /HttpServer::/] }, requires: ['rust'], analyzer: new ActixAnalyzer() },
    { id: 'rocket', name: 'Rocket Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['rocket', 'rocket_dyn_templates', 'rocket_sync'], files: ['Cargo.toml'], content: [/rocket::/, /#\[(get|post|put|delete|patch)\("/, /rocket::build/] }, requires: ['rust'], analyzer: new RocketAnalyzer() },
    { id: 'axum', name: 'Axum Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['axum'], files: ['Cargo.toml'], content: [/axum::/, /Router::new\s*\(/, /\.route\s*\(\s*"/] }, requires: ['rust'], analyzer: new AxumAnalyzer() },
    { id: 'vapor', name: 'Vapor Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['vapor'], files: ['Package.swift', '**/*.swift'], content: [/import\s+Vapor/, /\.grouped\s*\(/, /\.(get|post|put|delete|patch)\s*\(/] }, requires: ['swift'], analyzer: new VaporAnalyzer() },
    { id: 'mojolicious', name: 'Mojolicious Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Mojolicious'], files: ['cpanfile', 'Makefile.PL', '**/*.pl', '**/*.pm'], content: [/use\s+Mojolicious/, /^\s*(get|post|put|patch|del|options|any)\s+['"]/m, /->(get|post|put|patch|del|options|any|under)\s*\(/] }, requires: ['perl'], analyzer: new MojoliciousAnalyzer() },
    { id: 'gorouter', name: 'GoRouter Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['go_router'], files: ['pubspec.yaml', '**/*.dart'], content: [/GoRouter\s*\(/, /GoRoute\s*\(/, /package:go_router/] }, requires: ['dart'], analyzer: new GoRouterAnalyzer() },
    { id: 'http4s', name: 'http4s Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['http4s', 'http4s-dsl'], files: ['build.sbt', '**/*.scala'], content: [/org\.http4s/, /HttpRoutes\.of/, /AuthedRoutes\.of/] }, requires: ['scala'], analyzer: new Http4sAnalyzer() },
    { id: 'kemal', name: 'Kemal Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['kemal'], files: ['shard.yml', '**/*.cr'], content: [/require\s+"kemal"/, /^\s*(get|post|put|patch|delete|options|head|ws)\s+"/m] }, requires: ['crystal'], analyzer: new KemalAnalyzer() },
    { id: 'genie', name: 'Genie Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Genie'], files: ['Project.toml', '**/*.jl'], content: [/Genie/, /\broute\s*\(/, /@(get|post|put|patch|delete)\s*\(/] }, requires: ['julia'], analyzer: new GenieAnalyzer() },
    { id: 'compojure', name: 'Compojure Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['compojure'], files: ['deps.edn', 'project.clj', '**/*.clj', '**/*.cljs', '**/*.cljc'], content: [/compojure\.core/, /\(defroutes\b/, /\(context\b/, /\((?:GET|POST|PUT|DELETE|PATCH|ANY)\s+"/] }, requires: ['clojure'], analyzer: new CompojureAnalyzer() },
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
    { id: 'wordpress', name: 'WordPress Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['wp-config.php', 'style.css'], content: [/add_action\s*\(/, /add_filter\s*\(/, /register_post_type\s*\(/, /Plugin Name:/, /Theme Name:/] }, requires: ['php'], analyzer: new WordPressAnalyzer() },
    { id: 'blazor', name: 'Blazor Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.razor'], content: [/Microsoft\.AspNetCore\.Components/, /@page\s/, /@code\b/] }, requires: ['csharp'], analyzer: new BlazorAnalyzer() },
    { id: 'quarkus', name: 'Quarkus Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.quarkus'], files: ['pom.xml', 'build.gradle'], content: [/quarkus\./, /jakarta\.ws\.rs/, /javax\.ws\.rs/] }, requires: ['java'], analyzer: new QuarkusAnalyzer() },
    { id: 'micronaut', name: 'Micronaut Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.micronaut'], files: ['pom.xml', 'build.gradle'], content: [/io\.micronaut/, /@Controller/] }, requires: ['java'], analyzer: new MicronautAnalyzer() },
    { id: 'solidstart', name: 'SolidStart Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['solid-start', '@solidjs/start'] }, requires: ['typescript-javascript'], analyzer: new SolidStartAnalyzer() },
    { id: 'qwik', name: 'Qwik Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@builder.io/qwik', '@builder.io/qwik-city'] }, requires: ['typescript-javascript'], analyzer: new QwikAnalyzer() },
  ];

  const libraryRegistrations: AnalyzerRegistration[] = [
    { id: 'prisma', name: 'Prisma ORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['prisma', '@prisma/client'], files: ['prisma/schema.prisma'] }, requires: ['typescript-javascript'], analyzer: new PrismaAnalyzer() },
    { id: 'socketio', name: 'Socket.io Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['socket.io', 'socket.io-client'] }, requires: ['typescript-javascript'], analyzer: new SocketIOAnalyzer() },
    { id: 'react-router', name: 'React Router Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['react-router-dom', 'react-router'] }, requires: ['typescript-javascript'], analyzer: new ReactRouterAnalyzer() },
    { id: 'redux', name: 'Redux/RTK Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@reduxjs/toolkit', 'redux'] }, requires: ['typescript-javascript'], analyzer: new ReduxAnalyzer() },
    { id: 'zustand', name: 'Zustand Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['zustand'] }, requires: ['typescript-javascript'], analyzer: new ZustandAnalyzer() },
    { id: 'tanstack-query', name: 'TanStack Query Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@tanstack/react-query', 'react-query', '@tanstack/vue-query', '@tanstack/svelte-query'] }, requires: ['typescript-javascript'], analyzer: new TanStackQueryAnalyzer() },
    { id: 'reqwest', name: 'Reqwest HTTP Client Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['reqwest'], files: ['Cargo.toml'] }, requires: ['rust'], analyzer: new ReqwestAnalyzer() },
    { id: 'trpc', name: 'tRPC API Contract Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@trpc/server', '@trpc/client'] }, requires: ['typescript-javascript'], analyzer: new TRPCAnalyzer() },
    { id: 'graphql', name: 'GraphQL API Contract Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['graphql', '@apollo/server', 'type-graphql', 'graphql-yoga', 'nexus', 'strawberry-graphql', 'graphene', 'ariadne', 'gqlgen', 'spring-graphql', 'graphql-java'], files: ['**/*.graphql', '**/*.gql'] }, requires: ['typescript-javascript'], analyzer: new GraphQLAnalyzer() },
    { id: 'drizzle', name: 'Drizzle ORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['drizzle-orm'] }, requires: ['typescript-javascript'], analyzer: new DrizzleAnalyzer() },
    { id: 'typeorm', name: 'TypeORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['typeorm'] }, requires: ['typescript-javascript'], analyzer: new TypeORMAnalyzer() },
    { id: 'mongoose', name: 'Mongoose Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['mongoose'] }, requires: ['typescript-javascript'], analyzer: new MongooseAnalyzer() },
    { id: 'sqlalchemy-pydantic', name: 'SQLAlchemy/Pydantic Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sqlalchemy', 'pydantic', 'SQLAlchemy', 'sqlmodel'], files: ['requirements.txt', 'pyproject.toml', 'Pipfile'] }, requires: ['python'], analyzer: new SQLAlchemyPydanticAnalyzer() },
    { id: 'ai-stack', name: 'AI/LLM Stack Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['langchain', '@langchain/core', 'llamaindex', 'ai', '@ai-sdk/openai', 'openai', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'langgraph', 'crewai', '@pinecone-database/pinecone', 'weaviate-ts-client', 'chromadb', 'qdrant'] }, requires: ['typescript-javascript'], analyzer: new AIStackAnalyzer() },
    { id: 'workflow', name: 'Workflow/Queue Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@temporalio/client', '@temporalio/worker', 'celery', 'sidekiq', 'bullmq', 'bull', 'kafkajs', 'amqplib', 'nats', 'kafka-python', 'confluent-kafka', 'kafka-go', 'nats.go', 'rdkafka', 'async-nats', 'spring-kafka', 'Confluent.Kafka'] }, requires: ['typescript-javascript'], analyzer: new WorkflowAnalyzer() },
    { id: 'openapi', name: 'OpenAPI/Swagger Analyzer', type: 'library', version: '1.0.0', detectPatterns: { files: ['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml'], content: [/openapi\s*:/, /"openapi"\s*:/, /swagger\s*:/] }, analyzer: new OpenAPIAnalyzer() },
    { id: 'efcore', name: 'EF Core Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['Microsoft.EntityFrameworkCore'], content: [/:\s*DbContext/, /DbSet</] }, requires: ['csharp'], analyzer: new EFCoreAnalyzer() },
    ...architectureLibraryAnalyzerDefinitions().map(definition => ({
      id: definition.id,
      name: definition.name,
      type: 'library' as const,
      version: '1.0.0',
      detectPatterns: { dependencies: definition.dependencies },
      analyzer: definition.analyzer,
    })),
  ];

  for (const reg of [...languageRegistrations, ...frameworkRegistrations, ...libraryRegistrations]) {
    created.registerAnalyzer(reg);
  }

  return created;
}

export function getOrchestrator(): AnalyzerOrchestrator {
  if (process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS === '1') {
    return createOrchestrator();
  }

  if (orchestrator) return orchestrator;

  orchestrator = createOrchestrator();
  return orchestrator;
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
    const provider = createEmbeddingProvider(embedding.provider, {
      model: embedding.model,
      dimensions: embedding.dimensions,
      maxBatch: 64,
      maxConcurrency: embedding.maxConcurrency,
      apiKeyEnv: embedding.apiKeyEnv,
    });

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

export async function analyzeProject(projectPath: string): Promise<CASOutput> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  return withProjectAnalysisLock(projectPath, async () => {
    const orch = getOrchestrator();
    orch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));
    const previousOutput = await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
    const result = await applyStoredElementDescriptions(projectPath, preservePreviousAIDescriptions(
      previousOutput,
      await orch.orchestrateAnalysis(projectPath)
    ));

    await saveAnalysis(projectPath, result);
    clearFreshnessSummaryCache();
    await saveAnalysisSnapshot(projectPath, result);

    return result;
  });
}

export async function getAnalysis(projectPath: string): Promise<CASOutput> {
  const cached = await loadAnalysis(projectPath);
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

export async function analyzeProjectIncremental(projectPath: string): Promise<IncrementalAnalysisResult> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  return withProjectAnalysisLock(projectPath, () => runIncrementalAnalysis(projectPath));
}

async function runIncrementalAnalysis(projectPath: string): Promise<IncrementalAnalysisResult> {
  const debugTimings = process.env.KLAURO_DEBUG_INCREMENTAL_TIMINGS === '1';
  const debug = (label: string, startedAt: number) => {
    if (debugTimings) {
      console.error(`[Klauro] incremental timing ${label}: ${Date.now() - startedAt}ms`);
    }
  };

  const orch = getOrchestrator();
  orch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));

  const previousOutput = await loadAnalysis(projectPath, { preferCache: true });
  const previousState = await loadIncrementalState(projectPath);
  const previousCasVersion = previousOutput
    ? getAnalysisVersionInfo(previousOutput).stored_version
    : undefined;

  if (!previousOutput) {
    let phaseStartedAt = Date.now();
    const result = await orch.orchestrateAnalysis(projectPath);
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
        saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult)
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

  let phaseStartedAt = Date.now();
  const result = await orch.orchestrateIncrementalAnalysis(
    projectPath,
    previousOutput,
    previousState,
    {
      loadCache: (hash) => loadFileCache(projectPath, hash),
      saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult)
    }
  );
  debug('orchestrate-incremental', phaseStartedAt);

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

export interface RunAnalysisOptions {
  forceFull?: boolean;
}

export async function runAnalysisInProcess(projectPath: string, options: RunAnalysisOptions = {}): Promise<AnalysisRunSummary> {
  if (options.forceFull) {
    const output = await analyzeProject(projectPath);
    return summarizeFullAnalysis(projectPath, output);
  }
  const result = await analyzeProjectIncremental(projectPath);
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
  env: Record<string, string>;
}

interface WorkerResultMessage {
  type: 'result';
  id: number;
  summary: AnalysisRunSummary;
}

interface WorkerErrorMessage {
  type: 'error';
  id: number;
  message: string;
  stackTop?: string;
}

type WorkerResponse = WorkerResultMessage | WorkerErrorMessage;

interface PendingWorkerJob {
  projectPath: string;
  startedAtMs: number;
  resolve: (summary: AnalysisRunSummary) => void;
  reject: (error: Error) => void;
}

interface WorkerHandle {
  child: ChildProcess;
  heap: AnalysisHeapResolution;
  stderrTail: string;
  pending: Map<number, PendingWorkerJob>;
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

export async function runAnalysis(projectPath: string, options: RunAnalysisOptions = {}): Promise<AnalysisRunSummary> {
  if (analysisRunsInProcess()) {
    return runAnalysisInProcess(projectPath, options);
  }
  const run = workerJobChain.then(() => dispatchWorkerJob(projectPath, options));
  workerJobChain = run.catch(() => undefined);
  return run;
}
