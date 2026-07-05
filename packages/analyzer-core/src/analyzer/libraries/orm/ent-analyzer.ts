import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface EntField {
  name: string;
  type: string;
}

interface EntEdgeDef {
  name: string;
  kind: 'to' | 'from';
  target: string;
  unique: boolean;
}

interface EntSchema {
  entityName: string;
  fields: EntField[];
  edges: EntEdgeDef[];
  filePath: string;
  line: number;
}

/**
 * ent analyzer (Go, entgo.io).
 *
 * ent schemas are Go structs embedding `ent.Schema` with `Fields()`/`Edges()`
 * methods returning builder-style declarations, e.g.:
 *
 *   type User struct { ent.Schema }
 *   func (User) Fields() []ent.Field {
 *     return []ent.Field{ field.String("name") }
 *   }
 *   func (User) Edges() []ent.Edge {
 *     return []ent.Edge{ edge.To("posts", Post.Type) }
 *   }
 *
 * `edge.To(name, Target.Type)` is a forward (has-many-ish, ownership) edge;
 * `edge.From(name, Target.Type, InverseEdgeName)` is the inverse side. Both
 * carry `.Unique()` to mark 1:1 vs 1:N. Since ent doesn't distinguish
 * has-many from belongs-to as separate builder names (direction comes from
 * To/From + Unique), cardinality is inferred: `To` without `.Unique()` is
 * `OneToMany`, `To().Unique()` is `OneToOne`, `From` without `.Unique()` is
 * `ManyToOne` (inverse of a to-edge on the other schema), `From().Unique()` is
 * `OneToOne`.
 */
export class EntAnalyzer extends BaseAnalyzer {
  constructor() {
    super('ent', 'ent Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const goModPath = path.join(projectPath, 'go.mod');
    if (await fs.pathExists(goModPath)) {
      const content = await fs.readFile(goModPath, 'utf-8');
      if (/entgo\.io\/ent/.test(content)) {
        return true;
      }
    }

    const ignorePatterns = ['vendor/**', '**/vendor/**'];
    const sourceFiles = await glob('**/*.go', {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    for (const file of sourceFiles.slice(0, 400)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/ent\.Schema\b/.test(content)) {
          return true;
        }
      } catch {
        // ignore unreadable files
      }
    }

    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];

    const ignorePatterns = this.getIgnorePatterns(context);
    const sourceFiles = await glob('**/*.go', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    const schemas: EntSchema[] = [];
    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/ent\.Schema\b/.test(content)) continue;
      const relativePath = path.relative(context.projectPath, file);
      const schema = this.parseSchema(content, relativePath);
      if (schema) schemas.push(schema);
    }

    this.emitSchemaGraph(schemas, nodes, edges);

    return this.createContribution(nodes, edges, [], [], {
      orm: 'ent',
      entitiesFound: schemas.length,
      relationshipsFound: edges.filter(e => e.type === 'references').length,
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let sourceFiles: string[] = [];
    try {
      sourceFiles = await glob('**/*.go', {
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
      if (/ent\.Schema\b/.test(content)) {
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

    const schemas: EntSchema[] = [];
    if (/ent\.Schema\b/.test(content)) {
      const schema = this.parseSchema(content, context.relativePath);
      if (schema) schemas.push(schema);
    }

    this.emitSchemaGraph(schemas, nodes, edges);

    const exports = schemas.map(s => s.entityName);

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

  private emitSchemaGraph(schemas: EntSchema[], nodes: CASNode[], edges: CASEdge[]): void {
    const schemaByName = new Map<string, EntSchema>();
    for (const schema of schemas) schemaByName.set(schema.entityName, schema);

    for (const schema of schemas) {
      const nodeId = `entity_ent_${schema.entityName.toLowerCase()}`;
      const fields = schema.fields.map(f => ({ name: f.name, type: f.type, relation: false }));

      nodes.push(this.createNode(
        nodeId,
        schema.entityName,
        'entity',
        3,
        schema.filePath,
        schema.line,
        undefined,
        {
          orm: 'ent',
          source: 'ent_schema',
          fields,
          annotations: ['ent.Schema'],
          subcategories: ['entity', 'ent'],
        }
      ));

      for (const f of schema.fields) {
        const fieldNodeId = `field_ent_${schema.entityName.toLowerCase()}_${f.name.toLowerCase()}`;
        nodes.push(this.createNode(
          fieldNodeId,
          f.name,
          'field',
          4,
          schema.filePath,
          schema.line,
          undefined,
          {
            orm: 'ent',
            source: 'ent_field',
            entity: schema.entityName,
            dataType: f.type,
            subcategories: ['field', 'ent'],
          }
        ));
        edges.push(this.createEdge(
          `ent_field_${schema.entityName}_${f.name}`,
          nodeId,
          fieldNodeId,
          'has_field',
          'database',
          { attributes: { field: f.name, type: f.type } }
        ));
      }

      for (const edgeDef of schema.edges) {
        if (!schemaByName.has(edgeDef.target)) continue;
        const relationType = edgeDef.kind === 'to'
          ? (edgeDef.unique ? 'OneToOne' : 'OneToMany')
          : (edgeDef.unique ? 'OneToOne' : 'ManyToOne');
        edges.push(this.createEdge(
          `ent_rel_${schema.entityName}_${edgeDef.name}_${edgeDef.target}`,
          nodeId,
          `entity_ent_${edgeDef.target.toLowerCase()}`,
          'references',
          'database',
          {
            attributes: {
              relationType,
              field: edgeDef.name,
              targetEntity: edgeDef.target,
              via: `edge.${edgeDef.kind === 'to' ? 'To' : 'From'}`,
            },
          }
        ));
      }
    }
  }

  /**
   * Parse `type User struct { ent.Schema }`, then the sibling
   * `func (User) Fields() []ent.Field { return []ent.Field{ field.String("name"), ... } }`
   * and `func (User) Edges() []ent.Edge { return []ent.Edge{ edge.To("posts", Post.Type), ... } }`.
   */
  private parseSchema(content: string, filePath: string): EntSchema | undefined {
    const structMatch = /type\s+(\w+)\s+struct\s*\{\s*ent\.Schema\s*\}/.exec(content);
    if (!structMatch) return undefined;
    const entityName = structMatch[1];
    const line = content.slice(0, structMatch.index).split('\n').length;

    const fields: EntField[] = [];
    const fieldsFuncRegex = new RegExp(`func\\s*\\(\\w*\\s*${entityName}\\)\\s*Fields\\s*\\(\\)[^{]*\\{`);
    const fieldsFuncMatch = fieldsFuncRegex.exec(content);
    if (fieldsFuncMatch) {
      const bodyStart = content.indexOf('{', fieldsFuncMatch.index + fieldsFuncMatch[0].length - 1);
      const body = this.extractBalanced(content, bodyStart);
      if (body !== null) {
        const fieldRegex = /field\.(\w+)\s*\(\s*"(\w+)"/g;
        let fieldMatch: RegExpExecArray | null;
        while ((fieldMatch = fieldRegex.exec(body)) !== null) {
          fields.push({ name: fieldMatch[2], type: fieldMatch[1] });
        }
      }
    }

    const edgeDefs: EntEdgeDef[] = [];
    const edgesFuncRegex = new RegExp(`func\\s*\\(\\w*\\s*${entityName}\\)\\s*Edges\\s*\\(\\)[^{]*\\{`);
    const edgesFuncMatch = edgesFuncRegex.exec(content);
    if (edgesFuncMatch) {
      const bodyStart = content.indexOf('{', edgesFuncMatch.index + edgesFuncMatch[0].length - 1);
      const body = this.extractBalanced(content, bodyStart);
      if (body !== null) {
        const edgeRegex = /edge\.(To|From)\s*\(\s*"(\w+)"\s*,\s*(\w+)\.Type([^)]*)\)/g;
        let edgeMatch: RegExpExecArray | null;
        while ((edgeMatch = edgeRegex.exec(body)) !== null) {
          const trailer = edgeMatch[4] || '';
          edgeDefs.push({
            kind: edgeMatch[1] === 'To' ? 'to' : 'from',
            name: edgeMatch[2],
            target: edgeMatch[3],
            unique: /\.Unique\s*\(\s*\)/.test(this.chainAfter(body, edgeMatch.index + edgeMatch[0].length)),
          });
        }
      }
    }

    return { entityName, fields, edges: edgeDefs, filePath, line };
  }

  /** Look at the next ~120 chars after an edge builder call for a chained `.Unique()`. */
  private chainAfter(body: string, index: number): string {
    return body.slice(index, index + 120);
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
    return ['ent-schemas', 'ent-fields', 'ent-edges'];
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
