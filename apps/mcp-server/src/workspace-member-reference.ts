import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { reidentifyCasTree } from '../../../packages/analyzer-core/src/analyzer/core/recursive-cas';
import type { CrossCodebaseInput } from './cross-codebase-analysis';

export const WORKSPACE_MEMBER_REFERENCE_FIELDS = [
  'id', 'parent_id', 'label', 'composition_mode', 'cas_version', 'analysis_id', 'analysis_timestamp',
  'derived_fingerprint', 'ai_enrichment', 'layers_ready', 'system', 'nodes', 'edges', 'dependencies', 'children',
  'capabilities', 'entities', 'analyzer_contributions',
] as const;

export function workspaceMemberReference(repository: CrossCodebaseInput, codebaseId: string): CASOutput {
  const cas = repository.cas;
  const keep = new Set<string>(WORKSPACE_MEMBER_REFERENCE_FIELDS);
  const reference = Object.fromEntries(Object.entries(cas).filter(([field]) => keep.has(field))) as CASOutput;
  return reidentifyCasTree(reference, `workspace:${codebaseId}`, repository.name || cas.system.name);
}
