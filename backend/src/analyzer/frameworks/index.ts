export * from './web';
export * from './testing';
export * from './mobile';

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