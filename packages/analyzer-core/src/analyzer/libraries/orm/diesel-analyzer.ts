import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface DieselTableColumn {
  name: string;
  type: string;
}

interface DieselTable {
  name: string;
  columns: DieselTableColumn[];
  filePath: string;
  line: number;
}

interface DieselJoinable {
  child: string;
  parent: string;
  foreignKey: string;
  line: number;
}

interface DieselQueryableStruct {
  structName: string;
  fields: DieselTableColumn[];
  filePath: string;
  line: number;
}




















export class DieselAnalyzer extends BaseAnalyzer {
  constructor() {
    super('diesel', 'Diesel Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const cargoPath = path.join(projectPath, 'Cargo.toml');
    if (await fs.pathExists(cargoPath)) {
      const content = await fs.readFile(cargoPath, 'utf-8');
      if (/\bdiesel\s*=/.test(content)) {
        return true;
      }
    }

    const ignorePatterns = ['target/**', '**/target/**'];
    const sourceFiles = await glob('**/*.rs', {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    for (const file of sourceFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/\btable!\s*\{/.test(content) || /derive\s*\([^)]*Queryable/.test(content)) {
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
    const sourceFiles = await glob('**/*.rs', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    const tables: DieselTable[] = [];
    const joinables: DieselJoinable[] = [];
    const structs: DieselQueryableStruct[] = [];

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/\btable!\s*\{|\bjoinable!\s*\(|derive\s*\([^)]*Queryable/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      tables.push(...this.parseTables(content, relativePath));
      joinables.push(...this.parseJoinables(content));
      structs.push(...this.parseQueryableStructs(content, relativePath));
    }

    this.emitSchemaGraph(tables, joinables, structs, nodes, edges);

    return this.createContribution(nodes, edges, [], [], {
      orm: 'Diesel',
      tablesFound: tables.length,
      relationshipsFound: edges.filter(e => e.type === 'references').length,
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let sourceFiles: string[] = [];
    try {
      sourceFiles = await glob('**/*.rs', {
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
      if (/\btable!\s*\{|\bjoinable!\s*\(|derive\s*\([^)]*Queryable/.test(content)) {
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

    const tables: DieselTable[] = [];
    const joinables: DieselJoinable[] = [];
    const structs: DieselQueryableStruct[] = [];
    if (/\btable!\s*\{|\bjoinable!\s*\(|derive\s*\([^)]*Queryable/.test(content)) {
      tables.push(...this.parseTables(content, context.relativePath));
      joinables.push(...this.parseJoinables(content));
      structs.push(...this.parseQueryableStructs(content, context.relativePath));
    }

    this.emitSchemaGraph(tables, joinables, structs, nodes, edges);

    const exports = [...tables.map(t => t.name), ...structs.map(s => s.structName)];

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

  private emitSchemaGraph(
    tables: DieselTable[],
    joinables: DieselJoinable[],
    structs: DieselQueryableStruct[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const tableByName = new Map<string, DieselTable>();
    for (const table of tables) tableByName.set(table.name, table);

    for (const table of tables) {
      const nodeId = `entity_diesel_${table.name.toLowerCase()}`;
      const fields = table.columns.map(col => ({
        name: col.name,
        type: col.type,
        relation: false,
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
          orm: 'Diesel',
          source: 'diesel_table_macro',
          tableName: table.name,
          fields,
          annotations: ['DieselTable'],
          subcategories: ['entity', 'diesel'],
        }
      ));

      for (const col of table.columns) {
        const fieldNodeId = `field_diesel_${table.name.toLowerCase()}_${col.name.toLowerCase()}`;
        nodes.push(this.createNode(
          fieldNodeId,
          col.name,
          'field',
          4,
          table.filePath,
          table.line,
          undefined,
          {
            orm: 'Diesel',
            source: 'diesel_column',
            entity: table.name,
            dataType: col.type,
            subcategories: ['field', 'diesel'],
          }
        ));
        edges.push(this.createEdge(
          `diesel_field_${table.name}_${col.name}`,
          nodeId,
          fieldNodeId,
          'has_field',
          'database',
          { attributes: { field: col.name, type: col.type } }
        ));
      }
    }

    for (const join of joinables) {
      if (!tableByName.has(join.child) || !tableByName.has(join.parent)) continue;
      edges.push(this.createEdge(
        `diesel_joinable_${join.child}_${join.parent}`,
        `entity_diesel_${join.child.toLowerCase()}`,
        `entity_diesel_${join.parent.toLowerCase()}`,
        'references',
        'database',
        {
          attributes: {
            relationType: 'ManyToOne',
            field: join.foreignKey,
            targetEntity: join.parent,
            via: 'joinable!',
          },
        }
      ));
    }





    for (const struct of structs) {
      const matchesTable = tables.some(t => this.pluralize(struct.structName).toLowerCase() === t.name.toLowerCase());
      if (matchesTable) continue;
      const nodeId = `entity_diesel_struct_${struct.structName.toLowerCase()}`;
      nodes.push(this.createNode(
        nodeId,
        struct.structName,
        'entity',
        3,
        struct.filePath,
        struct.line,
        undefined,
        {
          orm: 'Diesel',
          source: 'diesel_queryable_struct',
          fields: struct.fields.map(f => ({ name: f.name, type: f.type, relation: false })),
          annotations: ['Queryable'],
          subcategories: ['entity', 'diesel'],
        }
      ));
    }
  }




  private parseTables(content: string, filePath: string): DieselTable[] {
    const tables: DieselTable[] = [];
    const tableRegex = /table!\s*\{\s*(\w+)\s*(?:\([^)]*\))?\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = tableRegex.exec(content)) !== null) {
      const name = match[1];
      const bodyStart = tableRegex.lastIndex - 1;
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) continue;
      const line = content.slice(0, match.index).split('\n').length;
      const columns: DieselTableColumn[] = [];
      const colRegex = /(\w+)\s*->\s*([\w<>]+)\s*,/g;
      let colMatch: RegExpExecArray | null;
      while ((colMatch = colRegex.exec(body)) !== null) {
        columns.push({ name: colMatch[1], type: colMatch[2] });
      }
      tables.push({ name, columns, filePath, line });
    }
    return tables;
  }




  private parseJoinables(content: string): DieselJoinable[] {
    const joinables: DieselJoinable[] = [];
    const joinRegex = /joinable!\s*\(\s*(\w+)\s*->\s*(\w+)\s*\(\s*(\w+)\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = joinRegex.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      joinables.push({ child: match[1], parent: match[2], foreignKey: match[3], line });
    }
    return joinables;
  }




  private parseQueryableStructs(content: string, filePath: string): DieselQueryableStruct[] {
    const structs: DieselQueryableStruct[] = [];
    const structRegex = /#\[derive\([^)]*Queryable[^)]*\)\][\s\S]{0,200}?struct\s+(\w+)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = structRegex.exec(content)) !== null) {
      const structName = match[1];
      const bodyStart = structRegex.lastIndex - 1;
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) continue;
      const line = content.slice(0, match.index).split('\n').length;
      const fields: DieselTableColumn[] = [];
      const fieldRegex = /(?:pub\s+)?(\w+)\s*:\s*([\w:<>]+)\s*,?/g;
      let fieldMatch: RegExpExecArray | null;
      while ((fieldMatch = fieldRegex.exec(body)) !== null) {
        fields.push({ name: fieldMatch[1], type: fieldMatch[2] });
      }
      structs.push({ structName, fields, filePath, line });
    }
    return structs;
  }

  private pluralize(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith('s')) return lower;
    if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
    return `${lower}s`;
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
    return ['diesel-tables', 'diesel-columns', 'diesel-joinables', 'diesel-queryable-structs'];
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
