import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ALL']);

interface AstroComponent {
  name: string;
  file: string;
  isPage: boolean;
  frontmatter: string;
  template: string;
  imports: Array<{ name: string; from: string }>;
  props: string[];
  fetchesData: boolean;
  islands: Array<{ component: string; directive: string }>;
  usedComponents: string[];
}

export class AstroAnalyzer extends BaseAnalyzer {
  constructor() {
    super('astro', 'Astro Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (deps['astro']) return true;
      }

      for (const configFile of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js']) {
        if (await fs.pathExists(path.join(projectPath, configFile))) return true;
      }

      const astroFiles = await glob(['**/*.astro'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
      return astroFiles.length > 0;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const ignorePatterns = this.getIgnorePatterns(context);

    const astroFiles = this.capAndPrioritizeSourceFiles(
      await glob(['**/*.astro'], { cwd: context.projectPath, ignore: ignorePatterns, nodir: true }),
      'Astro component files'
    );

    // file -> node id, so import edges can resolve to component nodes
    const componentNodeIds = new Map<string, string>();
    const components: AstroComponent[] = [];

    for (const file of astroFiles) {
      try {
        const fullPath = path.join(context.projectPath, file);
        const content = await fs.readFile(fullPath, 'utf-8');
        const component = this.parseAstroFile(content, file);
        components.push(component);

        const nodeId = `astro_component_${this.sanitizeId(file)}`;
        componentNodeIds.set(file, nodeId);

        const lineCount = content.split('\n').length;
        nodes.push(
          this.createNode(
            nodeId,
            component.name,
            'astro-component',
            component.isPage ? 2 : 3,
            file,
            1,
            lineCount,
            {
              framework: 'astro',
              attributes: {
                is_page: component.isPage,
                props: component.props,
                fetches_data: component.fetchesData,
                islands: component.islands,
                imports_count: component.imports.length,
              },
            }
          )
        );

        if (component.isPage) {
          const routePath = this.derivePageRoute(file);
          const routeNodeId = `astro_route_${this.sanitizeId(file)}`;
          const isDynamic = /\[/.test(routePath);

          nodes.push(
            this.createNode(routeNodeId, routePath, 'route', 3, file, undefined, undefined, {
              framework: 'astro',
              attributes: { routePath, dynamic: isDynamic, page_node: nodeId },
            })
          );

          edges.push(
            this.createEdge(
              this.generateEdgeId(routeNodeId, nodeId, 'renders'),
              routeNodeId,
              nodeId,
              'renders',
              'structural',
              { framework: 'astro', routePath }
            )
          );

          entryPoints.push({
            id: `entry_astro_page_${this.sanitizeId(file)}`,
            source_node: nodeId,
            source_analyzer: this.analyzerId,
            type: 'page',
            name: `PAGE ${routePath}`,
            description: `Astro page ${routePath}`,
            trigger: { method: 'GET', path: routePath },
            metadata: { framework: 'astro', pageFile: file, dynamic: isDynamic },
          });
        }
      } catch (error) {
        this.addAnalysisWarning(`Failed to parse Astro file ${file}: ${(error as Error).message}`);
      }
    }

    // Markdown/MDX pages under src/pages
    const mdPages = await glob(['**/pages/**/*.{md,mdx}'], {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      nodir: true,
    });
    for (const file of mdPages) {
      const routePath = this.derivePageRoute(file);
      const nodeId = `astro_page_${this.sanitizeId(file)}`;
      const isDynamic = /\[/.test(routePath);
      nodes.push(
        this.createNode(nodeId, routePath, 'route', 3, file, undefined, undefined, {
          framework: 'astro',
          attributes: { routePath, dynamic: isDynamic, content_type: path.extname(file).slice(1) },
        })
      );
      entryPoints.push({
        id: `entry_astro_page_${this.sanitizeId(file)}`,
        source_node: nodeId,
        source_analyzer: this.analyzerId,
        type: 'page',
        name: `PAGE ${routePath}`,
        description: `Astro content page ${routePath}`,
        trigger: { method: 'GET', path: routePath },
        metadata: { framework: 'astro', pageFile: file, dynamic: isDynamic },
      });
    }

    // API endpoints: src/pages/api/**/*.{ts,js} exporting HTTP method handlers
    const apiFiles = await glob(['**/pages/**/*.{ts,js}'], {
      cwd: context.projectPath,
      ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*', '**/*.d.ts'],
      nodir: true,
    });
    for (const file of apiFiles) {
      const fullPath = path.join(context.projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }
      const methods = this.getExportedHttpMethods(content);
      if (methods.length === 0) continue;

      const routePath = this.deriveApiRoute(file);
      const nodeId = `astro_endpoint_${this.sanitizeId(file)}`;
      nodes.push(
        this.createNode(nodeId, `API ${routePath}`, 'api-route', 3, file, undefined, undefined, {
          framework: 'astro',
          attributes: { routePath, methods },
        })
      );

      for (const method of methods) {
        entryPoints.push({
          id: `entry_astro_api_${this.sanitizeId(file)}_${method}`,
          source_node: nodeId,
          source_analyzer: this.analyzerId,
          type: 'http',
          name: `${method} ${routePath}`,
          description: `Astro API endpoint ${method} ${routePath}`,
          trigger: { method, path: routePath },
          metadata: { framework: 'astro', routeFile: file },
        });
      }
    }

    // Content collections: src/content/config.ts defineCollection(...)
    await this.analyzeContentCollections(context, ignorePatterns, nodes);

    // Import edges between components + island markers
    this.buildImportEdges(components, componentNodeIds, context.projectPath, edges);

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework_specific: {
        components_detected: components.length,
        pages_detected: components.filter(c => c.isPage).length + mdPages.length,
        islands_detected: components.reduce((sum, c) => sum + c.islands.length, 0),
        api_endpoints_detected: entryPoints.filter(ep => ep.type === 'http').length,
        content_collections_detected: nodes.filter(n => n.type === 'content-collection').length,
        nodes_created: nodes.length,
      },
      warnings: this.collectAnalysisWarnings(),
    });
  }

  protected getCapabilities(): string[] {
    return ['astro-components', 'astro-pages', 'astro-content-collections', 'astro-endpoints'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }

  private parseAstroFile(content: string, file: string): AstroComponent {
    const name = path.basename(file, '.astro');
    const normalized = file.replace(/\\/g, '/');
    const isPage = /(^|\/)src\/pages\//.test(normalized);

    // Frontmatter fence: content between the first pair of `---` lines.
    let frontmatter = '';
    let template = content;
    const fenceMatch = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (fenceMatch) {
      frontmatter = fenceMatch[1];
      template = fenceMatch[2];
    }

    const imports = this.extractImports(frontmatter);
    const props = this.extractProps(frontmatter);
    const fetchesData = /\b(await\s+fetch|Astro\.glob|getCollection|getEntry)\s*\(/.test(frontmatter);
    const islands = this.extractIslands(template);
    const usedComponents = this.extractUsedComponents(template);

    return { name, file, isPage, frontmatter, template, imports, props, fetchesData, islands, usedComponents };
  }

  private extractImports(frontmatter: string): Array<{ name: string; from: string }> {
    const imports: Array<{ name: string; from: string }> = [];
    const importPattern = /import\s+(?:(\w+)|\{[^}]*\}|\*\s+as\s+\w+)?\s*(?:,\s*\{[^}]*\})?\s*from\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(frontmatter)) !== null) {
      imports.push({ name: match[1] || '', from: match[2] });
    }
    return imports;
  }

  private extractProps(frontmatter: string): string[] {
    const props = new Set<string>();

    // interface Props { foo: string; bar?: number }
    const ifaceMatch = frontmatter.match(/interface\s+Props\s*\{([\s\S]*?)\}/);
    if (ifaceMatch) {
      const body = ifaceMatch[1];
      const fieldPattern = /(\w+)\s*\??\s*:/g;
      let m: RegExpExecArray | null;
      while ((m = fieldPattern.exec(body)) !== null) props.add(m[1]);
    }

    // const { foo, bar } = Astro.props
    const destructurePattern = /const\s*\{([^}]*)\}\s*=\s*Astro\.props/g;
    let dm: RegExpExecArray | null;
    while ((dm = destructurePattern.exec(frontmatter)) !== null) {
      dm[1].split(',').forEach(raw => {
        const key = raw.split(/[:=]/)[0].trim().replace(/\.\.\./, '');
        if (key && /^\w+$/.test(key)) props.add(key);
      });
    }

    return Array.from(props);
  }

  private extractIslands(template: string): Array<{ component: string; directive: string }> {
    const islands: Array<{ component: string; directive: string }> = [];
    // <Component client:load /> etc. — capitalized tag carrying a client: directive
    const islandPattern = /<([A-Z]\w*)[^>]*\sclient:(load|idle|visible|media|only)\b/g;
    let match: RegExpExecArray | null;
    while ((match = islandPattern.exec(template)) !== null) {
      islands.push({ component: match[1], directive: `client:${match[2]}` });
    }
    return islands;
  }

  private extractUsedComponents(template: string): string[] {
    const used = new Set<string>();
    const tagPattern = /<([A-Z]\w*)[\s/>]/g;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(template)) !== null) {
      used.add(match[1]);
    }
    return Array.from(used);
  }

  private getExportedHttpMethods(content: string): string[] {
    const methods = new Set<string>();

    const funcPattern = /export\s+(?:async\s+)?function\s+([A-Z]+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = funcPattern.exec(content)) !== null) {
      if (HTTP_METHODS.has(match[1])) methods.add(match[1]);
    }

    const constPattern = /export\s+const\s+([A-Z]+)\s*[:=]/g;
    while ((match = constPattern.exec(content)) !== null) {
      if (HTTP_METHODS.has(match[1])) methods.add(match[1]);
    }

    return Array.from(methods);
  }

  private derivePageRoute(file: string): string {
    const normalized = file.replace(/\\/g, '/');
    const match = normalized.match(/(?:^|\/)src\/pages\/(.+)\.(astro|md|mdx)$/);
    let routePath = match ? `/${match[1]}` : `/${path.basename(file).replace(/\.\w+$/, '')}`;
    routePath = routePath.replace(/\/index$/, '');
    if (routePath === '') routePath = '/';
    return routePath;
  }

  private deriveApiRoute(file: string): string {
    const normalized = file.replace(/\\/g, '/');
    const match = normalized.match(/(?:^|\/)src\/pages\/(.+)\.(ts|js)$/);
    let routePath = match ? `/${match[1]}` : `/${path.basename(file).replace(/\.\w+$/, '')}`;
    routePath = routePath.replace(/\/index$/, '');
    if (routePath === '') routePath = '/';
    return routePath;
  }

  private async analyzeContentCollections(
    context: AnalysisContext,
    ignorePatterns: string[],
    nodes: CASNode[]
  ): Promise<void> {
    const configFiles = await glob(['**/content/config.{ts,js,mjs}', '**/content.config.{ts,js,mjs}'], {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      nodir: true,
    });

    for (const file of configFiles) {
      const fullPath = path.join(context.projectPath, file);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      // const blog = defineCollection({ ... })
      const collectionPattern = /(?:const|let|var)\s+(\w+)\s*=\s*defineCollection\s*\(/g;
      let match: RegExpExecArray | null;
      const found = new Set<string>();
      while ((match = collectionPattern.exec(content)) !== null) {
        found.add(match[1]);
      }

      // Also pick up names registered in the exported collections map.
      const mapMatch = content.match(/export\s+const\s+collections\s*=\s*\{([\s\S]*?)\}/);
      if (mapMatch) {
        const keyPattern = /(\w+)\s*[:,}]/g;
        let km: RegExpExecArray | null;
        while ((km = keyPattern.exec(mapMatch[1])) !== null) found.add(km[1]);
      }

      for (const name of found) {
        const nodeId = `astro_collection_${this.sanitizeId(file)}_${this.sanitizeId(name)}`;
        nodes.push(
          this.createNode(nodeId, name, 'content-collection', 2, file, undefined, undefined, {
            framework: 'astro',
            attributes: { collection: name, kind: 'content-collection' },
          })
        );
      }
    }
  }

  private buildImportEdges(
    components: AstroComponent[],
    componentNodeIds: Map<string, string>,
    projectPath: string,
    edges: CASEdge[]
  ): void {
    for (const component of components) {
      const sourceId = componentNodeIds.get(component.file);
      if (!sourceId) continue;
      const islandComponentNames = new Set(component.islands.map(i => i.component));

      for (const imp of component.imports) {
        if (!imp.from.startsWith('.')) continue;
        // resolve relative import to a known .astro file
        const resolved = this.resolveAstroImport(component.file, imp.from);
        const targetId = resolved ? componentNodeIds.get(resolved) : undefined;
        if (!targetId) continue;

        const isIsland = imp.name && islandComponentNames.has(imp.name);
        edges.push(
          this.createEdge(
            this.generateEdgeId(sourceId, targetId, 'imports'),
            sourceId,
            targetId,
            'imports',
            'dependency',
            { import_path: imp.from, island: !!isIsland }
          )
        );
      }
    }
  }

  private resolveAstroImport(fromFile: string, importPath: string): string | undefined {
    const baseDir = path.dirname(fromFile);
    let resolved = path.normalize(path.join(baseDir, importPath)).replace(/\\/g, '/');
    if (!resolved.endsWith('.astro')) resolved += '.astro';
    return resolved;
  }
}
