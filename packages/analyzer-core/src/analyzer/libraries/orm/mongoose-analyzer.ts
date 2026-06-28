import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface MongooseField {
  name: string;
  type: string;
  required: boolean;
  isArray: boolean;
  ref?: string;
}

interface MongooseSchema {
  /** JS variable name the schema was assigned to, e.g. `UserSchema` */
  varName: string;
  fields: MongooseField[];
  filePath: string;
  line: number;
}

/**
 * Mongoose analyzer.
 *
 * Extracts `new Schema({ ... })` definitions as data-entity nodes (named by their
 * `mongoose.model('Name', Schema)` registration when present, else the schema var),
 * with field nodes per path and relation edges from `ref: 'Other'` references.
 *
 * Node conventions mirror PrismaAnalyzer: entity nodes are type `'entity'`, level 3,
 * id `entity_mongoose_<name>`, with embedded `fields[]` metadata. Field nodes are type
 * `'field'`, level 4, joined to their entity by `has_field` edges. Relation edges are
 * type `'references'`, category `'database'`.
 */
export class MongooseAnalyzer extends BaseAnalyzer {
  constructor() {
    super('mongoose', 'Mongoose Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };
      if (allDeps['mongoose']) {
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

    for (const file of sourceFiles.slice(0, 400)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/new\s+(?:mongoose\.)?Schema\s*\(/.test(content) || /mongoose\.model\s*\(/.test(content)) {
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
    const sourceFiles = await glob('**/*.{ts,js,mts,mjs}', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true
    });

    const schemas: MongooseSchema[] = [];
    // Map schema var name -> registered model name (mongoose.model('User', UserSchema))
    const modelNameByVar = new Map<string, string>();

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/new\s+(?:mongoose\.)?Schema\s*\(/.test(content) && !/mongoose\.model\s*\(/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      schemas.push(...this.parseSchemas(content, relativePath));
      this.parseModelRegistrations(content, modelNameByVar);
    }

    this.emitSchemaGraph(schemas, modelNameByVar, nodes, edges);

    return this.createContribution(nodes, edges, [], [], {
      orm: 'Mongoose',
      schemasFound: schemas.length,
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
      if (/new\s+(?:mongoose\.)?Schema\s*\(/.test(content) || /mongoose\.model\s*\(/.test(content)) {
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

    const schemas: MongooseSchema[] = [];
    const modelNameByVar = new Map<string, string>();
    if (/new\s+(?:mongoose\.)?Schema\s*\(/.test(content) || /mongoose\.model\s*\(/.test(content)) {
      schemas.push(...this.parseSchemas(content, context.relativePath));
      this.parseModelRegistrations(content, modelNameByVar);
    }

    // Single-file scope: ref relations to schemas/models registered in other
    // files resolve only by name here and re-derive on full analysis.
    this.emitSchemaGraph(schemas, modelNameByVar, nodes, edges);

    const exports = schemas.map(s => s.varName);

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
    schemas: MongooseSchema[],
    modelNameByVar: Map<string, string>,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    // Resolve display name for each schema var (model name preferred).
    const entityNameByVar = new Map<string, string>();
    for (const schema of schemas) {
      const modelName = modelNameByVar.get(schema.varName);
      entityNameByVar.set(schema.varName, modelName || this.stripSchemaSuffix(schema.varName));
    }
    // Allow refs to resolve by model name -> back to a var-based id.
    const varByEntityName = new Map<string, string>();
    for (const [varName, entityName] of entityNameByVar) {
      varByEntityName.set(entityName.toLowerCase(), varName);
    }

    for (const schema of schemas) {
      const entityName = entityNameByVar.get(schema.varName) || schema.varName;
      const nodeId = `entity_mongoose_${schema.varName.toLowerCase()}`;

      const fields = schema.fields.map(f => ({
        name: f.name,
        type: f.type,
        required: f.required,
        isArray: f.isArray,
        relation: !!f.ref,
        ref: f.ref
      }));

      nodes.push(this.createNode(
        nodeId,
        entityName,
        'entity',
        3,
        schema.filePath,
        schema.line,
        undefined,
        {
          orm: 'Mongoose',
          source: 'mongoose_schema',
          varName: schema.varName,
          modelName: modelNameByVar.get(schema.varName),
          fields,
          annotations: ['MongooseSchema'],
          subcategories: ['entity', 'mongoose']
        }
      ));

      for (const f of schema.fields) {
        const fieldNodeId = `field_mongoose_${schema.varName.toLowerCase()}_${f.name.toLowerCase()}`;
        nodes.push(this.createNode(
          fieldNodeId,
          f.name,
          'field',
          4,
          schema.filePath,
          schema.line,
          undefined,
          {
            orm: 'Mongoose',
            source: 'mongoose_field',
            entity: entityName,
            dataType: f.type,
            required: f.required,
            isArray: f.isArray,
            ref: f.ref,
            subcategories: ['field', 'mongoose']
          }
        ));
        edges.push(this.createEdge(
          `mongoose_field_${schema.varName}_${f.name}`,
          nodeId,
          fieldNodeId,
          'has_field',
          'database',
          { attributes: { field: f.name, type: f.type } }
        ));

        // ref relation -> resolve target entity by model name.
        if (f.ref) {
          const targetVar = varByEntityName.get(f.ref.toLowerCase());
          const targetId = targetVar
            ? `entity_mongoose_${targetVar.toLowerCase()}`
            : `entity_mongoose_${f.ref.toLowerCase()}`;
          edges.push(this.createEdge(
            `mongoose_ref_${schema.varName}_${f.name}_${f.ref}`,
            nodeId,
            targetId,
            'references',
            'database',
            {
              attributes: {
                relationType: f.isArray ? 'OneToMany' : 'ManyToOne',
                field: f.name,
                targetEntity: f.ref,
                via: 'ref'
              }
            }
          ));
        }
      }
    }
  }

  /**
   * Parse `const UserSchema = new Schema({ ... })`.
   */
  private parseSchemas(content: string, filePath: string): MongooseSchema[] {
    const schemas: MongooseSchema[] = [];
    const schemaRegex = /(?:export\s+)?const\s+(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema\s*(?:<[^>]*>)?\s*\(\s*\{/g;

    let match: RegExpExecArray | null;
    while ((match = schemaRegex.exec(content)) !== null) {
      const varName = match[1];
      const bodyStart = schemaRegex.lastIndex - 1; // opening `{`
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) {
        continue;
      }
      const line = content.slice(0, match.index).split('\n').length;
      schemas.push({
        varName,
        fields: this.parseFields(body),
        filePath,
        line
      });
    }

    return schemas;
  }

  /**
   * Parse the schema definition object body into fields.
   * Handles shorthand (`email: String`), option-objects
   * (`email: { type: String, required: true }`), and arrays/refs
   * (`posts: [{ type: Schema.Types.ObjectId, ref: 'Post' }]`).
   */
  private parseFields(body: string): MongooseField[] {
    const fields: MongooseField[] = [];
    // Split top-level entries by walking depth so nested objects/arrays stay intact.
    const entries = this.splitTopLevel(body);

    for (const entry of entries) {
      const colonIdx = entry.indexOf(':');
      if (colonIdx === -1) {
        continue;
      }
      const name = entry.slice(0, colonIdx).trim().replace(/['"`]/g, '');
      if (!/^\w+$/.test(name)) {
        continue;
      }
      const value = entry.slice(colonIdx + 1).trim();
      const isArray = value.startsWith('[');

      let type = 'Mixed';
      const typeMatch = /type\s*:\s*([\w.]+)/.exec(value);
      if (typeMatch) {
        type = this.simplifyType(typeMatch[1]);
      } else {
        // shorthand: `email: String` or `tags: [String]`
        const shorthand = /^\[?\s*([\w.]+)/.exec(value);
        if (shorthand) {
          type = this.simplifyType(shorthand[1]);
        }
      }

      const refMatch = /ref\s*:\s*['"`](\w+)['"`]/.exec(value);

      fields.push({
        name,
        type,
        required: /required\s*:\s*true/.test(value),
        isArray,
        ref: refMatch ? refMatch[1] : undefined
      });
    }

    return fields;
  }

  /**
   * Parse `mongoose.model('User', UserSchema)` / `model<T>('User', UserSchema)`.
   */
  private parseModelRegistrations(content: string, out: Map<string, string>): void {
    const modelRegex = /(?:mongoose\.)?model\s*(?:<[^>]*>)?\s*\(\s*['"`](\w+)['"`]\s*,\s*(\w+)/g;
    let match: RegExpExecArray | null;
    while ((match = modelRegex.exec(content)) !== null) {
      out.set(match[2], match[1]);
    }
  }

  private simplifyType(raw: string): string {
    if (raw.includes('ObjectId')) return 'ObjectId';
    if (raw.startsWith('Schema.Types.')) return raw.replace('Schema.Types.', '');
    if (raw.startsWith('mongoose.Schema.Types.')) return raw.replace('mongoose.Schema.Types.', '');
    return raw;
  }

  private stripSchemaSuffix(varName: string): string {
    return varName.replace(/Schema$/, '') || varName;
  }

  /**
   * Split an object-body string into top-level `key: value` entries, respecting
   * nested `{}`/`[]` and ignoring commas inside them.
   */
  private splitTopLevel(body: string): string[] {
    const entries: string[] = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        if (current.trim()) entries.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) entries.push(current.trim());
    return entries;
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
    return ['mongoose-schemas', 'mongoose-fields', 'mongoose-refs'];
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
