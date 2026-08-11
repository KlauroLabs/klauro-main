import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';
import { cachedGlob as glob } from '../core/glob-cache';
import * as fs from 'fs-extra';
import * as path from 'path';

/**
 * SQL DDL as an entity source.
 *
 * WHY THIS EXISTS — measured 2026-08-11 on a real customer-shaped repo:
 * `.sql` was in NO language registry, no analyzer claimed it, and nothing in the
 * product read `CREATE TABLE` anywhere. A TypeScript/Express backend that persists
 * through raw `pg` queries (`INSERT INTO generation_jobs`, `INSERT INTO
 * voice_profiles`) alongside a `db/schema.sql` therefore produced ZERO domain
 * entities. Only 3 entities were found repo-wide, all from the Python side.
 *
 * The consequence was not local. Capability↔flow linkage is entity-driven, so with
 * no entities every one of that repo's 38 flows reported `no-entity-evidence` and
 * `flows_to_capabilities` was 0/38 — flows named `POST / (SongService)` and
 * `GET /:id (VoiceProfileService)` sat unlinked while the tables they write were
 * declared in plain sight. The linker was right to refuse to guess; it was starved.
 *
 * A `CREATE TABLE` statement is the STRONGEST entity evidence a repo can offer —
 * the author declaring, in the database's own language, exactly what is persisted
 * and with which columns. Stronger than an ORM model class (which may be a DTO, a
 * view, or dead) and far stronger than a name heuristic. Reading it is the
 * repo-agnostic fix: any project with SQL DDL gets entities, whatever ORM it uses
 * or doesn't, in any host language.
 *
 * Deliberately NOT a full SQL parser. It recognises table and column declarations
 * and nothing else; anything it cannot parse is skipped rather than guessed at.
 */

interface ParsedColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  references?: { table: string; column?: string };
}

interface ParsedTable {
  name: string;
  columns: ParsedColumn[];
  line: number;
}

/** `CREATE TABLE [IF NOT EXISTS] [schema.]name (` — quoted or bare, any dialect. */
const CREATE_TABLE = /CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\]\w.]+)\s*\(/gi;

/** Constraint/rule lines inside a CREATE TABLE body that are not columns. */
const NON_COLUMN_LEADERS = new Set([
  'primary', 'foreign', 'unique', 'check', 'constraint', 'exclude', 'like', 'index', 'key', 'fulltext', 'spatial',
]);

function stripQuotes(identifier: string): string {
  return identifier.replace(/[`"[\]]/g, '').trim();
}

/** `public.voice_profiles` -> `voice_profiles`: the schema qualifier is deployment
 *  placement, not entity identity. */
function bareTableName(raw: string): string {
  const cleaned = stripQuotes(raw);
  const segments = cleaned.split('.').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : cleaned;
}

/**
 * `voice_profiles` -> `VoiceProfile`, `generation_jobs` -> `GenerationJob`.
 *
 * Table names are conventionally snake_case and plural; entity names elsewhere in
 * the CAS are PascalCase and singular, and the linker matches entities by
 * normalized name. Presenting the raw table name would leave `voice_profiles`
 * unable to meet a `VoiceProfile` referenced anywhere else.
 *
 * Singularisation is deliberately conservative English morphology on the LAST
 * segment only — no dictionary, no domain words. It cannot invent a name: the
 * output is always a transliteration of the author's own identifier, and the
 * original is preserved verbatim on the node so nothing is lost.
 */
function entityNameFromTable(table: string): string {
  const words = table.split(/[_\-\s]+/).filter(Boolean);
  if (!words.length) return table;
  const last = words[words.length - 1];
  words[words.length - 1] = singularize(last);
  return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

function singularize(word: string): string {
  const lower = word.toLowerCase();
  // Never strip from something already singular-looking or too short to be safe.
  if (lower.length < 4 || !lower.endsWith('s') || lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is')) {
    return word;
  }
  if (lower.endsWith('ies')) return word.slice(0, -3) + 'y';   // categories -> category
  if (lower.endsWith('ses') || lower.endsWith('xes') || lower.endsWith('zes') || lower.endsWith('ches') || lower.endsWith('shes')) {
    return word.slice(0, -2);                                   // addresses -> address
  }
  return word.slice(0, -1);                                     // songs -> song
}

/** Splits a CREATE TABLE body on top-level commas — `NUMERIC(10,2)` must not split. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if (character === '(') depth++;
    else if (character === ')') depth--;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Body of the CREATE TABLE that starts at `openParenIndex`, by paren matching —
 *  a regex cannot do this correctly once a column type carries its own parens. */
function tableBody(content: string, openParenIndex: number): string | undefined {
  let depth = 0;
  for (let index = openParenIndex; index < content.length; index++) {
    const character = content[index];
    if (character === '(') depth++;
    else if (character === ')') {
      depth--;
      if (depth === 0) return content.slice(openParenIndex + 1, index);
    }
  }
  return undefined; // unbalanced: skip rather than guess
}

function parseColumns(body: string): ParsedColumn[] {
  const columns: ParsedColumn[] = [];
  for (const rawPart of splitTopLevel(body)) {
    const part = rawPart.trim().replace(/\s+/g, ' ');
    if (!part) continue;
    const leader = stripQuotes(part.split(/[\s(]/)[0] || '').toLowerCase();
    if (NON_COLUMN_LEADERS.has(leader)) continue;

    const match = /^([`"[\]\w]+)\s+(.+)$/.exec(part);
    if (!match) continue;
    const name = stripQuotes(match[1]);
    if (!name) continue;
    const rest = match[2];
    const type = (rest.match(/^([\w]+(?:\s+\w+)?(?:\([^)]*\))?)/)?.[1] || rest).trim();

    const referencesMatch = /REFERENCES\s+([`"[\]\w.]+)\s*(?:\(\s*([`"[\]\w]+)\s*\))?/i.exec(rest);
    columns.push({
      name,
      type,
      // NOT NULL is an explicit declaration; absence means nullable in every dialect.
      nullable: !/\bNOT\s+NULL\b/i.test(rest),
      primaryKey: /\bPRIMARY\s+KEY\b/i.test(rest),
      ...(referencesMatch
        ? { references: { table: bareTableName(referencesMatch[1]), ...(referencesMatch[2] ? { column: stripQuotes(referencesMatch[2]) } : {}) } }
        : {}),
    });
  }
  return columns;
}

/** Table-level `PRIMARY KEY (a, b)` / `FOREIGN KEY (x) REFERENCES t(y)`, which
 *  carry the same evidence as the inline forms and are equally common. */
function applyTableConstraints(body: string, columns: ParsedColumn[]): void {
  const byName = new Map(columns.map(column => [column.name.toLowerCase(), column]));
  for (const rawPart of splitTopLevel(body)) {
    const part = rawPart.trim().replace(/\s+/g, ' ');
    const primary = /^(?:CONSTRAINT\s+[`"[\]\w]+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(part);
    if (primary) {
      for (const name of primary[1].split(',')) {
        const column = byName.get(stripQuotes(name).toLowerCase());
        if (column) column.primaryKey = true;
      }
      continue;
    }
    const foreign = /^(?:CONSTRAINT\s+[`"[\]\w]+\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([`"[\]\w.]+)\s*(?:\(\s*([`"[\]\w]+)\s*\))?/i.exec(part);
    if (foreign) {
      const column = byName.get(stripQuotes(foreign[1].split(',')[0]).toLowerCase());
      if (column) {
        column.references = { table: bareTableName(foreign[2]), ...(foreign[3] ? { column: stripQuotes(foreign[3]) } : {}) };
      }
    }
  }
}

export function parseSqlTables(content: string): ParsedTable[] {
  // Strip comments first so a commented-out CREATE TABLE is never treated as a
  // real declaration (migration files are full of them).
  const withoutComments = content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');

  const tables: ParsedTable[] = [];
  const seen = new Set<string>();
  CREATE_TABLE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREATE_TABLE.exec(withoutComments)) !== null) {
    const name = bareTableName(match[1]);
    if (!name) continue;
    const openParenIndex = withoutComments.indexOf('(', match.index + match[0].length - 1);
    if (openParenIndex === -1) continue;
    const body = tableBody(withoutComments, openParenIndex);
    if (body === undefined) continue;
    // A re-declared table (`DROP TABLE` then recreate across migrations) is one
    // entity, not several — keep the first, which is the canonical declaration.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const columns = parseColumns(body);
    applyTableConstraints(body, columns);
    if (columns.length === 0) continue; // nothing declared: no evidence to report
    tables.push({
      name,
      columns,
      line: withoutComments.slice(0, match.index).split('\n').length,
    });
  }
  return tables;
}

export class SqlSchemaAnalyzer extends BaseAnalyzer {
  constructor() {
    super('sql-schema', 'SQL Schema Analyzer', '1.0.0', 'language');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return (await this.getRelevantFiles(projectPath)).length > 0;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.sql', '**/*.ddl'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
      absolute: false,
    });
    const matches: string[] = [];
    for (const relativeFile of files) {
      const content = await this.safeRead(projectPath, relativeFile);
      // Only files that actually declare a table — a `.sql` of seed INSERTs or
      // ad-hoc SELECTs is not schema evidence and must not be reported as such.
      if (!content || !/CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE/i.test(content)) continue;
      matches.push(relativeFile);
    }
    return matches.sort();
  }

  async analyze(context: AnalysisContext) {
    const files = await this.getRelevantFiles(context.projectPath);
    const nodes: CASNode[] = [];
    for (const relativeFile of files) {
      nodes.push(...await this.analyzeSchemaFile(context.projectPath, relativeFile));
    }
    return this.createContribution(nodes, [], [], [], {
      schema_surface: 'sql-ddl',
      schema_files: files.length,
      declared_tables: nodes.filter(node => node.type === 'model').length,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes = await this.analyzeSchemaFile(context.projectPath, context.relativePath);
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
    return ['sql-ddl-entity-extraction', 'sql-table-relationship-detection'];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'schema' : 'schema detail';
  }

  /** Unreadable file is skipped, never fatal: one bad path must not fail an
   *  analysis (matches the sibling template analyzers). */
  private async safeRead(projectPath: string, relativeFile: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
    } catch {
      return undefined;
    }
  }

  private async analyzeSchemaFile(projectPath: string, relativeFile: string): Promise<CASNode[]> {
    const content = await this.safeRead(projectPath, relativeFile);
    if (!content) return [];
    const nodes: CASNode[] = [];

    for (const table of parseSqlTables(content)) {
      const entityName = entityNameFromTable(table.name);
      // `model` so downstream entity identification treats this as a persisted
      // domain type — which it demonstrably is: a CREATE TABLE is persistence
      // evidence by definition, which is exactly what the entity gate requires.
      const node = this.createNode(
        `sql_table_${this.sanitizeId(relativeFile)}_${this.sanitizeId(table.name)}`,
        entityName,
        'model',
        3,
        relativeFile,
        table.line,
        table.line,
        {
          schema_surface: 'sql-ddl',
          // The author's own identifier, preserved verbatim: the PascalCase name
          // above is for matching, this is the ground truth.
          table_name: table.name,
          is_persisted: true,
          persistence: 'sql-table',
          column_count: table.columns.length,
          columns: table.columns.map(column => ({
            name: column.name,
            type: column.type,
            nullable: column.nullable,
            ...(column.primaryKey ? { primary_key: true } : {}),
            ...(column.references ? { references_table: column.references.table, ...(column.references.column ? { references_column: column.references.column } : {}) } : {}),
          })),
          primary_key: table.columns.filter(column => column.primaryKey).map(column => column.name),
          // Foreign keys are declared relationships between entities — the
          // deterministic ground for ERD cardinality, which otherwise reads "?".
          references_tables: [...new Set(table.columns.map(column => column.references?.table).filter((name): name is string => Boolean(name)))],
          subcategories: ['schema', 'sql-table'],
        },
      );
      nodes.push(node);
    }
    return nodes;
  }
}
