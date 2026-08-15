import type { CASEdge } from '../../types/cas.types';
import { replaceArrayContents } from './bulk-array-ops';

function sourceAnalyzer(edge: CASEdge): string | undefined {
  const direct = (edge as unknown as { source_analyzer?: unknown }).source_analyzer;
  if (typeof direct === 'string') return direct;
  const metadata = edge.metadata as Record<string, unknown> | undefined;
  if (typeof metadata?.source_analyzer === 'string') return metadata.source_analyzer;
  const attributes = metadata?.attributes as Record<string, unknown> | undefined;
  return typeof attributes?.source_analyzer === 'string' ? attributes.source_analyzer : undefined;
}

function richness(edge: CASEdge): number {
  const metadata = edge.metadata as Record<string, unknown> | undefined;
  const attributes = metadata?.attributes as Record<string, unknown> | undefined;
  return (sourceAnalyzer(edge) ? 1000 : 0) +
    (edge.perspectives?.length || 0) * 100 +
    Object.keys(metadata || {}).length * 10 +
    Object.keys(attributes || {}).length;
}

export function dedupeCanonicalEdges(edges: CASEdge[]): void {
  const groups = new Map<string, CASEdge[]>();
  for (const edge of edges) {
    const metadata = edge.metadata as Record<string, unknown> | undefined;
    const attributes = metadata?.attributes as Record<string, unknown> | undefined;
    const relationship = metadata?.field ?? metadata?.via ?? metadata?.relation ?? metadata?.relationType ?? metadata?.relation_type
      ?? attributes?.relationType ?? attributes?.relation ?? attributes?.property ?? attributes?.kind ?? '';
    const key = `${edge.source}::${edge.target}::${edge.type}::${String(relationship)}`;
    const group = groups.get(key) || [];
    group.push(edge);
    groups.set(key, group);
  }
  const canonical = [...groups.values()].map(group => {
    return [...group].sort((left, right) => richness(right) - richness(left) || left.id.localeCompare(right.id))[0];
  });
  replaceArrayContents(edges, canonical);
}
