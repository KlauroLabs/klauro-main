import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

interface ObjectionRelation {
  name: string;
  relationKind: string;
  targetModel: string;
}

interface ObjectionModel {
  className: string;
  tableName?: string;
  relations: ObjectionRelation[];
  filePath: string;
  line: number;
}















export class ObjectionAnalyzer extends BaseAnalyzer {
  constructor() {
    super('objection', 'Objection.js Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (allDeps['objection']) {
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
        if (/relationMappings/.test(content) && /from\s+['"]objection['"]|require\(['"]objection['"]\)/.test(content)) {
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

    const models: ObjectionModel[] = [];
    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      if (!/extends\s+Model\b/.test(content)) continue;
      const relativePath = path.relative(context.projectPath, file);
      models.push(...this.parseModels(content, relativePath));
    }

    this.emitModelGraph(models, nodes, edges);

    return this.createContribution(nodes, edges, [], [], {
      orm: 'Objection.js',
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
      if (/extends\s+Model\b/.test(content)) {
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

    const models: ObjectionModel[] = /extends\s+Model\b/.test(content)
      ? this.parseModels(content, context.relativePath)
      : [];

    this.emitModelGraph(models, nodes, edges);

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

  private emitModelGraph(models: ObjectionModel[], nodes: CASNode[], edges: CASEdge[]): void {
    const modelByName = new Map<string, ObjectionModel>();
    for (const model of models) modelByName.set(model.className, model);

    for (const model of models) {
      const nodeId = `entity_objection_${model.className.toLowerCase()}`;

      nodes.push(this.createNode(
        nodeId,
        model.className,
        'entity',
        3,
        model.filePath,
        model.line,
        undefined,
        {
          orm: 'Objection.js',
          source: 'objection_model',
          tableName: model.tableName,
          fields: [],
          annotations: ['ObjectionModel'],
          subcategories: ['entity', 'objection'],
        }
      ));

      for (const rel of model.relations) {
        if (!modelByName.has(rel.targetModel)) continue;
        edges.push(this.createEdge(
          `objection_rel_${model.className}_${rel.name}_${rel.targetModel}`,
          nodeId,
          `entity_objection_${rel.targetModel.toLowerCase()}`,
          'references',
          'database',
          {
            attributes: {
              relationType: this.decoratorRelationType(rel.relationKind),
              field: rel.name,
              targetEntity: rel.targetModel,
              via: 'relationMappings',
            },
          }
        ));
      }
    }
  }

  private decoratorRelationType(kind: string): string {
    if (/HasMany/.test(kind)) return 'OneToMany';
    if (/BelongsToOne/.test(kind)) return 'ManyToOne';
    if (/HasOne/.test(kind)) return 'OneToOne';
    if (/ManyToMany/.test(kind)) return 'ManyToMany';
    return 'OneToOne';
  }





  private parseModels(content: string, filePath: string): ObjectionModel[] {
    const models: ObjectionModel[] = [];
    const classRegex = /class\s+(\w+)\s+extends\s+Model\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      const bodyStart = classRegex.lastIndex - 1;
      const body = this.extractBalanced(content, bodyStart);
      if (body === null) continue;
      const line = content.slice(0, match.index).split('\n').length;

      const tableNameMatch = /static\s+get\s+tableName\s*\(\)\s*\{\s*return\s*['"`](\w+)['"`]/.exec(body);

      models.push({
        className,
        tableName: tableNameMatch?.[1],
        relations: this.parseRelationMappings(body),
        filePath,
        line,
      });
    }
    return models;
  }

  private parseRelationMappings(classBody: string): ObjectionRelation[] {
    const relations: ObjectionRelation[] = [];
    const mappingsMatch = /relationMappings\s*\(\)\s*\{\s*return\s*\{/.exec(classBody)
      || /relationMappings\s*=\s*\{/.exec(classBody)
      || /relationMappings\s*:\s*\{/.exec(classBody);
    if (!mappingsMatch) return relations;

    const bodyStart = classBody.indexOf('{', mappingsMatch.index + mappingsMatch[0].length - 1);
    const body = this.extractBalanced(classBody, bodyStart);
    if (body === null) return relations;


    const entryRegex = /(\w+)\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRegex.exec(body)) !== null) {
      const name = entryMatch[1];
      const entryBody = entryMatch[2];
      const kindMatch = /relation\s*:\s*Model\.(\w+)/.exec(entryBody);
      const modelClassMatch = /modelClass\s*:\s*['"`]?(\w+)['"`]?/.exec(entryBody);
      if (kindMatch && modelClassMatch) {
        relations.push({
          name,
          relationKind: kindMatch[1],
          targetModel: modelClassMatch[1],
        });
      }
    }
    return relations;
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
    return ['objection-models', 'objection-relations'];
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
