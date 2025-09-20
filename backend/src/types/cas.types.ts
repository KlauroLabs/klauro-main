export interface CASOutput {
  cas_version: string;
  analysis_timestamp: string;
  analysis_id: string;
  system: CASSystem;
  perspectives?: CASPerspective[]; // New in v1.2
  nodes: CASNode[];
  edges: CASEdge[];
  behaviors?: CASBehavior[];
  patterns?: CASPattern[];
  categories?: CASCategories;
  tags?: CASTag[];
  index?: CASIndex;
  external_services?: CASExternalService[];
  cross_repository_links?: CASCrossRepositoryLink[];
  security_contexts?: CASSecurityContext[];
  test_coverage?: CASTestCoverage;
  libraries?: CASLibrary[];
  analyzer_contributions: CASAnalyzerContribution[];
  progressive_levels: CASProgressiveLevels;
  entry_points?: CASEntryPoint[];
  exit_points?: CASExitPoint[];
  configuration?: CASConfiguration;
  runtime?: CASRuntime;
  analysis_errors?: CASAnalysisError[];
  validation?: CASValidation;
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

export interface CASSystem {
  id: string;
  name: string;
  description?: string;
  type: 'monorepo' | 'application' | 'library' | 'service' | 'package';
  root_path: string;
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
    frameworks?: Array<{
      name: string;
      version?: string;
      confidence?: number;
    }>;
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
  metadata?: Record<string, any>;
}

export interface CASNode {
  id: string;
  name: string;
  type: string;
  qualified_name?: string;
  category?: string;
  subcategories?: string[];
  perspectives?: string[]; // New in v1.2: perspectives this node appears in
  level?: number;
  level_name?: string;
  description?: string;
  tags?: string[];
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
    perspective_data?: Record<string, any>; // New in v1.2: perspective-specific metadata
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
  perspectives?: string[]; // New in v1.2: perspectives this edge is relevant to
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
    perspective_data?: Record<string, any>; // New in v1.2: perspective-specific metadata
  };
}

export interface CASEntryPoint {
  id: string;
  source_node: string;
  source_analyzer?: string;
  type: 'http' | 'websocket' | 'cli' | 'event' | 'schedule' | 'page' | 'route' | 'message' | 'file';
  name: string;
  description?: string;
  trigger?: {
    method?: string;
    path?: string;
    pattern?: string;
    event?: string;
    schedule?: string;
  };
  input?: {
    type?: string;
    schema?: string;
    validation?: string[];
    example?: any;
  };
  output?: {
    type?: string;
    schema?: string;
    status_codes?: number[];
  };
  security?: {
    authenticated?: boolean;
    authorized_roles?: string[];
    rate_limit?: string;
    redirect_if_unauthorized?: string;
  };
  connected_nodes?: string[];
  metadata?: Record<string, any>;
}

export interface CASExitPoint {
  id: string;
  source_node: string;
  source_analyzer?: string;
  type: 'database' | 'api' | 'file' | 'message' | 'cache' | 'sdk' | 'webhook';
  name: string;
  description?: string;
  target?: {
    service_id?: string;
    endpoint?: string;
    resource?: string;
    sdk?: string;
  };
  operation?: {
    action?: string;
    method?: string;
    async?: boolean;
  };
  data?: {
    input_type?: string;
    output_type?: string;
    transformation_node?: string;
  };
  reliability?: {
    retry_attempts?: number;
    timeout_ms?: number;
    circuit_breaker?: boolean;
  };
  connected_nodes?: string[];
  metadata?: Record<string, any>;
}

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

export interface CASPattern {
  id: string;
  type: 'design-pattern' | 'architectural-pattern' | 'anti-pattern';
  name: string;
  confidence?: number;
  instances?: Array<{
    nodes?: string[];
    edges?: string[];
    location?: string;
  }>;
  metadata?: {
    framework_specific?: boolean;
    language_specific?: boolean;
    description?: string;
    benefits?: string[];
    drawbacks?: string[];
  };
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
  type: 'api' | 'library' | 'shared-schema' | 'message-contract';
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
  };
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

export interface CASAnalyzerContribution {
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
  nodes_contributed?: number;
  edges_contributed?: number;
  capabilities?: string[];
  analysis_scope?: {
    files_analyzed?: number;
    files_skipped?: number;
    patterns_detected?: string[];
  };
  contributed_categories?: string[];
  contributed_entry_points?: number;
  contributed_exit_points?: number;
  execution_time?: string;
  execution_time_ms?: number;
  memory_usage?: string;
  provided_perspectives?: string[];
  errors?: string[];
  warnings?: string[];
  framework_specific?: Record<string, any>;
  library_specific?: Record<string, any>;
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

  const crypto = require('crypto');
  const hash = crypto
    .createHash('sha256')
    .update(filePath + name)
    .digest('hex')
    .substring(0, 8);

  return `${type}_${normalizedPath}_${normalizedName}_${hash}`;
}

export function generateEdgeId(source: string, target: string, type: string): string {
  const crypto = require('crypto');
  const hash = crypto
    .createHash('sha256')
    .update(source + target + type)
    .digest('hex')
    .substring(0, 8);

  return `edge_${type}_${hash}`;
}