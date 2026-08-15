import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { parseWasm, hasWasmGrammar } from '../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';

type KotlinTypeKind =
  | 'class'
  | 'data-class'
  | 'sealed-class'
  | 'object'
  | 'interface'
  | 'enum-class'
  | 'annotation-class'
  | 'abstract-class';

interface KotlinDataField {
  name: string;
  type: string;
  annotations: string[];
  line: number;
}

interface KotlinType {
  name: string;
  kind: KotlinTypeKind;
  visibility: string;
  supertypes: string[];
  annotations: string[];
  lineStart: number;
  lineEnd: number;


  dataFields?: KotlinDataField[];
}

interface KotlinFunction {
  name: string;
  visibility: string;
  isSuspend: boolean;
  isComposable: boolean;
  isTopLevel: boolean;
  receiver?: string;
  ownerType?: string;
  lineStart: number;
  lineEnd: number;
}

interface KotlinImport {
  importPath: string;
  simpleName: string;
  lineNumber: number;
}






interface KotlinNavDestination {
  route: string;
  kind: 'composable' | 'dialog' | 'navigation';
  line: number;
}

interface KotlinFileInfo {
  relativePath: string;
  fullPath: string;
  packageName: string;
  types: KotlinType[];
  functions: KotlinFunction[];
  imports: KotlinImport[];
  lineCount: number;
  navDestinations: KotlinNavDestination[];
}

const KOTLIN_GLOBS = ['**/*.kt', '**/*.kts'];

const KOTLIN_CALL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'when', 'return', 'throw', 'try', 'catch',
  'finally', 'is', 'as', 'in', 'val', 'var', 'fun', 'class', 'object', 'super',
  'this', 'init', 'by', 'where', 'print', 'println', 'require', 'check', 'TODO',
  'listOf', 'mapOf', 'setOf', 'arrayOf', 'mutableListOf', 'mutableMapOf',
  'let', 'run', 'apply', 'also', 'with', 'lazy', 'emptyList', 'emptyMap',
]);
const ANDROID_ACTIVITY_BASES = new Set([
  'ComponentActivity', 'AppCompatActivity', 'Activity', 'FragmentActivity',
]);







const ANDROID_APPLICATION_BASES = new Set(['Application']);
const ANDROID_SERVICE_BASES = new Set(['Service', 'IntentService', 'LifecycleService']);
const ANDROID_RECEIVER_BASES = new Set(['BroadcastReceiver']);
const ANDROID_PROVIDER_BASES = new Set(['ContentProvider']);



const ANDROID_WORKER_BASES = new Set(['Worker', 'CoroutineWorker', 'ListenableWorker', 'RxWorker']);
const ANDROID_MANIFEST_GLOB = ['**/AndroidManifest.xml'];






const MANIFEST_COMPONENT_ENTRY_TYPES: Record<string, CASEntryPoint['type']> = {
  activity: 'page',
  service: 'lifecycle',
  receiver: 'event',
  provider: 'api',
};




const COMPOSE_THEME_ONLY_TYPES = new Set([
  'Color', 'Dp', 'TextUnit', 'Shape', 'FontFamily', 'Painter', 'ImageVector',
  'Brush', 'PaddingValues', 'Modifier', 'TextStyle', 'Typography',
]);

export class KotlinAnalyzer extends BaseAnalyzer {




  private readonly manifestParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });

  constructor() {
    super('kotlin', 'Kotlin Language Analyzer', '1.0.0', 'language');
  }





  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await glob(KOTLIN_GLOBS, {
        cwd: projectPath,
        ignore: this.getPackageDirSafeIgnorePatterns({ projectPath }),
        nodir: true,
      });
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(KOTLIN_GLOBS, {
      cwd: projectPath,
      ignore: this.getPackageDirSafeIgnorePatterns({ projectPath }),
      nodir: true,
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

    const info = this.parseKotlinFile(context.relativePath, context.filePath, content);
    const fileInfos = [info];
    this.emitFileNodes(info, nodes, edges, entryPoints);
    this.emitInheritanceEdges(fileInfos, nodes, edges);
    await this.emitCallEdges(fileInfos, nodes, edges);
    this.applyTestFileBoundary(nodes);

    const imports = info.imports.map(i => i.importPath);
    const exports = [
      ...info.types.map(t => t.name),
      ...info.functions.map(f => f.name),
    ];

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
      let kotlinFiles = await glob(KOTLIN_GLOBS, {
        cwd: context.projectPath,
        ignore: this.getPackageDirSafeIgnorePatterns(context),
        nodir: true,
      });
      kotlinFiles.sort();
      kotlinFiles = this.capAndPrioritizeSourceFiles(kotlinFiles, 'kotlin files');

      const fileInfos: KotlinFileInfo[] = [];
      for (const relativePath of kotlinFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        fileInfos.push(this.parseKotlinFile(relativePath, fullPath, content));
      }

      for (const info of fileInfos) {
        this.emitFileNodes(info, nodes, edges, entryPoints);
      }

      this.emitInheritanceEdges(fileInfos, nodes, edges);
      this.emitImportEdges(fileInfos, nodes, edges, exitPoints);
      await this.emitCallEdges(fileInfos, nodes, edges);
      await this.emitManifestEntryPoints(context, fileInfos, entryPoints);
      this.applyTestFileBoundary(nodes);

      const warnings = this.collectAnalysisWarnings();
      const composeCount = nodes.filter(n => n.tags?.includes('compose-fn')).length;
      const suspendCount = nodes.filter(n => n.tags?.includes('suspend')).length;
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'kotlin',
          filesAnalyzed: fileInfos.length,



          typesFound: nodes.filter(n => n.type === 'class' || n.type === 'interface' || n.type === 'dto').length,
          functionsFound: nodes.filter(n => n.type === 'function' || n.type === 'method').length,
          composeFunctions: composeCount,
          suspendFunctions: suspendCount,
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `Kotlin analysis failed: ${(error as Error).message}`,
        'KOTLIN_ANALYSIS_ERROR'
      );
    }
  }





  private parseKotlinFile(relativePath: string, fullPath: string, content: string): KotlinFileInfo {
    const lines = content.split('\n');
    const packageName = this.extractPackage(lines);
    const imports = this.extractImports(lines);
    const types = this.extractTypes(lines);
    const functions = this.extractFunctions(lines, types);
    const navDestinations = this.extractNavHostDestinations(lines);

    return {
      relativePath,
      fullPath,
      packageName,
      types,
      functions,
      imports,
      lineCount: lines.length,
      navDestinations,
    };
  }

  private extractPackage(lines: string[]): string {
    for (const raw of lines) {
      const line = raw.trim();
      const match = line.match(/^package\s+([A-Za-z0-9_.]+)/);
      if (match) return match[1];
      if (line && !line.startsWith('//') && !line.startsWith('@') && !line.startsWith('/*')) {

        if (line.startsWith('import')) return '';
      }
    }
    return '';
  }

  private extractImports(lines: string[]): KotlinImport[] {
    const imports: KotlinImport[] = [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].trim().match(/^import\s+([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z0-9_]+))?/);
      if (match) {
        const importPath = match[1];
        const alias = match[2];
        const simpleName = alias || importPath.split('.').pop() || importPath;
        imports.push({ importPath, simpleName, lineNumber: i + 1 });
      }
    }
    return imports;
  }

  private extractTypes(lines: string[]): KotlinType[] {
    const types: KotlinType[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      const decl = this.matchTypeDeclaration(trimmed);
      if (!decl) continue;


      if (decl.kind === 'object' && /\bcompanion\s+object\b/.test(trimmed)) continue;

      const annotations = this.collectPrecedingAnnotations(lines, i);
      const lineEnd = this.findBlockEnd(lines, i);
      const supertypes = this.extractSupertypes(lines, i, lineEnd);
      const dataFields = decl.kind === 'data-class'
        ? this.extractDataClassFields(lines, i)
        : undefined;

      types.push({
        name: decl.name,
        kind: decl.kind,
        visibility: this.extractVisibility(trimmed),
        supertypes,
        annotations,
        lineStart: i + 1,
        lineEnd,
        dataFields,
      });
    }
    return types;
  }

  private matchTypeDeclaration(trimmed: string): { name: string; kind: KotlinTypeKind } | undefined {


    const enumMatch = trimmed.match(/\benum\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (enumMatch) return { name: enumMatch[1], kind: 'enum-class' };

    const dataMatch = trimmed.match(/\bdata\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (dataMatch) return { name: dataMatch[1], kind: 'data-class' };

    const sealedMatch = trimmed.match(/\bsealed\s+(?:class|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (sealedMatch) return { name: sealedMatch[1], kind: 'sealed-class' };

    const annotationMatch = trimmed.match(/\bannotation\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (annotationMatch) return { name: annotationMatch[1], kind: 'annotation-class' };

    const abstractMatch = trimmed.match(/\babstract\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (abstractMatch) return { name: abstractMatch[1], kind: 'abstract-class' };

    const ifaceMatch = trimmed.match(/(?:^|\s)interface\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (ifaceMatch) return { name: ifaceMatch[1], kind: 'interface' };

    const objectMatch = trimmed.match(/(?:^|\s)object\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (objectMatch) return { name: objectMatch[1], kind: 'object' };

    const classMatch = trimmed.match(/(?:^|\s)class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch) return { name: classMatch[1], kind: 'class' };

    return undefined;
  }



  private extractSupertypes(lines: string[], startIndex: number, blockEnd: number): string[] {
    let header = '';
    for (let i = startIndex; i < lines.length && i < blockEnd; i++) {
      header += ' ' + lines[i];
      if (lines[i].includes('{')) break;

      if (i > startIndex + 8) break;
    }
    header = header.split('{')[0];

    const colonIndex = this.findSupertypeColon(header);
    if (colonIndex === -1) return [];

    const supertypeSection = header.slice(colonIndex + 1);
    return this.parseSupertypeList(supertypeSection);
  }



  private findSupertypeColon(header: string): number {
    let depthParen = 0;
    let depthAngle = 0;
    for (let i = 0; i < header.length; i++) {
      const ch = header[i];
      if (ch === '(') depthParen++;
      else if (ch === ')') depthParen--;
      else if (ch === '<') depthAngle++;
      else if (ch === '>') depthAngle--;
      else if (ch === ':' && depthParen === 0 && depthAngle === 0) return i;
    }
    return -1;
  }

  private parseSupertypeList(section: string): string[] {
    const names: string[] = [];
    const parts = this.splitTopLevel(section, ',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      if (/^where\b/.test(trimmed)) continue;
      const nameMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
      if (!nameMatch) continue;

      const name = nameMatch[1].split('.').pop()!;
      names.push(name);
    }
    return names;
  }


  private splitTopLevel(text: string, sep: string): string[] {
    const out: string[] = [];
    let depthParen = 0;
    let depthAngle = 0;
    let current = '';
    for (const ch of text) {
      if (ch === '(') depthParen++;
      else if (ch === ')') depthParen--;
      else if (ch === '<') depthAngle++;
      else if (ch === '>') depthAngle--;
      if (ch === sep && depthParen === 0 && depthAngle === 0) {
        out.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current) out.push(current);
    return out;
  }







  private extractDataClassFields(lines: string[], startIndex: number): KotlinDataField[] {






    const windowEnd = Math.min(lines.length, startIndex + 80);
    const lineStartOffsets: number[] = [];
    let joined = '';
    for (let i = startIndex; i < windowEnd; i++) {
      lineStartOffsets.push(joined.length);
      joined += this.stripStringsAndComments(lines[i]) + '\n';
    }
    const lineForOffset = (offset: number): number => {
      let line = startIndex;
      for (let i = 0; i < lineStartOffsets.length; i++) {
        if (lineStartOffsets[i] <= offset) line = startIndex + i;
        else break;
      }
      return line + 1;
    };

    const openIdx = joined.indexOf('(');
    if (openIdx === -1) return [];

    let depth = 0;
    let endIdx = -1;
    for (let c = openIdx; c < joined.length; c++) {
      if (joined[c] === '(') depth++;
      else if (joined[c] === ')') {
        depth--;
        if (depth === 0) { endIdx = c; break; }
      }
    }
    if (endIdx === -1) return [];

    const paramsSection = joined.slice(openIdx + 1, endIdx);
    const fields: KotlinDataField[] = [];
    let searchCursor = 0;
    for (const rawPart of this.splitTopLevel(paramsSection, ',')) {
      const partStartInSection = searchCursor;
      searchCursor += rawPart.length + 1;
      const part = rawPart.trim();
      if (!part) continue;

      const annotations = [...part.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
      const withoutAnnotations = part.replace(/@[A-Za-z_][A-Za-z0-9_]*(\([^)]*\))?/g, '').trim();
      if (!withoutAnnotations) continue;




      const declPart = this.splitTopLevel(withoutAnnotations, '=')[0]?.trim();
      if (!declPart) continue;

      const declMatch = declPart.match(
        /^(?:private\s+|protected\s+|internal\s+|public\s+|override\s+|crossinline\s+|noinline\s+|vararg\s+)*(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/
      );
      if (!declMatch) continue;

      const nameOffsetInPart = part.indexOf(declMatch[1]);
      const absoluteOffset = openIdx + 1 + partStartInSection + Math.max(0, nameOffsetInPart);

      fields.push({
        name: declMatch[1],
        type: declMatch[2].trim().replace(/\s+/g, ' '),
        annotations,
        line: lineForOffset(absoluteOffset),
      });
    }
    return fields;
  }






  private isEntityShapedDataClass(info: KotlinFileInfo, fields: KotlinDataField[]): boolean {
    if (fields.length < 2) return false;

    const pkg = info.packageName.toLowerCase();
    const file = info.relativePath.toLowerCase().replace(/\\/g, '/');
    if (/(^|\.)ui\.theme(\.|$)/.test(pkg) || /(^|\/)ui\/theme(\/|$)/.test(file)) return false;

    const bareType = (t: string) => t.replace(/[?]/g, '').replace(/<.*$/, '').trim().split('.').pop() || t;
    if (fields.every(f => COMPOSE_THEME_ONLY_TYPES.has(bareType(f.type)))) return false;

    return true;
  }

  private extractFunctions(lines: string[], types: KotlinType[]): KotlinFunction[] {
    const functions: KotlinFunction[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;


      const match = trimmed.match(
        /\bfun\b(?:\s*<[^>]*>)?\s+(?:([A-Za-z_][A-Za-z0-9_.]*)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/
      );
      if (!match) continue;

      const receiverRaw = match[1];
      const name = match[2];
      const receiver = receiverRaw ? receiverRaw.split('.').pop() : undefined;
      const annotations = this.collectPrecedingAnnotations(lines, i);
      const owner = this.enclosingType(types, i + 1);

      functions.push({
        name,
        visibility: this.extractVisibility(trimmed),
        isSuspend: /\bsuspend\b/.test(trimmed),
        isComposable: annotations.includes('Composable'),
        isTopLevel: !owner,
        receiver,
        ownerType: owner?.name,
        lineStart: i + 1,
        lineEnd: this.findBlockEnd(lines, i),
      });
    }
    return functions;
  }

  private extractVisibility(line: string): string {
    if (/\bprivate\b/.test(line)) return 'private';
    if (/\binternal\b/.test(line)) return 'internal';
    if (/\bprotected\b/.test(line)) return 'protected';
    return 'public';
  }

  private collectPrecedingAnnotations(lines: string[], lineIndex: number): string[] {
    const annotations: string[] = [];

    const ownLine = lines[lineIndex];
    for (const m of ownLine.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)) annotations.push(m[1]);

    for (let i = lineIndex - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) continue;
      if (t.startsWith('@')) {
        for (const m of t.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)) annotations.push(m[1]);
      } else if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
        continue;
      } else {
        break;
      }
    }
    return Array.from(new Set(annotations));
  }

  private enclosingType(types: KotlinType[], line: number): KotlinType | undefined {
    let innermost: KotlinType | undefined;
    for (const t of types) {
      if (t.lineStart < line && t.lineEnd >= line) {
        if (!innermost || t.lineStart > innermost.lineStart) innermost = t;
      }
    }
    return innermost;
  }


  private findBlockEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    let seenOpen = false;
    for (let i = startIndex; i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      for (const ch of stripped) {
        if (ch === '{') {
          depth++;
          seenOpen = true;
        } else if (ch === '}') {
          depth--;
          if (seenOpen && depth <= 0) return i + 1;
        }
      }

      if (!seenOpen && (stripped.includes(';') || (i > startIndex && stripped.trim() === ''))) {
        return i + 1;
      }
      if (!seenOpen && i === startIndex && !stripped.includes('{') && stripped.includes('=')) {
        return i + 1;
      }
    }
    return seenOpen ? lines.length : startIndex + 1;
  }

  private stripStringsAndComments(line: string): string {
    let result = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (!inSingle && !inDouble && ch === '/' && next === '/') break;
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (!inSingle && !inDouble) result += ch;
    }
    return result;
  }




  private removeTrailingLineComment(line: string): string {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (!inSingle && !inDouble && ch === '/' && next === '/') return line.slice(0, i);
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
    }
    return line;
  }







  private extractNavHostDestinations(lines: string[]): KotlinNavDestination[] {
    const destinations: KotlinNavDestination[] = [];
    const destRegex = /\b(composable|dialog)\s*\(\s*(?:route\s*=\s*)?"([^"]+)"/;



    const navGraphRegex = /\bnavigation\s*\(/;
    const navGraphRouteRegex = /\broute\s*=\s*"([^"]+)"/;

    for (let i = 0; i < lines.length; i++) {
      const header = this.removeTrailingLineComment(lines[i]);
      if (!/\bNavHost\s*\(/.test(header)) continue;

      const blockEnd = this.findBlockEnd(lines, i);
      for (let j = i; j < blockEnd && j < lines.length; j++) {
        const text = this.removeTrailingLineComment(lines[j]);

        const destMatch = text.match(destRegex);
        if (destMatch) {
          destinations.push({
            route: destMatch[2],
            kind: destMatch[1] as 'composable' | 'dialog',
            line: j + 1,
          });
          continue;
        }

        if (navGraphRegex.test(text)) {



          const windowEnd = Math.min(blockEnd, j + 6);
          for (let k = j; k < windowEnd; k++) {
            const routeMatch = this.removeTrailingLineComment(lines[k]).match(navGraphRouteRegex);
            if (routeMatch) {
              destinations.push({ route: routeMatch[1], kind: 'navigation', line: j + 1 });
              break;
            }
            if (lines[k].includes('{')) break;
          }
        }
      }



      i = Math.max(i, blockEnd - 1);
    }
    return destinations;
  }





  private emitFileNodes(
    info: KotlinFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const fileId = this.fileId(info.relativePath);
    const baseName = info.relativePath.split('/').pop() || 'unknown.kt';

    nodes.push(this.createNodeBuilder(fileId, baseName, 'file')
      .withLevel(1, 'File/Module')
      .withCategory('modules', ['kotlin-files'])
      .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
      .withMetadata({
        language: 'kotlin',
        attributes: {
          packageName: info.packageName || 'default',
          imports: info.imports.map(i => i.importPath),
          typeCount: info.types.length,
          functionCount: info.functions.length,
          extension: path.extname(baseName) || '.kt',
        },
      })
      .build());


    for (const type of info.types) {
      const typeId = this.typeId(info.relativePath, type.name);
      const dataFields = type.dataFields || [];






      const isDataEntity = type.kind === 'data-class' && this.isEntityShapedDataClass(info, dataFields);
      const nodeType = isDataEntity ? 'dto' : (type.kind === 'interface' ? 'interface' : 'class');
      const node = this.createNodeBuilder(typeId, type.name, nodeType)
        .withLevel(2, 'Class/Interface')
        .withCategory('structures', ['kotlin-types'])
        .withSource({ file: info.fullPath, line: type.lineStart, end_line: type.lineEnd })
        .withMetadata({
          language: 'kotlin',
          access_modifier: this.accessModifier(type.visibility),
          annotations: type.annotations,
          attributes: {
            kind: type.kind,
            packageName: info.packageName,
            supertypes: type.supertypes,
            visibility: type.visibility,
            ...(type.kind === 'data-class' ? { propertyCount: dataFields.length, methodCount: 0 } : {}),
          },
        })
        .withTags([`kotlin-kind:${type.kind}`, ...(isDataEntity ? ['kotlin-data-entity'] : [])])
        .build();
      node.qualified_name = info.packageName ? `${info.packageName}.${type.name}` : type.name;
      nodes.push(node);

      edges.push(this.createEdge(`${fileId}_contains_${typeId}`, fileId, typeId, 'contains'));


      const activityBase = type.supertypes.find(s => ANDROID_ACTIVITY_BASES.has(s));
      if (activityBase) {
        entryPoints.push(this.createEntryPoint(
          `entry_${typeId}`,
          typeId,
          'page',
          `Android Activity: ${type.name}`,
          `Android entry-point Activity (extends ${activityBase})`,
          { pattern: type.name },
          undefined,
          { file: info.relativePath, line: type.lineStart, base: activityBase, language: 'kotlin' },
          { node_id: typeId, method_name: type.name, file: info.relativePath, line: type.lineStart }
        ));
      }








      const structuralBases: Array<{ bases: Set<string>; type: CASEntryPoint['type']; label: string }> = [
        { bases: ANDROID_APPLICATION_BASES, type: 'lifecycle', label: 'Application' },
        { bases: ANDROID_SERVICE_BASES, type: 'lifecycle', label: 'Service' },
        { bases: ANDROID_RECEIVER_BASES, type: 'event', label: 'BroadcastReceiver' },
        { bases: ANDROID_PROVIDER_BASES, type: 'api', label: 'ContentProvider' },
        { bases: ANDROID_WORKER_BASES, type: 'schedule', label: 'WorkManager Worker' },
      ];
      for (const { bases, type: epType, label } of structuralBases) {
        const base = type.supertypes.find(s => bases.has(s));
        if (!base) continue;
        entryPoints.push(this.createEntryPoint(
          `entry_${typeId}`,
          typeId,
          epType,
          `Android ${label}: ${type.name}`,
          `Android ${label} (extends ${base})`,
          { pattern: type.name },
          undefined,
          { file: info.relativePath, line: type.lineStart, base, language: 'kotlin' },
          { node_id: typeId, method_name: type.name, file: info.relativePath, line: type.lineStart }
        ));
        break;
      }







      if (isDataEntity) {
        for (const field of dataFields) {
          const propertyId = this.propertyId(info.relativePath, type.name, field.name);
          const serializationAnnotations = field.annotations.filter(a =>
            a === 'SerialName' || a === 'SerializedName' || a === 'Serializable'
          );
          const propertyNode = this.createNodeBuilder(propertyId, field.name, 'property')
            .withLevel(3, 'Field/Property')
            .withCategory('structures', ['kotlin-fields'])
            .withSource({ file: info.fullPath, line: field.line, end_line: field.line })
            .withMetadata({
              language: 'kotlin',
              attributes: {
                type: field.type,
                ownerType: type.name,
                ...(field.annotations.length > 0 ? { annotations: field.annotations } : {}),
                ...(serializationAnnotations.length > 0 ? { serialization: serializationAnnotations } : {}),
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
    }


    for (const fn of info.functions) {
      const ownerId = fn.ownerType ? this.typeId(info.relativePath, fn.ownerType) : undefined;
      const functionId = this.functionId(info.relativePath, fn.name, fn.lineStart);
      const nodeType = ownerId ? 'method' : 'function';
      const tags: string[] = [];
      if (fn.isSuspend) tags.push('suspend');
      if (fn.isComposable) tags.push('compose-fn');

      const builder = this.createNodeBuilder(functionId, fn.name, nodeType)
        .withLevel(ownerId ? 4 : 3, ownerId ? 'Method/Function' : 'Function')
        .withCategory('functions', [ownerId ? 'kotlin-methods' : 'kotlin-functions'])
        .withSource({ file: info.fullPath, line: fn.lineStart, end_line: fn.lineEnd })
        .withMetadata({
          language: 'kotlin',
          access_modifier: this.accessModifier(fn.visibility),
          is_async: fn.isSuspend,
          attributes: {
            visibility: fn.visibility,
            suspend: fn.isSuspend,
            composable: fn.isComposable,
            isTopLevel: fn.isTopLevel,
            receiver: fn.receiver,
            ownerType: fn.ownerType,
            file: info.relativePath,
          },
        });
      if (tags.length > 0) builder.withTags(tags);
      if (ownerId) builder.withParent(ownerId);
      const node = builder.build();
      node.qualified_name = fn.ownerType
        ? `${info.relativePath}:${fn.ownerType}.${fn.name}`
        : `${info.relativePath}:${fn.name}`;
      nodes.push(node);

      const containerId = ownerId || fileId;
      edges.push(this.createEdge(
        `${containerId}_contains_${functionId}`,
        containerId,
        functionId,
        'contains'
      ));


      if (fn.name === 'main' && fn.isTopLevel) {
        entryPoints.push(this.createEntryPoint(
          `entry_${functionId}`,
          functionId,
          'cli',
          `main: ${baseName}`,
          'Kotlin application entry point (fun main)',
          undefined,
          undefined,
          { file: info.relativePath, line: fn.lineStart, language: 'kotlin' },
          { node_id: functionId, method_name: fn.name, file: info.relativePath, line: fn.lineStart }
        ));
      } else if (fn.name === 'module' && fn.receiver === 'Application') {
        entryPoints.push(this.createEntryPoint(
          `entry_${functionId}`,
          functionId,


          'lifecycle',
          `Ktor module: ${baseName}`,
          'Ktor application module (fun Application.module)',
          undefined,
          undefined,
          { file: info.relativePath, line: fn.lineStart, framework: 'ktor', language: 'kotlin' },
          { node_id: functionId, method_name: fn.name, file: info.relativePath, line: fn.lineStart }
        ));
      }
    }






    for (const dest of info.navDestinations) {
      const destId = `navdest_${this.sanitizeId(info.relativePath)}_${this.sanitizeId(dest.route)}_${dest.line}`;
      entryPoints.push(this.createEntryPoint(
        `entry_${destId}`,
        fileId,
        'route',
        `Compose destination: ${dest.route}`,
        `Compose Navigation ${dest.kind === 'navigation' ? 'nested graph' : 'destination'} registered via ${dest.kind}("${dest.route}") inside NavHost`,
        { pattern: dest.route },
        undefined,
        { file: info.relativePath, line: dest.line, route: dest.route, kind: dest.kind, framework: 'compose-navigation', language: 'kotlin' },
        { node_id: fileId, method_name: dest.route, file: info.relativePath, line: dest.line }
      ));
    }
  }

  private emitInheritanceEdges(
    fileInfos: KotlinFileInfo[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {

    const typeIdByName = new Map<string, string>();
    for (const info of fileInfos) {
      for (const type of info.types) {
        typeIdByName.set(type.name, this.typeId(info.relativePath, type.name));
      }
    }

    const edgeIds = new Set(edges.map(e => e.id));
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    for (const info of fileInfos) {
      for (const type of info.types) {
        const sourceId = this.typeId(info.relativePath, type.name);
        for (const supertype of type.supertypes) {
          const targetId = typeIdByName.get(supertype);
          if (!targetId || targetId === sourceId) continue;
          const targetNode = nodeById.get(targetId);
          const edgeType = targetNode?.type === 'interface' ? 'implements' : 'extends';
          const edgeId = `${sourceId}_${edgeType}_${targetId}`;
          if (edgeIds.has(edgeId)) continue;
          edgeIds.add(edgeId);
          edges.push(this.createEdge(edgeId, sourceId, targetId, edgeType, 'structure', {
            attributes: { supertype, language: 'kotlin' },
          }));
        }
      }
    }
  }

  private emitImportEdges(
    fileInfos: KotlinFileInfo[],
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[]
  ): void {

    const typeIdByQualified = new Map<string, string>();
    const typeIdByName = new Map<string, string>();
    for (const info of fileInfos) {
      for (const type of info.types) {
        const id = this.typeId(info.relativePath, type.name);
        typeIdByName.set(type.name, id);
        if (info.packageName) typeIdByQualified.set(`${info.packageName}.${type.name}`, id);
      }
    }

    const edgeIds = new Set(edges.map(e => e.id));
    for (const info of fileInfos) {
      const fileId = this.fileId(info.relativePath);
      for (const imp of info.imports) {
        const resolved = typeIdByQualified.get(imp.importPath)
          || typeIdByName.get(imp.simpleName);
        if (resolved) {
          const edgeId = `${fileId}_imports_${resolved}_${imp.lineNumber}`;
          if (edgeIds.has(edgeId)) continue;
          edgeIds.add(edgeId);
          edges.push(this.createEdge(edgeId, fileId, resolved, 'imports', 'dependency', {
            attributes: { importPath: imp.importPath, language: 'kotlin' },
          }));
        } else if (!imp.importPath.startsWith(info.packageName + '.') || !info.packageName) {

          exitPoints.push(this.createExitPoint(
            `exit_${fileId}_${this.sanitizeId(imp.importPath)}`,
            fileId,
            'sdk',
            `External import: ${imp.importPath}`,
            `Kotlin import of ${imp.importPath}`,
            { resource: imp.importPath, sdk: imp.simpleName },
            undefined,
            { importPath: imp.importPath, line: imp.lineNumber, language: 'kotlin' }
          ));
        }
      }
    }
  }







  private toArray<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  }




  private resolveManifestClassName(rawName: string, manifestPackage: string): string {
    if (rawName.startsWith('.')) return manifestPackage ? `${manifestPackage}${rawName}` : rawName.slice(1);
    if (!rawName.includes('.')) return manifestPackage ? `${manifestPackage}.${rawName}` : rawName;
    return rawName;
  }














  private async emitManifestEntryPoints(
    context: AnalysisContext,
    fileInfos: KotlinFileInfo[],
    entryPoints: CASEntryPoint[]
  ): Promise<void> {
    let manifestFiles: string[] = [];
    try {
      manifestFiles = await glob(ANDROID_MANIFEST_GLOB, {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true,
      });
    } catch {
      return;
    }
    if (manifestFiles.length === 0) {









      const looksAndroid = fileInfos.some(info =>
        info.types.some(type => type.supertypes.some(base => ANDROID_ACTIVITY_BASES.has(base)))
      );
      if (looksAndroid) {
        this.addAnalysisWarning(
          'Kotlin: this looks like an Android project (found an Activity subclass) but no AndroidManifest.xml was found — manifest-declared services/receivers/providers will not appear as entry points'
        );
      }
      return;
    }




    const byQualifiedName = new Map<string, { info: KotlinFileInfo; type: KotlinType }>();
    const bySimpleName = new Map<string, Array<{ info: KotlinFileInfo; type: KotlinType }>>();
    for (const info of fileInfos) {
      for (const type of info.types) {
        const entry = { info, type };
        if (info.packageName) byQualifiedName.set(`${info.packageName}.${type.name}`, entry);
        const bucket = bySimpleName.get(type.name);
        if (bucket) bucket.push(entry); else bySimpleName.set(type.name, [entry]);
      }
    }
    const alreadyEntryPointed = new Set(entryPoints.map(ep => ep.source_node));

    for (const manifestPath of manifestFiles.sort()) {
      const fullManifestPath = path.join(context.projectPath, manifestPath);
      let content: string;
      try {
        content = await fs.readFile(fullManifestPath, 'utf-8');
      } catch {
        continue;
      }

      let parsed: any;
      try {
        parsed = this.manifestParser.parse(content);
      } catch {
        this.addAnalysisWarning(`Kotlin: failed to parse AndroidManifest.xml at ${manifestPath}`);
        continue;
      }

      const manifestPackage = String(parsed?.manifest?.package || '');
      const application = parsed?.manifest?.application;
      if (!application) continue;






      const appName = typeof application === 'object' ? application?.name : undefined;
      if (appName && typeof appName === 'string') {
        const qualified = this.resolveManifestClassName(appName, manifestPackage);
        let resolved = byQualifiedName.get(qualified);
        if (!resolved) {
          const simpleName = qualified.split('.').pop() || qualified;
          const candidates = bySimpleName.get(simpleName);
          if (candidates && candidates.length === 1) resolved = candidates[0];
        }
        if (!resolved) {
          this.addAnalysisWarning(
            `Kotlin: manifest <application android:name="${appName}"> in ${manifestPath} did not resolve to a parsed class — skipped`
          );
        } else {
          const { info, type } = resolved;
          const typeId = this.typeId(info.relativePath, type.name);
          if (!alreadyEntryPointed.has(typeId)) {
            alreadyEntryPointed.add(typeId);
            const baseType = type.supertypes[0];
            entryPoints.push(this.createEntryPoint(
              `entry_${typeId}`,
              typeId,
              'lifecycle',
              `Android Application: ${type.name}`,
              `Android manifest-declared Application${baseType ? ` (extends ${baseType})` : ''}`,
              { pattern: type.name },
              undefined,
              {
                file: info.relativePath,
                line: type.lineStart,
                base: baseType,
                language: 'kotlin',
                component: 'application',
                manifestFile: manifestPath,
              },
              { node_id: typeId, method_name: type.name, file: info.relativePath, line: type.lineStart }
            ));
          }
        }
      }

      for (const [componentTag, entryType] of Object.entries(MANIFEST_COMPONENT_ENTRY_TYPES)) {
        for (const component of this.toArray(application[componentTag])) {
          const rawName = typeof component === 'object' ? component?.name : undefined;
          if (!rawName || typeof rawName !== 'string') continue;

          const qualified = this.resolveManifestClassName(rawName, manifestPackage);
          let resolved = byQualifiedName.get(qualified);
          if (!resolved) {
            const simpleName = qualified.split('.').pop() || qualified;
            const candidates = bySimpleName.get(simpleName);
            if (candidates && candidates.length === 1) resolved = candidates[0];
          }
          if (!resolved) {
            this.addAnalysisWarning(
              `Kotlin: manifest <${componentTag} android:name="${rawName}"> in ${manifestPath} did not resolve to a parsed class — skipped`
            );
            continue;
          }

          const { info, type } = resolved;
          const typeId = this.typeId(info.relativePath, type.name);

          const componentLabel = componentTag.charAt(0).toUpperCase() + componentTag.slice(1);
          const baseType = type.supertypes[0];

          let actions: string[] | undefined;
          if (componentTag === 'receiver') {
            const collected: string[] = [];
            for (const filter of this.toArray(component['intent-filter'])) {
              for (const action of this.toArray(filter?.action)) {
                const actionName = typeof action === 'object' ? action?.name : undefined;
                if (typeof actionName === 'string') collected.push(actionName);
              }
            }
            if (collected.length > 0) actions = collected;
          }





          let isLauncher = false;
          if (componentTag === 'activity') {
            for (const filter of this.toArray(component['intent-filter'])) {
              const filterActions = this.toArray(filter?.action)
                .map(a => (typeof a === 'object' ? a?.name : undefined));
              const filterCategories = this.toArray(filter?.category)
                .map(c => (typeof c === 'object' ? c?.name : undefined));
              if (
                filterActions.includes('android.intent.action.MAIN') &&
                filterCategories.includes('android.intent.category.LAUNCHER')
              ) {
                isLauncher = true;
                break;
              }
            }
          }

          if (alreadyEntryPointed.has(typeId)) {





            const existing = entryPoints.find(ep => ep.source_node === typeId);
            if (existing) {
              if (isLauncher) existing.metadata = { ...existing.metadata, is_launcher: true };
              if (actions) {
                existing.metadata = { ...existing.metadata, actions };
                existing.trigger = { ...existing.trigger, event: actions.join(',') };
              }
            }
            continue;
          }
          alreadyEntryPointed.add(typeId);

          entryPoints.push(this.createEntryPoint(
            `entry_${typeId}`,
            typeId,
            entryType,
            `Android ${componentLabel}: ${type.name}`,
            `Android manifest-declared ${componentLabel}${baseType ? ` (extends ${baseType})` : ''}`,
            actions ? { pattern: type.name, event: actions.join(',') } : { pattern: type.name },
            undefined,
            {
              file: info.relativePath,
              line: type.lineStart,
              base: baseType,
              language: 'kotlin',
              component: componentTag,
              manifestFile: manifestPath,
              ...(actions ? { actions } : {}),
              ...(isLauncher ? { is_launcher: true } : {}),
            },
            { node_id: typeId, method_name: type.name, file: info.relativePath, line: type.lineStart }
          ));
        }
      }
    }
  }

  private async emitCallEdges(
    fileInfos: KotlinFileInfo[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): Promise<void> {

    const definedNames = new Set<string>();
    const allFns: Array<{ fn: KotlinFunction; info: KotlinFileInfo }> = [];
    for (const info of fileInfos) {
      for (const fn of info.functions) { definedNames.add(fn.name); allFns.push({ fn, info }); }
    }

    const edgeIds = new Set(edges.map(e => e.id));
    const astAvailable = hasWasmGrammar('kotlin');

    for (const info of fileInfos) {
      let content: string;
      try {
        content = fs.readFileSync(info.fullPath, 'utf-8');
      } catch {
        continue;
      }
      let usedAst = false;
      if (astAvailable) {
        try {
          const tree = await parseWasm('kotlin', content);
          try {
            this.emitCallEdgesFromAst(info, tree, content, allFns, definedNames, edgeIds, edges);
            usedAst = true;
          } finally {
            tree.delete?.();
          }
        } catch {
          usedAst = false;
        }
      }
      if (!usedAst) this.emitCallEdgesFromRegex(info, content, definedNames, edgeIds, edges);
    }
  }



  private addCallEdge(
    info: KotlinFileInfo,
    caller: KotlinFunction,
    callee: string,
    line: number,
    definedNames: Set<string>,
    edgeIds: Set<string>,
    edges: CASEdge[]
  ): void {
    if (callee === caller.name) return;
    if (KOTLIN_CALL_KEYWORDS.has(callee)) return;
    if (!definedNames.has(callee)) return;

    const target = info.functions.find(fn => fn.name === callee);
    if (!target) return;
    const callerId = this.functionId(info.relativePath, caller.name, caller.lineStart);
    const targetId = this.functionId(info.relativePath, target.name, target.lineStart);
    if (callerId === targetId) return;
    const edgeId = `call_${callerId}_to_${targetId}_${line}`;
    if (edgeIds.has(edgeId)) return;
    edgeIds.add(edgeId);
    edges.push(this.createEdge(edgeId, callerId, targetId, 'calls', 'behavior', {
      attributes: { line: line + 1, language: 'kotlin' },
    }));
  }






  private emitCallEdgesFromAst(
    info: KotlinFileInfo,
    tree: any,
    content: string,
    allFns: Array<{ fn: KotlinFunction; info: KotlinFileInfo }>,
    definedNames: Set<string>,
    edgeIds: Set<string>,
    edges: CASEdge[]
  ): void {
    const varTypeCache = new Map<KotlinFunction, Map<string, string>>();
    const calleeAndReceiver = (call: any): { callee?: string; receiver?: string } => {
      const fn = call.child(0);
      if (!fn) return {};
      if (fn.type === 'simple_identifier') return { callee: fn.text };
      if (fn.type === 'navigation_expression') {
        const obj = fn.child(0);
        const receiver = obj?.type === 'simple_identifier' ? obj.text : undefined;
        let last: string | undefined;
        (function find(n: any) {
          if (n.type === 'simple_identifier') last = n.text;
          for (let i = 0; i < n.childCount; i++) find(n.child(i));
        })(fn);
        return { callee: last, receiver };
      }
      return {};
    };
    const walk = (n: any): void => {
      if (n.type === 'call_expression') {
        const { callee, receiver } = calleeAndReceiver(n);
        if (callee) {
          const line = n.startPosition.row + 1;
          const caller = this.enclosingFunction(info, line);
          if (caller) this.addKotlinCallEdge(info, caller, callee, receiver, content, allFns, varTypeCache, line - 1, definedNames, edgeIds, edges);
        }
      }
      for (let i = 0; i < n.childCount; i++) walk(n.child(i));
    };
    walk(tree.rootNode);
  }


  private addKotlinCallEdge(
    info: KotlinFileInfo,
    caller: KotlinFunction,
    callee: string,
    receiver: string | undefined,
    content: string,
    allFns: Array<{ fn: KotlinFunction; info: KotlinFileInfo }>,
    varTypeCache: Map<KotlinFunction, Map<string, string>>,
    line: number,
    definedNames: Set<string>,
    edgeIds: Set<string>,
    edges: CASEdge[]
  ): void {
    if (callee === caller.name) return;
    if (KOTLIN_CALL_KEYWORDS.has(callee)) return;
    if (!definedNames.has(callee)) return;

    let target: { fn: KotlinFunction; info: KotlinFileInfo } | undefined;


    if (receiver && receiver !== 'this') {
      let varTypes = varTypeCache.get(caller);
      if (!varTypes) { varTypes = this.kotlinVarTypes(content, caller); varTypeCache.set(caller, varTypes); }
      const recvType = varTypes.get(receiver);
      if (recvType) target = allFns.find(x => x.fn.name === callee && x.fn.ownerType === recvType);
    }

    if (!target) {
      const sameFile = info.functions.find(fn => fn.name === callee);
      if (sameFile) target = { fn: sameFile, info };
    }

    if (!target) {
      const named = allFns.filter(x => x.fn.name === callee);
      if (named.length === 1) target = named[0];
    }
    if (!target) return;

    const callerId = this.functionId(info.relativePath, caller.name, caller.lineStart);
    const targetId = this.functionId(target.info.relativePath, target.fn.name, target.fn.lineStart);
    if (callerId === targetId) return;
    const edgeId = `call_${callerId}_to_${targetId}_${line}`;
    if (edgeIds.has(edgeId)) return;
    edgeIds.add(edgeId);
    edges.push(this.createEdge(edgeId, callerId, targetId, 'calls', 'behavior', {
      attributes: { line: line + 1, language: 'kotlin' },
    }));
  }




  private kotlinVarTypes(content: string, fn: KotlinFunction): Map<string, string> {
    const map = new Map<string, string>();
    const lines = content.split('\n');
    const text = lines.slice(fn.lineStart - 1, fn.lineEnd >= fn.lineStart ? fn.lineEnd : fn.lineStart).join('\n');
    const bare = (t: string) => t.replace(/<.*$/, '').replace(/[?]/g, '').trim().split('.').pop() || t;
    const header = text.split('{')[0];
    const pm = header.match(/\(([^)]*)\)/);
    if (pm && pm[1].trim()) {
      for (const part of pm[1].split(',')) {
        const m = part.match(/(\w+)\s*:\s*([A-Za-z_][\w.]*)/);
        if (m && /^[A-Z]/.test(bare(m[2]))) map.set(m[1], bare(m[2]));
      }
    }
    for (const m of text.matchAll(/\bval\s+(\w+)\s*:\s*([A-Z][\w.]*)/g)) map.set(m[1], bare(m[2]));
    for (const m of text.matchAll(/\bval\s+(\w+)\s*=\s*([A-Z][\w.]*)\s*\(/g)) map.set(m[1], bare(m[2]));
    return map;
  }


  private emitCallEdgesFromRegex(
    info: KotlinFileInfo,
    content: string,
    definedNames: Set<string>,
    edgeIds: Set<string>,
    edges: CASEdge[]
  ): void {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]);
      if (!stripped.trim()) continue;
      const caller = this.enclosingFunction(info, i + 1);
      if (!caller) continue;




      let declTokenEnd = -1;
      if (i + 1 === caller.lineStart) {
        const decl = /\bfun\s+(?:<[^>]*>\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\(/.exec(stripped);
        if (decl) declTokenEnd = decl.index + decl[0].length;
      }

      for (const m of stripped.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {

        if (declTokenEnd >= 0 && (m.index ?? 0) < declTokenEnd) continue;
        this.addCallEdge(info, caller, m[1], i, definedNames, edgeIds, edges);
      }
    }
  }

  private enclosingFunction(info: KotlinFileInfo, line: number): KotlinFunction | undefined {
    let innermost: KotlinFunction | undefined;
    for (const fn of info.functions) {
      if (fn.lineStart <= line && fn.lineEnd >= line) {
        if (!innermost || fn.lineStart > innermost.lineStart) innermost = fn;
      }
    }
    return innermost;
  }





  private accessModifier(visibility: string): 'public' | 'private' | 'protected' | undefined {
    if (visibility === 'private') return 'private';
    if (visibility === 'protected') return 'protected';
    if (visibility === 'public') return 'public';
    return undefined;
  }

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private typeId(relativePath: string, name: string): string {
    return `class_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}`;
  }

  private functionId(relativePath: string, name: string, line: number): string {
    return `function_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}_${line}`;
  }

  private propertyId(relativePath: string, ownerName: string, fieldName: string): string {
    return `property_${this.sanitizeId(relativePath)}_${this.sanitizeId(ownerName)}_${this.sanitizeId(fieldName)}`;
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'File/Module';
      case 2: return 'Class/Interface';
      case 3: return 'Function';
      case 4: return 'Method/Function';
      default: return `level_${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return [
      'kotlin-types',
      'kotlin-functions',
      'compose-fns',
      'kotlin-coroutines',
      'kotlin-inheritance',
      'kotlin-imports',
      'entry-point-detection',
    ];
  }













  private applyTestFileBoundary(nodes: CASNode[]): void {
    for (const node of nodes) {
      const file = node.source?.file;
      if (!file || !this.isKotlinTestPath(file)) continue;
      node.metadata = { ...node.metadata, is_test: true };
      node.category = 'test';
      node.subcategories = [...new Set([...(node.subcategories || []), node.type, 'test-code'])];
      node.tags = [...new Set([...(node.tags || []), 'test-code'])];
    }
  }

  private isKotlinTestPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const basename = normalized.split('/').pop() || normalized;
    return /(?:^|\/)src\/(?:test|androidTest)\//i.test(normalized) ||
      /Tests?\.kts?$/i.test(basename);
  }
}

export default { KotlinAnalyzer };
