import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { CASContribution, CASEdge, CASExitPoint, CASLibrary, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';

/**
 * DI-container binding-graph analyzer.
 *
 * The `dependency-injection` rules in architectural-library-analyzer.ts detect that a DI
 * container is *used* (usage-pattern regex hits) but do not extract the actual binding
 * graph: which interface/token maps to which implementation, at what lifetime. That graph
 * is exactly what defines a codebase's architecture ("what depends on what") and is what
 * this analyzer surfaces, as import-gated, evidence-based facts:
 *
 *   - one CASNode per binding (interface/token -> implementation, with lifetime metadata)
 *   - a `binds` edge: container/module node -> binding node
 *   - a `provides` edge: binding node -> implementation node (mirrors the existing
 *     `provides` edge convention already read by orchestrator.ts's DI pattern detector)
 *
 * so agents can answer "what implements interface X" and "what is the DI graph" without
 * re-deriving it from source on every question.
 *
 * Evidence-based: every rule is gated on the file actually importing one of the
 * container's real packages (see requiresImportEvidence handling in findBindings), never
 * on a bare symbol name alone — the same import-source-gating discipline used by the ORM
 * rules above (typeorm vs mikro-orm's shared `EntityManager` symbol).
 */

type DiContainerId =
  | 'inversify'
  | 'tsyringe'
  | 'ninject'
  | 'autofac'
  | 'dotnet-service-collection'
  | 'dagger'
  | 'guice'
  | 'koin'
  | 'symfony-di'
  | 'php-di'
  | 'python-dependency-injector';

type Lifetime = 'singleton' | 'scoped' | 'transient' | 'unknown';

interface BindingMatch {
  /** Registered interface/token/abstract type name. */
  interfaceName: string;
  /** Concrete implementation type name, when statically determinable. */
  implementationName?: string;
  lifetime: Lifetime;
  file: string;
  line: number;
  excerpt: string;
}

interface DiContainerRule {
  id: DiContainerId;
  displayName: string;
  language: 'typescript' | 'csharp' | 'java-kotlin' | 'php' | 'python';
  packageManagers: string[];
  /** Import sources (or, for JVM/gradle-style deps, group:artifact substrings) that gate every extractor below. */
  packages: string[];
  /** File globs this rule's extractors should run against (in addition to the shared candidate set). */
  fileExtensions: string[];
  /** One or more binding-extraction patterns, each producing (interface, implementation?, lifetime). */
  extractors: BindingExtractor[];
  agentGuidance: string;
}

interface BindingExtractor {
  label: string;
  /** Regex with named groups `iface` (required) and `impl` (optional). Must be global (`g` flag). */
  pattern: RegExp;
  lifetime: Lifetime | ((match: RegExpMatchArray) => Lifetime);
}

function lifetimeFromKeyword(keyword: string | undefined): Lifetime {
  if (!keyword) return 'unknown';
  const lower = keyword.toLowerCase();
  if (lower.includes('single')) return 'singleton';
  if (lower.includes('scope') || lower.includes('request')) return 'scoped';
  if (lower.includes('transient') || lower.includes('factory')) return 'transient';
  return 'unknown';
}

const RULES: DiContainerRule[] = [
  {
    id: 'inversify',
    displayName: 'InversifyJS',
    language: 'typescript',
    packageManagers: ['npm'],
    packages: ['inversify'],
    fileExtensions: ['ts', 'tsx', 'js', 'jsx'],
    extractors: [
      {
        // container.bind<Foo>(TYPES.Foo).to(FooImpl).inSingletonScope()
        label: 'bind<T>().to()',
        pattern: /\bbind<(?<iface>[A-Za-z0-9_.]+)>\([^)]*\)\s*\.to\s*\(\s*(?<impl>[A-Za-z0-9_.]+)\s*\)(?<lifetime>(?:\s*\.\s*in\w*Scope\s*\(\s*\))?)/g,
        lifetime: match => {
          const scope = match.groups?.lifetime || '';
          if (/inSingletonScope/i.test(scope)) return 'singleton';
          if (/inRequestScope/i.test(scope)) return 'scoped';
          if (/inTransientScope/i.test(scope)) return 'transient';
          return 'singleton'; // Inversify default bind() scope
        },
      },
      {
        // container.bind(TYPES.Foo).to(FooImpl).inSingletonScope() (non-generic bind() call,
        // very common in real Inversify code that doesn't spell out bind<T>()).
        label: 'bind().to()',
        pattern: /\bbind\s*\(\s*(?:[A-Za-z0-9_.]*\.)?(?<iface>[A-Za-z0-9_]+)\s*\)\s*\.to\s*\(\s*(?<impl>[A-Za-z0-9_.]+)\s*\)(?<lifetime>(?:\s*\.\s*in\w*Scope\s*\(\s*\))?)/g,
        lifetime: match => {
          const scope = match.groups?.lifetime || '';
          if (/inSingletonScope/i.test(scope)) return 'singleton';
          if (/inRequestScope/i.test(scope)) return 'scoped';
          if (/inTransientScope/i.test(scope)) return 'transient';
          return 'singleton'; // Inversify default bind() scope
        },
      },
      {
        // bind(TYPES.Foo).toSelf().inSingletonScope()
        label: 'bind().toSelf()',
        pattern: /\bbind\s*\(\s*(?:[A-Za-z0-9_.]*\.)?(?<iface>[A-Za-z0-9_]+)\s*\)\s*\.toSelf\s*\(\s*\)(?<lifetime>(?:\s*\.\s*in\w*Scope\s*\(\s*\))?)/g,
        lifetime: match => {
          const scope = match.groups?.lifetime || '';
          if (/inSingletonScope/i.test(scope)) return 'singleton';
          if (/inRequestScope/i.test(scope)) return 'scoped';
          if (/inTransientScope/i.test(scope)) return 'transient';
          return 'singleton'; // Inversify default bind() scope
        },
      },
    ],
    agentGuidance: 'InversifyJS bindings define the container graph; preserve TYPES tokens, scope (singleton/request/transient), and constructor `@inject` parameter order when modifying bound classes.',
  },
  {
    id: 'tsyringe',
    displayName: 'tsyringe',
    language: 'typescript',
    packageManagers: ['npm'],
    packages: ['tsyringe'],
    fileExtensions: ['ts', 'tsx'],
    extractors: [
      {
        // container.register<Foo>("Foo", { useClass: FooImpl }) / registerSingleton(Foo, FooImpl)
        label: 'register useClass',
        pattern: /\bregister\s*(?:<[^>]*>)?\s*\(\s*["'`]?(?<iface>[A-Za-z0-9_.]+)["'`]?\s*,\s*\{\s*useClass\s*:\s*(?<impl>[A-Za-z0-9_.]+)/g,
        lifetime: 'transient',
      },
      {
        label: 'registerSingleton',
        pattern: /\bregisterSingleton\s*(?:<[^>]*>)?\s*\(\s*["'`]?(?<iface>[A-Za-z0-9_.]+)["'`]?\s*(?:,\s*(?<impl>[A-Za-z0-9_.]+))?\s*\)/g,
        lifetime: 'singleton',
      },
    ],
    agentGuidance: 'tsyringe registrations define the container graph; preserve injection tokens and useClass/useValue/useFactory wiring and constructor `@inject` order when modifying bound classes.',
  },
  {
    id: 'ninject',
    displayName: 'Ninject',
    language: 'csharp',
    packageManagers: ['nuget'],
    packages: ['Ninject'],
    fileExtensions: ['cs'],
    extractors: [
      {
        // Bind<IFoo>().To<Foo>().InSingletonScope()
        label: 'Bind<T>().To<T>()',
        pattern: /\bBind<(?<iface>[A-Za-z0-9_.]+)>\s*\(\s*\)\s*\.\s*To<(?<impl>[A-Za-z0-9_.]+)>\s*\(\s*\)(?<lifetime>(?:\s*\.\s*In\w+Scope\s*\(\s*\))?)/g,
        lifetime: match => {
          const scope = match.groups?.lifetime || '';
          if (/InSingletonScope/i.test(scope)) return 'singleton';
          if (/InRequestScope/i.test(scope)) return 'scoped';
          if (/InTransientScope/i.test(scope)) return 'transient';
          return 'transient'; // Ninject default Bind() scope
        },
      },
    ],
    agentGuidance: 'Ninject bindings define the container graph; preserve binding scope and constructor injection contracts when modifying bound classes.',
  },
  {
    id: 'autofac',
    displayName: 'Autofac',
    language: 'csharp',
    packageManagers: ['nuget'],
    packages: ['Autofac'],
    fileExtensions: ['cs'],
    extractors: [
      {
        // builder.RegisterType<Foo>().As<IFoo>().SingleInstance()
        label: 'RegisterType<T>().As<T>()',
        pattern: /\bRegisterType<(?<impl>[A-Za-z0-9_.]+)>\s*\(\s*\)\s*\.\s*As<(?<iface>[A-Za-z0-9_.]+)>\s*\(\s*\)(?<lifetime>(?:\s*\.\s*(?:SingleInstance|InstancePerLifetimeScope|InstancePerDependency|InstancePerRequest)\s*\(\s*\))?)/g,
        lifetime: match => {
          const scope = match.groups?.lifetime || '';
          if (/SingleInstance/i.test(scope)) return 'singleton';
          if (/InstancePerLifetimeScope|InstancePerRequest/i.test(scope)) return 'scoped';
          if (/InstancePerDependency/i.test(scope)) return 'transient';
          return 'transient'; // Autofac default RegisterType scope
        },
      },
    ],
    agentGuidance: 'Autofac registrations define the container graph; preserve As<T> service exposure and instance scope when modifying registered classes.',
  },
  {
    id: 'dotnet-service-collection',
    displayName: '.NET IServiceCollection',
    language: 'csharp',
    packageManagers: ['nuget'],
    packages: ['Microsoft.Extensions.DependencyInjection'],
    fileExtensions: ['cs'],
    extractors: [
      {
        // services.AddSingleton<IFoo, Foo>() / AddScoped<IFoo, Foo>() / AddTransient<IFoo, Foo>()
        label: 'Add{Lifetime}<TService, TImplementation>()',
        pattern: /\bAdd(?<lifetime>Singleton|Scoped|Transient)\s*<\s*(?<iface>[A-Za-z0-9_.]+)\s*,\s*(?<impl>[A-Za-z0-9_.]+)\s*>\s*\(\s*\)/g,
        lifetime: match => lifetimeFromKeyword(match.groups?.lifetime),
      },
      {
        // services.AddSingleton<Foo>() (self-registration, no separate interface)
        label: 'Add{Lifetime}<TImplementation>()',
        pattern: /\bAdd(?<lifetime>Singleton|Scoped|Transient)\s*<\s*(?<iface>[A-Za-z0-9_.]+)\s*>\s*\(\s*\)/g,
        lifetime: match => lifetimeFromKeyword(match.groups?.lifetime),
      },
    ],
    agentGuidance: 'IServiceCollection registrations define the container graph; preserve service lifetime (Singleton/Scoped/Transient) and constructor-injection contracts when modifying registered classes.',
  },
  {
    id: 'dagger',
    displayName: 'Dagger',
    language: 'java-kotlin',
    packageManagers: ['maven', 'gradle'],
    packages: ['dagger', 'com.google.dagger'],
    fileExtensions: ['java', 'kt'],
    extractors: [
      {
        // @Provides fun provideFoo(): IFoo = FooImpl() / @Provides Foo provideFoo() { return new FooImpl(); }
        label: '@Provides',
        pattern: /@Provides(?:\s*\n)?[^\n]*?\b(?:fun\s+\w+\s*\([^)]*\)\s*:\s*(?<iface>[A-Za-z0-9_.]+)|(?<iface2>[A-Za-z0-9_.]+)\s+\w+\s*\([^)]*\)\s*\{)/g,
        lifetime: 'unknown',
      },
      {
        // @Binds abstract fun bindFoo(impl: FooImpl): IFoo
        label: '@Binds',
        pattern: /@Binds[^\n]*\n?[^\n]*\bfun\s+\w+\s*\(\s*\w+\s*:\s*(?<impl>[A-Za-z0-9_.]+)\s*\)\s*:\s*(?<iface>[A-Za-z0-9_.]+)/g,
        lifetime: 'unknown',
      },
    ],
    agentGuidance: 'Dagger @Module/@Provides/@Binds declarations define the component graph; preserve module installation (@InstallIn), scope annotations, and qualifiers when changing providers.',
  },
  {
    id: 'guice',
    displayName: 'Guice',
    language: 'java-kotlin',
    packageManagers: ['maven', 'gradle'],
    packages: ['com.google.inject', 'guice'],
    fileExtensions: ['java', 'kt'],
    extractors: [
      {
        // bind(IFoo.class).to(Foo.class).in(Singleton.class)
        label: 'bind().to()',
        pattern: /\bbind\s*\(\s*(?<iface>[A-Za-z0-9_.]+)\.class\s*\)\s*\.to\s*\(\s*(?<impl>[A-Za-z0-9_.]+)\.class\s*\)(?<lifetime>(?:\s*\.\s*in\s*\(\s*[A-Za-z0-9_.]+\.class\s*\))?)/g,
        lifetime: match => {
          const scope = match.groups?.lifetime || '';
          if (/Singleton/i.test(scope)) return 'singleton';
          if (/RequestScoped|SessionScoped/i.test(scope)) return 'scoped';
          return 'unknown';
        },
      },
    ],
    agentGuidance: 'Guice module bindings define the injector graph; preserve binding scope annotations and qualifiers when changing bound implementations.',
  },
  {
    id: 'koin',
    displayName: 'Koin',
    language: 'java-kotlin',
    packageManagers: ['maven', 'gradle'],
    packages: ['io.insert-koin', 'koin-core', 'koin-android'],
    fileExtensions: ['kt'],
    extractors: [
      {
        // single<IFoo> { FooImpl(get()) }  /  single { FooImpl(get()) }
        label: 'single { }',
        pattern: /\bsingle(?:<(?<iface>[A-Za-z0-9_.]+)>)?\s*\{\s*(?<impl>[A-Za-z0-9_.]+)\s*\(/g,
        lifetime: 'singleton',
      },
      {
        // factory<IFoo> { FooImpl(get()) }
        label: 'factory { }',
        pattern: /\bfactory(?:<(?<iface>[A-Za-z0-9_.]+)>)?\s*\{\s*(?<impl>[A-Za-z0-9_.]+)\s*\(/g,
        lifetime: 'transient',
      },
      {
        // scoped<IFoo> { FooImpl(get()) }
        label: 'scoped { }',
        pattern: /\bscoped(?:<(?<iface>[A-Za-z0-9_.]+)>)?\s*\{\s*(?<impl>[A-Za-z0-9_.]+)\s*\(/g,
        lifetime: 'scoped',
      },
    ],
    agentGuidance: 'Koin module definitions (single/factory/scoped) define the DI graph; preserve module boundaries and qualifiers (named()) when changing bound implementations.',
  },
  {
    id: 'symfony-di',
    displayName: 'Symfony DI',
    language: 'php',
    packageManagers: ['composer'],
    packages: ['symfony/dependency-injection', 'symfony/framework-bundle'],
    fileExtensions: ['php', 'yaml', 'yml'],
    extractors: [
      {
        // $container->register(FooInterface::class, Foo::class)->setPublic(true)
        label: 'register()',
        pattern: /->register\s*\(\s*(?<iface>[A-Za-z0-9_\\]+)::class\s*,\s*(?<impl>[A-Za-z0-9_\\]+)::class\s*\)/g,
        lifetime: 'unknown',
      },
      {
        // $container->autowire(FooInterface::class, Foo::class)
        label: 'autowire()',
        pattern: /->autowire\s*\(\s*(?<iface>[A-Za-z0-9_\\]+)::class\s*,\s*(?<impl>[A-Za-z0-9_\\]+)::class\s*\)/g,
        lifetime: 'unknown',
      },
    ],
    agentGuidance: 'Symfony service definitions define the container graph; preserve service IDs, autowiring, and alias bindings when changing implementations.',
  },
  {
    id: 'php-di',
    displayName: 'PHP-DI',
    language: 'php',
    packageManagers: ['composer'],
    packages: ['php-di/php-di'],
    fileExtensions: ['php'],
    extractors: [
      {
        // FooInterface::class => \DI\create(Foo::class)  or  FooInterface::class => \DI\autowire(Foo::class)
        label: 'create()/autowire()',
        pattern: /(?<iface>[A-Za-z0-9_\\]+)::class\s*=>\s*(?:\\?DI\\)?(?:create|autowire)\s*\(\s*(?<impl>[A-Za-z0-9_\\]+)::class\s*\)/g,
        lifetime: 'singleton', // PHP-DI container entries are singletons by default
      },
    ],
    agentGuidance: 'PHP-DI container definitions define the binding graph; preserve definition keys and factory/autowire wiring when changing implementations.',
  },
  {
    id: 'python-dependency-injector',
    displayName: 'dependency-injector',
    language: 'python',
    packageManagers: ['pip'],
    packages: ['dependency_injector', 'dependency-injector'],
    fileExtensions: ['py'],
    extractors: [
      {
        // foo_service = providers.Singleton(FooImpl, ...)
        label: 'providers.Singleton',
        pattern: /(?<iface>[A-Za-z0-9_]+)\s*=\s*providers\.Singleton\s*\(\s*(?<impl>[A-Za-z0-9_.]+)/g,
        lifetime: 'singleton',
      },
      {
        // foo_service = providers.Factory(FooImpl, ...)
        label: 'providers.Factory',
        pattern: /(?<iface>[A-Za-z0-9_]+)\s*=\s*providers\.Factory\s*\(\s*(?<impl>[A-Za-z0-9_.]+)/g,
        lifetime: 'transient',
      },
    ],
    agentGuidance: 'dependency-injector container providers define the binding graph; preserve provider names, wiring config, and Provide[] injection markers when changing implementations.',
  },
];

export class DiContainerBindingAnalyzer extends BaseAnalyzer {
  constructor() {
    super('di-container-bindings', 'DI Container Binding Graph Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const dependencies = await this.readDependencies(projectPath);
    return RULES.some(ruleDef => dependencies.some(dep => this.ruleMatchesDependency(ruleDef, dep)));
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return this.sourceFiles({ projectPath });
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { nodes, edges, libraries } = await this.analyzeBindings(
      context.projectPath,
      await this.sourceFiles(context),
      true
    );

    const contribution = this.createContribution(nodes, edges, [], [], {
      library_family: 'dependency-injection-binding-graph',
      containers_detected: libraries.length,
      bindings_surfaced: nodes.filter(n => n.type === 'di_binding').length,
      categories: ['dependency-injection'],
    });
    contribution.libraries = libraries;
    return contribution;
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    const { nodes, edges } = await this.analyzeBindings(context.projectPath, [context.relativePath], false);
    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      [],
      this.extractImports(content),
      nodes.map(node => node.name)
    );
  }

  protected getCapabilities(): string[] {
    return [
      'di-container-binding-graph-extraction',
      'interface-to-implementation-resolution',
      'di-lifetime-detection',
      'cross-language-di-container-coverage',
    ];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'DI container' : 'DI binding';
  }

  private async sourceFiles(context: AnalysisContext): Promise<string[]> {
    return this.capAndPrioritizeSourceFiles(await glob([
      '**/*.{ts,tsx,js,jsx,cs,java,kt,php,py,yaml,yml}',
    ], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*', '**/obj/**', '**/bin/**'],
      nodir: true,
      absolute: false,
    }), 'DI container candidate files');
  }

  private async findBindings(projectPath: string, files: string[], ruleDef: DiContainerRule): Promise<BindingMatch[]> {
    const matches: BindingMatch[] = [];
    const applicableFiles = files.filter(f => ruleDef.fileExtensions.some(ext => f.endsWith(`.${ext}`)));

    for (const relativeFile of applicableFiles) {
      const absoluteFile = path.join(projectPath, relativeFile);
      let content = '';
      try {
        content = await fs.readFile(absoluteFile, 'utf8');
      } catch {
        continue;
      }

      // Import-source evidence: the file must actually reference the container's real
      // package, never just a bare symbol that could belong to a different container
      // (e.g. bare `bind(...)` / `single { }` shaped calls exist across multiple
      // ecosystems). This mirrors the requiresImportEvidence discipline in
      // architectural-library-analyzer.ts.
      if (!this.fileReferencesContainerPackage(content, ruleDef)) continue;

      for (const extractor of ruleDef.extractors) {
        extractor.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = extractor.pattern.exec(content)) !== null) {
          const iface = match.groups?.iface || match.groups?.iface2;
          if (!iface) continue;
          const lineIndex = content.slice(0, match.index).split(/\r?\n/).length;
          const lifetime = typeof extractor.lifetime === 'function' ? extractor.lifetime(match) : extractor.lifetime;
          matches.push({
            interfaceName: iface,
            implementationName: match.groups?.impl,
            lifetime,
            file: relativeFile,
            line: lineIndex,
            excerpt: match[0].replace(/\s+/g, ' ').trim().slice(0, 200),
          });
          if (extractor.pattern.lastIndex === match.index) extractor.pattern.lastIndex++; // guard zero-width match loops
        }
      }
    }
    return matches;
  }

  private fileReferencesContainerPackage(content: string, ruleDef: DiContainerRule): boolean {
    if (ruleDef.language === 'typescript') {
      return this.extractImports(content).some(importSource =>
        ruleDef.packages.some(pkg => importSource === pkg || importSource.startsWith(`${pkg}/`))
      );
    }
    if (ruleDef.language === 'csharp') {
      return ruleDef.packages.some(pkg => new RegExp(`\\busing\\s+${pkg.replace(/\./g, '\\.')}`).test(content))
        || (ruleDef.id === 'dotnet-service-collection' && /\bIServiceCollection\b/.test(content));
    }
    if (ruleDef.language === 'java-kotlin') {
      const lower = content.toLowerCase();
      return ruleDef.packages.some(pkg => lower.includes(pkg.toLowerCase()))
        || (ruleDef.id === 'dagger' && /@Module\b|@Provides\b|@Binds\b/.test(content))
        || (ruleDef.id === 'koin' && /\bmodule\s*\{/.test(content) && /\b(single|factory|scoped)\b/.test(content));
    }
    if (ruleDef.language === 'php') {
      const lower = content.toLowerCase();
      return ruleDef.packages.some(pkg => lower.includes(pkg.toLowerCase()))
        || (ruleDef.id === 'php-di' && /\\?DI\\(create|autowire)\s*\(/.test(content))
        || (ruleDef.id === 'symfony-di' && /->register\s*\(|->autowire\s*\(/.test(content));
    }
    if (ruleDef.language === 'python') {
      return content.includes('dependency_injector') || content.includes('providers.Singleton') || content.includes('providers.Factory');
    }
    return false;
  }

  private async analyzeBindings(
    projectPath: string,
    sourceFiles: string[],
    includeLibraries: boolean
  ): Promise<{ nodes: CASNode[]; edges: CASEdge[]; libraries: CASLibrary[] }> {
    const dependencies = await this.readDependencies(projectPath);
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const libraries: CASLibrary[] = [];

    for (const ruleDef of RULES) {
      const dependencyHits = dependencies.filter(dep => this.ruleMatchesDependency(ruleDef, dep));
      if (dependencyHits.length === 0) continue;

      const bindings = await this.findBindings(projectPath, sourceFiles, ruleDef);
      if (bindings.length === 0) {
        if (includeLibraries) libraries.push(this.buildLibraryFact(ruleDef, dependencyHits, [], []));
        continue;
      }

      const containerNodeId = `di_container_${this.sanitizeId(ruleDef.id)}`;
      nodes.push(this.createNode(
        containerNodeId,
        `${ruleDef.displayName} Container`,
        'di_container',
        3,
        undefined,
        undefined,
        undefined,
        {
          container: ruleDef.displayName,
          language: ruleDef.language,
          bindings_count: bindings.length,
          agent_guidance: ruleDef.agentGuidance,
          subcategories: ['dependency-injection-container', ruleDef.id],
        }
      ));

      const bindingNodeIds: string[] = [];
      for (const binding of bindings.slice(0, 200)) {
        const bindingNodeId = `di_binding_${this.sanitizeId(ruleDef.id)}_${this.sanitizeId(binding.interfaceName)}_${this.sanitizeId(binding.file)}_${binding.line}`;
        bindingNodeIds.push(bindingNodeId);

        nodes.push(this.createNode(
          bindingNodeId,
          binding.implementationName
            ? `${binding.interfaceName} -> ${binding.implementationName}`
            : `${binding.interfaceName} binding`,
          'di_binding',
          4,
          binding.file,
          binding.line,
          binding.line,
          {
            container: ruleDef.displayName,
            interface: binding.interfaceName,
            implementation: binding.implementationName,
            lifetime: binding.lifetime,
            excerpt: binding.excerpt,
            agent_guidance: ruleDef.agentGuidance,
            subcategories: ['dependency-injection-binding', ruleDef.id, `lifetime:${binding.lifetime}`],
          }
        ));

        // container -> binding: `binds`
        edges.push(this.createEdge(
          `edge_${containerNodeId}_binds_${bindingNodeId}`,
          containerNodeId,
          bindingNodeId,
          'binds',
          'architecture',
          { container: ruleDef.id, lifetime: binding.lifetime }
        ));

        // binding -> implementation: `provides` (matches the `provides` edge type already
        // consumed by orchestrator.ts's detectDependencyInjectionPattern()).
        if (binding.implementationName) {
          const implementationNodeId = `di_impl_${this.sanitizeId(ruleDef.id)}_${this.sanitizeId(binding.implementationName)}`;
          edges.push(this.createEdge(
            `edge_${bindingNodeId}_provides_${implementationNodeId}`,
            bindingNodeId,
            implementationNodeId,
            'provides',
            'architecture',
            { container: ruleDef.id, interface: binding.interfaceName, implementation: binding.implementationName, lifetime: binding.lifetime, file: binding.file, line: binding.line }
          ));
        }
      }

      if (includeLibraries) libraries.push(this.buildLibraryFact(ruleDef, dependencyHits, bindings, bindingNodeIds));
    }

    return { nodes, edges, libraries };
  }

  private buildLibraryFact(ruleDef: DiContainerRule, dependencyHits: DependencyHit[], bindings: BindingMatch[], bindingNodeIds: string[]): CASLibrary {
    const dep = dependencyHits[0];
    return {
      id: `lib_${this.sanitizeId(dep.name)}`,
      name: dep.name,
      version: dep.version,
      type: dep.type,
      package_manager: dep.packageManager,
      category: 'dependency-injection',
      description: `${ruleDef.displayName} is a dependency-injection container. ${ruleDef.agentGuidance}`,
      usage_patterns: ruleDef.extractors.map(extractor => ({
        pattern: extractor.label,
        occurrences: 0,
        example_nodes: bindingNodeIds.slice(0, 5),
        functions_used: [],
      })),
      usage_statistics: {
        import_count: bindings.length,
        usage_frequency: bindings.length > 10 ? 'high' : bindings.length > 3 ? 'medium' : bindings.length > 0 ? 'low' : 'declared-only',
        critical_path: true,
      },
      connected_nodes: bindingNodeIds,
      metadata: {
        breaking_changes_risk: 'high',
      },
    };
  }

  private extractImports(content: string): string[] {
    const imports = new Set<string>();
    for (const line of content.split(/\r?\n/)) {
      const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
      const requireMatch = line.match(/\brequire\(['"]([^'"]+)['"]\)/);
      const value = importMatch?.[1] || requireMatch?.[1];
      if (value) imports.add(value);
    }
    return [...imports];
  }

  private ruleMatchesDependency(ruleDef: DiContainerRule, dep: DependencyHit): boolean {
    if (!ruleDef.packageManagers.includes(dep.packageManager)) return false;
    const name = dep.name.toLowerCase();
    return ruleDef.packages.some(pkg => name === pkg.toLowerCase() || name.includes(pkg.toLowerCase()));
  }

  private async readDependencies(projectPath: string): Promise<DependencyHit[]> {
    return [
      ...await this.readPackageJsonDependencies(projectPath),
      ...await this.readPythonDependencies(projectPath),
      ...await this.readComposerDependencies(projectPath),
      ...await this.readJavaDependencies(projectPath),
      ...await this.readDotnetDependencies(projectPath),
    ];
  }

  private async readPackageJsonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!await fs.pathExists(packageJsonPath)) return [];
    const pkg = await fs.readJson(packageJsonPath);
    const hits: DependencyHit[] = [];
    const add = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
      for (const [name, version] of Object.entries(deps || {})) {
        hits.push({ name, version: String(version).replace(/^[\^~>=<]/, ''), type, packageManager: 'npm' });
      }
    };
    add(pkg.dependencies, 'production');
    add(pkg.devDependencies, 'development');
    add(pkg.peerDependencies, 'peer');
    add(pkg.optionalDependencies, 'optional');
    return hits;
  }

  private async readPythonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    const requirements = ['requirements.txt', 'requirements/base.txt', 'requirements/production.txt', 'pyproject.toml'];
    for (const file of requirements) {
      const reqPath = path.join(projectPath, file);
      if (!await fs.pathExists(reqPath)) continue;
      const content = await fs.readFile(reqPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = line.trim().match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*"?([^,;\s"]+))?/);
        if (match && /^[a-zA-Z]/.test(match[1])) hits.push({ name: match[1], version: match[2], type: 'production', packageManager: 'pip' });
      }
    }
    return hits;
  }

  private async readComposerDependencies(projectPath: string): Promise<DependencyHit[]> {
    const composerPath = path.join(projectPath, 'composer.json');
    if (!await fs.pathExists(composerPath)) return [];
    const composer = await fs.readJson(composerPath);
    const hits: DependencyHit[] = [];
    const add = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
      for (const [name, version] of Object.entries(deps || {})) {
        hits.push({ name, version: String(version), type, packageManager: 'composer' });
      }
    };
    add(composer.require, 'production');
    add(composer['require-dev'], 'development');
    return hits;
  }

  private async readDotnetDependencies(projectPath: string): Promise<DependencyHit[]> {
    const csprojFiles = await glob('**/*.csproj', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    const hits: DependencyHit[] = [];
    for (const relativeFile of csprojFiles) {
      const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
      const packageRegex = /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g;
      let match: RegExpExecArray | null;
      while ((match = packageRegex.exec(content)) !== null) {
        hits.push({ name: match[1], version: match[2], type: 'production', packageManager: 'nuget' });
      }
    }
    return hits;
  }

  private async readJavaDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    const pomPath = path.join(projectPath, 'pom.xml');
    if (await fs.pathExists(pomPath)) {
      const content = await fs.readFile(pomPath, 'utf8');
      const dependencyRegex = /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?(?:<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, version: match[3], type: 'production', packageManager: 'maven' });
        hits.push({ name: match[1], version: match[3], type: 'production', packageManager: 'maven' });
      }
    }

    const gradleFiles = await glob(['build.gradle', 'build.gradle.kts', '**/build.gradle', '**/build.gradle.kts'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativeFile of gradleFiles) {
      const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
      const dependencyRegex = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|kapt|ksp)\s*(?:\(?\s*)['"]([^:'"]+):([^:'"]+):?([^'"]*)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, version: match[3] || undefined, type: 'production', packageManager: 'gradle' });
        hits.push({ name: match[1], version: match[3] || undefined, type: 'production', packageManager: 'gradle' });
      }
    }
    return hits;
  }
}

interface DependencyHit {
  name: string;
  version?: string;
  type: CASLibrary['type'];
  packageManager: string;
}
