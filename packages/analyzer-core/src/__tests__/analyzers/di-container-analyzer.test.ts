jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { DiContainerBindingAnalyzer } from '../../analyzer/libraries/architecture/di-container-analyzer';
import { CASContribution, CASNode } from '../../types/cas.types';

describe('DiContainerBindingAnalyzer surfaces the DI binding graph (interface -> implementation, lifetime)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-di-container-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function analyzeProject(
    manifests: Record<string, unknown>,
    files: Record<string, string>,
    existingAnalysis?: CASContribution[]
  ): Promise<CASContribution> {
    for (const [name, content] of Object.entries(manifests)) {
      if (typeof content === 'string') {
        await fs.writeFile(path.join(tempDir, name), content);
      } else {
        await fs.writeJson(path.join(tempDir, name), content);
      }
    }
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
    const analyzer = new DiContainerBindingAnalyzer();
    return analyzer.analyze({ projectPath: tempDir, existingAnalysis });
  }

  function bindingNodes(contribution: CASContribution): Array<CASNode & { metadata: any }> {
    return (contribution.nodes || []).filter((n: CASNode) => n.type === 'di_binding') as any;
  }

  it('InversifyJS: extracts bind<T>().to().inSingletonScope() as a singleton binding + provides edge', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { inversify: '^6.0.2' } } },
      {
        'src/container.ts': [
          "import { Container } from 'inversify';",
          "import { TYPES } from './types';",
          "import { FooService } from './foo-service';",
          "import { IFooService } from './i-foo-service';",
          '',
          'const container = new Container();',
          'container.bind<IFooService>(TYPES.FooService).to(FooService).inSingletonScope();',
          'export { container };',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    expect(bindings.length).toBeGreaterThan(0);
    const binding = bindings.find(n => n.metadata?.interface === 'IFooService');
    expect(binding).toBeDefined();
    expect(binding!.metadata?.implementation).toBe('FooService');
    expect(binding!.metadata?.lifetime).toBe('singleton');

    const providesEdges = (contribution.edges || []).filter(e => e.type === 'provides');
    expect(providesEdges.length).toBeGreaterThan(0);
    const bindsEdges = (contribution.edges || []).filter(e => e.type === 'binds');
    expect(bindsEdges.length).toBeGreaterThan(0);
  });

  it('tsyringe: extracts registerSingleton as a singleton binding', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { tsyringe: '^4.8.0' } } },
      {
        'src/setup.ts': [
          "import { container } from 'tsyringe';",
          "import { FooService } from './foo-service';",
          '',
          'container.registerSingleton("FooService", FooService);',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    expect(bindings.some(n => n.metadata?.interface === 'FooService' && n.metadata?.lifetime === 'singleton')).toBe(true);
  });

  it('.NET IServiceCollection: extracts AddScoped<IFoo, Foo>() with scoped lifetime', async () => {
    const contribution = await analyzeProject(
      { 'App.csproj': '<Project><ItemGroup><PackageReference Include="Microsoft.Extensions.DependencyInjection" Version="8.0.0" /></ItemGroup></Project>' },
      {
        'Startup.cs': [
          'using Microsoft.Extensions.DependencyInjection;',
          '',
          'public class Startup {',
          '  public void ConfigureServices(IServiceCollection services) {',
          '    services.AddScoped<IFooService, FooService>();',
          '  }',
          '}',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    const binding = bindings.find(n => n.metadata?.interface === 'IFooService');
    expect(binding).toBeDefined();
    expect(binding!.metadata?.implementation).toBe('FooService');
    expect(binding!.metadata?.lifetime).toBe('scoped');
  });

  it('Autofac: extracts RegisterType<T>().As<T>().SingleInstance() with singleton lifetime', async () => {
    const contribution = await analyzeProject(
      { 'App.csproj': '<Project><ItemGroup><PackageReference Include="Autofac" Version="7.0.0" /></ItemGroup></Project>' },
      {
        'Module.cs': [
          'using Autofac;',
          '',
          'public class AppModule : Module {',
          '  protected override void Load(ContainerBuilder builder) {',
          '    builder.RegisterType<FooService>().As<IFooService>().SingleInstance();',
          '  }',
          '}',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    const binding = bindings.find(n => n.metadata?.interface === 'IFooService');
    expect(binding).toBeDefined();
    expect(binding!.metadata?.implementation).toBe('FooService');
    expect(binding!.metadata?.lifetime).toBe('singleton');
  });

  it('Ninject: extracts Bind<T>().To<T>() with default transient lifetime', async () => {
    const contribution = await analyzeProject(
      { 'App.csproj': '<Project><ItemGroup><PackageReference Include="Ninject" Version="3.3.6" /></ItemGroup></Project>' },
      {
        'NinjectModule.cs': [
          'using Ninject;',
          'using Ninject.Modules;',
          '',
          'public class AppModule : NinjectModule {',
          '  public override void Load() {',
          '    Bind<IFooService>().To<FooService>();',
          '  }',
          '}',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    const binding = bindings.find(n => n.metadata?.interface === 'IFooService');
    expect(binding).toBeDefined();
    expect(binding!.metadata?.implementation).toBe('FooService');
  });

  it('links provider edges to canonical implementation nodes and materializes unresolved implementations', async () => {
    const canonicalNode: CASNode = {
      id: 'class_existing_foo_service',
      name: 'FooService',
      qualified_name: 'Example.Services.FooService',
      type: 'class',
      level: 3,
      source: { file: 'FooService.cs' },
    };
    const contribution = await analyzeProject(
      { 'App.csproj': '<Project><ItemGroup><PackageReference Include="Ninject" Version="3.3.6" /></ItemGroup></Project>' },
      {
        'NinjectModule.cs': [
          'using Ninject;',
          'using Ninject.Modules;',
          'public class AppModule : NinjectModule {',
          '  public override void Load() {',
          '    Bind<IFooService>().To<FooService>();',
          '    Bind<IBarService>().To<BarService>();',
          '  }',
          '}',
        ].join('\n'),
      },
      [{ nodes: [canonicalNode], analyzer_metadata: { analyzer_id: 'fixture', analyzer_name: 'Fixture', version: '1.0.0', contribution_type: 'language', capabilities: [] } }]
    );

    const providesEdges = (contribution.edges || []).filter(edge => edge.type === 'provides');
    const implementationName = (edge: typeof providesEdges[number]): unknown =>
      (edge.metadata as Record<string, unknown> | undefined)?.implementation;
    expect(providesEdges.find(edge => implementationName(edge) === 'FooService')?.target).toBe(canonicalNode.id);
    const unresolvedEdge = providesEdges.find(edge => implementationName(edge) === 'BarService');
    expect(unresolvedEdge).toBeDefined();
    expect(contribution.nodes?.some(node => node.id === unresolvedEdge!.target && node.type === 'di_implementation')).toBe(true);
    const availableIds = new Set([canonicalNode.id, ...(contribution.nodes || []).map(node => node.id)]);
    expect(providesEdges.every(edge => availableIds.has(edge.target))).toBe(true);
  });

  it('Guice: extracts bind(IFoo.class).to(Foo.class).in(Singleton.class)', async () => {
    const contribution = await analyzeProject(
      { 'pom.xml': '<project><dependencies><dependency><groupId>com.google.inject</groupId><artifactId>guice</artifactId><version>7.0.0</version></dependency></dependencies></project>' },
      {
        'src/main/java/com/example/AppModule.java': [
          'import com.google.inject.AbstractModule;',
          'import com.google.inject.Singleton;',
          '',
          'public class AppModule extends AbstractModule {',
          '  protected void configure() {',
          '    bind(FooService.class).to(FooServiceImpl.class).in(Singleton.class);',
          '  }',
          '}',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    const binding = bindings.find(n => n.metadata?.interface === 'FooService');
    expect(binding).toBeDefined();
    expect(binding!.metadata?.implementation).toBe('FooServiceImpl');
    expect(binding!.metadata?.lifetime).toBe('singleton');
  });

  it('Dagger: extracts @Binds abstract fun bindFoo(impl: FooImpl): IFoo', async () => {
    const contribution = await analyzeProject(
      { 'pom.xml': '<project><dependencies><dependency><groupId>com.google.dagger</groupId><artifactId>dagger</artifactId><version>2.50</version></dependency></dependencies></project>' },
      {
        'src/main/kotlin/com/example/AppModule.kt': [
          '@Module',
          'abstract class AppModule {',
          '  @Binds',
          '  abstract fun bindFoo(impl: FooServiceImpl): FooService',
          '}',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    const binding = bindings.find(n => n.metadata?.interface === 'FooService');
    expect(binding).toBeDefined();
    expect(binding!.metadata?.implementation).toBe('FooServiceImpl');
  });

  it('Koin: extracts single<IFoo> { FooImpl(get()) } with singleton lifetime', async () => {
    const contribution = await analyzeProject(
      { 'build.gradle.kts': "dependencies { implementation(\"io.insert-koin:koin-core:3.5.0\") }" },
      {
        'src/main/kotlin/com/example/AppModule.kt': [
          'import org.koin.dsl.module',
          '',
          'val appModule = module {',
          '  single<FooService> { FooServiceImpl(get()) }',
          '}',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    const binding = bindings.find(n => n.metadata?.interface === 'FooService');
    expect(binding).toBeDefined();
    expect(binding!.metadata?.implementation).toBe('FooServiceImpl');
    expect(binding!.metadata?.lifetime).toBe('singleton');
  });

  it('Symfony DI: extracts ->autowire(FooInterface::class, Foo::class)', async () => {
    const contribution = await analyzeProject(
      { 'composer.json': { require: { 'symfony/dependency-injection': '^6.4' } } },
      {
        'src/AppServices.php': [
          '<?php',
          'use Symfony\\Component\\DependencyInjection\\ContainerBuilder;',
          '',
          '$container = new ContainerBuilder();',
          '$container->autowire(FooInterface::class, Foo::class);',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    const binding = bindings.find(n => n.metadata?.interface === 'FooInterface');
    expect(binding).toBeDefined();
    expect(binding!.metadata?.implementation).toBe('Foo');
  });

  it('PHP-DI: extracts FooInterface::class => \\DI\\autowire(Foo::class) with singleton lifetime', async () => {
    const contribution = await analyzeProject(
      { 'composer.json': { require: { 'php-di/php-di': '^7.0' } } },
      {
        'config/container.php': [
          '<?php',
          'return [',
          '    FooInterface::class => \\DI\\autowire(Foo::class),',
          '];',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    const binding = bindings.find(n => n.metadata?.interface === 'FooInterface');
    expect(binding).toBeDefined();
    expect(binding!.metadata?.implementation).toBe('Foo');
    expect(binding!.metadata?.lifetime).toBe('singleton');
  });

  it('Python dependency-injector: extracts providers.Singleton and providers.Factory', async () => {
    const contribution = await analyzeProject(
      { 'requirements.txt': 'dependency-injector==4.41.0\n' },
      {
        'app/containers.py': [
          'from dependency_injector import containers, providers',
          '',
          'class Container(containers.DeclarativeContainer):',
          '    foo_service = providers.Singleton(FooService)',
          '    bar_factory = providers.Factory(BarService)',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    expect(bindings.some(n => n.metadata?.interface === 'foo_service' && n.metadata?.implementation === 'FooService' && n.metadata?.lifetime === 'singleton')).toBe(true);
    expect(bindings.some(n => n.metadata?.interface === 'bar_factory' && n.metadata?.implementation === 'BarService' && n.metadata?.lifetime === 'transient')).toBe(true);
  });

  it('does not fabricate a binding when the container package is declared but never imported/used (import-source gating)', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { inversify: '^6.0.2' } } },
      {
        'src/unrelated.ts': [
          'export class Container {',
          '  bind(name: string) { return this; }',
          '  to(impl: unknown) { return this; }',
          '}',
        ].join('\n'),
      }
    );

    const bindings = bindingNodes(contribution);
    expect(bindings.length).toBe(0);
  });

  it('canAnalyze returns false when no DI container dependency is declared', async () => {
    await fs.writeJson(path.join(tempDir, 'package.json'), { dependencies: { express: '^4.18.0' } });
    const analyzer = new DiContainerBindingAnalyzer();
    expect(await analyzer.canAnalyze(tempDir)).toBe(false);
  });
});
