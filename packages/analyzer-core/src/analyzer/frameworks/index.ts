export * from './web';
export * from './testing';
export * from './mobile';
export * from './swift';
export * from './dart';
export * from './scala';
export * from './crystal';
export * from './julia';
export * from './clojure';
export * from './ocaml';
export * from './apex';
export * from './perl';

import { VaporAnalyzer } from './swift';
import { GoRouterAnalyzer } from './dart';
import { Http4sAnalyzer } from './scala';
import { KemalAnalyzer } from './crystal';
import { GenieAnalyzer } from './julia';
import { CompojureAnalyzer } from './clojure';
import { DreamAnalyzer } from './ocaml';
import { ApexRestAnalyzer } from './apex';
import { MojoliciousAnalyzer } from './perl';

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
} from './web';

import { JestAnalyzer, CypressAnalyzer } from './testing';

import { BaseAnalyzer } from '../core/base-analyzer';

export interface FrameworkAnalyzerInfo {
  name: string;
  analyzer: any;
  category: 'web' | 'mobile' | 'testing' | 'library';
  languages: string[];
  frameworks: string[];
  priority: number;
}

export const FRAMEWORK_ANALYZERS: FrameworkAnalyzerInfo[] = [
  {
    name: 'NestJS',
    analyzer: NestJSAnalyzer,
    category: 'web',
    languages: ['typescript', 'javascript'],
    frameworks: ['nestjs', '@nestjs/core', '@nestjs/common'],
    priority: 120
  },
  {
    name: 'Spring Boot',
    analyzer: SpringBootAnalyzer,
    category: 'web',
    languages: ['java'],
    frameworks: ['spring-boot', 'org.springframework.boot'],
    priority: 115
  },
  {
    name: 'Django',
    analyzer: DjangoAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['django'],
    priority: 110
  },
  {
    name: 'Flask',
    analyzer: FlaskAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['flask'],
    priority: 105
  },
  {
    name: 'FastAPI',
    analyzer: FastAPIAnalyzer,
    category: 'web',
    languages: ['python'],
    frameworks: ['fastapi'],
    priority: 108
  },
  {
    name: 'Express.js',
    analyzer: ExpressAnalyzer,
    category: 'web',
    languages: ['javascript', 'typescript'],
    frameworks: ['express'],
    priority: 100
  },
  {
    name: 'React',
    analyzer: ReactAnalyzer,
    category: 'web',
    languages: ['javascript', 'typescript'],
    frameworks: ['react', 'react-dom'],
    priority: 95
  },
  {
    name: 'Vue.js',
    analyzer: VueAnalyzer,
    category: 'web',
    languages: ['javascript', 'typescript'],
    frameworks: ['vue', '@vue/cli', 'nuxt'],
    priority: 93
  },
  {
    name: 'Angular',
    analyzer: AngularAnalyzer,
    category: 'web',
    languages: ['typescript'],
    frameworks: ['@angular/core', '@angular/cli'],
    priority: 90
  },
  {
    name: 'Laravel',
    analyzer: LaravelAnalyzer,
    category: 'web',
    languages: ['php'],
    frameworks: ['laravel/framework', 'laravel/laravel'],
    priority: 85
  },
  {
    name: 'Vapor',
    analyzer: VaporAnalyzer,
    category: 'web',
    languages: ['swift'],
    frameworks: ['vapor'],
    priority: 112
  },
  {
    name: 'Mojolicious',
    analyzer: MojoliciousAnalyzer,
    category: 'web',
    languages: ['perl'],
    frameworks: ['mojolicious', 'Mojolicious::Lite'],
    priority: 112
  },
  {
    name: 'GoRouter',
    analyzer: GoRouterAnalyzer,
    category: 'web',
    languages: ['dart'],
    frameworks: ['go_router', 'gorouter'],
    priority: 112
  },
  {
    name: 'http4s',
    analyzer: Http4sAnalyzer,
    category: 'web',
    languages: ['scala'],
    frameworks: ['http4s', 'http4s-dsl'],
    priority: 112
  },
  {
    name: 'kemal',
    analyzer: KemalAnalyzer,
    category: 'web',
    languages: ['crystal'],
    frameworks: ['kemal'],
    priority: 112
  },
  {
    name: 'Genie',
    analyzer: GenieAnalyzer,
    category: 'web',
    languages: ['julia'],
    frameworks: ['Genie'],
    priority: 112
  },
  {
    name: 'Compojure',
    analyzer: CompojureAnalyzer,
    category: 'web',
    languages: ['clojure'],
    frameworks: ['compojure'],
    priority: 112
  },
  {
    name: 'dream',
    analyzer: DreamAnalyzer,
    category: 'web',
    languages: ['ocaml'],
    frameworks: ['dream'],
    priority: 112
  },
  {
    name: 'ApexREST',
    analyzer: ApexRestAnalyzer,
    category: 'web',
    languages: ['apex'],
    frameworks: ['apex-rest'],
    priority: 112
  },
  {
    name: 'Jest',
    analyzer: JestAnalyzer,
    category: 'testing',
    languages: ['javascript', 'typescript'],
    frameworks: ['jest', '@jest/core'],
    priority: 50
  },
  {
    name: 'Cypress',
    analyzer: CypressAnalyzer,
    category: 'testing',
    languages: ['javascript', 'typescript'],
    frameworks: ['cypress'],
    priority: 55
  }
];

export function getFrameworkAnalyzer(
  language: string,
  detectedFrameworks: string[]
): typeof BaseAnalyzer | null {
  const sortedAnalyzers = [...FRAMEWORK_ANALYZERS].sort((a, b) => b.priority - a.priority);

  for (const analyzerInfo of sortedAnalyzers) {
    if (!analyzerInfo.languages.includes(language.toLowerCase())) {
      continue;
    }

    const frameworkMatch = analyzerInfo.frameworks.some(fw =>
      detectedFrameworks.some(detected =>
        detected.toLowerCase().includes(fw.toLowerCase()) ||
        fw.toLowerCase().includes(detected.toLowerCase())
      )
    );

    if (frameworkMatch) {
      return analyzerInfo.analyzer;
    }
  }

  return null;
}

export async function detectFrameworkFromFiles(
  projectPath: string,
  files: string[]
): Promise<string[]> {
  const detectedFrameworks: string[] = [];

  if (files.some(f => f.endsWith('.jsx') || f.endsWith('.tsx'))) {
    if (files.some(f => f.includes('next.config'))) {
      detectedFrameworks.push('nextjs');
    } else {
      detectedFrameworks.push('react');
    }
  }

  if (files.some(f => f.endsWith('.vue'))) {
    detectedFrameworks.push('vue');
  }

  if (files.some(f => f === 'angular.json' || f.includes('@angular'))) {
    detectedFrameworks.push('@angular/core');
  }

  if (files.some(f => f === 'manage.py')) {
    detectedFrameworks.push('django');
  }

  if (files.some(f => f === 'Package.swift' || f.endsWith('.swift'))) {
    detectedFrameworks.push('vapor');
  }

  if (files.some(f => f === 'cpanfile' || f.endsWith('.pl') || f.endsWith('.pm'))) {
    detectedFrameworks.push('mojolicious');
  }

  if (files.some(f => f === 'pubspec.yaml' || f.endsWith('.dart'))) {
    detectedFrameworks.push('go_router');
  }

  if (files.some(f => f === 'build.sbt' || f.endsWith('.scala'))) {
    detectedFrameworks.push('http4s');
  }

  if (files.some(f => f === 'shard.yml' || f.endsWith('.cr'))) {
    detectedFrameworks.push('kemal');
  }

  if (files.some(f => f === 'Project.toml' || f.endsWith('.jl'))) {
    detectedFrameworks.push('Genie');
  }

  if (files.some(f => f === 'deps.edn' || f === 'project.clj' || f.endsWith('.clj') || f.endsWith('.cljs') || f.endsWith('.cljc'))) {
    detectedFrameworks.push('compojure');
  }

  if (files.some(f => f === 'dune-project' || f === 'dune' || f.endsWith('.ml'))) {
    detectedFrameworks.push('dream');
  }

  if (files.some(f => f === 'sfdx-project.json' || f.endsWith('.cls'))) {
    detectedFrameworks.push('apex-rest');
  }

  if (files.some(f => f === 'artisan' || f.includes('laravel'))) {
    detectedFrameworks.push('laravel/framework');
  }

  if (files.some(f => f.includes('pom.xml') || f.includes('build.gradle'))) {
    detectedFrameworks.push('spring-boot');
  }

  if (files.some(f => f.includes('.test.') || f.includes('.spec.'))) {
    detectedFrameworks.push('jest');
  }

  if (files.some(f => f.includes('cypress.config') || f.includes('cypress/'))) {
    detectedFrameworks.push('cypress');
  }

  if (files.some(f => f.includes('nest-cli.json') || f.includes('@nestjs'))) {
    detectedFrameworks.push('@nestjs/core');
  }

  return detectedFrameworks;
}