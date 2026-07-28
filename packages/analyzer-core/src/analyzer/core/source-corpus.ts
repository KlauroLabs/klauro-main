import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';

export type SourcePathCategory = 'source' | 'test' | 'config' | 'migration' | 'generated' | 'documentation';
export type SourceManifestKind = 'npm' | 'python' | 'ruby' | 'rust' | 'dotnet' | 'maven' | 'gradle' | 'go' | 'unknown';
export type SourceImportFlavor = 'ecmascript' | 'python' | 'ruby' | 'java' | 'go' | 'dotnet' | 'rust' | 'php' | 'dart' | 'all';

export interface SourceCorpusEntry {
  readonly absolutePath: string;
  readonly content: string;
  readonly lineStarts: readonly number[];
  readonly lines: readonly string[];
  readonly imports: readonly string[];
  importsFor(flavor: SourceImportFlavor): readonly string[];
  readonly categories: readonly SourcePathCategory[];
  readonly manifestKind?: SourceManifestKind;
}

export interface SourceCorpusStats {
  files: number;
  derivedEntries: number;
  entryHits: number;
  importIndexes: number;
  lineIndexes: number;
  lineArrays: number;
  jsonParses: number;
  lineLookups: number;
  linePrefixCharactersAvoided: number;
}

function classifyPath(filePath: string): readonly SourcePathCategory[] {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const categories = new Set<SourcePathCategory>();
  if (/(^|\/)(tests?|__tests__|spec|e2e|fixtures?)(\/|$)|\.(test|spec|e2e)\./.test(normalized)) categories.add('test');
  if (/(^|\/)(config|configs?|\.github)(\/|$)|(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/.test(normalized)) categories.add('config');
  if (/(^|\/)(migrations?|db\/migrate)(\/|$)/.test(normalized)) categories.add('migration');
  if (/(^|\/)(generated|dist|build|coverage|vendor)(\/|$)|\.(generated|gen)\./.test(normalized)) categories.add('generated');
  if (/(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst)$/.test(normalized)) categories.add('documentation');
  if (!categories.has('generated')) categories.add('source');
  return Object.freeze([...categories]);
}

function buildLineStarts(content: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return Object.freeze(starts);
}

function manifestKind(filePath: string): SourceManifestKind | undefined {
  const name = path.basename(filePath).toLowerCase();
  if (name === 'package.json') return 'npm';
  if (name === 'pyproject.toml' || name.startsWith('requirements') || name === 'pipfile') return 'python';
  if (name === 'gemfile') return 'ruby';
  if (name === 'cargo.toml') return 'rust';
  if (name.endsWith('.csproj') || name.endsWith('.fsproj')) return 'dotnet';
  if (name === 'pom.xml') return 'maven';
  if (name === 'build.gradle' || name === 'build.gradle.kts') return 'gradle';
  if (name === 'go.mod') return 'go';
  return undefined;
}

function extractImports(content: string, flavor: SourceImportFlavor): readonly string[] {
  const imports = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const ecmascript = flavor === 'all' || flavor === 'ecmascript';
    const importMatch = ecmascript ? line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/) : null;
    const requireMatch = ecmascript ? line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/) : null;
    const fromMatch = flavor === 'all' ? line.match(/^\s*\}?\s*from\s+['"]([^'"]+)['"]/) : null;
    const pythonMatch = flavor === 'all' || flavor === 'python' ? line.match(/^\s*(?:from\s+([a-zA-Z0-9_.-]+)\s+import|import\s+([a-zA-Z0-9_.-]+))/) : null;
    const rubyMatch = flavor === 'all' || flavor === 'ruby' ? line.match(/^\s*(?:require|include)\s+['"]?([A-Za-z0-9_:.-]+)['"]?/) : null;
    const javaMatch = flavor === 'all' || flavor === 'java' ? line.match(/^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.]+)(?:\.\*)?\s*;?\s*$/) : null;
    const goMatch = flavor === 'all' || flavor === 'go' ? line.match(/^\s*(?:import\s+)?(?:[a-zA-Z0-9_.]+\s+)?["`]([^"`]+)["`]/) : null;
    const csharpMatch = flavor === 'all' || flavor === 'dotnet' ? line.match(/^\s*using\s+(?:static\s+)?([A-Za-z0-9_.]+)\s*;/) : null;
    const rustMatch = flavor === 'all' || flavor === 'rust' ? line.match(/^\s*(?:pub\s+)?use\s+(?:::)?([A-Za-z_][A-Za-z0-9_:]*)/) : null;
    const phpMatch = flavor === 'all' || flavor === 'php' ? line.match(/^\s*use\s+([A-Za-z_\\][A-Za-z0-9_\\]*)/) : null;
    const dartMatch = flavor === 'all' || flavor === 'dart' ? line.match(/^\s*(?:import|export)\s+['"](?:package:)?([^'"]+)['"]/) : null;
    if (dartMatch?.[1]) {
      imports.add(dartMatch[1]);
      continue;
    }
    if (phpMatch?.[1] && (flavor === 'php' || phpMatch[1].includes('\\'))) {
      imports.add(phpMatch[1].replace(/\\/g, '/'));
      continue;
    }
    if (rustMatch?.[1]) {
      imports.add(rustMatch[1].replace(/::/g, '/'));
      continue;
    }
    const value = importMatch?.[1] || requireMatch?.[1] || fromMatch?.[1] || pythonMatch?.[1] || pythonMatch?.[2] || rubyMatch?.[1] || javaMatch?.[1] || goMatch?.[1] || csharpMatch?.[1];
    if (value) imports.add(value);
  }
  return Object.freeze([...imports]);
}

export class AnalyzerSourceCorpus {
  private readonly entriesByPath = new Map<string, SourceCorpusEntry>();
  private readonly entriesByContent = new Map<string, SourceCorpusEntry>();
  private readonly jsonByContent = new Map<string, { value?: unknown; error?: Error }>();
  private derivedEntries = 0;
  private entryHits = 0;
  private importIndexes = 0;
  private lineIndexes = 0;
  private lineArrays = 0;
  private jsonParses = 0;
  private lineLookups = 0;
  private linePrefixCharactersAvoided = 0;

  capture(filePath: string, content: string): SourceCorpusEntry {
    const absolutePath = path.resolve(filePath);
    const existing = this.entriesByPath.get(absolutePath);
    if (existing && existing.content === content) {
      this.entryHits++;
      return existing;
    }
    let lineStarts: readonly number[] | undefined;
    let lines: readonly string[] | undefined;
    const importsByFlavor = new Map<SourceImportFlavor, readonly string[]>();
    const corpus = this;
    const entry = Object.freeze({
      absolutePath,
      content,
      get lineStarts() {
        if (!lineStarts) {
          lineStarts = buildLineStarts(content);
          corpus.lineIndexes++;
        }
        return lineStarts;
      },
      get lines() {
        if (!lines) {
          lines = Object.freeze(content.split(/\r?\n/));
          corpus.lineArrays++;
        }
        return lines;
      },
      get imports() {
        return this.importsFor('all');
      },
      importsFor(flavor: SourceImportFlavor) {
        let imports = importsByFlavor.get(flavor);
        if (!imports) {
          imports = extractImports(content, flavor);
          importsByFlavor.set(flavor, imports);
          corpus.importIndexes++;
        }
        return imports;
      },
      categories: classifyPath(absolutePath),
      manifestKind: manifestKind(absolutePath),
    });
    this.entriesByPath.set(absolutePath, entry);
    if (!this.entriesByContent.has(content)) this.entriesByContent.set(content, entry);
    this.derivedEntries++;
    return entry;
  }

  get(filePath: string): SourceCorpusEntry | undefined {
    const entry = this.entriesByPath.get(path.resolve(filePath));
    if (entry) this.entryHits++;
    return entry;
  }

  lineForIndex(content: string, index: number): number {
    const entry = this.entriesByContent.get(content);
    if (!entry) return content.slice(0, index).split(/\r?\n/).length;
    this.entryHits++;
    this.lineLookups++;
    const bounded = Math.max(0, Math.min(index, content.length));
    this.linePrefixCharactersAvoided += bounded;
    let low = 0;
    let high = entry.lineStarts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entry.lineStarts[middle] <= bounded) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  lineCount(content: string): number {
    const entry = this.entriesByContent.get(content);
    if (!entry) return content.split('\n').length;
    this.entryHits++;
    this.lineLookups++;
    this.linePrefixCharactersAvoided += content.length;
    return entry.lineStarts.length;
  }

  stats(): SourceCorpusStats {
    return {
      files: this.entriesByPath.size,
      derivedEntries: this.derivedEntries,
      entryHits: this.entryHits,
      importIndexes: this.importIndexes,
      lineIndexes: this.lineIndexes,
      lineArrays: this.lineArrays,
      jsonParses: this.jsonParses,
      lineLookups: this.lineLookups,
      linePrefixCharactersAvoided: this.linePrefixCharactersAvoided,
    };
  }

  importsForContent(content: string, flavor: SourceImportFlavor = 'all'): readonly string[] | undefined {
    const entry = this.entriesByContent.get(content);
    if (entry) this.entryHits++;
    return entry?.importsFor(flavor);
  }

  linesForContent(content: string): readonly string[] | undefined {
    const entry = this.entriesByContent.get(content);
    if (entry) this.entryHits++;
    return entry?.lines;
  }

  pathCategories(filePath: string): readonly SourcePathCategory[] {
    return this.get(filePath)?.categories ?? classifyPath(filePath);
  }

  manifestKindForPath(filePath: string): SourceManifestKind | undefined {
    return this.get(filePath)?.manifestKind ?? manifestKind(filePath);
  }

  jsonForContent<T>(content: string): T {
    const cached = this.jsonByContent.get(content);
    if (cached) {
      this.entryHits++;
      if (cached.error) throw cached.error;
      return cached.value as T;
    }
    this.jsonParses++;
    try {
      const value = JSON.parse(content.replace(/^\uFEFF/, '')) as T;
      this.jsonByContent.set(content, { value });
      return value;
    } catch (error) {
      const parsedError = error instanceof Error ? error : new Error(String(error));
      this.jsonByContent.set(content, { error: parsedError });
      throw parsedError;
    }
  }
}

const sourceCorpusStorage = new AsyncLocalStorage<AnalyzerSourceCorpus>();

export function withSourceCorpus<T>(corpus: AnalyzerSourceCorpus, fn: () => Promise<T>): Promise<T> {
  return sourceCorpusStorage.run(corpus, fn);
}

export function captureSourceCorpusFile(filePath: string, content: string): SourceCorpusEntry | undefined {
  return sourceCorpusStorage.getStore()?.capture(filePath, content);
}

export function getActiveSourceCorpus(): AnalyzerSourceCorpus | undefined {
  return sourceCorpusStorage.getStore();
}

export function sourceLineForIndex(content: string, index: number): number {
  return sourceCorpusStorage.getStore()?.lineForIndex(content, index) ?? content.slice(0, index).split(/\r?\n/).length;
}

export function sourceLineCount(content: string): number {
  return sourceCorpusStorage.getStore()?.lineCount(content) ?? content.split('\n').length;
}

export function sourceImports(content: string, flavor: SourceImportFlavor = 'all'): readonly string[] | undefined {
  return sourceCorpusStorage.getStore()?.importsForContent(content, flavor);
}

export function sourceLines(content: string): readonly string[] | undefined {
  return sourceCorpusStorage.getStore()?.linesForContent(content);
}

export function sourcePathCategories(filePath: string): readonly SourcePathCategory[] {
  return sourceCorpusStorage.getStore()?.pathCategories(filePath) ?? classifyPath(filePath);
}

export function sourceManifestKind(filePath: string): SourceManifestKind | undefined {
  return sourceCorpusStorage.getStore()?.manifestKindForPath(filePath) ?? manifestKind(filePath);
}

export function sourceJson<T>(content: string): T {
  const corpus = sourceCorpusStorage.getStore();
  return corpus ? corpus.jsonForContent<T>(content) : JSON.parse(content.replace(/^\uFEFF/, '')) as T;
}
