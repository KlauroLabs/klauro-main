import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';

type SwiftAccess = 'open' | 'public' | 'internal' | 'fileprivate' | 'private';
type SwiftTypeKind = 'class' | 'struct' | 'enum' | 'protocol' | 'actor' | 'extension';

interface SwiftFunction {
  name: string;
  access?: SwiftAccess;
  isStatic: boolean;
  isInit: boolean;
  lineStart: number;
  lineEnd: number;
  // Name of the enclosing type, or undefined for a free function.
  ownerName?: string;
  // True for `func application(_:open urls:)` (AppKit) / the UIKit
  // scene-delegate equivalent — the app's URL-scheme / deep-link entry.
  // Structural: matched on the parameter label `open urls:`, not the name alone.
  isDeepLinkHandler?: boolean;
}

// One SwiftUI scene builder found at the top level of an App-conforming
// type's `var body: some Scene` computed property — each is a distinct
// app surface (a window, a menu-bar extra, the Settings scene, ...).
interface SwiftSceneEntry {
  kind: string;
  line: number;
}

// A body-level `let`/`var` declaration with an explicit type — i.e. an
// actual stored property (the type's real data shape), not a computed
// property (which has a `{ get ... }` body instead of a stored value).
interface SwiftStoredProperty {
  name: string;
  type: string;
  // Leading property-wrapper attribute names, e.g. `@Published var x` -> ['Published'].
  annotations: string[];
  line: number;
}

interface SwiftType {
  name: string;
  kind: SwiftTypeKind;
  access?: SwiftAccess;
  // Names listed after the colon: base class + protocol conformances.
  conformances: string[];
  isSwiftUIView: boolean;
  isAppConformer: boolean;
  hasMainAttribute: boolean;
  lineStart: number;
  lineEnd: number;
  functions: SwiftFunction[];
  // Stored (non-computed) properties declared directly in the type body —
  // the class/struct's actual data shape, analogous to a Kotlin data class's
  // primary-constructor fields. Populated for every type (cheap to compute);
  // only consulted for entity-shape classification below.
  storedProperties: SwiftStoredProperty[];
  // True when the body declares a nested `enum CodingKeys` — positive,
  // structural evidence the type participates in custom Codable
  // (de)serialization, carried into entity metadata when present.
  hasCodingKeysEnum: boolean;
  // SwiftUI scene builders found at the top level of `var body: some Scene`
  // (only meaningful when isAppConformer is true; empty otherwise).
  sceneEntries: SwiftSceneEntry[];
  // Line of a `.onOpenURL { ... }` modifier found anywhere in the type body,
  // if any — the SwiftUI deep-link entry point alternative to
  // `application(_:open:)`.
  onOpenURLLine?: number;
}

interface SwiftImport {
  module: string;
  lineNumber: number;
}

interface SwiftFileInfo {
  relativePath: string;
  fullPath: string;
  lineCount: number;
  types: SwiftType[];
  // Free functions (top-level, not inside a type).
  freeFunctions: SwiftFunction[];
  imports: SwiftImport[];
  hasTopLevelMain: boolean; // main.swift convention
}

const ACCESS_KEYWORDS = new Set(['open', 'public', 'internal', 'fileprivate', 'private']);
const TYPE_KEYWORDS: Record<string, SwiftTypeKind> = {
  class: 'class',
  struct: 'struct',
  enum: 'enum',
  protocol: 'protocol',
  actor: 'actor',
  extension: 'extension',
};
// Swift control-flow / keyword identifiers that must never be treated as user calls.
const SWIFT_KEYWORDS = new Set([
  'if', 'else', 'guard', 'switch', 'case', 'default', 'for', 'while', 'repeat',
  'do', 'catch', 'try', 'throw', 'throws', 'return', 'break', 'continue', 'in',
  'let', 'var', 'func', 'init', 'deinit', 'self', 'super', 'nil', 'true', 'false',
  'where', 'as', 'is', 'async', 'await', 'defer', 'fallthrough', 'some', 'any',
  'print', 'and', 'or', 'not',
]);
// Conformances that mark a `@main` type as a CLI command entry (swift-argument-parser)
// rather than a generic app-lifecycle entry. Stronger evidence than the
// App/Scene-absence rule below, but not the only way to reach 'cli' — see
// the entry-point classification comment where it's used.
const CLI_COMMAND_CONFORMANCES = new Set(['ParsableCommand', 'AsyncParsableCommand']);
// Conformances that mark a `@main` type as the app's UI/process LIFECYCLE
// (SwiftUI's `App` protocol, or a `Scene` builder occasionally carrying
// `@main` directly) rather than a plain process entry point.
const APP_LIFECYCLE_CONFORMANCES = new Set(['App', 'Scene']);
// Structurally excluded from data-entity classification even when a struct
// has >=2 stored properties: a CLI command's own option/argument struct
// isn't a payload/domain shape, and Error conformers are diagnostic types,
// not data entities.
const NON_ENTITY_CONFORMANCES = new Set(['Scene', 'Error', 'ParsableCommand', 'AsyncParsableCommand']);
// Conformances that mark a type as the app's lifecycle delegate, wired via
// `@NSApplicationDelegateAdaptor`/`@UIApplicationDelegateAdaptor` (SwiftUI)
// or the classic `UIApplicationMain`/`NSApplicationMain` entry — NOT via
// `@main` on the delegate itself, so this is detected independently of the
// hasMainAttribute/isAppConformer entry-point path above.
const APP_DELEGATE_CONFORMANCES = new Set(['NSApplicationDelegate', 'UIApplicationDelegate']);
// SwiftUI Scene builders recognized inside an App-conforming type's
// `var body: some Scene`. Each is a distinct app surface. Matched by word
// boundary + an immediately-following `(` or `{` so `Window` doesn't
// false-positive inside `WindowGroup`.
const SCENE_BUILDER_KEYWORDS = ['WindowGroup', 'Window', 'MenuBarExtra', 'Settings', 'DocumentGroup'];

export class SwiftAnalyzer extends BaseAnalyzer {
  constructor() {
    super(
      'swift',
      'Swift Language Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await this.findSwiftFiles(projectPath, { projectPath }, true);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await this.findSwiftFiles(projectPath, { projectPath }, false);
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const info = this.parseSwiftFile(context.relativePath, context.filePath, content);
    const typeIndex = this.buildTypeIndex([info]);
    const functionIndex = this.buildFunctionIndex([info]);

    this.emitFileNodes(info, nodes, edges, entryPoints, typeIndex);
    this.emitConformanceEdges([info], typeIndex, edges);
    this.emitCallEdges(info, content, functionIndex, edges);

    const imports = info.imports.map(imp => imp.module);
    const exports = info.types.map(t => t.name);

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
      let swiftFiles = await this.findSwiftFiles(context.projectPath, context, false);
      swiftFiles.sort();
      swiftFiles = this.capAndPrioritizeSourceFiles(swiftFiles, 'swift files');

      const fileInfos: SwiftFileInfo[] = [];
      for (const relativePath of swiftFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        fileInfos.push(this.parseSwiftFile(relativePath, fullPath, content));
      }

      const typeIndex = this.buildTypeIndex(fileInfos);
      const functionIndex = this.buildFunctionIndex(fileInfos);

      const externalModules = new Set<string>();
      for (const info of fileInfos) {
        this.emitFileNodes(info, nodes, edges, entryPoints, typeIndex);
        for (const imp of info.imports) externalModules.add(imp.module);
      }

      this.emitConformanceEdges(fileInfos, typeIndex, edges);

      for (const info of fileInfos) {
        const content = await fs.readFile(info.fullPath, 'utf-8').catch(() => '');
        if (content) this.emitCallEdges(info, content, functionIndex, edges);
      }

      const warnings = this.collectAnalysisWarnings();
      // 'dto' covers structs reclassified as data-entity shapes (see
      // emitFileNodes) — still a Swift TYPE, just carrying a more precise
      // node.type than plain 'class' for downstream entity derivation.
      const typeCount = nodes.filter(n => n.type === 'class' || n.type === 'interface' || n.type === 'dto').length;
      const functionCount = nodes.filter(n => n.type === 'function' || n.type === 'method').length;
      const viewCount = nodes.filter(n => n.tags?.includes('swiftui-view')).length;

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'swift',
          packageManager: 'spm',
          filesAnalyzed: fileInfos.length,
          typesFound: typeCount,
          functionsFound: functionCount,
          swiftUIViewsFound: viewCount,
          externalModules: Array.from(externalModules).sort(),
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `Swift analysis failed: ${(error as Error).message}`,
        'SWIFT_ANALYSIS_ERROR'
      );
    }
  }

  private async findSwiftFiles(
    projectPath: string,
    context: AnalysisContext,
    stopEarly: boolean
  ): Promise<string[]> {
    const ignore = this.getIgnorePatterns(context);
    const files = await glob(['**/*.swift'], {
      cwd: projectPath,
      ignore,
      nodir: true
    });
    if (stopEarly) return files.slice(0, 1);
    return files;
  }

  private parseSwiftFile(relativePath: string, fullPath: string, content: string): SwiftFileInfo {
    const lines = content.split('\n');
    const baseName = path.basename(relativePath);

    const types: SwiftType[] = [];
    const freeFunctions: SwiftFunction[] = [];
    const imports = this.extractImports(lines);

    let pendingMainAttr = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      // Track a standalone @main attribute that precedes a type declaration.
      if (/^@main\b/.test(trimmed)) {
        pendingMainAttr = true;
        // @main may share the line with the declaration; fall through to parse it.
      }

      const typeDecl = this.matchTypeDeclaration(trimmed);
      if (typeDecl) {
        const lineEnd = this.findBlockEnd(lines, i);
        const hasMain = pendingMainAttr || /@main\b/.test(trimmed);
        const functions = this.extractMembersAtBodyLevel(lines, i + 1, lineEnd, typeDecl.name);
        const conformances = typeDecl.conformances;
        const { properties: storedProperties, hasCodingKeysEnum } =
          this.extractStoredProperties(lines, i + 1, lineEnd);
        const isAppConformer = conformances.includes('App');
        // Cheap and only meaningful for App conformers, but computed
        // unconditionally like storedProperties above — consulted below.
        const sceneEntries = isAppConformer
          ? this.extractSceneEntries(lines, i + 1, lineEnd)
          : [];
        const onOpenURLLine = this.findOnOpenURLLine(lines, i + 1, lineEnd);
        types.push({
          name: typeDecl.name,
          kind: typeDecl.kind,
          access: typeDecl.access,
          conformances,
          isSwiftUIView: conformances.includes('View'),
          isAppConformer,
          hasMainAttribute: hasMain,
          lineStart: i + 1,
          lineEnd,
          functions,
          storedProperties,
          hasCodingKeysEnum,
          sceneEntries,
          onOpenURLLine,
        });
        pendingMainAttr = false;
        i = lineEnd - 1; // skip the body; functions already captured
        continue;
      }

      // A non-type, non-blank declaration line consumes a pending @main only if it's not @main itself.
      if (pendingMainAttr && !/^@main\b/.test(trimmed)) {
        pendingMainAttr = false;
      }

      // Free (top-level) function.
      const fn = this.matchFunctionDeclaration(trimmed);
      if (fn) {
        const lineEnd = this.findBlockEnd(lines, i);
        freeFunctions.push({
          name: fn.name,
          access: fn.access,
          isStatic: fn.isStatic,
          isInit: fn.isInit,
          lineStart: i + 1,
          lineEnd,
        });
      }
    }

    return {
      relativePath,
      fullPath,
      lineCount: lines.length,
      types,
      freeFunctions,
      imports,
      hasTopLevelMain: baseName === 'main.swift',
    };
  }

  private extractImports(lines: string[]): SwiftImport[] {
    const imports: SwiftImport[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const match = trimmed.match(/^import\s+(?:struct\s+|class\s+|enum\s+|func\s+|protocol\s+|typealias\s+|var\s+|let\s+)?([A-Za-z_][A-Za-z0-9_.]*)/);
      if (match) {
        // For submodule imports (import Foo.Bar) keep the root module.
        imports.push({ module: match[1].split('.')[0], lineNumber: i + 1 });
      }
    }
    return imports;
  }

  private matchTypeDeclaration(trimmed: string): { name: string; kind: SwiftTypeKind; access?: SwiftAccess; conformances: string[] } | undefined {
    // Strip a leading attribute (e.g. @main, @objc) so the keyword is reachable.
    let working = trimmed.replace(/^(@[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?\s+)+/, '');

    const access = this.leadingAccess(working);
    // Remove leading modifiers to find the type keyword.
    const modifierStripped = working.replace(/^((open|public|internal|fileprivate|private|final|static|indirect|@[A-Za-z_]+(\([^)]*\))?)\s+)+/, '');

    const keywordMatch = modifierStripped.match(/^(class|struct|enum|protocol|actor|extension)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!keywordMatch) return undefined;

    const kind = TYPE_KEYWORDS[keywordMatch[1]];
    const name = keywordMatch[2];

    // Conformances/inheritance come after the type name up to the opening brace or generic where.
    const conformances = this.extractConformances(modifierStripped, name);

    return { name, kind, access, conformances };
  }

  private extractConformances(declLine: string, typeName: string): string[] {
    // Capture text after "Name<...>?" and a colon, up to `{` or `where`.
    const afterName = declLine.slice(declLine.indexOf(typeName) + typeName.length);
    // Drop generic parameter clause on the type itself.
    const withoutGenerics = afterName.replace(/^\s*<[^>]*>/, '');
    const colonIdx = withoutGenerics.indexOf(':');
    if (colonIdx === -1) return [];
    let rest = withoutGenerics.slice(colonIdx + 1);
    const braceIdx = rest.indexOf('{');
    if (braceIdx !== -1) rest = rest.slice(0, braceIdx);
    const whereIdx = rest.search(/\bwhere\b/);
    if (whereIdx !== -1) rest = rest.slice(0, whereIdx);

    return this.splitTopLevel(rest)
      .map(part => part.trim())
      // Strip generic args / namespacing to the base symbol name.
      .map(part => part.replace(/<.*$/, '').split('.').pop() || part)
      .filter(part => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part));
  }

  // Collect func/init declarations that sit directly in the type body (one brace level deep).
  private extractMembersAtBodyLevel(lines: string[], start: number, end: number, ownerName: string): SwiftFunction[] {
    const functions: SwiftFunction[] = [];
    let depth = 0;
    let bodyEntered = false;
    for (let i = start - 1; i < end && i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      const trimmed = stripped.trim();

      // Member declarations sit at body level (depth === 1 after the type's opening brace).
      if (bodyEntered && depth === 1 && trimmed) {
        const fn = this.matchFunctionDeclaration(trimmed);
        if (fn) {
          const lineEnd = this.findBlockEnd(lines, i);
          // AppKit's `application(_:open:)` / the equivalent UIKit
          // scene-delegate hook — matched on the `open urls:` parameter
          // label, not the bare function name (which is also used for the
          // unrelated `application(_:didFinishLaunching...)` lifecycle hook).
          const isDeepLinkHandler = fn.name === 'application' && /\bopen\s+urls\s*:/.test(trimmed);
          functions.push({
            name: fn.name,
            access: fn.access,
            isStatic: fn.isStatic,
            isInit: fn.isInit,
            lineStart: i + 1,
            lineEnd,
            ownerName,
            isDeepLinkHandler,
          });
        }
      }

      for (const ch of stripped) {
        if (ch === '{') { depth++; bodyEntered = true; }
        else if (ch === '}') depth--;
      }
    }
    return functions;
  }

  // Collect stored (non-computed) properties directly in the type body (one
  // brace level deep) plus whether the body declares a nested `CodingKeys`
  // enum. Best-effort/regex-based like the rest of this file: a declaration
  // this can't confidently classify as stored (vs. computed) is skipped, not
  // guessed at — never fabricates a field.
  private extractStoredProperties(
    lines: string[],
    start: number,
    end: number
  ): { properties: SwiftStoredProperty[]; hasCodingKeysEnum: boolean } {
    const properties: SwiftStoredProperty[] = [];
    let hasCodingKeysEnum = false;
    let depth = 0;
    let bodyEntered = false;
    for (let i = start - 1; i < end && i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      const trimmed = stripped.trim();

      if (bodyEntered && depth === 1 && trimmed) {
        if (/^((private|fileprivate|internal|public)\s+)?enum\s+CodingKeys\b/.test(trimmed)) {
          hasCodingKeysEnum = true;
        }
        const prop = this.matchStoredPropertyDeclaration(trimmed);
        if (prop) properties.push({ ...prop, line: i + 1 });
      }

      for (const ch of stripped) {
        if (ch === '{') { depth++; bodyEntered = true; }
        else if (ch === '}') depth--;
      }
    }
    return { properties, hasCodingKeysEnum };
  }

  // Find SwiftUI Scene builders (WindowGroup/Window/MenuBarExtra/Settings/
  // DocumentGroup) declared at the top brace-level of a `var body: some
  // Scene` computed property within the given type body. Scoped strictly to
  // that property's own braces — never a repo-wide scan for these words,
  // which would false-positive on unrelated types/settings screens.
  private extractSceneEntries(lines: string[], start: number, end: number): SwiftSceneEntry[] {
    const entries: SwiftSceneEntry[] = [];
    let depth = 0;
    let bodyEntered = false;
    let inSceneBody = false;
    let sceneDepth = 0;
    for (let i = start - 1; i < end && i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      const trimmed = stripped.trim();

      if (bodyEntered && depth === 1 && !inSceneBody && trimmed &&
        /^(?:(?:open|public|internal|fileprivate|private)\s+)?var\s+body\s*:\s*some\s+Scene\b/.test(trimmed)) {
        inSceneBody = true;
        sceneDepth = 0;
      } else if (inSceneBody && sceneDepth === 1 && trimmed) {
        for (const kind of SCENE_BUILDER_KEYWORDS) {
          if (new RegExp(`\\b${kind}\\b\\s*[({]`).test(trimmed)) {
            entries.push({ kind, line: i + 1 });
          }
        }
      }

      for (const ch of stripped) {
        if (ch === '{') {
          depth++;
          bodyEntered = true;
          if (inSceneBody) sceneDepth++;
        } else if (ch === '}') {
          depth--;
          if (inSceneBody) {
            sceneDepth--;
            if (sceneDepth <= 0) inSceneBody = false;
          }
        }
      }
    }
    return entries;
  }

  // Find a `.onOpenURL { ... }` SwiftUI modifier anywhere within the type
  // body (any nesting depth — it's a view-modifier chained inside a body,
  // not a body-level declaration). Structural token match, not a keyword scan
  // over the whole file: scoped to this type's own line range.
  private findOnOpenURLLine(lines: string[], start: number, end: number): number | undefined {
    for (let i = start - 1; i < end && i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      if (/\.onOpenURL\s*\{/.test(stripped)) return i + 1;
    }
    return undefined;
  }

  // Matches a body-level `let`/`var name: Type` declaration and returns its
  // name/type/leading-attribute (property-wrapper) names. Returns undefined
  // for anything that isn't a plain stored declaration with an explicit
  // type — in particular a computed property or property-observer block
  // (`var x: Int { get { ... } }` / `{ didSet { ... } }`), recognized by the
  // type being immediately followed by `{` rather than `=` or end-of-line.
  private matchStoredPropertyDeclaration(
    trimmed: string
  ): { name: string; type: string; annotations: string[] } | undefined {
    const annotations: string[] = [];
    let working = trimmed;
    const attrRe = /^@([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?\s+/;
    let attrMatch: RegExpMatchArray | null;
    while ((attrMatch = working.match(attrRe))) {
      annotations.push(attrMatch[1]);
      working = working.slice(attrMatch[0].length);
    }
    working = working.replace(
      /^((private|fileprivate|internal|public|open|static|final|lazy|weak|unowned)\s+)+/,
      ''
    );

    const declMatch = working.match(/^(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^={]+?)\s*(=|\{|$)/);
    if (!declMatch) return undefined;

    const terminator = declMatch[3];
    if (terminator === '{') return undefined; // computed property / observer — not stored data

    const type = declMatch[2].trim();
    if (!type) return undefined;

    return { name: declMatch[1], type: type.replace(/\s+/g, ' '), annotations };
  }

  // A struct qualifies as a data-entity shape when it carries at least two
  // stored properties (excludes single-property wrappers, e.g.
  // `struct Id { let value: String }`), isn't SwiftUI View/Scene/App UI
  // surface, isn't an Error/CLI-command struct, and doesn't live under a
  // ui/theme-ish path (design tokens, not a domain DTO). Evidence-gated on
  // structure/conformance/path, never name-based.
  private isEntityShapedType(info: SwiftFileInfo, type: SwiftType): boolean {
    if (type.kind !== 'struct') return false;
    if (type.storedProperties.length < 2) return false;
    if (type.isSwiftUIView || type.isAppConformer) return false;
    if (type.conformances.some(c => NON_ENTITY_CONFORMANCES.has(c))) return false;

    const fileLower = info.relativePath.toLowerCase().replace(/\\/g, '/');
    if (/(^|\/)(ui\/)?theme(s)?(\/|$)/.test(fileLower)) return false;

    return true;
  }

  private matchFunctionDeclaration(trimmed: string): { name: string; access?: SwiftAccess; isStatic: boolean; isInit: boolean } | undefined {
    // Strip leading attributes.
    let working = trimmed.replace(/^(@[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?\s+)+/, '');
    const access = this.leadingAccess(working);
    const isStatic = /(^|\s)(static|class)\s+func\b/.test(working);

    // init / convenience init / required init
    const initMatch = working.match(/^((open|public|internal|fileprivate|private|final|required|convenience|override|static)\s+)*init\b/);
    if (initMatch) {
      return { name: 'init', access, isStatic: false, isInit: true };
    }

    const funcMatch = working.match(/^((open|public|internal|fileprivate|private|final|static|class|override|mutating|nonmutating|async|@[A-Za-z_]+(\([^)]*\))?)\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*|[-+*/%<>=!&|^~]+)/);
    if (!funcMatch) return undefined;
    const name = funcMatch[4];
    return { name, access, isStatic, isInit: false };
  }

  private leadingAccess(line: string): SwiftAccess | undefined {
    const stripped = line.replace(/^(@[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?\s+)+/, '');
    const first = stripped.split(/\s+/)[0];
    if (ACCESS_KEYWORDS.has(first)) return first as SwiftAccess;
    return undefined;
  }

  private splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    for (const ch of text) {
      if (ch === '<' || ch === '(' || ch === '[') depth++;
      else if (ch === '>' || ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current);
    return parts;
  }

  private findBlockEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    let seenOpen = false;
    for (let i = startIndex; i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);

      // Before any opening brace is seen, a bodyless declaration (e.g. a protocol
      // requirement `func greet()`) ends on its own line. If the next non-empty
      // line opens nothing and we hit a `}` (end of the enclosing body), stop here
      // so we never absorb sibling declarations.
      if (!seenOpen && i > startIndex) {
        const t = stripped.trim();
        if (t.startsWith('}')) return i; // closing brace of the enclosing scope
      }

      for (const ch of stripped) {
        if (ch === '{') {
          depth++;
          seenOpen = true;
        } else if (ch === '}') {
          depth--;
          if (seenOpen && depth <= 0) return i + 1;
        }
      }

      // A bodyless declaration: no opening brace anywhere on the starting line,
      // and the next line is a new declaration — treat the start line as the whole decl.
      if (!seenOpen && i === startIndex && !stripped.includes('{')) {
        const next = (lines[i + 1] || '').trim();
        if (this.startsNewDeclaration(next) || next.startsWith('}') || next === '') {
          return startIndex + 1;
        }
      }
    }
    return startIndex + 1;
  }

  private startsNewDeclaration(trimmed: string): boolean {
    const stripped = trimmed.replace(/^(@[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?\s+)+/, '');
    return /^((open|public|internal|fileprivate|private|final|static|class|override|mutating|required|convenience|indirect)\s+)*(func|init|var|let|class|struct|enum|protocol|actor|extension)\b/.test(stripped);
  }

  private stripStringsAndComments(line: string): string {
    let result = '';
    let inString = false;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];
      if (!inString && ch === '/' && next === '/') break;
      if (ch === '"') {
        inString = !inString;
        i++;
        continue;
      }
      if (!inString) result += ch;
      i++;
    }
    return result;
  }

  private buildTypeIndex(fileInfos: SwiftFileInfo[]): Map<string, { fileRel: string; type: SwiftType }> {
    const index = new Map<string, { fileRel: string; type: SwiftType }>();
    for (const info of fileInfos) {
      for (const type of info.types) {
        // Prefer the canonical declaration (non-extension) when names collide.
        const existing = index.get(type.name);
        if (!existing || (existing.type.kind === 'extension' && type.kind !== 'extension')) {
          index.set(type.name, { fileRel: info.relativePath, type });
        }
      }
    }
    return index;
  }

  private buildFunctionIndex(fileInfos: SwiftFileInfo[]): Map<string, Array<{ fileRel: string; fn: SwiftFunction }>> {
    const index = new Map<string, Array<{ fileRel: string; fn: SwiftFunction }>>();
    const add = (name: string, fileRel: string, fn: SwiftFunction) => {
      if (name === 'init') return; // do not resolve init as a call target
      const list = index.get(name) || [];
      list.push({ fileRel, fn });
      index.set(name, list);
    };
    for (const info of fileInfos) {
      for (const fn of info.freeFunctions) add(fn.name, info.relativePath, fn);
      for (const type of info.types) {
        for (const fn of type.functions) add(fn.name, info.relativePath, fn);
      }
    }
    return index;
  }

  private emitFileNodes(
    info: SwiftFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    typeIndex?: Map<string, { fileRel: string; type: SwiftType }>
  ): void {
    const fileId = this.fileId(info.relativePath);
    const baseName = path.basename(info.relativePath);

    nodes.push(this.createNodeBuilder(fileId, baseName, 'file')
      .withLevel(1, this.getLevelName(1))
      .withCategory('modules', ['swift-files'])
      .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
      .withMetadata({
        language: 'swift',
        attributes: {
          imports: info.imports.map(i => i.module),
          typeCount: info.types.length,
          freeFunctionCount: info.freeFunctions.length,
        }
      })
      .build());

    for (const type of info.types) {
      // An `extension X` is NOT a new type. When a canonical declaration of X
      // exists, skip the duplicate type node and re-parent the extension's
      // methods to the canonical type's id (so `extension UserStore { refresh }`
      // adds `refresh` to UserStore rather than emitting a second UserStore).
      const canonical = typeIndex?.get(type.name);
      const isCanonical = !canonical || canonical.type === type;
      const typeId = this.canonicalTypeId(type, typeIndex);

      if (!isCanonical) {
        // Methods only — attach to the canonical type's node.
        for (const fn of type.functions) {
          const fnId = this.functionId(info.relativePath, type.name, fn.name, fn.lineStart);
          const fnNode = this.createNodeBuilder(fnId, fn.name, 'method')
            .withLevel(4, this.getLevelName(4))
            .withCategory('methods', ['swift-methods'])
            .withSource({ file: info.fullPath, line: fn.lineStart, end_line: fn.lineEnd })
            .withParent(typeId)
            .withMetadata({
              language: 'swift',
              access_modifier: this.normalizeAccess(fn.access),
              is_static: fn.isStatic,
              attributes: {
                access: fn.access || 'internal',
                isInit: fn.isInit,
                isStatic: fn.isStatic,
                owner: type.name,
                file: info.relativePath,
                viaExtension: true,
              }
            })
            .build();
          fnNode.qualified_name = `${info.relativePath}:${type.name}.${fn.name}`;
          nodes.push(fnNode);
          edges.push(this.createEdge(`${typeId}_has_method_${fnId}`, typeId, fnId, 'has_method'));
        }
        continue;
      }
      // protocol -> 'interface'; an entity-shaped struct (>=2 stored
      // properties, non-UI, non-theme — see isEntityShapedType) -> 'dto' so
      // the orchestrator's generic data-entity derivation
      // (isDtoLikeDataShapeNode) picks it up unchanged; everything else -> 'class'.
      const isDataEntity = this.isEntityShapedType(info, type);
      const nodeType = type.kind === 'protocol' ? 'interface' : (isDataEntity ? 'dto' : 'class');
      const tags = [`analyzer:${this.analyzerId}`, `swift-${type.kind}`, ...(isDataEntity ? ['swift-data-entity'] : [])];
      if (type.isSwiftUIView) tags.push('swiftui-view');

      const serialization: string[] = [];
      if (type.hasCodingKeysEnum) serialization.push('CodingKeys');
      if (type.conformances.some(c => c === 'Codable' || c === 'Encodable' || c === 'Decodable')) {
        serialization.push('Codable');
      }

      const node = this.createNodeBuilder(typeId, type.name, nodeType)
        .withLevel(2, this.getLevelName(2))
        .withCategory('structures', [type.kind === 'protocol' ? 'protocols' : 'types'])
        .withSource({ file: info.fullPath, line: type.lineStart, end_line: type.lineEnd })
        .withTags(tags)
        .withMetadata({
          language: 'swift',
          access_modifier: this.normalizeAccess(type.access),
          attributes: {
            kind: type.kind,
            access: type.access || 'internal',
            conformances: type.conformances,
            isSwiftUIView: type.isSwiftUIView,
            isApp: type.isAppConformer,
            file: info.relativePath,
            methodCount: type.functions.length,
            ...(isDataEntity ? { propertyCount: type.storedProperties.length } : {}),
            ...(serialization.length > 0 ? { serialization } : {}),
          }
        })
        .build();
      node.qualified_name = `${info.relativePath}:${type.name}`;
      nodes.push(node);

      edges.push(this.createEdge(
        `${fileId}_contains_${typeId}`,
        fileId,
        typeId,
        'contains'
      ));

      // Data-entity fields: one 'property' node per stored property, parented
      // to the type node — the shape buildEntityPropertyIndex/
      // buildDataEntities (orchestrator) walks (node.parent + node.type ===
      // 'property') to populate a CASDataEntity's `fields`. Without these, a
      // 'dto'-typed node with zero matched property nodes contributes no
      // field evidence and gets filtered out (dataShapeNodeHasFieldEvidence).
      if (isDataEntity) {
        for (const field of type.storedProperties) {
          const propertyId = this.propertyId(info.relativePath, type.name, field.name);
          const propertyNode = this.createNodeBuilder(propertyId, field.name, 'property')
            .withLevel(3, this.getLevelName(3))
            .withCategory('structures', ['swift-fields'])
            .withSource({ file: info.fullPath, line: field.line, end_line: field.line })
            .withMetadata({
              language: 'swift',
              attributes: {
                type: field.type,
                ownerType: type.name,
                ...(field.annotations.length > 0 ? { annotations: field.annotations } : {}),
              },
            })
            // buildDataEntities (orchestrator) reads a property's type off
            // signature.return_type first — set it here so the field's type
            // surfaces on the derived CASDataEntity instead of collapsing to
            // 'unknown'.
            .withSignature({ return_type: field.type })
            .withParent(typeId)
            .build();
          nodes.push(propertyNode);

          edges.push(this.createEdge(
            `${typeId}_contains_${propertyId}`,
            typeId,
            propertyId,
            'contains'
          ));
        }
      }

      for (const fn of type.functions) {
        const fnId = this.functionId(info.relativePath, type.name, fn.name, fn.lineStart);
        const fnNode = this.createNodeBuilder(fnId, fn.name, 'method')
          .withLevel(4, this.getLevelName(4))
          .withCategory('methods', ['swift-methods'])
          .withSource({ file: info.fullPath, line: fn.lineStart, end_line: fn.lineEnd })
          .withParent(typeId)
          .withMetadata({
            language: 'swift',
            access_modifier: this.normalizeAccess(fn.access),
            is_static: fn.isStatic,
            attributes: {
              access: fn.access || 'internal',
              isInit: fn.isInit,
              isStatic: fn.isStatic,
              owner: type.name,
              file: info.relativePath,
            }
          })
          .build();
        fnNode.qualified_name = `${info.relativePath}:${type.name}.${fn.name}`;
        nodes.push(fnNode);

        edges.push(this.createEdge(
          `${typeId}_has_method_${fnId}`,
          typeId,
          fnId,
          'has_method'
        ));
      }

      // Entry points: @main attribute or App conformer only. A public type
      // declaration is API surface (already visible as a 'class'/'interface'/
      // 'dto' node with access_modifier:'public') — NOT an entry point on its
      // own; emitting one per public struct/class made every public type in
      // the repo look like a way in, drowning the real entries. The real
      // entry shapes here: a SwiftUI App/AppDelegate-adapter (@main + App/
      // Scene conformance) -> 'lifecycle'; any OTHER @main type -> 'cli' —
      // @main marks the process's actual entry point (a static main(), or
      // swift-argument-parser's synthesized one), and the only thing that
      // makes that entry a UI *lifecycle* hook instead of a plain process
      // entry is adopting App/Scene. A swift-argument-parser command
      // (ParsableCommand/AsyncParsableCommand conformance) is STRONGER
      // evidence for the same 'cli' outcome, not a separate requirement —
      // DEFECT (measured live on a real 2-executable Swift macOS repo,
      // v1.0.116): the second executable's @main type (a plain struct with
      // its own static main(), not conforming to ParsableCommand/
      // AsyncParsableCommand at all) fell through to 'lifecycle' ("App
      // entry point: <Name>") because the old check gated 'cli' on
      // ParsableCommand conformance specifically instead of on the absence
      // of App/Scene.
      if (type.hasMainAttribute || type.isAppConformer) {
        const isAppLifecycle = type.isAppConformer ||
          type.conformances.some(c => APP_LIFECYCLE_CONFORMANCES.has(c));
        const isParsableCommand = type.conformances.some(c => CLI_COMMAND_CONFORMANCES.has(c));
        const isCliCommand = type.hasMainAttribute && !isAppLifecycle;

        const reasons: string[] = [];
        if (type.hasMainAttribute) reasons.push('@main');
        if (isAppLifecycle) reasons.push(type.isAppConformer ? 'App' : 'Scene');
        if (isCliCommand && isParsableCommand) reasons.push('ParsableCommand');

        entryPoints.push(this.createEntryPoint(
          `entry_${typeId}`,
          typeId,
          isCliCommand ? 'cli' : 'lifecycle',
          isCliCommand ? `CLI command: ${type.name}` : `App entry point: ${type.name}`,
          isCliCommand
            ? (isParsableCommand
              ? 'Swift command-line entry point (swift-argument-parser @main command)'
              : 'Swift command-line entry point (@main process entry, no App/Scene conformance)')
            : `Swift application entry point (${reasons.join(', ')})`,
          undefined,
          undefined,
          {
            file: info.relativePath,
            line: type.lineStart,
            reasons,
            isMain: type.hasMainAttribute,
            isApp: type.isAppConformer,
          },
          { node_id: typeId, method_name: type.name, file: info.relativePath, line: type.lineStart }
        ));
      }

      // AppDelegate lifecycle: a class conforming to NSApplicationDelegate/
      // UIApplicationDelegate is the app's lifecycle hook whether or not it
      // carries @main — the common SwiftUI wiring is
      // @NSApplicationDelegateAdaptor/@UIApplicationDelegateAdaptor on a
      // separate App type, so this must be detected independently of the
      // hasMainAttribute/isAppConformer branch above.
      const delegateConformance = type.conformances.find(c => APP_DELEGATE_CONFORMANCES.has(c));
      if (delegateConformance) {
        entryPoints.push(this.createEntryPoint(
          `entry_${typeId}_appdelegate`,
          typeId,
          'lifecycle',
          `App delegate: ${type.name}`,
          `Swift application delegate (${delegateConformance} conformance)`,
          undefined,
          undefined,
          { file: info.relativePath, line: type.lineStart, reasons: [delegateConformance] },
          { node_id: typeId, method_name: type.name, file: info.relativePath, line: type.lineStart }
        ));
      }

      // SwiftUI Scene entries: each scene builder at the top level of an App
      // conformer's `var body: some Scene` is a distinct app surface
      // (window / menu-bar extra / Settings / document window / ...).
      if (type.isAppConformer && type.sceneEntries.length > 0) {
        for (const scene of type.sceneEntries) {
          entryPoints.push(this.createEntryPoint(
            `entry_${typeId}_scene_${scene.line}`,
            typeId,
            'lifecycle',
            `${scene.kind} scene: ${type.name}`,
            `SwiftUI ${scene.kind} scene declared in ${type.name}'s body: some Scene`,
            undefined,
            undefined,
            { file: info.relativePath, line: scene.line, reasons: ['Scene body'], scene_kind: scene.kind },
            { node_id: typeId, method_name: type.name, file: info.relativePath, line: scene.line }
          ));
        }
      }

      // URL scheme / deep-link handler: either the AppKit/UIKit
      // application(_:open:) delegate method, or the SwiftUI .onOpenURL
      // modifier — whichever is present. At most one entry per type; the
      // delegate method (more explicit evidence) wins if both are present.
      const deepLinkMethod = type.functions.find(fn => fn.isDeepLinkHandler);
      if (deepLinkMethod || type.onOpenURLLine !== undefined) {
        const line = deepLinkMethod ? deepLinkMethod.lineStart : type.onOpenURLLine!;
        const reason = deepLinkMethod ? 'application(_:open:)' : '.onOpenURL';
        const handlerName = deepLinkMethod ? deepLinkMethod.name : 'onOpenURL';
        const handlerNodeId = deepLinkMethod
          ? this.functionId(info.relativePath, type.name, deepLinkMethod.name, deepLinkMethod.lineStart)
          : typeId;
        entryPoints.push(this.createEntryPoint(
          `entry_${typeId}_deeplink`,
          handlerNodeId,
          'event',
          `URL open handler: ${type.name}`,
          `Swift deep-link / URL-scheme handler (${reason})`,
          undefined,
          undefined,
          { file: info.relativePath, line, reasons: [reason] },
          { node_id: handlerNodeId, method_name: handlerName, file: info.relativePath, line }
        ));
      }
    }

    // Free function nodes.
    for (const fn of info.freeFunctions) {
      const fnId = this.functionId(info.relativePath, '', fn.name, fn.lineStart);
      const fnNode = this.createNodeBuilder(fnId, fn.name, 'function')
        .withLevel(3, this.getLevelName(3))
        .withCategory('functions', ['swift-functions'])
        .withSource({ file: info.fullPath, line: fn.lineStart, end_line: fn.lineEnd })
        .withMetadata({
          language: 'swift',
          access_modifier: this.normalizeAccess(fn.access),
          attributes: { access: fn.access || 'internal', file: info.relativePath }
        })
        .build();
      fnNode.qualified_name = `${info.relativePath}:${fn.name}`;
      nodes.push(fnNode);

      edges.push(this.createEdge(
        `${fileId}_contains_${fnId}`,
        fileId,
        fnId,
        'contains'
      ));
    }

    // main.swift top-level entry point — the executable target's actual
    // process entry, so this is a CLI entry (not a generic lifecycle hook).
    if (info.hasTopLevelMain) {
      entryPoints.push(this.createEntryPoint(
        `entry_${fileId}_main`,
        fileId,
        'cli',
        `Top-level entry: ${baseName}`,
        'Swift main.swift top-level executable entry point',
        undefined,
        undefined,
        { file: info.relativePath, line: 1, reasons: ['main.swift'] }
      ));
    }
  }

  private emitConformanceEdges(
    fileInfos: SwiftFileInfo[],
    typeIndex: Map<string, { fileRel: string; type: SwiftType }>,
    edges: CASEdge[]
  ): void {
    const edgeIds = new Set(edges.map(e => e.id));
    for (const info of fileInfos) {
      for (const type of info.types) {
        // Resolve BOTH endpoints through the same canonicalization emitFileNodes
        // uses. `extension X: P` declares a conformance on a row that is not
        // itself a node — X's node lives at the canonical declaration's line —
        // so keying the source off `type.lineStart` names an id no collection
        // ever emitted and the edge dangles.
        const sourceId = this.canonicalTypeId(type, typeIndex);
        for (const conformance of type.conformances) {
          const target = typeIndex.get(conformance);
          if (!target) continue; // external / system protocol (e.g. View, App) — not a repo edge
          const targetId = this.canonicalTypeId(target.type, typeIndex);
          if (sourceId === targetId) continue;

          // protocol target -> 'implements'; class/struct/etc -> 'extends' (mirrors java/csharp).
          const edgeType = target.type.kind === 'protocol' ? 'implements' : 'extends';
          const edgeId = `${sourceId}_${edgeType}_${targetId}`;
          if (edgeIds.has(edgeId)) continue;
          edgeIds.add(edgeId);
          edges.push(this.createEdge(
            edgeId,
            sourceId,
            targetId,
            edgeType,
            'inheritance',
            { conformance, kind: target.type.kind }
          ));
        }
      }
    }
  }

  private emitCallEdges(
    info: SwiftFileInfo,
    content: string,
    functionIndex: Map<string, Array<{ fileRel: string; fn: SwiftFunction }>>,
    edges: CASEdge[]
  ): void {
    const edgeIds = new Set(edges.map(e => e.id));
    const lines = content.split('\n');

    // Build the list of all functions in this file with their ranges for caller resolution.
    const localFns: Array<{ fn: SwiftFunction; id: string }> = [];
    for (const fn of info.freeFunctions) {
      localFns.push({ fn, id: this.functionId(info.relativePath, '', fn.name, fn.lineStart) });
    }
    for (const type of info.types) {
      for (const fn of type.functions) {
        localFns.push({ fn, id: this.functionId(info.relativePath, type.name, fn.name, fn.lineStart) });
      }
    }

    const varTypeCache = new Map<SwiftFunction, Map<string, string>>();
    for (let i = 0; i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      if (!stripped.trim()) continue;
      const caller = this.enclosingFunction(localFns, i + 1);
      if (!caller) continue;

      // Find `name(` and `recv.name(` call expressions on this line.
      const calls = stripped.matchAll(/(?:([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
      for (const call of calls) {
        const receiver = call[1];
        const word = call[2];
        if (SWIFT_KEYWORDS.has(word)) continue;
        if (word === caller.fn.name) continue;
        const targets = functionIndex.get(word);
        if (!targets || targets.length === 0) continue;
        // 1) Receiver typed -> resolve to its class, pick the method on THAT class
        //    (excludes a same-name method on another class).
        let resolved: { fileRel: string; fn: SwiftFunction } | undefined;
        if (receiver && receiver !== 'self') {
          let vt = varTypeCache.get(caller.fn);
          if (!vt) { vt = this.buildSwiftVarTypes(content, caller.fn); varTypeCache.set(caller.fn, vt); }
          const recvType = vt.get(receiver);
          if (recvType) resolved = targets.find(t => t.fn.ownerName === recvType);
        }
        // 2) Same-file, then 3) cross-file unambiguous (existing conservative order).
        if (!resolved) resolved = targets.find(t => t.fileRel === info.relativePath);
        if (!resolved && targets.length === 1) resolved = targets[0];
        if (!resolved) continue;

        const targetOwner = resolved.fn.ownerName || '';
        const targetId = this.functionId(resolved.fileRel, targetOwner, resolved.fn.name, resolved.fn.lineStart);
        if (caller.id === targetId) continue;
        const edgeId = `call_${caller.id}_to_${targetId}_${i}`;
        if (edgeIds.has(edgeId)) continue;
        edgeIds.add(edgeId);
        edges.push(this.createEdge(
          edgeId,
          caller.id,
          targetId,
          'calls',
          'behavior',
          { line: i + 1, callType: 'function' }
        ));
      }
    }
  }

  /** Map a Swift function's local var names to their bare class types, from
   *  parameters (`name: Type`, incl. `label name: Type` / `_ name: Type`) and
   *  local declarations (`let x: Type`, `let x = Type(...)`). */
  private buildSwiftVarTypes(content: string, fn: SwiftFunction): Map<string, string> {
    const map = new Map<string, string>();
    const lines = content.split('\n');
    const text = lines.slice(fn.lineStart - 1, fn.lineEnd >= fn.lineStart ? fn.lineEnd : fn.lineStart).join('\n');
    const bare = (t: string) => t.replace(/<.*$/, '').replace(/[?!]/g, '').trim().split('.').pop() || t;
    const header = text.split('{')[0];
    const pm = header.match(/\(([^)]*)\)/);
    if (pm && pm[1].trim()) {
      for (const part of pm[1].split(',')) {
        // last `name: Type` pair in the parameter (handles `label name: Type`).
        const m = part.trim().match(/([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w.]*)\s*$/) || part.trim().match(/([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w.]*)/);
        if (m && /^[A-Z]/.test(bare(m[2]))) map.set(m[1], bare(m[2]));
      }
    }
    for (const m of text.matchAll(/\b(?:let|var)\s+(\w+)\s*:\s*([A-Z][\w.]*)/g)) map.set(m[1], bare(m[2]));
    for (const m of text.matchAll(/\b(?:let|var)\s+(\w+)\s*=\s*([A-Z][\w.]*)\s*\(/g)) map.set(m[1], bare(m[2]));
    return map;
  }

  private enclosingFunction(
    localFns: Array<{ fn: SwiftFunction; id: string }>,
    line: number
  ): { fn: SwiftFunction; id: string } | undefined {
    let innermost: { fn: SwiftFunction; id: string } | undefined;
    for (const entry of localFns) {
      if (entry.fn.lineStart <= line && entry.fn.lineEnd >= line) {
        if (!innermost || entry.fn.lineStart > innermost.fn.lineStart) innermost = entry;
      }
    }
    return innermost;
  }

  private normalizeAccess(access?: SwiftAccess): 'public' | 'private' | 'protected' | undefined {
    if (!access) return undefined;
    if (access === 'open' || access === 'public') return 'public';
    if (access === 'private' || access === 'fileprivate') return 'private';
    return undefined; // internal has no direct CAS access_modifier mapping
  }

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private typeId(name: string, line: number): string {
    return `type_${this.sanitizeId(name)}_${line}`;
  }

  /**
   * The id of the node that actually REPRESENTS this type declaration. An
   * `extension X` is not a new type: emitFileNodes emits no node for it and
   * re-parents its members onto X's canonical declaration. So every id-bearing
   * reference to a type — the node itself and any edge endpoint naming it —
   * must resolve through this one helper, or a reference keyed off the
   * extension's own line names an id that exists in no collection.
   */
  private canonicalTypeId(
    type: SwiftType,
    typeIndex?: Map<string, { fileRel: string; type: SwiftType }>
  ): string {
    const canonical = typeIndex?.get(type.name);
    if (!canonical || canonical.type === type) return this.typeId(type.name, type.lineStart);
    return this.typeId(canonical.type.name, canonical.type.lineStart);
  }

  private functionId(relativePath: string, owner: string, name: string, line: number): string {
    return `func_${this.sanitizeId(relativePath)}_${this.sanitizeId(owner)}_${this.sanitizeId(name)}_${line}`;
  }

  private propertyId(relativePath: string, ownerName: string, fieldName: string): string {
    return `property_${this.sanitizeId(relativePath)}_${this.sanitizeId(ownerName)}_${this.sanitizeId(fieldName)}`;
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'File/Module';
      case 2: return 'Type';
      case 3: return 'Function';
      case 4: return 'Method/Member';
      case 5: return 'Implementation';
      default: return `level_${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return [
      'swift-types',
      'swift-functions',
      'swiftui-views',
      'swift-conformance',
      'swift-imports',
      'swift-call-graph',
      'swift-entry-points',
      'swift-data-entities',
    ];
  }
}

export default { SwiftAnalyzer };
