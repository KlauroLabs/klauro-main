import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';


















interface WPCallback {

  raw: string;

  name: string | null;
}

interface WPHook {
  kind: 'action' | 'filter';
  name: string;
  callback: WPCallback;
  priority?: number;
  line: number;
}

interface WPPostType { name: string; line: number; }
interface WPTaxonomy { name: string; objectType?: string; line: number; }
interface WPShortcode { name: string; callback: WPCallback; line: number; }
interface WPRestRoute { namespace: string; route: string; methods: string[]; callback: WPCallback; line: number; }
interface WPAjax { action: string; nopriv: boolean; callback: WPCallback; line: number; }
interface WPAsset { kind: 'script' | 'style'; handle: string; line: number; }

interface WPMeta {
  kind: 'plugin' | 'theme';
  name: string;
  version?: string;
  description?: string;
  author?: string;
}

const WP_FUNCTION_HINT = /\b(add_action|add_filter|register_post_type|register_taxonomy|add_shortcode|register_rest_route|wp_enqueue_script|wp_enqueue_style)\s*\(/;

export class WordPressAnalyzer extends BaseAnalyzer {
  constructor() {
    super('wordpress', 'WordPress Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {

      if (await fs.pathExists(path.join(projectPath, 'wp-config.php'))) return true;


      const styleCss = path.join(projectPath, 'style.css');
      if (await fs.pathExists(styleCss)) {
        const css = await fs.readFile(styleCss, 'utf-8');
        if (/^\s*Theme Name:/im.test(css)) return true;
      }

      const phpFiles = await glob(['**/*.php'], {
        cwd: projectPath,
        ignore: this.getWPIgnorePatterns({ projectPath }),
        nodir: true
      });

      for (const file of phpFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');

        if (/^\s*\*?\s*Plugin Name:/im.test(content)) return true;

        if (WP_FUNCTION_HINT.test(content)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.php', '**/style.css'], {
      cwd: projectPath,
      ignore: this.getWPIgnorePatterns({ projectPath }),
      nodir: true
    });
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    this.analyzeFileContent(content, context.filePath, context.relativePath, nodes, edges, entryPoints);

    const exports = nodes.map(n => n.name);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const files = await glob(['**/*.php', '**/style.css'], {
        cwd: context.projectPath,
        ignore: this.getWPIgnorePatterns(context),
        nodir: true
      });
      files.sort();

      let hooks = 0, postTypes = 0, taxonomies = 0, shortcodes = 0, restRoutes = 0, ajax = 0, assets = 0, meta = 0;

      for (const file of files) {
        const fullPath = path.join(context.projectPath, file);
        const content = await fs.readFile(fullPath, 'utf-8');
        const counts = this.analyzeFileContent(content, fullPath, file, nodes, edges, entryPoints);
        hooks += counts.hooks;
        postTypes += counts.postTypes;
        taxonomies += counts.taxonomies;
        shortcodes += counts.shortcodes;
        restRoutes += counts.restRoutes;
        ajax += counts.ajax;
        assets += counts.assets;
        meta += counts.meta;
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          hooks_detected: hooks,
          post_types_detected: postTypes,
          taxonomies_detected: taxonomies,
          shortcodes_detected: shortcodes,
          rest_routes_detected: restRoutes,
          ajax_endpoints_detected: ajax,
          assets_detected: assets,
          plugin_theme_meta_detected: meta
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `WordPress analysis failed: ${(error as Error).message}`,
        'WORDPRESS_ANALYSIS_ERROR'
      );
    }
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

  protected getCapabilities(): string[] {
    return ['wp-hooks', 'wp-post-types', 'wp-shortcodes', 'wp-rest-routes', 'wp-ajax'];
  }



  private analyzeFileContent(
    content: string,
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): { hooks: number; postTypes: number; taxonomies: number; shortcodes: number; restRoutes: number; ajax: number; assets: number; meta: number } {
    const result = { hooks: 0, postTypes: 0, taxonomies: 0, shortcodes: 0, restRoutes: 0, ajax: 0, assets: 0, meta: 0 };


    const metaInfo = this.extractMeta(content, relativePath);
    let metaNodeId: string | undefined;
    if (metaInfo) {
      metaNodeId = this.generateId(metaInfo.kind, fullPath, metaInfo.name);
      nodes.push(
        this.createNodeBuilder(metaNodeId, metaInfo.name, `wordpress_${metaInfo.kind}`)
          .withLevel(1, 'system')
          .withCategory(metaInfo.kind, ['wordpress', 'php', metaInfo.kind])
          .withSource({ file: relativePath, line: 1, end_line: content.split('\n').length })
          .withDescription(`WordPress ${metaInfo.kind}: ${metaInfo.name}`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({
            framework: 'wordpress',
            attributes: {
              kind: metaInfo.kind,
              version: metaInfo.version,
              description: metaInfo.description,
              author: metaInfo.author
            }
          })
          .build()
      );
      result.meta++;
    }


    const hooks = this.extractHooks(content);
    for (const hook of hooks) {
      const ajaxMatch = hook.kind === 'action' && /^wp_ajax(_nopriv)?_(.+)$/.exec(hook.name);
      if (ajaxMatch) {
        const nopriv = !!ajaxMatch[1];
        const action = ajaxMatch[2];
        this.emitAjax({ action, nopriv, callback: hook.callback, line: hook.line }, fullPath, relativePath, nodes, edges, entryPoints);
        result.ajax++;
        continue;
      }

      const hookId = this.generateId('wp_hook', fullPath, `${hook.kind}_${hook.name}_${hook.line}`);
      nodes.push(
        this.createNodeBuilder(hookId, hook.name, hook.kind === 'action' ? 'wordpress_action' : 'wordpress_filter')
          .withLevel(3, 'code')
          .withCategory('hook', ['wordpress', hook.kind])
          .withSource({ file: relativePath, line: hook.line, end_line: hook.line })
          .withDescription(`WordPress ${hook.kind} hook: ${hook.name}`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({
            framework: 'wordpress',
            attributes: {
              hook_kind: hook.kind,
              hook_name: hook.name,
              priority: hook.priority,
              callback: hook.callback.raw
            }
          })
          .build()
      );
      result.hooks++;


      this.linkCallback(hookId, hook.callback, 'registers', { hook: hook.name, kind: hook.kind }, fullPath, edges);

      if (metaNodeId) {
        edges.push(this.createEdge(
          this.generateEdgeId(metaNodeId, hookId, 'contains'),
          metaNodeId, hookId, 'contains', 'structural'
        ));
      }
    }


    for (const pt of this.extractPostTypes(content)) {
      const ptId = this.generateId('wp_post_type', fullPath, pt.name);
      nodes.push(
        this.createNodeBuilder(ptId, pt.name, 'wordpress_post_type')
          .withLevel(2, 'architectural')
          .withCategory('data_entity', ['wordpress', 'content_model', 'post_type'])
          .withSource({ file: relativePath, line: pt.line, end_line: pt.line })
          .withDescription(`WordPress custom post type: ${pt.name}`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({ framework: 'wordpress', attributes: { post_type: pt.name } })
          .build()
      );
      result.postTypes++;
      if (metaNodeId) {
        edges.push(this.createEdge(this.generateEdgeId(metaNodeId, ptId, 'contains'), metaNodeId, ptId, 'contains', 'structural'));
      }
    }


    for (const tax of this.extractTaxonomies(content)) {
      const taxId = this.generateId('wp_taxonomy', fullPath, tax.name);
      nodes.push(
        this.createNodeBuilder(taxId, tax.name, 'wordpress_taxonomy')
          .withLevel(2, 'architectural')
          .withCategory('data_entity', ['wordpress', 'content_model', 'taxonomy'])
          .withSource({ file: relativePath, line: tax.line, end_line: tax.line })
          .withDescription(`WordPress taxonomy: ${tax.name}`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({ framework: 'wordpress', attributes: { taxonomy: tax.name, object_type: tax.objectType } })
          .build()
      );
      result.taxonomies++;
      if (metaNodeId) {
        edges.push(this.createEdge(this.generateEdgeId(metaNodeId, taxId, 'contains'), metaNodeId, taxId, 'contains', 'structural'));
      }
    }


    for (const sc of this.extractShortcodes(content)) {
      const scId = this.generateId('wp_shortcode', fullPath, sc.name);
      nodes.push(
        this.createNodeBuilder(scId, sc.name, 'wordpress_shortcode')
          .withLevel(3, 'code')
          .withCategory('shortcode', ['wordpress', 'entry_point'])
          .withSource({ file: relativePath, line: sc.line, end_line: sc.line })
          .withDescription(`WordPress shortcode: [${sc.name}]`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({ framework: 'wordpress', attributes: { shortcode: sc.name, callback: sc.callback.raw } })
          .build()
      );
      result.shortcodes++;
      this.linkCallback(scId, sc.callback, 'handled_by', { shortcode: sc.name }, fullPath, edges);

      entryPoints.push(this.createEntryPoint(
        `entry_${scId}`,
        scId,
        'event',
        `shortcode [${sc.name}]`,
        `WordPress shortcode entry point: [${sc.name}]`,
        { event: `shortcode:${sc.name}` },
        undefined,
        { shortcode: sc.name, callback: sc.callback.name }
      ));
      if (metaNodeId) {
        edges.push(this.createEdge(this.generateEdgeId(metaNodeId, scId, 'contains'), metaNodeId, scId, 'contains', 'structural'));
      }
    }


    for (const rr of this.extractRestRoutes(content)) {
      const fullRoute = `/${rr.namespace}${rr.route.startsWith('/') ? '' : '/'}${rr.route}`.replace(/\/+/g, '/');
      const methods = rr.methods.length ? rr.methods : ['GET'];
      const rrId = this.generateId('wp_rest_route', fullPath, `${methods.join(',')}_${fullRoute}`);
      nodes.push(
        this.createNodeBuilder(rrId, `${methods.join('|')} ${fullRoute}`, 'wordpress_rest_route')
          .withLevel(3, 'code')
          .withCategory('route', ['wordpress', 'rest', 'http'])
          .withSource({ file: relativePath, line: rr.line, end_line: rr.line })
          .withDescription(`WordPress REST route: ${methods.join('|')} ${fullRoute}`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({
            framework: 'wordpress',
            attributes: { namespace: rr.namespace, route: rr.route, full_path: fullRoute, methods, callback: rr.callback.raw }
          })
          .build()
      );
      result.restRoutes++;
      this.linkCallback(rrId, rr.callback, 'handled_by', { route: fullRoute }, fullPath, edges);

      for (const method of methods) {
        entryPoints.push(this.createEntryPoint(
          `entry_${rrId}_${method}`,
          rrId,
          'http',
          `${method} ${fullRoute}`,
          `WordPress REST endpoint: ${method} ${fullRoute}`,
          { method: method.toUpperCase(), path: fullRoute },
          undefined,
          { namespace: rr.namespace, callback: rr.callback.name }
        ));
      }
      if (metaNodeId) {
        edges.push(this.createEdge(this.generateEdgeId(metaNodeId, rrId, 'contains'), metaNodeId, rrId, 'contains', 'structural'));
      }
    }


    for (const asset of this.extractAssets(content)) {
      const assetId = this.generateId('wp_asset', fullPath, `${asset.kind}_${asset.handle}_${asset.line}`);
      nodes.push(
        this.createNodeBuilder(assetId, asset.handle, 'wordpress_asset')
          .withLevel(4, 'member')
          .withCategory('asset', ['wordpress', asset.kind])
          .withSource({ file: relativePath, line: asset.line, end_line: asset.line })
          .withDescription(`WordPress enqueued ${asset.kind}: ${asset.handle}`)
          .withTags([`analyzer:${this.id}`])
          .withMetadata({ framework: 'wordpress', attributes: { asset_kind: asset.kind, handle: asset.handle } })
          .build()
      );
      result.assets++;
    }

    return result;
  }

  private emitAjax(
    ajax: WPAjax,
    fullPath: string,
    relativePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const ajaxId = this.generateId('wp_ajax', fullPath, `${ajax.action}_${ajax.nopriv ? 'nopriv' : 'priv'}_${ajax.line}`);
    nodes.push(
      this.createNodeBuilder(ajaxId, ajax.action, 'wordpress_ajax')
        .withLevel(3, 'code')
        .withCategory('ajax', ['wordpress', 'entry_point', ajax.nopriv ? 'public' : 'authenticated'])
        .withSource({ file: relativePath, line: ajax.line, end_line: ajax.line })
        .withDescription(`WordPress AJAX endpoint: ${ajax.action}${ajax.nopriv ? ' (nopriv)' : ''}`)
        .withTags([`analyzer:${this.id}`])
        .withMetadata({ framework: 'wordpress', attributes: { action: ajax.action, nopriv: ajax.nopriv, callback: ajax.callback.raw } })
        .build()
    );
    this.linkCallback(ajaxId, ajax.callback, 'handled_by', { ajax_action: ajax.action }, fullPath, edges);

    entryPoints.push(this.createEntryPoint(
      `entry_${ajaxId}`,
      ajaxId,
      'http',
      `AJAX ${ajax.action}`,
      `WordPress AJAX endpoint: ${ajax.action}`,
      { method: 'POST', path: `/wp-admin/admin-ajax.php?action=${ajax.action}` },
      { authenticated: !ajax.nopriv },
      { action: ajax.action, nopriv: ajax.nopriv, callback: ajax.callback.name }
    ));
  }


  private linkCallback(
    sourceId: string,
    callback: WPCallback,
    edgeType: string,
    metadata: Record<string, any>,
    fullPath: string,
    edges: CASEdge[]
  ): void {
    if (!callback.name) return;

    const targetId = this.generateId('function', '', callback.name);
    edges.push(this.createEdge(
      this.generateEdgeId(sourceId, targetId, edgeType),
      sourceId,
      targetId,
      edgeType,
      'behavioral',
      { ...metadata, callback: callback.name }
    ));
  }



  private lineOf(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  private parseCallback(raw: string): WPCallback {
    const trimmed = raw.trim();

    const strMatch = /^['"]([A-Za-z_\\][\w\\]*)['"]$/.exec(trimmed);
    if (strMatch) return { raw: trimmed, name: strMatch[1] };


    const arrMatch = /^(?:\[|array\s*\()\s*([^,]+?)\s*,\s*['"](\w+)['"]\s*(?:\]|\))$/.exec(trimmed);
    if (arrMatch) {
      const objExpr = arrMatch[1].trim();
      const method = arrMatch[2];
      const classMatch = /^['"]?(\w+)['"]?$/.exec(objExpr);
      const cls = classMatch ? classMatch[1] : objExpr.replace(/^\$/, '');
      return { raw: trimmed, name: `${cls}::${method}` };
    }


    return { raw: trimmed, name: null };
  }


  private splitArgs(argStr: string): string[] {
    const args: string[] = [];
    let depth = 0, current = '', quote: string | null = null;
    for (let i = 0; i < argStr.length; i++) {
      const ch = argStr[i];
      if (quote) {
        current += ch;
        if (ch === quote && argStr[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
      if (ch === '(' || ch === '[') { depth++; current += ch; continue; }
      if (ch === ')' || ch === ']') { depth--; current += ch; continue; }
      if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    if (current.trim()) args.push(current.trim());
    return args;
  }


  private captureCall(content: string, fnName: string): Array<{ args: string[]; index: number }> {
    const results: Array<{ args: string[]; index: number }> = [];
    const re = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1, i = start, quote: string | null = null;
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (quote) {
          if (ch === quote && content[i - 1] !== '\\') quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '(' || ch === '[') {
          depth++;
        } else if (ch === ')' || ch === ']') {
          depth--;
        }
        i++;
      }
      const inner = content.substring(start, i - 1);
      results.push({ args: this.splitArgs(inner), index: m.index });
    }
    return results;
  }

  private extractHooks(content: string): WPHook[] {
    const hooks: WPHook[] = [];
    for (const kind of ['action', 'filter'] as const) {
      for (const call of this.captureCall(content, `add_${kind}`)) {
        if (call.args.length < 2) continue;
        const nameMatch = /^['"]([^'"]+)['"]$/.exec(call.args[0]);
        if (!nameMatch) continue;
        const priority = call.args[2] !== undefined && /^\d+$/.test(call.args[2]) ? parseInt(call.args[2], 10) : undefined;
        hooks.push({
          kind,
          name: nameMatch[1],
          callback: this.parseCallback(call.args[1]),
          priority,
          line: this.lineOf(content, call.index)
        });
      }
    }
    return hooks;
  }

  private extractPostTypes(content: string): WPPostType[] {
    const out: WPPostType[] = [];
    for (const call of this.captureCall(content, 'register_post_type')) {
      const nameMatch = call.args[0] && /^['"]([^'"]+)['"]$/.exec(call.args[0]);
      if (!nameMatch) continue;
      out.push({ name: nameMatch[1], line: this.lineOf(content, call.index) });
    }
    return out;
  }

  private extractTaxonomies(content: string): WPTaxonomy[] {
    const out: WPTaxonomy[] = [];
    for (const call of this.captureCall(content, 'register_taxonomy')) {
      const nameMatch = call.args[0] && /^['"]([^'"]+)['"]$/.exec(call.args[0]);
      if (!nameMatch) continue;
      const objMatch = call.args[1] && /^['"]([^'"]+)['"]$/.exec(call.args[1]);
      out.push({ name: nameMatch[1], objectType: objMatch ? objMatch[1] : undefined, line: this.lineOf(content, call.index) });
    }
    return out;
  }

  private extractShortcodes(content: string): WPShortcode[] {
    const out: WPShortcode[] = [];
    for (const call of this.captureCall(content, 'add_shortcode')) {
      if (call.args.length < 2) continue;
      const nameMatch = /^['"]([^'"]+)['"]$/.exec(call.args[0]);
      if (!nameMatch) continue;
      out.push({ name: nameMatch[1], callback: this.parseCallback(call.args[1]), line: this.lineOf(content, call.index) });
    }
    return out;
  }

  private extractRestRoutes(content: string): WPRestRoute[] {
    const out: WPRestRoute[] = [];
    for (const call of this.captureCall(content, 'register_rest_route')) {
      if (call.args.length < 2) continue;
      const nsMatch = /^['"]([^'"]+)['"]$/.exec(call.args[0]);
      const routeMatch = /^['"]([^'"]+)['"]$/.exec(call.args[1]);
      if (!nsMatch || !routeMatch) continue;
      const optsBlob = call.args.slice(2).join(',');
      const methods = this.extractRestMethods(optsBlob);
      const callback = this.extractRestCallback(optsBlob);
      out.push({
        namespace: nsMatch[1],
        route: routeMatch[1],
        methods,
        callback,
        line: this.lineOf(content, call.index)
      });
    }
    return out;
  }

  private extractRestMethods(optsBlob: string): string[] {
    const m = /['"]methods['"]\s*=>\s*([^,]+?)(?:,\s*['"]callback|,\s*['"]permission|\}|$)/s.exec(optsBlob);
    if (!m) return [];
    const raw = m[1];

    const literals = raw.match(/['"]([A-Za-z]+)['"]/g);
    if (literals) {
      return literals
        .map(l => l.replace(/['"]/g, '').toUpperCase())
        .flatMap(token => token.split(/[,|\s]+/))
        .filter(Boolean);
    }
    if (/READABLE/.test(raw)) return ['GET'];
    if (/CREATABLE/.test(raw)) return ['POST'];
    if (/EDITABLE/.test(raw)) return ['POST', 'PUT', 'PATCH'];
    if (/DELETABLE/.test(raw)) return ['DELETE'];
    if (/ALLMETHODS/.test(raw)) return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    return [];
  }

  private extractRestCallback(optsBlob: string): WPCallback {
    const m = /['"]callback['"]\s*=>\s*(\[[^\]]*\]|array\s*\([^)]*\)|['"][\w\\]+['"]|'[^']*'|"[^"]*")/s.exec(optsBlob);
    if (!m) return { raw: '', name: null };
    return this.parseCallback(m[1].trim());
  }

  private extractAssets(content: string): WPAsset[] {
    const out: WPAsset[] = [];
    for (const kind of ['script', 'style'] as const) {
      for (const call of this.captureCall(content, `wp_enqueue_${kind}`)) {
        const handleMatch = call.args[0] && /^['"]([^'"]+)['"]$/.exec(call.args[0]);
        if (!handleMatch) continue;
        out.push({ kind, handle: handleMatch[1], line: this.lineOf(content, call.index) });
      }
    }
    return out;
  }

  private extractMeta(content: string, relativePath: string): WPMeta | null {
    const isCss = relativePath.endsWith('.css');
    const header = content.substring(0, 8192);
    if (isCss) {
      const themeName = /^\s*Theme Name:\s*(.+)$/im.exec(header);
      if (!themeName) return null;
      return {
        kind: 'theme',
        name: themeName[1].trim(),
        version: this.headerField(header, 'Version'),
        description: this.headerField(header, 'Description'),
        author: this.headerField(header, 'Author')
      };
    }
    const pluginName = /^\s*\*?\s*Plugin Name:\s*(.+)$/im.exec(header);
    if (!pluginName) return null;
    return {
      kind: 'plugin',
      name: pluginName[1].trim(),
      version: this.headerField(header, 'Version'),
      description: this.headerField(header, 'Description'),
      author: this.headerField(header, 'Author')
    };
  }

  private headerField(header: string, field: string): string | undefined {
    const re = new RegExp(`^\\s*\\*?\\s*${field}:\\s*(.+)$`, 'im');
    const m = re.exec(header);
    return m ? m[1].trim() : undefined;
  }

  private getWPIgnorePatterns(context: AnalysisContext): string[] {
    return [
      ...this.getIgnorePatterns(context),
      '**/wp-admin/**',
      '**/wp-includes/**',
      '**/cache/**'
    ];
  }
}
