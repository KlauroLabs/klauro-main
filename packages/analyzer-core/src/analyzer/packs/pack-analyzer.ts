/**
 * PackAnalyzer — a single BaseAnalyzer that runs EVERY loaded declarative
 * pack against a project. One analyzer instance (not one per pack) because
 * packs are additive/data-only and the orchestrator's analyzer list is coded
 * in TypeScript; a pack does not need its own class, only its own YAML.
 *
 * This is the "declarative analyzer" the SPEC promises: instead of writing a
 * new *-analyzer.ts, a community author writes a *.pack.yaml with tree-sitter
 * queries, and it produces real CAS entry_points/entities/edges the same way
 * a coded analyzer would — see docs/SPEC-ANALYZER-PACKS.md.
 *
 * Additive by design: PackAnalyzer registers alongside coded analyzers in
 * apps/mcp-server/src/analyzer.ts (own registerAnalyzer() call) and never
 * replaces one — if a coded analyzer AND a pack both match a repo, both
 * contribute (duplicate facts are a follow-up dedup concern, out of scope for
 * this prototype; see SPEC "honest scope").
 */
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';
import { BaseAnalyzer, AnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, generateNodeId, generateEdgeId } from '../../types/cas.types';
import { AnalyzerError } from '../core/errors';
import { LoadedPack, loadPacksForProject } from './pack-loader';
import { evaluateAppliesWhen } from './pack-applies-when';
import { runPackQuery, packLanguageHasGrammar, PackQueryError } from './pack-query-runner';
import { mapMatchToFacts, MappedFact } from './pack-fact-mapper';

const DEFAULT_EXTENSIONS: Record<string, string[]> = {
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  'typescript-javascript': ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
};

export interface PackAnalyzerDiagnostics {
  packsConsidered: string[];
  packsApplied: string[];
  packsSkipped: Array<{ pack: string; reason: string }>;
  loadErrors: Array<{ sourcePath: string; errors: string[] }>;
  ruleErrors: Array<{ pack: string; rule: string; error: string }>;
}

export class PackAnalyzer extends BaseAnalyzer {
  /** Local pack globs declared by .klaurorc (analyzer-packs section), set by
   *  the host before analyze() runs. Optional — defaults to built-ins only. */
  public localPackGlobs: string[] = [];

  /** Populated after analyze() runs — surfaced by the caller for reporting/tests. */
  public lastDiagnostics: PackAnalyzerDiagnostics = {
    packsConsidered: [], packsApplied: [], packsSkipped: [], loadErrors: [], ruleErrors: [],
  };

  constructor() {
    super('analyzer-packs', 'Declarative Analyzer-Pack Engine', '0.1.0', 'pattern');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const { packs } = await loadPacksForProject(projectPath, this.localPackGlobs);
    return packs.length > 0;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    const diagnostics: PackAnalyzerDiagnostics = {
      packsConsidered: [], packsApplied: [], packsSkipped: [], loadErrors: [], ruleErrors: [],
    };

    try {
      const { packs, errors } = await loadPacksForProject(context.projectPath, this.localPackGlobs);
      diagnostics.loadErrors = errors;
      diagnostics.packsConsidered = packs.map(p => p.pack.pack);

      // Track named facts (entry_point/entity) so edge/binding/role rules in
      // later packs can resolve @capture names against a REAL emitted node id.
      const nodeIdByName = new Map<string, string>();

      for (const loaded of packs) {
        await this.applyPack(loaded, context, nodes, edges, entryPoints, exitPoints, nodeIdByName, diagnostics);
      }
    } catch (error) {
      throw new AnalyzerError(`Analyzer-pack engine failed: ${(error as Error).message}`, 'PACK_ANALYSIS_ERROR');
    }

    this.lastDiagnostics = diagnostics;

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      packsConsidered: diagnostics.packsConsidered,
      packsApplied: diagnostics.packsApplied,
      packsSkipped: diagnostics.packsSkipped,
      loadErrors: diagnostics.loadErrors,
      ruleErrors: diagnostics.ruleErrors,
    });
  }

  private async applyPack(
    loaded: LoadedPack,
    context: AnalysisContext,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    nodeIdByName: Map<string, string>,
    diagnostics: PackAnalyzerDiagnostics,
  ): Promise<void> {
    const pack = loaded.pack;

    if (!packLanguageHasGrammar(pack.language)) {
      diagnostics.packsSkipped.push({ pack: pack.pack, reason: `no tree-sitter grammar available for language "${pack.language}"` });
      return;
    }

    const extensions = pack.files?.length ? null : (DEFAULT_EXTENSIONS[pack.language] || []);
    const globs = pack.files?.length ? pack.files : extensions!.map(ext => `**/*.${ext}`);
    const candidateFiles = await glob(globs, {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
      nodir: true,
    });

    if (candidateFiles.length === 0) {
      diagnostics.packsSkipped.push({ pack: pack.pack, reason: 'no matching files in project' });
      return;
    }

    const gate = await evaluateAppliesWhen(context.projectPath, pack.applies_when, candidateFiles);
    if (!gate.applies) {
      diagnostics.packsSkipped.push({ pack: pack.pack, reason: gate.reason });
      return;
    }

    let appliedAnyFact = false;

    for (const file of candidateFiles) {
      let source: string;
      try {
        source = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
      } catch {
        continue;
      }

      for (const rule of pack.rules) {
        let matches;
        try {
          matches = await runPackQuery(pack.language, source, rule.name, rule.query);
        } catch (error) {
          if (error instanceof PackQueryError) {
            diagnostics.ruleErrors.push({ pack: pack.pack, rule: rule.name, error: error.message });
            continue; // bad query in one rule must not crash the whole pack/file
          }
          throw error;
        }

        for (const match of matches) {
          const facts = mapMatchToFacts(rule.emit, match, file);
          for (const fact of facts) {
            appliedAnyFact = true;
            this.emitFact(pack.pack, fact, nodes, edges, entryPoints, nodeIdByName);
          }
        }
      }
    }

    if (appliedAnyFact) {
      diagnostics.packsApplied.push(pack.pack);
    } else {
      diagnostics.packsSkipped.push({ pack: pack.pack, reason: 'applies_when gate matched but no rule produced any fact (queries found nothing)' });
    }
  }

  private emitFact(
    packId: string,
    fact: MappedFact,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    nodeIdByName: Map<string, string>,
  ): void {
    switch (fact.kind) {
      case 'entry_point': {
        const nodeId = generateNodeId('pack_entry_point', fact.file, `${packId}_${fact.name}_${fact.line}`);
        const node = this.createNodeBuilder(nodeId, fact.name, 'route')
          .withLevel(3, this.getLevelName(3))
          .withCategory('route', ['pack', packId])
          .withSource({ file: fact.file, line: fact.line })
          .withDescription(`${packId} pack entry point: ${fact.name}`)
          .withTags([`analyzer:${this.id}`, `pack:${packId}`])
          .withMetadata({ framework: packId, attributes: { pack: packId, method: fact.method, path: fact.path, handler: fact.handler } })
          .build();
        nodes.push(node);
        nodeIdByName.set(fact.name, nodeId);

        entryPoints.push(this.createEntryPoint(
          `entry_${nodeId}`,
          nodeId,
          fact.entryKind as CASEntryPoint['type'],
          fact.name,
          `${packId} pack entry point: ${fact.name}`,
          { method: fact.method, path: fact.path },
          undefined,
          { pack: packId, method: fact.method, path: fact.path, handler: fact.handler },
          fact.handler ? { node_id: nodeId, method_name: fact.handler, file: fact.file } : undefined,
        ));
        break;
      }
      case 'entity': {
        const nodeId = generateNodeId(fact.nodeType, fact.file, `${packId}_${fact.name}`);
        const node = this.createNodeBuilder(nodeId, fact.name, fact.nodeType)
          .withLevel(3, this.getLevelName(3))
          .withCategory(fact.nodeType, ['pack', packId])
          .withSource({ file: fact.file, line: fact.line })
          .withDescription(`${packId} pack entity: ${fact.name}`)
          .withTags([`analyzer:${this.id}`, `pack:${packId}`])
          .withMetadata({ framework: packId, attributes: { pack: packId } })
          .build();
        nodes.push(node);
        nodeIdByName.set(fact.name, nodeId);
        break;
      }
      case 'edge': {
        const fromId = nodeIdByName.get(fact.from) || fact.from;
        const toId = nodeIdByName.get(fact.to) || fact.to;
        // Both endpoints must resolve to a real emitted node — never fabricate
        // an edge to a name nothing in this analysis actually produced.
        if (!nodeIdByName.has(fact.from) || !nodeIdByName.has(fact.to)) break;
        edges.push(this.createEdge(generateEdgeId(fromId, toId, fact.edgeType), fromId, toId, fact.edgeType, 'pack', { attributes: { pack: packId } }));
        break;
      }
      case 'binding': {
        // Bindings surface as a `binds` edge between token and implementation
        // entity nodes when both are known; otherwise as node metadata only
        // (recorded via a lightweight node so it's queryable even standalone).
        const tokenId = nodeIdByName.get(fact.token);
        const implId = nodeIdByName.get(fact.implementation);
        if (tokenId && implId) {
          edges.push(this.createEdge(generateEdgeId(tokenId, implId, 'binds'), tokenId, implId, 'binds', 'pack', { attributes: { pack: packId } }));
        }
        break;
      }
      case 'role': {
        const targetId = nodeIdByName.get(fact.target);
        if (!targetId) break;
        const node = nodes.find(n => n.id === targetId);
        if (node) {
          node.tags = [...new Set([...(node.tags || []), `role:${fact.role}`])];
        }
        break;
      }
    }
  }

  protected getCapabilities(): string[] {
    return ['declarative-analyzer-packs', 'pack-entry-points', 'pack-entities'];
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
