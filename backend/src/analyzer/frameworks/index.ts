// Framework Analyzers Index - Exports all framework-specific analyzers
// Phase 3: Framework Sub-Analyzers - Central export point

// Frontend Framework Analyzers
export { ReactAnalyzer } from './frontend/react-analyzer';
export { VueAnalyzer } from './frontend/vue-analyzer';
export { AngularAnalyzer } from './frontend/angular-analyzer';
export { NextJSAnalyzer } from './frontend/nextjs-analyzer';

// Backend Framework Analyzers
export { DjangoAnalyzer } from './backend/django-analyzer';

// Framework Analyzer Registry
import { BaseAnalyzer } from '../base-analyzer';
import { ReactAnalyzer } from './frontend/react-analyzer';
import { VueAnalyzer } from './frontend/vue-analyzer';
import { AngularAnalyzer } from './frontend/angular-analyzer';
import { NextJSAnalyzer } from './frontend/nextjs-analyzer';
import { DjangoAnalyzer } from './backend/django-analyzer';

export interface FrameworkAnalyzerInfo {
  name: string;
  analyzer: typeof BaseAnalyzer;
  category: 'frontend' | 'backend' | 'fullstack';
  languages: string[];
  frameworks: string[];
  priority: number;
}

// Registry of all framework analyzers
export const FRAMEWORK_ANALYZERS: FrameworkAnalyzerInfo[] = [
  // Frontend Frameworks
  {
    name: 'React',
    analyzer: ReactAnalyzer as typeof BaseAnalyzer,
    category: 'frontend',
    languages: ['javascript', 'typescript'],
    frameworks: ['react', 'react-native'],
    priority: 100
  },
  {
    name: 'Vue',
    analyzer: VueAnalyzer as typeof BaseAnalyzer,
    category: 'frontend',
    languages: ['javascript', 'typescript'],
    frameworks: ['vue', 'nuxt'],
    priority: 95
  },
  {
    name: 'Angular',
    analyzer: AngularAnalyzer as typeof BaseAnalyzer,
    category: 'frontend',
    languages: ['typescript'],
    frameworks: ['angular', 'ionic'],
    priority: 90
  },
  {
    name: 'Next.js',
    analyzer: NextJSAnalyzer as typeof BaseAnalyzer,
    category: 'fullstack',
    languages: ['javascript', 'typescript'],
    frameworks: ['next', 'nextjs'],
    priority: 105 // Higher priority than React since it's more specific
  },
  
  // Backend Frameworks
  {
    name: 'Django',
    analyzer: DjangoAnalyzer as typeof BaseAnalyzer,
    category: 'backend',
    languages: ['python'],
    frameworks: ['django', 'django-rest-framework'],
    priority: 100
  }
];

// Helper function to get appropriate framework analyzer
export function getFrameworkAnalyzer(
  language: string,
  detectedFrameworks: string[]
): typeof BaseAnalyzer | null {
  // Sort analyzers by priority (highest first)
  const sortedAnalyzers = [...FRAMEWORK_ANALYZERS].sort((a, b) => b.priority - a.priority);
  
  for (const analyzerInfo of sortedAnalyzers) {
    // Check if language matches
    if (!analyzerInfo.languages.includes(language.toLowerCase())) {
      continue;
    }
    
    // Check if any framework matches
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

// Helper function to detect framework from file patterns
export async function detectFrameworkFromFiles(
  projectPath: string,
  files: string[]
): Promise<string[]> {
  const detectedFrameworks: string[] = [];
  
  // React detection
  if (files.some(f => f.includes('package.json'))) {
    // Would need to read package.json to detect frameworks
    // This is a simplified version
    if (files.some(f => f.endsWith('.jsx') || f.endsWith('.tsx'))) {
      if (files.some(f => f.includes('next.config'))) {
        detectedFrameworks.push('nextjs');
      } else {
        detectedFrameworks.push('react');
      }
    }
  }
  
  // Vue detection
  if (files.some(f => f.endsWith('.vue'))) {
    if (files.some(f => f.includes('nuxt.config'))) {
      detectedFrameworks.push('nuxt');
    } else {
      detectedFrameworks.push('vue');
    }
  }
  
  // Angular detection
  if (files.some(f => f === 'angular.json')) {
    detectedFrameworks.push('angular');
  }
  
  // Django detection
  if (files.some(f => f === 'manage.py')) {
    detectedFrameworks.push('django');
  }
  
  // FastAPI detection
  if (files.some(f => f.includes('main.py') || f.includes('app.py'))) {
    // Would need to read file content to detect FastAPI
    // This is a placeholder
  }
  
  // Express detection
  if (files.some(f => f === 'app.js' || f === 'server.js')) {
    // Would need to read file content to detect Express
    // This is a placeholder
  }
  
  return detectedFrameworks;
}

// Export types for framework-specific components
export type {
  // React types
  ReactComponent,
  ReactHook,
  ReactRoute,
  ReactStateManagement
} from './frontend/react-analyzer';

export type {
  // Vue types
  VueComponent,
  VueProp,
  VueRoute,
  VueStore
} from './frontend/vue-analyzer';

export type {
  // Angular types
  AngularComponent,
  AngularModule,
  AngularService,
  AngularRoute
} from './frontend/angular-analyzer';

export type {
  // Next.js types
  NextJSPage,
  NextJSAPIRoute,
  NextJSDataFetching,
  NextJSConfig
} from './frontend/nextjs-analyzer';

export type {
  // Django types
  DjangoModel,
  DjangoView,
  DjangoApp,
  DjangoURL
} from './backend/django-analyzer';