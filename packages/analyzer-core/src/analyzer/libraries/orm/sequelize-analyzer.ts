import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

type SequelizeAssociationKind = 'hasMany' | 'belongsTo' | 'hasOne' | 'belongsToMany';

interface SequelizeAttribute {
  name: string;
  type: string;
  primary: boolean;
}

interface SequelizeAssociation {
  owner: string;
  kind: SequelizeAssociationKind;
  target: string;
  alias?: string;
  foreignKey?: string;
  line: number;
}

interface SequelizeModel {
  className: string;
  tableName?: string;
  attributes: SequelizeAttribute[];
  filePath: string;
  line: number;
}

















export class SequelizeAnalyzer extends BaseAnalyzer {
  constructor() {
    super('sequelize', 'Sequelize Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (allDeps['sequelize']) {
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

    for (const file of sourceFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (/\bModel\.init\s*\(|\bsequelize\.define\s*\(/.test(content)) {
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
      nodir: true,
    });

    const models: SequelizeModel[] = [];
    const associations: SequelizeAssociation[] = [];

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/\bModel\.init\s*\(|\bsequelize\.define\s*\(|\.(hasMany|belongsTo|hasOne|belongsToMany)\s*\(/.test(content)) {
        continue;
      }
      const relativePath = path.relative(context.projectPath, file);
      models.push(...this.parseInitModels(content, relativePath));
      models.push(...this.parseDefineModels(content, relativePath));
      associations.push(...this.parseAssociations(content));
    }

    this.emitModelGraph(models, associations, nodes, edges);

    return this.createContribution(nodes, edges, [], [], {
      orm: 'Sequelize',
      modelsFound: models.length,
      associationsFound: associations.length,
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
      if (/\bModel\.init\s*\(|\bsequelize\.define\s*\(|\.(hasMany|belongsTo|hasOne|belongsToMany)\s*\(/.test(content)) {
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

    const models: SequelizeModel[] = [];
    const associations: SequelizeAssociation[] = [];
    if (/\bModel\.init\s*\(|\bsequelize\.define\s*\(|\.(hasMany|belongsTo|hasOne|belongsToMany)\s*\(/.test(content)) {
      models.push(...this.parseInitModels(content, context.relativePath));
      models.push(...this.parseDefineModels(content, context.relativePath));
      associations.push(...this.parseAssociations(content));
    }

    this.emitModelGraph(models, associations, nodes, edges);

    const exports = models.map(m => m.className);

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

  private emitModelGraph(
    models: SequelizeModel[],
    associations: SequelizeAssociation[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    const modelByName = new Map<string, SequelizeModel>();
    for (const model of models) {
      modelByName.set(model.className, model);
    }

    for (const model of models) {
      const nodeId = `entity_sequelize_${model.className.toLowerCase()}`;
      const fields = model.attributes.map(attr => ({
        name: attr.name,
        type: attr.type,
        primary: attr.primary,
        relation: false,
      }));

      nodes.push(this.createNode(
        nodeId,
        model.className,
        'entity',
        3,
        model.filePath,
        model.line,
        undefined,
        {
          orm: 'Sequelize',
          source: 'sequelize_model',
          tableName: model.tableName,
          fields,
          annotations: ['SequelizeModel'],
          subcategories: ['entity', 'sequelize'],
        }
      ));

      for (const attr of model.attributes) {
        const fieldNodeId = `field_sequelize_${model.className.toLowerCase()}_${attr.name.toLowerCase()}`;
        nodes.push(this.createNode(
          fieldNodeId,
          attr.name,
          'field',
          4,
          model.filePath,
          model.line,
          undefined,
          {
            orm: 'Sequelize',
            source: 'sequelize_attribute',
            entity: model.className,
            dataType: attr.type,
            primary: attr.primary,
            subcategories: ['field', 'sequelize'],
          }
        ));
        edges.push(this.createEdge(
          `sequelize_field_${model.className}_${attr.name}`,
          nodeId,
          fieldNodeId,
          'has_field',
          'database',
          { attributes: { field: attr.name, type: attr.type } }
        ));
      }
    }

    associations.forEach((assoc, index) => {
      if (!modelByName.has(assoc.owner)) return;
      const ownerId = `entity_sequelize_${assoc.owner.toLowerCase()}`;
      const relationId = `sequelize_assoc_${assoc.owner.toLowerCase()}_${assoc.kind}_${index}`;

      nodes.push(this.createNode(
        relationId,
        assoc.alias || assoc.target,
        'eloquent_relation',
        4,
        undefined,
        assoc.line,
        undefined,
        {
          orm: 'Sequelize',
          source: 'sequelize_association',
          attributes: {
            relation_type: assoc.kind,
            related_model: assoc.target,
            owner_model: assoc.owner,
            foreign_key: assoc.foreignKey,
          },
          subcategories: ['relation', 'sequelize'],
        }
      ));

      edges.push(this.createEdge(
        `sequelize_contains_${ownerId}_${relationId}`,
        ownerId,
        relationId,
        'contains',
        'structural'
      ));

      if (modelByName.has(assoc.target)) {
        edges.push(this.createEdge(
          `sequelize_rel_${assoc.owner}_${assoc.kind}_${assoc.target}_${index}`,
          ownerId,
          `entity_sequelize_${assoc.target.toLowerCase()}`,
          'references',
          'database',
          {
            attributes: {
              relationType: this.decoratorRelationType(assoc.kind),
              field: assoc.alias || assoc.target,
              targetEntity: assoc.target,
              via: 'association',
            },
          }
        ));
      }
    });
  }

  private decoratorRelationType(kind: SequelizeAssociationKind): string {
    switch (kind) {
      case 'hasMany': return 'OneToMany';
      case 'belongsTo': return 'ManyToOne';
      case 'hasOne': return 'OneToOne';
      case 'belongsToMany': return 'ManyToMany';
    }
  }




  private parseInitModels(content: string, filePath: string): SequelizeModel[] {
    const models: SequelizeModel[] = [];
    const initRegex = /(\w+)\.init\s*\(\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = initRegex.exec(content)) !== null) {
      const className = match[1];
      const bodyStart = initRegex.lastIndex - 1;
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) continue;
      const line = content.slice(0, match.index).split('\n').length;


      const afterBody = content.slice(initRegex.lastIndex);
      const tableNameMatch = /tableName\s*:\s*['"`](\w+)['"`]/.exec(afterBody.slice(0, 400));

      models.push({
        className,
        tableName: tableNameMatch?.[1],
        attributes: this.parseAttributes(body),
        filePath,
        line,
      });
    }
    return models;
  }




  private parseDefineModels(content: string, filePath: string): SequelizeModel[] {
    const models: SequelizeModel[] = [];
    const defineRegex = /(?:const|let|var)\s+(\w+)\s*=\s*\w+\.define\s*\(\s*['"`](\w+)['"`]\s*,\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = defineRegex.exec(content)) !== null) {
      const className = match[1];
      const tableName = match[2];
      const bodyStart = defineRegex.lastIndex - 1;
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) continue;
      const line = content.slice(0, match.index).split('\n').length;
      models.push({
        className,
        tableName,
        attributes: this.parseAttributes(body),
        filePath,
        line,
      });
    }
    return models;
  }

  private parseAttributes(body: string): SequelizeAttribute[] {
    const attrs: SequelizeAttribute[] = [];
    const entries = this.splitTopLevel(body);
    for (const entry of entries) {
      const colonIdx = entry.indexOf(':');
      if (colonIdx === -1) continue;
      const name = entry.slice(0, colonIdx).trim().replace(/['"`]/g, '');
      if (!/^\w+$/.test(name)) continue;
      const value = entry.slice(colonIdx + 1).trim();

      let type = 'unknown';
      const typeMatch = /DataTypes\.(\w+)/.exec(value);
      if (typeMatch) type = typeMatch[1];

      attrs.push({
        name,
        type,
        primary: /primaryKey\s*:\s*true/.test(value),
      });
    }
    return attrs;
  }







  private parseAssociations(content: string): SequelizeAssociation[] {
    const associations: SequelizeAssociation[] = [];
    const assocRegex = /(\w+)\.(hasMany|belongsTo|hasOne|belongsToMany)\s*\(\s*(\w+)\s*(?:,\s*\{([^}]*)\})?\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = assocRegex.exec(content)) !== null) {
      const owner = match[1];
      const kind = match[2] as SequelizeAssociationKind;
      const target = match[3];
      const options = match[4] || '';
      const aliasMatch = /as\s*:\s*['"`](\w+)['"`]/.exec(options);
      const fkMatch = /foreignKey\s*:\s*['"`](\w+)['"`]/.exec(options);
      const line = content.slice(0, match.index).split('\n').length;
      associations.push({
        owner,
        kind,
        target,
        alias: aliasMatch?.[1],
        foreignKey: fkMatch?.[1],
        line,
      });
    }
    return associations;
  }

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
    return ['sequelize-models', 'sequelize-fields', 'sequelize-associations'];
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
