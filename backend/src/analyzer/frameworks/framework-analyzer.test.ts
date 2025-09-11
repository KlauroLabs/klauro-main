// Framework Analyzer Integration Tests
// Phase 3: Framework Sub-Analyzers - Test suite

import { ReactAnalyzer } from './frontend/react-analyzer';
import { VueAnalyzer } from './frontend/vue-analyzer';
import { AngularAnalyzer } from './frontend/angular-analyzer';
import { NextJSAnalyzer } from './frontend/nextjs-analyzer';
import { DjangoAnalyzer } from './backend/django-analyzer';
import { PluginRegistry } from '../plugin-registry';
import { registerFrameworkAnalyzers, autoRegisterFrameworkAnalyzer } from '../register-framework-analyzers';
import * as path from 'path';

// Test configuration
const TEST_TIMEOUT = 30000;

describe('Framework Analyzers', () => {
  let registry: PluginRegistry;
  
  beforeEach(() => {
    registry = new PluginRegistry();
  });
  
  describe('Framework Registration', () => {
    test('should register all framework analyzers', async () => {
      await registerFrameworkAnalyzers(registry);
      
      const stats = registry.getStatistics();
      expect(stats.frameworkAnalyzers).toBeGreaterThan(0);
      
      // Check specific analyzers are registered
      expect(registry.getPlugin('unravl.framework.react')).toBeDefined();
      expect(registry.getPlugin('unravl.framework.vue')).toBeDefined();
      expect(registry.getPlugin('unravl.framework.angular')).toBeDefined();
      expect(registry.getPlugin('unravl.framework.nextjs')).toBeDefined();
      expect(registry.getPlugin('unravl.framework.django')).toBeDefined();
    }, TEST_TIMEOUT);
    
    test('should auto-detect React framework', async () => {
      const pluginId = await autoRegisterFrameworkAnalyzer(
        registry,
        '/test/project',
        'typescript',
        ['react', 'redux']
      );
      
      expect(pluginId).toBe('unravl.framework.react');
    });
    
    test('should auto-detect Next.js over React', async () => {
      const pluginId = await autoRegisterFrameworkAnalyzer(
        registry,
        '/test/project',
        'typescript',
        ['react', 'next']
      );
      
      // Next.js should have higher priority
      expect(pluginId).toBe('unravl.framework.nextjs');
    });
  });
  
  describe('React Analyzer', () => {
    let analyzer: ReactAnalyzer;
    
    beforeEach(() => {
      analyzer = new ReactAnalyzer();
    });
    
    test('should identify as React analyzer', () => {
      expect(analyzer.getAnalyzerName()).toBe('React Framework Analyzer');
      expect(analyzer.getSupportedFrameworks()).toContain('react');
    });
    
    test('should support React-specific frameworks', () => {
      const frameworks = analyzer.getSupportedFrameworks();
      expect(frameworks).toContain('react');
      expect(frameworks).toContain('react-native');
      expect(frameworks).toContain('next');
      expect(frameworks).toContain('gatsby');
    });
  });
  
  describe('Vue Analyzer', () => {
    let analyzer: VueAnalyzer;
    
    beforeEach(() => {
      analyzer = new VueAnalyzer();
    });
    
    test('should identify as Vue analyzer', () => {
      expect(analyzer.getAnalyzerName()).toBe('Vue Framework Analyzer');
      expect(analyzer.getSupportedFrameworks()).toContain('vue');
    });
    
    test('should support Vue-specific frameworks', () => {
      const frameworks = analyzer.getSupportedFrameworks();
      expect(frameworks).toContain('vue');
      expect(frameworks).toContain('nuxt');
      expect(frameworks).toContain('quasar');
      expect(frameworks).toContain('vuetify');
    });
  });
  
  describe('Angular Analyzer', () => {
    let analyzer: AngularAnalyzer;
    
    beforeEach(() => {
      analyzer = new AngularAnalyzer();
    });
    
    test('should identify as Angular analyzer', () => {
      expect(analyzer.getAnalyzerName()).toBe('Angular Framework Analyzer');
      expect(analyzer.getSupportedFrameworks()).toContain('angular');
    });
    
    test('should support Angular-specific frameworks', () => {
      const frameworks = analyzer.getSupportedFrameworks();
      expect(frameworks).toContain('angular');
      expect(frameworks).toContain('ionic');
    });
  });
  
  describe('Next.js Analyzer', () => {
    let analyzer: NextJSAnalyzer;
    
    beforeEach(() => {
      analyzer = new NextJSAnalyzer();
    });
    
    test('should identify as Next.js analyzer', () => {
      expect(analyzer.getAnalyzerName()).toBe('Next.js Framework Analyzer');
      expect(analyzer.getSupportedFrameworks()).toContain('next');
    });
    
    test('should extend React analyzer', () => {
      expect(analyzer).toBeInstanceOf(ReactAnalyzer);
    });
  });
  
  describe('Django Analyzer', () => {
    let analyzer: DjangoAnalyzer;
    
    beforeEach(() => {
      analyzer = new DjangoAnalyzer();
    });
    
    test('should identify as Django analyzer', () => {
      expect(analyzer.getAnalyzerName()).toBe('Django Framework Analyzer');
      expect(analyzer.getSupportedFrameworks()).toContain('django');
    });
    
    test('should support Django-specific frameworks', () => {
      const frameworks = analyzer.getSupportedFrameworks();
      expect(frameworks).toContain('django');
      expect(frameworks).toContain('django-rest-framework');
      expect(frameworks).toContain('django-channels');
    });
  });
  
  describe('Framework Analyzer Integration', () => {
    test('should create proper inheritance chain', () => {
      const reactAnalyzer = new ReactAnalyzer();
      const nextAnalyzer = new NextJSAnalyzer();
      
      // Next.js should extend React
      expect(nextAnalyzer).toBeInstanceOf(ReactAnalyzer);
      
      // Both should have React methods
      expect(typeof nextAnalyzer.getSupportedFrameworks).toBe('function');
    });
    
    test('should handle mock React project analysis', async () => {
      const analyzer = new ReactAnalyzer();
      
      // Mock the file system calls
      jest.spyOn(analyzer as any, 'findFiles').mockResolvedValue([
        'src/App.tsx',
        'src/components/Header.tsx',
        'src/components/Footer.tsx',
        'src/hooks/useAuth.ts',
        'src/pages/Home.tsx'
      ]);
      
      // Mock file reading
      jest.spyOn(analyzer as any, 'readFile').mockImplementation((...args: unknown[]) => {
        const filePath = args[0] as string;
        if (filePath.includes('App.tsx')) {
          return Promise.resolve(`
            import React from 'react';
            
            const App: React.FC = () => {
              return <div>Hello World</div>;
            };
            
            export default App;
          `);
        }
        return Promise.resolve('');
      });
      
      const result = await analyzer.analyzeRepository('/test/react-app');
      expect(result).toBeDefined();
      expect(result.metadata).toBeDefined();
    });
    
    test('should handle mock Django project analysis', async () => {
      const analyzer = new DjangoAnalyzer();
      
      // Mock the file system calls
      jest.spyOn(analyzer as any, 'findFiles').mockResolvedValue([
        'manage.py',
        'myapp/models.py',
        'myapp/views.py',
        'myapp/urls.py',
        'myapp/serializers.py'
      ]);
      
      // Mock file reading
      jest.spyOn(analyzer as any, 'readFile').mockImplementation((...args: unknown[]) => {
        const filePath = args[0] as string;
        if (filePath.includes('models.py')) {
          return Promise.resolve(`
            from django.db import models
            
            class User(models.Model):
                name = models.CharField(max_length=100)
                email = models.EmailField(unique=True)
                created_at = models.DateTimeField(auto_now_add=True)
          `);
        }
        return Promise.resolve('');
      });
      
      const result = await analyzer.analyzeRepository('/test/django-app');
      expect(result).toBeDefined();
      expect(result.metadata).toBeDefined();
    });
  });
});

// Performance tests
describe('Framework Analyzer Performance', () => {
  test('should complete analysis within reasonable time', async () => {
    const analyzer = new ReactAnalyzer();
    
    // Mock large number of files
    jest.spyOn(analyzer as any, 'findFiles').mockResolvedValue(
      Array.from({ length: 1000 }, (_, i) => `src/component${i}.tsx`)
    );
    
    const startTime = Date.now();
    
    // This should use batching and parallelization
    await analyzer.analyzeRepository('/test/large-project');
    
    const elapsedTime = Date.now() - startTime;
    
    // Should complete within 10 seconds even for 1000 files
    expect(elapsedTime).toBeLessThan(10000);
  }, TEST_TIMEOUT);
});