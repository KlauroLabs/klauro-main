import type { CASFlowGraph } from '../../types/cas.types';

export function emptyFlowGraph(): CASFlowGraph {
  return {
    capability_candidates: [],
    dependencies: [],
    topology: {
      root_capabilities: [],
      leaf_capabilities: [],
      critical_path: [],
      max_depth: 0,
    },
    primary_flow: {
      core_capability_id: '',
      value_chain: [],
      supporting_capabilities: [],
      infrastructure_capabilities: [],
    },
    layers: [],
    system_insights: {
      detected_patterns: [],
      primary_entry_type: 'unknown',
      data_flow_type: 'unknown',
    },
  };
}
