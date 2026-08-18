import type { CASContribution, CASEdge, CASNode } from '../../types/cas.types';

interface IncrementalLanguageResolutionInput {
  analyzerId: string;
  existingAnalysis?: CASContribution[];
  relativePath: string;
  nodes: CASNode[];
  edges: CASEdge[];
  relationshipTypes: ReadonlySet<string>;
}

export function buildIncrementalLanguageResolution(input: IncrementalLanguageResolutionInput): {
  nodes: CASNode[];
  relationshipEdges: CASEdge[];
} {
  const existingNodes = (input.existingAnalysis || [])
    .flatMap(contribution => contribution.nodes || [])
    .filter(node => hasAnalyzerAttribution(node, input.analyzerId));
  const replacedNodeIds = new Set(existingNodes
    .filter(node => sameSourceFile(node.source?.file, input.relativePath))
    .map(node => node.id));
  const nodes = uniqueById([
    ...existingNodes.filter(node => !replacedNodeIds.has(node.id)),
    ...input.nodes,
  ]);
  const relationshipEdges = uniqueById([
    ...(input.existingAnalysis || [])
      .flatMap(contribution => contribution.edges || [])
      .filter(edge => hasAnalyzerAttribution(edge, input.analyzerId))
      .filter(edge => !replacedNodeIds.has(edge.source) && !replacedNodeIds.has(edge.target))
      .filter(edge => input.relationshipTypes.has(edge.type)),
    ...input.edges,
  ]);
  return { nodes, relationshipEdges };
}

function hasAnalyzerAttribution(item: CASNode | CASEdge, analyzerId: string): boolean {
  const attributes = item.metadata?.attributes as Record<string, unknown> | undefined;
  if (attributes?.source_analyzer === analyzerId) return true;
  if ('primaryAnalyzer' in item && item.primaryAnalyzer === analyzerId) return true;
  return 'analyzers' in item && Boolean(item.analyzers?.includes(analyzerId));
}

function sameSourceFile(sourceFile: string | undefined, relativePath: string): boolean {
  if (!sourceFile) return false;
  return normalizeSourceFile(sourceFile) === normalizeSourceFile(relativePath);
}

function normalizeSourceFile(file: string): string {
  return file.split(String.fromCharCode(92)).join('/').replace(/^\.\//, '');
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}
