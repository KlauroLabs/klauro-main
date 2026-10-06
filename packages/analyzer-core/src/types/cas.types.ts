import { createHash } from 'crypto';
import type { CASExitPoint } from './cas-exit-point.types';
export { EXIT_POINT_TYPES } from './cas-exit-point.types';
export type { CASExitPoint, CASExitPointType } from './cas-exit-point.types';
import type { CASCoverageGap } from './cas-coverage.types';
import type { CASAnalyzerSourceInputEvidence, CASSourceInputCatalog } from './cas-source-input.types';
export type { CASAnalyzerSourceInputs, CASAnalyzerSourceInputEvidence, CASAnalyzerSourceInputReferences, CASSourceInputCatalog, CASSourceInputIdentity } from './cas-source-input.types';
export type { CASCoverageGap, CASCoverageGapKind } from './cas-coverage.types';
import type { CASComposedClaimProvenance, CASTerminalityProvenance } from './cas-composition.types';
export type { CASComposedClaimProvenance, CASTerminalityEdge, CASTerminalityProvenance, CASTerminalityRelationEvidence } from './cas-composition.types';
import type { CASFirstPartyProductEvidence } from './cas-product-evidence.types';
import type { CASHistoryPercentiles } from './cas-history.types';
export type { CASFirstPartyProductEvidence, CASFirstPartyProductEvidenceValue, CASFirstPartyProductStatement } from './cas-product-evidence.types';
export interface CASOutput extends CASSourceInputCatalog {
  id?: string;
  parent_id?: string | null;
  label?: string;
  children?: CASOutput[];
  composition_mode?: 'derived' | 'composed';
  cas_version: string;
  analyzer_build?: string;
  parser_fingerprint?: string;
  derived_fingerprint?: string;
  analysis_timestamp: string;
  analysis_id: string;
  system: CASSystem;
  analysis_phases?: CASAnalysisPhase[];
  timings?: CASAnalysisTimings;
  architecture_summary?: CASArchitectureSummary;
  route_table?: CASRouteTableEntry[];
  database_schema?: CASDatabaseSchema;
  perspectives?: CASPerspective[];
  nodes: CASNode[];
  edges: CASEdge[];
  entry_points?: CASEntryPoint[];
  exit_points?: CASExitPoint[];
  external_services?: CASExternalService[];
  repository_links?: CASCrossRepositoryLink[];
  dependencies?: Dependencies;
  disclosure?: DisclosureHints;
  analyzer_contributions: CASAnalyzerContribution[];
  method_calls?: CASMethodCall[];
  call_chains?: CASCallChain[];
  decorators?: CASDecorator[];
  documentation_summary?: CASDocumentationSummary;
  todos_summary?: CASTodoSummary;
  implementation_health?: CASImplementationHealth;
  system_health?: CASSystemHealth;
  behaviors?: CASBehavior[];
  patterns?: CASPattern[];
  communities?: CASCommunity[];
  reachability_index?: CASReachabilityIndex;
  structural_importance_meta?: CASStructuralImportanceMeta;
  categories?: CASCategories;
  tags?: CASTag[];
  index?: CASIndex;
  cross_repository_links?: CASCrossRepositoryLink[];
  security_contexts?: CASSecurityContext[];
  test_coverage?: CASTestCoverage;
  test_suites?: CASTestSuite[];
  mocks?: CASMock[];
  fixtures?: CASFixture[];
  test_summary?: CASTestSummary;
  intents?: CASIntent[];
  flow_summary?: CASFlowSummary;
  change_risks?: CASChangeRisk[];
  change_risk_summary?: CASChangeRiskSummary;
  entities?: CASDataEntity[];
  data_summary?: CASDataSummary;
  behavioral_invariants?: CASBehavioralInvariant[];
  behavioral_invariant_summary?: CASBehavioralInvariantSummary;
  security_boundaries?: CASSecurityBoundary[];
  security_summary?: CASSecuritySummary;
  flow_coverage?: CASFlowCoverage[];
  test_gaps?: CASTestGap[];
  temporal_stability?: CASTemporalStability[];
  stability_summary?: CASStabilitySummary;
  capabilities?: SystemCapability[];
  flows?: FlowConcept[];
  steps?: FlowStep[];
  terminality?: CASTerminality;


  behavior_surfaces?: SystemCapability[];
  system_purpose?: SystemPurpose;

  entry_point_flows?: CASEntryPointFlow[];
  entry_point_flow_summary?: CASEntryPointFlowSummary;
  data_lineage?: CASEntityLineage[];
  domain_concepts?: CASDomainConcept[];
  enhanced_system_purpose?: EnhancedSystemPurpose;

  flow_graph?: CASFlowGraph;
  runtime_static_links?: CASRuntimeStaticLink[];
  analysis_facts?: CASAnalysisFact[];
  distribution_units?: CASDistributionUnit[];
  units?: CASIndexUnit[];
  deployable_evidence?: DeployableEvidence[];


  codebase_idioms?: CASCodebaseIdiom[];
  idiom_summary?: CASIdiomSummary;
  idiom_examples?: CASIdiomExample[];
  idiom_violations?: CASIdiomViolation[];
  paradigm_conformance?: CASParadigmConformance[];
  architectural_conflicts?: CASArchitecturalConflict[];
  principle_violations?: CASPrincipleViolation[];


  module_health?: CASModuleHealth;
  product_map?: CASProductMap;


  embedding_index?: CASEmbeddingIndex;








  codebase_type?: import('../analyzer/core/codebase-type').CodebaseType;
  codebase_type_confidence?: number;


  codebase_types?: Array<{ type: import('../analyzer/core/codebase-type').CodebaseType; confidence: number }>;
  codebase_type_signals?: import('../analyzer/core/codebase-type').CodebaseTypeSignal[];









  coverage_gaps?: CASCoverageGap[];









  conventions_applied?: import('../analyzer/core/conventions-applier').ConventionMatchReport[];









  communication_seams?: import('../analyzer/core/communication-seams').CommunicationSeamsResult;










  consistency_model?: import('../analyzer/core/consistency-model').ConsistencyModelResult;

  libraries?: CASLibrary[];












  dependency_manifest?: CASDependencyManifest;














  dependency_roles?: CASDependencyRole[];

  progressive_levels: CASProgressiveLevels;
  configuration?: CASConfiguration;
  runtime?: CASRuntime;
  analysis_errors?: CASAnalysisError[];
  validation?: CASValidation;


  base_commit?: string;
  branch?: string;

  analyzed_track?: 'main' | 'other-branch' | 'in-flight';


  diff_only?: boolean;

























  ai_cache_reuse?: {


    hits: number;
    misses: number;




    bypassed: boolean;
  };








  layers_ready?: CASLayersReady;
  member_reference?: CASMemberReference;






  l0_index?: {
    total_files: number;
    languages: Array<{ name: string; files: number }>;
    top_level_dirs: string[];
    duration_ms: number;
  };
}




export interface CASLayerStatus {
  layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  name: string;








  status: 'pending' | 'ready' | 'error' | 'not_loaded';

  completed_at?: string;
  duration_ms?: number;

  error?: string;

  
  
  warning?: string;
  fields: string[];
  not_loaded_fields?: string[];
}







export interface CASMemberReference {
  format: 'workspace-member-reference';
  version: 1;
  project_id: string;
  composed_id: string;
  analysis_id: string;
  analysis_timestamp: string;
  generation: string;
  storage_format: 'segmented-v2';
  loaded_sections: string[];
  omitted_sections: string[];
  loaded_fields: string[];
  omitted_fields: string[];
}

export interface CASLayersReady {
  layers: CASLayerStatus[];


  complete: boolean;
  generated_at: string;
}

export interface CASEmbeddingIndex {
  model: string;
  provider: 'api' | 'local';
  dimensions: number;
  document_version: string;
  store: 'file' | 'pgvector';
  generated_at: string;
  node_count: number;
  coverage: {
    embedded: number;
    skipped: number;
    failed: number;
  };
  degraded?: boolean;
  degraded_reason?: string;
}

export type CASDistributionUnitKind =
  | 'desktop-app'
  | 'mobile-app'
  | 'server-bundle'
  | 'installer'
  | 'container-stack'
  | 'package'
  | 'deployment-unit';

export type CASDistributionEvidenceSource =
  | 'installer'
  | 'install-script'
  | 'release-script'
  | 'service-unit'
  | 'desktop-entry'
  | 'package-manifest'
  | 'container-topology'
  | 'ci'
  | 'inferred';

export interface CASDistributionEvidence {
  source: CASDistributionEvidenceSource;
  file?: string;
  line?: number;
  claim: string;
  confidence: number;
}

export interface CASDistributionUnit {
  id: string;
  name: string;
  kind: CASDistributionUnitKind;
  platforms: string[];
  component_names: string[];
  component_node_ids: string[];
  artifact_node_ids: string[];
  artifact_paths: string[];
  install_paths?: string[];
  evidence: CASDistributionEvidence[];
  confidence: number;
  agent_guidance?: string;
}

export interface CASPerspective {
  id: string;
  name: string;
  description: string;
  analyzer_id: string;
  type: 'flow' | 'structure' | 'deployment' | 'data' | 'security' | 'custom';
  connection_rules?: {
    node_connections?: Array<{
      from_type: string;
      to_types: string[];
      edge_type: string;
      conditions?: Record<string, any>;
    }>;
    visible_node_types?: string[];
    relevant_edge_types?: string[];
  };
  layout_hints?: {
    style: 'hierarchical' | 'force' | 'circular' | 'grid';
    direction?: 'TB' | 'LR' | 'BT' | 'RL';
    group_by?: string;
  };
  metadata?: Record<string, any>;
}

export interface CASNestedRepository {
  path: string;
  has_git_directory: boolean;
  primary_language?: string;
  source_files: number;
  note: string;
}

export interface CASSystemCatalogEntry {
  owner?: string;
  system?: string;
  depends_on?: string[];
}

export interface CASSystem {
  id: string;
  name: string;
  description?: string;
  type: 'monorepo' | 'application' | 'library' | 'service' | 'package';
  root_path: string;
  catalog?: CASSystemCatalogEntry;
  analysis_focus?: 'agent-fast' | 'ui-overview' | 'deep-context' | 'full';
  repository?: {
    url?: string;
    branch?: string;
    commit?: string;
  };
  package_management?: {
    primary_manager?: string;
    lock_files?: string[];
    manifests?: string[];
  };
  technologies?: {
    languages?: Array<{
      name: string;
      version?: string;
      percentage?: number;
      files?: number;
    }>;
    unanalyzed_languages?: Array<{
      name: string;
      files: number;
      share_of_source: number;
    }>;
    nested_repositories?: CASNestedRepository[];
    frameworks?: Array<{
      name: string;
      version?: string;
      confidence?: number;
    }>;









    framework_identities?: CASFrameworkIdentity[];
    runtime?: string;
    databases?: string[];
    infrastructure?: string[];
  };
  dependencies?: {
    direct_count?: number;
    total_count?: number;
    critical_vulnerabilities?: number;
    outdated_packages?: number;
    license_issues?: number;
  };
  quality?: {
    test_coverage?: number;
    code_quality_score?: number;
    documentation_coverage?: number;
    complexity_score?: number;
    maintainability_index?: number;
  };









  repo_facts?: {
    contributor_count?: number;
    first_commit_at?: string;
    last_commit_at?: string;
  };









  repo_facts_status?: {
    available: false;
    reason: string;
  };
  metadata?: Record<string, any>;
}

export interface CASNodePerspective {
  hierarchy: string[];
  level: number;
  priority: number;
  metadata?: Record<string, any>;
}

export interface CASNode {
  id: string;
  name: string;
  type: string;
  qualified_name?: string;
  category?: string;
  subcategories?: string[];
  perspectives?: Record<string, CASNodePerspective>;
  analyzers?: string[];
  primaryAnalyzer?: string;
  level?: number;
  level_name?: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  tags?: string[];
  contract?: ICELOTContract;










  role?: CASNodeRole;









  role_source?: 'framework-evidence' | 'structural-evidence';






  role_evidence?: string;




  structural_importance?: number;
  documentation?: CASDocumentation;
  comments?: CASComment[];
  implementation_status?: CASImplementationStatus;
  todos?: CASTodo[];
  call_graph?: CASCallGraph;
  source?: {
    file?: string;
    line?: number;
    end_line?: number;
    column?: number;
    end_column?: number;
    raw?: string;
  };
  metadata?: {
    language?: string;
    framework?: string;
    paradigm?: string;
    commonjs_reexports?: string[];
    access_modifier?: 'public' | 'private' | 'protected';
    is_abstract?: boolean;
    is_static?: boolean;
    is_async?: boolean;
    is_exported?: boolean;
    is_test?: boolean;
    is_generated?: boolean;
    complexity?: {
      cyclomatic?: number;
      cognitive?: number;
      halstead?: Record<string, number>;
    };
    metrics?: {
      lines_of_code?: number;
      lines_of_comments?: number;
      test_coverage?: number;
    };
    documentation?: string;
    annotations?: string[];
    attributes?: Record<string, any>;
    perspective_data?: Record<string, any>;
  };
  signature?: {
    parameters?: Array<{
      name: string;
      type?: string;
      optional?: boolean;
      default_value?: string;
    }>;
    return_type?: string;
    type_parameters?: string[];
    throws?: string[];
  };
  implementation?: {
    body_hash?: string;
    uses?: string[];
    modifies?: string[];
    local_variables?: Array<{
      name: string;
      type?: string;
    }>;
    control_flow?: Record<string, any>;
  };
  runtime?: {
    performance_characteristics?: {
      typical_latency?: string;
      memory_usage?: string;
      cpu_intensive?: boolean;
      io_bound?: boolean;
    };
    scalability?: {
      stateless?: boolean;
      horizontally_scalable?: boolean;
      singleton?: boolean;
    };
  };
  security?: {
    authentication_required?: boolean;
    authorization_roles?: string[];
    data_sensitivity?: string;
    encryption?: string;
    protected?: boolean;
    public?: boolean;
  };
  testing?: {
    tested_by?: string[];
    test_type?: string;
    coverage_percentage?: number;
    assertions?: number;
  };
  configuration?: {
    environment_variables?: string[];
    config_files?: string[];
    feature_flags?: string[];
    required_services?: string[];
  };
  children?: string[];
  parent?: string;
}

export interface CASEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  perspectives?: string[];
  category?: string;
  metadata?: {
    weight?: number;
    confidence?: number;
    occurrences?: number;
    bidirectional?: boolean;
    transitive?: boolean;
    async?: boolean;
    conditional?: boolean;
    locations?: Array<{
      file?: string;
      line?: number;
      context?: string;
    }>;
    attributes?: Record<string, any>;
    perspective_data?: Record<string, any>;
  };
}











export const ENTRY_POINT_TYPES = [
  'http', 'websocket', 'cli', 'event', 'schedule', 'page', 'route',
  'message', 'file', 'test', 'lifecycle', 'api',



  'task', 'pipeline', 'notebook-cell', 'train',


  'interrupt', 'driver',



  'ipc', 'command',



  'rpc',





  'graphql',
  'ui',
  'tool',
] as const;

export type CASEntryPointType = typeof ENTRY_POINT_TYPES[number];

export const ENTRY_POINT_TYPE_REACH = {
  http: 'external', websocket: 'external', cli: 'external', event: 'unknown', schedule: 'internal', page: 'external', route: 'external',
  message: 'unknown', file: 'internal', test: 'internal', lifecycle: 'internal', api: 'external', task: 'internal', pipeline: 'internal',
  'notebook-cell': 'external', train: 'external', interrupt: 'internal', driver: 'internal', ipc: 'external', command: 'external', rpc: 'external', graphql: 'external', ui: 'external',
  tool: 'external',
} as const satisfies Record<CASEntryPointType, 'external' | 'internal' | 'unknown'>;

export interface CASEntryPoint {
  id: string;
  source_node: string;
  source_analyzer?: string;
  type: CASEntryPointType;
  name: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  trigger?: {
    method?: string;
    path?: string;
    pattern?: string;
    event?: string;
    schedule?: string;
    parameters?: Array<{
      name: string;
      type: string;
      required: boolean;
      location?: string;
    }>;
  };
  handler?: {
    node_id: string;
    method_name: string;
    file?: string;
    line?: number;
  };
  input?: {
    type?: string;
    schema?: string;
    validation?: string[];
    example?: any;


    fields?: Array<{ name?: string; type: string }>;
    is_positional_only?: boolean;
  };
  output?: {
    type?: string;
    schema?: string;
    status_codes?: number[];



    is_named_type?: boolean;
    is_void?: boolean;
  };
  security?: {
    authenticated?: boolean;
    authorized_roles?: string[];
    guards?: string[];
    roles?: string[];
    permissions?: string[];
    rate_limit?: string;
    redirect_if_unauthorized?: string;



    enforcement?: 'enforced' | 'assumed';
  };



  capabilities?: Array<{ capability_id: string; capability_name: string; role: string }>;


  interaction_reach?: 'external' | 'internal' | 'unknown';


  deployable_id?: string;
  deployable_name?: string;
  connected_nodes?: string[];
  metadata?: Record<string, any>;
}

































export const NODE_ROLES = [



  'controller',


  'middleware',



  'guard',



  'gateway',


  'resolver',



  'migration',


  'scheduled-job',


  'event-listener',
] as const;

export type CASNodeRole = typeof NODE_ROLES[number];



export interface CASBehavior {
  id: string;
  name: string;
  description?: string;
  nodes?: string[];
  flow?: Array<{
    from: string;
    to: string;
    action: string;
  }>;
  metadata?: Record<string, any>;
}

export interface CASPatternVariation {
  id: string;
  implementation: string;
  description: string;
  instances: string[];
  percentage: number;
  characteristics?: Record<string, any>;
}

export interface CASPatternDeviation {
  type: 'inconsistent-adoption' | 'partial-implementation' | 'anti-pattern' | 'obsolete-usage' | 'mixed-styles';
  severity: 'info' | 'warning' | 'error';
  description: string;
  affected_instances: string[];
  recommendation?: string;
}


export interface CASCommunity {
  id: number;
  member_ids: string[];
  size: number;
  internal_edges: number;
}














export interface CASReachabilityIndex {
  version: 1;














  includes_invokes_edges?: boolean;

  node_ids: string[];


  comp_of: number[];
  comp_count: number;

  comp_adj_offsets: number[];
  comp_adj_targets: number[];


  label_out_offsets: number[];
  label_out: number[];
  label_in_offsets: number[];
  label_in: number[];
  stats: {
    nodes: number;
    edges: number;
    comps: number;
    largest_scc: number;
    label_entries: number;
  };
}




export interface CASStructuralImportanceMeta {
  algorithm: 'seeded-random-walk-power-iteration';
  damping: number;
  epsilon: number;
  max_iterations: number;
  iterations: number;
  converged: boolean;


  seed_count: number;
  seed_source: 'entry-points' | 'uniform';
  node_count: number;
  edge_count: number;
}

export interface CASPattern {
  id: string;
  type?: 'design-pattern' | 'architectural-pattern' | 'anti-pattern';
  name: string;
  description?: string;
  confidence: number;
  instances: string[];
  variations?: CASPatternVariation[];
  deviations?: CASPatternDeviation[];
  metadata?: {
    framework_specific?: boolean;
    language_specific?: boolean;
    benefits?: string[];
    drawbacks?: string[];
  };
}

export type CASIdiomCategory =
  | 'naming'
  | 'file-organization'
  | 'module-boundary'
  | 'dependency-injection'
  | 'data-access'
  | 'error-handling'
  | 'validation'
  | 'auth-tenant-scope'
  | 'logging'
  | 'testing'
  | 'migrations'
  | 'async-style'
  | 'configuration';

export interface CASIdiomScope {
  languages?: string[];
  frameworks?: string[];
  node_types?: string[];
  file_globs?: string[];
  node_ids?: string[];
  files?: string[];
}

export interface CASIdiomEvidence {
  kind: 'node' | 'edge' | 'file' | 'import' | 'decorator' | 'test' | 'migration' | 'invariant' | 'pattern' | 'analysis-fact';
  file?: string;
  line?: number;
  node_id?: string;
  edge_id?: string;
  fact_id?: string;
  claim: string;
  confidence: number;
}

export interface CASIdiomExample {
  id: string;
  idiom_id: string;
  file: string;
  line?: number;
  node_id?: string;
  name?: string;
  excerpt?: string;
  explanation: string;
}

export interface CASIdiomViolation {
  id: string;
  idiom_id: string;
  category: CASIdiomCategory;
  severity: 'info' | 'warning' | 'error';
  file?: string;
  line?: number;
  node_id?: string;
  description: string;
  recommendation: string;
  evidence?: CASIdiomEvidence[];
}

export interface CASCodebaseIdiom {
  id: string;
  category: CASIdiomCategory;
  name: string;
  description: string;
  confidence: number;
  prevalence: number;
  evidence: CASIdiomEvidence[];
  positive_examples: CASIdiomExample[];
  affected_scopes: CASIdiomScope;
  agent_guidance: {
    do: string[];
    avoid: string[];
    validation: string[];
  };
  deviations?: CASIdiomViolation[];
  provenance?: {
    evidence_files: number;
    evidence_nodes: number;
    population: number;
    matching: number;
    derivation: string;
  };
}

export interface CASIdiomSummary {
  total: number;
  high_confidence: number;
  violations: number;
  by_category: Record<CASIdiomCategory, number>;
  top_idioms: string[];
  guidance_digest: string[];
}

export type CASParadigmDeviationKind =
  | 'direct-data-access'
  | 'layer-skipping-call'
  | 'unguarded-entry-point'
  | 'parallel-implementation'
  | 'convention-departure';

export interface CASParadigmDeviation {
  file: string;
  node_id: string;
  kind: CASParadigmDeviationKind;
  detail: string;
  severity: 'info' | 'warning' | 'error';
}





export interface CASArchitecturalConflict {
  id: string;
  kind: 'pattern-conflict' | 'pattern-overlap';
  concern: string;
  competing: Array<{
    label: string;
    files: string[];
    share: number;
  }>;
  severity: 'low' | 'medium' | 'high';
  evidence: string[];
  suggested_alignment: string;
}




export interface CASPrincipleViolation {
  id: string;
  principle: 'layering' | 'single-responsibility' | 'coupling';
  file: string;
  node_id: string;
  detail: string;
  severity: 'info' | 'warning' | 'error';
}












export interface CASModuleHealthFileStat {
  file: string;
  lines: number;
  node_count: number;
  fan_in: number;
  commits_90d: number;
  capability_anchor_count: number;
}

export interface CASModuleHealthFinding {
  id: string;
  file: string;
  kind: 'size-outlier' | 'change-concentration' | 'fan-in-hotspot' | 'mixed-concerns' | 'danger-composite';


  metric_value: number;

  robust_z: number;
  comparison: { median: number; scale: number; sample_size: number };
  severity: 'info' | 'warning' | 'error';
  detail: string;
  evidence: string[];
}

export interface CASModuleHealth {


  method: string;
  files_analyzed: number;
  total_lines: number;
  total_commits_90d: number;
  concentration: {
    size_outlier_file_count: number;

    size_outlier_share_of_lines: number;
    churn_outlier_file_count: number;

    churn_outlier_share_of_commits: number;
  };
  findings: CASModuleHealthFinding[];


  file_stats: CASModuleHealthFileStat[];
}

export interface CASParadigmConformance {
  paradigm: string;
  description: string;
  adoption: {
    following_count: number;
    comparable_count: number;
    adoption_rate: number;
    evidence_files: string[];
  };
  deviations: CASParadigmDeviation[];
}

export interface CASProductMapCapability {
  name: string;
  description: string;






  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  category: 'core' | 'supporting' | 'admin' | 'internal';
  criticality: 'critical' | 'high' | 'medium' | 'low';
  entry_point_flows: Array<{ id: string; name: string }>;
  entities: string[];
  tests_present: boolean;
  confidence?: number;
  risk_level: 'low' | 'medium' | 'high';
}

export interface CASProductMapEntryPointFlow {
  id: string;
  name: string;
  kind: 'user-facing' | 'system' | 'scheduled';
  criticality: 'critical' | 'high' | 'medium' | 'low';
  boundaries: string[];
  tests: number;
  unshipped?: string;
}

export interface CASProductMapJourney {
  id: string;
  label: string;
  does: string;
  steps: number;
  flows: number;
  programs: number;
}

export interface CASProductMap {
  identity: {
    name: string;
    domain: string;








    domain_label?: string;



    domain_source?: 'deterministic' | 'ai' | 'ai-refined' | 'reused';
    description: string;
    description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
    unanalyzed_languages: Array<{ name: string; files: number; share_of_source: number }>;
    nested_repositories?: CASNestedRepository[];
  };
  capabilities: CASProductMapCapability[];
  entry_point_flows: {
    total: number;
    user_facing: number;
    system: number;
    scheduled: number;
    top: CASProductMapEntryPointFlow[];
  };
  journeys: {
    total: number;
    shown: number;
    top: CASProductMapJourney[];
  };
  data: {
    entities: number;
    sensitive: string[];
    exposure_highlights: Array<{
      entity: string;
      sensitive_fields: string[];
      unguarded_paths: number;
      non_auth_guarded_paths?: number;
      external_transfer: boolean;
      external_transfer_unresolved?: boolean;
      unresolved_exit_point_ids?: string[];
      external_recipients: string[];
    }>;
  };
  conventions: {
    paradigms: Array<{
      paradigm: string;
      description: string;
      adoption_rate: number;
      following_count: number;
      comparable_count: number;
    }>;
    open_deviations: { error: number; warning: number; info: number };
  };
  health: {
    status?: 'healthy' | 'watch' | 'at-risk' | 'critical';
    score?: number;
    tests: { total: number; passing: number; failing: number; unknown?: number; execution_status?: 'not-run' | 'partial' | 'observed' | 'unknown'; coverage_percentage?: number };
    implementation: {
      complete: number;
      partial: number;
      stubs: number;
      not_implemented: number;
      deprecated: number;
      health_score?: number;
    };
    top_risks: Array<{ name: string; level: 'low' | 'medium' | 'high'; type: string; recommendation: string }>;
  };






  runtime_topology?: CASProductMapRuntimeTopology;
  coverage_caveats: string[];
}

export interface CASProductMapRuntimeTopology {

  edge_count: number;

  deployables: CASProductMapDeployableTopology[];








  communication?: CASProductMapCommunicationGraph;
}

export interface CASProductMapCommunicationGraph {

  counts: { sync: number; async: number; passive: number; total: number };



  edges: CASProductMapCommunicationEdge[];
}

export interface CASProductMapCommunicationEdge {

  source: string;

  target: string;

  modalities: ('sync' | 'async' | 'passive')[];
  sync: number;
  async: number;
  passive: number;
  total: number;
}

export interface CASProductMapDeployableTopology {

  name: string;

  deploys: string[];

  exposes: string[];

  routes: string[];

  channels: string[];

  databases: string[];

  storage: string[];

  depends_on: string[];
}

export interface CASCategories {
  [level: string]: {
    [category: string]: {
      name?: string;
      types?: string[];
      common_patterns?: string[];
      parent_categories?: string[];
      description?: string;
      frameworks?: string[];
      languages?: string[];
      parent_types?: string[];
    };
  };
}

export interface CASTag {
  name: string;
  category?: string;
  nodes?: string[];
  color?: string;
  metadata?: Record<string, any>;
}

export interface CASIndex {
  by_type?: Record<string, string[]>;
  by_name?: Record<string, string[]>;
  by_perspective?: Record<string, string[]>;
  entry_points?: string[];
  exit_points?: string[];
  external_services?: string[];
  [key: string]: any;
}

export interface CASExternalService {
  id: string;
  name: string;
  type: string;
  purpose?: 'consumption' | 'production' | 'bidirectional';
  description?: string;
  endpoint?: string;
  provider?: string;
  usage_pattern?: {
    frequency?: string;
    criticality?: string;
    operations?: string[];
  };
  connected_nodes?: string[];
  entry_points?: string[];
  exit_points?: string[];
  configuration?: Record<string, any>;
  monitoring?: {
    health_check?: string;
    metrics?: string[];
  };
  cost?: {
    model?: string;
    estimated_monthly?: string;
  };
}

export interface CASCrossRepositoryLink {
  id: string;
  type: 'api' | 'library' | 'shared-schema' | 'message-contract' | 'shared-database';
  source_repository?: {
    url?: string;
    node_ids?: string[];
    path?: string;
  };
  target_repository?: {
    url?: string;
    node_ids?: string[];
    path?: string;
  };
  connection?: {
    protocol?: string;
    endpoint?: string;
    method?: string;
    contract?: string;
    package_name?: string;
    version?: string;
    broker?: string;
    exchange?: string;
    routing_key?: string;
    message_schema?: string;
  };
  metadata?: {
    verified?: boolean;
    last_sync?: string;
    breaking_changes?: boolean;
    confidence?: number;
    evidence?: CASFactEvidence[];
  };
}

export interface CASFactEvidence {
  kind: 'source-location' | 'analyzer' | 'configuration' | 'dependency' | 'route' | 'runtime-signal' | 'naming' | 'graph';
  source: string;
  file?: string;
  line?: number;
  excerpt?: string;
  confidence: number;
}

export interface CASAnalysisFact {
  id: string;



  subject_type: 'node' | 'edge' | 'entry_point' | 'exit_point' | 'external_service' | 'entry_point_flow' | 'capability' | 'runtime_link' | 'repository_link';
  subject_id: string;
  fact_type: 'definition' | 'relationship' | 'entry' | 'exit' | 'entry_point_flow' | 'capability' | 'runtime-correlation' | 'cross-repository';
  claim: string;
  confidence: number;
  produced_by: string;
  evidence: CASFactEvidence[];
}

export interface CASRuntimeStaticLink {
  id: string;
  kind: 'entry-point' | 'exit-point' | 'call-chain' | 'external-service' | 'telemetry-hook';
  static_id: string;
  runtime_signal: string;
  telemetry_status: 'observed' | 'instrumentable' | 'not-instrumented';
  confidence: number;
  instrumentation_points: string[];
  evidence: CASFactEvidence[];
}

export interface CASSecurityContext {
  id: string;
  name: string;
  type?: 'authorization' | 'authentication' | 'encryption';
  scope?: {
    node_ids?: string[];
    entry_points?: string[];
    paths?: string[];
  };
  requirements?: {
    authentication?: {
      required?: boolean;
      methods?: string[];
      multi_factor?: boolean;
    };
    authorization?: {
      roles?: string[];
      permissions?: string[];
      policy?: string;
    };
    data_protection?: {
      encryption_at_rest?: boolean;
      encryption_in_transit?: boolean;
      pii_handling?: string;
      audit_logging?: boolean;
    };
  };
  compliance?: {
    standards?: string[];
    data_residency?: string;
    retention_policy?: string;
  };
  threats?: {
    owasp_top_10?: string[];
    mitigations?: string[];
  };


  node_id?: string;
  trust_level?: 'untrusted' | 'partially-trusted' | 'trusted';
  security_relevant?: boolean;
  security_relevance_reason?: string;
  required_protections?: string[];
  actual_protections?: string[];
  protection_gaps?: string[];
}

export interface CASTestCoverage {
  summary?: {
    total_coverage?: number;
    lines_covered?: number;
    lines_total?: number;
    branches_covered?: number;
    branches_total?: number;
    functions_covered?: number;
    functions_total?: number;
  };
  by_level?: Record<string, {
    coverage?: number;
    test_count?: number;
    assertion_count?: number;
  }>;
  by_component?: Record<string, {
    coverage?: number;
    untested_nodes?: string[];
  }>;
  test_relationships?: Array<{
    test_id?: string;
    tested_nodes?: string[];
    test_type?: string;
    assertions?: number;
    coverage_contribution?: number;
  }>;
}







export interface CASLibrary {
  id: string;
  name: string;
  version?: string;
  type?: 'production' | 'development' | 'peer' | 'optional';
  category?: string;
  package_manager?: string;
  description?: string;
  usage_patterns?: Array<{
    pattern?: string;
    occurrences?: number;
    example_nodes?: string[];
    functions_used?: string[];
  }>;
  size?: {
    bundle_size?: string;
    gzipped_size?: string;
    tree_shakeable?: boolean;
  };
  security?: {
    vulnerabilities?: number;
    last_audit?: string;
    license?: string;
    license_compatible?: boolean;
  };
  usage_statistics?: {
    import_count?: number;
    usage_frequency?: string;
    critical_path?: boolean;
    performance_impact?: string;
  };
  related_libraries?: string[];
  alternative_libraries?: string[];
  migration_complexity?: string;
  connected_nodes?: string[];
  optimization_opportunities?: Array<{
    type?: string;
    potential_savings?: string;
    recommendation?: string;
  }>;
  replacement_feasibility?: {
    native_alternatives?: number;
    smaller_alternatives?: string[];
    effort_estimate?: string;
  };
  metadata?: {
    installation_date?: string;
    last_updated?: string;
    auto_updatable?: boolean;
    breaking_changes_risk?: string;
  };
}







export interface CASDependencyManifest {


  manifests: string[];



  dependencies: CASDeclaredDependency[];

  total: number;
}









export const FRAMEWORK_ROLES = [
  'web', 'orm', 'di', 'test', 'build', 'queue', 'observability', 'other',
] as const;
export type CASFrameworkRole = typeof FRAMEWORK_ROLES[number];

export interface CASFrameworkIdentity {

  name: string;



  version?: string;

  ecosystem?: CASDeclaredDependency['ecosystem'];
  role: CASFrameworkRole;



  role_confidence: number;



  role_evidence: string;
}







export const DEPENDENCY_ROLE_KINDS = [
  'http-client', 'database-driver', 'orm', 'cache', 'message-broker',
  'observability', 'auth', 'realtime', 'graphql-client', 'workflow',
  'other',
] as const;
export type CASDependencyRoleKind = typeof DEPENDENCY_ROLE_KINDS[number];

export interface CASDependencyRole {

  name: string;
  ecosystem: CASDeclaredDependency['ecosystem'];
  role: CASDependencyRoleKind;



  confidence: number;


  evidence: string[];
  source: 'exit-point-evidence' | 'known-package-list';
}

export interface CASDeclaredDependency {


  name: string;

  ecosystem: 'npm' | 'pypi' | 'cargo' | 'go' | 'maven' | 'gradle' | 'nuget' | 'composer' | 'pub' | 'unknown';

  version?: string;

  scopes: Array<'runtime' | 'dev' | 'peer' | 'optional' | 'build'>;

  declared_in: string[];
}

export interface CASAnalyzerContribution {
  source_inputs?: CASAnalyzerSourceInputEvidence;
  analyzer_id: string;
  analyzer_name: string;
  analyzer_version?: string;
  analyzer_type?: 'language' | 'framework' | 'library' | 'pattern';
  version?: string;
  contribution_type: 'language' | 'framework' | 'library' | 'pattern';
  confidence?: number;
  depends_on?: string[];
  nodes_created?: number;
  edges_created?: number;

  files_created?: number;
  nodes_contributed?: number;
  edges_contributed?: number;
  capabilities?: string[];
  analysis_scope?: {
    files_eligible?: number; files_analyzed?: number;
    files_skipped?: number; files_partial?: number; complete?: boolean; applicability?: 'file-coverage' | 'not-applicable';
    patterns_detected?: string[]; incomplete_reason?: string; omitted_paths?: string[]; partial_paths?: string[];
  };
  contributed_categories?: string[];
  contributed_entry_points?: number;
  contributed_exit_points?: number;
  execution_time?: string;
  execution_time_ms?: number;
  cache_status?: 'disabled' | 'hit' | 'miss' | 'invalidated' | 'coalesced';
  memory_usage?: string;
  provided_perspectives?: string[];
  errors?: string[];
  warnings?: string[];
  framework_specific?: Record<string, any>;
  library_specific?: Record<string, any>;
  application_type?: string;
  project_name?: string;
  project_version?: string;
  frameworks_detected?: Record<string, boolean>;
  crates?: Record<string, Record<string, boolean>>;
}

export interface CASProgressiveLevels {
  total_levels: number;
  level_definitions?: Array<{
    level: number;
    name?: string;
    description?: string;
    node_count?: number;
    recommended_for?: string[];
    example_nodes?: string[];
    time_to_understand?: string;
    contains?: {
      categories?: string[];
      entry_points?: string;
      exit_points?: string;
      key_connections?: string;
    };
  }>;
  query_patterns?: {
    level_specific?: {
      description?: string;
      example?: string;
      use_case?: string;
    };
    level_range?: {
      description?: string;
      example?: string;
      use_case?: string;
    };
    discover_levels?: {
      description?: string;
      example?: string;
      response?: string;
    };
    category_with_level?: {
      description?: string;
      example?: string;
      use_case?: string;
    };
    children_progressive?: {
      description?: string;
      example?: string;
      use_case?: string;
    };
  };
  consumer_recommendations?: {
    mcp_servers?: {
      initial_load?: string;
      on_demand?: string;
      benefit?: string;
      adaptive?: string;
    };
    ui_visualization?: {
      overview_mode?: string;
      detail_mode?: string;
      debug_mode?: string;
      benefit?: string;
    };
    documentation_tools?: {
      architecture_docs?: string;
      api_docs?: string;
      implementation_docs?: string;
      benefit?: string;
    };
  };
  level_strategy?: {
    flexible_depth?: string;
    minimum_levels?: number;
    maximum_levels?: string;
    common_range?: string;
    examples?: Record<string, string>;
  };
}

export interface CASConfiguration {
  environment_variables?: Array<{
    name: string;
    required?: boolean;
    default?: any;
    description?: string;
    used_by?: string[];
    sensitive?: boolean;
  }>;
  config_files?: Array<{
    path?: string;
    format?: string;
    environment_specific?: boolean;
    schema?: string;
  }>;
  feature_flags?: Array<{
    name?: string;
    enabled?: boolean;
    rollout_percentage?: number;
    affected_nodes?: string[];
  }>;
  required_services?: Array<{
    service?: string;
    version?: string;
    optional?: boolean;
  }>;
}

export interface CASRuntime {
  deployment?: {
    type?: string;
    orchestration?: string;
    scaling?: {
      min_instances?: number;
      max_instances?: number;
      auto_scaling?: boolean;
      scaling_metric?: string;
    };
  };
  performance?: {
    startup_time?: string;
    memory_baseline?: string;
    memory_peak?: string;
    cpu_baseline?: string;
    cpu_peak?: string;
    concurrent_requests?: number;
    request_duration_p50?: string;
    request_duration_p95?: string;
    request_duration_p99?: string;
  };
  dependencies?: {
    runtime?: string;
    system_libraries?: string[];
    external_services?: string[];
  };
  monitoring?: {
    health_check?: string;
    readiness_check?: string;
    metrics_endpoint?: string;
    logging?: {
      level?: string;
      format?: string;
      destinations?: string[];
    };
  };
  instrumentation?: {
    instrumentable_entry_points: string[];
    instrumentable_exit_points: string[];
    observed_call_chains: string[];
    missing_runtime_coverage: string[];
  };
}

export interface CASAnalysisError {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  file?: string;
  line?: number;
  analyzer?: string;
  recoverable?: boolean;
  suggestion?: string;
}

export interface CASValidation {
  schema_version?: string;
  schema_url?: string;
  validation_errors?: string[];
  validation_warnings?: Array<{
    path?: string;
    message?: string;
  }>;
  completeness?: {
    nodes_with_location?: number;
    edges_with_metadata?: number;
    documented_nodes?: number;
  };
  graph_integrity?: {
    total_edges: number;
    dangling_edges: number;
    duplicate_ids?: {
      nodes: number;
      edges: number;
      entry_points: number;
      exit_points: number;
    };
    connected_nodes: number;
    orphaned_nodes: number;
    entry_points_with_handlers: number;
    exit_points_with_sources: number;
    runtime_links_with_instrumentation: number;
    facts_with_evidence: number;
    relationship_coverage_score: number;
  };
}

export interface CASAnalyzer {
  getAnalyzerName(): string;
  getSupportedLanguages(): string[];
  getSupportedFrameworks(): string[];
  analyze(projectPath: string): Promise<CASContribution>;
  enhance?(existingAnalysis: CASOutput, projectPath: string): Promise<CASContribution>;
}

export interface CASContribution {
  nodes?: CASNode[];
  edges?: CASEdge[];
  entry_points?: CASEntryPoint[];
  exit_points?: CASExitPoint[];
  behaviors?: CASBehavior[];
  patterns?: CASPattern[];
  libraries?: CASLibrary[];
  external_services?: CASExternalService[];
  test_coverage?: CASTestCoverage;
  analyzer_metadata: CASAnalyzerContribution;
  categories?: Partial<CASCategories>;
  tags?: CASTag[];
  perspectives?: CASPerspective[];
  provided_perspectives?: string[];
  method_calls?: CASMethodCall[];
  call_chains?: CASCallChain[];
}

export interface CASMergeStrategy {
  nodeConflictResolution: 'merge' | 'replace' | 'keep-both';
  edgeConflictResolution: 'merge' | 'replace' | 'keep-both';
  metadataConflictResolution: 'merge' | 'replace' | 'prefer-specialized';
  priority: string[];
}

export class CASNodeBuilder {
  private node: Partial<CASNode> = {};

  constructor(id: string, name: string, type: string) {
    this.node = { id, name, type };
  }

  withLevel(level: number, levelName?: string): this {
    this.node.level = level;
    if (levelName) this.node.level_name = levelName;
    return this;
  }

  withCategory(category: string, subcategories?: string[]): this {
    this.node.category = category;
    if (subcategories) this.node.subcategories = subcategories;
    return this;
  }

  withSource(source: Partial<CASNode['source']>): this {
    this.node.source = { ...this.node.source, ...source };
    return this;
  }

  withMetadata(metadata: Partial<CASNode['metadata']>): this {
    this.node.metadata = { ...this.node.metadata, ...metadata };
    return this;
  }

  withParentChild(parent?: string, children?: string[]): this {
    if (parent) this.node.parent = parent;
    if (children) this.node.children = children;
    return this;
  }

  withParent(parent?: string): this {
    if (parent) this.node.parent = parent;
    return this;
  }

  withDescription(description: string): this {
    this.node.description = description;
    return this;
  }

  withTags(tags: string[]): this {
    this.node.tags = tags;
    return this;
  }

  withSignature(signature: Partial<CASNode['signature']>): this {
    this.node.signature = { ...this.node.signature, ...signature };
    return this;
  }

  withDocumentation(documentation?: CASDocumentation): this {
    if (documentation) this.node.documentation = documentation;
    return this;
  }

  withComments(comments?: CASComment[]): this {
    if (comments) this.node.comments = comments;
    return this;
  }

  withTodos(todos?: CASTodo[]): this {
    if (todos) this.node.todos = todos;
    return this;
  }

  withImplementationStatus(status?: CASImplementationStatus): this {
    if (status) this.node.implementation_status = status;
    return this;
  }

  withAnalyzers(analyzers: string[], primaryAnalyzer?: string): this {
    this.node.analyzers = analyzers;
    if (primaryAnalyzer) {
      this.node.primaryAnalyzer = primaryAnalyzer;
    } else if (analyzers.length > 0) {
      this.node.primaryAnalyzer = analyzers[0];
    }
    return this;
  }

  withPerspective(perspectiveId: string, perspective: CASNodePerspective): this {
    if (!this.node.perspectives) {
      this.node.perspectives = {};
    }
    this.node.perspectives[perspectiveId] = perspective;
    return this;
  }

  build(): CASNode {
    if (!this.node.id || !this.node.name || !this.node.type) {
      throw new Error('CAS node must have id, name, and type');
    }
    return this.node as CASNode;
  }
}

export class CASEdgeBuilder {
  private edge: Partial<CASEdge> = {};

  constructor(id: string, source: string, target: string, type: string) {
    this.edge = { id, source, target, type };
  }

  withCategory(category: string): this {
    this.edge.category = category;
    return this;
  }

  withMetadata(metadata: Partial<CASEdge['metadata']>): this {
    this.edge.metadata = { ...this.edge.metadata, ...metadata };
    return this;
  }

  build(): CASEdge {
    if (!this.edge.id || !this.edge.source || !this.edge.target || !this.edge.type) {
      throw new Error('CAS edge must have id, source, target, and type');
    }
    return this.edge as CASEdge;
  }
}

export function generateNodeId(type: string, filePath: string, name: string): string {
  const normalizedPath = filePath
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toLowerCase()
    .substring(0, 50);

  const normalizedName = name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .substring(0, 50);

  const hash = createHash('sha256')
    .update(filePath + name)
    .digest('hex')
    .substring(0, 8);

  return `${type}_${normalizedPath}_${normalizedName}_${hash}`;
}

export function generateEdgeId(source: string, target: string, type: string): string {
  const hash = createHash('sha256')
    .update(source + target + type)
    .digest('hex')
    .substring(0, 8);

  return `edge_${type}_${hash}`;
}

export interface CASDocumentation {
  id?: string;
  format?: 'jsdoc' | 'javadoc' | 'xml_doc' | 'docstring' | 'rustdoc' | 'godoc' | 'phpdoc' | 'typedoc' | 'other';
  type?: 'jsdoc' | 'javadoc' | 'xmldoc' | 'docstring' | 'rustdoc' | 'godoc' | 'phpdoc' | 'typedoc' | 'other' | 'django_docstring' | 'express_documentation' | 'fastapi_documentation' | 'flask_documentation' | 'laravel_documentation' | 'spring_boot_documentation';
  raw: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    type?: string;
    description?: string;
    optional?: boolean;
    default_value?: string;
  }>;
  returns?: {
    type?: string;
    description?: string;
  };
  return_info?: {
    type?: string;
    description?: string;
  };
  throws?: Array<{
    type?: string;
    description?: string;
  }>;
  exceptions?: Array<{
    type?: string;
    description?: string;
  }>;
  examples?: Array<{
    title?: string;
    code: string;
    language?: string;
  }>;
  tags?: Array<{
    tag: string;
    value: string;
    metadata?: Record<string, any>;
  }>;
  remarks?: string;
  framework_docs?: {
    swagger?: {
      summary?: string;
      description?: string;
      tags?: string[];
      operation_id?: string;
    };
    graphql?: {
      description?: string;
      deprecated?: boolean;
      deprecation_reason?: string;
    };
    django?: {
      view_type?: string;
      template?: string;
      form_class?: string;
      model?: string;
      field_help_texts?: Record<string, any>;
    };
    express?: {
      middleware?: string[];
      route_params?: string[];
      query_params?: string[];
      routes?: Record<string, any>;
    };
    fastapi?: {
      path_operation_id?: string;
      dependencies?: string[];
      status_code?: number;
      response_model?: string;
      field_descriptions?: Record<string, any>;
    };
    flask?: {
      route?: string;
      methods?: string[];
      endpoint?: string;
      decorators?: string[];
    };
    laravel?: {
      route_name?: string;
      middleware?: string[];
      controller?: string;
      action?: string;
    };
    spring_boot?: {
      mapping?: string;
      method?: string;
      params?: string[];
      consumes?: string[];
      produces?: string[];
    };
  };
  location: {
    start_line: number;
    end_line: number;
  };
}

export interface CASComment {
  id: string;
  type: 'single-line' | 'multi-line' | 'inline' | 'block' | 'docstring' | 'blade-comment';
  style: '//' | '#' | '--' | '/* */' | '<!-- -->' | 'other' | '"""' | '{{-- --}}';
  text: string;
  purpose?: 'explanation' | 'todo' | 'warning' | 'note' | 'hack' | 'clarification' | 'disabled-code' | 'other';
  location: {
    file: string;
    line: number;
    end_line?: number;
    column?: number;
    relative_to?: 'above' | 'inline' | 'below';
  };
  context?: {
    preceding_code?: string;
    following_code?: string;
    scope?: string;
    scope_id?: string;
  };
  markers?: {
    is_todo?: boolean;
    is_fixme?: boolean;
    is_hack?: boolean;
    is_warning?: boolean;
    is_note?: boolean;
    is_question?: boolean;
    is_important?: boolean;
    is_deprecated?: boolean;
    custom_markers?: string[];
  };
}

export interface CASTodo {
  id: string;
  type: 'TODO' | 'FIXME' | 'HACK' | 'NOTE' | 'WARNING' | 'XXX' | 'OPTIMIZE' | 'REFACTOR';
  text: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assignee?: string;
  created_date?: string;
  due_date?: string;
  category?: 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' | 'general';
  location: {
    file: string;
    line: number;
    node_id?: string;
    context?: string;
  };
  context?: {
    function_name?: string;
    class_name?: string;
    estimated_effort?: string;
    related_issue?: string;
  };
  classification?: {
    category?: 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' | 'general';
    technical_debt?: boolean;
    blocking?: boolean;
  };
  metadata?: Record<string, any>;
}

export interface CASImplementationStatus {
  status: 'complete' | 'partial' | 'stub' | 'not-implemented' | 'deprecated' | 'experimental';
  indicators: {
    has_todo_markers: boolean;
    has_not_implemented_exceptions: boolean;
    has_stub_returns: boolean;
    has_placeholder_code: boolean;
    has_hardcoded_values: boolean;
    has_commented_out_code: boolean;

    has_placeholder_template?: boolean;
    has_empty_methods?: boolean;
    has_console_logs?: boolean;
    has_mock_data?: boolean;
    has_deprecated_markers?: boolean;
  } | string[];
  confidence?: number;
  completeness?: {
    estimated_percentage?: number;
    missing_features?: string[];
    implemented_features?: string[];
  };
  deprecation?: {
    is_deprecated: boolean;
    deprecated_since?: string;
    removal_version?: string;
    replacement?: string;
    migration_guide?: string;
  };
  experimental?: {
    is_experimental: boolean;
    stability_level?: 'unstable' | 'experimental' | 'beta' | 'stable';
    expected_stable_version?: string;
  };
}


export interface CASMethodCall {
  id: string;
  caller_node: string;
  target_node?: string;
  call_details: {
    method_name: string;
    signature?: string;
    location: {
      file: string;
      line: number;
      column: number;
    };
    call_type: 'direct' | 'method' | 'constructor' | 'abstract' | 'interface' | 'callback' | 'hook' | 'dynamic';
    resolution_type: 'static' | 'dynamic' | 'polymorphic' | 'external' | 'unresolved';
  };
  execution_context: {
    is_async: boolean;
    is_conditional: boolean;
    is_in_loop: boolean;
    is_recursive: boolean;
    call_depth: number;
    conditional_depth: number;
    loop_depth: number;
    enclosing_function?: string;
    enclosing_class?: string;
  };
  arguments?: Array<{
    position: number;
    type?: string;
    value?: string;
    is_literal: boolean;
    is_variable: boolean;
  }>;
  external_details?: {
    library: string;
    module?: string;
    is_builtin: boolean;
    is_sdk: boolean;
    exit_point_id?: string;
  };
  framework_semantics?: {
    framework: string;
    decorator_type?: string;
    semantic_meaning?: string;
    route_info?: {
      method: string;
      path: string;
      parameters?: string[];
    };
  };
  performance_hints: {
    is_hot_path: boolean;
    is_potential_bottleneck: boolean;
    estimated_frequency?: number;
    is_critical_path?: boolean;
  };
  metadata?: Record<string, any>;
}

export interface CASCallChain {
  id: string;
  chain_type: 'entry-to-exit' | 'circular' | 'recursive' | 'dead-end' | 'hot-path' | 'critical-path';
  entry_point: {
    node_id: string;
    method_name: string;
    entry_point_id?: string;
  };
  exit_point?: {
    node_id?: string;
    method_name: string;
    exit_point_id?: string;
  };
  call_path: Array<{
    call_id: string;
    node_id: string;
    method_name: string;
    depth: number;
    execution_branch?: string;
  }>;
  characteristics: {
    total_calls: number;
    max_depth: number;
    has_external_calls: boolean;
    has_database_calls: boolean;
    has_async_calls: boolean;
    is_circular: boolean;
    is_recursive: boolean;
    complexity_score: number;
  };
  business_context?: {
    user_action?: string;
    business_process?: string;
    feature_area?: string;
  };
  risk_analysis: {
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    risk_factors: string[];
    bottlenecks?: Array<{
      node_id: string;
      method_name: string;
      reason: string;
      impact: 'low' | 'medium' | 'high';
    }>;
  };


  criticality?: 'critical' | 'high' | 'medium' | 'low';
  criticality_factors?: string[];
  runtime_stats?: {
    traffic_volume: 'very-high' | 'high' | 'medium' | 'low';
    avg_latency_ms?: number;
    error_rate_percent?: number;
    last_observed?: string;
  };
  test_coverage?: {
    covered: boolean;
    coverage_percentage?: number;
    test_ids?: string[];
    gaps?: string[];
  };

  metadata?: Record<string, any>;
}


export interface CASCallGraph {
  calls?: Array<{
    target_id: string;
    target_name: string;
    target_type: 'function' | 'method' | 'constructor' | 'api' | 'external';
    call_type: 'direct' | 'async' | 'callback' | 'event' | 'delegate';
    location: {
      line: number;
      column?: number;
    };
    arguments?: Array<{
      type?: string;
      value?: any;
      is_literal?: boolean;
    }>;
    is_recursive?: boolean;
    in_loop?: boolean;
    in_try_catch?: boolean;
    condition?: string;
  }>;
  called_by?: Array<{
    source_id: string;
    source_name: string;
    source_type: string;
    location: {
      file: string;
      line: number;
    };
  }>;
  call_chain_depth?: number;
  is_entry_point?: boolean;
  is_exit_point?: boolean;
  is_hot_path?: boolean;
  total_calls_made?: number;
  total_calls_received?: number;
  decorators?: Array<{
    name: string;
    type: string;
    arguments?: Record<string, any>;
    provides?: string[];
  }>;
  async_context?: {
    is_async: boolean;
    is_generator: boolean;
    is_observable: boolean;
    returns_promise: boolean;
    await_count?: number;
    parallel_operations?: boolean;
  };
}

export interface CASArchitectureSummary {
  system_type: string;
  total_files: number;
  total_lines?: number;
  architectural_patterns?: CASArchitecturalPatternSummary[];
  architectural_inventory?: CASArchitecturalInventory;
  pattern_balance?: CASPatternBalance;
  layers: {
    presentation?: {
      controllers?: number;
      guards?: number;
      middleware?: number;
      endpoints?: number;
      components?: number;
      pages?: number;
    };
    business?: {
      services?: number;
      providers?: number;
      use_cases?: number;
      handlers?: number;
    };
    data?: {
      repositories?: number;
      entities?: number;
      migrations?: number;
      models?: number;
    };
    infrastructure?: {
      modules?: number;
      configs?: number;
      utilities?: number;
    };
  };
  api_surface?: {
    total_endpoints: number;
    by_auth: {
      authenticated: number;
      public: number;
    };
    by_method: Record<string, number>;
  };
  external_dependencies?: {
    databases?: Array<{
      type: string;
      via?: string;
      entities?: number;
    }>;
    caches?: Array<{
      type: string;
      used_for?: string[];
    }>;
    ai_services?: Array<{
      name: string;
      models?: string[];
    }>;
    external_apis?: Array<{
      name: string;
      purpose?: string;
    }>;
  };
  security?: {
    auth_strategy?: string;
    protected_endpoints?: number;
    oauth_providers?: string[];
    guards?: string[];
  };
}

export interface CASArchitecturalPatternSummary {
  name: string;
  category: 'application-architecture' | 'presentation' | 'business-logic' | 'data-access' | 'integration' | 'object-lifecycle' | 'anti-pattern';
  confidence: number;
  evidence: string[];
  node_ids: string[];
  guidance: string;
}

export interface CASArchitecturalInventory {
  models: string[];
  views: string[];
  controllers: string[];
  view_models: string[];
  services: string[];
  repositories: string[];
  clients: string[];
  mediators: string[];
  unit_of_work: string[];
  singletons: string[];
  scripts: string[];
  packages: string[];
}

export interface CASPatternBalance {
  status: 'balanced' | 'under-patterned' | 'over-patterned' | 'mixed';
  detected_count: number;
  primary_patterns?: string[];
  conflicting_patterns?: string[];
  rationale?: string;
  risks: string[];
  recommendations: string[];
}

export interface CASSystemHealth {
  score: number;
  status: 'healthy' | 'watch' | 'at-risk' | 'critical';
  summary: string;
  risk_areas: CASSystemHealthRiskArea[];
  coherence: {
    status: 'coherent' | 'mixed' | 'drifting' | 'fragmented';
    paradigm_count: number;
    primary_paradigms: string[];
    conflicting_paradigms: string[];
    naming_convention_violations: number;
    dependency_injection_violations: number;
    module_boundary_violations: number;
    duplication_signals: number;
  };
  remediation: {
    immediate: string[];
    agent_rules: string[];
    validation_tools: string[];
  };
}

export interface CASSystemHealthRiskArea {
  id: string;
  type:
    | 'complexity'
    | 'duplication'
    | 'paradigm-drift'
    | 'naming-drift'
    | 'dependency-injection-drift'
    | 'module-boundary-drift'
    | 'implementation-gap'
    | 'test-gap'
    | 'runtime-coverage-gap'
    | 'pattern-balance';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  affected_files?: string[];
  affected_nodes?: string[];
  evidence: string[];
  recommendation: string;
  agent_guidance: string;
}

export interface CASRouteTableEntry {
  method: string;
  path: string;
  controller: string;
  handler: string;
  auth: boolean;
  guards?: string[];
  middleware?: string[];
  source_node?: string;
  description?: string;
}

export interface CASDatabaseSchema {
  orm?: string;
  entities: CASDatabaseEntity[];
  relationships_summary: string[];
}

export interface CASDatabaseEntity {
  name: string;
  table?: string;
  source_file?: string;
  source_files?: string[];
  fields: CASDatabaseField[];
  relationships: CASDatabaseRelationship[];
}

export interface CASDatabaseField {
  name: string;
  type: string;
  primary?: boolean;
  unique?: boolean;
  nullable?: boolean;
  default?: string;
  column?: string;
  type_variants?: string[];
}

export interface CASDatabaseRelationship {
  type: 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany';
  target: string;
  field: string;
  inverse_field?: string;
  join_table?: string;
}

export interface CASDecorator {
  id: string;
  target_node: string;

  decorator_info: {
    name: string;
    type: 'method' | 'class' | 'property' | 'parameter';
    framework: string;
    source_location: {
      file: string;
      line: number;
      column: number;
    };
  };

  semantic_meaning: {
    category: 'routing' | 'validation' | 'security' | 'lifecycle' | 'injection' | 'configuration' | 'other';
    behavior: string;
    affects_runtime: boolean;
  };

  parameters?: Array<{
    name: string;
    value: any;
    type: string;
  }>;

  routing_info?: {
    method: string;
    path: string;
    parameters: string[];
    guards?: string[];
    middleware?: string[];
  };

  security_info?: {
    authentication_required: boolean;
    roles?: string[];
    permissions?: string[];
  };

  metadata?: Record<string, any>;
}

export interface Dependencies {
  manager: string;
  lock_file?: string;
  packages: Array<{
    name: string;
    version: string;
    direct: boolean;
    license?: string;
    repository?: string;
    vulnerabilities?: string[];
  }>;
}

export interface DisclosureHints {
  default_perspective?: string;
  important_nodes?: string[];
  suggested_paths?: Array<{
    name: string;
    description?: string;
    nodes: string[];
  }>;
  summaries?: Array<{
    level: number;
    node_count: number;
    perspective: string;
    description?: string;
  }>;
}

export interface CASDocumentationSummary {
  total_documented_nodes: number;
  documentation_coverage: number;

  by_type: {
    functions: { documented: number; total: number; coverage: number };
    classes: { documented: number; total: number; coverage: number };
    interfaces: { documented: number; total: number; coverage: number };
    modules: { documented: number; total: number; coverage: number };
  };

  by_documentation_type: Record<string, number>;

  quality_metrics: {
    average_description_length: number;
    parameters_documented: number;
    returns_documented: number;
    examples_provided: number;
    deprecated_items: number;
  };

  missing_documentation: Array<{
    node_id: string;
    node_name: string;
    node_type: string;
    importance: 'low' | 'medium' | 'high';
    reason: string;
  }>;
}

export interface CASTodoSummary {
  total_todos: number;
  total_fixmes: number;
  total_hacks: number;
  total_warnings: number;

  by_priority: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };

  by_category: Record<string, number>;

  technical_debt_items: number;
  blocking_items: number;

  hotspots: Array<{
    file: string;
    todo_count: number;
    types: string[];
  }>;

  age_analysis?: {
    old_todos: Array<{
      id: string;
      age_days?: number;
      text: string;
    }>;
  };
}

export interface CASImplementationHealth {
  complete_implementations: number;
  partial_implementations: number;
  stubs: number;
  not_implemented: number;
  deprecated: number;
  experimental: number;

  health_score: number;

  risk_areas: Array<{
    node_id: string;
    node_name: string;
    risk_type: 'incomplete' | 'deprecated' | 'unstable' | 'high-todo-density';
    risk_level: 'low' | 'medium' | 'high';
    recommendation: string;
  }>;

  deprecation_timeline?: Array<{
    node_id: string;
    node_name: string;
    deprecated_since: string;
    removal_version?: string;
  }>;
}



export interface TestMetadata {
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance' | 'performance' | 'visual' | 'smoke' | 'bdd';
  test_style: 'procedural' | 'bdd' | 'property-based' | 'snapshot' | 'parameterized';
  priority?: 'critical' | 'high' | 'medium' | 'low';
  tags?: string[];
  uses_mocks: boolean;
  is_async: boolean;
  timeout_ms?: number;
  framework: string;

  bdd_context?: {
    feature?: string;
    scenario?: string;
    given?: string[];
    when?: string[];
    then?: string[];
  };

  parameterization?: {
    data_source: 'inline' | 'fixture' | 'external';
    parameter_count: number;
    cases: number;
  };
}

export interface CASTestSuite {
  id: string;
  name: string;
  file_path: string;
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance';
  framework: string;

  tests: CASTestCase[];
  hooks?: CASTestHook[];
  fixtures?: string[];
  mocks?: string[];

  coverage?: {
    nodes_tested: string[];
    coverage_percentage?: number;
  };

  metadata?: {
    parallel?: boolean;
    timeout_ms?: number;
    retries?: number;
    skip_reason?: string;
  };
}

export interface CASTestCase {
  id: string;
  name: string;
  description?: string;
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance' | 'bdd';

  assertions?: CASAssertion[];
  mocks_used?: string[];
  targets?: string[];

  bdd_steps?: Array<{
    type: 'given' | 'when' | 'then' | 'and' | 'but';
    text: string;
    implementation_id?: string;
  }>;

  parameterized?: {
    parameters: Array<{ name: string; values: any[] }>;
    case_count: number;
  };

  status: {
    skipped: boolean;
    focused: boolean;
    flaky: boolean;
  };

  source?: {
    file: string;
    line: number;
    end_line?: number;
  };
}

export interface CASTestHook {
  id: string;
  type: 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach' | 'setup' | 'teardown';
  name?: string;
  source?: {
    file: string;
    line: number;
  };
}

export interface CASAssertion {
  id: string;
  type: 'equality' | 'truthiness' | 'exception' | 'mock-call' | 'snapshot' | 'type-check' | 'custom';
  description?: string;
  target?: string;
  expected_value?: string;
  source?: {
    file: string;
    line: number;
  };
}

export interface CASMock {
  id: string;
  name: string;
  type: 'mock' | 'stub' | 'spy' | 'fake';
  target_node?: string;
  framework: string;

  implementation?: {
    return_value?: string;
    implementation_fn?: string;
    call_tracking: boolean;
  };

  used_by?: string[];
}

export interface CASFixture {
  id: string;
  name: string;
  type: 'factory' | 'fixture' | 'builder' | 'seed-data';
  file_path: string;

  generates?: string;
  dependencies?: string[];
  used_by?: string[];
}

export interface CASNodeTestCoverage {
  covered: boolean;
  coverage_percentage?: number;
  tested_by?: string[];
  untested_branches?: Array<{
    line: number;
    condition: string;
  }>;
}

export interface CASTestSummary {
  total_tests: number;
  by_type: {
    unit: number;
    integration: number;
    e2e: number;
    acceptance: number;
    bdd: number;
    other: number;
  };
  by_status: {
    passing: number;
    failing: number;
    skipped: number;
    flaky: number;
    unknown?: number;
  };
  execution?: { status: 'not-run' | 'partial' | 'observed'; source: 'static-analysis' | 'runtime'; observed_tests: number; note?: string };
  coverage: {
    status?: 'measured' | 'not-measured';
    overall_percentage?: number;
    by_layer?: Record<string, number>;
  };
  mocks: {
    total: number;
    by_target_type?: Record<string, number>;
  };
  fixtures: {
    total: number;
    factories?: number;
    seed_data?: number;
  };
}



export interface CASIntent {
  node_id: string;
  inferred_purpose?: string;
  inferred_constraints?: string[];
  architectural_decision?: {
    decision: string;
    rationale?: string;
    evidence: IntentEvidence[];
  };
  workaround_indicator?: {
    is_workaround: boolean;
    workaround_for?: string;
    expected_resolution?: string;
  };
  confidence: 'high' | 'medium' | 'low';
}

export interface IntentEvidence {
  type: 'commit_message' | 'pr_description' | 'code_comment' |
        'pattern_deviation' | 'naming_convention';
  source: string;
  excerpt: string;
  confidence_contribution: number;
}



export interface CASFlowSummary {
  total_critical_flows: number;
  by_criticality: Record<string, number>;
  untested_critical_flows: string[];
  high_error_rate_flows: string[];
}



export interface CASChangeRisk {
  node_id: string;
  risk_level: 'critical' | 'high' | 'medium' | 'low';
  risk_factors: ChangeRiskFactor[];

  downstream_impact: {
    direct_callers: string[];
    transitive_callers: string[];
    affected_call_chains: string[];
    affected_entry_points: string[];
  };

  test_protection: {
    has_direct_tests: boolean;
    has_integration_tests: boolean;
    test_ids?: string[];
    untested_callers?: string[];
  };

  stability_context: {
    recent_churn: boolean;
    commit_count_30d: number;
    bug_fix_density: number;
    last_refactor?: string;
  } & CASHistoryPercentiles;

  recommendations?: string[];
}

export interface ChangeRiskFactor {
  factor: 'many-callers' | 'critical-path' | 'high-traffic' |
          'no-tests' | 'recent-bugs' | 'complex-logic' |
          'external-dependency' | 'security-sensitive';
  severity: 'high' | 'medium' | 'low';
  details: string;
}

export interface CASChangeRiskSummary {
  high_risk_nodes: string[];
  untested_critical_paths: string[];
  recent_hotspots: string[];
}



export interface CASDescriptionGeneration {
  status:
    | 'deterministic_initial'
    | 'deterministic_kept'
    | 'ai_applied'
    | 'ai_rejected'
    | 'ai_skipped'
    | 'ai_failed'
    | 'reused_previous';
  attempted: boolean;
  reason?: string;
  budget_ms?: number;
  generated_at?: string;
  validation_version?: number;


  origin_source?: 'deterministic' | 'ai' | 'manual';





  may_be_stale?: boolean;
}










export interface CASEntityDescriptionCoverage {

  total: number;


  described: number;



  attempted: number;


  budget_ms: number;


  batch_size: number;



  priority_ordered: boolean;


  stopped_reason?: string;
}

export interface CASAnalysisPhase {
  id: string;
  name: string;
  priority: number;
  status: 'complete' | 'partial' | 'failed' | 'skipped' | 'deferred';
  purpose: 'visualization' | 'agent-development' | 'deep-context' | 'comprehension' | 'runtime';
  default_phase: boolean;
  description: string;
  outputs: string[];
  agent_value: string;
  visualization_value: string;
  can_run_later: boolean;
  requires_ai?: boolean;
  generated_at?: string;
  notes?: string[];




  started_at?: string;



  duration_ms?: number;
}









export interface CASAnalysisTimings {



  total_ms: number;


  cpu_total_ms?: number;
  cpu_user_ms?: number;
  cpu_system_ms?: number;


  average_cpu_cores?: number;





  stages?: Record<string, number>;



  cpu_stages?: Record<string, number>;


  analyzers?: Record<string, number>;
}


















export type CASDataEntityKind =
  | 'persisted-entity'
  | 'api-response'
  | 'request-dto'
  | 'domain-shape'
  | 'value-object';

export interface CASDataEntity {
  id: string;
  name: string;
  schema_source?: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;





  kind?: CASDataEntityKind;






  kind_source?: 'framework-evidence' | 'shape-inference';






  kind_evidence?: string;

  fields?: Array<{
    name: string;
    type: string;
    is_sensitive: boolean;
    validation?: string[];







    is_relation?: boolean;
  }>;

  lifecycle: {
    created_by: string[];
    read_by: string[];
    updated_by: string[];
    deleted_by: string[];
  };












  relations?: Array<{
    target_name: string;
    relation_type: string;
    kind: 'data' | 'structural';
    cardinality?: '1:1' | '1:N' | 'N:1' | 'N:M';
    field?: string;
    inverse_field?: string;
    owning?: boolean;
    join_table?: string;
    evidence_source: 'orm-edge' | 'orm-declaration' | 'typed-composition' | 'structural-edge';
    evidence: string;
  }>;

  transformations?: Array<{
    from_node: string;
    to_node: string;
    transformation_type: 'map' | 'filter' | 'aggregate' |
                         'enrich' | 'validate' | 'sanitize';
  }>;

  invariants?: Array<{
    description: string;
    enforced_by: string[];
    source: 'validation' | 'constraint' | 'test' | 'assertion';
  }>;
}

export interface CASDataSummary {
  entities: CASDataEntity[];
  sensitive_data_nodes: string[];
  validation_gaps: Array<{
    entity_id: string;
    missing_validation: string;
  }>;
}



export interface CASBehavioralInvariant {
  id: string;
  name: string;
  invariant_type: 'tenant-scope' | 'auth-boundary' | 'authorization' |
                  'db-constraint' | 'migration-contract' | 'test-coverage' |
                  'data-lifecycle' | 'business-rule';
  description: string;
  scope: {
    node_ids?: string[];
    entry_point_ids?: string[];
    entity_names?: string[];
    field_names?: string[];
    file_paths?: string[];
  };
  enforcement: Array<{
    source: 'code' | 'decorator' | 'database-schema' | 'migration' |
            'test' | 'configuration' | 'security-boundary' | 'naming';
    mechanism: string;
    confidence: 'enforced' | 'inferred' | 'missing';
    node_id?: string;
    file?: string;
    line?: number;
  }>;
  evidence: Array<{
    source: 'node' | 'entry_point' | 'database_schema' | 'security_boundary' |
            'test_suite' | 'migration_file' | 'source_file';
    id?: string;
    file?: string;
    line?: number;
    excerpt?: string;
  }>;
  related_tests?: string[];
  related_boundaries?: string[];
  related_entities?: string[];
  gaps?: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface CASBehavioralInvariantSummary {
  total: number;
  by_type: Record<string, number>;
  by_confidence: Record<string, number>;
  by_gap_severity?: Record<'high' | 'medium' | 'low', number>;
  enforced: number;
  inferred: number;
  missing: number;
  gaps: Array<{
    invariant_id: string;
    gap: string;
    severity: 'high' | 'medium' | 'low';
  }>;
}



export interface CASSecurityBoundary {
  id: string;
  name: string;
  boundary_type: 'authentication' | 'authorization' | 'input-validation' |
                 'output-encoding' | 'rate-limiting' | 'encryption' | 'tenant-isolation';

  enforcement_points: Array<{
    node_id: string;
    mechanism: string;
    confidence: 'enforced' | 'assumed' | 'missing';
  }>;

  trust_transition: {
    from_trust_level: 'untrusted' | 'partially-trusted' | 'trusted';
    to_trust_level: 'untrusted' | 'partially-trusted' | 'trusted';
  };

  sensitive_operations: string[];
  bypass_risks?: string[];
}

export interface CASSecuritySummary {
  boundaries: CASSecurityBoundary[];
  unprotected_sensitive_ops: string[];
  assumed_vs_enforced: {
    enforced: number;
    assumed: number;
    missing: number;
  };
}



export interface CASFlowCoverage {
  call_chain_id: string;
  call_chain_name?: string;

  coverage_status: 'fully-covered' | 'partially-covered' | 'not-covered';
  coverage_percentage?: number;

  tested_segments: Array<{
    node_id: string;
    test_ids: string[];
    assertion_count: number;
  }>;

  untested_segments: Array<{
    node_id: string;
    importance: 'critical' | 'high' | 'medium' | 'low';
    reason: string;
  }>;

  test_quality: {
    has_unit_tests: boolean;
    has_integration_tests: boolean;
    has_e2e_tests: boolean;
    uses_mocks: boolean;
    mock_targets?: string[];
  };
}

export interface CASTestGap {
  gap_type: 'untested-flow' | 'untested-branch' | 'mock-only' | 'no-assertions';
  title?: string;
  description?: string;
  location: {
    node_id?: string;
    call_chain_id?: string;
    line?: number;
  };
  severity: 'critical' | 'high' | 'medium' | 'low';
  recommendation: string;
}



export interface CASTemporalStability {
  node_id: string;

  stability_score: number;
  stability_class: 'stable' | 'evolving' | 'volatile' | 'fragile';

  churn_metrics: {
    commits_30d: number;
    commits_90d: number;
    unique_authors_30d: number;
    lines_changed_30d: number;
  };

  quality_signals: {
    bug_fix_rate: number;
    refactor_frequency: 'frequent' | 'occasional' | 'rare';
    has_recent_regression: boolean;
  } & CASHistoryPercentiles & { bug_fix_commits?: number };

  age_context: {
    file_age_days: number;
    last_major_change?: string;
    is_legacy: boolean;
  };

  risk_correlation?: {
    high_churn_high_bugs: boolean;
    recent_refactor_unstable: boolean;
  };
}

export interface CASStabilitySummary {
  by_stability_class: Record<string, number>;
  hotspots: Array<{
    node_id: string;
    reason: string;
  }>;
  legacy_areas: string[];
}



export interface SystemCapability {
  id: string;
  name: string;










  name_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  name_generation?: CASDescriptionGeneration;







  structural_label?: string;
  description: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  category: 'core' | 'supporting' | 'admin' | 'internal';

  operations: Array<{
    entry_point_id: string;
    entry_point_type: string;
    action: string;
    path_or_command?: string;





    trigger?: { method?: string; path?: string };
  }>;

  related_entities: string[];
  related_domains: string[];
  criticality: 'critical' | 'high' | 'medium' | 'low';
  criticality_factors: string[];
  confidence?: number;
  unsettled?: string;
  composition_provenance?: CASComposedClaimProvenance[];
  parent_originated?: { kind: 'seam' | 'orphan'; evidence: string[] };





  evidence_kind?: 'behavior-surface' | 'infrastructure';
  evidence_role?: 'product-outcome' | 'supporting-mechanism' | 'verification-harness' | 'unresolved';
  evidence_role_reasons?: string[];













  evidence_examples?: string[];
  operation_evidence?: Array<{
    entry_point_id: string;
    source_node_id: string;
    text: string;
  }>;








  related_flows?: Array<{ flow_id: string; role: CapabilityFlowRole; rationale: string }>;
























  depends_on?: CASCapabilityDependency[];



  depended_by?: string[];
}

export interface SystemPurpose {
  primary_type: string;
  confidence: number;
  evidence: string[];
  secondary_types?: string[];
}

export interface CASEntryPointFlowStep {
  node_id: string;
  name: string;
  layer: 'entry' | 'business' | 'data' | 'infrastructure';
  depth: number;
}

export interface CASEntryPointFlowTerminalEntity {
  entity_id?: string;
  name: string;
  access: 'created' | 'updated' | 'deleted' | 'read';
  node_id?: string;
  terminal_kind: 'entity' | 'node';
}






export type CASGuardKind = 'authentication' | 'authorization' | 'rate-limiting' | 'validation' | 'unknown';

export interface CASEntryPointFlow {
  id: string;
  name: string;
  flow_kind: 'user-facing' | 'system' | 'scheduled';
  entry_point_id: string;
  entry: {
    type: string;
    name: string;
    method?: string;
    path_or_trigger?: string;
    handler_node_id?: string;
  };
  steps: CASEntryPointFlowStep[];
  terminal_effects: {
    entities_written: string[];
    entities_read: string[];
    external_services: string[];
    messages_emitted: string[];
  };
  terminal_entities: CASEntryPointFlowTerminalEntity[];
  security_boundaries: Array<{
    node_id?: string;
    name: string;
    mechanism: string;
    kind?: CASGuardKind;
  }>;
  tests_covering: string[];
  risk?: 'low' | 'medium' | 'high' | 'critical';
  criticality: 'critical' | 'high' | 'medium' | 'low';
  call_chain_ids: string[];
  exit_point_ids: string[];
  unresolved_exit_point_ids?: string[];
  unshipped?: string;








  derived_from_flow_id?: string;













  capability_relationships?: Array<{
    capability_id: string;
    role: CapabilityFlowRole;
    rationale: string;
    evidence?: string;
  }>;
}

export interface CASEntryPointFlowSummary {
  total_discovered: number;
  included: number;
  by_kind: {
    'user-facing': number;
    system: number;
    scheduled: number;
  };
}

export interface CASEntityLineageAccessor {
  node_id: string;
  file?: string;
  via: string;
}

export interface CASEntityLineageExternalRecipient {
  exit_point_id: string;
  service: string;
  via_node?: string;
}

export interface CASEntityLineageBoundary {
  boundary: string;
  guarded: boolean;
  guard_kinds?: CASGuardKind[];
}

export interface CASEntityLineage {
  entity_id: string;
  entity_name: string;
  sensitive_fields: string[];
  writers: CASEntityLineageAccessor[];
  readers: CASEntityLineageAccessor[];
  external_recipients: CASEntityLineageExternalRecipient[];
  unresolved_exit_point_ids?: string[];
  boundaries_crossed: CASEntityLineageBoundary[];
  entry_point_flows_carrying: string[];
  exposure: {
    unguarded_paths: number;
    non_auth_guarded_paths?: number;
    external_transfer: boolean;
    external_transfer_unresolved?: boolean;
    sensitive: boolean;
  };
}

export interface CASBehaviorDiffEntryPointFlow {
  id: string;
  name: string;
  entry: string;
  entities_written: string[];
  guarded: boolean;
}

export interface CASBehaviorDiffEntryPointFlowChange {
  id: string;
  name: string;
  what: string[];
}

export interface CASBehaviorDiffJourney {
  id: string;
  label: string;
  does: string;
  steps: number;
}

export interface CASBehaviorDiffJourneyChange {
  id: string;
  label: string;
  what: string[];
}

export interface CASBehaviorDiffUnguardedEntry {
  entry_point_flow_id: string;
  name: string;
  entry: string;
  entities_written: string[];
  reason: 'lost-guard' | 'new-unguarded';
}

export interface CASBehaviorDiffCapabilityOverlap {
  new_capability: string;
  overlaps_with: string;
  shared_entities: string[];
  shared_name_tokens: string[];
}

export interface CASBehaviorDiffParadigmDeviation {
  paradigm: string;
  file: string;
  kind: string;
  detail: string;
  severity: 'info' | 'warning' | 'error';
}

export interface CASBehaviorDiff {
  entry_point_flows: {
    added: CASBehaviorDiffEntryPointFlow[];
    removed: CASBehaviorDiffEntryPointFlow[];
    changed: CASBehaviorDiffEntryPointFlowChange[];
  };
  journeys: {
    added: CASBehaviorDiffJourney[];
    removed: CASBehaviorDiffJourney[];
    changed: CASBehaviorDiffJourneyChange[];
  };
  security: {
    boundaries_added: string[];
    boundaries_removed: string[];
    newly_unguarded_entries: CASBehaviorDiffUnguardedEntry[];
  };
  capabilities: {
    added: Array<{ id: string; name: string }>;
    removed: Array<{ id: string; name: string }>;
    possibly_duplicated: CASBehaviorDiffCapabilityOverlap[];
  };
  lineage: {
    entities_with_new_writers: Array<{ entity_name: string; new_writers: string[] }>;
    sensitive_exposure_changes: Array<{ entity_name: string; change: string }>;
  };
  paradigms: {
    new_deviations: CASBehaviorDiffParadigmDeviation[];
    resolved_deviations: Array<{ paradigm: string; file: string; kind: string }>;
  };
  summary: {
    risk_flags: string[];
  };
}

export interface CASDomainConcept {
  id: string;
  name: string;






  frequency: number;
  appears_in: {
    entry_points: string[];
    entities: string[];
    nodes: string[];
  };
  classification: 'core' | 'supporting' | 'infrastructure';





  description?: string;





  distinctiveness?: number;








  distinctiveness_evidence?: string[];
}

export type CASArtifactType = 'app' | 'library' | 'client-sdk' | 'cli-tool' | 'boilerplate' | 'infrastructure';


export interface EnhancedSystemPurpose extends SystemPurpose {
  primary_domain: string;
  domain_source?: 'deterministic' | 'ai' | 'ai-refined' | 'reused';
  first_party_product_evidence?: CASFirstPartyProductEvidence;
  domain_anchored?: boolean;
  domain_rejected_candidates?: Array<{ label: string; reason: string }>;
  capability_description_degradations?: Array<{
    id: string;
    name: string;
    reason: string;





    failure_class: 'provider-unavailable' | 'failed-grounding';
  }>;











  capability_name_degradations?: Array<{
    id: string;

    name: string;

    rejected_name: string;
    reason: 'name-derived-from-source-path';
    disposition: 'rebuilt-from-evidence' | 'dropped';
  }>;






















  description_capability_gaps?: Array<{
    entity_id: string;
    entity_name: string;
    disposition: 'structural-evidence-only' | 'no-structural-candidate';
    capability_id?: string;
  }>;






  capability_naming_coverage?: {
    total: number;
    authored: number;
    un_enriched: number;
    path_derived_rejected: number;
  };
  capability_catalog_coverage?: {
    evidence_families: number;
    product_evidence_candidates?: number;
    supporting_evidence_candidates?: number;
    verification_evidence_candidates?: number;
    unresolved_evidence_candidates?: number;
    candidate_dispositions?: Array<{ candidate_id: string; role: NonNullable<SystemCapability['evidence_role']>; reasons: string[] }>;
    actual_publishable_capabilities?: number;
    published_capabilities: number;
    status: 'accepted' | 'partial' | 'rejected' | 'unavailable';
    reason?: string;
  };
  capability_reconciliation?: {
    unverified_declarations?: Array<{
      role: 'feature';
      value: string;
      source: string;
      reason: 'no-corroborating-candidate';
    }>;
    proposals: Array<{
      requirement_id: string;
      statement: string;
      first_party_outcome_text?: string;
      audience?: 'agent' | 'human';
      candidate_ids: string[];
      disposition: 'grounded' | 'intent-gap';
      capability_ids: string[];
    }>;
    undocumented_capabilities: Array<{
      capability_id: string;
      name: string;
    }>;
    structural_gaps?: Array<{
      candidate_id: string;
      name: string;
      reason: string;
    }>;
  };


  artifact_type?: CASArtifactType;
  secondary_domains?: Array<{ domain: string; areas: string[]; node_share: number }>;
  core_concepts: string[];
  inferred_description: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;


























  system_description_degradation?: {
    reason: string;



    failure_class: 'provider-unavailable' | 'failed-grounding';
  };




  ai_input_fingerprint?: string;
  primary_workflow_id?: string;
  supporting_workflow_ids: string[];




  entity_description_coverage?: CASEntityDescriptionCoverage;

  ai_phase_status?: 'complete' | 'degraded';
}

export interface CASCapability {
  id: string;
  name: string;
  description: string;

  entry_points: string[];
  entry_point_summary: {
    types: string[];
    count: number;
    primary_type: string;
  };

  operations: CASOperation[];
  operation_patterns: ('crud' | 'transform' | 'query' | 'command' | 'event' | 'pipeline')[];

  entities_touched?: string[];
  services_used: string[];
  exit_points: string[];

  call_chain_ids: string[];
  complexity_profile: {
    avg_depth: number;
    max_depth: number;
    has_external_calls: boolean;
    has_database_calls: boolean;
    has_async_calls: boolean;
    branching_factor: number;
  };

  classification: 'primary' | 'supporting' | 'infrastructure';
  criticality: 'critical' | 'high' | 'medium' | 'low';

  signals: {
    domain_concept_score: number;
    centrality_score: number;
    coverage_score: number;
    complexity_score: number;
    total_score: number;
  };

  depends_on: CASCapabilityDependency[];
  depended_by: string[];
}

export interface CASOperation {
  id: string;
  name: string;
  pattern: 'create' | 'read' | 'update' | 'delete' | 'action' | 'query' | 'transform';

  entry_point_id?: string;
  call_chain_ids: string[];
  implementing_nodes: string[];

  trigger?: {
    type: string;
    method?: string;
    path?: string;
    command?: string;
    event_name?: string;
  };
}

export interface CASCapabilityDependency {
  from_capability: string;
  to_capability: string;

  dependency_type: 'requires' | 'uses' | 'shares-data' | 'triggers' | 'cascade';
  strength: 'required' | 'common' | 'optional';

  evidence: {
    shared_services: string[];
    shared_entities?: string[];
    shared_nodes: string[];
    call_count?: number;
  };

  description: string;
}

export const CONTRACT_MODEL_NAME = 'ICELOT';

export const UNDERSTANDING_CONTRACT_FACETS = [
  'input',
  'constraints',
  'system_effects',
  'logic',
  'output',
  'telemetry',
] as const;

export type UnderstandingContractFacet = (typeof UNDERSTANDING_CONTRACT_FACETS)[number];

export type ConstraintKind =
  | 'validation'
  | 'auth'
  | 'rate-limit'
  | 'error'
  | 'invariant'
  | 'business-rule'
  | 'consistency';

export interface FacetConstraint {
  kind: ConstraintKind;
  rule: string;
  evidence: string;
}

export interface ContractTelemetry {
  static_id: string;
  request_count: number;
  error_rate: number;
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  status_code_distribution?: Record<string, number>;
  source: string;
  last_seen?: string;
}

export interface LogicSummary {
  text: string;
  description_source: 'ai';
  evidence_refs: string[];
}

export type ProvenanceFacet =
  | 'input'
  | 'logic'
  | 'output'
  | 'state_change'
  | 'external_integration'
  | 'constraint'
  | 'telemetry';

export interface FacetProvenance {
  facet: ProvenanceFacet;
  value: string;
  contributed_by_step_ids?: string[];
  contributed_by_node_ids?: string[];
  source: 'deterministic';
  evidence: string;
}

export type ICELOTAbstentionReason =
  'no-source-evidence' | 'interpretation-not-requested' | 'no-runtime-observation';

export interface ICELOTContract {
  input: string[];
  logic: string;
  side_effects: {
    state_changes: string[];
    external_integrations: string[];
    unresolved_exit_point_ids?: string[];
  };
  output: string[];
  constraints: FacetConstraint[];
  telemetry?: ContractTelemetry;
  facet_provenance?: FacetProvenance[];
  logic_summary?: LogicSummary;
  facet_abstentions?: Partial<Record<UnderstandingContractFacet, ICELOTAbstentionReason>>;
}

export interface FlowICELOTContract extends ICELOTContract {
  internal_inputs_count?: number;
  internal_outputs_count?: number;
}

export type StepCodeRelationship =
  | 'implements'
  | 'partially_implements'
  | 'initiates'
  | 'completes'
  | 'validates'
  | 'branches'
  | 'transforms'
  | 'causes_effect'
  | 'observes'
  | 'handles_failure'
  | 'provides_input'
  | 'consumes_output';

export interface StepCodeRegion {
  node_id: string;
  file?: string;
  line_range?: [number, number];
}

export interface StepCodeSubSegment {
  label: string;
  line_range: [number, number];
  description_source: 'ai';
  evidence_refs: string[];
}

export interface StepCodeMapping {
  step_id: string;
  code_region: StepCodeRegion;
  relationship: StepCodeRelationship;
  contribution: string;
  confidence: number;
  sub_segments?: StepCodeSubSegment[];
}

export interface FlowStep {
  step_id: string;
  order: number;
  name: string;
  description: string;
  description_source: 'deterministic-label' | 'ai';
  contract: ICELOTContract;
  functions: Array<{
    function_id: string;
    section?: { start_line: number; end_line: number; label?: string };
  }>;
  entities: string[];
  code_mappings?: StepCodeMapping[];
  code_mappings_truncated?: number;
}

export type CapabilityFlowRole =
  | 'primary'
  | 'supporting'
  | 'prerequisite'
  | 'operational'
  | 'recovery'
  | 'observability';

export interface CapabilityFlowRelationship {
  capability_id: string;
  role: CapabilityFlowRole;
  rationale: string;
  evidence?: 'operation' | 'interior-step' | 'route' | 'entity-overlap' | 'entity-lineage' | 'surface-membership';
}

export type FlowEdgeKind = 'sequence' | 'branch' | 'error' | 'compensation';

export interface FlowStepEdge {
  from_step_id: string;
  to_step_id: string;
  kind: FlowEdgeKind;
  evidence?: string;
}

export interface FlowStepGraph {
  edges: FlowStepEdge[];
}

export interface FlowEffect {
  exit_point_id: string;
  kind: string;
  produces: string;
  node_id: string;
  hops?: number;
  via_shared_helper?: boolean;
}

export interface FlowConcept {
  flow_id: string;
  name: string;
  intent: string;
  description?: string;
  description_source?: 'ai';
  entry_point: string;
  standing?: string;
  confidence?: number;
  unsettled?: string;
  open?: number;
  cut?: boolean;
  capability_id?: string;
  capability_relationships?: CapabilityFlowRelationship[];
  entities: string[];
  contract: FlowICELOTContract;
  steps: FlowStep[];
  terminus?: FlowEffect;
  effects?: FlowEffect[];
  criticality?: 'critical' | 'high' | 'medium' | 'low';
  step_graph?: FlowStepGraph;
  continuations?: string[];
  continued_from?: string[];
  is_subflow?: boolean;
  triggers?: string[];
  gaps?: string[];
}

export interface ComputeFlowConceptsOptions {
  maxDepth?: number;
  maxFunctionsPerFlow?: number;
  maxFlows?: number;
  offset?: number;
  target?: string;
  nameStep?: (step: FlowStep, ctx: { flowEntryPoint: CASEntryPoint }) => { name?: string; description?: string } | undefined;
}


export interface CASTerminalityMember {
  id: string;
  terminal: boolean;
  proximal_terminal: boolean;
  distance_to_terminal: number;
  incoming: number;
  outgoing: number;
  strongly_connected_size: number;
  composition_provenance?: CASTerminalityProvenance;
}

export interface CASTerminality {
  nodes: CASTerminalityMember[];
  entities: CASTerminalityMember[];
  flows: CASTerminalityMember[];
  capabilities: CASTerminalityMember[];
}

export interface CASFlowGraph {
  capability_candidates: CASCapability[];
  dependencies: CASCapabilityDependency[];
  topology: {
    root_capabilities: string[];
    leaf_capabilities: string[];
    critical_path: string[];
    max_depth: number;
  };

  primary_flow: {
    core_capability_id: string;
    value_chain: string[];
    supporting_capabilities: string[];
    infrastructure_capabilities: string[];
  };

  layers: CASFlowLayer[];

  system_insights: {
    detected_patterns: string[];
    primary_entry_type: string;
    data_flow_type: string;
  };
}



















export const CAS_VERSION = '3.0.0';

export interface CASFlowLayer {
  layer_number: number;
  layer_name: string;
  capabilities: string[];
  layer_type: 'entry' | 'business' | 'data' | 'infrastructure';
}





export const INCREMENTAL_STATE_VERSION = '1.0.0';
export const FULL_REBUILD_THRESHOLD = 0.50;

export interface IncrementalState {
  version: string;
  projectPath: string;
  lastFullAnalysis: string;
  lastAnalysisTimestamp: number;
  gitCommitHash?: string;
  files: Record<string, FileAnalysisRecord>;
  analyzerVersions: Record<string, string>;
  analyzerRegistryFingerprint?: string;
  config?: {
    rebuildThreshold?: number;
    watchDebounceMs?: number;
    maxPropagationDepth?: number;
  };
}

export interface FileAnalysisRecord {
  filePath: string;
  contentHash: string;
  mtimeMs: number;
  lastAnalyzed: string;
  analyzerId: string;
  nodeIds: string[];
  edgeIds: string[];
  entryPointIds: string[];
  exitPointIds: string[];
  importedFiles: string[];
  exportedSymbols: string[];
}

export interface FileAnalysisResult {
  filePath: string;
  contentHash: string;
  mtimeMs: number;
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  imports: string[];
  exports: string[];
}

export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  affectedFiles: string[];
  affectedNodeIds: Set<string>;
  requiresFullRebuild: boolean;
  reason?: string;
  detectionMethod: 'mtime' | 'git' | 'hash' | 'hybrid';
}

export interface ChangeHistoryEntry {
  id: string;
  timestamp: string;
  gitCommitHash?: string;
  gitCommitMessage?: string;
  author?: string;
  source: 'human' | 'ai' | 'automated' | 'unknown';
  aiSessionId?: string;
  aiProvider?: string;

  changes: {
    files: FileChange[];
    nodes: NodeChange[];
    edges: EdgeChange[];
    entryPoints: EntryPointChange[];
    exitPoints: ExitPointChange[];
  };

  semanticSummary?: string;
  intent: ChangeIntent;

  impact: ImpactAnalysis;
  suggestedActions: SuggestedAction[];
  breakingChanges: BreakingChange[];
  minimumTestSet: string[];
}

export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted' | 'renamed' | 'moved';
  oldPath?: string;
  linesAdded: number;
  linesRemoved: number;
  hunks?: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface NodeChange {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  file: string;
  changeType: 'added' | 'modified' | 'deleted' | 'moved' | 'renamed';
  oldNodeId?: string;
  semanticChange?: string;
  diff?: {
    before: string;
    after: string;
  };
}

export interface EdgeChange {
  edgeId: string;
  source: string;
  target: string;
  edgeType: string;
  changeType: 'added' | 'deleted' | 'modified';
}

export interface EntryPointChange {
  entryPointId: string;
  name: string;
  changeType: 'added' | 'deleted' | 'modified';
  details?: string;
}

export interface ExitPointChange {
  exitPointId: string;
  name: string;
  changeType: 'added' | 'deleted' | 'modified';
  details?: string;
}

export interface ChangeIntent {
  type: 'bug-fix' | 'feature' | 'refactor' | 'performance' | 'security' | 'docs' | 'test' | 'chore' | 'unknown';
  confidence: number;
  evidence: string[];
}

export interface SuggestedAction {
  type: 'run-test' | 'update-docs' | 'review-security' | 'update-api-version' | 'notify-consumers';
  priority: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  targets: string[];
}

export interface BreakingChange {
  type: 'signature-change' | 'removed-export' | 'renamed-export' | 'visibility-change' | 'type-change' | 'behavior-change';
  verdict?: 'breaking' | 'potentially-breaking' | 'non-breaking';
  nodeId: string;
  description: string;
  affectedConsumers: string[];
  consumers?: Array<{ id: string; name: string; file?: string; line?: number }>;
  suggestedMigration?: string;
}

export interface ImpactAnalysis {
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;

  affectedEntryPoints: Array<{
    id: string;
    name: string;
    path?: string;
    impactType: 'direct' | 'transitive';
    distance: number;
  }>;

  affectedCallChains: Array<{
    id: string;
    name?: string;
    criticality?: string;
    affectedNodes: string[];
  }>;

  affectedConsumers: Array<{
    nodeId: string;
    file: string;
    usageType: 'import' | 'call' | 'extend' | 'implement';
  }>;

  criticalPathsAffected: boolean;
  securitySensitive: boolean;
  dataFlowAffected: boolean;

  testCoverage: {
    directTests: string[];
    integrationTests: string[];
    uncoveredChanges: string[];
    suggestedTests: string[];
  };

  documentation: {
    affectedDocs: string[];
    outdatedComments: string[];
  };
}

export interface ChangeReport {
  timestamp: string;
  previousAnalysis: string;
  currentAnalysis: string;

  summary: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    nodesAdded: number;
    nodesModified: number;
    nodesDeleted: number;
    edgesAdded: number;
    edgesModified: number;
    edgesDeleted: number;
  };

  impact: ImpactAnalysis;
  semantic_impact?: ChangeSemanticImpact;
  locality?: ChangeExecutionLocality;

  details: {
    files?: FileChange[];
    addedNodes: Array<{ id: string; name: string; type: string; file: string }>;
    modifiedNodes: Array<{ id: string; name: string; type?: string; file?: string; changes: string[] }>;
    deletedNodes: Array<{ id: string; name: string; type: string; file?: string }>;
    addedEdges: Array<{ id?: string; source: string; target: string; type: string }>;
    deletedEdges: Array<{ id?: string; source: string; target: string; type: string }>;
    addedEntryPoints?: Array<{ id: string; name: string }>;
    modifiedEntryPoints?: Array<{ id: string; name: string; details?: string }>;
    deletedEntryPoints?: Array<{ id: string; name: string }>;
    addedExitPoints?: Array<{ id: string; name: string }>;
    deletedExitPoints?: Array<{ id: string; name: string }>;
  };

  changeHistory?: ChangeHistoryEntry[];
}

export interface ChangeExecutionLocality {
  strategy: 'no-change' | 'structural-noop' | 'localized-file-merge' | 'derived-layer-rebuild' | 'project-contribution-refresh' | 'full-rebuild';
  directChangedFiles: number;
  graphAffectedFiles: number;
  analyzedFiles: number;
  trackedFiles: number;
  reusedFiles: number;
  reuseRatio: number;
  affectedPackageRoots?: string[];
  affectedDeployableRoots?: string[];
  refreshedProjectAnalyzers?: string[];
  fullRebuildReason?: string;
}

export interface ChangeSemanticImpact {
  affected_entry_point_flows: Array<{ id: string; name: string; reason: string }>;
  affected_capabilities: Array<{ id: string; name: string; reason: string }>;
  affected_data_entities: Array<{ id: string; name: string; reason: string }>;
  affected_runtime_links: Array<{ id: string; runtime_signal: string; reason: string }>;
  changed_contracts: Array<{ id: string; type: 'entry-point' | 'exit-point' | 'repository-link'; name: string }>;
  risk_reasons: string[];
}

export interface AnalysisConfidence {
  overall: number;
  staleness: 'fresh' | 'recent' | 'stale' | 'very-stale';
  lastAnalysis: string;
  timeSinceAnalysis: number;

  perFile: Record<string, {
    confidence: number;
    reason: string;
  }>;

  perNode: Record<string, {
    confidence: number;
    factors: string[];
  }>;

  recommendations: Array<{
    action: 'reanalyze' | 'reanalyze-file' | 'reanalyze-module';
    target?: string;
    reason: string;
    priority: 'low' | 'medium' | 'high';
  }>;
}

export interface ContextBundle {
  tokenCount: number;
  priority: 'essential' | 'important' | 'supplementary';

  core: {
    targetNode: CASNode;
    signature?: string;
    documentation?: string;
    immediateContext?: string;
  };

  related?: {
    callers: CASNode[];
    callees: CASNode[];
    siblings: CASNode[];
  };

  patterns?: {
    appliedPatterns: string[];
    conventions: string[];
    antiPatterns: string[];
  };

  history?: {
    recentChanges: ChangeHistoryEntry[];
    changeVelocity: 'stable' | 'active' | 'volatile';
  };

  similar?: Array<{
    node: CASNode;
    similarity: number;
    reason: string;
  }>;

  truncated: boolean;
  omitted: string[];
}

export interface PreFlightAssessment {
  feasibility: 'safe' | 'caution' | 'risky' | 'dangerous';
  impact: ImpactAnalysis;

  conflicts: Array<{
    type: 'recent-change' | 'in-progress' | 'pattern-violation' | 'convention-violation';
    description: string;
    changeId?: string;
    severity: 'info' | 'warning' | 'error';
  }>;

  suggestions: Array<{
    type: 'use-existing' | 'follow-pattern' | 'consider-alternative' | 'update-related';
    description: string;
    reference?: string;
    code?: string;
  }>;

  requiredUpdates: Array<{
    file: string;
    nodeId?: string;
    reason: string;
    automated: boolean;
  }>;

  testStrategy: {
    existingTests: string[];
    newTestsNeeded: string[];
    suggestedTestPattern?: string;
  };

  estimatedEffort: 'trivial' | 'small' | 'medium' | 'large';
}

export interface MinimumTestSet {
  required: Array<{
    testId: string;
    testName: string;
    file: string;
    reason: string;
    coversNodes: string[];
  }>;

  recommended: Array<{
    testId: string;
    testName: string;
    reason: string;
    priority: number;
  }>;

  optional: Array<{
    testId: string;
    testName: string;
    reason: string;
  }>;

  coverage: {
    coveredNodes: string[];
    uncoveredNodes: string[];
    coveragePercent: number;
  };

  estimatedRunTime: number;
  fullSuiteRunTime: number;
  savingsPercent: number;
}

export interface AnalysisTimeline {
  entries: TimelineEntry[];
  span: { start: string; end: string };
  resolution: 'minute' | 'hour' | 'day' | 'week';
}

export interface TimelineEntry {
  timestamp: string;
  type: 'analysis' | 'change' | 'milestone';

  analysisId?: string;
  nodeCount?: number;
  duration?: number;

  changeId?: string;
  summary?: string;
  impactLevel?: 'low' | 'medium' | 'high';

  milestone?: 'release' | 'branch' | 'merge' | 'tag';
  label?: string;
}

export interface HeatMapData {
  type: 'churn' | 'bugs' | 'complexity' | 'coverage' | 'staleness';
  resolution: 'file' | 'module' | 'node';

  data: Array<{
    id: string;
    value: number;
    raw: number;
    label: string;
  }>;

  scale: {
    min: number;
    max: number;
    median: number;
  };

  hotSpots: Array<{
    id: string;
    value: number;
    reason: string;
  }>;
}

export interface ChangeAggregate {
  key: string;
  label: string;

  counts: {
    changes: number;
    filesChanged: number;
    nodesAdded: number;
    nodesModified: number;
    nodesDeleted: number;
    linesAdded: number;
    linesRemoved: number;
  };

  impact: {
    avgRisk: number;
    maxRisk: 'low' | 'medium' | 'high' | 'critical';
    criticalChanges: number;
  };

  trend: 'increasing' | 'stable' | 'decreasing';
  velocity: number;
}

export interface WatchStatus {
  watchId: string;
  projectPath: string;
  active: boolean;
  startedAt: string;
  lastEvent?: string;
  pendingChanges: number;
  analysisInProgress: boolean;
  error?: string;
}

export interface CrossRepoLink {
  id: string;
  sourceRepo: string;
  targetRepo: string;
  linkType: 'api-call' | 'shared-db' | 'message-queue' | 'import' | 'submodule';

  apiEndpoint?: string;
  apiConsumers?: string[];

  sharedTables?: string[];

  publishedMessages?: string[];
  consumedMessages?: string[];
}

export interface CrossRepoImpact {
  changeId: string;
  affectedRepos: Array<{
    repo: string;
    linkType: string;
    affectedNodes: string[];
    severity: 'info' | 'warning' | 'breaking';
  }>;
}

export interface AnalysisLockStatus {
  locked: boolean;
  holder?: {
    pid: number;
    startedAt: string;
    operation: string;
  };
  queuedOperations: number;
}








export interface CASIndexUnit {
  id: string;
  name: string;
  reached_nodes: number;
  entry_point_ids: string[];
  entry_point_kinds: Record<string, number>;
  root_paths: string[];
}

export interface DeployableEvidence {
  root_path: string;
  name: string;
  tier: 1 | 2 | 3;
  kind: 'container' | 'compose-service' | 'k8s' | 'serverless' | 'installer' | 'ci-deploy' | 'bin' | 'server-entry' | 'package' | 'build-image';
  evidence: string[];
  entry_files?: string[];
  ships_paths?: string[];
  ports?: number[];
  entrypoint_member?: string;
  capabilities?: string[];






  base_images?: string[];










  bundled_into?: string;
}
