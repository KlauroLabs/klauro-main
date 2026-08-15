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

  ownerName?: string;



  isDeepLinkHandler?: boolean;
}




interface SwiftSceneEntry {
  kind: string;
  line: number;
}




interface SwiftStoredProperty {
  name: string;
  type: string;

  annotations: string[];
  line: number;
}

interface SwiftType {
  name: string;
  kind: SwiftTypeKind;
  access?: SwiftAccess;

  conformances: string[];
  isSwiftUIView: boolean;
  isAppConformer: boolean;
  hasMainAttribute: boolean;
  lineStart: number;
  lineEnd: number;
  functions: SwiftFunction[];




  storedProperties: SwiftStoredProperty[];



  hasCodingKeysEnum: boolean;


  sceneEntries: SwiftSceneEntry[];



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

  freeFunctions: SwiftFunction[];
  imports: SwiftImport[];
  hasTopLevelMain: boolean;
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

const SWIFT_KEYWORDS = new Set([
  'if', 'else', 'guard', 'switch', 'case', 'default', 'for', 'while', 'repeat',
  'do', 'catch', 'try', 'throw', 'throws', 'return', 'break', 'continue', 'in',
  'let', 'var', 'func', 'init', 'deinit', 'self', 'super', 'nil', 'true', 'false',
  'where', 'as', 'is', 'async', 'await', 'defer', 'fallthrough', 'some', 'any',
  'print', 'and', 'or', 'not',
]);




const CLI_COMMAND_CONFORMANCES = new Set(['ParsableCommand', 'AsyncParsableCommand']);



const APP_LIFECYCLE_CONFORMANCES = new Set(['App', 'Scene']);




const NON_ENTITY_CONFORMANCES = new Set(['Scene', 'Error', 'ParsableCommand', 'AsyncParsableCommand']);





const APP_DELEGATE_CONFORMANCES = new Set(['NSApplicationDelegate', 'UIApplicationDelegate']);




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
    this.applyTestFileBoundary(nodes);

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
      this.applyTestFileBoundary(nodes);

      const warnings = this.collectAnalysisWarnings();



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


      if (/^@main\b/.test(trimmed)) {
        pendingMainAttr = true;

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
        i = lineEnd - 1;
        continue;
      }


      if (pendingMainAttr && !/^@main\b/.test(trimmed)) {
        pendingMainAttr = false;
      }


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

        imports.push({ module: match[1].split('.')[0], lineNumber: i + 1 });
      }
    }
    return imports;
  }

  private matchTypeDeclaration(trimmed: string): { name: string; kind: SwiftTypeKind; access?: SwiftAccess; conformances: string[] } | undefined {

    let working = trimmed.replace(/^(@[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?\s+)+/, '');

    const access = this.leadingAccess(working);

    const modifierStripped = working.replace(/^((open|public|internal|fileprivate|private|final|static|indirect|@[A-Za-z_]+(\([^)]*\))?)\s+)+/, '');

    const keywordMatch = modifierStripped.match(/^(class|struct|enum|protocol|actor|extension)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!keywordMatch) return undefined;

    const kind = TYPE_KEYWORDS[keywordMatch[1]];
    const name = keywordMatch[2];


    const conformances = this.extractConformances(modifierStripped, name);

    return { name, kind, access, conformances };
  }

  private extractConformances(declLine: string, typeName: string): string[] {

    const afterName = declLine.slice(declLine.indexOf(typeName) + typeName.length);

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

      .map(part => part.replace(/<.*$/, '').split('.').pop() || part)
      .filter(part => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part));
  }


  private extractMembersAtBodyLevel(lines: string[], start: number, end: number, ownerName: string): SwiftFunction[] {
    const functions: SwiftFunction[] = [];
    let depth = 0;
    let bodyEntered = false;
    for (let i = start - 1; i < end && i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      const trimmed = stripped.trim();


      if (bodyEntered && depth === 1 && trimmed) {
        const fn = this.matchFunctionDeclaration(trimmed);
        if (fn) {
          const lineEnd = this.findBlockEnd(lines, i);




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





  private findOnOpenURLLine(lines: string[], start: number, end: number): number | undefined {
    for (let i = start - 1; i < end && i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      if (/\.onOpenURL\s*\{/.test(stripped)) return i + 1;
    }
    return undefined;
  }







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
    if (terminator === '{') return undefined;

    const type = declMatch[2].trim();
    if (!type) return undefined;

    return { name: declMatch[1], type: type.replace(/\s+/g, ' '), annotations };
  }







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

    let working = trimmed.replace(/^(@[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?\s+)+/, '');
    const access = this.leadingAccess(working);
    const isStatic = /(^|\s)(static|class)\s+func\b/.test(working);


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





      if (!seenOpen && i > startIndex) {
        const t = stripped.trim();
        if (t.startsWith('}')) return i;
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
      if (name === 'init') return;
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




      const canonical = typeIndex?.get(type.name);
      const isCanonical = !canonical || canonical.type === type;
      const typeId = this.canonicalTypeId(type, typeIndex);

      if (!isCanonical) {

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





        const sourceId = this.canonicalTypeId(type, typeIndex);
        for (const conformance of type.conformances) {
          const target = typeIndex.get(conformance);
          if (!target) continue;
          const targetId = this.canonicalTypeId(target.type, typeIndex);
          if (sourceId === targetId) continue;


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


      const calls = stripped.matchAll(/(?:([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
      for (const call of calls) {
        const receiver = call[1];
        const word = call[2];
        if (SWIFT_KEYWORDS.has(word)) continue;
        if (word === caller.fn.name) continue;
        const targets = functionIndex.get(word);
        if (!targets || targets.length === 0) continue;


        let resolved: { fileRel: string; fn: SwiftFunction } | undefined;
        if (receiver && receiver !== 'self') {
          let vt = varTypeCache.get(caller.fn);
          if (!vt) { vt = this.buildSwiftVarTypes(content, caller.fn); varTypeCache.set(caller.fn, vt); }
          const recvType = vt.get(receiver);
          if (recvType) resolved = targets.find(t => t.fn.ownerName === recvType);
        }

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




  private buildSwiftVarTypes(content: string, fn: SwiftFunction): Map<string, string> {
    const map = new Map<string, string>();
    const lines = content.split('\n');
    const text = lines.slice(fn.lineStart - 1, fn.lineEnd >= fn.lineStart ? fn.lineEnd : fn.lineStart).join('\n');
    const bare = (t: string) => t.replace(/<.*$/, '').replace(/[?!]/g, '').trim().split('.').pop() || t;
    const header = text.split('{')[0];
    const pm = header.match(/\(([^)]*)\)/);
    if (pm && pm[1].trim()) {
      for (const part of pm[1].split(',')) {

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
    return undefined;
  }

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private typeId(name: string, line: number): string {
    return `type_${this.sanitizeId(name)}_${line}`;
  }









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













  private applyTestFileBoundary(nodes: CASNode[]): void {
    for (const node of nodes) {
      const file = node.source?.file;
      if (!file || !this.isSwiftTestPath(file)) continue;
      node.metadata = { ...node.metadata, is_test: true };
      node.category = 'test';
      node.subcategories = [...new Set([...(node.subcategories || []), node.type, 'test-code'])];
      node.tags = [...new Set([...(node.tags || []), 'test-code'])];
    }
  }

  private isSwiftTestPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const basename = normalized.split('/').pop() || normalized;
    return /(?:^|\/)Tests\//i.test(normalized) ||
      /Tests\.swift$/i.test(basename);
  }
}

export default { SwiftAnalyzer };
