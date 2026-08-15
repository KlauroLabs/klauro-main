import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { parseWasm, hasWasmGrammar } from '../core/wasm-tree-sitter';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';

interface CFunction {
  name: string;
  returnType: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  className?: string;
  classNodeId?: string;
}

interface CClass {
  name: string;
  kind: 'class' | 'struct';
  filePath: string;
  lineStart: number;
  lineEnd: number;
  bases: string[];
}

interface CInclude {
  rawPath: string;
  system: boolean;
  lineNumber: number;
}

interface CFileInfo {
  relativePath: string;
  fullPath: string;
  language: 'c' | 'cpp';
  functions: CFunction[];
  classes: CClass[];
  includes: CInclude[];
  lineCount: number;
}

const C_HEADER_EXTS = new Set(['.h', '.hpp', '.hh', '.hxx']);
const CPP_EXTS = new Set(['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx']);
const C_GLOBS = [
  '**/*.c', '**/*.h',
  '**/*.cpp', '**/*.cc', '**/*.cxx',
  '**/*.hpp', '**/*.hh', '**/*.hxx',
];


const C_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'sizeof', 'else', 'do', 'case',
  'goto', 'break', 'continue', 'default', 'typedef', 'struct', 'union', 'enum',
  'class', 'namespace', 'template', 'typename', 'using', 'public', 'private',
  'protected', 'virtual', 'static', 'inline', 'const', 'constexpr', 'explicit',
  'friend', 'operator', 'new', 'delete', 'throw', 'catch', 'try', 'and', 'or',
  'not', 'defined', 'extern', 'register', 'volatile', 'alignof', 'static_assert',
  'noexcept', 'decltype', 'co_await', 'co_return', 'co_yield', 'requires',
]);

export class CCppAnalyzer extends BaseAnalyzer {
  constructor() {
    super('c-cpp', 'C/C++ Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await this.findCFiles(projectPath, { projectPath }, true);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  incrementalContributionScope(): 'project' {
    return 'project';
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await this.findCFiles(projectPath, { projectPath }, false);
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const info = this.parseFile(context.relativePath, context.filePath, content);
    const definedFunctionNames = new Set(info.functions.map(fn => fn.name));
    const fileByRel = new Map<string, CFileInfo>([[this.normalize(info.relativePath), info]]);

    this.emitFileNodes(info, nodes, edges, entryPoints);
    await this.emitCallEdges([info], definedFunctionNames, edges);
    this.emitIncludeEdges([info], context.projectPath, fileByRel, edges);

    const imports = info.includes.map(inc => inc.rawPath);
    const exports = info.functions.map(fn => fn.name);

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
      let cFiles = await this.findCFiles(context.projectPath, context, false);
      cFiles.sort();
      cFiles = this.capAndPrioritizeSourceFiles(cFiles, 'C/C++ source files');

      const fileInfos: CFileInfo[] = [];
      for (const relativePath of cFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        fileInfos.push(this.parseFile(relativePath, fullPath, content));
      }


      const definedFunctionNames = new Set<string>();
      const fileByRel = new Map<string, CFileInfo>();
      for (const info of fileInfos) {
        fileByRel.set(this.normalize(info.relativePath), info);
        for (const fn of info.functions) definedFunctionNames.add(fn.name);
      }

      for (const info of fileInfos) {
        this.emitFileNodes(info, nodes, edges, entryPoints);
      }

      await this.emitCallEdges(fileInfos, definedFunctionNames, edges);
      this.emitIncludeEdges(fileInfos, context.projectPath, fileByRel, edges);

      const warnings = this.collectAnalysisWarnings();
      const functionCount = nodes.filter(n => n.type === 'function' || n.type === 'method').length;
      const classCount = nodes.filter(n => n.type === 'class').length;
      const hasCpp = fileInfos.some(f => f.language === 'cpp');

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: hasCpp ? 'cpp' : 'c',
          packageManager: 'unknown',
          filesAnalyzed: fileInfos.length,
          functionsFound: functionCount,
          classesFound: classCount,
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `C/C++ analysis failed: ${(error as Error).message}`,
        'C_CPP_ANALYSIS_ERROR'
      );
    }
  }

  private async findCFiles(
    projectPath: string,
    context: AnalysisContext,
    stopEarly: boolean
  ): Promise<string[]> {
    const ignore = this.getIgnorePatterns(context);
    const files = await glob(C_GLOBS, {
      cwd: projectPath,
      ignore,
      nodir: true,
    });
    if (stopEarly && files.length > 0) {
      return files.slice(0, 1);
    }
    return [...new Set(files)];
  }

  private classifyLanguage(relativePath: string, content: string): 'c' | 'cpp' {
    const ext = path.extname(relativePath).toLowerCase();
    if (CPP_EXTS.has(ext)) {

      return 'cpp';
    }

    if (ext === '.h') {
      if (/\b(class|namespace|template)\b|::|\bstd::/.test(content)) return 'cpp';
    }
    return 'c';
  }

  private parseFile(relativePath: string, fullPath: string, content: string): CFileInfo {
    const language = this.classifyLanguage(relativePath, content);
    const stripped = this.stripCommentsPreserveLines(content);
    const lines = stripped.split('\n');

    const includes = this.extractIncludes(lines);
    const classes = this.extractClasses(lines, fullPath, language);
    const functions = this.extractFunctions(lines, fullPath, classes);

    return {
      relativePath,
      fullPath,
      language,
      functions,
      classes,
      includes,
      lineCount: lines.length,
    };
  }


  private stripCommentsPreserveLines(content: string): string {
    let out = '';
    let i = 0;
    const n = content.length;
    let inLine = false;
    let inBlock = false;
    let inStr = false;
    let inChar = false;
    while (i < n) {
      const ch = content[i];
      const next = i + 1 < n ? content[i + 1] : '';
      if (inLine) {
        if (ch === '\n') { inLine = false; out += ch; } else { out += ' '; }
        i++;
        continue;
      }
      if (inBlock) {
        if (ch === '*' && next === '/') { inBlock = false; out += '  '; i += 2; }
        else { out += ch === '\n' ? '\n' : ' '; i++; }
        continue;
      }
      if (inStr) {
        out += ch;
        if (ch === '\\') { out += next; i += 2; continue; }
        if (ch === '"') inStr = false;
        i++;
        continue;
      }
      if (inChar) {
        out += ch;
        if (ch === '\\') { out += next; i += 2; continue; }
        if (ch === "'") inChar = false;
        i++;
        continue;
      }
      if (ch === '/' && next === '/') { inLine = true; out += '  '; i += 2; continue; }
      if (ch === '/' && next === '*') { inBlock = true; out += '  '; i += 2; continue; }
      if (ch === '"') { inStr = true; out += ch; i++; continue; }
      if (ch === "'") { inChar = true; out += ch; i++; continue; }
      out += ch;
      i++;
    }
    return out;
  }

  private extractIncludes(lines: string[]): CInclude[] {
    const includes: CInclude[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/);
      if (m) {
        includes.push({
          rawPath: m[2],
          system: m[1] === '<',
          lineNumber: i + 1,
        });
      }
    }
    return includes;
  }

  private extractClasses(lines: string[], filePath: string, language: 'c' | 'cpp'): CClass[] {
    const classes: CClass[] = [];
    if (language !== 'cpp') return classes;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;

      const m = trimmed.match(
        /^(?:template\s*<[^>]*>\s*)?(class|struct)\s+([A-Za-z_]\w*)\b([^;{]*)\{/
      );
      if (!m) continue;
      const kind = m[1] as 'class' | 'struct';
      const name = m[2];
      const inheritance = m[3] || '';
      const bases: string[] = [];
      const baseMatch = inheritance.match(/:\s*(.+)$/);
      if (baseMatch) {
        for (const part of baseMatch[1].split(',')) {
          const bm = part.trim().match(/(?:public|protected|private|virtual)?\s*(?:virtual\s+)?([A-Za-z_][\w:]*)/);
          if (bm && bm[1]) bases.push(bm[1].replace(/.*::/, ''));
        }
      }
      const lineEnd = this.findBlockEnd(lines, i);
      classes.push({ name, kind, filePath, lineStart: i + 1, lineEnd, bases });
    }
    return classes;
  }

  private extractFunctions(lines: string[], filePath: string, classes: CClass[]): CFunction[] {
    const functions: CFunction[] = [];
    const seen = new Set<string>();
    const text = lines.join('\n');


    const re =
      /(?:^|\n)[ \t]*((?:(?:static|inline|virtual|extern|const|constexpr|explicit|friend|unsigned|signed|struct|enum|class|typename|register|volatile)\s+)*[A-Za-z_][\w:<>,*&\s]*?[\s*&])([A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)?)\s*\(([^;{}()]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:->[^;{]+)?\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      let returnType = m[1].trim();
      const rawName = m[2];
      const matchStart = m.index + (text[m.index] === '\n' ? 1 : 0);
      const lineStart = text.slice(0, matchStart).split('\n').length;

      const baseName = rawName.includes('::')
        ? rawName.split('::').pop()!
        : rawName;
      if (!baseName || C_KEYWORDS.has(baseName)) continue;
      if (C_KEYWORDS.has(returnType.split(/\s+/).pop() || '')) {

      }

      if (C_KEYWORDS.has(rawName)) continue;


      let className: string | undefined;
      if (rawName.includes('::')) {
        className = rawName.split('::').slice(-2)[0];
      } else {

        const enclosing = classes.find(c => lineStart > c.lineStart && lineStart <= c.lineEnd);
        if (enclosing) className = enclosing.name;
      }

      if (!returnType) returnType = 'void';
      const lineEndIdx = matchStart + m[0].length - 1;
      const lineEnd = this.findBlockEndChar(text, lineEndIdx);

      const key = `${baseName}:${lineStart}`;
      if (seen.has(key)) continue;
      seen.add(key);

      functions.push({
        name: baseName,
        returnType,
        filePath,
        lineStart,
        lineEnd,
        className,
      });
    }
    return functions;
  }


  private findBlockEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    let seenOpen = false;
    for (let i = startIndex; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') { depth++; seenOpen = true; }
        else if (ch === '}') { depth--; if (seenOpen && depth <= 0) return i + 1; }
      }
    }
    return startIndex + 1;
  }


  private findBlockEndChar(text: string, openBraceIndex: number): number {
    let depth = 0;
    for (let i = openBraceIndex; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth <= 0) return text.slice(0, i + 1).split('\n').length;
      }
    }
    return text.slice(0, openBraceIndex + 1).split('\n').length;
  }

  private emitFileNodes(
    info: CFileInfo,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const fileId = this.fileId(info.relativePath);
    const baseName = info.relativePath.split('/').pop() || 'unknown.c';

    nodes.push(this.createNodeBuilder(fileId, baseName, 'file')
      .withLevel(1, 'File/Module')
      .withCategory('modules', ['c-cpp-files'])
      .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
      .withMetadata({
        language: info.language,
        attributes: {
          extension: path.extname(baseName) || '(none)',
          functionCount: info.functions.length,
          classCount: info.classes.length,
          includeCount: info.includes.length,
          isHeader: C_HEADER_EXTS.has(path.extname(baseName).toLowerCase()),
        }
      })
      .build());


    const classNodeIds = new Map<string, string>();
    for (const cls of info.classes) {
      const classId = this.classId(info.relativePath, cls.name, cls.lineStart);
      classNodeIds.set(cls.name, classId);
      const node = this.createNodeBuilder(classId, cls.name, 'class')
        .withLevel(2, 'Class')
        .withCategory('classes', ['cpp-classes'])
        .withSource({ file: cls.filePath, line: cls.lineStart, end_line: cls.lineEnd })
        .withMetadata({
          language: info.language,
          attributes: { kind: cls.kind, file: info.relativePath, bases: cls.bases }
        })
        .build();
      node.qualified_name = `${info.relativePath}:${cls.name}`;
      nodes.push(node);

      edges.push(this.createEdge(
        `${fileId}_contains_${classId}`, fileId, classId, 'contains'
      ));


      for (const base of cls.bases) {
        edges.push(this.createEdge(
          `inherit_${classId}_${this.sanitizeId(base)}`,
          classId,
          `class_name_${this.sanitizeId(base)}`,
          'inheritance',
          'structure',
          { baseName: base, language: info.language }
        ));
      }
    }


    for (const fn of info.functions) {
      const isMethod = !!fn.className;
      const fnId = isMethod
        ? this.methodId(info.relativePath, fn.className!, fn.name, fn.lineStart)
        : this.functionId(info.relativePath, fn.name, fn.lineStart);
      const nodeType = isMethod ? 'method' : 'function';

      const builder = this.createNodeBuilder(fnId, fn.name, nodeType)
        .withLevel(3, 'Function')
        .withCategory(isMethod ? 'methods' : 'functions', isMethod ? ['cpp-methods'] : ['c-functions'])
        .withSource({ file: fn.filePath, line: fn.lineStart, end_line: fn.lineEnd })
        .withSignature({ return_type: fn.returnType })
        .withMetadata({
          language: info.language,
          attributes: { file: info.relativePath, returnType: fn.returnType, class: fn.className }
        });
      if (isMethod) builder.withParent(classNodeIds.get(fn.className!));
      const node = builder.build();
      node.qualified_name = isMethod
        ? `${info.relativePath}:${fn.className}::${fn.name}`
        : `${info.relativePath}:${fn.name}`;
      nodes.push(node);

      const containerId = isMethod && classNodeIds.has(fn.className!)
        ? classNodeIds.get(fn.className!)!
        : fileId;
      edges.push(this.createEdge(
        `${containerId}_contains_${fnId}`, containerId, fnId, 'contains'
      ));


      if (fn.name === 'main' && !isMethod) {
        entryPoints.push(this.createEntryPoint(
          `entry_${fnId}`,
          fnId,
          'cli',
          `main (${baseName})`,
          `C/C++ program entry point main() in ${info.relativePath}`,
          undefined,
          undefined,
          { file: info.relativePath, line: fn.lineStart, language: info.language },
          { node_id: fnId, method_name: 'main', file: info.relativePath, line: fn.lineStart }
        ));
      }
    }
  }

  private async emitCallEdges(
    fileInfos: CFileInfo[],
    definedFunctionNames: Set<string>,
    edges: CASEdge[]
  ): Promise<void> {
    const edgeIds = new Set(edges.map(e => e.id));
    const astAvailable = hasWasmGrammar('c-cpp');
    for (const info of fileInfos) {
      let raw: string;
      try {
        raw = fs.readFileSync(info.fullPath, 'utf-8');
      } catch {
        continue;
      }




      let usedAst = false;
      if (astAvailable) {
        try {
          const tree = await parseWasm('c-cpp', raw);
          try {
            this.emitCallEdgesFromAst(info, tree, raw, fileInfos, definedFunctionNames, edgeIds, edges);
            usedAst = true;
          } finally {
            tree.delete?.();
          }
        } catch {
          usedAst = false;
        }
      }
      if (!usedAst) {
        this.emitCallEdgesFromRegex(info, this.stripCommentsPreserveLines(raw), fileInfos, definedFunctionNames, edgeIds, edges);
      }
    }
  }


  private addCallEdge(
    info: CFileInfo,
    caller: CFunction,
    callee: string,
    recvType: string | undefined,
    lineIndex: number,
    fileInfos: CFileInfo[],
    definedFunctionNames: Set<string>,
    edgeIds: Set<string>,
    edges: CASEdge[]
  ): void {
    if (callee === caller.name) return;
    if (C_KEYWORDS.has(callee)) return;
    if (!definedFunctionNames.has(callee)) return;


    let target: { info: CFileInfo; fn: CFunction } | undefined;
    if (recvType) {
      for (const fi of fileInfos) {
        const fn = fi.functions.find(f => f.name === callee && f.className === recvType);
        if (fn) { target = { info: fi, fn }; break; }
      }
    }
    if (!target) target = this.findTargetFunction(fileInfos, info, callee);
    if (!target) return;
    const callerId = caller.className
      ? this.methodId(info.relativePath, caller.className, caller.name, caller.lineStart)
      : this.functionId(info.relativePath, caller.name, caller.lineStart);
    const targetId = target.fn.className
      ? this.methodId(target.info.relativePath, target.fn.className, target.fn.name, target.fn.lineStart)
      : this.functionId(target.info.relativePath, target.fn.name, target.fn.lineStart);
    if (callerId === targetId) return;
    const edgeId = `call_${callerId}_to_${targetId}_${lineIndex}`;
    if (edgeIds.has(edgeId)) return;
    edgeIds.add(edgeId);
    edges.push(this.createEdge(
      edgeId, callerId, targetId, 'calls', 'behavior',
      { line: lineIndex + 1, callType: 'function' }
    ));
  }




  private emitCallEdgesFromAst(
    info: CFileInfo,
    tree: any,
    content: string,
    fileInfos: CFileInfo[],
    definedFunctionNames: Set<string>,
    edgeIds: Set<string>,
    edges: CASEdge[]
  ): void {
    const lastIdent = (n: any): string => {
      let last = '';
      (function find(x: any) {
        if (x.type === 'identifier' || x.type === 'field_identifier') last = x.text;
        for (let i = 0; i < x.childCount; i++) find(x.child(i));
      })(n);
      return last;
    };

    const calleeAndReceiver = (call: any): { callee?: string; receiver?: string } => {
      const f = call.childForFieldName('function');
      if (!f) return {};
      if (f.type === 'identifier') return { callee: f.text };
      if (f.type === 'field_expression') {
        const arg = f.childForFieldName('argument');
        const receiver = arg?.type === 'identifier' ? arg.text : undefined;
        return { callee: f.childForFieldName('field')?.text || undefined, receiver };
      }
      if (f.type === 'qualified_identifier') return { callee: lastIdent(f) || undefined };
      if (f.type === 'template_function') return { callee: f.childForFieldName('name')?.text || lastIdent(f) || undefined };
      return { callee: lastIdent(f) || undefined };
    };
    const varTypeCache = new Map<CFunction, Map<string, string>>();
    const walk = (n: any): void => {
      if (n.type === 'call_expression') {
        const { callee, receiver } = calleeAndReceiver(n);
        if (callee) {
          const line = n.startPosition.row + 1;
          const caller = this.enclosingFunction(info, line);
          if (caller) {
            let recvType: string | undefined;
            if (receiver && receiver !== 'this') {
              let vt = varTypeCache.get(caller);
              if (!vt) { vt = this.buildCppVarTypes(content, caller); varTypeCache.set(caller, vt); }
              recvType = vt.get(receiver);
            }
            this.addCallEdge(info, caller, callee, recvType, line - 1, fileInfos, definedFunctionNames, edgeIds, edges);
          }
        }
      }
      for (let i = 0; i < n.childCount; i++) walk(n.child(i));
    };
    walk(tree.rootNode);
  }




  private buildCppVarTypes(content: string, fn: CFunction): Map<string, string> {
    const map = new Map<string, string>();
    const lines = content.split('\n');
    const text = lines.slice(fn.lineStart - 1, fn.lineEnd >= fn.lineStart ? fn.lineEnd : fn.lineStart).join('\n');
    const bare = (t: string) => t.replace(/<.*$/, '').trim().split('::').pop() || t;
    const header = text.split('{')[0];
    const pm = header.match(/\(([^)]*)\)/);
    if (pm && pm[1].trim()) {
      for (const part of pm[1].split(',')) {
        const p = part.replace(/\bconst\b/g, '').trim();
        const m = p.match(/([A-Za-z_][\w:]*)\s*[*&]?\s*([A-Za-z_]\w*)\s*$/);
        if (m && /^[A-Z]/.test(bare(m[1]))) map.set(m[2], bare(m[1]));
      }
    }
    for (const m of text.matchAll(/\b([A-Z][\w:]*)\s*[*&]?\s+([a-z_]\w*)\s*[=;]/g)) map.set(m[2], bare(m[1]));
    return map;
  }



  private emitCallEdgesFromRegex(
    info: CFileInfo,
    content: string,
    fileInfos: CFileInfo[],
    definedFunctionNames: Set<string>,
    edgeIds: Set<string>,
    edges: CASEdge[]
  ): void {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (/^\s*#/.test(line)) continue;
      const caller = this.enclosingFunction(info, i + 1);
      if (!caller) continue;

      const callMatches = line.matchAll(/(^|[^A-Za-z0-9_>.])([A-Za-z_]\w*)\s*\(/g);
      for (const cm of callMatches) {
        this.addCallEdge(info, caller, cm[2], undefined, i, fileInfos, definedFunctionNames, edgeIds, edges);
      }
    }
  }

  private findTargetFunction(
    fileInfos: CFileInfo[],
    preferred: CFileInfo,
    name: string
  ): { info: CFileInfo; fn: CFunction } | undefined {
    const local = preferred.functions.find(fn => fn.name === name);
    if (local) return { info: preferred, fn: local };
    for (const info of fileInfos) {
      const fn = info.functions.find(f => f.name === name);
      if (fn) return { info, fn };
    }
    return undefined;
  }

  private emitIncludeEdges(
    fileInfos: CFileInfo[],
    projectPath: string,
    fileByRel: Map<string, CFileInfo>,
    edges: CASEdge[]
  ): void {
    const edgeIds = new Set(edges.map(e => e.id));

    const byBasename = new Map<string, string[]>();
    for (const info of fileInfos) {
      const base = path.basename(info.relativePath);
      const arr = byBasename.get(base) || [];
      arr.push(info.relativePath);
      byBasename.set(base, arr);
    }

    for (const info of fileInfos) {
      const sourceDir = path.dirname(info.fullPath);
      for (const inc of info.includes) {
        if (inc.system) continue;
        const resolved = this.resolveInclude(inc.rawPath, sourceDir, projectPath, byBasename, fileByRel);
        if (!resolved) continue;
        const sourceId = this.fileId(info.relativePath);
        const targetId = this.fileId(resolved);
        if (sourceId === targetId) continue;
        const edgeId = `${sourceId}_imports_${targetId}_${inc.lineNumber}`;
        if (edgeIds.has(edgeId)) continue;
        edgeIds.add(edgeId);
        edges.push(this.createEdge(
          edgeId, sourceId, targetId, 'imports', 'dependency',
          { line: inc.lineNumber, rawPath: inc.rawPath, language: info.language }
        ));
      }
    }
  }

  private resolveInclude(
    rawPath: string,
    sourceDir: string,
    projectPath: string,
    byBasename: Map<string, string[]>,
    fileByRel: Map<string, CFileInfo>
  ): string | undefined {

    const abs = path.resolve(sourceDir, rawPath);
    let rel = this.normalize(path.relative(projectPath, abs));
    if (!rel.startsWith('..') && fileByRel.has(rel)) return rel;


    const base = path.basename(rawPath);
    const candidates = byBasename.get(base);
    if (candidates && candidates.length > 0) {

      const tail = this.normalize(rawPath);
      const exact = candidates.find(c => this.normalize(c).endsWith(tail));
      return exact || candidates[0];
    }
    return undefined;
  }

  private enclosingFunction(info: CFileInfo, line: number): CFunction | undefined {
    let innermost: CFunction | undefined;
    for (const fn of info.functions) {
      if (fn.lineStart <= line && fn.lineEnd >= line) {
        if (!innermost || fn.lineStart > innermost.lineStart) innermost = fn;
      }
    }
    return innermost;
  }

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private functionId(relativePath: string, name: string, line: number): string {
    return `function_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}_${line}`;
  }

  private methodId(relativePath: string, className: string, name: string, line: number): string {
    return `method_${this.sanitizeId(relativePath)}_${this.sanitizeId(className)}_${this.sanitizeId(name)}_${line}`;
  }

  private classId(relativePath: string, name: string, line: number): string {
    return `class_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}_${line}`;
  }

  private normalize(relativePath: string): string {
    return relativePath.replace(/\\/g, '/');
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
      'c-functions',
      'cpp-classes',
      'cpp-methods',
      'cpp-inheritance',
      'c-includes',
      'c-callgraph',
      'entry-point-detection',
    ];
  }
}

export default { CCppAnalyzer };
