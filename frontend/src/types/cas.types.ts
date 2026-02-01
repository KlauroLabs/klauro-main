// CAS v1.7.0 TypeScript interfaces

export interface CASOutput {
  cas_version: "1.7.0" | "1.6.0" | "1.5.0" | "1.4.0";
  analysis_timestamp: string;
  analysis_id: string;

  system: {
    id: string;
    name: string;
    root_path: string;
    type?: string;
    description?: string;
    metadata?: Record<string, any>;
  };

  nodes: CASNode[];
  edges: CASEdge[];
  entry_points: EntryPoint[];
  exit_points: ExitPoint[];
  external_services: ExternalService[];

  perspectives?: CASPerspective[];
  repository_links?: RepositoryLink[];
  dependencies?: Dependencies;
  disclosure?: DisclosureHints;
  analyzer_contributions: AnalyzerContribution[];

  method_calls?: CASMethodCall[];
  call_chains?: CASCallChain[];
  decorators?: CASDecorator[];

  documentation_summary?: CASDocumentationSummary;
  todos_summary?: CASTodoSummary;
  implementation_health?: CASImplementationHealth;

  patterns?: CASPattern[];

  // v1.6.0+ Test structures
  test_suites?: CASTestSuite[];
  mocks?: CASMock[];
  fixtures?: CASFixture[];
  test_summary?: CASTestSummary;

  // v1.7.0+ Inference-Based Intelligence
  intents?: CASIntent[];
  flow_summary?: CASFlowSummary;
  change_risks?: CASChangeRisk[];
  change_risk_summary?: CASChangeRiskSummary;
  data_entities?: CASDataEntity[];
  data_summary?: CASDataSummary;
  security_boundaries?: CASSecurityBoundary[];
  security_contexts?: CASSecurityContext[];
  security_summary?: CASSecuritySummary;
  flow_coverage?: CASFlowCoverage[];
  test_gaps?: CASTestGap[];
  temporal_stability?: CASTemporalStability[];
  stability_summary?: CASStabilitySummary;

  system_capabilities?: SystemCapability[];
  system_purpose?: SystemPurpose;

  flow_graph?: CASFlowGraph;

  metadata?: SystemMetadata;
}

export interface CASNode {
  id: string;
  name: string;
  tags: string[];
  type: string;
  parent?: string;

  perspectives?: {
    [perspectiveId: string]: {
      hierarchy: string[];
      level: number;
      priority: number;
      metadata?: Record<string, any>;
    }
  };

  analyzers?: string[];
  primaryAnalyzer?: string;

  source: SourceLocation;
  level?: number;
  level_name?: string;
  relationships?: Relationships;

  signature?: {
    parameters?: Array<{
      name: string;
      type?: string;
      optional?: boolean;
      default_value?: string;
    }>;
    return_type?: string;
    async?: boolean;
    visibility?: string;
  };

  documentation?: CASDocumentation;
  comments?: CASComment[];
  implementation_status?: CASImplementationStatus;
  todos?: CASTodo[];

  metrics?: Metrics;
  security?: SecurityContext;
  telemetry?: TelemetryHooks;
  dataFlow?: DataFlow;
  metadata?: {
    perspective_data?: Record<string, any>;
    attributes?: {
      methodCount?: number;
      implements?: string[];
      extends?: string;
      decorators?: string[];
      isAbstract?: boolean;
      isExported?: boolean;
    };
    [key: string]: any;
  };
}

export interface CASEdge {
  id: string;
  source: string;
  target: string;
  type: string;

  perspectives?: string[];
  analyzer?: string;
  dataFlow?: EdgeDataFlow;
  metadata?: {
    perspective_data?: Record<string, any>;
    [key: string]: any;
  };
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

export interface SourceLocation {
  file: string;
  line: number;
  end_line: number;
}

export interface EntryPoint {
  id: string;
  type: 'http' | 'grpc' | 'graphql' | 'websocket' | 'cli' | 'event' | 'scheduled' | 'startup' | 'test' | 'page' | 'route' | 'message' | 'other';
  name: string;
  description?: string;

  protocol_details?: {
    method?: string;
    path?: string;
    parameters?: Array<{
      name: string;
      type: string;
      required?: boolean;
      location?: 'query' | 'path' | 'body' | 'header';
    }>;
  };

  handler: {
    node_id: string;
    method_name?: string;
    file: string;
    line: number;
  };

  authentication?: {
    required: boolean;
    methods?: string[];
  };

  metadata?: Record<string, any>;
}

export interface ExitPoint {
  id: string;
  type: 'database' | 'api' | 'file' | 'cache' | 'queue' | 'email' | 'storage' | 'sdk' | 'other';
  name: string;
  description?: string;
  source_node?: string;

  target: {
    service_id?: string;
    resource?: string;
    sdk?: string;
    endpoint?: string;
    system?: string;
    protocol?: string;
  };

  source?: {
    node_id: string;
    method_name?: string;
    file: string;
    line: number;
  };

  operation?: {
    action: string;
    async: boolean;
  };

  operations?: string[];

  metadata?: Record<string, any>;
}

export interface ExternalService {
  id: string;
  name: string;
  type: string;
  direction: 'consumption' | 'production' | 'bidirectional';
  connection_node: string;
  metadata?: Record<string, any>;
}

export interface AnalyzerContribution {
  analyzer_name: string;
  analyzer_type: string;
  version?: string;
  confidence: number;
  provided_perspectives?: string[];
}

export interface RepositoryLink {
  target_system_id: string;
  connection_type: string;
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

export interface SystemMetadata {
  [key: string]: any;
}

export interface Relationships {
  [key: string]: any;
}

export interface CASDocumentation {
  type: 'jsdoc' | 'javadoc' | 'xmldoc' | 'docstring' | 'rustdoc' | 'godoc' | 'phpdoc' | 'typedoc' | 'other';
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

  throws?: Array<{
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
  };

  location: {
    start_line: number;
    end_line: number;
  };
}

export interface Documentation {
  [key: string]: any;
}

export interface Metrics {
  [key: string]: any;
}

export interface SecurityContext {
  [key: string]: any;
}

export interface TelemetryHooks {
  [key: string]: any;
}

export interface DataFlow {
  [key: string]: any;
}

export interface EdgeDataFlow {
  [key: string]: any;
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

  // v1.7.0 Enhancements
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

export interface CASComment {
  id: string;
  type: 'single-line' | 'multi-line' | 'inline' | 'block';
  style: '//' | '#' | '--' | '/* */' | '<!-- -->' | 'other';
  text: string;
  purpose?: 'explanation' | 'todo' | 'warning' | 'note' | 'hack' | 'clarification' | 'disabled-code' | 'other';

  location: {
    file: string;
    line: number;
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

  location: {
    file: string;
    line: number;
    node_id?: string;
  };

  context?: {
    function_name?: string;
    class_name?: string;
    estimated_effort?: string;
    related_issue?: string;
  };

  classification?: {
    category?: 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test';
    technical_debt?: boolean;
    blocking?: boolean;
  };
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
  };

  completeness?: {
    estimated_percentage?: number;
    missing_features?: string[];
    implemented_features?: string[];
  };

  deprecation?: {
    is_deprecated: boolean;
    deprecated_since?: string;
    removal_version?: string;
    alternative?: string;
    migration_guide?: string;
  };

  experimental?: {
    is_experimental: boolean;
    stability_level?: 'unstable' | 'experimental' | 'beta' | 'stable';
    api_may_change?: boolean;
  };
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

  by_type: Record<string, number>;
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

// UI-specific types for perspective views
export interface PerspectiveGroup {
  id: string;
  name: string;
  type: string;
  count: number;
  nodes: CASNode[];
  color: string;
  icon: React.ReactNode;
}

export interface ViewState {
  mode: 'overview' | 'perspective' | 'component';
  selectedPerspective?: string;
  selectedComponent?: string;
  zoom: number;
  position: { x: number; y: number };
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

export interface CASPattern {
  id: string;
  name: string;
  description?: string;
  confidence: number;
  instances: string[];
  variations?: CASPatternVariation[];
  deviations?: CASPatternDeviation[];
}

// v1.6.0 Test Structures

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
  };
  coverage: {
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

// v1.7.0 Inference-Based Intelligence Structures

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
  type: 'commit_message' | 'pr_description' | 'code_comment' | 'pattern_deviation' | 'naming_convention';
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
  };

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

export interface CASDataEntity {
  id: string;
  name: string;
  schema_source?: string;

  fields?: Array<{
    name: string;
    type: string;
    is_sensitive: boolean;
    validation?: string[];
  }>;

  lifecycle: {
    created_by: string[];
    read_by: string[];
    updated_by: string[];
    deleted_by: string[];
  };

  transformations?: Array<{
    from_node: string;
    to_node: string;
    transformation_type: 'map' | 'filter' | 'aggregate' | 'enrich' | 'validate' | 'sanitize';
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

export interface CASSecurityBoundary {
  id: string;
  name: string;
  boundary_type: 'authentication' | 'authorization' | 'input-validation' |
                 'output-encoding' | 'rate-limiting' | 'encryption';

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

export interface CASSecurityContext {
  node_id: string;
  trust_level: 'untrusted' | 'partially-trusted' | 'trusted';
  security_relevant: boolean;
  security_relevance_reason?: string;
  required_protections: string[];
  actual_protections: string[];
  protection_gaps?: string[];
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
  };

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
  description: string;
  category: 'core' | 'supporting' | 'admin' | 'internal';

  operations: Array<{
    entry_point_id: string;
    entry_point_type: string;
    action: string;
    path_or_command?: string;
  }>;

  related_entities: string[];
  related_domains: string[];
  criticality: 'critical' | 'high' | 'medium' | 'low';
  criticality_factors: string[];
}

export interface SystemPurpose {
  primary_type: string;
  confidence: number;
  evidence: string[];
  secondary_types?: string[];
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

export interface CASFlowGraph {
  capabilities: CASCapability[];
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

export interface CASFlowLayer {
  layer_number: number;
  layer_name: string;
  capabilities: string[];
  layer_type: 'entry' | 'business' | 'data' | 'infrastructure';
}