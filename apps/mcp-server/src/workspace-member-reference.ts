import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CrossCodebaseInput } from './cross-codebase-analysis';

export function workspaceMemberReference(repository: CrossCodebaseInput, codebaseId: string): CASOutput {
  const cas = repository.cas;
  return {
    id: `workspace:${codebaseId}`,
    parent_id: null,
    label: repository.name || cas.system.name,
    cas_version: cas.cas_version,
    analysis_id: cas.analysis_id,
    analysis_timestamp: cas.analysis_timestamp,
    system: cas.system,
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 0 },
    ...(cas.layers_ready ? { layers_ready: cas.layers_ready } : {}),
  } as CASOutput;
}
