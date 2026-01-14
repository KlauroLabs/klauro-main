// CAS v1.5.0 TypeScript interfaces

export interface CASOutput {
  cas_version: "1.5.0" | "1.4.0";
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
  type: 'http' | 'grpc' | 'graphql' | 'websocket' | 'cli' | 'event' | 'scheduled' | 'startup' | 'other';
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
  [key: string]: any;
}

export interface DisclosureHints {
  [key: string]: any;
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
  total_nodes: number;
  documented_nodes: number;
  documentation_coverage: number;

  by_type: Record<string, {
    total: number;
    documented: number;
    coverage: number;
  }>;

  quality_metrics?: {
    nodes_with_examples: number;
    nodes_with_parameters: number;
    nodes_with_returns: number;
    average_doc_length?: number;
  };
}

export interface CASTodoSummary {
  total_todos: number;

  by_type: Record<string, number>;
  by_priority: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };

  by_category?: Record<string, number>;

  technical_debt_items: number;
  blocking_items: number;
}

export interface CASImplementationHealth {
  overall_score: number;

  status_breakdown: {
    complete: number;
    partial: number;
    stub: number;
    not_implemented: number;
    deprecated: number;
    experimental: number;
  };

  quality_indicators: {
    nodes_with_todos: number;
    nodes_with_hardcoded_values: number;
    nodes_with_placeholder_code: number;
    nodes_with_commented_code: number;
  };

  stability_analysis?: {
    stable_nodes: number;
    beta_nodes: number;
    experimental_nodes: number;
    unstable_nodes: number;
  };
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