import type {
  CASAnalysisFact,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASNode,
  CASRuntimeStaticLink,
  CASValidation,
} from '../../types/cas.types';

export function buildGraphValidation(
  nodes: CASNode[],
  edges: CASEdge[],
  entryPoints: CASEntryPoint[] = [],
  exitPoints: CASExitPoint[] = [],
  runtimeLinks: CASRuntimeStaticLink[] = [],
  analysisFacts: CASAnalysisFact[] = []
): CASValidation {
  const nodeIds = new Set(nodes.map(node => node.id));
  const entryPointIds = new Set(entryPoints.map(entryPoint => entryPoint.id));
  const exitPointIds = new Set(exitPoints.map(exitPoint => exitPoint.id));
  const graphEndpointIds = new Set([...nodeIds, ...entryPointIds, ...exitPointIds]);
  const warnings: Array<{ path?: string; message?: string }> = [];
  const countDuplicateIds = (items: Array<{ id: string }>, section: string): number => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.id, (counts.get(item.id) || 0) + 1);
    let duplicateIds = 0;
    for (const [id, count] of counts) {
      if (count <= 1) continue;
      duplicateIds++;
      warnings.push({ path: `${section}[${id}]`, message: `Duplicate ${section} id "${id}" appears ${count} times` });
    }
    return duplicateIds;
  };
  const duplicateIds = {
    nodes: countDuplicateIds(nodes, 'nodes'),
    edges: countDuplicateIds(edges, 'edges'),
    entry_points: countDuplicateIds(entryPoints, 'entry_points'),
    exit_points: countDuplicateIds(exitPoints, 'exit_points'),
  };
  let danglingEdges = 0;
  const connectedNodeIds = new Set<string>();
  for (const edge of edges) {
    if (!graphEndpointIds.has(edge.source)) {
      danglingEdges++;
      warnings.push({ path: `edges[${edge.id}].source`, message: `Edge source "${edge.source}" references nonexistent graph endpoint` });
    } else if (nodeIds.has(edge.source)) {
      connectedNodeIds.add(edge.source);
    }
    if (!graphEndpointIds.has(edge.target)) {
      danglingEdges++;
      warnings.push({ path: `edges[${edge.id}].target`, message: `Edge target "${edge.target}" references nonexistent graph endpoint` });
    } else if (nodeIds.has(edge.target)) {
      connectedNodeIds.add(edge.target);
    }
  }
  const nodesWithLocation = nodes.filter(node => node.source?.file && node.source?.line).length;
  const edgesWithMetadata = edges.filter(edge => edge.metadata && Object.keys(edge.metadata).length > 0).length;
  const documentedNodes = nodes.filter(node => node.documentation).length;
  const entryPointNodeIds = new Set(entryPoints.flatMap(entryPoint => [entryPoint.source_node, entryPoint.handler?.node_id].filter(Boolean) as string[]));
  const exitPointNodeIds = new Set(exitPoints.map(exitPoint => exitPoint.source_node).filter(Boolean));
  const orphanedNodes = nodes.filter(node =>
    !connectedNodeIds.has(node.id) &&
    !entryPointNodeIds.has(node.id) &&
    !exitPointNodeIds.has(node.id) &&
    node.type !== 'system'
  ).length;
  const entryPointsWithHandlers = entryPoints.filter(entryPoint => {
    const handlerNodeId = entryPoint.handler?.node_id || entryPoint.source_node;
    return Boolean(handlerNodeId && nodeIds.has(handlerNodeId));
  }).length;
  const exitPointsWithSources = exitPoints.filter(exitPoint => nodeIds.has(exitPoint.source_node)).length;
  const runtimeLinksWithInstrumentation = runtimeLinks.filter(link => link.instrumentation_points.length > 0).length;
  const factsWithEvidence = analysisFacts.filter(fact => fact.evidence.length > 0).length;
  const coverageParts = [
    nodes.length > 0 ? nodesWithLocation / nodes.length : 1,
    edges.length > 0 ? (edges.length - danglingEdges) / edges.length : 1,
    entryPoints.length > 0 ? entryPointsWithHandlers / entryPoints.length : 1,
    exitPoints.length > 0 ? exitPointsWithSources / exitPoints.length : 1,
    runtimeLinks.length > 0 ? runtimeLinksWithInstrumentation / runtimeLinks.length : 1,
    analysisFacts.length > 0 ? factsWithEvidence / analysisFacts.length : 1,
  ];
  const relationshipCoverageScore = Math.round(
    (coverageParts.reduce((sum, value) => sum + value, 0) / coverageParts.length) * 100
  );
  return {
    schema_version: '1.8.0',
    validation_warnings: warnings.length > 0 ? warnings : undefined,
    completeness: {
      nodes_with_location: nodesWithLocation,
      edges_with_metadata: edgesWithMetadata,
      documented_nodes: documentedNodes,
    },
    graph_integrity: {
      total_edges: edges.length,
      dangling_edges: danglingEdges,
      duplicate_ids: duplicateIds,
      connected_nodes: connectedNodeIds.size,
      orphaned_nodes: orphanedNodes,
      entry_points_with_handlers: entryPointsWithHandlers,
      exit_points_with_sources: exitPointsWithSources,
      runtime_links_with_instrumentation: runtimeLinksWithInstrumentation,
      facts_with_evidence: factsWithEvidence,
      relationship_coverage_score: relationshipCoverageScore,
    },
  };
}
