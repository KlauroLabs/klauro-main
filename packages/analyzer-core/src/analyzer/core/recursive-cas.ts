import type { CASOutput, CASTerminalityRelationEvidence } from '../../types/cas.types';
import { assertValidCasTree, hasCasChildren, walkCasTree } from '../../types/cas-tree-validation';
export { assertValidCasTree, hasCasChildren, validateCasTree, walkCasTree } from '../../types/cas-tree-validation';
export type { CASTreeValidationIssue, CASTreeValidationResult } from '../../types/cas-tree-validation';

export function remapCasIdentities<T extends Partial<CASOutput>>(cas: T, idMap: ReadonlyMap<string, string>): T {
  const remap = (id: string): string => idMap.get(id) || id;
  const remapRelations = (relations: CASTerminalityRelationEvidence[]): CASTerminalityRelationEvidence[] =>
    relations.map(relation => ({ ...relation, source_id: remap(relation.source_id), target_id: remap(relation.target_id) }));
  return {
    ...cas,
    ...(cas.id !== undefined ? { id: remap(cas.id) } : {}),
    ...(cas.parent_id ? { parent_id: remap(cas.parent_id) } : {}),
    ...(cas.member_reference ? { member_reference: { ...cas.member_reference, composed_id: remap(cas.member_reference.composed_id) } } : {}),
    ...(cas.nodes ? { nodes: cas.nodes.map(node => {
      const id = node.type === 'cas' ? idMap.get(node.id) : undefined;
      return id ? { ...node, id, metadata: { ...node.metadata, attributes: { ...node.metadata?.attributes, cas_id: id } } } : node;
    }) } : {}),
    ...(cas.edges ? { edges: cas.edges.map(edge => ({ ...edge, source: remap(edge.source), target: remap(edge.target) })) } : {}),
    ...(cas.capabilities ? { capabilities: cas.capabilities.map(capability => ({
      ...capability,
      composition_provenance: capability.composition_provenance?.map(claim => ({
        ...claim, source_child_id: remap(claim.source_child_id), relation_path: remapRelations(claim.relation_path),
      })),
    })) } : {}),
    ...(cas.terminality ? { terminality: {
      ...cas.terminality,
      nodes: cas.terminality.nodes.map(member => ({
        ...member,
        id: remap(member.id),
        composition_provenance: member.composition_provenance ? {
          ...member.composition_provenance,
          source_child_id: remap(member.composition_provenance.source_child_id),
          supporting_source_ids: member.composition_provenance.supporting_source_ids.map(remap),
          relation_path: remapRelations(member.composition_provenance.relation_path),
        } : undefined,
      })),
    } } : {}),
    ...(cas.children ? { children: cas.children.map(child => remapCasIdentities(child, idMap)) } : {}),
  };
}

function cloneCasTreeWithIds(
  root: CASOutput,
  idFor: (cas: CASOutput, depth: number) => string,
  label?: string,
): CASOutput {
  const idMap = new Map<string, string>();
  for (const { cas, depth } of walkCasTree(root)) idMap.set(cas.id!, idFor(cas, depth));
  const clone = (cas: CASOutput, parentId: string | null): CASOutput => {
    const id = idMap.get(cas.id!)!;
    const { children: originalChildren, ...fields } = cas;
    const children = (originalChildren || []).map(child => clone(child, id));
    const mapped = remapCasIdentities(fields, idMap);
    return {
      ...mapped,
      id,
      parent_id: parentId,
      ...(parentId === null && label ? { label } : {}),
      nodes: mapped.nodes || [],
      edges: mapped.edges || [],
      ...(children.length > 0 ? { children } : { children: undefined, composition_mode: undefined }),
    };
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
