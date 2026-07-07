import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint,
  CASComment, CASTodo, FileAnalysisResult
} from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import * as path from 'path';

interface ShellFunction {
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

interface ShellSource {
  rawPath: string;
  lineNumber: number;
}

interface ShellFileInfo {
  relativePath: string;
  fullPath: string;
  functions: ShellFunction[];
  sources: ShellSource[];
  hasShebang: boolean;
  shebangLine?: string;
  externalCommands: Array<{ command: string; lineNumber: number }>;
  lineCount: number;
}

const SHELL_EXTENSIONS = ['.sh', '.bash', '.zsh', '.ksh'];
const SHEBANG_SHELLS = /^#!\s*(?:\/usr\/bin\/env\s+)?\/?(?:\S*\/)?(sh|bash|zsh|ksh|dash|ash)\b/;
const ENTRYPOINT_NAMES = new Set([
  'main.sh', 'run.sh', 'entrypoint.sh', 'install.sh', 'setup.sh',
  'deploy.sh', 'bootstrap.sh',
]);
// External commands that represent calls leaving the process (exit points).
const EXTERNAL_EXIT_COMMANDS = new Set([
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'docker', 'kubectl', 'helm',
  'aws', 'gcloud', 'az', 'terraform', 'ansible', 'git', 'npm', 'yarn',
  'pip', 'psql', 'mysql', 'redis-cli', 'http',
]);
// Common shell builtins / keywords that must never be treated as user functions/calls.
const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', 'select', 'time', 'return', 'break',
  'continue', 'exit', 'local', 'declare', 'readonly', 'export', 'echo',
  'printf', 'read', 'set', 'unset', 'shift', 'eval', 'exec', 'source',
  'test', 'true', 'false', 'cd', 'pwd', 'trap', 'wait', 'kill',
]);

// Cap on how many extensionless files we read first lines from when sniffing shebangs.
const MAX_SHEBANG_SNIFF = 400;

export class ShellAnalyzer extends BaseAnalyzer {
  private todoCounter = 0;
  private commentCounter = 0;

  constructor() {
    super(
      'shell',
      'Shell/Bash Analyzer',
      '1.0.0',
      'language'
    );
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const files = await this.findShellFiles(projectPath, { projectPath }, true);
      return files.length > 0;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await this.findShellFiles(projectPath, { projectPath }, false);
    return files.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const info = this.parseShellFile(context.relativePath, context.filePath, content);
    // Single-file analysis can only resolve calls/sources within this one file.
    const definedFunctionNames = new Set(info.functions.map(fn => fn.name));
    const fileById = new Map<string, ShellFileInfo>([[info.relativePath, info]]);

    this.emitFileNodes(info, content, nodes, edges, entryPoints, exitPoints, definedFunctionNames);
    this.emitCallEdges([info], fileById, edges);
    this.emitSourceEdges([info], context.projectPath, edges);

    const imports = info.sources.map(src => src.rawPath);
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
      let shellFiles = await this.findShellFiles(context.projectPath, context, false);
      shellFiles.sort();
      shellFiles = this.capAndPrioritizeSourceFiles(shellFiles, 'shell scripts');

      const fileInfos: ShellFileInfo[] = [];
      for (const relativePath of shellFiles) {
        const fullPath = path.join(context.projectPath, relativePath);
        let content = '';
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        fileInfos.push(this.parseShellFile(relativePath, fullPath, content));
      }

      // Resolve calls against the full set of defined function names across the repo.
      const definedFunctionNames = new Set<string>();
      const fileById = new Map<string, ShellFileInfo>();
      for (const info of fileInfos) {
        fileById.set(info.relativePath, info);
        for (const fn of info.functions) definedFunctionNames.add(fn.name);
      }

      for (const info of fileInfos) {
        const content = await fs.readFile(info.fullPath, 'utf-8').catch(() => '');
        this.emitFileNodes(info, content, nodes, edges, entryPoints, exitPoints, definedFunctionNames);
      }

      this.emitCallEdges(fileInfos, fileById, edges);
      this.emitSourceEdges(fileInfos, context.projectPath, edges);

      const warnings = this.collectAnalysisWarnings();
      const functionCount = nodes.filter(n => n.type === 'function').length;
      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        ...(warnings.length > 0 ? { warnings } : {}),
        framework_specific: {
          language: 'shell',
          packageManager: 'unknown',
          filesAnalyzed: fileInfos.length,
          functionsFound: functionCount
        }
      });
    } catch (error) {
      throw new AnalyzerError(
        `Shell analysis failed: ${(error as Error).message}`,
        'SHELL_ANALYSIS_ERROR'
      );
    }
  }

  private async findShellFiles(
    projectPath: string,
    context: AnalysisContext,
    stopEarly: boolean
  ): Promise<string[]> {
    const ignore = this.getIgnorePatterns(context);
    const extGlobs = ['**/*.sh', '**/*.bash', '**/*.zsh', '**/*.ksh'];
    const extFiles = await glob(extGlobs, {
      cwd: projectPath,
      ignore,
      nodir: true
    });

    if (stopEarly && extFiles.length > 0) {
      return extFiles;
    }

    // Sniff extensionless files for a shell shebang.
    const allFiles = await glob(['**/*'], {
      cwd: projectPath,
      ignore,
      nodir: true
    });

    const candidates = allFiles.filter(file => {
      const base = path.basename(file);
      const ext = path.extname(base);
      return ext === '' && !base.startsWith('.');
    });

    const shebangFiles: string[] = [];
    let sniffed = 0;
    for (const file of candidates) {
      if (sniffed >= MAX_SHEBANG_SNIFF) break;
      sniffed++;
      try {
        const firstLine = await this.readFirstLine(path.join(projectPath, file));
        if (SHEBANG_SHELLS.test(firstLine)) {
          shebangFiles.push(file);
          if (stopEarly) break;
        }
      } catch {
        // ignore unreadable files
      }
    }

    return [...new Set([...extFiles, ...shebangFiles])];
  }

  private async readFirstLine(fullPath: string): Promise<string> {
    const handle = await fs.open(fullPath, 'r');
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await fs.read(handle, buffer, 0, 256, 0);
      const text = buffer.slice(0, bytesRead).toString('utf-8');
      const newlineIndex = text.indexOf('\n');
      return newlineIndex === -1 ? text : text.slice(0, newlineIndex);
    } finally {
      await fs.close(handle);
    }
  }

  private parseShellFile(relativePath: string, fullPath: string, content: string): ShellFileInfo {
    const lines = content.split('\n');
    const functions = this.extractFunctions(lines, fullPath);
    const sources = this.extractSources(lines);
    const externalCommands = this.extractExternalCommands(lines);
    const firstLine = lines[0] || '';
    const hasShebang = SHEBANG_SHELLS.test(firstLine);

    return {
      relativePath,
      fullPath,
      functions,
      sources,
      hasShebang,
      shebangLine: hasShebang ? firstLine.trim() : undefined,
      externalCommands,
      lineCount: lines.length,
    };
  }

  private extractFunctions(lines: string[], filePath: string): ShellFunction[] {
    const functions: ShellFunction[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Form 1: name() { ... }   (optional `function` keyword)
      // Form 2: function name { ... } / function name() { ... }
      let name: string | undefined;
      const posix = trimmed.match(/^(?:function\s+)?([A-Za-z_][A-Za-z0-9_:.-]*)\s*\(\s*\)\s*\{?/);
      const keyword = trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_:.-]*)\s*\{?/);
      if (posix) {
        name = posix[1];
      } else if (keyword) {
        name = keyword[1];
      }

      if (!name || SHELL_KEYWORDS.has(name)) continue;

      const lineEnd = this.findFunctionEnd(lines, i);
      functions.push({
        name,
        filePath,
        lineStart: i + 1,
        lineEnd,
      });
    }
    return functions;
  }

  // Best-effort brace matching to find the end of a function body.
  private findFunctionEnd(lines: string[], startIndex: number): number {
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
    }
    return startIndex + 1;
  }

  private stripStringsAndComments(line: string): string {
    let result = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === '#' && !inSingle && !inDouble) break;
      else if (!inSingle && !inDouble) result += ch;
    }
    return result;
  }

  private extractSources(lines: string[]): ShellSource[] {
    const sources: ShellSource[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // `source path` or `. path`
      const match = trimmed.match(/^(?:source|\.)\s+(["']?)([^"'\s;&|]+)\1/);
      if (match) {
        sources.push({ rawPath: match[2], lineNumber: i + 1 });
      }
    }
    return sources;
  }

  private extractExternalCommands(lines: string[]): Array<{ command: string; lineNumber: number }> {
    const found: Array<{ command: string; lineNumber: number }> = [];
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const stripped = this.stripStringsAndComments(lines[i]).trim();
      if (!stripped) continue;
      const match = stripped.match(/(?:^|[;&|]|\$\(|`)\s*([A-Za-z][A-Za-z0-9_-]*)\b/);
      if (match && EXTERNAL_EXIT_COMMANDS.has(match[1])) {
        const key = `${match[1]}:${i + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ command: match[1], lineNumber: i + 1 });
        }
      }
    }
    return found;
  }

  private emitFileNodes(
    info: ShellFileInfo,
    content: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    definedFunctionNames: Set<string>
  ): void {
    const fileId = this.fileId(info.relativePath);
    const baseName = info.relativePath.split('/').pop() || 'unknown.sh';
    const fileComments = this.extractCommentsFromFile(content, info.fullPath);
    const fileTodos = this.extractTodosFromComments(fileComments, info.fullPath);

    nodes.push(this.createNodeBuilder(fileId, baseName, 'file')
      .withLevel(1, 'File/Module')
      .withCategory('modules', ['shell-files'])
      .withSource({ file: info.fullPath, line: 1, end_line: info.lineCount })
      .withMetadata({
        language: 'shell',
        attributes: {
          shebang: info.shebangLine,
          hasShebang: info.hasShebang,
          functionCount: info.functions.length,
          sourceCount: info.sources.length,
          extension: path.extname(baseName) || '(none)',
          commentCount: fileComments.length,
          todoCount: fileTodos.length
        }
      })
      .withComments(fileComments.length > 0 ? fileComments : undefined)
      .withTodos(fileTodos.length > 0 ? fileTodos : undefined)
      .build());

    // Function nodes
    for (const fn of info.functions) {
      const functionId = this.functionId(info.relativePath, fn.name, fn.lineStart);
      const fnComments = fileComments.filter(c =>
        c.location.line >= fn.lineStart && c.location.line <= fn.lineEnd
      );
      const fnTodos = this.extractTodosFromComments(fnComments, functionId);

      const node = this.createNodeBuilder(functionId, fn.name, 'function')
        .withLevel(3, 'Function')
        .withCategory('functions', ['shell-functions'])
        .withSource({ file: fn.filePath, line: fn.lineStart, end_line: fn.lineEnd })
        .withMetadata({
          language: 'shell',
          attributes: {
            file: info.relativePath
          }
        })
        .withComments(fnComments.length > 0 ? fnComments : undefined)
        .withTodos(fnTodos.length > 0 ? fnTodos : undefined)
        .build();
      node.qualified_name = `${info.relativePath}:${fn.name}`;
      nodes.push(node);

      edges.push(this.createEdge(
        `${fileId}_contains_${functionId}`,
        fileId,
        functionId,
        'contains'
      ));
    }

    // External command exit points
    for (const ext of info.externalCommands) {
      const sourceNode = this.enclosingNodeId(info, ext.lineNumber, fileId);
      const exitId = `exit_${fileId}_${this.sanitizeId(ext.command)}_${ext.lineNumber}`;
      exitPoints.push(this.createExitPoint(
        exitId,
        sourceNode,
        ext.command === 'psql' || ext.command === 'mysql' || ext.command === 'redis-cli' ? 'database' : 'api',
        `External command: ${ext.command}`,
        `Shell invocation of ${ext.command}`,
        { resource: ext.command, sdk: ext.command },
        { action: ext.command, method: 'shell' },
        { command: ext.command, line: ext.lineNumber, language: 'shell' }
      ));
    }

    // Entry point: executable OR shebang OR entrypoint-named
    const isEntrypointName = ENTRYPOINT_NAMES.has(baseName);
    const isExecutable = this.isExecutable(info.fullPath);
    if (info.hasShebang || isExecutable || isEntrypointName) {
      const reasons: string[] = [];
      if (info.hasShebang) reasons.push('shebang');
      if (isExecutable) reasons.push('executable');
      if (isEntrypointName) reasons.push('entrypoint-name');
      entryPoints.push(this.createEntryPoint(
        `entry_${fileId}`,
        fileId,
        'cli',
        `Shell script: ${baseName}`,
        `Executable shell script (${reasons.join(', ')})`,
        undefined,
        undefined,
        {
          file: info.relativePath,
          line: 1,
          shebang: info.shebangLine,
          executable: isExecutable,
          reasons
        }
      ));
    }
  }

  private emitCallEdges(
    fileInfos: ShellFileInfo[],
    fileById: Map<string, ShellFileInfo>,
    edges: CASEdge[]
  ): void {
    const edgeIds = new Set(edges.map(e => e.id));
    for (const info of fileInfos) {
      let content: string;
      try {
        content = fs.readFileSync(info.fullPath, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const stripped = this.stripStringsAndComments(lines[i]);
        if (!stripped.trim()) continue;
        const caller = this.enclosingFunction(info, i + 1);
        if (!caller) continue;

        // Find bareword command invocations on this line.
        const tokens = stripped.matchAll(/(?:^|[;&|(){}\s])([A-Za-z_][A-Za-z0-9_:.-]*)\b/g);
        for (const token of tokens) {
          const word = token[1];
          if (word === caller.name) continue;
          if (SHELL_KEYWORDS.has(word)) continue;
          // Only link to functions defined within the same file (resolvable scope).
          const target = info.functions.find(fn => fn.name === word);
          if (!target) continue;

          const callerId = this.functionId(info.relativePath, caller.name, caller.lineStart);
          const targetId = this.functionId(info.relativePath, target.name, target.lineStart);
          if (callerId === targetId) continue;
          const edgeId = `call_${callerId}_to_${targetId}_${i}`;
          if (edgeIds.has(edgeId)) continue;
          edgeIds.add(edgeId);
          edges.push(this.createEdge(
            edgeId,
            callerId,
            targetId,
            'calls',
            'behavior',
            { line: i + 1, callType: 'function' }
          ));
        }
      }
    }
  }

  private emitSourceEdges(
    fileInfos: ShellFileInfo[],
    projectPath: string,
    edges: CASEdge[]
  ): void {
    const edgeIds = new Set(edges.map(e => e.id));
    const byRelative = new Map<string, ShellFileInfo>();
    for (const info of fileInfos) byRelative.set(this.normalize(info.relativePath), info);

    for (const info of fileInfos) {
      const sourceDir = path.dirname(info.fullPath);
      for (const src of info.sources) {
        const resolved = this.resolveSourcePath(src.rawPath, sourceDir, projectPath);
        if (!resolved) continue;
        const target = byRelative.get(this.normalize(resolved));
        if (!target) continue;
        const sourceId = this.fileId(info.relativePath);
        const targetId = this.fileId(target.relativePath);
        if (sourceId === targetId) continue;
        const edgeId = `${sourceId}_imports_${targetId}_${src.lineNumber}`;
        if (edgeIds.has(edgeId)) continue;
        edgeIds.add(edgeId);
        edges.push(this.createEdge(
          edgeId,
          sourceId,
          targetId,
          'imports',
          'dependency',
          { line: src.lineNumber, rawPath: src.rawPath, language: 'shell' }
        ));
      }
    }
  }

  private resolveSourcePath(rawPath: string, sourceDir: string, projectPath: string): string | undefined {
    // Drop variable-only paths we can't resolve statically.
    if (rawPath.includes('$') && !rawPath.includes('/')) return undefined;
    let candidate = rawPath;
    // Strip common dynamic prefixes like "$(dirname "$0")/" to a relative tail.
    const slashIndex = candidate.lastIndexOf('/');
    if (candidate.includes('$') && slashIndex !== -1) {
      candidate = candidate.slice(slashIndex + 1);
    }
    const abs = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(sourceDir, candidate);
    let rel = path.relative(projectPath, abs);
    if (rel.startsWith('..')) {
      // Fall back to basename match within the repo.
      rel = path.basename(candidate);
      return rel || undefined;
    }
    return rel;
  }

  private enclosingFunction(info: ShellFileInfo, line: number): ShellFunction | undefined {
    let innermost: ShellFunction | undefined;
    for (const fn of info.functions) {
      if (fn.lineStart <= line && fn.lineEnd >= line) {
        if (!innermost || fn.lineStart > innermost.lineStart) innermost = fn;
      }
    }
    return innermost;
  }

  private enclosingNodeId(info: ShellFileInfo, line: number, fileId: string): string {
    const fn = this.enclosingFunction(info, line);
    return fn ? this.functionId(info.relativePath, fn.name, fn.lineStart) : fileId;
  }

  private isExecutable(fullPath: string): boolean {
    try {
      const stat = fs.statSync(fullPath);
      return (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  private fileId(relativePath: string): string {
    return `file_${this.sanitizeId(relativePath)}`;
  }

  private functionId(relativePath: string, name: string, line: number): string {
    return `function_${this.sanitizeId(relativePath)}_${this.sanitizeId(name)}_${line}`;
  }

  private normalize(relativePath: string): string {
    return relativePath.replace(/\\/g, '/');
  }

  private extractCommentsFromFile(content: string, filePath: string): CASComment[] {
    const comments: CASComment[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Skip the shebang line itself.
      if (i === 0 && lines[i].startsWith('#!')) continue;
      const hashIndex = this.commentIndex(lines[i]);
      if (hashIndex === -1) continue;
      const text = lines[i].slice(hashIndex + 1).trim();
      if (!text) continue;
      const markers = this.extractCommentMarkers(text);
      comments.push({
        id: `comment_${++this.commentCounter}`,
        type: 'single-line',
        style: '#',
        text,
        purpose: this.classifyCommentPurpose(text),
        location: { file: filePath, line: i + 1, relative_to: 'inline' },
        markers
      });
    }
    return comments;
  }

  // Index of the comment '#' that is not inside a string and not part of a shebang.
  private commentIndex(line: string): number {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === '#' && !inSingle && !inDouble) {
        // Require start-of-token (preceded by whitespace or start) to avoid ${#var} etc.
        if (i === 0 || /\s/.test(line[i - 1])) return i;
      }
    }
    return -1;
  }

  private classifyCommentPurpose(text: string): CASComment['purpose'] {
    const lower = text.toLowerCase();
    if (/\b(todo|fixme|hack|xxx|optimize|refactor)\b/.test(lower)) return 'todo';
    if (/\b(warning|warn|caution|danger|important)\b/.test(lower)) return 'warning';
    if (/\b(note|info|tip|hint)\b/.test(lower)) return 'note';
    if (/\b(temp|temporary|quick|dirty)\b/.test(lower)) return 'hack';
    return 'explanation';
  }

  private extractCommentMarkers(text: string): CASComment['markers'] {
    const lower = text.toLowerCase();
    return {
      is_todo: /\btodo\b/.test(lower),
      is_fixme: /\bfixme\b/.test(lower),
      is_hack: /\bhack\b/.test(lower),
      is_warning: /\b(warning|warn)\b/.test(lower),
      is_note: /\b(note|info)\b/.test(lower),
      is_important: /\b(important|critical|urgent)\b/.test(lower),
      is_deprecated: /\b(deprecated|obsolete)\b/.test(lower),
    };
  }

  private extractTodosFromComments(comments: CASComment[], context: string): CASTodo[] {
    const todos: CASTodo[] = [];
    for (const comment of comments) {
      if (comment.markers?.is_todo || comment.markers?.is_fixme || comment.markers?.is_hack) {
        const typeMatch = comment.text.match(/\b(TODO|FIXME|HACK|NOTE|WARNING|XXX|OPTIMIZE|REFACTOR)\b/i);
        const type = typeMatch ? typeMatch[0].toUpperCase() as CASTodo['type'] : 'TODO';
        const priority = comment.markers?.is_important ? 'high' :
          comment.markers?.is_fixme ? 'medium' : 'low';
        todos.push({
          id: `todo_${++this.todoCounter}`,
          type,
          text: comment.text,
          priority,
          category: this.categorizeTodo(comment.text),
          location: { file: comment.location.file, line: comment.location.line, context },
          metadata: { source: 'comment', comment_type: comment.type }
        });
      }
    }
    return todos;
  }

  private categorizeTodo(text: string): CASTodo['category'] {
    const lower = text.toLowerCase();
    if (/\b(fix|bug|error|issue|broken)\b/.test(lower)) return 'bug';
    if (/\b(feature|add|implement|new)\b/.test(lower)) return 'feature';
    if (/\b(refactor|clean|improve|restructure)\b/.test(lower)) return 'refactor';
    if (/\b(performance|optimize|speed|slow)\b/.test(lower)) return 'performance';
    if (/\b(security|secure|auth|permission)\b/.test(lower)) return 'security';
    return 'general';
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
      'shell-script-detection',
      'shebang-detection',
      'function-extraction',
      'call-graph-analysis',
      'source-include-tracking',
      'entry-point-detection',
      'external-command-detection'
    ];
  }
}
