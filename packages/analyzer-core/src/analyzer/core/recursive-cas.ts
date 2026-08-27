import type { CASOutput } from '../../types/cas.types';
import { assertValidCasTree, hasCasChildren, walkCasTree } from '../../types/cas-tree-validation';
export { assertValidCasTree, hasCasChildren, validateCasTree, walkCasTree } from '../../types/cas-tree-validation';
export type { CASTreeValidationIssue, CASTreeValidationResult } from '../../types/cas-tree-validation';

function cloneCasTreeWithIds(
  root: CASOutput,
  idFor: (cas: CASOutput, depth: number) => string,
  label?: string,
): CASOutput {
  const idMap = new Map<string, string>();
  for (const { cas, depth } of walkCasTree(root)) idMap.set(cas.id!, idFor(cas, depth));

  const clone = (cas: CASOutput, parentId: string | null): CASOutput => {
    const id = idMap.get(cas.id!)!;
    const children = (cas.children || []).map(child => clone(child, id));
    const namespaced: CASOutput = {
      ...cas,
      id,
      parent_id: parentId,
      ...(parentId === null && label ? { label } : {}),
      nodes: (cas.nodes || []).map(node => {
        const namespacedNodeId = node.type === 'cas' ? idMap.get(node.id) : undefined;
        if (!namespacedNodeId) return node;
        return {
          ...node,
          id: namespacedNodeId,
          metadata: {
            ...(node.metadata || {}),
            attributes: {
              ...(node.metadata?.attributes || {}),
              cas_id: namespacedNodeId,
            },
          },
        };
      }),
      edges: (cas.edges || []).map(edge => ({
        ...edge,
        source: idMap.get(edge.source) || edge.source,
        target: idMap.get(edge.target) || edge.target,
      })),
      terminality: cas.terminality ? {
        ...cas.terminality,
        nodes: cas.terminality.nodes.map(member => ({
          ...member,
          id: idMap.get(member.id) || member.id,
        })),
      } : undefined,
      ...(children.length > 0 ? { children } : { children: undefined, composition_mode: undefined }),
    };
    return namespaced;
  };

  const namespaced = clone(root, null);
  assertValidCasTree(namespaced);
  return namespaced;
}

export function namespaceCasTree(root: CASOutput, namespace: string): CASOutput {
  assertValidCasTree(root);
  const normalizedNamespace = namespace.trim();
  if (!normalizedNamespace) throw new Error('CAS namespace cannot be empty.');
  return cloneCasTreeWithIds(root, cas => `${normalizedNamespace}:${cas.id}`);
}

export function reidentifyCasTree(root: CASOutput, rootId: string, label?: string): CASOutput {
  const normalizedRootId = rootId.trim();
  if (!normalizedRootId) throw new Error('CAS root id cannot be empty.');
  const rootHasChildren = hasCasChildren(root);
  const normalizedRoot: CASOutput = {
    ...root,
    id: root.id || `cas:${root.analysis_id}`,
    parent_id: null,
    ...(!rootHasChildren ? { children: undefined, composition_mode: undefined } : {}),
  };
  assertValidCasTree(normalizedRoot);
  return cloneCasTreeWithIds(
    normalizedRoot,
    (cas, depth) => depth === 0 ? normalizedRootId : `${normalizedRootId}:${cas.id}`,
    label,
  );
}
