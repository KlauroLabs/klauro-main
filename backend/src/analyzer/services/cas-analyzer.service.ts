import { Injectable, Logger } from '@nestjs/common';
import { AnalyzerOrchestrator, CASOutput, AnalyzerRegistration } from '../core/orchestrator';
import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';

import { TypeScriptJavaScriptAnalyzer } from '../languages/typescript-javascript-analyzer';
import { PythonAnalyzer } from '../languages/python-analyzer';
import { JavaAnalyzer } from '../languages/java-analyzer';
import { CSharpAnalyzer } from '../languages/csharp-analyzer';
import { GoAnalyzer } from '../languages/go-analyzer';
import { RustAnalyzer } from '../languages/rust-analyzer';
import { PHPAnalyzer } from '../languages/php-analyzer';

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
  LaravelAnalyzer
} from '../frameworks/web';

import { JestAnalyzer, CypressAnalyzer } from '../frameworks/testing';

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
      }
    ];

    registrations.forEach(registration => {
      this.orchestrator.registerAnalyzer(registration);
      this.logger.log(`  ✓ Registered framework analyzer: ${registration.name}`);
    });
  }
}