import {
  isGuardEnforcementEdge,
  resolveGuardEnforcementRelationship,
} from '../../analyzer/core/guard-relationships';
import type { CASEdge, CASNode } from '../../types/cas.types';

describe('guard relationships', () => {
  const node = (id: string, type: string, subcategories?: string[]): CASNode => ({
    id,
    name: id,
    type,
    subcategories,
  });

  const edge = (type: string, source: string, target: string): CASEdge => ({
    id: `${source}-${type}-${target}`,
    type,
    source,
    target,
  });

  it('orients protected-by edges from protected nodes to mechanisms', () => {
    const relationship = resolveGuardEnforcementRelationship(
      edge('protected_by', 'operation', 'policy'),
      new Map([
        ['operation', node('operation', 'method')],
        ['policy', node('policy', 'guard')],
      ]),
    );
    expect(relationship).toEqual({ guard_node_id: 'policy', protected_node_id: 'operation' });
  });

  it('orients guards edges from mechanisms to protected nodes', () => {
    const relationship = resolveGuardEnforcementRelationship(
      edge('guards', 'policy', 'operation'),
      new Map([
        ['policy', node('policy', 'middleware')],
        ['operation', node('operation', 'handler')],
      ]),
    );
    expect(relationship).toEqual({ guard_node_id: 'policy', protected_node_id: 'operation' });
  });

  it('uses structural node evidence when edge direction conventions disagree', () => {
    const relationship = resolveGuardEnforcementRelationship(
      edge('guards', 'operation', 'policy'),
      new Map([
        ['operation', node('operation', 'method')],
        ['policy', node('policy', 'function', ['before_action'])],
      ]),
    );
    expect(relationship).toEqual({ guard_node_id: 'policy', protected_node_id: 'operation' });
  });

  it('rejects unrelated edges', () => {
    const candidate = edge('calls', 'caller', 'callee');
    expect(isGuardEnforcementEdge(candidate)).toBe(false);
    expect(resolveGuardEnforcementRelationship(candidate, new Map())).toBeUndefined();
  });
});
