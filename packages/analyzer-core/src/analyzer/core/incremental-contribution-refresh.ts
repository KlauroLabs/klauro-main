import { isDeepStrictEqual } from 'node:util';
import type {
  CASContribution,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASNode,
  CASOutput,
  FileAnalysisRecord,
} from '../../types/cas.types';
import { replaceArrayContents } from './bulk-array-ops';
import type { AnalysisContext, FileAnalysisResult } from './base-analyzer';
import * as path from 'path';

interface RefreshRegistration {
  id: string;
  type: 'language' | 'framework' | 'library' | 'pattern';
  analyzer: {
    analyze(context: AnalysisContext): Promise<CASContribution>;
    incrementalSourceInvariantContributionFields?(): readonly (keyof CASContribution)[];
  };
}

export type ProjectContributionRefreshFailure =
  | { reason: 'registration-missing'; analyzerIds: string[] }
  | { reason: 'non-replaceable-ownership'; analyzerIds: string[] }
  | { reason: 'non-refreshable-contribution'; analyzerId: string }
  | { reason: 'retained-field-mismatch'; analyzerId: string }
  | { reason: 'analyzer-error'; message: string };

export interface IncrementalGraph {
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
}

export function indexIncrementalGraphItemsByFile(
  projectPath: string,
  output: Pick<CASOutput, 'nodes' | 'edges' | 'entry_points' | 'exit_points'>
): {
  nodesByFile: Map<string, CASNode[]>;
  edgesByFile: Map<string, CASEdge[]>;
  entryPointsByFile: Map<string, CASEntryPoint[]>;
  exitPointsByFile: Map<string, CASExitPoint[]>;
} {
  const nodesByFile = new Map<string, CASNode[]>();
  const edgesByFile = new Map<string, CASEdge[]>();
  const entryPointsByFile = new Map<string, CASEntryPoint[]>();
  const exitPointsByFile = new Map<string, CASExitPoint[]>();
  const relativeFile = (file?: string): string | undefined => file
    ? (path.isAbsolute(file) ? path.relative(projectPath, file) : file)
    : undefined;
  const add = <T>(index: Map<string, T[]>, file: string | undefined, item: T): void => {
    if (!file) return;
    const items = index.get(file) || [];
    items.push(item);
    index.set(file, items);
  };
  const nodesById = new Map(output.nodes.map(node => [node.id, node]));
  for (const node of output.nodes) add(nodesByFile, relativeFile(node.source?.file), node);
  for (const edge of output.edges) {
    const attachedFiles = new Set([edge.source, edge.target]
      .map(id => relativeFile(nodesById.get(id)?.source?.file))
      .filter((file): file is string => Boolean(file)));
    for (const file of attachedFiles) add(edgesByFile, file, edge);
  }
  for (const item of output.entry_points || []) add(entryPointsByFile, relativeFile(nodesById.get(item.source_node)?.source?.file), item);
  for (const item of output.exit_points || []) add(exitPointsByFile, relativeFile(nodesById.get(item.source_node)?.source?.file), item);
  return { nodesByFile, edgesByFile, entryPointsByFile, exitPointsByFile };
}

export function shouldPromoteIncrementalAnalyzerRefresh(
  plannedFileCount: number,
  relevantFileCount: number
): boolean {
  if (plannedFileCount <= 1 || relevantFileCount <= 0) return false;
  return plannedFileCount * plannedFileCount > relevantFileCount;
}

export async function rebuildIncrementalAnalysis(
  projectPath: string,
  trigger: string,
  fullRebuildReason: string,
  run: () => Promise<CASOutput>,
): Promise<{ output: CASOutput; fileResults: Map<string, FileAnalysisResult>; wasFullRebuild: true; fullRebuildReason: string }> {
  process.stderr.write(`[Klauro] incremental full rebuild (${trigger}): ${fullRebuildReason}\n`);
  process.stderr.write(`${JSON.stringify({ event: 'incremental_full_rebuild', project_path: projectPath, trigger, reason: fullRebuildReason })}\n`);
  return { output: await run(), fileResults: new Map(), wasFullRebuild: true, fullRebuildReason };
}

export function shouldPreferFullRebuildForFanout(
  affectedFileCount: number,
  trackedFileCount: number,
  projectScopedAnalyzerCount: number
): boolean {
  const minimumFanoutFiles = 512;
  return projectScopedAnalyzerCount > 0 && affectedFileCount >= minimumFanoutFiles && affectedFileCount >= trackedFileCount;
}

interface PromotionRegistration {
  id: string;
  analyzer: {
    incrementalContributionScope(): 'file' | 'project';
    getRelevantFiles?(projectPath: string): Promise<string[]>;
  };
}

export async function selectPromotedIncrementalAnalyzers(
  projectPath: string,
  registrations: PromotionRegistration[],
  plansByFile: ReadonlyMap<string, readonly { registration: PromotionRegistration }[]>,
  scannedRelevantFilesByAnalyzer: ReadonlyMap<string, number>
): Promise<Set<string>> {
  const plannedFilesByAnalyzer = new Map<string, number>();
  for (const plans of plansByFile.values()) {
    for (const plan of plans) {
      plannedFilesByAnalyzer.set(
        plan.registration.id,
        (plannedFilesByAnalyzer.get(plan.registration.id) || 0) + 1
      );
    }
  }
  const promoted = await Promise.all(registrations.map(async registration => {
    const plannedFileCount = plannedFilesByAnalyzer.get(registration.id) || 0;
    if (registration.analyzer.incrementalContributionScope() === 'project' || plannedFileCount <= 1) return undefined;
    const relevantFileCount = scannedRelevantFilesByAnalyzer.get(registration.id)
      ?? (await registration.analyzer.getRelevantFiles?.(projectPath) || []).length;
    return shouldPromoteIncrementalAnalyzerRefresh(plannedFileCount, relevantFileCount)
      ? registration.id
      : undefined;
  }));
  return new Set(promoted.filter((analyzerId): analyzerId is string => Boolean(analyzerId)));
}

interface ReusableIncrementalFileRecord {
  contentHash: string;
  mtimeMs: number;
  importedFiles?: string[];
  exportedSymbols?: string[];
}

export function reusedIncrementalFileResult(
  relativePath: string,
  record: ReusableIncrementalFileRecord
): FileAnalysisResult {
  return {
    filePath: relativePath,
    contentHash: record.contentHash,
    mtimeMs: record.mtimeMs,
    nodes: [],
    edges: [],
    entryPoints: [],
    exitPoints: [],
    imports: record.importedFiles || [],
    exports: record.exportedSymbols || [],
  };
}

export function mergeIncrementalFileAnalysisResult(
  target: FileAnalysisResult,
  source: FileAnalysisResult
): void {
  const nodeIds = new Set(target.nodes.map(node => node.id));
  const edgeIds = new Set(target.edges.map(edge => edge.id));
  const entryPointIds = new Set(target.entryPoints.map(entryPoint => entryPoint.id));
  const exitPointIds = new Set(target.exitPoints.map(exitPoint => exitPoint.id));

  for (const node of source.nodes) {
    if (!nodeIds.has(node.id)) {
      target.nodes.push(node);
      nodeIds.add(node.id);
      continue;
    }
    const existingNode = target.nodes.find(candidate => candidate.id === node.id);
    if (!existingNode) continue;
    if (node.metadata) existingNode.metadata = { ...existingNode.metadata, ...node.metadata };
    if (node.subcategories?.length) {
      existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), ...node.subcategories])];
    }
    if (node.level !== undefined) existingNode.level = node.level;
    if (node.level_name) existingNode.level_name = node.level_name;
    if (node.description) existingNode.description = node.description;
    if (node.tags?.length) existingNode.tags = [...new Set([...(existingNode.tags || []), ...node.tags])];
    if (node.type) existingNode.type = node.type;
    if (node.analyzers?.length) {
      existingNode.analyzers = [...new Set([...(existingNode.analyzers || []), ...node.analyzers])];
    }
    existingNode.primaryAnalyzer ||= node.primaryAnalyzer;
    if (node.documentation) existingNode.documentation = node.documentation;
    if (node.comments?.length) existingNode.comments = node.comments;
    if (node.todos?.length) existingNode.todos = node.todos;
    if (node.implementation_status) existingNode.implementation_status = node.implementation_status;
    if (node.signature) existingNode.signature = { ...existingNode.signature, ...node.signature };
  }
  for (const edge of source.edges) {
    if (!edgeIds.has(edge.id)) {
      target.edges.push(edge);
      edgeIds.add(edge.id);
    }
  }
  for (const entryPoint of source.entryPoints) {
    if (!entryPointIds.has(entryPoint.id)) {
      target.entryPoints.push(entryPoint);
      entryPointIds.add(entryPoint.id);
    }
  }
  for (const exitPoint of source.exitPoints) {
    if (!exitPointIds.has(exitPoint.id)) {
      target.exitPoints.push(exitPoint);
      exitPointIds.add(exitPoint.id);
    }
  }
  target.imports.push(...source.imports);
  target.exports.push(...source.exports);
}

export function removeFileScopedGraphItems(
  graph: IncrementalGraph,
  record: FileAnalysisRecord,
  analyzerIds: ReadonlySet<string>
): void {
  removeFileScopedGraphItemsBatch(graph, [{ record, analyzerIds }]);
}

export function removeReplaceableFileScopedGraphItems(
  graph: IncrementalGraph,
  record: FileAnalysisRecord,
  analyzerIds: ReadonlySet<string>,
  onDeferredOwnership?: (analyzerIds: readonly string[]) => void
): boolean {
  const ownedNodeIds = new Set(record.nodeIds);
  const deferredNodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!ownedNodeIds.has(node.id)) continue;
    const analyzers = nodeAnalyzers(node);
    if (analyzers.length === 0) return false;
    if (analyzers.some(analyzer => !analyzerIds.has(analyzer))) {
      if (!onDeferredOwnership) return false;
      onDeferredOwnership(analyzers);
      deferredNodeIds.add(node.id);
      continue;
    }
  }
  removeFileScopedGraphItemsBatch(graph, [{ record, analyzerIds }]);
  const removedNodeIds = new Set(graph.nodes
    .filter(node => !deferredNodeIds.has(node.id) && ownedNodeIds.has(node.id) &&
      nodeAnalyzers(node).some(analyzer => analyzerIds.has(analyzer)))
    .map(node => node.id));
  replaceArrayContents(graph.nodes, graph.nodes.filter(node => !removedNodeIds.has(node.id)));
  replaceArrayContents(graph.edges, graph.edges.filter(edge =>
    !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target)
  ));
  replaceArrayContents(graph.entryPoints, graph.entryPoints.filter(item => !removedNodeIds.has(item.source_node)));
  replaceArrayContents(graph.exitPoints, graph.exitPoints.filter(item => !removedNodeIds.has(item.source_node)));
  return true;
}

export function removeFileScopedGraphItemsBatch(
  graph: IncrementalGraph,
  removals: Iterable<{ record: FileAnalysisRecord; analyzerIds: ReadonlySet<string> }>
): void {
  const edgeOwners = new Map<string, Set<string>>();
  const entryPointOwners = new Map<string, Set<string>>();
  const exitPointOwners = new Map<string, Set<string>>();
  const indexOwners = (target: Map<string, Set<string>>, ids: readonly string[], analyzerIds: ReadonlySet<string>) => {
    for (const id of ids) {
      let owners = target.get(id);
      if (!owners) {
        owners = new Set();
        target.set(id, owners);
      }
      for (const analyzerId of analyzerIds) owners.add(analyzerId);
    }
  };
  for (const { record, analyzerIds } of removals) {
    if (analyzerIds.size === 0) continue;
    indexOwners(edgeOwners, record.edgeIds, analyzerIds);
    indexOwners(entryPointOwners, record.entryPointIds, analyzerIds);
    indexOwners(exitPointOwners, record.exitPointIds, analyzerIds);
  }
  const retained = <T extends CASEdge | CASEntryPoint | CASExitPoint>(
    item: T,
    ownersById: ReadonlyMap<string, ReadonlySet<string>>
  ) => {
    const owners = ownersById.get(item.id);
    return !owners || !graphItemAnalyzers(item).some(analyzerId => owners.has(analyzerId));
  };
  replaceArrayContents(graph.edges, graph.edges.filter(item => retained(item, edgeOwners)));
  replaceArrayContents(graph.entryPoints, graph.entryPoints.filter(item => retained(item, entryPointOwners)));
  replaceArrayContents(graph.exitPoints, graph.exitPoints.filter(item => retained(item, exitPointOwners)));
}

export function createIncrementalGraphAccumulator(graph: IncrementalGraph): (result: FileAnalysisResult) => void {
  const nodeIds = new Set(graph.nodes.map(item => item.id));
  const edgeIds = new Set(graph.edges.map(item => item.id));
  const entryPointIds = new Set(graph.entryPoints.map(item => item.id));
  const exitPointIds = new Set(graph.exitPoints.map(item => item.id));
  const append = <T extends { id: string }>(target: T[], source: T[], ids: Set<string>) => {
    for (const item of source) {
      if (ids.has(item.id)) continue;
      target.push(item);
      ids.add(item.id);
    }
  };
  return result => {
    append(graph.nodes, result.nodes, nodeIds);
    append(graph.edges, result.edges, edgeIds);
    append(graph.entryPoints, result.entryPoints, entryPointIds);
    append(graph.exitPoints, result.exitPoints, exitPointIds);
  };
}

export function updatedIncrementalFileRecord(input: {
  previous?: FileAnalysisRecord;
  result: FileAnalysisResult;
  output: CASOutput;
  preservePreviousFacts: boolean;
}): FileAnalysisRecord {
  const currentIds = input.preservePreviousFacts ? {
    nodes: new Set(input.output.nodes.map(item => item.id)),
    edges: new Set(input.output.edges.map(item => item.id)),
    entryPoints: new Set((input.output.entry_points || []).map(item => item.id)),
    exitPoints: new Set((input.output.exit_points || []).map(item => item.id)),
  } : undefined;
  const merge = (current: string[], previous: string[] | undefined, existing?: ReadonlySet<string>) => [
    ...new Set([
      ...current,
      ...(input.preservePreviousFacts ? previous || [] : []).filter(id => existing?.has(id)),
    ]),
  ];
  return {
    filePath: input.result.filePath,
    contentHash: input.result.contentHash,
    mtimeMs: input.result.mtimeMs,
    lastAnalyzed: new Date().toISOString(),
    analyzerId: input.result.nodes.find(node => node.primaryAnalyzer)?.primaryAnalyzer ||
      input.result.nodes.find(node => node.analyzers?.length)?.analyzers?.[0] ||
      input.previous?.analyzerId || 'unknown',
    nodeIds: merge(input.result.nodes.map(item => item.id), input.previous?.nodeIds, currentIds?.nodes),
    edgeIds: merge(input.result.edges.map(item => item.id), input.previous?.edgeIds, currentIds?.edges),
    entryPointIds: merge(input.result.entryPoints.map(item => item.id), input.previous?.entryPointIds, currentIds?.entryPoints),
    exitPointIds: merge(input.result.exitPoints.map(item => item.id), input.previous?.exitPointIds, currentIds?.exitPoints),
    importedFiles: input.result.imports,
    exportedSymbols: input.result.exports,
  };
}

export function projectScopedFileAnalysisSnapshot(
  previous: CASContribution,
  relativePath: string,
): CASContribution {
  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  const nodes = (previous.nodes || []).filter(node => {
    const sourceFile = node.source?.file?.replace(/\\/g, '/');
    return sourceFile === normalizedRelativePath || sourceFile?.endsWith(`/${normalizedRelativePath}`);
  });
  const nodeIds = new Set(nodes.map(node => node.id));
  return {
    nodes,
    edges: (previous.edges || []).filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    entry_points: (previous.entry_points || []).filter(item => nodeIds.has(item.source_node)),
    exit_points: (previous.exit_points || []).filter(item => nodeIds.has(item.source_node)),
    analyzer_metadata: {
      analyzer_id: 'incremental-file-snapshot',
      analyzer_name: 'Incremental File Snapshot',
      version: '1.0.0',
      contribution_type: 'pattern',
      nodes_contributed: nodes.length,
      edges_contributed: 0,
      contributed_entry_points: 0,
      contributed_exit_points: 0,
    },
  };
}

export function overlayIncrementalSnapshot(
  previous: CASContribution,
  current: FileAnalysisResult
): CASContribution {
  if (current.nodes.length === 0 && current.edges.length === 0 && current.entryPoints.length === 0 && current.exitPoints.length === 0) return previous;
  const overlay = <T extends { id: string }>(currentItems: T[], previousItems: T[] | undefined): T[] => {
    const currentIds = new Set(currentItems.map(item => item.id));
    return [...currentItems, ...(previousItems || []).filter(item => !currentIds.has(item.id))];
  };
  return {
    ...previous,
    nodes: overlay(current.nodes, previous.nodes),
    edges: overlay(current.edges, previous.edges),
    entry_points: overlay(current.entryPoints, previous.entry_points),
    exit_points: overlay(current.exitPoints, previous.exit_points),
  };
}

export function createIncrementalAnalysisSnapshot(previous: CASContribution): {
  current: () => CASContribution;
  append: (result: FileAnalysisResult) => void;
} {
  let current = previous;
  return {
    current: () => current,
    append: result => {
      if (current === previous) {
        current = overlayIncrementalSnapshot(previous, result);
        return;
      }
      const append = <T extends { id: string }>(existing: T[] | undefined, added: T[]): T[] => {
        const addedById = new Map(added.map(item => [item.id, item]));
        const existingIds = new Set((existing || []).map(item => item.id));
        return [
          ...(existing || []).map(item => addedById.get(item.id) || item),
          ...added.filter(item => !existingIds.has(item.id)),
        ];
      };
      current = {
        ...current,
        nodes: append(current.nodes, result.nodes),
        edges: append(current.edges, result.edges),
        entry_points: append(current.entry_points, result.entryPoints),
        exit_points: append(current.exit_points, result.exitPoints),
      };
    },
  };
}

export function filterInvalidIncrementalEndpoints(
  result: FileAnalysisResult,
  isValidEntryPoint: (entryPoint: CASEntryPoint) => boolean,
  isValidExitPoint: (exitPoint: CASExitPoint) => boolean
): void {
  const invalidEntryPointIds = new Set(result.entryPoints
    .filter(entryPoint => !isValidEntryPoint(entryPoint))
    .map(entryPoint => entryPoint.id));
  const invalidExitPointIds = new Set(result.exitPoints
    .filter(exitPoint => !isValidExitPoint(exitPoint))
    .map(exitPoint => exitPoint.id));
  result.entryPoints = result.entryPoints.filter(entryPoint => !invalidEntryPointIds.has(entryPoint.id));
  result.exitPoints = result.exitPoints.filter(exitPoint => !invalidExitPointIds.has(exitPoint.id));
  result.edges = result.edges.filter(edge =>
    !invalidEntryPointIds.has(edge.source) && !invalidEntryPointIds.has(edge.target) &&
    !invalidExitPointIds.has(edge.source) && !invalidExitPointIds.has(edge.target)
  );
}

function nodeAnalyzers(node: CASNode): string[] {
  return [...new Set([
    ...(node.analyzers || []),
    ...(node.primaryAnalyzer ? [node.primaryAnalyzer] : []),
  ])];
}

function sourceAnalyzer(item: CASEdge | CASEntryPoint | CASExitPoint): string | undefined {
  const direct = (item as unknown as { source_analyzer?: unknown }).source_analyzer;
  if (typeof direct === 'string') return direct;
  if ('metadata' in item) {
    const metadata = item.metadata as Record<string, unknown> | undefined;
    const metadataAnalyzer = metadata?.source_analyzer;
    if (typeof metadataAnalyzer === 'string') return metadataAnalyzer;
    const attributes = metadata?.attributes as Record<string, unknown> | undefined;
    if (typeof attributes?.source_analyzer === 'string') return attributes.source_analyzer;
  }
  return undefined;
}

export function stampAnalyzerAttribution(
  nodes: CASNode[],
  edges: CASEdge[],
  entryPoints: CASEntryPoint[],
  exitPoints: CASExitPoint[],
  analyzerId: string
): void {
  for (const node of nodes) {
    node.analyzers = [...new Set([...(node.analyzers || []), analyzerId])];
    node.primaryAnalyzer ||= analyzerId;
  }
  for (const edge of edges) {
    const metadata = edge.metadata as Record<string, any> | undefined;
    edge.metadata = {
      ...(metadata || {}),
      attributes: {
        ...(metadata?.attributes || {}),
        source_analyzer: metadata?.attributes?.source_analyzer || analyzerId,
      },
    };
  }
  for (const item of [...entryPoints, ...exitPoints]) {
    item.metadata = {
      ...(item.metadata || {}),
      source_analyzer: item.metadata?.source_analyzer || analyzerId,
    };
  }
}

function mergedAnalyzers(item: CASEntryPoint | CASExitPoint): string[] {
  const metadata = item.metadata as Record<string, unknown> | undefined;
  const merged = metadata?.merged_from_analyzers;
  return Array.isArray(merged)
    ? merged.filter((value): value is string => typeof value === 'string')
    : [];
}

export function graphItemAnalyzers(item: CASEdge | CASEntryPoint | CASExitPoint): string[] {
  return [...new Set([
    sourceAnalyzer(item),
    ...('source_node' in item ? mergedAnalyzers(item) : []),
  ].filter((analyzer): analyzer is string => Boolean(analyzer)))];
}

export function indexIncrementalAnalyzersByFile(
  previousOutput: CASOutput,
  projectPath: string
): Map<string, Set<string>> {
  const analyzerIdsByFile = new Map<string, Set<string>>();
  const normalizeFile = (filePath?: string): string => {
    if (!filePath) return '';
    const relative = path.isAbsolute(filePath) ? path.relative(projectPath, filePath) : filePath;
    return relative.replace(/\\/g, '/').replace(/^\.\//, '');
  };
  const add = (filePath: string | undefined, analyzerIds: Iterable<string>) => {
    const normalized = normalizeFile(filePath);
    if (!normalized) return;
    const indexed = analyzerIdsByFile.get(normalized) || new Set<string>();
    analyzerIdsByFile.set(normalized, indexed);
    for (const analyzerId of analyzerIds) if (analyzerId) indexed.add(analyzerId);
  };
  const nodeFileById = new Map(previousOutput.nodes.map(node => [node.id, node.source?.file]));
  for (const node of previousOutput.nodes) {
    add(node.source?.file, [...(node.analyzers || []), ...(node.primaryAnalyzer ? [node.primaryAnalyzer] : [])]);
  }
  for (const edge of previousOutput.edges) {
    const analyzerIds = graphItemAnalyzers(edge);
    add(nodeFileById.get(edge.source), analyzerIds);
    add(nodeFileById.get(edge.target), analyzerIds);
  }
  for (const endpoint of [...(previousOutput.entry_points || []), ...(previousOutput.exit_points || [])]) {
    const metadata = endpoint.metadata as Record<string, unknown> | undefined;
    const handlerFile = 'handler' in endpoint ? endpoint.handler?.file : undefined;
    const metadataFile = typeof metadata?.file === 'string' ? metadata.file : undefined;
    add(handlerFile || metadataFile || nodeFileById.get(endpoint.source_node), graphItemAnalyzers(endpoint));
  }
  return analyzerIdsByFile;
}

export function canReplaceAnalyzerContributions(
  graph: IncrementalGraph,
  analyzerIds: ReadonlySet<string>
): boolean {
  const ownedNodeIds = new Set<string>();
  for (const node of graph.nodes) {
    const analyzers = nodeAnalyzers(node);
    if (!analyzers.some(analyzer => analyzerIds.has(analyzer))) continue;
    if (analyzers.some(analyzer => !analyzerIds.has(analyzer))) return false;
    ownedNodeIds.add(node.id);
  }

  for (const item of [...graph.entryPoints, ...graph.exitPoints]) {
    const merged = mergedAnalyzers(item);
    if (merged.some(candidate => analyzerIds.has(candidate)) &&
      merged.some(candidate => !analyzerIds.has(candidate))) return false;
  }

  const attachedItems = [...graph.edges, ...graph.entryPoints, ...graph.exitPoints]
    .filter(item => 'source_node' in item
      ? ownedNodeIds.has(item.source_node)
      : ownedNodeIds.has(item.source) || ownedNodeIds.has(item.target));
  if (attachedItems.some(item => {
    const analyzers = graphItemAnalyzers(item);
    if (analyzers.length === 0) return true;
    if (analyzers.every(analyzer => analyzerIds.has(analyzer))) return false;
    const attributes = item.metadata?.attributes as Record<string, unknown> | undefined;
    return attributes?.source_analyzer !== 'orchestrator' ||
      attributes?.contribution_scope !== 'derived-rebuild';
  })) return false;

  return true;
}

export function removeAnalyzerContributions(
  graph: IncrementalGraph,
  analyzerIds: ReadonlySet<string>
): IncrementalGraph {
  const removedNodeIds = new Set(
    graph.nodes
      .filter(node => nodeAnalyzers(node).some(analyzer => analyzerIds.has(analyzer)))
      .map(node => node.id)
  );
  const belongsToSelectedAnalyzer = (item: CASEdge | CASEntryPoint | CASExitPoint): boolean => {
    const analyzer = sourceAnalyzer(item);
    return Boolean(analyzer && analyzerIds.has(analyzer));
  };

  return {
    nodes: graph.nodes.filter(node => !removedNodeIds.has(node.id)),
    edges: graph.edges.filter(edge =>
      !removedNodeIds.has(edge.source) &&
      !removedNodeIds.has(edge.target) &&
      !belongsToSelectedAnalyzer(edge)
    ),
    entryPoints: graph.entryPoints.filter(item =>
      !removedNodeIds.has(item.source_node) && !belongsToSelectedAnalyzer(item)
    ),
    exitPoints: graph.exitPoints.filter(item =>
      !removedNodeIds.has(item.source_node) && !belongsToSelectedAnalyzer(item)
    ),
  };
}

export function isRefreshableContribution(
  contribution: CASContribution,
  retainedFields: ReadonlySet<keyof CASContribution> = new Set()
): boolean {
  const allowed = new Set([
    'nodes',
    'edges',
    'entry_points',
    'exit_points',
    'analyzer_metadata',
  ]);
  return Object.entries(contribution).every(([key, value]) =>
    allowed.has(key) || retainedFields.has(key as keyof CASContribution) ||
      (key === 'provided_perspectives' && retainedFields.has('perspectives')) ||
      value === undefined || (Array.isArray(value) && value.length === 0)
  );
}

export function retainedContributionFieldsMatch(
  contribution: CASContribution,
  retained: Partial<CASContribution>,
  fields: ReadonlySet<keyof CASContribution>
): boolean {
  for (const field of fields) {
    const current = contribution[field];
    const previous = retained[field];
    if (current === undefined || previous === undefined) {
      if (current !== previous) return false;
      continue;
    }
    if (field === 'provided_perspectives') {
      const perspectiveIds = new Set((contribution.perspectives || []).map(item => item.id));
      if (!(current as string[]).every(id => perspectiveIds.has(id))) return false;
      if (!isDeepStrictEqual([...(current as string[])].sort(), [...(previous as string[])].sort())) return false;
      continue;
    }
    if (field === 'perspectives' && Array.isArray(current) && Array.isArray(previous)) {
      const currentPerspectives = current as NonNullable<CASContribution['perspectives']>;
      const previousPerspectives = previous as NonNullable<CASContribution['perspectives']>;
      const analyzerIds = new Set(currentPerspectives
        .map(item => item?.analyzer_id)
        .filter((value): value is string => typeof value === 'string'));
      if (analyzerIds.size === 0) return false;
      const priorForAnalyzers = previousPerspectives.filter(item => analyzerIds.has(item.analyzer_id));
      const previousById = new Map(priorForAnalyzers.map(item => [item.id, item]));
      if (previousById.size !== priorForAnalyzers.length || currentPerspectives.length !== priorForAnalyzers.length ||
        currentPerspectives.some(item => !isDeepStrictEqual(previousById.get(item.id), item))) return false;
      continue;
    }
    if (Array.isArray(current)) {
      if (!Array.isArray(previous) || current.length !== previous.length) return false;
      if (current.some(item => !item || typeof item !== 'object' || !('id' in item)) ||
        previous.some(item => !item || typeof item !== 'object' || !('id' in item))) {
        if (!isDeepStrictEqual(current, previous)) return false;
        continue;
      }
      const previousById = new Map<string, unknown>();
      for (const item of previous as unknown[]) {
        previousById.set(String((item as { id: unknown }).id), item);
      }
      const currentById = new Map(current.map(item => [String((item as { id: unknown }).id), item]));
      if (previousById.size !== previous.length || currentById.size !== current.length ||
        ![...previousById].every(([id, item]) => isDeepStrictEqual(currentById.get(id), item))) return false;
      continue;
    }
    if (field === 'categories' && current && typeof current === 'object') {
      if (!isDeepStrictEqual(current, previous)) return false;
      continue;
    }
    if (!isDeepStrictEqual(previous, current)) return false;
  }
  return true;
}

export function analyzerOwnershipClosure(
  graph: IncrementalGraph,
  initial: ReadonlySet<string>,
  availableAnalyzerIds?: ReadonlySet<string>
): Set<string> {
  const selected = new Set(initial);
  const isAvailable = (analyzer: string): boolean => !availableAnalyzerIds || availableAnalyzerIds.has(analyzer);
  let changed = true;
  while (changed) {
    changed = false;
    const ownedNodeIds = new Set<string>();
    for (const node of graph.nodes) {
      const analyzers = nodeAnalyzers(node);
      if (!analyzers.some(analyzer => selected.has(analyzer))) continue;
      ownedNodeIds.add(node.id);
      for (const analyzer of analyzers) {
        if (!selected.has(analyzer)) {
          selected.add(analyzer);
          changed = true;
        }
      }
    }
    for (const edge of graph.edges) {
      if (!ownedNodeIds.has(edge.source) && !ownedNodeIds.has(edge.target)) continue;
      const analyzer = sourceAnalyzer(edge);
      if (analyzer && isAvailable(analyzer) && !selected.has(analyzer)) {
        selected.add(analyzer);
        changed = true;
      }
    }
    for (const item of [...graph.entryPoints, ...graph.exitPoints]) {
      const merged = mergedAnalyzers(item);
      if (!ownedNodeIds.has(item.source_node) && !merged.some(analyzer => selected.has(analyzer))) continue;
      for (const analyzer of [sourceAnalyzer(item), ...merged]) {
        if (analyzer && isAvailable(analyzer) && !selected.has(analyzer)) {
          selected.add(analyzer);
          changed = true;
        }
      }
    }
  }
  return selected;
}

function analysisSnapshot(
  graph: IncrementalGraph,
  analyzerIds?: ReadonlySet<string>
): CASContribution {
  const includesNode = (node: CASNode): boolean =>
    !analyzerIds || nodeAnalyzers(node).some(analyzer => analyzerIds.has(analyzer));
  const includesItem = (item: CASEdge | CASEntryPoint | CASExitPoint): boolean => {
    const analyzer = sourceAnalyzer(item);
    return !analyzerIds || Boolean(analyzer && analyzerIds.has(analyzer));
  };
  const nodes = graph.nodes.filter(includesNode);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge =>
    includesItem(edge) && nodeIds.has(edge.source) && nodeIds.has(edge.target)
  );
  const entryPoints = graph.entryPoints.filter(item =>
    includesItem(item) && nodeIds.has(item.source_node)
  );
  const exitPoints = graph.exitPoints.filter(item =>
    includesItem(item) && nodeIds.has(item.source_node)
  );
  return {
    nodes,
    edges,
    entry_points: entryPoints,
    exit_points: exitPoints,
    analyzer_metadata: {
      analyzer_id: 'merged',
      analyzer_name: 'Merged Analysis',
      version: '1.0.0',
      contribution_type: 'pattern',
      nodes_contributed: nodes.length,
      edges_contributed: edges.length,
      contributed_entry_points: entryPoints.length,
      contributed_exit_points: exitPoints.length,
    },
  };
}

export async function refreshProjectScopedContributions(options: {
  projectPath: string;
  registrations: RefreshRegistration[];
  analyzerIds: ReadonlySet<string>;
  graph: IncrementalGraph;
  ownershipGraph: IncrementalGraph;
  analyzerRoot: (analyzerId: string) => string;
  analysisFilters: string[];
  scopeFilters: (registration: RefreshRegistration, analyzerRoot: string) => string[];
  retainedContribution?: Partial<CASContribution>;
  normalizeContribution: (contribution: CASContribution, analyzerRoot: string) => void;
  mergeContribution: (
    graph: IncrementalGraph,
    contribution: CASContribution,
    analyzerId: string
  ) => Promise<IncrementalGraph>;
  onFailure?: (failure: ProjectContributionRefreshFailure) => void;
}): Promise<IncrementalGraph | null> {
  const reportFailure = (failure: ProjectContributionRefreshFailure): void => {
    try {
      options.onFailure?.(failure);
    } catch {
      return;
    }
  };
  try {
    const availableAnalyzerIds = new Set(options.registrations.map(registration => registration.id));
    const analyzerIds = analyzerOwnershipClosure(options.ownershipGraph, options.analyzerIds, availableAnalyzerIds);
    const selected = options.registrations.filter(registration => analyzerIds.has(registration.id));
    if (selected.length !== analyzerIds.size) {
      reportFailure({ reason: 'registration-missing', analyzerIds: [...analyzerIds].sort() });
      return null;
    }
    if (!canReplaceAnalyzerContributions(options.ownershipGraph, analyzerIds)) {
      reportFailure({ reason: 'non-replaceable-ownership', analyzerIds: [...analyzerIds].sort() });
      return null;
    }

    let graph = removeAnalyzerContributions(options.graph, analyzerIds);
    const analyze = async (
      registration: RefreshRegistration,
      existingAnalysis: CASContribution
    ): Promise<CASContribution | null> => {
      const startedAt = Date.now();
      const analyzerRoot = options.analyzerRoot(registration.id);
      const contribution = await registration.analyzer.analyze({
        projectPath: analyzerRoot,
        analysisRootPath: options.projectPath,
        filters: [...options.analysisFilters, ...options.scopeFilters(registration, analyzerRoot)],
        existingAnalysis: [existingAnalysis],
      });
      if (process.env.KLAURO_DEBUG_INCREMENTAL_PHASES === '1') {
        process.stderr.write(`[Klauro] incremental project analyzer ${registration.id}: ${Date.now() - startedAt}ms\n`);
      }
      const retainedFields = new Set(registration.analyzer.incrementalSourceInvariantContributionFields?.() || []);
      if (!isRefreshableContribution(contribution, retainedFields)) {
        reportFailure({ reason: 'non-refreshable-contribution', analyzerId: registration.id });
        return null;
      }
      if (!retainedContributionFieldsMatch(contribution, options.retainedContribution || {}, retainedFields)) {
        reportFailure({ reason: 'retained-field-mismatch', analyzerId: registration.id });
        return null;
      }
      options.normalizeContribution(contribution, analyzerRoot);
      return contribution;
    };

    const languageAnalyzerIds = new Set(
      options.registrations
        .filter(registration => registration.type === 'language')
        .map(registration => registration.id)
    );
    for (const registration of selected.filter(candidate => candidate.type === 'language')) {
      const contribution = await analyze(registration, analysisSnapshot(graph, languageAnalyzerIds));
      if (!contribution) return null;
      graph = await options.mergeContribution(graph, contribution, registration.id);
    }

    const languageSnapshot = analysisSnapshot(graph, languageAnalyzerIds);
    const frameworkRegistrations = selected
      .filter(registration => registration.type === 'framework' || registration.type === 'library')
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const registration of frameworkRegistrations) {
      const contribution = await analyze(registration, languageSnapshot);
      if (!contribution) return null;
      graph = await options.mergeContribution(graph, contribution, registration.id);
    }

    for (const registration of selected.filter(candidate => candidate.type === 'pattern')) {
      const contribution = await analyze(registration, analysisSnapshot(graph));
      if (!contribution) return null;
      graph = await options.mergeContribution(graph, contribution, registration.id);
    }
    return graph;
  } catch (error) {
    reportFailure({ reason: 'analyzer-error', message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
