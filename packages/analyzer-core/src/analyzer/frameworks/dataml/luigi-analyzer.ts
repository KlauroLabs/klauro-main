import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';





interface LuigiTask {
  className: string;
  file: string;
  line: number;
  bodyEnd: number;
  requires: string[];
}

const CLASS_PATTERN = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([^)]*luigi\.Task[^)]*|[A-Za-z_][A-Za-z0-9_.]*Task)\s*\)\s*:/;
const REQUIRES_DEF_PATTERN = /^\s*def\s+requires\s*\(\s*self\s*\)\s*:/;
const RETURN_NAME_PATTERN = /return\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

export class LuigiAnalyzer extends BaseAnalyzer {
  constructor() {
    super('luigi', 'Luigi Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (/\bluigi\b/i.test(requirements)) return true;
      }

      const pyFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
        nodir: true
      });

      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeLuigi(content)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private looksLikeLuigi(content: string): boolean {
    return /import\s+luigi\b|from\s+luigi\b/.test(content) && /luigi\.Task\b/.test(content);
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const pyFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      });

      const luigiFiles: string[] = [];
      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        if (this.looksLikeLuigi(content)) luigiFiles.push(file);
      }

      if (luigiFiles.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, { framework: 'luigi', tasksFound: 0 });
      }

      const allTasks: LuigiTask[] = [];
      for (const file of luigiFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        allTasks.push(...this.extractLuigiTasks(content, file));
      }

      const nodeIdByClass = new Map<string, string>();
      let dependenciesFound = 0;

      for (const task of allTasks) {
        const nodeId = `luigi_task_${this.sanitizeId(task.className)}_${this.sanitizeId(task.file)}`;
        nodeIdByClass.set(task.className, nodeId);

        const node = this.createNodeBuilder(nodeId, task.className, 'task')
          .withLevel(3, 'code')
          .withCategory('task', ['luigi', 'batch-task'])
          .withSource({ file: task.file, line: task.line, end_line: task.bodyEnd })
          .withDescription(`Luigi task: ${task.className}`)
          .withMetadata({ framework: 'luigi' })
          .build();
        nodes.push(node);

        entryPoints.push(this.createEntryPoint(
          `entry_${nodeId}`,
          nodeId,
          'task',
          task.className,
          `Luigi task entry point: ${task.className}`,
          undefined,
          undefined,
          { framework: 'luigi' },
          { node_id: nodeId, method_name: 'run', file: task.file, line: task.line }
        ));
      }

      for (const task of allTasks) {
        const targetId = nodeIdByClass.get(task.className);
        if (!targetId) continue;
        for (const reqClass of task.requires) {
          const sourceId = nodeIdByClass.get(reqClass) || `luigi_ref_${this.sanitizeId(reqClass)}`;
          edges.push(this.createEdge(
            `${sourceId}_precedes_${targetId}`,
            sourceId,
            targetId,
            'precedes',
            'luigi-dependency',
            { framework: 'luigi' }
          ));
          dependenciesFound++;
        }
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'luigi',
        tasksFound: allTasks.length,
        dependenciesFound
      });
    } catch (error) {
      throw new AnalyzerError(`Luigi analysis failed: ${(error as Error).message}`, 'LUIGI_ANALYSIS_ERROR');
    }
  }

  extractLuigiTasks(content: string, file: string): LuigiTask[] {
    const results: LuigiTask[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const classMatch = lines[i].match(CLASS_PATTERN);
      if (!classMatch) continue;

      const className = classMatch[1];
      const classIndent = lines[i].match(/^\s*/)?.[0].length ?? 0;
      let bodyEnd = i;
      let requiresBody = '';
      let inRequires = false;
      let requiresIndent = -1;

      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].trim() === '') { bodyEnd = k; continue; }
        const indent = lines[k].match(/^\s*/)?.[0].length ?? 0;
        if (indent <= classIndent) break;
        bodyEnd = k;

        if (REQUIRES_DEF_PATTERN.test(lines[k])) {
          inRequires = true;
          requiresIndent = indent;
          continue;
        }
        if (inRequires) {
          if (indent <= requiresIndent) {
            inRequires = false;
          } else {
            requiresBody += lines[k] + '\n';
          }
        }
      }

      const requires: string[] = [];
      let match: RegExpExecArray | null;
      const returnRegex = new RegExp(RETURN_NAME_PATTERN);
      while ((match = returnRegex.exec(requiresBody)) !== null) {
        requires.push(match[1]);
      }

      const yieldRegex = /yield\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      while ((match = yieldRegex.exec(requiresBody)) !== null) {
        if (!requires.includes(match[1])) requires.push(match[1]);
      }

      results.push({ className, file, line: i + 1, bodyEnd, requires });
    }

    return results;
  }

  protected getCapabilities(): string[] {
    return ['luigi-analysis', 'task-extraction', 'requires-dependency-graph'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }
}
