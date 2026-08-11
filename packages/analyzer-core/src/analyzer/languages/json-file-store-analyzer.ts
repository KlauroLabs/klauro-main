import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASNode } from '../../types/cas.types';
import { cachedGlob as glob } from '../core/glob-cache';
import * as fs from 'fs-extra';
import * as path from 'path';

/**
 * A JSON file read AND written at a stable path is a persistent store.
 *
 * WHY THIS EXISTS — measured 2026-08-11 on a real customer-shaped repo:
 * `persistence: 'sql-table'` was the ONLY kind of persistence the entire product
 * could recognise. A gateway/CLI repo (12,795 nodes, 35 HTTP journeys, POST and
 * DELETE routes) shipped `data.entities: 0`, every capability carried
 * `entities: []`, and the payload's own caveat read "No data lineage derived".
 * The repo has no ORM and no DDL — it keeps its state in JSON files that modules
 * read and write directly. That is a huge share of real Node/CLI/tool repos, and
 * for every one of them the entity layer was empty, which starves the
 * entity-driven capability↔flow linkage and the whole data/lineage surface.
 *
 * The evidence standard is deliberately narrow, because "a program touched a
 * file" is not persistence. A store is recognised only when ONE module both:
 *   - SERIALISES to a path (a write call whose argument is JSON.stringify), and
 *   - DESERIALISES from that same path (a read whose result is JSON.parse).
 * Round-tripping the same path is the author declaring that the file outlives the
 * process — the file-system equivalent of a CREATE TABLE. A write-only path is a
 * log or an export; a read-only path is configuration or a fixture. Neither is a
 * persisted entity, and neither is reported as one.
 *
 * The entity is named after the FILE, not the module: the file is the store, and
 * one module may own several. Fields are recorded only when the serialised shape
 * is statically visible; otherwise the entity ships with no fields rather than an
 * invented schema — a store with unknown columns is still a store.
 *
 * Repo-agnostic by construction: it keys on the fs/JSON call shape that every
 * JavaScript and TypeScript project shares, never on directory names, framework
 * names, or a list of known filenames.
 */

interface DetectedStore {
  /** The JSON file being round-tripped, as written in the source. */
  storePath: string;
  /** Entity name derived from the store file's basename. */
  entityName: string;
  line: number;
  fields: string[];
  /** True when the same source file both serialises to and parses from storePath. */
  roundTrip: boolean;
}

/** Writes whose payload we can see: fs.writeFile / writeFileSync / promises.writeFile / fs.outputJson-style. */
const WRITE_CALL = /\b(?:writeFileSync|writeFile|outputFileSync|outputFile)\s*\(\s*([^,]{1,200}?)\s*,\s*([\s\S]{0,400}?)\)/g;
/** Reads whose result we can see being parsed. */
const READ_CALL = /\b(?:readFileSync|readFile)\s*\(\s*([^,)]{1,200}?)\s*[,)]/g;
/** `writeJson`/`readJson` (fs-extra) serialise implicitly — the JSON is the API. */
const WRITE_JSON_CALL = /\b(?:writeJsonSync|writeJson|outputJsonSync|outputJson)\s*\(\s*([^,]{1,200}?)\s*,\s*([\s\S]{0,400}?)\)/g;
const READ_JSON_CALL = /\b(?:readJsonSync|readJson)\s*\(\s*([^,)]{1,200}?)\s*[,)]/g;

/**
 * The JSON filename a path expression ends in, or undefined.
 *
 * Handles the shapes source code actually uses — a literal, a template literal,
 * and `path.join(dir, 'name.json')` — by looking for a `.json` filename token
 * anywhere in the expression. A path assembled entirely from variables yields
 * nothing, which is correct: we cannot name a store we cannot see.
 */
export function jsonFileNameFrom(expression: string): string | undefined {
  const match = /([A-Za-z0-9_.-]+\.json)\b/.exec(expression);
  if (!match) return undefined;
  const fileName = match[1];
  // A lockfile/manifest is the ECOSYSTEM's file, not this product's state.
  // spec-purity:vocab-ok — closed ecosystem fact (package-manager metadata), and
  // it only SUPPRESSES output; it cannot categorise a repo.
  const ECOSYSTEM_FILES = new Set([
    'package.json', 'package-lock.json', 'tsconfig.json', 'composer.json',
    'composer.lock.json', 'jsconfig.json', 'deno.json', 'bun.lock.json',
    'angular.json', 'nx.json', 'lerna.json', 'turbo.json', 'manifest.json',
  ]);
  if (ECOSYSTEM_FILES.has(fileName.toLowerCase())) return undefined;
  return fileName;
}

/** `google-state.json` -> `GoogleState`; `topics.json` -> `Topics`. The author's
 *  own filename, mechanically cased — never a synonym or an invented noun. */
export function entityNameFromJsonFile(fileName: string): string {
  const stem = fileName.replace(/\.json$/i, '');
  const words = stem.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return stem;
  return words
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * Top-level keys of the object literal being serialised, when one is visible.
 *
 * Only a literal counts. `JSON.stringify(state)` tells us a store exists but not
 * its shape, and guessing the shape from a variable name would be fabrication.
 */
export function serializedFieldNames(payload: string): string[] {
  const stringify = /JSON\.stringify\s*\(\s*(\{[\s\S]*)$/.exec(payload);
  const literal = stringify ? stringify[1] : (payload.trim().startsWith('{') ? payload.trim() : undefined);
  if (!literal) return [];
  // Walk to the matching brace so a nested object does not end the scan early.
  let depth = 0;
  let end = -1;
  for (let i = 0; i < literal.length; i++) {
    const character = literal[i];
    if (character === '{') depth++;
    else if (character === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return [];
  const body = literal.slice(1, end);
  const fields: string[] = [];
  let nesting = 0;
  let keyStart = 0;
  for (let i = 0; i <= body.length; i++) {
    const character = body[i];
    if (character === '{' || character === '[' || character === '(') nesting++;
    else if (character === '}' || character === ']' || character === ')') nesting--;
    if (nesting !== 0) continue;
    if (i === body.length || character === ',') {
      const segment = body.slice(keyStart, i);
      const key = /^\s*(?:['"`]?)([A-Za-z_$][A-Za-z0-9_$]*)(?:['"`]?)\s*:/.exec(segment);
      if (key) fields.push(key[1]);
      keyStart = i + 1;
    }
  }
  return Array.from(new Set(fields));
}

/**
 * Stores this source file round-trips. Exported for direct testing: the parse is
 * the whole risk surface, so it is tested without a filesystem or an analyzer.
 */
export function detectJsonFileStores(content: string): DetectedStore[] {
  const lineOf = (index: number): number => content.slice(0, index).split('\n').length;

  const written = new Map<string, { line: number; fields: string[] }>();
  const collectWrites = (pattern: RegExp, payloadIsJson: boolean): void => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const fileName = jsonFileNameFrom(match[1]);
      if (!fileName) continue;
      const payload = match[2] || '';
      // A plain writeFile of a non-JSON payload is not a JSON store.
      if (!payloadIsJson && !/JSON\.stringify/.test(payload)) continue;
      const fields = serializedFieldNames(payload);
      const existing = written.get(fileName);
      if (!existing || (existing.fields.length === 0 && fields.length > 0)) {
        written.set(fileName, { line: lineOf(match.index), fields });
      }
    }
  };
  collectWrites(WRITE_CALL, false);
  collectWrites(WRITE_JSON_CALL, true);

  const read = new Set<string>();
  const collectReads = (pattern: RegExp, impliesParse: boolean): void => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const fileName = jsonFileNameFrom(match[1]);
      if (!fileName) continue;
      if (!impliesParse) {
        // Require the read to be parsed as JSON somewhere — the call itself is
        // shape-blind, so a `readFileSync` of a template is not a store read.
        // Looking at the surrounding window keeps this local and cheap.
        const window = content.slice(Math.max(0, match.index - 200), match.index + 400);
        if (!/JSON\.parse/.test(window)) continue;
      }
      read.add(fileName);
    }
  };
  collectReads(READ_CALL, false);
  collectReads(READ_JSON_CALL, true);

  const stores: DetectedStore[] = [];
  for (const [fileName, write] of written) {
    if (!read.has(fileName)) continue; // write-only: an export or a log, not a store
    stores.push({
      storePath: fileName,
      entityName: entityNameFromJsonFile(fileName),
      line: write.line,
      fields: write.fields,
      roundTrip: true,
    });
  }
  return stores.sort((a, b) => a.storePath.localeCompare(b.storePath));
}

export class JsonFileStoreAnalyzer extends BaseAnalyzer {
  constructor() {
    super('json-file-store', 'JSON File Store Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.getRelevantFiles(projectPath)).length > 0;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.mts', '**/*.cts'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
      absolute: false,
    });
    const matches: string[] = [];
    for (const relativeFile of files) {
      const content = await this.safeRead(projectPath, relativeFile);
      // Cheap pre-filter before the real detection: a file that never mentions a
      // write call and a .json path cannot declare a store.
      if (!content) continue;
      if (!/\.json\b/.test(content)) continue;
      if (!/write(?:File|Json)/.test(content)) continue;
      if (detectJsonFileStores(content).length === 0) continue;
      matches.push(relativeFile);
    }
    return matches.sort();
  }

  async analyze(context: AnalysisContext) {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    for (const relativeFile of files) {
      nodes.push(...await this.analyzeStoreFile(context.projectPath, relativeFile));
    }
    return this.createContribution(nodes, [], [], [], {
      schema_surface: 'json-file-store',
      store_modules: files.length,
      declared_stores: nodes.length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes = await this.analyzeStoreFile(context.projectPath, context.relativePath);
    const content = await this.safeRead(context.projectPath, context.relativePath) || '';
    const stat = await fs.stat(path.join(context.projectPath, context.relativePath));
    return this.createFileAnalysisResult(
      path.join(context.projectPath, context.relativePath),
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      [],
      [],
      [],
      [],
      [],
    );
  }

  protected getCapabilities(): string[] {
    return ['json-file-store-entity-extraction'];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'schema' : 'schema detail';
  }

  private async analyzeStoreFile(projectPath: string, relativeFile: string): Promise<CASNode[]> {
    const content = await this.safeRead(projectPath, relativeFile);
    if (!content) return [];
    return detectJsonFileStores(content).map(store => this.createNode(
      `json_store_${this.sanitizeId(relativeFile)}_${this.sanitizeId(store.storePath)}`,
      store.entityName,
      'model',
      3,
      relativeFile,
      store.line,
      store.line,
      {
        schema_surface: 'json-file-store',
        // The author's own filename, preserved verbatim: entityName above is for
        // matching, this is the ground truth.
        store_path: store.storePath,
        is_persisted: true,
        persistence: 'json-file',
        // Absent when the serialised shape is a variable rather than a literal —
        // an unknown schema is reported as unknown, never invented.
        ...(store.fields.length > 0
          ? { field_count: store.fields.length, columns: store.fields.map(name => ({ name, type: 'unknown', nullable: true })) }
          : {}),
        evidence: 'read-write-round-trip',
      },
    ));
  }

  /** Unreadable file is skipped, never fatal — one bad path must not fail an
   *  analysis (matches the sibling schema analyzers). */
  private async safeRead(projectPath: string, relativeFile: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    } catch {
      return undefined;
    }
  }
}
