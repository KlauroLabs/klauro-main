import type { CASEdge, CASNode, CASOutput, ChangeExecutionLocality, ChangeReport, ImpactAnalysis } from '../../../packages/analyzer-core/src/types/cas.types';

type Placed = { id: string; name: string; type: string; file: string };

function edgeKey(edge: CASEdge): string {
  return [edge.source, edge.target, edge.type].join('\u0000');
}

function placed(node: CASNode): Placed {
  return { id: node.id, name: node.name, type: node.type, file: node.source?.file ?? '' };
}

function filesOf(cas: CASOutput): Set<string> {
  return new Set(cas.nodes.map(node => node.source?.file).filter((file): file is string => Boolean(file)));
}

function missing<T>(from: Map<string, T>, present: Map<string, unknown>): T[] {
  return [...from].filter(([key]) => !present.has(key)).map(([, value]) => value);
}

function reach(added: number, deleted: number): ImpactAnalysis['riskLevel'] {
  if (deleted > 0) return 'high';
  return added > 0 ? 'medium' : 'low';
}

function impact(cas: CASOutput, added: number, deleted: number): ImpactAnalysis {
  return {
    riskLevel: reach(added, deleted),
    confidence: 1,
    affectedEntryPoints: [],
    affectedCallChains: [],
    affectedConsumers: [],
    criticalPathsAffected: false,
    securitySensitive: false,
    dataFlowAffected: (cas.exit_points?.length ?? 0) > 0,
    testCoverage: { directTests: [], integrationTests: [], uncoveredChanges: [], suggestedTests: [] },
    documentation: { affectedDocs: [], outdatedComments: [] },
  };
}

function localityOf(current: CASOutput): ChangeExecutionLocality | undefined {
  const extraction = current.extraction;
  if (!extraction) return undefined;
  const reused = extraction.files - extraction.read_afresh;
  const strategy = reused <= 0 ? 'full-rebuild' : extraction.read_afresh === 0 ? 'no-change' : 'derived-layer-rebuild';
  return {
    strategy,
    directChangedFiles: extraction.changed.length,
    graphAffectedFiles: 0,
    analyzedFiles: extraction.read_afresh,
    trackedFiles: extraction.files,
    reusedFiles: Math.max(reused, 0),
    reuseRatio: extraction.files > 0 ? Math.max(reused, 0) / extraction.files : 0,
  };
}

export function changesBetween(previous: CASOutput | null, current: CASOutput): ChangeReport {
  const before = new Map((previous?.nodes ?? []).map(node => [node.id, placed(node)]));
  const after = new Map(current.nodes.map(node => [node.id, placed(node)]));
  const beforeEdges = new Map((previous?.edges ?? []).map(edge => [edgeKey(edge), edge]));
  const afterEdges = new Map(current.edges.map(edge => [edgeKey(edge), edge]));
  const beforeFiles = previous ? filesOf(previous) : new Set<string>();
  const afterFiles = filesOf(current);

  const addedNodes = missing(after, before);
  const deletedNodes = missing(before, after);
  const addedEdges = missing(afterEdges, beforeEdges);
  const deletedEdges = missing(beforeEdges, afterEdges);
  const addedFiles = [...afterFiles].filter(file => !beforeFiles.has(file));
  const deletedFiles = [...beforeFiles].filter(file => !afterFiles.has(file));
  const modifiedFiles = (current.extraction?.changed ?? []).filter(file => beforeFiles.has(file) && afterFiles.has(file));

  return {
    timestamp: current.analysis_timestamp,
    previousAnalysis: previous?.analysis_id ?? '',
    currentAnalysis: current.analysis_id,
    summary: {
      filesAdded: addedFiles.length,
      filesModified: modifiedFiles.length,
      filesDeleted: deletedFiles.length,
      nodesAdded: addedNodes.length,
      nodesModified: 0,
      nodesDeleted: deletedNodes.length,
      edgesAdded: addedEdges.length,
      edgesModified: 0,
      edgesDeleted: deletedEdges.length,
    },
    impact: impact(current, addedNodes.length, deletedNodes.length),
    locality: localityOf(current),
    details: {
      addedNodes,
      modifiedNodes: [],
      deletedNodes,
      addedEdges: addedEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type })),
      deletedEdges: deletedEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type })),
    },
  };
}
