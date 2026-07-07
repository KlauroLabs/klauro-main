import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';

type ElixirVisibility = 'public' | 'private';

interface ElixirFunction {
  name: string;
  arity: number;
  visibility: ElixirVisibility;
  isMacro: boolean;
  lineStart: number;
  lineEnd: number;
  moduleQualifiedName: string;
}

interface ElixirModule {
  name: string;            // last segment, e.g. "Math"
  qualifiedName: string;   // full dotted, e.g. "App.Math"
  lineStart: number;
  lineEnd: number;
  functions: ElixirFunction[];
  // use/import/alias/require targets (dotted module names)
  uses: Array<{ target: string; line: number }>;
  imports: Array<{ target: string; line: number }>;
  aliases: Array<{ target: string; as: string; line: number }>;
  requires: Array<{ target: string; line: number }>;
  structFields: string[];
  hasStruct: boolean;
  // High-value framework/behaviour tags derived from `use ...`.
  tags: Set<string>;
}

interface ElixirFileInfo {
  relativePath: string;
  fullPath: string;
  modules: ElixirModule[];
  lineCount: number;
}

const ELIXIR_GLOBS = ['**/*.ex', '**/*.exs'];

// `use X` target -> high-value tag.
const USE_TAGS: Array<{ match: RegExp; tag: string }> = [
  { match: /\bGenServer\b/, tag: 'genserver' },
  { match: /\bPhoenix\.Router\b/, tag: 'phoenix-router' },
  { match: /\bPhoenix\.LiveView\b/, tag: 'liveview' },
  { match: /\bPhoenix\.LiveComponent\b/, tag: 'live-component' },
  { match: /\bPhoenix\.Controller\b/, tag: 'phoenix-controller' },
  { match: /\bPhoenix\.Channel\b/, tag: 'phoenix-channel' },
  { match: /:controller\b/, tag: 'phoenix-controller' },
  { match: /:live_view\b/, tag: 'liveview' },
  { match: /:router\b/, tag: 'phoenix-router' },
  { match: /\bEcto\.Schema\b/, tag: 'ecto-schema' },
  { match: /\bEcto\.Migration\b/, tag: 'ecto-migration' },
  { match: /\bSupervisor\b/, tag: 'supervisor' },
  { match: /\bGenStage\b/, tag: 'genstage' },
  { match: /\bAgent\b/, tag: 'agent' },
  { match: /\bTask\b/, tag: 'task' },
];

// GenServer/OTP callbacks that are runtime entry points.
const OTP_CALLBACKS = new Set([
  'init', 'handle_call', 'handle_cast', 'handle_info', 'handle_continue',
  'terminate', 'code_change', 'start_link', 'child_spec',
]);

// Phoenix Router route macros.
const ROUTE_MACROS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'forward',
]);

export class ElixirAnalyzer extends BaseAnalyzer {
  constructor() {
    super('elixir', 'Elixir Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await this.findElixirFiles(projectPath, { projectPath }, true);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await this.findElixirFiles(projectPath, { projectPath }, false);
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const info = this.parseElixirFile(context.relativePath, context.filePath, content);

    // Single-file scope: only resolve module refs to modules in this file.
    const moduleIndex = new Map<string, ElixirModule>();
    for (const mod of info.modules) moduleIndex.set(mod.qualifiedName, mod);

    this.emitFileNodes(info, nodes, edges, entryPoints, exitPoints);
    this.emitDependencyEdges([info], moduleIndex, edges);
    this.emitCallEdges([info], moduleIndex, edges);

    const imports: string[] = [];
    const exports: string[] = [];
    for (const mod of info.modules) {
      for (const u of [...mod.uses, ...mod.imports, ...mod.requires]) imports.push(u.target);
      for (const a of mod.aliases) imports.push(a.target);
      exports.push(mod.qualifiedName);
    }

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      imports,
      exports
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      let files = await this.findElixirFiles(context.projectPath, context, false);
      files.sort();
      files = this.capAndPrioritizeSourceFiles(files, 'elixir source files');

      const fileInfos: ElixirFileInfo[] = [];
      for (const relativePath of files) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        fileInfos.push(this.parseElixirFile(relativePath, fullPath, content));
      }

      // Repo-wide module index for resolving alias/use/import + call targets.
      const moduleIndex = new Map<string, ElixirModule>();
      for (const info of fileInfos) {
        for (const mod of info.modules) moduleIndex.set(mod.qualifiedName, mod);
      }

      for (const info of fileInfos) {
        this.emitFileNodes(info, nodes, edges, entryPoints, exitPoints);
      }

      this.emitDependencyEdges(fileInfos, moduleIndex, edges);
      this.emitCallEdges(fileInfos, moduleIndex, edges);

      const warnings = this.collectAnalysisWarnings();
      const moduleCount = nodes.filter(n => n.type === 'module').length;
      const functionCount = nodes.filter(n => n.type === 'function').length;
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'elixir',
          packageManager: 'mix',
          filesAnalyzed: fileInfos.length,
          modulesFound: moduleCount,
          functionsFound: functionCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Elixir analysis failed: ${(error as Error).message}`,
        'ELIXIR_ANALYSIS_ERROR'
      );
    }
  }

  private async findElixirFiles(
    projectPath: string,
    context: AnalysisContext,
    stopEarly: boolean
  ): Promise<string[]> {
    const ignore = this.getIgnorePatterns(context);
    const files = await glob(ELIXIR_GLOBS, {
      cwd: projectPath,
      ignore,
      nodir: true,
    });
    if (stopEarly && files.length > 0) return files.slice(0, 1);
    return [...new Set(files)];
  }

  // ---- Parsing -------------------------------------------------------------

  private parseElixirFile(relativePath: string, fullPath: string, content: string): ElixirFileInfo {
    const lines = content.split('\n');
    const modules = this.extractModules(lines);
    return { relativePath, fullPath, modules, lineCount: lines.length };
  }

  // Line-based parser using a `do`/`end` depth stack. Handles nested modules
  // by tracking which module is innermost-on-stack at each point.
  private extractModules(lines: string[]): ElixirModule[] {
    const modules: ElixirModule[] = [];
    // Stack frames: either a module frame or a generic block frame (so `end`
    // counts balance). Module frames carry a reference into `modules`.
    interface Frame { kind: 'module' | 'block'; module?: ElixirModule; }
    const stack: Frame[] = [];

    const moduleStack = (): ElixirModule | undefined => {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'module') return stack[i].module;
      }
      return undefined;
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = this.stripComment(raw);
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lineNo = i + 1;

      // defmodule App.Foo do
      const modMatch = trimmed.match(/^defmodule\s+([A-Z][A-Za-z0-9_.]*)\s+do\b/);
      if (modMatch) {
        const parent = moduleStack();
        const declared = modMatch[1];
        const qualifiedName = this.resolveNestedModuleName(parent, declared);
        const mod: ElixirModule = {
          name: qualifiedName.split('.').pop() || qualifiedName,
          qualifiedName,
          lineStart: lineNo,
          lineEnd: lineNo,
          functions: [],
          uses: [], imports: [], aliases: [], requires: [],
          structFields: [],
          hasStruct: false,
          tags: new Set<string>(),
        };
        modules.push(mod);
        stack.push({ kind: 'module', module: mod });
        continue;
      }

      const current = moduleStack();

      if (current) {
        // use / import / alias / require
        const directive = this.matchDirective(trimmed);
        if (directive) {
          switch (directive.kind) {
            case 'use':
              current.uses.push({ target: directive.target, line: lineNo });
              for (const { match, tag } of USE_TAGS) {
                if (match.test(directive.raw)) current.tags.add(tag);
              }
              break;
            case 'import':
              current.imports.push({ target: directive.target, line: lineNo });
              break;
            case 'require':
              current.requires.push({ target: directive.target, line: lineNo });
              break;
            case 'alias':
              current.aliases.push({
                target: directive.target,
                as: directive.as || (directive.target.split('.').pop() || directive.target),
                line: lineNo,
              });
              break;
          }
        }

        // defstruct
        const structMatch = trimmed.match(/^defstruct\b(.*)$/);
        if (structMatch) {
          current.hasStruct = true;
          current.tags.add('struct');
          current.structFields.push(...this.extractStructFields(structMatch[1]));
        }

        // schema "table" do  (Ecto fields) -> just tag, already covered by use
        // def / defp / defmacro
        const fn = this.matchFunctionHead(trimmed, lineNo, current.qualifiedName);
        if (fn) {
          // Avoid double-counting clauses: keep the first occurrence per name/arity.
          const existing = current.functions.find(
            f => f.name === fn.name && f.arity === fn.arity && f.visibility === fn.visibility
          );
          if (!existing) {
            current.functions.push(fn);
          }
        }
      }

      // Track block depth for `do`/`end` so module end-lines are accurate.
      const opens = this.countDoOpeners(trimmed);
      const closes = this.countEnds(trimmed);
      for (let o = 0; o < opens; o++) {
        // A module `defmodule ... do` already pushed a module frame above;
        // only push a generic block frame for non-module openers.
        if (!modMatch || o > 0) stack.push({ kind: 'block' });
      }
      for (let c = 0; c < closes; c++) {
        const frame = stack.pop();
        if (frame?.kind === 'module' && frame.module) {
          frame.module.lineEnd = lineNo;
        }
      }
    }

    // Close any modules left open (malformed/truncated files).
    for (const mod of modules) {
      if (mod.lineEnd <= mod.lineStart) mod.lineEnd = lines.length;
    }

    return modules;
  }

  // Nested modules in Elixir compose names: outer App.Foo + inner Bar => App.Foo.Bar,
  // but an inner fully-qualified name (App.X) is used as-is.
  private resolveNestedModuleName(parent: ElixirModule | undefined, declared: string): string {
    if (!parent) return declared;
    return `${parent.qualifiedName}.${declared}`;
  }

  private matchDirective(trimmed: string):
    | { kind: 'use' | 'import' | 'require' | 'alias'; target: string; as?: string; raw: string }
    | undefined {
    const m = trimmed.match(/^(use|import|require|alias)\s+([A-Z][A-Za-z0-9_.]*)(.*)$/);
    if (!m) return undefined;
    const kind = m[1] as 'use' | 'import' | 'require' | 'alias';
    const target = m[2];
    const rest = m[3] || '';
    let as: string | undefined;
    if (kind === 'alias') {
      const asMatch = rest.match(/,\s*as:\s*([A-Z][A-Za-z0-9_.]*)/);
      if (asMatch) as = asMatch[1].split('.').pop();
    }
    return { kind, target, as, raw: trimmed };
  }

  private matchFunctionHead(trimmed: string, lineNo: number, moduleQN: string): ElixirFunction | undefined {
    // def name(args), defp name(args), defmacro name(args); also no-paren defs.
    const m = trimmed.match(/^(defmacrop?|defp?)\s+([a-z_][A-Za-z0-9_?!]*)\s*(\(([^)]*)\))?/);
    if (!m) return undefined;
    const keyword = m[1];
    const name = m[2];
    const argsRaw = m[4] || '';
    const visibility: ElixirVisibility =
      keyword === 'defp' || keyword === 'defmacrop' ? 'private' : 'public';
    const isMacro = keyword.startsWith('defmacro');
    const arity = this.countArity(argsRaw);
    return {
      name,
      arity,
      visibility,
      isMacro,
      lineStart: lineNo,
      lineEnd: lineNo,
      moduleQualifiedName: moduleQN,
    };
  }

  private countArity(argsRaw: string): number {
    const trimmed = argsRaw.trim();
    if (!trimmed) return 0;
    // Count top-level commas (ignore nested brackets).
    let depth = 0;
    let count = 1;
    for (const ch of trimmed) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) count++;
    }
    return count;
  }

  private extractStructFields(rest: string): string[] {
    const fields: string[] = [];
    // defstruct [:a, :b, c: 1]  OR  defstruct a: 1, b: 2
    const atomFields = rest.matchAll(/:([a-z_][A-Za-z0-9_]*)/g);
    for (const f of atomFields) fields.push(f[1]);
    const kwFields = rest.matchAll(/([a-z_][A-Za-z0-9_]*):/g);
    for (const f of kwFields) {
      if (!fields.includes(f[1])) fields.push(f[1]);
    }
    return [...new Set(fields)];
  }

  // Count `do` block openers on a line (defmodule/def/if/case/... do, or `do` keyword).
  private countDoOpeners(trimmed: string): number {
    let count = 0;
    // trailing/standalone `do` (block form). Inline `, do:` does NOT open a block.
    if (/(^|\s)do\s*$/.test(trimmed)) count++;
    // `fn ... ->` ... `end` blocks
    const fnOpeners = trimmed.match(/\bfn\b/g);
    if (fnOpeners) count += fnOpeners.length;
    return count;
  }

  private countEnds(trimmed: string): number {
    const m = trimmed.match(/\bend\b/g);
    return m ? m.length : 0;
  }

  private stripComment(line: string): string {
    let inDouble = false;
    let result = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i - 1] !== '\\') inDouble = !inDouble;
      if (ch === '#' && !inDouble) break;
      result += ch;
    }
    return result;
  }

  // ---- Node / edge emission ------------------------------------------------

  private emitFileNodes(
    info: ElixirFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {
    const fileId = this.fileId(info.relativePath);
    const baseName = info.relativePath.split('/').pop() || 'unknown.ex';

    nodes.push(this.createNodeBuilder(fileId, baseName, 'file')
      .withLevel(1, 'File/Module')
      .withCategory('modules', ['elixir-files'])
      .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
      .withMetadata({
        language: 'elixir',
        attributes: {
          extension: path.extname(baseName) || '(none)',
          moduleCount: info.modules.length,
          isScript: baseName.endsWith('.exs'),
        },
      })
      .build());

    for (const mod of info.modules) {
      const moduleId = this.moduleId(mod.qualifiedName);
      const tags = [...mod.tags];
      const moduleNode = this.createNodeBuilder(moduleId, mod.name, 'module')
        .withLevel(3, 'code')
        .withCategory('module', ['elixir'])
        .withSource({ file: info.fullPath, line: mod.lineStart, end_line: mod.lineEnd })
        .withTags(tags.map(t => `elixir:${t}`))
        .withMetadata({
          language: 'elixir',
          attributes: {
            qualified_name: mod.qualifiedName,
            visibility: 'public',
            is_struct: mod.hasStruct,
            struct_fields: mod.structFields,
            behaviours: tags,
            function_count: mod.functions.length,
          },
        })
        .build();
      moduleNode.qualified_name = mod.qualifiedName;
      nodes.push(moduleNode);

      edges.push(this.createEdge(`${fileId}_contains_${moduleId}`, fileId, moduleId, 'contains'));

      const isRouter = mod.tags.has('phoenix-router');
      const isController = mod.tags.has('phoenix-controller');
      const isGenServer = mod.tags.has('genserver') || mod.tags.has('supervisor');
      const isLiveView = mod.tags.has('liveview');

      for (const fn of mod.functions) {
        const functionId = this.functionId(mod.qualifiedName, fn.name, fn.arity);
        const fnNode = this.createNodeBuilder(functionId, fn.name, 'function')
          .withLevel(4, 'member')
          .withCategory('function', ['elixir'])
          .withSource({ file: info.fullPath, line: fn.lineStart, end_line: fn.lineEnd })
          .withMetadata({
            language: 'elixir',
            access_modifier: fn.visibility,
            attributes: {
              visibility: fn.visibility,
              arity: fn.arity,
              is_macro: fn.isMacro,
              qualified_name: `${mod.qualifiedName}.${fn.name}/${fn.arity}`,
              module: mod.qualifiedName,
            },
          })
          .build();
        fnNode.qualified_name = `${mod.qualifiedName}.${fn.name}/${fn.arity}`;
        nodes.push(fnNode);

        edges.push(this.createEdge(
          `${moduleId}_contains_${functionId}`,
          moduleId,
          functionId,
          'contains'
        ));

        // Entry points: OTP callbacks and Phoenix controller actions.
        if (isGenServer && OTP_CALLBACKS.has(fn.name)) {
          entryPoints.push(this.createEntryPoint(
            `entry_${functionId}`,
            functionId,
            fn.name === 'init' || fn.name === 'start_link' ? 'lifecycle' : 'message',
            `OTP callback: ${mod.qualifiedName}.${fn.name}/${fn.arity}`,
            `GenServer/OTP callback ${fn.name}`,
            { event: fn.name },
            undefined,
            { module: mod.qualifiedName, callback: fn.name, line: fn.lineStart, language: 'elixir' }
          ));
        } else if (isLiveView && (fn.name === 'mount' || fn.name === 'handle_event' || fn.name === 'handle_info')) {
          entryPoints.push(this.createEntryPoint(
            `entry_${functionId}`,
            functionId,
            fn.name === 'mount' ? 'lifecycle' : 'event',
            `LiveView callback: ${mod.qualifiedName}.${fn.name}/${fn.arity}`,
            `Phoenix LiveView callback ${fn.name}`,
            { event: fn.name },
            undefined,
            { module: mod.qualifiedName, callback: fn.name, line: fn.lineStart, language: 'elixir' }
          ));
        } else if (isController && fn.visibility === 'public') {
          entryPoints.push(this.createEntryPoint(
            `entry_${functionId}`,
            functionId,
            'http',
            `Controller action: ${mod.qualifiedName}.${fn.name}/${fn.arity}`,
            `Phoenix controller action ${fn.name}`,
            undefined,
            undefined,
            { module: mod.qualifiedName, action: fn.name, line: fn.lineStart, language: 'elixir' }
          ));
        }
      }

      // Phoenix Router route macros as entry points.
      if (isRouter) {
        this.emitRouterEntryPoints(info, mod, moduleId, entryPoints);
      }

      // Application module: `use Application` + `def start` -> lifecycle entry point.
      if (mod.tags.has('struct') === false &&
          (mod.uses.some(u => /\bApplication\b/.test(u.target)))) {
        const startFn = mod.functions.find(f => f.name === 'start');
        if (startFn) {
          const startId = this.functionId(mod.qualifiedName, startFn.name, startFn.arity);
          entryPoints.push(this.createEntryPoint(
            `entry_app_${this.moduleId(mod.qualifiedName)}`,
            startId,
            'lifecycle',
            `Application start: ${mod.qualifiedName}`,
            'OTP Application start/2 entry point',
            undefined,
            undefined,
            { module: mod.qualifiedName, line: startFn.lineStart, language: 'elixir' }
          ));
        }
      }
    }
  }

  private emitRouterEntryPoints(
    info: ElixirFileInfo,
    mod: ElixirModule,
    moduleId: string,
    entryPoints: CASEntryPoint[]
  ): void {
    let content: string;
    try {
      content = fs.readFileSync(info.fullPath, 'utf-8');
    } catch {
      return;
    }
    const lines = content.split('\n');
    for (let i = mod.lineStart - 1; i < Math.min(mod.lineEnd, lines.length); i++) {
      const trimmed = this.stripComment(lines[i]).trim();
      const m = trimmed.match(/^(get|post|put|patch|delete|options|head|forward)\s+("[^"]*"|'[^']*'|[^\s,]+)\s*,\s*(.+)$/);
      if (!m || !ROUTE_MACROS.has(m[1])) continue;
      const method = m[1].toUpperCase();
      const routePath = m[2].replace(/['"]/g, '');
      const handler = m[3].trim();
      entryPoints.push(this.createEntryPoint(
        `entry_route_${moduleId}_${this.sanitizeId(method)}_${this.sanitizeId(routePath)}_${i + 1}`,
        moduleId,
        'route',
        `${method} ${routePath}`,
        `Phoenix route ${method} ${routePath}`,
        { method, path: routePath },
        undefined,
        { module: mod.qualifiedName, handler, line: i + 1, language: 'elixir' }
      ));
    }
  }

  // alias/import/use/require that resolve to a repo-defined module -> module->module edges.
  private emitDependencyEdges(
    fileInfos: ElixirFileInfo[],
    moduleIndex: Map<string, ElixirModule>,
    edges: CASEdge[]
  ): void {
    const seen = new Set(edges.map(e => e.id));
    for (const info of fileInfos) {
      for (const mod of info.modules) {
        const sourceId = this.moduleId(mod.qualifiedName);
        const directives: Array<{ target: string; kind: string; line: number }> = [
          ...mod.uses.map(u => ({ target: u.target, kind: 'use', line: u.line })),
          ...mod.imports.map(u => ({ target: u.target, kind: 'import', line: u.line })),
          ...mod.requires.map(u => ({ target: u.target, kind: 'require', line: u.line })),
          ...mod.aliases.map(a => ({ target: a.target, kind: 'alias', line: a.line })),
        ];
        for (const d of directives) {
          const target = this.resolveModuleRef(d.target, moduleIndex);
          if (!target || target === mod.qualifiedName) continue;
          const targetId = this.moduleId(target);
          const edgeId = `${sourceId}_${d.kind}_${targetId}_${d.line}`;
          if (seen.has(edgeId)) continue;
          seen.add(edgeId);
          edges.push(this.createEdge(
            edgeId,
            sourceId,
            targetId,
            d.kind === 'use' || d.kind === 'import' ? 'imports' : 'depends_on',
            'dependency',
            { line: d.line, directive: d.kind, language: 'elixir' }
          ));
        }
      }
    }
  }

  // Conservative call edges: Module.func( and local func( within a function body,
  // resolved against repo-defined functions only.
  private emitCallEdges(
    fileInfos: ElixirFileInfo[],
    moduleIndex: Map<string, ElixirModule>,
    edges: CASEdge[]
  ): void {
    const seen = new Set(edges.map(e => e.id));

    // Index repo functions by (module, name) for resolution.
    const fnByModuleName = new Map<string, ElixirFunction[]>();
    for (const mod of moduleIndex.values()) {
      for (const fn of mod.functions) {
        const key = `${mod.qualifiedName}::${fn.name}`;
        const arr = fnByModuleName.get(key) || [];
        arr.push(fn);
        fnByModuleName.set(key, arr);
      }
    }

    for (const info of fileInfos) {
      let content: string;
      try {
        content = fs.readFileSync(info.fullPath, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n');

      for (const mod of info.modules) {
        // Local alias resolution map for this module.
        const aliasMap = new Map<string, string>();
        for (const a of mod.aliases) aliasMap.set(a.as, a.target);

        for (const caller of mod.functions) {
          const callerId = this.functionId(mod.qualifiedName, caller.name, caller.arity);
          const start = caller.lineStart - 1;
          // Body extends to the next function start or module end.
          const end = this.functionBodyEnd(mod, caller, lines.length);
          for (let i = start; i < end && i < lines.length; i++) {
            const stripped = this.stripComment(lines[i]);

            // Qualified calls: Mod.Path.func(  or Alias.func(
            const qualified = stripped.matchAll(/\b([A-Z][A-Za-z0-9_.]*)\.([a-z_][A-Za-z0-9_?!]*)\s*\(/g);
            for (const q of qualified) {
              const ref = q[1];
              const fnName = q[2];
              const resolvedMod = this.resolveModuleRef(ref, moduleIndex, aliasMap);
              if (!resolvedMod) continue;
              const targets = fnByModuleName.get(`${resolvedMod}::${fnName}`);
              if (!targets || targets.length === 0) continue;
              const target = targets[0];
              this.pushCallEdge(seen, edges, callerId,
                this.functionId(resolvedMod, target.name, target.arity), i + 1, 'qualified');
            }

            // Local calls: bareword func(  resolving to a function in the same module.
            const local = stripped.matchAll(/(?:^|[^.\w])([a-z_][A-Za-z0-9_?!]*)\s*\(/g);
            for (const l of local) {
              const fnName = l[1];
              if (fnName === caller.name) continue;
              const targets = fnByModuleName.get(`${mod.qualifiedName}::${fnName}`);
              if (!targets || targets.length === 0) continue;
              const target = targets[0];
              this.pushCallEdge(seen, edges, callerId,
                this.functionId(mod.qualifiedName, target.name, target.arity), i + 1, 'local');
            }
          }
        }
      }
    }
  }

  private functionBodyEnd(mod: ElixirModule, caller: ElixirFunction, fileLineCount: number): number {
    // The body scan (`for i = start; i < end`) is exclusive of `end`. The next
    // function's declaration line must NOT be scanned as part of this caller's
    // body — otherwise an inline `def add(...), do: ...` (no `end`) bleeds into
    // the following `defp sum(...)` head and mis-reads it as a call (spurious
    // add→sum). Stop at the next def's declaration line, not one past it.
    let end = mod.lineEnd;
    for (const other of mod.functions) {
      if (other.lineStart > caller.lineStart && other.lineStart - 1 < end) {
        end = other.lineStart - 1;
      }
    }
    return Math.min(end, fileLineCount);
  }

  private pushCallEdge(
    seen: Set<string>,
    edges: CASEdge[],
    callerId: string,
    targetId: string,
    line: number,
    callType: string
  ): void {
    if (callerId === targetId) return;
    const edgeId = `call_${callerId}_to_${targetId}_${line}`;
    if (seen.has(edgeId)) return;
    seen.add(edgeId);
    edges.push(this.createEdge(
      edgeId,
      callerId,
      targetId,
      'calls',
      'behavior',
      { line, callType, language: 'elixir' }
    ));
  }

  // Resolve a module reference (possibly aliased) to a repo-defined qualified name.
  private resolveModuleRef(
    ref: string,
    moduleIndex: Map<string, ElixirModule>,
    aliasMap?: Map<string, string>
  ): string | undefined {
    if (moduleIndex.has(ref)) return ref;
    if (aliasMap) {
      // First segment may be an alias; expand it.
      const head = ref.split('.')[0];
      const expandedHead = aliasMap.get(head);
      if (expandedHead) {
        const rest = ref.slice(head.length); // includes leading '.'
        const expanded = `${expandedHead}${rest}`;
        if (moduleIndex.has(expanded)) return expanded;
      }
      const direct = aliasMap.get(ref);
      if (direct && moduleIndex.has(direct)) return direct;
    }
    // Suffix match: alias resolves a short name to a repo module ending in it.
    if (!ref.includes('.')) {
      for (const qn of moduleIndex.keys()) {
        if (qn === ref || qn.endsWith(`.${ref}`)) return qn;
      }
    }
    return undefined;
  }

  // ---- ID helpers ----------------------------------------------------------

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private moduleId(qualifiedName: string): string {
    return `module_${this.sanitizeId(qualifiedName)}`;
  }

  private functionId(moduleQN: string, name: string, arity: number): string {
    return `function_${this.sanitizeId(moduleQN)}_${this.sanitizeId(name)}_${arity}`;
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
    return [
      'elixir-modules',
      'elixir-functions',
      'elixir-structs',
      'elixir-dependencies',
      'phoenix-detection',
      'genserver-detection',
      'liveview-detection',
      'ecto-detection',
      'call-graph-analysis',
      'entry-point-detection',
    ];
  }
}

export default { ElixirAnalyzer };
