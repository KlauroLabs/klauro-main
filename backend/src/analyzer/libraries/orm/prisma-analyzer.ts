import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

interface PrismaField {
  name: string;
  type: string;
  isArray: boolean;
  isPrimary: boolean;
  isUnique: boolean;
  isOptional: boolean;
  isRelation: boolean;
}

interface PrismaModel {
  name: string;
  fields: PrismaField[];
  filePath: string;
}

export class PrismaAnalyzer extends BaseAnalyzer {
  constructor() {
    super('prisma', 'Prisma ORM Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };
      if (allDeps['prisma'] || allDeps['@prisma/client']) {
        return true;
      }
    }

    const schemaPath = path.join(projectPath, 'prisma', 'schema.prisma');
    return fs.pathExists(schemaPath);
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];

    const ignorePatterns = this.getIgnorePatterns(context);
    const schemaFiles = await glob('**/prisma/schema.prisma', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true
    });

    for (const schemaFile of schemaFiles) {
      const content = await fs.readFile(schemaFile, 'utf-8');
      const relativePath = path.relative(context.projectPath, schemaFile);
      const models = this.parseModels(content, relativePath);

      const modelNames = new Set(models.map(m => m.name));

      for (const model of models) {
        const nodeId = `entity_prisma_${model.name.toLowerCase()}`;

        const fields = model.fields.map(field => ({
          name: field.name,
          type: field.type,
          primary: field.isPrimary,
          unique: field.isUnique,
          optional: field.isOptional,
          relation: field.isRelation
        }));

        const node = this.createNode(
          nodeId,
          model.name,
          'entity',
          3,
          model.filePath,
          undefined,
          undefined,
          {
            orm: 'Prisma',
            source: 'prisma_schema',
            fields,
            annotations: ['PrismaModel'],
            subcategories: ['entity', 'prisma']
          }
        );

        nodes.push(node);

        for (const field of model.fields) {
          if (modelNames.has(field.type)) {
            const edgeId = `prisma_rel_${model.name}_${field.name}_${field.type}`;
            const sourceId = nodeId;
            const targetId = `entity_prisma_${field.type.toLowerCase()}`;

            const edge = this.createEdge(
              edgeId,
              sourceId,
              targetId,
              'references',
              'database',
              {
                attributes: {
                  relationType: field.isArray ? 'OneToMany' : 'ManyToOne',
                  field: field.name,
                  targetModel: field.type,
                  isArray: field.isArray
                }
              }
            );

            edges.push(edge);
          }
        }
      }
    }

    return this.createContribution(nodes, edges, [], [], {
      orm: 'Prisma',
      schemasAnalyzed: schemaFiles.length,
      modelsFound: nodes.length,
      relationshipsFound: edges.length
    });
  }

  private parseModels(content: string, filePath: string): PrismaModel[] {
    const models: PrismaModel[] = [];
    const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;

    let match;
    while ((match = modelRegex.exec(content)) !== null) {
      const modelName = match[1];
      const modelBody = match[2];
      const fields = this.parseFields(modelBody);

      models.push({
        name: modelName,
        fields,
        filePath
      });
    }

    return models;
  }

  private parseFields(modelBody: string): PrismaField[] {
    const fields: PrismaField[] = [];
    const fieldRegex = /\s+(\w+)\s+(\w+)(\[\])?\s*(.*)/g;

    let match;
    while ((match = fieldRegex.exec(modelBody)) !== null) {
      const name = match[1];
      const type = match[2];
      const isArray = !!match[3];
      const modifiers = match[4] || '';

      if (name === 'model' || name === '@@') {
        continue;
      }

      fields.push({
        name,
        type,
        isArray,
        isPrimary: modifiers.includes('@id'),
        isUnique: modifiers.includes('@unique'),
        isOptional: modifiers.includes('?'),
        isRelation: modifiers.includes('@relation')
      });
    }

    return fields;
  }

  protected getCapabilities(): string[] {
    return ['prisma-schema-parsing', 'entity-detection', 'relationship-mapping', 'database-schema'];
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
