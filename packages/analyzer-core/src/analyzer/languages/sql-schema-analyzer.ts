import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../core/base-analyzer';
import { CASNode } from '../../types/cas.types';
import { cachedGlob as glob } from '../core/glob-cache';
import * as fs from 'fs-extra';
import * as path from 'path';




























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


const CREATE_TABLE = /CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\]\w.]+)\s*\(/gi;


const NON_COLUMN_LEADERS = new Set([
  'primary', 'foreign', 'unique', 'check', 'constraint', 'exclude', 'like', 'index', 'key', 'fulltext', 'spatial',
]);

function stripQuotes(identifier: string): string {
  return identifier.replace(/[`"[\]]/g, '').trim();
}



function bareTableName(raw: string): string {
  const cleaned = stripQuotes(raw);
  const segments = cleaned.split('.').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : cleaned;
}














function entityNameFromTable(table: string): string {
  const words = table.split(/[_\-\s]+/).filter(Boolean);
  if (!words.length) return table;
  const last = words[words.length - 1];
  words[words.length - 1] = singularize(last);
  return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

function singularize(word: string): string {
  const lower = word.toLowerCase();

  if (lower.length < 4 || !lower.endsWith('s') || lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is')) {
    return word;
  }
  if (lower.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (lower.endsWith('ses') || lower.endsWith('xes') || lower.endsWith('zes') || lower.endsWith('ches') || lower.endsWith('shes')) {
    return word.slice(0, -2);
  }
  return word.slice(0, -1);
}


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
  return undefined;
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

      nullable: !/\bNOT\s+NULL\b/i.test(rest),
      primaryKey: /\bPRIMARY\s+KEY\b/i.test(rest),
      ...(referencesMatch
        ? { references: { table: bareTableName(referencesMatch[1]), ...(referencesMatch[2] ? { column: stripQuotes(referencesMatch[2]) } : {}) } }
        : {}),
    });
  }
  return columns;
}



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


    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const columns = parseColumns(body);
    applyTableConstraints(body, columns);
    if (columns.length === 0) continue;
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


          references_tables: [...new Set(table.columns.map(column => column.references?.table).filter((name): name is string => Boolean(name)))],
          subcategories: ['schema', 'sql-table'],
        },
      );
      nodes.push(node);
    }
    return nodes;
  }
}
