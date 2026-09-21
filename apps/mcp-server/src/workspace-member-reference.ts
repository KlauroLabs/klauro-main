import type { CASLayerStatus, CASMemberReference, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { reidentifyCasTree } from '../../../packages/analyzer-core/src/analyzer/core/recursive-cas';
import type { CrossCodebaseInput } from './cross-codebase-analysis';
import { casSectionForField } from './cas-sections';

export const WORKSPACE_MEMBER_REFERENCE_FIELDS = [
  'id', 'parent_id', 'label', 'composition_mode', 'cas_version', 'analysis_id', 'analysis_timestamp',
  'derived_fingerprint', 'layers_ready', 'member_reference', 'system', 'nodes', 'edges', 'dependencies',
  'children', 'capabilities', 'entities', 'analyzer_contributions',
] as const;

export function workspaceMemberReference(repository: CrossCodebaseInput, codebaseId: string): CASOutput {
  const cas = repository.cas;
  const keep = new Set<string>(WORKSPACE_MEMBER_REFERENCE_FIELDS);
  const reference = Object.fromEntries(Object.entries(cas).filter(([field]) => keep.has(field))) as CASOutput;
  const composedId = `workspace:${codebaseId}`;
  const memberReference = cas.member_reference
    ? { ...cas.member_reference, composed_id: composedId, loaded_fields: WORKSPACE_MEMBER_REFERENCE_FIELDS.filter(field => field in reference && field !== 'member_reference'), omitted_fields: [...new Set([...cas.member_reference.omitted_fields, ...Object.keys(cas).filter(field => !keep.has(field))])].sort() }
    : undefined;
  if (memberReference) {
    reference.member_reference = memberReference;
    reference.layers_ready = projectLayersReady(cas, memberReference);
  }
  return reidentifyCasTree(reference, composedId, repository.name || cas.system.name);
}

export function projectLayersReady(cas: Partial<CASOutput>, reference: CASMemberReference): CASOutput['layers_ready'] | undefined {
  const layers = cas.layers_ready;
  if (!layers) return undefined;
  const omittedFields = new Set(reference.omitted_fields);
  const omittedSections = new Set(reference.omitted_sections);
  const projected = layers.layers.map((layer): CASLayerStatus => {
    const fields = Array.isArray(layer.fields) ? layer.fields : [];
    const missing = fields.filter(field => omittedFields.has(field) || (!(field in cas) && omittedSections.has(casSectionForField(field))));
    if (layer.status !== 'ready' || missing.length === 0) return layer;
    return { ...layer, status: 'not_loaded', not_loaded_fields: missing };
  });
  return { ...layers, layers: projected, complete: false };
}
