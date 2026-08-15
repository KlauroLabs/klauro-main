import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface KnexTableColumn {
  name: string;
  type: string;
  referencesTable?: string;
}

interface KnexTable {
  name: string;
  columns: KnexTableColumn[];
  filePath: string;
  line: number;
}

interface KnexQuerySite {
  table: string;
  method: string;
  filePath: string;
  line: number;
}


















export class KnexAnalyzer extends BaseAnalyzer {
  constructor() {
    super('knex', 'Knex Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (allDeps['knex']) {
        return true;
      }
    }

    const ignorePatterns = ['node_modules/**', '**/node_modules/**', 'dist/**', '**/dist/**'];
    const sourceFiles = await glob('**/*.{ts,js,mts,mjs}', {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    for (const file of sourceFiles.slice(0, 400)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/knex\.schema\.(createTable|table)\s*\(/.test(content)) {
          return true;
        }
      } catch {

      }
    }

    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const exitPoints: CASContribution['exit_points'] = [];

    const ignorePatterns = this.getIgnorePatterns(context);
    const sourceFiles = await glob('**/*.{ts,js,mts,mjs}', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    const tables: KnexTable[] = [];
    const querySites: KnexQuerySite[] = [];

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/knex\.schema\.(createTable|table)\s*\(|\bknex\s*\(\s*['"`]/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      tables.push(...this.parseMigrationTables(content, relativePath));
      querySites.push(...this.parseQuerySites(content, relativePath));
    }

    this.emitSchemaGraph(tables, nodes, edges);
    exitPoints.push(...this.emitQueryExitPoints(querySites, nodes));

    return this.createContribution(nodes, edges, [], exitPoints, {
      orm: 'Knex',
      tablesFound: tables.length,
      querySitesFound: querySites.length,
      relationshipsFound: edges.filter(e => e.type === 'references').length,
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let sourceFiles: string[] = [];
    try {
      sourceFiles = await glob('**/*.{ts,js,mts,mjs}', {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
    } catch {
      return [];
    }

    const relevant: string[] = [];
    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      if (/knex\.schema\.(createTable|table)\s*\(|\bknex\s*\(\s*['"`]/.test(content)) {
        relevant.push(file);
      }
    }
    return relevant.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const tables: KnexTable[] = [];
    const querySites: KnexQuerySite[] = [];
    if (/knex\.schema\.(createTable|table)\s*\(|\bknex\s*\(\s*['"`]/.test(content)) {
      tables.push(...this.parseMigrationTables(content, context.relativePath));
      querySites.push(...this.parseQuerySites(content, context.relativePath));
    }

    this.emitSchemaGraph(tables, nodes, edges);
    const exitPoints = this.emitQueryExitPoints(querySites, nodes);

    const exports = tables.map(t => t.name);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      exitPoints,
      [],
      exports
    );
  }

  private emitSchemaGraph(tables: KnexTable[], nodes: CASNode[], edges: CASEdge[]): void {
    const tableByName = new Map<string, KnexTable>();
    for (const table of tables) tableByName.set(table.name, table);

    for (const table of tables) {
      const nodeId = `entity_knex_${table.name.toLowerCase()}`;
      const fields = table.columns.map(col => ({
        name: col.name,
        type: col.type,
        relation: !!col.referencesTable,
      }));

      nodes.push(this.createNode(
        nodeId,
        table.name,
        'entity',
        3,
        table.filePath,
        table.line,
        undefined,
        {
          orm: 'Knex',
          source: 'knex_migration_table',
          tableName: table.name,
          fields,
          annotations: ['KnexMigrationTable'],
          subcategories: ['entity', 'knex'],
        }
      ));

      for (const col of table.columns) {
        const fieldNodeId = `field_knex_${table.name.toLowerCase()}_${col.name.toLowerCase()}`;
        nodes.push(this.createNode(
          fieldNodeId,
          col.name,
          'field',
          4,
          table.filePath,
          table.line,
          undefined,
          {
            orm: 'Knex',
            source: 'knex_column',
            entity: table.name,
            dataType: col.type,
            subcategories: ['field', 'knex'],
          }
        ));
        edges.push(this.createEdge(
          `knex_field_${table.name}_${col.name}`,
          nodeId,
          fieldNodeId,
          'has_field',
          'database',
          { attributes: { field: col.name, type: col.type } }
        ));

        if (col.referencesTable && tableByName.has(col.referencesTable)) {
          edges.push(this.createEdge(
            `knex_fk_${table.name}_${col.name}_${col.referencesTable}`,
            nodeId,
            `entity_knex_${col.referencesTable.toLowerCase()}`,
            'references',
            'database',
            {
              attributes: {
                relationType: 'ManyToOne',
                field: col.name,
                targetEntity: col.referencesTable,
                via: 'foreign-key',
              },
            }
          ));
        }
      }
    }
  }

  private emitQueryExitPoints(querySites: KnexQuerySite[], nodes: CASNode[]): NonNullable<CASContribution['exit_points']> {
    const READ_METHODS = new Set(['select', 'where', 'first', 'pluck', 'count']);
    return querySites.slice(0, 40).map((site, index) => {
      const nodeId = `query_knex_${this.sanitizeId(site.table)}_${this.sanitizeId(site.filePath)}_${site.line}_${index}`;
      nodes.push(this.createNode(
        nodeId,
        `Knex ${site.method} on ${site.table}`,
        'database_query',
        4,
        site.filePath,
        site.line,
        undefined,
        {
          orm: 'Knex',
          source: 'knex_query_site',
          table: site.table,
          method: site.method,
          subcategories: ['query', 'knex'],
        }
      ));
      return this.createExitPoint(
        `exit_knex_${this.sanitizeId(site.table)}_${this.sanitizeId(site.filePath)}_${site.line}_${index}`,
        nodeId,
        'database',
        `Knex ${site.method} on ${site.table}`,
        `Knex query-builder ${site.method} call against table '${site.table}'.`,
        { resource: site.table },
        { action: READ_METHODS.has(site.method) ? 'read' : 'write' },
        { orm: 'Knex', table: site.table, method: site.method, file: site.filePath, line: site.line }
      );
    });
  }




  private parseMigrationTables(content: string, filePath: string): KnexTable[] {
    const tables: KnexTable[] = [];



    const createRegex = /(?:knex\.schema\.)?\.?createTable\s*\(\s*['"`](\w+)['"`]\s*,\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = createRegex.exec(content)) !== null) {
      const name = match[1];
      const bodyStart = createRegex.lastIndex - 1;
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) continue;
      const line = content.slice(0, match.index).split('\n').length;
      tables.push({
        name,
        columns: this.parseColumns(body),
        filePath,
        line,
      });
    }
    return tables;
  }




  private parseColumns(body: string): KnexTableColumn[] {
    const columns: KnexTableColumn[] = [];
    const colRegex = /table\.(\w+)\s*\(\s*['"`](\w+)['"`][^)]*\)([^;]*)/g;
    let match: RegExpExecArray | null;
    while ((match = colRegex.exec(body)) !== null) {
      const type = match[1];
      if (type === 'index' || type === 'unique' || type === 'primary' || type === 'dropColumn') continue;
      const name = match[2];
      const chain = match[3] || '';
      const refMatch = /\.inTable\s*\(\s*['"`](\w+)['"`]\s*\)/.exec(chain);
      columns.push({
        name,
        type,
        referencesTable: refMatch?.[1],
      });
    }
    return columns;
  }




  private parseQuerySites(content: string, filePath: string): KnexQuerySite[] {
    const sites: KnexQuerySite[] = [];
    const lines = content.split(/\r?\n/);
    const callRegex = /knex(?:\s*\(\s*['"`](\w+)['"`]\s*\))?(?:\.[\w]+)*?\.(select|where|insert|update|del|delete|first|pluck|count)\s*\(/;
    lines.forEach((line, index) => {
      const match = callRegex.exec(line);
      if (!match) return;
      const table = match[1] || 'unknown';
      sites.push({ table, method: match[2], filePath, line: index + 1 });
    });
    return sites;
  }

  private extractBalanced(content: string, openIndex: number): string | null {
    if (content[openIndex] !== '{') return null;
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return content.slice(openIndex + 1, i);
      }
    }
    return null;
  }

  protected getCapabilities(): string[] {
    return ['knex-migration-tables', 'knex-columns', 'knex-query-sites'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}
