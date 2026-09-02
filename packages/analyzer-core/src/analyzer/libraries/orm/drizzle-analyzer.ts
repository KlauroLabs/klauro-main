import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface DrizzleColumn {
  name: string;
  column: string;
  type: string;
  isPrimary: boolean;
  isNotNull: boolean;
  isUnique: boolean;
  referencesTable?: string;
}

interface DrizzleTable {

  varName: string;

  tableName: string;
  dialect: string;
  columns: DrizzleColumn[];
  filePath: string;
  line: number;
}

interface DrizzleRelation {
  fromVar: string;
  toVar: string;
  field: string;
  kind: 'one' | 'many';
}













export class DrizzleAnalyzer extends BaseAnalyzer {
  constructor() {
    super('drizzle', 'Drizzle ORM Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };
      if (allDeps['drizzle-orm']) {
        return true;
      }
    }

    const ignorePatterns = ['node_modules/**', '**/node_modules/**', 'dist/**', '**/dist/**'];
    const sourceFiles = await glob('**/*.{ts,js,mts,mjs}', {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true
    });

    for (const file of sourceFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/from\s+['"]drizzle-orm/.test(content)) {
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

    const ignorePatterns = this.getIgnorePatterns(context);
    const sourceFiles = await glob('**/*.{ts,js,mts,mjs}', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true
    });

    const tables: DrizzleTable[] = [];
    const relations: DrizzleRelation[] = [];

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!content.includes('drizzle-orm') && !/\b(pgTable|mysqlTable|sqliteTable|relations)\b/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      tables.push(...this.parseTables(content, relativePath));
      relations.push(...this.parseRelations(content));
    }

    this.emitTableGraph(tables, relations, nodes, edges);

    return this.createContribution(nodes, edges, [], [], {
      orm: 'Drizzle',
      tablesFound: tables.length,
      relationshipsFound: edges.filter(e => e.type === 'references').length
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
        nodir: true
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
      if (content.includes('drizzle-orm') || /\b(pgTable|mysqlTable|sqliteTable|relations)\b/.test(content)) {
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

    const tables: DrizzleTable[] = [];
    const relations: DrizzleRelation[] = [];
    if (content.includes('drizzle-orm') || /\b(pgTable|mysqlTable|sqliteTable|relations)\b/.test(content)) {
      tables.push(...this.parseTables(content, context.relativePath));
      relations.push(...this.parseRelations(content));
    }



    this.emitTableGraph(tables, relations, nodes, edges);

    const exports = tables.map(t => t.varName);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      [],
      [],
      exports
    );
  }

  private emitTableGraph(
    tables: DrizzleTable[],
    relations: DrizzleRelation[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {

    const tableByVar = new Map<string, DrizzleTable>();
    for (const table of tables) {
      tableByVar.set(table.varName, table);
    }

    for (const table of tables) {
      const nodeId = `entity_drizzle_${table.varName.toLowerCase()}`;

      const fields = table.columns.map(col => ({
        name: col.name,
        column: col.column,
        type: col.type,
        primary: col.isPrimary,
        unique: col.isUnique,
        notNull: col.isNotNull,
        relation: !!col.referencesTable
      }));

      const node = this.createNode(
        nodeId,
        table.tableName,
        'entity',
        3,
        table.filePath,
        table.line,
        undefined,
        {
          orm: 'Drizzle',
          source: 'drizzle_table',
          dialect: table.dialect,
          varName: table.varName,
          tableName: table.tableName,
          fields,
          annotations: ['DrizzleTable'],
          subcategories: ['entity', 'drizzle']
        }
      );
      nodes.push(node);


      for (const col of table.columns) {
        const fieldNodeId = `field_drizzle_${table.varName.toLowerCase()}_${col.name.toLowerCase()}`;
        nodes.push(this.createNode(
          fieldNodeId,
          col.name,
          'field',
          4,
          table.filePath,
          table.line,
          undefined,
          {
            orm: 'Drizzle',
            source: 'drizzle_column',
            entity: table.tableName,
            column: col.column,
            dataType: col.type,
            primary: col.isPrimary,
            unique: col.isUnique,
            notNull: col.isNotNull,
            subcategories: ['field', 'drizzle']
          }
        ));
        edges.push(this.createEdge(
          `drizzle_field_${table.varName}_${col.name}`,
          nodeId,
          fieldNodeId,
          'has_field',
          'database',
          { attributes: { field: col.name, type: col.type } }
        ));


        if (col.referencesTable && tableByVar.has(col.referencesTable)) {
          const targetTable = tableByVar.get(col.referencesTable)!;
          edges.push(this.createEdge(
            `drizzle_ref_${table.varName}_${col.name}_${col.referencesTable}`,
            nodeId,
            `entity_drizzle_${col.referencesTable.toLowerCase()}`,
            'references',
            'database',
            {
              attributes: {
                relationType: 'ManyToOne',
                field: col.name,
                targetEntity: targetTable.tableName,
                via: 'foreign_key'
              }
            }
          ));
        }
      }
    }


    for (const rel of relations) {
      const from = tableByVar.get(rel.fromVar);
      const to = tableByVar.get(rel.toVar);
      if (!from || !to) {
        continue;
      }
      edges.push(this.createEdge(
        `drizzle_rel_${rel.fromVar}_${rel.field}_${rel.toVar}`,
        `entity_drizzle_${rel.fromVar.toLowerCase()}`,
        `entity_drizzle_${rel.toVar.toLowerCase()}`,
        'references',
        'database',
        {
          attributes: {


            relationType: rel.kind === 'many' ? 'OneToMany' : 'ManyToOne',
            field: rel.field,
            targetEntity: to.tableName,
            via: 'relations'
          }
        }
      ));
    }
  }




  private parseTables(content: string, filePath: string): DrizzleTable[] {
    const tables: DrizzleTable[] = [];
    const tableRegex = /(?:export\s+)?const\s+(\w+)\s*=\s*(pgTable|mysqlTable|sqliteTable)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;

    let match: RegExpExecArray | null;
    while ((match = tableRegex.exec(content)) !== null) {
      const varName = match[1];
      const helper = match[2];
      const tableName = match[3];
      const dialect = helper === 'pgTable' ? 'postgres' : helper === 'mysqlTable' ? 'mysql' : 'sqlite';
      const bodyStart = tableRegex.lastIndex - 1;
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) {
        continue;
      }
      const line = content.slice(0, match.index).split('\n').length;
      tables.push({
        varName,
        tableName,
        dialect,
        columns: this.parseColumns(body),
        filePath,
        line
      });
    }

    return tables;
  }







  private parseColumns(body: string): DrizzleColumn[] {
    const columns: DrizzleColumn[] = [];

    const colRegex = /(\w+)\s*:\s*(\w+)\s*\(\s*(?:['"`]([^'"`]+)['"`])?[^,;]*?(?:,[\s\S]*?)?\)((?:\s*\.\w+\([^)]*\))*)/g;

    let match: RegExpExecArray | null;
    while ((match = colRegex.exec(body)) !== null) {
      const name = match[1];
      const builder = match[2];
      const columnName = match[3] || name;
      const chain = match[4] || '';


      if (['primaryKey', 'foreignKey', 'index', 'uniqueIndex', 'unique', 'relations'].includes(builder)) {
        continue;
      }

      let referencesTable: string | undefined;
      const refMatch = /\.references\(\s*\(\s*\)\s*=>\s*(\w+)\./.exec(chain);
      if (refMatch) {
        referencesTable = refMatch[1];
      }

      columns.push({
        name,
        column: columnName,
        type: builder,
        isPrimary: /\.primaryKey\(/.test(chain),
        isNotNull: /\.notNull\(/.test(chain),
        isUnique: /\.unique\(/.test(chain),
        referencesTable
      });
    }

    return columns;
  }




  private parseRelations(content: string): DrizzleRelation[] {
    const relations: DrizzleRelation[] = [];
    const relRegex = /relations\s*\(\s*(\w+)\s*,\s*\(\s*\{[^}]*\}\s*\)\s*=>\s*\(\s*\{/g;

    let match: RegExpExecArray | null;
    while ((match = relRegex.exec(content)) !== null) {
      const fromVar = match[1];
      const bodyStart = relRegex.lastIndex - 1;
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) {
        continue;
      }
      const entryRegex = /(\w+)\s*:\s*(one|many)\s*\(\s*(\w+)/g;
      let entry: RegExpExecArray | null;
      while ((entry = entryRegex.exec(body)) !== null) {
        relations.push({
          fromVar,
          field: entry[1],
          kind: entry[2] as 'one' | 'many',
          toVar: entry[3]
        });
      }
    }

    return relations;
  }





  private extractBalanced(content: string, openIndex: number): string | null {
    if (content[openIndex] !== '{') {
      return null;
    }
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return content.slice(openIndex + 1, i);
        }
      }
    }
    return null;
  }

  protected getCapabilities(): string[] {
    return ['drizzle-tables', 'drizzle-columns', 'drizzle-relations'];
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
