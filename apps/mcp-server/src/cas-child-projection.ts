import type { CASOutput, CASSystem } from '../../../packages/analyzer-core/src/types/cas.types';

type CASChildFieldPolicy =
  | { mode: 'identity' }
  | { mode: 'inherit' }
  | { mode: 'scope' }
  | { mode: 'recompute' };

export const CAS_CHILD_FIELD_POLICY = {
  id: { mode: 'identity' },
  parent_id: { mode: 'identity' },
  label: { mode: 'identity' },
  children: { mode: 'identity' },
  composition_mode: { mode: 'identity' },
  member_reference: { mode: 'identity' },
  cas_version: { mode: 'inherit' },
  analyzer_build: { mode: 'inherit' },
  parser_fingerprint: { mode: 'inherit' },
  derived_fingerprint: { mode: 'inherit' },
  analysis_timestamp: { mode: 'inherit' },
  analysis_id: { mode: 'identity' },
  system: { mode: 'identity' },
  analysis_phases: { mode: 'inherit' },
  timings: { mode: 'inherit' },
  architecture_summary: { mode: 'inherit' },
  route_table: { mode: 'inherit' },
  database_schema: { mode: 'inherit' },
  perspectives: { mode: 'inherit' },
  nodes: { mode: 'scope' },
  edges: { mode: 'scope' },
  entry_points: { mode: 'scope' },
  exit_points: { mode: 'scope' },
  external_services: { mode: 'inherit' },
  repository_links: { mode: 'inherit' },
  dependencies: { mode: 'inherit' },
  disclosure: { mode: 'inherit' },
  analyzer_contributions: { mode: 'inherit' },
  source_input_identities: { mode: 'inherit' },
  source_input_root: { mode: 'inherit' },
  source_input_catalog: { mode: 'inherit' },
  method_calls: { mode: 'scope' },
  call_chains: { mode: 'scope' },
  decorators: { mode: 'inherit' },
  documentation_summary: { mode: 'inherit' },
  todos_summary: { mode: 'inherit' },
  implementation_health: { mode: 'inherit' },
  system_health: { mode: 'inherit' },
  behaviors: { mode: 'inherit' },
  patterns: { mode: 'inherit' },
  communities: { mode: 'inherit' },
  reachability_index: { mode: 'inherit' },
  structural_importance_meta: { mode: 'inherit' },
  categories: { mode: 'inherit' },
  tags: { mode: 'inherit' },
  index: { mode: 'inherit' },
  cross_repository_links: { mode: 'inherit' },
  security_contexts: { mode: 'scope' },
  test_coverage: { mode: 'inherit' },
  test_suites: { mode: 'scope' },
  mocks: { mode: 'inherit' },
  fixtures: { mode: 'inherit' },
  test_summary: { mode: 'inherit' },
  intents: { mode: 'scope' },
  flow_summary: { mode: 'inherit' },
  change_risks: { mode: 'scope' },
  change_risk_summary: { mode: 'scope' },
  entities: { mode: 'scope' },
  data_summary: { mode: 'inherit' },
  behavioral_invariants: { mode: 'scope' },
  behavioral_invariant_summary: { mode: 'scope' },
  security_boundaries: { mode: 'scope' },
  security_summary: { mode: 'scope' },
  flow_coverage: { mode: 'scope' },
  test_gaps: { mode: 'scope' },
  temporal_stability: { mode: 'scope' },
  stability_summary: { mode: 'scope' },
  capabilities: { mode: 'scope' },
  flows: { mode: 'scope' },
  steps: { mode: 'scope' },
  terminality: { mode: 'recompute' },
  behavior_surfaces: { mode: 'scope' },
  system_purpose: { mode: 'inherit' },
  data_lineage: { mode: 'scope' },
  entry_point_flows: { mode: 'scope' },
  entry_point_flow_summary: { mode: 'inherit' },
  domain_concepts: { mode: 'inherit' },
  enhanced_system_purpose: { mode: 'inherit' },
  flow_graph: { mode: 'scope' },
  runtime_static_links: { mode: 'scope' },
  analysis_facts: { mode: 'scope' },
  distribution_units: { mode: 'inherit' },
  deployable_evidence: { mode: 'scope' },
  units: { mode: 'scope' },
  codebase_idioms: { mode: 'inherit' },
  idiom_summary: { mode: 'inherit' },
  idiom_examples: { mode: 'inherit' },
  idiom_violations: { mode: 'scope' },
  paradigm_conformance: { mode: 'inherit' },
  architectural_conflicts: { mode: 'inherit' },
  principle_violations: { mode: 'scope' },
  module_health: { mode: 'scope' },
  product_map: { mode: 'inherit' },
  embedding_index: { mode: 'inherit' },
  codebase_type: { mode: 'inherit' },
  codebase_type_confidence: { mode: 'inherit' },
  codebase_types: { mode: 'inherit' },
  codebase_type_signals: { mode: 'inherit' },
  coverage_gaps: { mode: 'inherit' },
  conventions_applied: { mode: 'inherit' },
  communication_seams: { mode: 'scope' },
  consistency_model: { mode: 'inherit' },
  libraries: { mode: 'inherit' },
  type_shapes: { mode: 'inherit' },
  dependency_manifest: { mode: 'inherit' },
  dependency_roles: { mode: 'inherit' },
  progressive_levels: { mode: 'inherit' },
  configuration: { mode: 'inherit' },
  runtime: { mode: 'inherit' },
  analysis_errors: { mode: 'inherit' },
  validation: { mode: 'inherit' },
  base_commit: { mode: 'inherit' },
  branch: { mode: 'inherit' },
  analyzed_track: { mode: 'inherit' },
  diff_only: { mode: 'inherit' },
  ai_cache_reuse: { mode: 'inherit' },
  layers_ready: { mode: 'inherit' },
  l0_index: { mode: 'inherit' },
} as const satisfies { [K in keyof CASOutput]-?: CASChildFieldPolicy };

type PolicyKey = keyof typeof CAS_CHILD_FIELD_POLICY;
type KeysWithMode<Mode extends CASChildFieldPolicy['mode']> = {
  [K in PolicyKey]: typeof CAS_CHILD_FIELD_POLICY[K]['mode'] extends Mode ? K : never;
}[PolicyKey];

type ProjectedKey = KeysWithMode<'scope' | 'recompute'>;

export type CASChildProjectedValues = {
  [K in ProjectedKey]-?: CASOutput[K] | undefined;
};

export interface CASChildIdentity {
  id: string;
  parent_id: string | null;
  label: string;
  children?: CASOutput[];
  composition_mode?: CASOutput['composition_mode'];
  analysis_id: string;
  system: CASSystem;
}

export function projectCasChild(
  parent: CASOutput,
  identity: CASChildIdentity,
  projected: CASChildProjectedValues,
): CASOutput {
  if (parent.member_reference) throw new Error(`CAS '${parent.id}' requires authorized, generation-pinned member resolution before child projection`);
  const knownFields = new Set<string>(Object.keys(CAS_CHILD_FIELD_POLICY));
  const unknownFields = Object.keys(parent).filter(field => !knownFields.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`CAS child projection has no field policy for: ${unknownFields.sort().join(', ')}`);
  }

  const output: Partial<CASOutput> = {};
  for (const field of Object.keys(CAS_CHILD_FIELD_POLICY) as PolicyKey[]) {
    const mode = CAS_CHILD_FIELD_POLICY[field].mode;
    const value = mode === 'identity'
      ? identity[field as keyof CASChildIdentity]
      : mode === 'inherit'
        ? parent[field]
        : projected[field as ProjectedKey];
    if (value !== undefined) (output as Record<string, unknown>)[field] = value;
  }
  if (Array.isArray(parent.analyzer_contributions) && parent.analyzer_contributions.some(contribution => contribution?.source_inputs)) {
    output.source_input_root = parent.source_input_root ?? parent.system.root_path;
  }
  return output as CASOutput;
}
