import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { AnalysisEntry } from './storage';
import type { AnalysisTrack } from './track';

export function createAnalysisIndexEntry(
  projectPath: string,
  fileName: string,
  output: CASOutput,
  track: AnalysisTrack,
  storageFormat: AnalysisEntry['storage_format'],
): AnalysisEntry {
  return {
    name: output.system.name,
    path: projectPath,
    file: fileName,
    analysis_id: output.analysis_id,
    analyzed_at: output.analysis_timestamp,
    system_type: output.system.type,
    frameworks: output.system.technologies?.frameworks?.map(framework => framework.name) || [],
    node_count: output.nodes.length,
    edge_count: output.edges.length,
    cas_version: output.cas_version,
    ...(output.layers_ready ? { layers_ready: output.layers_ready } : {}),
    storage_format: storageFormat,
    track,
    ...(output.base_commit ? { base_commit: output.base_commit } : {}),
    ...(output.branch ? { branch: output.branch } : {}),
  };
}
