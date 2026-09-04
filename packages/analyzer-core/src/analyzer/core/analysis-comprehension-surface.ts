import type { CASNode, CASEdge } from './base-analyzer';
import type {
  CASDataEntity,
  CASEntryPoint,
  CASExitPoint,
  CASOutput,
  EnhancedSystemPurpose,
} from '../../types/cas.types';
import { isScaffoldOrTestPath } from './scaffold-paths';

export function removeTestEntryPoints(
  nodes: CASNode[],
  edges: CASEdge[],
  entryPoints: CASEntryPoint[],
  isTestFileNode: (node: CASNode) => boolean,
): void {
  const nodesById = new Map(nodes.map(node => [node.id, node] as const));
  const removedEntryPointIds = new Set<string>();
  let writeIndex = 0;

  for (const entryPoint of entryPoints) {
    const sourceNode = nodesById.get(entryPoint.source_node);
    const handlerNode = entryPoint.handler?.node_id ? nodesById.get(entryPoint.handler.node_id) : undefined;
    const sourceFile = sourceNode?.source?.file || entryPoint.handler?.file || '';
    const handlerFile = handlerNode?.source?.file || entryPoint.handler?.file || '';
    const metadata = entryPoint.metadata as Record<string, any> | undefined;
    const isTestEntryPoint = entryPoint.type === 'test' ||
      Boolean(metadata?.test_framework || metadata?.attributes?.test_framework) ||
      [sourceNode, handlerNode].some(node => Boolean(node && (
        isTestFileNode(node) ||
        /(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(node.source?.file || '') ||
        node.type === 'test' ||
        node.type === 'test-suite' ||
        node.type.startsWith('test_') ||
        node.type.startsWith('cypress_') ||
        node.category === 'test' ||
        node.subcategories?.some(category => /^(test|testing|test-suite|e2e)$/i.test(category))
      ))) ||
      Boolean((sourceFile && isScaffoldOrTestPath(sourceFile)) || (handlerFile && isScaffoldOrTestPath(handlerFile)));

    if (isTestEntryPoint) {
      removedEntryPointIds.add(entryPoint.id);
      continue;
    }
    entryPoints[writeIndex++] = entryPoint;
  }
  entryPoints.length = writeIndex;

  if (removedEntryPointIds.size === 0) return;
  writeIndex = 0;
  for (const edge of edges) {
    if (removedEntryPointIds.has(edge.source) || removedEntryPointIds.has(edge.target)) continue;
    edges[writeIndex++] = edge;
  }
  edges.length = writeIndex;
}

export function isComprehensionInertPrivateAddition(
  previousOutput: Pick<CASOutput, 'nodes' | 'edges' | 'entry_points' | 'exit_points' | 'entities'>,
  nodes: CASNode[],
  edges: CASEdge[],
  entryPoints: CASEntryPoint[],
  exitPoints: CASExitPoint[],
  dataEntities: CASDataEntity[],
): boolean {
  const previousNodeById = new Map(previousOutput.nodes.map(node => [node.id, node] as const));
  const nextNodeById = new Map(nodes.map(node => [node.id, node] as const));
  const addedNodes = nodes.filter(node => !previousNodeById.has(node.id));
  if (addedNodes.length === 0 || previousOutput.nodes.some(node => !nextNodeById.has(node.id))) return false;

  const addedNodeIds = new Set(addedNodes.map(node => node.id));
  const capabilityBearingNodeTypes = /^(controller|route|endpoint|page|screen|command|entity|model|schema|message|event|job|consumer|producer)$/;
  if (addedNodes.some(node => {
    const visibility = (node.metadata as any)?.visibility || node.metadata?.access_modifier || node.metadata?.attributes?.visibility;
    const languagePrivate = node.name.startsWith('_') && /\.dart$/i.test(node.source?.file || '');
    return (visibility !== 'private' && !languagePrivate) || node.metadata?.is_exported === true || capabilityBearingNodeTypes.test(node.type);
  })) return false;

  const previousEdgeIds = new Set(previousOutput.edges.map(edge => edge.id));
  const structuralEdgeTypes = new Set(['contains', 'contained_by', 'has_member', 'member_of', 'defined_in']);
  if (edges.some(edge => !previousEdgeIds.has(edge.id) && (
    !structuralEdgeTypes.has(edge.type) ||
    (!addedNodeIds.has(edge.source) && !addedNodeIds.has(edge.target))
  ))) return false;

  const sameIds = (before: { id: string }[], after: { id: string }[]): boolean =>
    before.length === after.length && before.map(item => item.id).sort().join('\n') === after.map(item => item.id).sort().join('\n');
  if (!sameIds(previousOutput.entry_points || [], entryPoints) || !sameIds(previousOutput.exit_points || [], exitPoints)) return false;

  const entityIdentity = (entity: CASDataEntity): string => JSON.stringify({ id: entity.id, name: entity.name, kind: entity.kind || null });
  const previousEntities = previousOutput.entities || [];
  return previousEntities.length === dataEntities.length &&
    previousEntities.map(entityIdentity).sort().join('\n') === dataEntities.map(entityIdentity).sort().join('\n');
}

export function shouldReuseComprehensionForInertPrivateAddition(
  comprehensionInertAddition: boolean,
  refreshReason: string,
): boolean {
  return comprehensionInertAddition && (
    refreshReason === 'missing-previous-description' ||
    refreshReason === 'legacy-semantic-facts-changed' ||
    refreshReason.startsWith('semantic-fingerprint-changed:') ||
    refreshReason.startsWith('degraded-semantic-fingerprint-changed:')
  );
}

export function degradedComprehensionRefreshDecision(
  purpose: EnhancedSystemPurpose | undefined,
  nextFingerprint: string,
): { refresh: boolean; reason: string } | undefined {
  const generation = purpose?.description_generation;
  const settledDegradation = generation?.attempted === true &&
    (generation.status === 'ai_rejected' || generation.status === 'ai_failed');
  if (!settledDegradation || !purpose?.ai_input_fingerprint) return undefined;
  return purpose.ai_input_fingerprint === nextFingerprint
    ? { refresh: false, reason: 'degraded-semantic-fingerprint-unchanged' }
    : { refresh: true, reason: `degraded-semantic-fingerprint-changed:${purpose.ai_input_fingerprint}->${nextFingerprint}` };
}
