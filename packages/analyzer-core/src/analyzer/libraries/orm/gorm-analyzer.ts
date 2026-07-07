import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface GormField {
  name: string;
  type: string;
  isSlice: boolean;
  foreignKeyTag?: string;
}

interface GormModel {
  structName: string;
  fields: GormField[];
  filePath: string;
  line: number;
}

/**
 * GORM analyzer (Go).
 *
 * GORM models are plain Go structs — there is no decorator syntax to gate on,
 * so detection relies on the combination of a `gorm.io/gorm` import plus
 * either an embedded `gorm.Model` field or a `gorm:"..."` struct tag anywhere
 * in the file (this avoids false-positives on structs that merely happen to
 * share field names with a GORM model).
 *
 * Relations are inferred the same way GORM itself infers them by convention:
 *  - A field whose type is `[]Other` (a slice of another known model) is a
 *    `has-many` (1:N) relation to `Other`.
 *  - A field whose type is `Other` (a known model, singular) is a `belongs-to`
 *    (N:1) relation to `Other`.
 *  - An explicit `gorm:"foreignKey:UserID"` tag is recorded but the target is
 *    still the field's declared type, matching GORM's own resolution order.
 *
 * Entities are emitted per struct: `entity` node, level 3, id
 * `entity_gorm_<name>`; relation edges are `references`/`database` with a
 * `relationType` attribute so they land in database_schema.relationships_summary
 * the same way TypeORM/Mongoose/Drizzle relations do.
 */
export class GormAnalyzer extends BaseAnalyzer {
  constructor() {
    super('gorm', 'GORM Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const goModPath = path.join(projectPath, 'go.mod');
    let hasGormDependency = false;
    if (await fs.pathExists(goModPath)) {
      const content = await fs.readFile(goModPath, 'utf-8');
      hasGormDependency = /gorm\.io\/gorm/.test(content);
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
        if (/"gorm\.io\/gorm"/.test(content) && (/gorm\.Model\b/.test(content) || /gorm:"/.test(content))) {
          return true;
        }
        if (hasGormDependency && /gorm\.Model\b/.test(content)) {
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

    const models: GormModel[] = [];

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/gorm\.Model\b|gorm:"/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      models.push(...this.parseModels(content, relativePath));
    }

    this.emitModelGraph(models, nodes, edges);

    return this.createContribution(nodes, edges, [], [], {
      orm: 'GORM',
      modelsFound: models.length,
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
      if (/gorm\.Model\b|gorm:"/.test(content)) {
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

    const models: GormModel[] = [];
    if (/gorm\.Model\b|gorm:"/.test(content)) {
      models.push(...this.parseModels(content, context.relativePath));
    }

    this.emitModelGraph(models, nodes, edges);

    const exports = models.map(m => m.structName);

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

  private emitModelGraph(models: GormModel[], nodes: CASNode[], edges: CASEdge[]): void {
    const modelByName = new Map<string, GormModel>();
    for (const model of models) modelByName.set(model.structName, model);

    for (const model of models) {
      const nodeId = `entity_gorm_${model.structName.toLowerCase()}`;
      const fields = model.fields.map(f => ({
        name: f.name,
        type: f.type,
        relation: f.isSlice || modelByName.has(f.type),
      }));

      nodes.push(this.createNode(
        nodeId,
        model.structName,
        'entity',
        3,
        model.filePath,
        model.line,
        undefined,
        {
          orm: 'GORM',
          source: 'gorm_struct',
          fields,
          annotations: ['gorm.Model'],
          subcategories: ['entity', 'gorm'],
        }
      ));

      for (const f of model.fields) {
        const fieldNodeId = `field_gorm_${model.structName.toLowerCase()}_${f.name.toLowerCase()}`;
        nodes.push(this.createNode(
          fieldNodeId,
          f.name,
          'field',
          4,
          model.filePath,
          model.line,
          undefined,
          {
            orm: 'GORM',
            source: 'gorm_field',
            entity: model.structName,
            dataType: f.type,
            subcategories: ['field', 'gorm'],
          }
        ));
        edges.push(this.createEdge(
          `gorm_field_${model.structName}_${f.name}`,
          nodeId,
          fieldNodeId,
          'has_field',
          'database',
          { attributes: { field: f.name, type: f.type } }
        ));

        // Convention-based relation inference: slice-of-model = has-many,
        // singular model type = belongs-to.
        if (f.isSlice && modelByName.has(f.type)) {
          edges.push(this.createEdge(
            `gorm_rel_${model.structName}_${f.name}_${f.type}`,
            nodeId,
            `entity_gorm_${f.type.toLowerCase()}`,
            'references',
            'database',
            {
              attributes: {
                relationType: 'OneToMany',
                field: f.name,
                targetEntity: f.type,
                via: f.foreignKeyTag ? `foreignKey:${f.foreignKeyTag}` : 'slice-convention',
              },
            }
          ));
        } else if (!f.isSlice && modelByName.has(f.type) && f.type !== model.structName) {
          edges.push(this.createEdge(
            `gorm_rel_${model.structName}_${f.name}_${f.type}`,
            nodeId,
            `entity_gorm_${f.type.toLowerCase()}`,
            'references',
            'database',
            {
              attributes: {
                relationType: 'ManyToOne',
                field: f.name,
                targetEntity: f.type,
                via: f.foreignKeyTag ? `foreignKey:${f.foreignKeyTag}` : 'field-convention',
              },
            }
          ));
        }
      }
    }
  }

  /**
   * Parse `type User struct { gorm.Model; Name string; Posts []Post \`gorm:"foreignKey:UserID"\` }`.
   */
  private parseModels(content: string, filePath: string): GormModel[] {
    const models: GormModel[] = [];
    const structRegex = /type\s+(\w+)\s+struct\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = structRegex.exec(content)) !== null) {
      const structName = match[1];
      const bodyStart = structRegex.lastIndex - 1;
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) continue;
      // Only treat as a GORM model if it embeds gorm.Model or carries a gorm tag.
      if (!/gorm\.Model\b/.test(body) && !/gorm:"/.test(body)) continue;
      const line = content.slice(0, match.index).split('\n').length;
      models.push({
        structName,
        fields: this.parseFields(body),
        filePath,
        line,
      });
    }
    return models;
  }

  private parseFields(body: string): GormField[] {
    const fields: GormField[] = [];
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'gorm.Model') continue;
      // `Name string` / `Posts []Post \`gorm:"foreignKey:UserID"\`` / `UserID uint`
      const fieldMatch = /^(\w+)\s+(\[\])?([\w.]+)(?:\s+`([^`]*)`)?/.exec(trimmed);
      if (!fieldMatch) continue;
      const name = fieldMatch[1];
      const isSlice = !!fieldMatch[2];
      const type = fieldMatch[3].replace(/^\*/, '');
      const tag = fieldMatch[4] || '';
      const fkMatch = /gorm:"[^"]*foreignKey:(\w+)/.exec(tag);
      fields.push({
        name,
        type,
        isSlice,
        foreignKeyTag: fkMatch?.[1],
      });
    }
    return fields;
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
    return ['gorm-models', 'gorm-fields', 'gorm-relations'];
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
