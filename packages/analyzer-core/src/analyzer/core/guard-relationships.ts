import type { CASEdge, CASNode } from '../../types/cas.types';

const GUARD_ENFORCEMENT_EDGE_TYPES = new Set([
  'guarded_by',
  'protected_by',
  'guards',
  'authorizes',
  'middleware',
  'intercepts',
  'before_action',
]);

const GUARD_NODE_TYPES = new Set([
  'guard',
  'angular_guard',
  'auth_strategy',
  'auth_policy',
  'middleware',
  'interceptor',
]);

const GUARD_NODE_CATEGORIES = new Set([
  'guard',
  'middleware',
  'interceptor',
  'auth_strategy',
  'auth_policy',
  'before_action',
  'before_filter',
]);

export interface GuardEnforcementRelationship {
  guard_node_id: string;
  protected_node_id: string;
}

export function isGuardEnforcementEdge(edge: Pick<CASEdge, 'type'>): boolean {
  return GUARD_ENFORCEMENT_EDGE_TYPES.has(edge.type);
}

function isGuardMechanismNode(node: CASNode | undefined): boolean {
  if (!node) return false;
  if (GUARD_NODE_TYPES.has(node.type)) return true;
  return (node.subcategories || []).some(category => GUARD_NODE_CATEGORIES.has(category));
}

export function resolveGuardEnforcementRelationship(
  edge: CASEdge,
  nodesById: ReadonlyMap<string, CASNode>,
): GuardEnforcementRelationship | undefined {
  if (!isGuardEnforcementEdge(edge)) return undefined;
  const sourceIsGuard = isGuardMechanismNode(nodesById.get(edge.source));
  const targetIsGuard = isGuardMechanismNode(nodesById.get(edge.target));
  if (sourceIsGuard !== targetIsGuard) {
    return sourceIsGuard
      ? { guard_node_id: edge.source, protected_node_id: edge.target }
      : { guard_node_id: edge.target, protected_node_id: edge.source };
  }
  return edge.type === 'guards' || edge.type === 'authorizes'
    ? { guard_node_id: edge.source, protected_node_id: edge.target }
    : { guard_node_id: edge.target, protected_node_id: edge.source };
}
