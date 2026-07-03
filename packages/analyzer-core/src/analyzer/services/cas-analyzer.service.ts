import { Injectable, Logger } from '@nestjs/common';
import { AnalyzerOrchestrator, CASOutput, AnalyzerRegistration } from '../core/orchestrator';
import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { IncrementalState, ChangeReport } from '../../types/cas.types';

import { TypeScriptJavaScriptAnalyzer } from '../languages/typescript-javascript-analyzer';
import { PythonAnalyzer } from '../languages/python-analyzer';
import { JavaAnalyzer } from '../languages/java-analyzer';
import { CSharpAnalyzer } from '../languages/csharp-analyzer';
import { GoAnalyzer } from '../languages/go-analyzer';
import { RustAnalyzer } from '../languages/rust-analyzer';
import { PHPAnalyzer } from '../languages/php-analyzer';
import { RubyAnalyzer } from '../languages/ruby-analyzer';
import { DartAnalyzer } from '../languages/dart-analyzer';
import { TerraformAnalyzer } from '../languages/terraform-analyzer';
import { CCppAnalyzer } from '../languages/c-cpp-analyzer';
import { KotlinAnalyzer } from '../languages/kotlin-analyzer';
import { SwiftAnalyzer } from '../languages/swift-analyzer';
import { SolidityAnalyzer } from '../languages/solidity-analyzer';
import { ElixirAnalyzer } from '../languages/elixir-analyzer';
import { ShellAnalyzer } from '../languages/shell-analyzer';
import { ProtobufAnalyzer } from '../languages/protobuf-analyzer';
import { DockerComposeAnalyzer, DockerfileAnalyzer, KubernetesManifestAnalyzer } from '../languages/container-topology-analyzer';
import { DistributionArtifactAnalyzer } from '../languages/distribution-artifact-analyzer';
import { GenericTreeSitterLanguageAnalyzer } from '../languages/generic-tree-sitter-language-analyzer';

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
  NextJSAnalyzer
} from '../frameworks/web';

import { JestAnalyzer, CypressAnalyzer } from '../frameworks/testing';
import { WPFAnalyzer, AspNetCoreAnalyzer } from '../frameworks/dotnet';
import { ActixAnalyzer, RocketAnalyzer, AxumAnalyzer } from '../frameworks/rust';
import { PhoenixAnalyzer } from '../frameworks/elixir/phoenix-analyzer';
import { VaporAnalyzer } from '../frameworks/swift';
import { GoRouterAnalyzer } from '../frameworks/dart';
import { Http4sAnalyzer } from '../frameworks/scala';
import { KemalAnalyzer } from '../frameworks/crystal';
import { GenieAnalyzer } from '../frameworks/julia';
import { CompojureAnalyzer } from '../frameworks/clojure';
import { DreamAnalyzer } from '../frameworks/ocaml';
import { ApexRestAnalyzer } from '../frameworks/apex';
import { MojoliciousAnalyzer } from '../frameworks/perl';
import {
  PrismaAnalyzer,
  SocketIOAnalyzer,
  ReactRouterAnalyzer,
  ReduxAnalyzer,
  ZustandAnalyzer,
  TanStackQueryAnalyzer,
  ReqwestAnalyzer,
  architectureLibraryAnalyzerDefinitions,
  AIStackAnalyzer,
  McpToolRegistrationAnalyzer
} from '../libraries';

import * as fs from 'fs-extra';
import * as path from 'path';

export interface CASAnalysisOptions {
  includeTests?: boolean;
  maxDepth?: number;
  filters?: string[];
  level?: number;
  type?: string;
  nameFilter?: string;
}

export interface CASSummaryOutput {
  cas_version: string;
  analysis_timestamp: string;
  analysis_id: string;
  system: {
    name: string;
    type: string;
  };
  architecture_summary: CASOutput['architecture_summary'];
  route_table?: CASOutput['route_table'];
  database_schema?: CASOutput['database_schema'];
  external_services_count?: number;
  node_counts: {
    total: number;
    by_type: Record<string, number>;
  };
  edge_counts: {
    total: number;
    by_type: Record<string, number>;
  };
}

export interface CASAnalysisRequest {
  projectPath: string;
  options?: CASAnalysisOptions;
}

@Injectable()
export class CASAnalyzerService {
  private readonly logger = new Logger(CASAnalyzerService.name);
  private orchestrator: AnalyzerOrchestrator;

  constructor() {
    this.orchestrator = new AnalyzerOrchestrator();
    this.registerAnalyzers();
  }

  async analyzeProject(request: CASAnalysisRequest): Promise<CASOutput> {
    const { projectPath, options = {} } = request;

    this.logger.log(`Starting CAS analysis for project: ${projectPath}`);

    if (!await fs.pathExists(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    try {
      const result = await this.orchestrator.orchestrateAnalysis(projectPath);

      this.logger.log(`CAS analysis completed: ${result.nodes.length} nodes, ${result.edges.length} edges`);
      this.logger.log(`Analyzers executed: ${result.analyzer_contributions.map(c => c.analyzer_name).join(', ')}`);

      return result;
    } catch (error) {
      this.logger.error(`CAS analysis failed: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  async analyzeProjectIncremental(
    request: CASAnalysisRequest,
    previousOutput: CASOutput,
    previousState: IncrementalState | null
  ): Promise<{
    output: CASOutput;
    state: IncrementalState;
    changeReport: ChangeReport;
    wasFullRebuild: boolean;
  }> {
    const { projectPath } = request;

    this.logger.log(`Starting incremental CAS analysis for project: ${projectPath}`);

    if (!await fs.pathExists(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    try {
      const result = await this.orchestrator.orchestrateIncrementalAnalysis(
        projectPath,
        previousOutput,
        previousState
      );

      if (result.wasFullRebuild) {
        this.logger.log(`Full rebuild triggered: ${result.changeReport.summary.filesModified + result.changeReport.summary.filesAdded + result.changeReport.summary.filesDeleted} files changed`);
      } else {
        this.logger.log(
          `Incremental analysis completed: ` +
          `${result.changeReport.summary.nodesAdded} added, ` +
          `${result.changeReport.summary.nodesModified} modified, ` +
          `${result.changeReport.summary.nodesDeleted} deleted`
        );
      }

      this.logger.log(`Total nodes: ${result.output.nodes.length}, edges: ${result.output.edges.length}`);

      return result;
    } catch (error) {
      this.logger.error(`Incremental CAS analysis failed: ${(error as Error).message}`, (error as Error).stack);
      this.logger.log('Falling back to full analysis...');

      const fullResult = await this.analyzeProject(request);
      const state = await this.orchestrator.orchestrateIncrementalAnalysis(
        projectPath,
        fullResult,
        null
      );

      return state;
    }
  }

  queryAnalysis(casOutput: CASOutput, options: CASAnalysisOptions = {}) {
    this.logger.log(`Querying CAS analysis with options: ${JSON.stringify(options)}`);

    return this.orchestrator.queryAnalysis(casOutput, {
      level: options.level,
      type: options.type,
      nameFilter: options.nameFilter,
      includeEdges: true
    });
  }

  extractSummary(casOutput: CASOutput): CASSummaryOutput {
    const nodesByType: Record<string, number> = {};
    casOutput.nodes.forEach(n => {
      nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
    });

    const edgesByType: Record<string, number> = {};
    casOutput.edges.forEach(e => {
      edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
    });

    return {
      cas_version: casOutput.cas_version,
      analysis_timestamp: casOutput.analysis_timestamp,
      analysis_id: casOutput.analysis_id,
      system: {
        name: casOutput.system.name,
        type: casOutput.system.type
      },
      architecture_summary: casOutput.architecture_summary,
      route_table: casOutput.route_table,
      database_schema: casOutput.database_schema,
      external_services_count: casOutput.external_services?.length,
      node_counts: {
        total: casOutput.nodes.length,
        by_type: nodesByType
      },
      edge_counts: {
        total: casOutput.edges.length,
        by_type: edgesByType
      }
    };
  }

  async getDetectedAnalyzers(projectPath: string): Promise<AnalyzerRegistration[]> {
    if (!await fs.pathExists(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    return this.orchestrator.detectAnalyzers(projectPath);
  }

  private registerAnalyzers(): void {
    this.logger.log('Registering CAS analyzers...');

    this.registerLanguageAnalyzers();
    this.registerFrameworkAnalyzers();
    this.registerLibraryAnalyzers();

    this.logger.log('CAS analyzers registered successfully');
  }

  private registerLanguageAnalyzers(): void {
    const registrations: AnalyzerRegistration[] = [
      {
        id: 'typescript-javascript',
        name: 'TypeScript/JavaScript Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['package.json', 'tsconfig.json', 'jsconfig.json'],
          content: [/\.ts$/, /\.js$/, /\.tsx$/, /\.jsx$/]
        },
        analyzer: new TypeScriptJavaScriptAnalyzer()
      },
      {
        id: 'python',
        name: 'Python Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'],
          content: [/\.py$/]
        },
        analyzer: new PythonAnalyzer()
      },
      {
        id: 'java',
        name: 'Java Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
          content: [/\.java$/]
        },
        analyzer: new JavaAnalyzer()
      },
      {
        id: 'csharp',
        name: 'C# Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['*.csproj', '*.sln'],
          content: [/\.cs$/]
        },
        analyzer: new CSharpAnalyzer()
      },
      {
        id: 'go',
        name: 'Go Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['go.mod', 'go.sum'],
          content: [/\.go$/]
        },
        analyzer: new GoAnalyzer()
      },
      {
        id: 'rust',
        name: 'Rust Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['Cargo.toml', 'Cargo.lock'],
          content: [/\.rs$/]
        },
        analyzer: new RustAnalyzer()
      },
      {
        id: 'php',
        name: 'PHP Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['composer.json', 'composer.lock'],
          content: [/\.php$/]
        },
        analyzer: new PHPAnalyzer()
      },
      {
        id: 'ruby',
        name: 'Ruby Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['Gemfile', 'Gemfile.lock', 'Rakefile'],
          content: [/\.rb$/]
        },
        analyzer: new RubyAnalyzer()
      },
      {
        id: 'dart',
        name: 'Dart/Flutter Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['pubspec.yaml'],
          content: [/\.dart$/]
        },
        analyzer: new DartAnalyzer()
      },
      {
        id: 'terraform',
        name: 'Terraform/HCL Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['*.tf', '*.tfvars'],
          content: [/\.tf$/, /\.tfvars$/]
        },
        analyzer: new TerraformAnalyzer()
      },
      {
        id: 'c-cpp',
        name: 'C/C++ Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['CMakeLists.txt', 'Makefile', '*.vcxproj'],
          content: [/\.(c|h|cpp|cc|cxx|hpp|hh|hxx)$/]
        },
        analyzer: new CCppAnalyzer()
      },
      {
        id: 'kotlin',
        name: 'Kotlin Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['build.gradle.kts', 'settings.gradle.kts'],
          content: [/\.kt$/, /\.kts$/]
        },
        analyzer: new KotlinAnalyzer()
      },
      {
        id: 'swift',
        name: 'Swift Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['Package.swift', '*.xcodeproj'],
          content: [/\.swift$/]
        },
        analyzer: new SwiftAnalyzer()
      },
      {
        id: 'solidity',
        name: 'Solidity Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['hardhat.config.js', 'hardhat.config.ts', 'foundry.toml', 'truffle-config.js'],
          content: [/\.sol$/]
        },
        analyzer: new SolidityAnalyzer()
      },
      {
        id: 'elixir',
        name: 'Elixir Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['mix.exs', 'mix.lock'],
          content: [/\.ex$/, /\.exs$/]
        },
        analyzer: new ElixirAnalyzer()
      },
      {
        id: 'shell',
        name: 'Shell/Bash Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['*.sh', '*.bash', '*.zsh', '*.ksh'],
          content: [/^#!.*\b(?:sh|bash|zsh|ksh|dash|ash)\b/m]
        },
        analyzer: new ShellAnalyzer()
      },
      {
        id: 'protobuf',
        name: 'Protobuf/gRPC Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['buf.yaml', 'buf.gen.yaml'],
          content: [/\.proto$/]
        },
        analyzer: new ProtobufAnalyzer()
      },
      {
        id: 'dockerfile',
        name: 'Dockerfile Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['Dockerfile', 'Dockerfile.*', '*.Dockerfile'],
          content: [/^FROM\s+/m]
        },
        analyzer: new DockerfileAnalyzer()
      },
      {
        id: 'docker-compose',
        name: 'Docker Compose Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml', 'docker-compose.*.yml', 'docker-compose.*.yaml'],
          content: [/^services:\s*$/m]
        },
        analyzer: new DockerComposeAnalyzer()
      },
      {
        id: 'kubernetes-manifest',
        name: 'Kubernetes Manifest Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['k8s/**/*.yaml', 'k8s/**/*.yml', 'kubernetes/**/*.yaml', 'kubernetes/**/*.yml', 'deploy/**/*.yaml', 'deploy/**/*.yml'],
          content: [/^apiVersion:\s+/m, /^kind:\s+(Deployment|Service|Ingress|StatefulSet|Job|CronJob|ConfigMap|Secret)/m]
        },
        analyzer: new KubernetesManifestAnalyzer()
      },
      {
        id: 'distribution-artifacts',
        name: 'Distribution Artifact Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          files: ['*.sh', '*.bash', '*.zsh', '*.ps1', '*.psm1', '*.bat', '*.cmd', '*.nsi', '*.wxs', '*.desktop', '*.service'],
          content: [/systemctl|launchctl|makensis|msiexec|pkgbuild|create-dmg|SERVICE_NAME|BINARY_NAME|DOWNLOAD_PREFIX|manifest\.json/i]
        },
        analyzer: new DistributionArtifactAnalyzer()
      },
      {
        // Breadth fallback: any grammar-backed language without a deep analyzer
        // (zig, haskell, lua, ocaml, erlang, clojure, julia, nim, fortran, …).
        // Detection is via canAnalyze (no fixed extension list — it covers ~130).
        id: 'generic-tree-sitter',
        name: 'Generic Tree-sitter Analyzer',
        type: 'language',
        version: '1.0.0',
        detectPatterns: {
          content: [/\.(zig|hs|lua|ml|erl|ex|exs|clj|jl|nim|f90|ada|d|cr|nix|ipynb)$/i]
        },
        analyzer: new GenericTreeSitterLanguageAnalyzer()
      }
    ];

    registrations.forEach(registration => {
      this.orchestrator.registerAnalyzer(registration);
      this.logger.log(`  ✓ Registered language analyzer: ${registration.name}`);
    });
  }

  private registerFrameworkAnalyzers(): void {
    const registrations: AnalyzerRegistration[] = [
      {
        id: 'nestjs',
        name: 'NestJS Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['@nestjs/core', '@nestjs/common']
        },
        requires: ['typescript-javascript'],
        analyzer: new NestJSAnalyzer()
      },
      {
        id: 'spring-boot',
        name: 'Spring Boot Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['spring-boot-starter', 'org.springframework.boot'],
          files: ['pom.xml', 'build.gradle']
        },
        requires: ['java'],
        analyzer: new SpringBootAnalyzer()
      },
      {
        id: 'django',
        name: 'Django Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['Django', 'django'],
          files: ['manage.py', 'requirements.txt']
        },
        requires: ['python'],
        analyzer: new DjangoAnalyzer()
      },
      {
        id: 'flask',
        name: 'Flask Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['Flask', 'flask'],
          files: ['requirements.txt']
        },
        requires: ['python'],
        analyzer: new FlaskAnalyzer()
      },
      {
        id: 'fastapi',
        name: 'FastAPI Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['fastapi', 'FastAPI'],
          files: ['requirements.txt']
        },
        requires: ['python'],
        analyzer: new FastAPIAnalyzer()
      },
      {
        id: 'laravel',
        name: 'Laravel Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          files: ['artisan', 'composer.json'],
          dependencies: ['laravel/framework']
        },
        requires: ['php'],
        analyzer: new LaravelAnalyzer()
      },
      {
        id: 'symfony',
        name: 'Symfony Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          files: ['bin/console', 'composer.json'],
          dependencies: ['symfony/framework-bundle']
        },
        requires: ['php'],
        analyzer: new SymfonyAnalyzer()
      },
      {
        id: 'rails',
        name: 'Rails Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          files: ['Gemfile', 'config/routes.rb'],
          dependencies: ['rails']
        },
        requires: ['ruby'],
        analyzer: new RailsAnalyzer()
      },
      {
        id: 'phoenix',
        name: 'Phoenix Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          files: ['mix.exs'],
          dependencies: ['phoenix']
        },
        requires: ['elixir'],
        analyzer: new PhoenixAnalyzer()
      },
      {
        id: 'express',
        name: 'Express.js Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['express'],
          files: ['package.json']
        },
        requires: ['typescript-javascript'],
        analyzer: new ExpressAnalyzer()
      },
      {
        id: 'react',
        name: 'React Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['react', 'react-dom'],
          files: ['package.json'],
          content: [/\.jsx$/, /\.tsx$/]
        },
        requires: ['typescript-javascript'],
        analyzer: new ReactAnalyzer()
      },
      {
        id: 'angular',
        name: 'Angular Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['@angular/core', '@angular/common'],
          files: ['angular.json', 'package.json'],
          content: [/\.component\.ts$/]
        },
        requires: ['typescript-javascript'],
        analyzer: new AngularAnalyzer()
      },
      {
        id: 'vue',
        name: 'Vue.js Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['vue', 'vue@'],
          files: ['package.json'],
          content: [/\.vue$/]
        },
        requires: ['typescript-javascript'],
        analyzer: new VueAnalyzer()
      },
      {
        id: 'jest',
        name: 'Jest Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['jest', '@jest/core'],
          files: ['jest.config.js', 'jest.config.ts'],
          content: [/\.test\.(js|ts|jsx|tsx)$/, /\.spec\.(js|ts|jsx|tsx)$/]
        },
        requires: ['typescript-javascript'],
        analyzer: new JestAnalyzer()
      },
      {
        id: 'cypress',
        name: 'Cypress Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['cypress'],
          files: ['cypress.json', 'cypress.config.js', 'cypress.config.ts'],
          content: [/\.cy\.(js|ts|jsx|tsx)$/]
        },
        requires: ['typescript-javascript'],
        analyzer: new CypressAnalyzer()
      },
      {
        id: 'wpf',
        name: 'WPF Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          files: ['**/*.xaml', '**/*.csproj'],
          content: [/PresentationFramework/, /System\.Windows/, /<UseWPF>true<\/UseWPF>/]
        },
        requires: ['csharp'],
        analyzer: new WPFAnalyzer()
      },
      {
        id: 'aspnet-core',
        name: 'ASP.NET Core Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          files: ['**/*.csproj'],
          content: [/Microsoft\.AspNetCore/, /Microsoft\.NET\.Sdk\.Web/]
        },
        requires: ['csharp'],
        analyzer: new AspNetCoreAnalyzer()
      },
      {
        id: 'nextjs',
        name: 'Next.js Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['next'],
          files: ['next.config.js', 'next.config.mjs', 'next.config.ts']
        },
        requires: ['typescript-javascript'],
        analyzer: new NextJSAnalyzer()
      },
      {
        id: 'actix-web',
        name: 'Actix-web Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['actix-web', 'actix_web'],
          files: ['Cargo.toml'],
          content: [/actix_web::/, /#\[(get|post|put|delete|patch)\("/, /HttpServer::/]
        },
        requires: ['rust'],
        analyzer: new ActixAnalyzer()
      },
      {
        id: 'rocket',
        name: 'Rocket Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['rocket', 'rocket_dyn_templates', 'rocket_sync'],
          files: ['Cargo.toml'],
          content: [/rocket::/, /#\[(get|post|put|delete|patch)\("/, /rocket::build/]
        },
        requires: ['rust'],
        analyzer: new RocketAnalyzer()
      },
      {
        id: 'axum',
        name: 'Axum Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['axum'],
          files: ['Cargo.toml'],
          content: [/axum::/, /Router::new\s*\(/, /\.route\s*\(\s*"/]
        },
        requires: ['rust'],
        analyzer: new AxumAnalyzer()
      },
      {
        id: 'vapor',
        name: 'Vapor Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['vapor'],
          files: ['Package.swift', '**/*.swift'],
          content: [/import\s+Vapor/, /\.grouped\s*\(/, /\.(get|post|put|delete|patch)\s*\(/]
        },
        requires: ['swift'],
        analyzer: new VaporAnalyzer()
      },
      {
        id: 'mojolicious',
        name: 'Mojolicious Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['Mojolicious'],
          files: ['cpanfile', 'Makefile.PL', '**/*.pl', '**/*.pm'],
          content: [/use\s+Mojolicious/, /^\s*(get|post|put|patch|del|options|any)\s+['"]/m, /->(get|post|put|patch|del|options|any|under)\s*\(/]
        },
        requires: ['perl'],
        analyzer: new MojoliciousAnalyzer()
      },
      {
        id: 'gorouter',
        name: 'GoRouter Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['go_router'],
          files: ['pubspec.yaml', '**/*.dart'],
          content: [/GoRouter\s*\(/, /GoRoute\s*\(/, /package:go_router/]
        },
        requires: ['dart'],
        analyzer: new GoRouterAnalyzer()
      },
      {
        id: 'http4s',
        name: 'http4s Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['http4s', 'http4s-dsl'],
          files: ['build.sbt', '**/*.scala'],
          content: [/org\.http4s/, /HttpRoutes\.of/, /AuthedRoutes\.of/]
        },
        requires: ['scala'],
        analyzer: new Http4sAnalyzer()
      },
      {
        id: 'kemal',
        name: 'Kemal Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['kemal'],
          files: ['shard.yml', '**/*.cr'],
          content: [/require\s+"kemal"/, /^\s*(get|post|put|patch|delete|options|head|ws)\s+"/m]
        },
        requires: ['crystal'],
        analyzer: new KemalAnalyzer()
      },
      {
        id: 'genie',
        name: 'Genie Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['Genie'],
          files: ['Project.toml', '**/*.jl'],
          content: [/Genie/, /\broute\s*\(/, /@(get|post|put|patch|delete)\s*\(/]
        },
        requires: ['julia'],
        analyzer: new GenieAnalyzer()
      },
      {
        id: 'compojure',
        name: 'Compojure Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['compojure'],
          files: ['deps.edn', 'project.clj', '**/*.clj', '**/*.cljs', '**/*.cljc'],
          content: [/compojure\.core/, /\(defroutes\b/, /\(context\b/, /\((?:GET|POST|PUT|DELETE|PATCH|ANY)\s+"/]
        },
        requires: ['clojure'],
        analyzer: new CompojureAnalyzer()
      },
      {
        id: 'dream',
        name: 'Dream Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['dream'],
          files: ['dune-project', 'dune', '**/*.ml'],
          content: [/Dream\.router/, /Dream\.(get|post|put|patch|delete|options|head)\s+"/, /Dream\.scope/]
        },
        requires: ['ocaml'],
        analyzer: new DreamAnalyzer()
      },
      {
        id: 'apexrest',
        name: 'Apex REST Analyzer',
        type: 'framework',
        version: '1.0.0',
        detectPatterns: {
          dependencies: [],
          files: ['sfdx-project.json', '**/*.cls'],
          content: [/@RestResource\b/, /@Http(Get|Post|Put|Patch|Delete)\b/]
        },
        requires: ['apex'],
        analyzer: new ApexRestAnalyzer()
      }
    ];

    registrations.forEach(registration => {
      this.orchestrator.registerAnalyzer(registration);
      this.logger.log(`  ✓ Registered framework analyzer: ${registration.name}`);
    });
  }

  private registerLibraryAnalyzers(): void {
    const registrations: AnalyzerRegistration[] = [
      {
        id: 'prisma',
        name: 'Prisma ORM Analyzer',
        type: 'library',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['prisma', '@prisma/client'],
          files: ['prisma/schema.prisma']
        },
        requires: ['typescript-javascript'],
        analyzer: new PrismaAnalyzer()
      },
      {
        id: 'socketio',
        name: 'Socket.io Analyzer',
        type: 'library',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['socket.io', 'socket.io-client']
        },
        requires: ['typescript-javascript'],
        analyzer: new SocketIOAnalyzer()
      },
      {
        id: 'react-router',
        name: 'React Router Analyzer',
        type: 'library',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['react-router-dom', 'react-router']
        },
        requires: ['typescript-javascript'],
        analyzer: new ReactRouterAnalyzer()
      },
      {
        id: 'redux',
        name: 'Redux/RTK Analyzer',
        type: 'library',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['@reduxjs/toolkit', 'redux']
        },
        requires: ['typescript-javascript'],
        analyzer: new ReduxAnalyzer()
      },
      {
        id: 'zustand',
        name: 'Zustand Analyzer',
        type: 'library',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['zustand']
        },
        requires: ['typescript-javascript'],
        analyzer: new ZustandAnalyzer()
      },
      {
        id: 'tanstack-query',
        name: 'TanStack Query Analyzer',
        type: 'library',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['@tanstack/react-query', 'react-query', '@tanstack/vue-query', '@tanstack/svelte-query']
        },
        requires: ['typescript-javascript'],
        analyzer: new TanStackQueryAnalyzer()
      },
      {
        id: 'reqwest',
        name: 'Reqwest HTTP Client Analyzer',
        type: 'library',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['reqwest'],
          files: ['Cargo.toml']
        },
        requires: ['rust'],
        analyzer: new ReqwestAnalyzer()
      },
      {
        id: 'mcp-tool-registration',
        name: 'MCP Tool Registration Analyzer',
        type: 'library',
        version: '1.0.0',
        detectPatterns: {
          dependencies: ['@modelcontextprotocol/sdk'],
          content: [/\.registerTool\s*\(/, /\.setRequestHandler\s*\(/]
        },
        requires: ['typescript-javascript'],
        analyzer: new McpToolRegistrationAnalyzer()
      },
      {
        id: 'ai-stack',
        name: 'AI Stack Analyzer',
        type: 'library',
        version: '1.0.0',
        detectPatterns: {
          dependencies: [
            'langchain', '@langchain/core', '@langchain/langgraph',
            'llamaindex', 'llama-index',
            'ai', '@ai-sdk/openai', '@ai-sdk/anthropic',
            'openai',
            '@anthropic-ai/sdk', 'anthropic',
            '@modelcontextprotocol/sdk', 'mcp', 'fastmcp',
            'crewai', 'langgraph',
            'autogen', 'pyautogen',
            'pinecone', '@pinecone-database/pinecone',
            'weaviate', 'weaviate-client', 'weaviate-ts-client',
            'chromadb',
            'qdrant', '@qdrant/js-client-rest', 'qdrant-client',
            'pgvector'
          ],
          files: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']
        },
        analyzer: new AIStackAnalyzer()
      },
      ...architectureLibraryAnalyzerDefinitions().map(definition => ({
        id: definition.id,
        name: definition.name,
        type: 'library' as const,
        version: '1.0.0',
        detectPatterns: { dependencies: definition.dependencies },
        analyzer: definition.analyzer,
      }))
    ];

    registrations.forEach(registration => {
      this.orchestrator.registerAnalyzer(registration);
      this.logger.log(`  ✓ Registered library analyzer: ${registration.name}`);
    });
  }
}
