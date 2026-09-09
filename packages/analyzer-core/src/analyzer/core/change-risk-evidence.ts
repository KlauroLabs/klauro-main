import type { CASNode } from '../../types/cas.types';

export const RISKABLE_NODE_TYPES: readonly string[] = [
  'function', 'method', 'service', 'controller', 'serializer',
  'entity', 'model', 'route', 'handler', 'resolver', 'mutation', 'repository'
];
export function hasStructuralSecurityEvidence(node: Pick<CASNode, 'security'>): boolean {
  return !!(node.security?.authentication_required || node.security?.authorization_roles);
}
