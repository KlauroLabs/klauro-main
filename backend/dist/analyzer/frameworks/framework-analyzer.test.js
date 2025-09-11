"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const react_analyzer_1 = require("./frontend/react-analyzer");
const vue_analyzer_1 = require("./frontend/vue-analyzer");
const angular_analyzer_1 = require("./frontend/angular-analyzer");
const nextjs_analyzer_1 = require("./frontend/nextjs-analyzer");
const django_analyzer_1 = require("./backend/django-analyzer");
const plugin_registry_1 = require("../plugin-registry");
const register_framework_analyzers_1 = require("../register-framework-analyzers");
const TEST_TIMEOUT = 30000;
describe('Framework Analyzers', () => {
    let registry;
    beforeEach(() => {
        registry = new plugin_registry_1.PluginRegistry();
    });
    describe('Framework Registration', () => {
        test('should register all framework analyzers', async () => {
            await (0, register_framework_analyzers_1.registerFrameworkAnalyzers)(registry);
            const stats = registry.getStatistics();
            expect(stats.frameworkAnalyzers).toBeGreaterThan(0);
            expect(registry.getPlugin('unravl.framework.react')).toBeDefined();
            expect(registry.getPlugin('unravl.framework.vue')).toBeDefined();
            expect(registry.getPlugin('unravl.framework.angular')).toBeDefined();
            expect(registry.getPlugin('unravl.framework.nextjs')).toBeDefined();
            expect(registry.getPlugin('unravl.framework.django')).toBeDefined();
        }, TEST_TIMEOUT);
        test('should auto-detect React framework', async () => {
            const pluginId = await (0, register_framework_analyzers_1.autoRegisterFrameworkAnalyzer)(registry, '/test/project', 'typescript', ['react', 'redux']);
            expect(pluginId).toBe('unravl.framework.react');
        });
        test('should auto-detect Next.js over React', async () => {
            const pluginId = await (0, register_framework_analyzers_1.autoRegisterFrameworkAnalyzer)(registry, '/test/project', 'typescript', ['react', 'next']);
            expect(pluginId).toBe('unravl.framework.nextjs');
        });
    });
    describe('React Analyzer', () => {
        let analyzer;
        beforeEach(() => {
            analyzer = new react_analyzer_1.ReactAnalyzer();
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
        let analyzer;
        beforeEach(() => {
            analyzer = new vue_analyzer_1.VueAnalyzer();
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
        let analyzer;
        beforeEach(() => {
            analyzer = new angular_analyzer_1.AngularAnalyzer();
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
        let analyzer;
        beforeEach(() => {
            analyzer = new nextjs_analyzer_1.NextJSAnalyzer();
        });
        test('should identify as Next.js analyzer', () => {
            expect(analyzer.getAnalyzerName()).toBe('Next.js Framework Analyzer');
            expect(analyzer.getSupportedFrameworks()).toContain('next');
        });
        test('should extend React analyzer', () => {
            expect(analyzer).toBeInstanceOf(react_analyzer_1.ReactAnalyzer);
        });
    });
    describe('Django Analyzer', () => {
        let analyzer;
        beforeEach(() => {
            analyzer = new django_analyzer_1.DjangoAnalyzer();
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
            const reactAnalyzer = new react_analyzer_1.ReactAnalyzer();
            const nextAnalyzer = new nextjs_analyzer_1.NextJSAnalyzer();
            expect(nextAnalyzer).toBeInstanceOf(react_analyzer_1.ReactAnalyzer);
            expect(typeof nextAnalyzer.getSupportedFrameworks).toBe('function');
        });
        test('should handle mock React project analysis', async () => {
            const analyzer = new react_analyzer_1.ReactAnalyzer();
            jest.spyOn(analyzer, 'findFiles').mockResolvedValue([
                'src/App.tsx',
                'src/components/Header.tsx',
                'src/components/Footer.tsx',
                'src/hooks/useAuth.ts',
                'src/pages/Home.tsx'
            ]);
            jest.spyOn(analyzer, 'readFile').mockImplementation((...args) => {
                const filePath = args[0];
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
            const analyzer = new django_analyzer_1.DjangoAnalyzer();
            jest.spyOn(analyzer, 'findFiles').mockResolvedValue([
                'manage.py',
                'myapp/models.py',
                'myapp/views.py',
                'myapp/urls.py',
                'myapp/serializers.py'
            ]);
            jest.spyOn(analyzer, 'readFile').mockImplementation((...args) => {
                const filePath = args[0];
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
describe('Framework Analyzer Performance', () => {
    test('should complete analysis within reasonable time', async () => {
        const analyzer = new react_analyzer_1.ReactAnalyzer();
        jest.spyOn(analyzer, 'findFiles').mockResolvedValue(Array.from({ length: 1000 }, (_, i) => `src/component${i}.tsx`));
        const startTime = Date.now();
        await analyzer.analyzeRepository('/test/large-project');
        const elapsedTime = Date.now() - startTime;
        expect(elapsedTime).toBeLessThan(10000);
    }, TEST_TIMEOUT);
});
