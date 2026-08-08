import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

/** A `@flow` or `@task`-decorated function. */
interface PrefectNode {
  kind: 'flow' | 'task';
  name: string;
  file: string;
  line: number;
  bodyStart: number;
  bodyEnd: number;
}

const DECORATOR_PATTERN = /^\s*@(flow|task)\b\s*(\([^)]*\))?\s*$/;
const DEF_PATTERN = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const CALL_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

export class PrefectAnalyzer extends BaseAnalyzer {
  constructor() {
    super('prefect', 'Prefect Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (/prefect/i.test(requirements)) return true;
      }

      const pyFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
        nodir: true
      });

      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikePrefect(content)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private looksLikePrefect(content: string): boolean {
    return /from\s+prefect\b|import\s+prefect\b/.test(content) &&
      (/@flow\b/.test(content) || /@task\b/.test(content));
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

      const prefectFiles: string[] = [];
      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        if (this.looksLikePrefect(content)) prefectFiles.push(file);
      }

      if (prefectFiles.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, { framework: 'prefect', flowsFound: 0 });
      }

      let flowsFound = 0;
      let tasksFound = 0;
      let dependenciesFound = 0;

      for (const file of prefectFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        const lines = content.split('\n');
        const prefectNodes = this.extractPrefectNodes(content, file);
        const nodeIdByName = new Map<string, string>();

        for (const pn of prefectNodes) {
          const nodeId = `prefect_${pn.kind}_${this.sanitizeId(pn.name)}_${this.sanitizeId(file)}_${pn.line}`;
          nodeIdByName.set(pn.name, nodeId);

          const casType = pn.kind === 'flow' ? 'pipeline' : 'task';
          const node = this.createNodeBuilder(nodeId, pn.name, casType)
            .withLevel(pn.kind === 'flow' ? 2 : 3, pn.kind === 'flow' ? 'architectural' : 'code')
            .withCategory(casType, ['prefect', pn.kind])
            .withSource({ file: pn.file, line: pn.line, end_line: pn.bodyEnd })
            .withDescription(`Prefect ${pn.kind}: ${pn.name}`)
            .withMetadata({ framework: 'prefect', attributes: { kind: pn.kind } })
            .build();
          nodes.push(node);

          if (pn.kind === 'flow') flowsFound++;
          else tasksFound++;

          entryPoints.push(this.createEntryPoint(
            `entry_${nodeId}`,
            nodeId,
            pn.kind === 'flow' ? 'pipeline' : 'task',
            pn.name,
            `Prefect ${pn.kind} entry point: ${pn.name}`,
            undefined,
            undefined,
            { framework: 'prefect', kind: pn.kind },
            { node_id: nodeId, method_name: pn.name, file: pn.file, line: pn.line }
          ));
        }

        // Dependency edges: within each `@flow` body, calls to other known `@task`/`@flow`
        // functions define the flow -> task fan-out (Prefect tasks are called as plain
        // functions/`.submit()` inside the flow body, not chained via `>>`).
        const flowNodes = prefectNodes.filter(n => n.kind === 'flow');
        for (const flow of flowNodes) {
          const flowId = nodeIdByName.get(flow.name);
          if (!flowId) continue;
          const bodyLines = lines.slice(flow.bodyStart, flow.bodyEnd + 1).join('\n');
          const calledNames = new Set<string>();
          let match: RegExpExecArray | null;
          const callRegex = new RegExp(CALL_PATTERN);
          while ((match = callRegex.exec(bodyLines)) !== null) {
            calledNames.add(match[1]);
          }
          for (const other of prefectNodes) {
            if (other.name === flow.name) continue;
            if (calledNames.has(other.name)) {
              const otherId = nodeIdByName.get(other.name);
              if (!otherId) continue;
              edges.push(this.createEdge(
                `${flowId}_invokes_${otherId}`,
                flowId,
                otherId,
                'invokes',
                'prefect-dependency',
                { framework: 'prefect' }
              ));
              dependenciesFound++;
            }
          }
        }
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'prefect',
        flowsFound,
        tasksFound,
        dependenciesFound
      });
    } catch (error) {
      throw new AnalyzerError(`Prefect analysis failed: ${(error as Error).message}`, 'PREFECT_ANALYSIS_ERROR');
    }
  }

  extractPrefectNodes(content: string, file: string): PrefectNode[] {
    const results: PrefectNode[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const decoratorMatch = lines[i].match(DECORATOR_PATTERN);
      if (!decoratorMatch) continue;

      const kind = decoratorMatch[1] as PrefectNode['kind'];
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('@'))) {
        if (j - i > 6) break;
        j++;
      }
      const defMatch = j < lines.length ? lines[j].match(DEF_PATTERN) : null;
      if (!defMatch) continue;

      const name = defMatch[1];
      const defIndent = lines[j].match(/^\s*/)?.[0].length ?? 0;
      let bodyEnd = j;
      for (let k = j + 1; k < lines.length; k++) {
        if (lines[k].trim() === '') { bodyEnd = k; continue; }
        const indent = lines[k].match(/^\s*/)?.[0].length ?? 0;
        if (indent <= defIndent) break;
        bodyEnd = k;
      }

      results.push({ kind, name, file, line: j + 1, bodyStart: j, bodyEnd });
    }

    return results;
  }

  protected getCapabilities(): string[] {
    return ['prefect-analysis', 'flow-extraction', 'task-extraction', 'dependency-graph'];
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
