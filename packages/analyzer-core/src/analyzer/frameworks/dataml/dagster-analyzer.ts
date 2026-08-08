import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

/** A `@asset` / `@op`-decorated function, or an `@job` composing ops. */
interface DagsterNode {
  kind: 'asset' | 'op' | 'job' | 'graph';
  name: string;
  file: string;
  line: number;
  deps: string[]; // asset `deps=[...]` / `ins=` param names / op fn params (best-effort)
}

const DECORATOR_PATTERN = /^\s*@(asset|op|job|graph)\b\s*(\(([^)]*)\))?\s*$/;
const DEF_PATTERN = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/;
const DEPS_KW_PATTERN = /deps\s*=\s*\[([^\]]*)\]/;
const INS_KW_PATTERN = /ins\s*=\s*\{([^}]*)\}/;

export class DagsterAnalyzer extends BaseAnalyzer {
  constructor() {
    super('dagster', 'Dagster Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (/dagster/i.test(requirements)) return true;
      }

      const pyFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
        nodir: true
      });

      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeDagster(content)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private looksLikeDagster(content: string): boolean {
    return /from\s+dagster\b|import\s+dagster\b/.test(content) &&
      (/@asset\b/.test(content) || /@op\b/.test(content) || /@job\b/.test(content) || /@graph\b/.test(content));
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

      const dagsterFiles: string[] = [];
      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        if (this.looksLikeDagster(content)) dagsterFiles.push(file);
      }

      if (dagsterFiles.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, { framework: 'dagster', assetsFound: 0 });
      }

      let assetsFound = 0;
      let opsFound = 0;
      let jobsFound = 0;
      let dependenciesFound = 0;
      const nodeIdByName = new Map<string, string>();

      // Pass 1: collect all decorated nodes across files so cross-file asset deps resolve.
      const allDagsterNodes: DagsterNode[] = [];
      for (const file of dagsterFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        allDagsterNodes.push(...this.extractDagsterNodes(content, file));
      }

      for (const dn of allDagsterNodes) {
        const nodeId = `dagster_${dn.kind}_${this.sanitizeId(dn.name)}_${this.sanitizeId(dn.file)}`;
        nodeIdByName.set(dn.name, nodeId);

        const casType = dn.kind === 'job' || dn.kind === 'graph' ? 'pipeline' : 'task';
        const node = this.createNodeBuilder(nodeId, dn.name, casType)
          .withLevel(dn.kind === 'job' || dn.kind === 'graph' ? 2 : 3, dn.kind === 'job' || dn.kind === 'graph' ? 'architectural' : 'code')
          .withCategory(casType, ['dagster', dn.kind])
          .withSource({ file: dn.file, line: dn.line, end_line: dn.line })
          .withDescription(`Dagster ${dn.kind}: ${dn.name}`)
          .withMetadata({ framework: 'dagster', attributes: { kind: dn.kind } })
          .build();
        nodes.push(node);

        if (dn.kind === 'asset') assetsFound++;
        else if (dn.kind === 'op') opsFound++;
        else jobsFound++;

        const entryType = dn.kind === 'job' || dn.kind === 'graph' ? 'pipeline' : 'task';
        entryPoints.push(this.createEntryPoint(
          `entry_${nodeId}`,
          nodeId,
          entryType,
          dn.name,
          `Dagster ${dn.kind} entry point: ${dn.name}`,
          undefined,
          undefined,
          { framework: 'dagster', kind: dn.kind },
          { node_id: nodeId, method_name: dn.name, file: dn.file, line: dn.line }
        ));
      }

      // Pass 2: dependency edges from asset `deps=[...]`/`ins={...}` and op param names.
      for (const dn of allDagsterNodes) {
        const targetId = nodeIdByName.get(dn.name);
        if (!targetId) continue;
        for (const depName of dn.deps) {
          const sourceId = nodeIdByName.get(depName) || `dagster_ref_${this.sanitizeId(depName)}`;
          edges.push(this.createEdge(
            `${sourceId}_feeds_${targetId}`,
            sourceId,
            targetId,
            'feeds',
            'dagster-dependency',
            { framework: 'dagster' }
          ));
          dependenciesFound++;
        }
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'dagster',
        assetsFound,
        opsFound,
        jobsFound,
        dependenciesFound
      });
    } catch (error) {
      throw new AnalyzerError(`Dagster analysis failed: ${(error as Error).message}`, 'DAGSTER_ANALYSIS_ERROR');
    }
  }

  extractDagsterNodes(content: string, file: string): DagsterNode[] {
    const results: DagsterNode[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const decoratorMatch = lines[i].match(DECORATOR_PATTERN);
      if (!decoratorMatch) continue;

      const kind = decoratorMatch[1] as DagsterNode['kind'];
      const decoratorArgs = decoratorMatch[3] || '';

      // Decorator args may span multiple lines before the closing paren; join a
      // bounded lookahead window so `deps=[...]` split across lines still matches.
      let argsText = decoratorArgs;
      if (decoratorMatch[2] && !decoratorArgs.includes(')')) {
        let j = i;
        while (j < lines.length - 1 && !/\)\s*$/.test(lines[j].trim())) {
          j++;
          argsText += '\n' + lines[j];
          if (j - i > 20) break;
        }
      }

      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('@'))) {
        // Skip stacked decorators/blank lines, but stop scanning past 5 stacked lines.
        if (j - i > 6) break;
        j++;
      }
      const defMatch = j < lines.length ? lines[j].match(DEF_PATTERN) : null;
      if (!defMatch) continue;

      const name = defMatch[1];
      const params = defMatch[2];
      const deps: string[] = [];

      const depsMatch = argsText.match(DEPS_KW_PATTERN);
      if (depsMatch) {
        deps.push(...depsMatch[1].split(',').map(s => s.replace(/["']/g, '').trim()).filter(Boolean));
      }

      const insMatch = argsText.match(INS_KW_PATTERN);
      if (insMatch) {
        const keys = insMatch[1].split(',').map(s => s.split(':')[0].replace(/["']/g, '').trim()).filter(Boolean);
        deps.push(...keys);
      }

      if (kind === 'op' && deps.length === 0 && params.trim()) {
        // Best-effort: op params other than `context` often name upstream op outputs.
        const paramNames = params.split(',').map(p => p.trim().split(':')[0].split('=')[0].trim()).filter(p => p && p !== 'context' && p !== 'self');
        deps.push(...paramNames);
      }

      results.push({ kind, name, file, line: i + 1, deps });
    }

    return results;
  }

  protected getCapabilities(): string[] {
    return ['dagster-analysis', 'asset-extraction', 'op-extraction', 'job-extraction', 'dependency-graph'];
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
