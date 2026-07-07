import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface SeaOrmField {
  name: string;
  type: string;
  primary: boolean;
}

interface SeaOrmEntity {
  /** SeaORM convention names the row struct `Model` in each entity module; the
   * module's directory or file stem (e.g. `user.rs` -> `user`) is what
   * disambiguates one entity's `Model` from another's, so we key entities by
   * that module name rather than the (always-identical) struct name. */
  moduleName: string;
  tableName?: string;
  fields: SeaOrmField[];
  filePath: string;
  line: number;
}

interface SeaOrmRelation {
  moduleName: string;
  kind: 'has_many' | 'has_one' | 'belongs_to';
  targetModule: string;
  line: number;
}

const RELATION_CARDINALITY: Record<SeaOrmRelation['kind'], string> = {
  has_many: 'OneToMany',
  has_one: 'OneToOne',
  belongs_to: 'ManyToOne',
};

/**
 * SeaORM analyzer (Rust).
 *
 * SeaORM entities are one Rust module per table: `#[sea_orm(table_name =
 * "users")] pub struct Model { #[sea_orm(primary_key)] pub id: i32, ... }`,
 * plus a sibling `enum Relation { #[sea_orm(has_many = "super::post::Entity")]
 * Post, ... }` carrying the relation kind and target module path.
 *
 * Because every entity's row struct is named `Model` (not the table name),
 * this analyzer keys entities by their containing module (file stem, e.g.
 * `user.rs` -> `user`) and resolves `super::post::Entity` / `Entity` paths in
 * relation targets back to that same module-name space.
 */
export class SeaOrmAnalyzer extends BaseAnalyzer {
  constructor() {
    super('sea-orm', 'SeaORM Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const cargoPath = path.join(projectPath, 'Cargo.toml');
    if (await fs.pathExists(cargoPath)) {
      const content = await fs.readFile(cargoPath, 'utf-8');
      if (/\bsea-orm\s*=/.test(content) || /\bsea_orm\s*=/.test(content)) {
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

    for (const file of sourceFiles.slice(0, 400)) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/DeriveEntityModel/.test(content) || /sea_orm\(table_name/.test(content)) {
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
    const sourceFiles = await glob('**/*.rs', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    const entities: SeaOrmEntity[] = [];
    const relations: SeaOrmRelation[] = [];

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/DeriveEntityModel|sea_orm\(table_name|DeriveRelation/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      const moduleName = path.basename(file, '.rs');
      const entity = this.parseEntity(content, moduleName, relativePath);
      if (entity) entities.push(entity);
      relations.push(...this.parseRelations(content, moduleName));
    }

    this.emitEntityGraph(entities, relations, nodes, edges);

    return this.createContribution(nodes, edges, [], [], {
      orm: 'SeaORM',
      entitiesFound: entities.length,
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
      if (/DeriveEntityModel|sea_orm\(table_name|DeriveRelation/.test(content)) {
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

    const entities: SeaOrmEntity[] = [];
    const relations: SeaOrmRelation[] = [];
    if (/DeriveEntityModel|sea_orm\(table_name|DeriveRelation/.test(content)) {
      const moduleName = path.basename(context.filePath, '.rs');
      const entity = this.parseEntity(content, moduleName, context.relativePath);
      if (entity) entities.push(entity);
      relations.push(...this.parseRelations(content, moduleName));
    }

    this.emitEntityGraph(entities, relations, nodes, edges);

    const exports = entities.map(e => e.moduleName);

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

  private emitEntityGraph(
    entities: SeaOrmEntity[],
    relations: SeaOrmRelation[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const entityByModule = new Map<string, SeaOrmEntity>();
    for (const entity of entities) entityByModule.set(entity.moduleName, entity);

    for (const entity of entities) {
      const nodeId = `entity_seaorm_${entity.moduleName.toLowerCase()}`;
      const displayName = entity.tableName || entity.moduleName;
      const fields = entity.fields.map(f => ({
        name: f.name,
        type: f.type,
        primary: f.primary,
        relation: false,
      }));

      nodes.push(this.createNode(
        nodeId,
        displayName,
        'entity',
        3,
        entity.filePath,
        entity.line,
        undefined,
        {
          orm: 'SeaORM',
          source: 'sea_orm_entity_model',
          tableName: entity.tableName,
          fields,
          annotations: ['DeriveEntityModel'],
          subcategories: ['entity', 'sea-orm'],
        }
      ));

      for (const f of entity.fields) {
        const fieldNodeId = `field_seaorm_${entity.moduleName.toLowerCase()}_${f.name.toLowerCase()}`;
        nodes.push(this.createNode(
          fieldNodeId,
          f.name,
          'field',
          4,
          entity.filePath,
          entity.line,
          undefined,
          {
            orm: 'SeaORM',
            source: 'sea_orm_column',
            entity: displayName,
            dataType: f.type,
            primary: f.primary,
            subcategories: ['field', 'sea-orm'],
          }
        ));
        edges.push(this.createEdge(
          `seaorm_field_${entity.moduleName}_${f.name}`,
          nodeId,
          fieldNodeId,
          'has_field',
          'database',
          { attributes: { field: f.name, type: f.type } }
        ));
      }
    }

    for (const rel of relations) {
      const targetModule = this.resolveModulePath(rel.targetModule);
      const target = entityByModule.get(targetModule);
      const source = entityByModule.get(rel.moduleName);
      if (!target || !source) continue;
      edges.push(this.createEdge(
        `seaorm_rel_${rel.moduleName}_${rel.kind}_${targetModule}_${rel.line}`,
        `entity_seaorm_${rel.moduleName.toLowerCase()}`,
        `entity_seaorm_${targetModule.toLowerCase()}`,
        'references',
        'database',
        {
          attributes: {
            relationType: RELATION_CARDINALITY[rel.kind],
            field: targetModule,
            targetEntity: target.tableName || targetModule,
            via: 'DeriveRelation',
          },
        }
      ));
    }
  }

  /**
   * Parse `#[sea_orm(table_name = "users")] pub struct Model { #[sea_orm(primary_key)] pub id: i32, pub name: String }`.
   */
  private parseEntity(content: string, moduleName: string, filePath: string): SeaOrmEntity | undefined {
    const tableNameMatch = /sea_orm\(table_name\s*=\s*"([^"]+)"\)/.exec(content);
    const structMatch = /pub\s+struct\s+Model\s*\{/.exec(content);
    if (!structMatch) return undefined;

    const bodyStart = content.indexOf('{', structMatch.index);
    const body = this.extractBalanced(content, bodyStart);
    if (body === null) return undefined;
    const line = content.slice(0, structMatch.index).split('\n').length;

    const fields: SeaOrmField[] = [];
    // Split on field boundaries: optional #[sea_orm(...)] attr, then `pub name: Type,`
    const fieldRegex = /(?:#\[sea_orm\(([^)]*)\)\]\s*)?pub\s+(\w+)\s*:\s*([\w:<>]+)\s*,?/g;
    let match: RegExpExecArray | null;
    while ((match = fieldRegex.exec(body)) !== null) {
      const attrs = match[1] || '';
      fields.push({
        name: match[2],
        type: match[3],
        primary: /primary_key/.test(attrs),
      });
    }

    return { moduleName, tableName: tableNameMatch?.[1], fields, filePath, line };
  }

  /**
   * Parse `enum Relation { #[sea_orm(has_many = "super::post::Entity")] Post, #[sea_orm(belongs_to = "super::user::Entity", ...)] User }`.
   */
  private parseRelations(content: string, moduleName: string): SeaOrmRelation[] {
    const relations: SeaOrmRelation[] = [];
    const relEnumMatch = /enum\s+Relation\s*\{/.exec(content);
    if (!relEnumMatch) return relations;
    const bodyStart = content.indexOf('{', relEnumMatch.index);
    const body = this.extractBalanced(content, bodyStart);
    if (body === null) return relations;

    const relRegex = /#\[sea_orm\(\s*(has_many|has_one|belongs_to)\s*=\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = relRegex.exec(body)) !== null) {
      const line = content.slice(0, relEnumMatch.index).split('\n').length;
      relations.push({
        moduleName,
        kind: match[1] as SeaOrmRelation['kind'],
        targetModule: match[2],
        line,
      });
    }
    return relations;
  }

  /**
   * Resolve `super::post::Entity` / `crate::entities::post::Entity` / `Entity`
   * down to the bare module name (`post`) used as the entity key.
   */
  private resolveModulePath(target: string): string {
    const parts = target.split('::').filter(p => p && p !== 'super' && p !== 'crate' && p !== 'Entity');
    return parts.length > 0 ? parts[parts.length - 1] : target;
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
    return ['sea-orm-entities', 'sea-orm-fields', 'sea-orm-relations'];
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
