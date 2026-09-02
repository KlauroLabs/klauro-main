import * as path from 'node:path';
import type { TSESTree } from '@typescript-eslint/typescript-estree';

export interface ReactSourceAnalysisFile {
  readonly file: string;
  readonly fullPath: string;
  readonly content: string;
}

export interface ReactSourceAnalysisStats {
  readonly files: number;
  readonly reads: number;
  readonly parses: number;
}

export interface ReactSourceAnalysisOptions {
  files: readonly string[];
  projectPath: string;
  read: (fullPath: string) => Promise<string | null>;
  parse: (file: string, content: string) => TSESTree.Program;
}

export function isReactApplicableSource(file: string, content: string): boolean {
  if (/\.d\.(?:ts|cts|mts)$/.test(file)) return false;
  if (/\.(?:tsx|jsx)$/.test(file)) return true;
  if (/(?:^|\/)(?:routes?|stores?|contexts?|hooks?|pages?|screens?|components?)(?:\/|$)/i.test(file)
    || /(?:route|router|store|context|hook|page|screen|component|layout|provider)/i.test(path.basename(file))) return true;
  return /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:react(?:-dom)?|next|react-router(?:-dom)?|redux|\/toolkit|zustand|recoil)(?:\/[^'"]*)?['"]/.test(content);
}

export function buildComponentModuleMap(content: string): Map<string, string> {
  const modules = new Map<string, string>();
  for (const match of content.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;]*?)(?:;|\n(?=\s*(?:const|let|var|function|export|import)\b))/g)) {
    const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(match[2]);
    if (dynamic) modules.set(match[1], dynamic[1]);
  }
  for (const match of content.matchAll(/\bimport\s+([^;'"]+?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = match[1];
    const moduleSpecifier = match[2];
    const defaultMatch = /^\s*(\w+)\s*(?:,|$)/.exec(clause);
    if (defaultMatch) modules.set(defaultMatch[1], moduleSpecifier);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (!braces) continue;
    for (const part of braces[1].split(',')) {
      const named = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (named) modules.set(named[2] || named[1], moduleSpecifier);
    }
  }
  return modules;
}

export class ReactSourceAnalysis {
  private readonly astByFile = new Map<string, TSESTree.Program>();
  private readonly parseErrorByFile = new Map<string, unknown>();
  private readonly modulesByFile = new Map<string, ReadonlyMap<string, string>>();
  private parseCount = 0;

  private constructor(
    readonly files: readonly ReactSourceAnalysisFile[],
    private readonly parseFile: (file: string, content: string) => TSESTree.Program,
    private readonly readCount: number,
  ) {
    for (const source of files) this.modulesByFile.set(source.file, buildComponentModuleMap(source.content));
  }

  static async create(options: ReactSourceAnalysisOptions): Promise<ReactSourceAnalysis> {
    let reads = 0;
    const loaded = await Promise.all(options.files.map(async file => {
      reads += 1;
      const fullPath = path.join(options.projectPath, file);
      const content = await options.read(fullPath);
      return content === null ? null : Object.freeze({ file, fullPath, content });
    }));
    return new ReactSourceAnalysis(
      Object.freeze(loaded.filter((source): source is ReactSourceAnalysisFile => source !== null)),
      options.parse,
      reads,
    );
  }

  static fromContent(file: string, fullPath: string, content: string, parseFile: (file: string, content: string) => TSESTree.Program): ReactSourceAnalysis {
    return new ReactSourceAnalysis([Object.freeze({ file, fullPath, content })], parseFile, 1);
  }

  ast(source: ReactSourceAnalysisFile): TSESTree.Program {
    const cached = this.astByFile.get(source.file);
    if (cached) return cached;
    if (this.parseErrorByFile.has(source.file)) throw this.parseErrorByFile.get(source.file);
    try {
      const parsed = this.parseFile(source.file, source.content);
      this.astByFile.set(source.file, parsed);
      this.parseCount += 1;
      return parsed;
    } catch (error) {
      this.parseErrorByFile.set(source.file, error);
      this.parseCount += 1;
      throw error;
    }
  }

  componentModule(source: ReactSourceAnalysisFile, localName: string): string | undefined {
    return this.modulesByFile.get(source.file)?.get(localName);
  }

  stats(): ReactSourceAnalysisStats {
    return Object.freeze({ files: this.files.length, reads: this.readCount, parses: this.parseCount });
  }
}
