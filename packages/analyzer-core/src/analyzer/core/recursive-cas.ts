import type { CASOutput, CASTerminalityRelationEvidence } from '../../types/cas.types';
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
  const remapRelationPath = (relations: CASTerminalityRelationEvidence[]): CASTerminalityRelationEvidence[] =>
    relations.map(relation => ({
      ...relation,
      source_id: idMap.get(relation.source_id) || relation.source_id,
      target_id: idMap.get(relation.target_id) || relation.target_id,
    }));
  const remapClaimProvenance = (claims: NonNullable<CASOutput['capabilities']>[number]['composition_provenance']) =>
    claims?.map(claim => ({
      ...claim,
      source_child_id: idMap.get(claim.source_child_id) || claim.source_child_id,
      relation_path: remapRelationPath(claim.relation_path),
    }));

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
      capabilities: cas.capabilities?.map(capability => ({
        ...capability,
        composition_provenance: remapClaimProvenance(capability.composition_provenance),
      })),
      terminality: cas.terminality ? {
        ...cas.terminality,
        nodes: cas.terminality.nodes.map(member => ({
          ...member,
          id: idMap.get(member.id) || member.id,
          composition_provenance: member.composition_provenance ? {
            ...member.composition_provenance,
            source_child_id: idMap.get(member.composition_provenance.source_child_id)
              || member.composition_provenance.source_child_id,
            supporting_source_ids: member.composition_provenance.supporting_source_ids
              .map(sourceId => idMap.get(sourceId) || sourceId),
            relation_path: remapRelationPath(member.composition_provenance.relation_path),
          } : undefined,
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
