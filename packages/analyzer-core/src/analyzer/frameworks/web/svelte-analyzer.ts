import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode,
  CASEdge,
  CASContribution,
  CASEntryPoint,
  CASExitPoint,
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

interface SvelteProp {
  name: string;
  defaultValue?: string;
  source: 'export-let' | 'props-rune';
}

interface SvelteComponent {
  name: string;
  filePath: string; // relative
  hasScript: boolean;
  scriptLang: string | null; // 'ts' | 'js' | null
  hasStyle: boolean;
  hasMarkup: boolean;
  props: SvelteProp[];
  reactiveState: string[]; // $state runes, $: reactive statements, $store usages
  imports: string[]; // raw module specifiers
  componentImports: Array<{ name: string; importPath: string }>; // imported .svelte components
  renderedComponents: string[]; // PascalCase components used in the markup (render tree)
}

interface SvelteStore {
  name: string;
  filePath: string; // relative
  kind: 'writable' | 'readable' | 'derived';
  line: number;
}

interface SvelteRoute {
  routePath: string; // e.g. /api, /blog/[slug]
  dirRelative: string; // relative dir under src/routes
  pageComponent?: string; // relative path to +page.svelte
  hasPageLoad: boolean; // +page.ts / +page.js
  hasServerLoad: boolean; // +page.server.ts / +page.server.js
  hasLayout: boolean; // +layout.svelte
  endpointFile?: string; // relative path to +server.ts/.js
  endpointMethods: string[]; // exported HTTP methods on +server.*
}

export class SvelteAnalyzer extends BaseAnalyzer {
  constructor() {
    super('svelte', 'Svelte Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (
          Object.keys(deps).some(
            dep => dep === 'svelte' || dep === '@sveltejs/kit' || dep.startsWith('@sveltejs/')
          )
        ) {
          return true;
        }
      }

      const svelteFiles = await glob(['**/*.svelte'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      return svelteFiles.length > 0;
    } catch {
      return false;
    }
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1:
        return 'system';
      case 2:
        return 'architectural';
      case 3:
        return 'code';
      case 4:
        return 'member';
      case 5:
        return 'implementation';
      default:
        return `level_${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['svelte-components', 'sveltekit-routes', 'svelte-stores', 'sveltekit-endpoints'];
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const ignorePatterns = this.getIgnorePatterns(context);
      const candidateFiles = this.capAndPrioritizeSourceFiles(
        await glob(['**/*.{svelte,svelte.ts,svelte.js,ts,js}'], {
          cwd: context.projectPath,
          ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*'],
          nodir: true,
        }),
        'Svelte source files'
      );

      const svelteFiles = candidateFiles.filter(f => f.endsWith('.svelte'));
      const moduleFiles = candidateFiles.filter(f => !f.endsWith('.svelte'));

      const components = await this.analyzeComponents(svelteFiles, context.projectPath, nodes);
      const stores = await this.analyzeStores(
        [...moduleFiles, ...svelteFiles],
        context.projectPath,
        nodes
      );
      await this.analyzeRoutes(context.projectPath, components, nodes, edges, entryPoints);
      this.buildComponentRelationships(components, nodes, edges);

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          svelte_version: await this.getPackageVersion(context.projectPath, 'svelte'),
          sveltekit: !!(await this.getPackageVersion(context.projectPath, '@sveltejs/kit')),
          components_detected: components.length,
          stores_detected: stores.length,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Svelte analysis failed: ${(error as Error).message}`,
        'SVELTE_ANALYSIS_ERROR'
      );
    }
  }

  // ---- Components -------------------------------------------------------

  private async analyzeComponents(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<SvelteComponent[]> {
    const components: SvelteComponent[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      try {
        const component = this.extractComponent(content, file);
        components.push(component);

        const componentId = this.generateId('component', component.filePath, component.name);
        const node = this.createNodeBuilder(componentId, component.name, 'svelte_component')
          .withLevel(2, 'architectural')
          .withCategory('component', ['svelte', 'sfc'])
          .withSource({ file: fullPath, line: 1, end_line: content.split('\n').length })
          .withDescription(`Svelte component: ${component.name}`)
          .withTags(['svelte-component'])
          .withMetadata({
            framework: 'svelte',
            attributes: {
              has_script: component.hasScript,
              script_lang: component.scriptLang,
              has_style: component.hasStyle,
              has_markup: component.hasMarkup,
              props: component.props.map(p => p.name),
              props_count: component.props.length,
              reactive_state: component.reactiveState,
              reactive_state_count: component.reactiveState.length,
            },
          })
          .build();
        nodes.push(node);
      } catch (error) {
        this.addAnalysisWarning(`Failed to parse Svelte component ${file}: ${(error as Error).message}`);
      }
    }

    return components;
  }

  private extractComponent(content: string, filePath: string): SvelteComponent {
    const name = path.basename(filePath, '.svelte');

    const scriptMatch = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    let scriptBlocks = '';
    let scriptLang: string | null = null;
    let hasScript = false;
    let m: RegExpExecArray | null;
    while ((m = scriptMatch.exec(content)) !== null) {
      hasScript = true;
      const attrs = m[1] || '';
      const langMatch = /lang\s*=\s*['"]([^'"]+)['"]/.exec(attrs);
      if (langMatch) scriptLang = langMatch[1];
      scriptBlocks += '\n' + m[2];
    }

    const hasStyle = /<style[\s>]/.test(content);
    // markup = everything outside script/style; cheap heuristic: any non-tag content remains
    const markupStripped = content
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .trim();
    const hasMarkup = markupStripped.length > 0;

    return {
      name,
      filePath,
      hasScript,
      scriptLang,
      hasStyle,
      hasMarkup,
      props: this.extractProps(scriptBlocks),
      reactiveState: this.extractReactiveState(scriptBlocks),
      imports: this.extractImports(scriptBlocks),
      componentImports: this.extractComponentImports(scriptBlocks),
      renderedComponents: this.extractRenderedComponents(markupStripped),
    };
  }

  /** PascalCase component tags actually used in the markup — the render tree,
   *  distinct from imports (a component can be imported but not rendered). */
  private extractRenderedComponents(markup: string): string[] {
    const found = new Set<string>();
    for (const m of markup.matchAll(/<([A-Z][A-Za-z0-9_]*)[\s/>]/g)) found.add(m[1]);
    return [...found];
  }

  private extractProps(script: string): SvelteProp[] {
    const props: SvelteProp[] = [];
    const seen = new Set<string>();

    // Svelte <=4: export let x; export let y = default;
    const exportLetPattern = /export\s+let\s+(\w+)\s*(?::[^=;]+)?(?:=\s*([^;]+))?;?/g;
    let match: RegExpExecArray | null;
    while ((match = exportLetPattern.exec(script)) !== null) {
      const propName = match[1];
      if (seen.has(propName)) continue;
      seen.add(propName);
      props.push({
        name: propName,
        defaultValue: match[2] ? match[2].trim() : undefined,
        source: 'export-let',
      });
    }

    // Svelte 5 runes: let { a, b = 1, ...rest } = $props();
    const propsRunePattern = /(?:let|const)\s*\{([^}]*)\}\s*(?::[^=]+)?=\s*\$props\s*\(/g;
    while ((match = propsRunePattern.exec(script)) !== null) {
      const destructured = match[1];
      const partPattern = /(\w+)\s*(?:=\s*([^,]+))?/g;
      let part: RegExpExecArray | null;
      while ((part = partPattern.exec(destructured)) !== null) {
        const propName = part[1];
        if (!propName || seen.has(propName)) continue;
        seen.add(propName);
        props.push({
          name: propName,
          defaultValue: part[2] ? part[2].trim() : undefined,
          source: 'props-rune',
        });
      }
    }

    return props;
  }

  private extractReactiveState(script: string): string[] {
    const state = new Set<string>();

    // Svelte 5 runes: let count = $state(0)
    const statePattern = /(?:let|const)\s+(\w+)\s*=\s*\$state\b/g;
    let m: RegExpExecArray | null;
    while ((m = statePattern.exec(script)) !== null) state.add(`$state:${m[1]}`);

    // $derived rune
    const derivedPattern = /(?:let|const)\s+(\w+)\s*=\s*\$derived\b/g;
    while ((m = derivedPattern.exec(script)) !== null) state.add(`$derived:${m[1]}`);

    // Reactive statements: $: foo = ...   /  $: { ... }
    const reactivePattern = /\$:\s*(\w+)?/g;
    while ((m = reactivePattern.exec(script)) !== null) {
      state.add(m[1] ? `$:${m[1]}` : '$:block');
    }

    // Store auto-subscriptions: $storeName usages (exclude $: , $state, $props, $derived, $effect)
    const storeUsagePattern = /\$(\w+)/g;
    const runeNames = new Set(['state', 'props', 'derived', 'effect', 'bindable', 'inspect', 'host']);
    while ((m = storeUsagePattern.exec(script)) !== null) {
      const name = m[1];
      if (runeNames.has(name)) continue;
      state.add(`$store:${name}`);
    }

    return Array.from(state);
  }

  private extractImports(script: string): string[] {
    const imports: string[] = [];
    const importPattern =
      /import\s+(?:[\w*\s{},]+\s+from\s+)?['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importPattern.exec(script)) !== null) imports.push(m[1]);
    return imports;
  }

  private extractComponentImports(script: string): Array<{ name: string; importPath: string }> {
    const result: Array<{ name: string; importPath: string }> = [];
    const importPattern = /import\s+(\w+)\s+from\s+['"]([^'"]+\.svelte)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importPattern.exec(script)) !== null) {
      result.push({ name: m[1], importPath: m[2] });
    }
    return result;
  }

  // ---- Stores -----------------------------------------------------------

  private async analyzeStores(
    files: string[],
    projectPath: string,
    nodes: CASNode[]
  ): Promise<SvelteStore[]> {
    const stores: SvelteStore[] = [];

    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      // Only consider files that import from svelte/store
      if (!/from\s+['"]svelte\/store['"]/.test(content)) continue;

      const extracted = this.extractStores(content, file);
      for (const store of extracted) {
        stores.push(store);
        const storeId = this.generateId('store', store.filePath, store.name);
        const node = this.createNodeBuilder(storeId, store.name, 'svelte_store')
          .withLevel(3, 'code')
          .withCategory('store', ['svelte', 'state', store.kind])
          .withSource({ file: fullPath, line: store.line, end_line: store.line })
          .withDescription(`Svelte ${store.kind} store: ${store.name}`)
          .withTags(['svelte-store'])
          .withMetadata({
            framework: 'svelte',
            attributes: { store_kind: store.kind },
          })
          .build();
        nodes.push(node);
      }
    }

    return stores;
  }

  private extractStores(content: string, filePath: string): SvelteStore[] {
    const stores: SvelteStore[] = [];
    const lines = content.split('\n');
    const pattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(writable|readable|derived)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const name = m[1];
      const kind = m[2] as SvelteStore['kind'];
      const line = content.substring(0, m.index).split('\n').length;
      stores.push({ name, filePath, kind, line });
    }
    void lines;
    return stores;
  }

  // ---- SvelteKit routing ------------------------------------------------

  private async analyzeRoutes(
    projectPath: string,
    components: SvelteComponent[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): Promise<SvelteRoute[]> {
    const routesDir = path.join(projectPath, 'src', 'routes');
    if (!(await fs.pathExists(routesDir))) return [];

    const routeFiles = await glob(['**/+*.{svelte,ts,js}'], {
      cwd: routesDir,
      nodir: true,
    });

    // Group by directory => one route per directory.
    const byDir = new Map<string, string[]>();
    for (const rf of routeFiles) {
      const dir = path.dirname(rf) === '.' ? '' : path.dirname(rf);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(path.basename(rf));
    }

    const routes: SvelteRoute[] = [];

    for (const [dir, basenames] of byDir.entries()) {
      const routePath = this.dirToRoutePath(dir);
      const dirRelativeFromProject = path.join('src', 'routes', dir);

      const route: SvelteRoute = {
        routePath,
        dirRelative: dir,
        hasPageLoad: false,
        hasServerLoad: false,
        hasLayout: false,
        endpointMethods: [],
      };

      for (const base of basenames) {
        const relFromProject = path.join('src', 'routes', dir, base);
        if (base === '+page.svelte') {
          route.pageComponent = relFromProject;
        } else if (/^\+page\.(ts|js)$/.test(base)) {
          route.hasPageLoad = true;
        } else if (/^\+page\.server\.(ts|js)$/.test(base)) {
          route.hasServerLoad = true;
        } else if (/^\+layout\./.test(base)) {
          route.hasLayout = true;
        } else if (/^\+server\.(ts|js)$/.test(base)) {
          route.endpointFile = relFromProject;
          const content = await fs
            .readFile(path.join(projectPath, relFromProject), 'utf-8')
            .catch(() => '');
          route.endpointMethods = this.extractEndpointMethods(content);
        }
      }

      routes.push(route);

      const routeId = this.generateId('route', dirRelativeFromProject, routePath || '/');
      const isApi = !!route.endpointFile;
      const routeNode = this.createNodeBuilder(routeId, routePath || '/', 'sveltekit_route')
        .withLevel(3, 'code')
        .withCategory('route', ['svelte', 'sveltekit', isApi ? 'api' : 'page'])
        .withSource({ file: path.join(projectPath, dirRelativeFromProject), line: 1, end_line: 1 })
        .withDescription(
          isApi
            ? `SvelteKit API route: ${routePath || '/'}`
            : `SvelteKit page route: ${routePath || '/'}`
        )
        .withTags(['sveltekit-route', isApi ? 'sveltekit-endpoint' : 'sveltekit-page'])
        .withMetadata({
          framework: 'svelte',
          attributes: {
            route_path: routePath || '/',
            kind: isApi ? 'endpoint' : 'page',
            has_page: !!route.pageComponent,
            has_page_load: route.hasPageLoad,
            has_server_load: route.hasServerLoad,
            has_layout: route.hasLayout,
            http_methods: route.endpointMethods,
            dynamic: routePath.includes(':'),
          },
        })
        .build();
      nodes.push(routeNode);

      // Page route entry point + edge to its component.
      if (route.pageComponent) {
        entryPoints.push(
          this.createEntryPoint(
            `entry_${routeId}`,
            routeId,
            'page',
            `Page ${routePath || '/'}`,
            `SvelteKit page route ${routePath || '/'}`,
            { path: routePath || '/', method: 'GET' },
            { authenticated: route.hasServerLoad },
            { component: route.pageComponent, has_load: route.hasPageLoad || route.hasServerLoad }
          )
        );

        const pageComponentName = path.basename(route.pageComponent, '.svelte');
        const componentId = this.generateId('component', route.pageComponent, pageComponentName);
        edges.push(
          this.createEdge(
            this.generateEdgeId(routeId, componentId, 'renders'),
            routeId,
            componentId,
            'renders',
            'structural',
            { route_path: routePath || '/' }
          )
        );
      }

      // +server.ts endpoints: each exported HTTP method is an API entry point.
      if (route.endpointFile) {
        for (const method of route.endpointMethods) {
          entryPoints.push(
            this.createEntryPoint(
              `entry_${routeId}_${method}`,
              routeId,
              'http',
              `${method} ${routePath || '/'}`,
              `SvelteKit ${method} endpoint at ${routePath || '/'}`,
              { method, path: routePath || '/' },
              undefined,
              { endpoint_file: route.endpointFile, http_method: method },
              {
                node_id: routeId,
                method_name: method,
                file: route.endpointFile,
              }
            )
          );
        }
      }
    }

    return routes;
  }

  private extractEndpointMethods(content: string): string[] {
    const methods = new Set<string>();
    for (const method of HTTP_METHODS) {
      // export function GET(...)  |  export const GET = ...  |  export async function GET(...)
      const fnPattern = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${method}\\b`
      );
      const constPattern = new RegExp(`export\\s+const\\s+${method}\\b`);
      if (fnPattern.test(content) || constPattern.test(content)) {
        methods.add(method);
      }
    }
    return Array.from(methods);
  }

  private dirToRoutePath(dir: string): string {
    if (!dir) return '/';
    const segments = dir.split(path.sep).filter(Boolean);
    const mapped = segments
      .filter(seg => !(seg.startsWith('(') && seg.endsWith(')'))) // route groups are transparent
      .map(seg => seg.replace(/\[([^\]]+)\]/g, (_all, inner) => `:${inner.replace(/^\.\.\./, '')}`));
    const routePath = '/' + mapped.join('/');
    return routePath === '/' && segments.length ? '/' : routePath;
  }

  // ---- Relationships ----------------------------------------------------

  private buildComponentRelationships(
    components: SvelteComponent[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const byBaseName = new Map<string, string>(); // component name -> node id
    for (const c of components) {
      byBaseName.set(c.name, this.generateId('component', c.filePath, c.name));
    }

    for (const component of components) {
      const componentId = this.generateId('component', component.filePath, component.name);
      for (const imp of component.componentImports) {
        const importedName = path.basename(imp.importPath, '.svelte');
        const targetId =
          byBaseName.get(importedName) ||
          this.generateId('component', imp.importPath, importedName);
        edges.push(
          this.createEdge(
            this.generateEdgeId(componentId, targetId, 'uses'),
            componentId,
            targetId,
            'uses',
            'dependency',
            { import_path: imp.importPath, imported_as: imp.name }
          )
        );
      }

      // Render tree (Camp-C): a component used in THIS component's markup, not
      // merely imported. import/structural graphs only have the `uses` import edge.
      for (const rendered of new Set(component.renderedComponents)) {
        const targetId = byBaseName.get(rendered);
        if (!targetId || targetId === componentId) continue;
        edges.push(
          this.createEdge(
            this.generateEdgeId(componentId, targetId, 'renders'),
            componentId,
            targetId,
            'renders',
            'structural'
          )
        );
      }
    }
    void nodes;
  }
}

export default { SvelteAnalyzer };
