import * as crypto from 'crypto';
import type { CASEdge, CASNode } from '../../types/cas.types';

export function linkStructuralOwnership(nodes: CASNode[], edges: CASEdge[]): void {
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    if (isStructuralOwnershipEdge(edges[index])) edges.splice(index, 1);
  }
  const nodeById = new Map(nodes.map(node => [node.id, node] as const));
  const incidentNodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    incidentNodeIds.add(edge.source);
    incidentNodeIds.add(edge.target);
    edgeKeys.add(`${edge.source}\0${edge.target}\0${edge.type}`);
  }
  const fileNodeByPath = new Map<string, CASNode>();
  for (const node of nodes) {
    if (node.type !== 'file' || !node.source?.file) continue;
    const normalized = normalizeOwnershipPath(node.source.file);
    const existing = fileNodeByPath.get(normalized);
    if (!existing || compareFileOwners(node, existing) < 0) fileNodeByPath.set(normalized, node);
  }
  const addOwnershipEdge = (owner: CASNode, node: CASNode, resolution: string): void => {
    const key = `${owner.id}\0${node.id}\0contains`;
    if (edgeKeys.has(key)) return;
    edges.push({
      id: `structural_ownership_${crypto.createHash('sha256').update(owner.id).update('\0').update(node.id).digest('hex').slice(0, 20)}`,
      source: owner.id,
      target: node.id,
      type: 'contains',
      metadata: {
        attributes: {
          source_analyzer: 'orchestrator',
          contribution_scope: 'derived-rebuild',
          relationship: 'structural_ownership',
          resolution,
        },
      },
    });
    edgeKeys.add(key);
    incidentNodeIds.add(owner.id);
    incidentNodeIds.add(node.id);
  };
  for (const node of nodes) {
    if (node.type === 'system' || incidentNodeIds.has(node.id)) continue;
    const parent = node.parent ? nodeById.get(node.parent) : undefined;
    const fileOwner = node.source?.file
      ? fileNodeByPath.get(normalizeOwnershipPath(node.source.file))
      : undefined;
    const owner = parent || (fileOwner?.id !== node.id ? fileOwner : undefined);
    if (!owner) continue;
    const resolution = parent && parent.id !== fileOwner?.id ? 'declared-parent' : 'same-source-file';
    addOwnershipEdge(owner, node, resolution);
  }
  for (const [normalizedPath, fileNode] of fileNodeByPath) {
    if (incidentNodeIds.has(fileNode.id)) continue;
    const candidates = nodes.filter(node =>
      node.id !== fileNode.id &&
      node.source?.file &&
      normalizeOwnershipPath(node.source.file) === normalizedPath
    );
    const root = candidates.find(node => !node.parent || !nodeById.has(node.parent)) || candidates[0];
    if (root) addOwnershipEdge(fileNode, root, 'file-root');
  }
}

function compareFileOwners(left: CASNode, right: CASNode): number {
  const lengthDifference = left.id.length - right.id.length;
  return lengthDifference || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function isStructuralOwnershipEdge(edge: CASEdge): boolean {
  return edge.id.startsWith('structural_ownership_') || edge.metadata?.attributes?.relationship === 'structural_ownership';
}

function normalizeOwnershipPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}
