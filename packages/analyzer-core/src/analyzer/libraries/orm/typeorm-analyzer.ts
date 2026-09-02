import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

type TypeORMRelationKind = 'OneToMany' | 'ManyToOne' | 'ManyToMany' | 'OneToOne';

interface TypeORMColumn {
  name: string;
  type: string;
  isPrimary: boolean;
  isGenerated: boolean;
}

interface TypeORMRelationField {
  name: string;
  kind: TypeORMRelationKind;
  targetEntity: string;
}

interface TypeORMEntity {
  className: string;
  tableName: string;
  columns: TypeORMColumn[];
  relations: TypeORMRelationField[];
  filePath: string;
  line: number;
}













export class TypeORMAnalyzer extends BaseAnalyzer {
  constructor() {
    super('typeorm', 'TypeORM Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };
      if (allDeps['typeorm']) {
        return true;
      }
    }

    const ignorePatterns = ['node_modules/**', '**/node_modules/**', 'dist/**', '**/dist/**'];
    const sourceFiles = await glob('**/*.ts', {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true
    });

    for (const file of sourceFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/@Entity\s*\(/.test(content)) {
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
    const sourceFiles = await glob('**/*.ts', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true
    });

    const entities: TypeORMEntity[] = [];

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/@Entity\s*\(/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      entities.push(...this.parseEntities(content, relativePath));
    }

    this.emitEntityGraph(entities, nodes, edges);

    return this.createContribution(nodes, edges, [], [], {
      orm: 'TypeORM',
      entitiesFound: entities.length,
      relationshipsFound: edges.filter(e => e.type === 'references').length
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let sourceFiles: string[] = [];
    try {
      sourceFiles = await glob('**/*.ts', {
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
      if (/@Entity\s*\(/.test(content)) {
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

    const entities: TypeORMEntity[] = [];
    if (/@Entity\s*\(/.test(content)) {
      entities.push(...this.parseEntities(content, context.relativePath));
    }



    this.emitEntityGraph(entities, nodes, edges);

    const exports = entities.map(e => e.className);

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

  private emitEntityGraph(entities: TypeORMEntity[], nodes: CASNode[], edges: CASEdge[]): void {
    const entityByClass = new Map<string, TypeORMEntity>();
    for (const entity of entities) {
      entityByClass.set(entity.className, entity);
    }

    for (const entity of entities) {
      const nodeId = `entity_typeorm_${entity.className.toLowerCase()}`;

      const fields = [
        ...entity.columns.map(col => ({
          name: col.name,
          type: col.type,
          primary: col.isPrimary,
          generated: col.isGenerated,
          relation: false
        })),
        ...entity.relations.map(rel => ({
          name: rel.name,
          type: rel.targetEntity,
          primary: false,
          generated: false,
          relation: true,
          relationType: rel.kind
        }))
      ];

      nodes.push(this.createNode(
        nodeId,
        entity.className,
        'entity',
        3,
        entity.filePath,
        entity.line,
        undefined,
        {
          orm: 'TypeORM',
          source: 'typeorm_entity',
          tableName: entity.tableName,
          fields,
          annotations: ['Entity'],
          subcategories: ['entity', 'typeorm']
        }
      ));

      for (const col of entity.columns) {
        const fieldNodeId = `field_typeorm_${entity.className.toLowerCase()}_${col.name.toLowerCase()}`;
        nodes.push(this.createNode(
          fieldNodeId,
          col.name,
          'field',
          4,
          entity.filePath,
          entity.line,
          undefined,
          {
            orm: 'TypeORM',
            source: 'typeorm_column',
            entity: entity.className,
            dataType: col.type,
            primary: col.isPrimary,
            generated: col.isGenerated,
            subcategories: ['field', 'typeorm']
          }
        ));
        edges.push(this.createEdge(
          `typeorm_field_${entity.className}_${col.name}`,
          nodeId,
          fieldNodeId,
          'has_field',
          'database',
          { attributes: { field: col.name, type: col.type } }
        ));
      }

      for (const rel of entity.relations) {
        if (!entityByClass.has(rel.targetEntity)) {
          continue;
        }
        edges.push(this.createEdge(
          `typeorm_rel_${entity.className}_${rel.name}_${rel.targetEntity}`,
          nodeId,
          `entity_typeorm_${rel.targetEntity.toLowerCase()}`,
          'references',
          'database',
          {
            attributes: {
              relationType: rel.kind,
              field: rel.name,
              targetEntity: rel.targetEntity,
              via: 'decorator'
            }
          }
        ));
      }
    }
  }




  private parseEntities(content: string, filePath: string): TypeORMEntity[] {
    const entities: TypeORMEntity[] = [];

    const entityRegex = /@Entity\s*\(\s*(?:['"`]([^'"`]+)['"`])?[^)]*\)\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;

    let match: RegExpExecArray | null;
    while ((match = entityRegex.exec(content)) !== null) {
      const tableName = match[1] || match[2];
      const className = match[2];
      const classBodyStart = content.indexOf('{', entityRegex.lastIndex);
      if (classBodyStart === -1) {
        continue;
      }
      const body = this.extractBalanced(content, classBodyStart);
      if (body === null) {
        continue;
      }
      const line = content.slice(0, match.index).split('\n').length;
      entities.push({
        className,
        tableName,
        columns: this.parseColumns(body),
        relations: this.parseRelations(body),
        filePath,
        line
      });
    }

    return entities;
  }




  private parseColumns(body: string): TypeORMColumn[] {
    const columns: TypeORMColumn[] = [];
    const colRegex = /@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn)\s*\(([^)]*)\)\s*(\w+)/g;

    let match: RegExpExecArray | null;
    while ((match = colRegex.exec(body)) !== null) {
      const decorator = match[1];
      const args = match[2] || '';
      const name = match[3];

      let type = 'unknown';
      const typeMatch = /['"`](\w+)['"`]/.exec(args) || /type\s*:\s*['"`](\w+)['"`]/.exec(args);
      if (typeMatch) {
        type = typeMatch[1];
      }

      columns.push({
        name,
        type,
        isPrimary: decorator === 'PrimaryGeneratedColumn' || decorator === 'PrimaryColumn',
        isGenerated: decorator === 'PrimaryGeneratedColumn'
      });
    }

    return columns;
  }




  private parseRelations(body: string): TypeORMRelationField[] {
    const relations: TypeORMRelationField[] = [];

    const relRegex = /@(OneToMany|ManyToOne|ManyToMany|OneToOne)\s*\(\s*(?:\([^)]*\)|\w+)?\s*=>\s*(\w+)[\s\S]*?\)\s*(\w+)/g;

    let match: RegExpExecArray | null;
    while ((match = relRegex.exec(body)) !== null) {
      relations.push({
        kind: match[1] as TypeORMRelationKind,
        targetEntity: match[2],
        name: match[3]
      });
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
    return ['typeorm-entities', 'typeorm-columns', 'typeorm-relations'];
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
