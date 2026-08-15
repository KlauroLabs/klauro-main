import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASNode } from '../../types/cas.types';
import { cachedGlob as glob } from '../core/glob-cache';
import * as fs from 'fs-extra';
import * as path from 'path';

































interface DetectedStore {

  storePath: string;

  entityName: string;
  line: number;
  fields: string[];

  roundTrip: boolean;
}

const WRITE_CALLEES = ['writeFileSync', 'writeFile', 'outputFileSync', 'outputFile'];
const READ_CALLEES = ['readFileSync', 'readFile'];

const WRITE_JSON_CALLEES = ['writeJsonSync', 'writeJson', 'outputJsonSync', 'outputJson'];
const READ_JSON_CALLEES = ['readJsonSync', 'readJson'];

interface CallSite {
  args: string[];
  index: number;
}










function findCalls(content: string, callees: string[]): CallSite[] {
  const sites: CallSite[] = [];
  for (const callee of callees) {


    const pattern = new RegExp(`\\b${callee}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const open = match.index + match[0].length - 1;
      let depth = 0;
      let close = -1;
      let quote: string | undefined;
      for (let i = open; i < content.length; i++) {
        const character = content[i];
        if (quote) {
          if (character === '\\') { i++; continue; }
          if (character === quote) quote = undefined;
          continue;
        }
        if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
        if (character === '(' || character === '[' || character === '{') depth++;
        else if (character === ')' || character === ']' || character === '}') {
          depth--;
          if (depth === 0) { close = i; break; }
        }
      }
      if (close < 0) continue;
      sites.push({ args: splitTopLevelArgs(content.slice(open + 1, close)), index: match.index });
    }
  }
  return sites.sort((a, b) => a.index - b.index);
}


function splitTopLevelArgs(argumentList: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i <= argumentList.length; i++) {
    const character = argumentList[i];
    if (i === argumentList.length) { args.push(argumentList.slice(start)); break; }
    if (quote) {
      if (character === '\\') { i++; continue; }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') depth++;
    else if (character === ')' || character === ']' || character === '}') depth--;
    else if (character === ',' && depth === 0) { args.push(argumentList.slice(start, i)); start = i + 1; }
  }
  return args.map(argument => argument.trim()).filter(argument => argument.length > 0);
}









export function jsonFileNameFrom(expression: string): string | undefined {
  const match = /([A-Za-z0-9_.-]+\.json)\b/.exec(expression);
  if (!match) return undefined;
  const fileName = match[1];



  const ECOSYSTEM_FILES = new Set([
    'package.json', 'package-lock.json', 'tsconfig.json', 'composer.json',
    'composer.lock.json', 'jsconfig.json', 'deno.json', 'bun.lock.json',
    'angular.json', 'nx.json', 'lerna.json', 'turbo.json', 'manifest.json',
  ]);
  if (ECOSYSTEM_FILES.has(fileName.toLowerCase())) return undefined;
  return fileName;
}



export function entityNameFromJsonFile(fileName: string): string {
  const stem = fileName.replace(/\.json$/i, '');
  const words = stem.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return stem;
  return words
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}







export function serializedFieldNames(payload: string): string[] {
  const stringify = /JSON\.stringify\s*\(\s*(\{[\s\S]*)$/.exec(payload);
  const literal = stringify ? stringify[1] : (payload.trim().startsWith('{') ? payload.trim() : undefined);
  if (!literal) return [];

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





      const key = /^\s*(?:['"`]?)([A-Za-z_$][A-Za-z0-9_$]*)(?:['"`]?)\s*(?::|$)/.exec(segment);
      if (key) fields.push(key[1]);
      keyStart = i + 1;
    }
  }
  return Array.from(new Set(fields));
}





export function detectJsonFileStores(content: string): DetectedStore[] {
  const lineOf = (index: number): number => content.slice(0, index).split('\n').length;





  const aliases = new Map<string, string>();



  const DECLARATION = /\b(?:const|let|var)\s+([^;\n]{1,400})/g;
  let declaration: RegExpExecArray | null;
  while ((declaration = DECLARATION.exec(content)) !== null) {
    for (const declarator of splitTopLevelArgs(declaration[1])) {
      const assignment = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]+)$/.exec(declarator);
      if (!assignment) continue;
      const fileName = jsonFileNameFrom(assignment[2]);
      if (fileName) aliases.set(assignment[1], fileName);
    }
  }
  const resolveFileName = (expression: string): string | undefined => {
    const direct = jsonFileNameFrom(expression);
    if (direct) return direct;
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.exec(expression.trim());
    return identifier ? aliases.get(identifier[0]) : undefined;
  };

  const written = new Map<string, { line: number; fields: string[] }>();
  const collectWrites = (callees: string[], payloadIsJson: boolean): void => {
    for (const site of findCalls(content, callees)) {
      if (site.args.length < 2) continue;
      const fileName = resolveFileName(site.args[0]);
      if (!fileName) continue;
      const payload = site.args[1];

      if (!payloadIsJson && !/JSON\.stringify/.test(payload)) continue;
      const fields = serializedFieldNames(payload);
      const existing = written.get(fileName);
      if (!existing || (existing.fields.length === 0 && fields.length > 0)) {
        written.set(fileName, { line: lineOf(site.index), fields });
      }
    }
  };
  collectWrites(WRITE_CALLEES, false);
  collectWrites(WRITE_JSON_CALLEES, true);

  const read = new Set<string>();
  const collectReads = (callees: string[], impliesParse: boolean): void => {
    for (const site of findCalls(content, callees)) {
      if (site.args.length === 0) continue;
      const fileName = resolveFileName(site.args[0]);
      if (!fileName) continue;
      if (!impliesParse) {




        const window = content.slice(Math.max(0, site.index - 240), site.index + 400);
        if (!/JSON\.parse/.test(window)) continue;
      }
      read.add(fileName);
    }
  };
  collectReads(READ_CALLEES, false);
  collectReads(READ_JSON_CALLEES, true);

  const stores: DetectedStore[] = [];
  for (const [fileName, write] of written) {
    if (!read.has(fileName)) continue;
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


        store_path: store.storePath,
        is_persisted: true,
        persistence: 'json-file',


        ...(store.fields.length > 0
          ? { field_count: store.fields.length, columns: store.fields.map(name => ({ name, type: 'unknown', nullable: true })) }
          : {}),
        evidence: 'read-write-round-trip',
      },
    ));
  }



  private async safeRead(projectPath: string, relativeFile: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    } catch {
      return undefined;
    }
  }
}
