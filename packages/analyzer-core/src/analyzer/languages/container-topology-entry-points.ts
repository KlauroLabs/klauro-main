import type { CASEntryPoint } from '../../types/cas.types';

export function dockerfileStartupEntryPoint(
  nodeId: string,
  relativeFile: string,
  command: string,
  workdir?: string,
): CASEntryPoint {
  return {
    id: `entry_${nodeId}_startup`,
    source_node: nodeId,
    source_analyzer: 'dockerfile',
    type: 'lifecycle',
    name: `Start container from ${relativeFile}`,
    description: `The container starts with ${command}.`,
    trigger: { event: 'container-start' },
    metadata: { topology_surface: 'dockerfile', command, workdir },
    handler: { node_id: nodeId, method_name: command, file: relativeFile },
  };
}
