# Code Analysis Specification (CAS)

**Version:** 1.8.0
**Status:** Active
**Last Updated:** 2026-02-05

## Abstract

The Code Analysis Specification (CAS) defines a universal, language-agnostic format for representing comprehensive code analysis results. This specification enables tools to analyze, understand, and share insights about software systems through a standardized data structure supporting multiple analytical perspectives, rich metadata, progressive disclosure, call graph tracking, and documentation extraction.

## Table of Contents

1. [Introduction](#1-introduction)
2. [Conformance](#2-conformance)
3. [References](#3-references)
4. [Data Structures](#4-data-structures)
5. [Semantic Rules](#5-semantic-rules)
6. [Query Interface](#6-query-interface)
7. [Extensions](#7-extensions)
8. [Security Considerations](#8-security-considerations)
9. [IANA Considerations](#9-iana-considerations)
10. [Examples](#10-examples)

## Version History

This document specifies version 1.8.0 of the Code Analysis Specification. The evolution of CAS includes:

- **[Version 1.0.0](./v1.0.0.md)** (2024-01-01) - Initial release with core nodes, edges, and basic metadata
- **[Version 1.1.0](./v1.1.0.md)** (2024-06-01) - Added progressive levels, entry/exit points, and extended metadata
- **[Version 1.2.0](./v1.2.0.md)** (2024-09-19) - Added multi-perspective support and enhanced patterns
- **[Version 1.3.0](./v1.3.0-rfp.md)** (2025-01-01) - Added comprehensive call graph tracking and method invocation analysis
- **[Version 1.4.0](./v1.4.0-rfp.md)** (2025-09-20) - Added documentation and comment extraction
- **[Version 1.5.0](./v1.5.0-rfp.md)** (2026-01-09) - Added class-level relationships, pattern variations, and enhanced entry points
- **[Version 1.6.0](./v1.6.0-rfp.md)** (2026-01-23) - Added test architecture, test categorization, BDD support, and test-to-code relationships
- **[Version 1.7.0](./v1.7.0-rfp.md)** (2026-01-25) - Added inference-based intelligence: intent, critical flows, change risk, data lifecycle, security boundaries, flow coverage, temporal stability
- **[Version 1.8.0](./v1.8.0-rfp.md)** (2026-02-05) - Current version - Added incremental analysis: change detection, change reporting, change history, impact analysis

## 1. Introduction

### 1.1 Purpose

Modern software systems require analysis from multiple perspectives - language constructs, framework patterns, architectural layers, business domains, and quality metrics. The CAS provides a unified format for capturing and sharing these diverse analytical views.

### 1.2 Scope

This specification defines:
- Data structures for representing code analysis results
- Semantic rules for multi-perspective analysis
- Query interfaces for information retrieval
- Extension mechanisms for future capabilities

This specification does NOT define:
- Visualization or presentation formats
- Analysis algorithms or techniques
- Language-specific parsing rules
- Performance requirements

### 1.3 Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 2. Conformance

A conforming implementation:
- MUST produce output matching the specified data structures
- MUST implement the tag accumulation system correctly
- MUST maintain perspective independence
- MUST preserve analyzer attribution
- SHOULD support all defined metadata fields
- MAY extend the specification with additional fields

## 3. References

### 3.1 Normative References

- RFC 2119: Key words for use in RFCs to Indicate Requirement Levels
- RFC 8259: The JavaScript Object Notation (JSON) Data Interchange Format
- ISO 8601: Date and time format

### 3.2 Informative References

- Language Server Protocol Specification
- SARIF (Static Analysis Results Interchange Format)
- CodeQL Database Schema

## 4. Data Structures

### 4.1 CASOutput

The root structure containing complete analysis results:

```typescript
interface CASOutput {
  cas_version: "1.8.0";
  analysis_timestamp: string;  // ISO 8601
  analysis_id: string;          // Unique identifier

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
  entry_points: EntryPoint[];      // Added in v1.1.0
  exit_points: ExitPoint[];        // Added in v1.1.0
  external_services: ExternalService[]; // Added in v1.1.0, filtered in v1.5.0

  repository_links?: CrossRepositoryLink[];
  cross_repository_links?: CrossRepositoryLink[]; // Backward-compatible alias
  dependencies?: Dependencies;
  disclosure?: DisclosureHints;     // Added in v1.1.0
  analyzer_contributions: AnalyzerContribution[];
  progressive_levels?: ProgressiveLevels;

  perspectives?: CASPerspective[];  // Added in v1.2.0

  method_calls?: CASMethodCall[];   // Added in v1.3.0
  call_chains?: CASCallChain[];     // Added in v1.3.0, enhanced in v1.7.0
  decorators?: CASDecorator[];      // Added in v1.3.0

  documentation_summary?: CASDocumentationSummary;  // Added in v1.4.0
  todos_summary?: CASTodoSummary;                   // Added in v1.4.0
  implementation_health?: CASImplementationHealth;  // Added in v1.4.0

  patterns?: CASPattern[];          // Enhanced in v1.5.0 with variations

  test_suites?: CASTestSuite[];     // Added in v1.6.0
  mocks?: CASMock[];                // Added in v1.6.0
  fixtures?: CASFixture[];          // Added in v1.6.0
  test_summary?: CASTestSummary;    // Added in v1.6.0

  // v1.7.0 Inference-Based Intelligence
  intents?: CASIntent[];                        // Added in v1.7.0
  flow_summary?: CASFlowSummary;                // Added in v1.7.0
  change_risks?: CASChangeRisk[];               // Added in v1.7.0
  change_risk_summary?: CASChangeRiskSummary;   // Added in v1.7.0
  data_entities?: CASDataEntity[];              // Added in v1.7.0
  data_summary?: CASDataSummary;                // Added in v1.7.0
  security_boundaries?: CASSecurityBoundary[];  // Added in v1.7.0
  security_contexts?: CASSecurityContext[];     // Added in v1.7.0
  security_summary?: CASSecuritySummary;        // Added in v1.7.0
  flow_coverage?: CASFlowCoverage[];            // Added in v1.7.0
  test_gaps?: CASTestGap[];                     // Added in v1.7.0
  temporal_stability?: CASTemporalStability[];  // Added in v1.7.0
  stability_summary?: CASStabilitySummary;      // Added in v1.7.0

  // v1.8.0 Analysis Truth and Runtime Readiness
  configuration?: CASConfiguration;              // Runtime/configuration signals inferred from code
  runtime?: CASRuntime;                          // Deployment, monitoring, and instrumentation readiness
  runtime_static_links?: CASRuntimeStaticLink[]; // Static objects mapped to runtime signals
  analysis_facts?: CASAnalysisFact[];            // Evidence-backed claims behind CAS objects

  metadata?: SystemMetadata;
}
```

### 4.2 CASNode

Represents a code element with multi-perspective analysis:

```typescript
interface CASNode {
  id: string;                   // Unique identifier
  name: string;                  // Human-readable name
  type: string;                  // Node type (e.g., 'class', 'function', 'module')
  tags: string[];                // Classification tags (v1.1.0: accumulative from all analyzers)

  parent?: string;               // v1.5.0: REQUIRED for class members (methods, properties)

  perspectives: {                // Added in v1.2.0
    [perspectiveId: string]: {
      hierarchy: string[];       // Hierarchical path
      level: number;            // Depth (0 = top-level)
      priority: number;         // Importance (0-100)
      metadata?: Record<string, any>;
    }
  };

  analyzers: string[];          // Contributing analyzers (v1.1.0)
  primaryAnalyzer: string;      // Primary ownership (v1.1.0)

  source: SourceLocation;
  relationships?: Relationships;

  documentation?: CASDocumentation;    // Enhanced in v1.4.0
  comments?: CASComment[];             // Added in v1.4.0
  implementation_status?: CASImplementationStatus; // Added in v1.4.0
  todos?: CASTodo[];                    // Added in v1.4.0

  metrics?: Metrics;
  security?: SecurityContext;
  telemetry?: TelemetryHooks;
  dataFlow?: DataFlow;

  test_coverage?: CASTestCoverage;  // Added in v1.6.0

  metadata?: Record<string, any>;
}
```

### 4.3 CASEdge

Represents relationships between nodes:

```typescript
interface CASEdge {
  id: string;
  source: string;               // Source node ID
  target: string;               // Target node ID
  type: string;                 // Relationship type (v1.3.0+: extended types)

  analyzer?: string;            // Creating analyzer (v1.1.0)
  perspectives?: string[];      // Array of perspective IDs (v1.2.0)
  dataFlow?: EdgeDataFlow;

  aggregated_from?: string[];   // v1.5.0: For class-level edges, list of method-level call IDs
  relationship_metadata?: {     // v1.5.0: Additional context for class relationships
    injection_type?: 'constructor' | 'property' | 'method';
    instantiation_count?: number;
    usage_locations?: Array<{ file: string; line: number }>;
  };

  metadata?: Record<string, any>;
}

// Standard edge types (v1.0.0 - v1.2.0)
type StandardEdgeTypes = 'imports' | 'exports' | 'extends' | 'implements' |
                        'contains' | 'uses' | 'depends-on' | 'references';

// Call graph edge types (v1.3.0)
type CallGraphEdgeTypes = 'calls' | 'invokes' | 'delegates-to' | 'instantiates' |
                          'decorates' | 'guards' | 'intercepts' | 'validates' |
                          'transforms' | 'overrides';

// Class relationship edge types (v1.5.0)
type ClassRelationshipEdgeTypes = 'uses' | 'depends_on' | 'injects';
// - 'uses': ClassA has method that calls method in ClassB
// - 'depends_on': ClassA receives ClassB via constructor injection
// - 'injects': Module/container provides ClassB to ClassA
// - 'instantiates': ClassA creates instance of ClassB (from v1.3.0)

// Test edge types (v1.6.0)
type TestEdgeTypes = 'tests' | 'mocks' | 'stubs' | 'covers' | 'validates';
// - 'tests': Test -> Code being tested
// - 'mocks': Test -> Mock node
// - 'stubs': Test -> Stub node
// - 'covers': Test -> Covered node (from coverage data)
// - 'validates': Assertion -> Validated behavior
```

### 4.4 Call Graph Structures (v1.3.0)

#### CASMethodCall
Tracks function-to-function calls with execution context:

```typescript
interface CASMethodCall {
  id: string;
  caller_node: string;              // Source node ID
  target_node?: string;             // Target node ID (null for external)

  call_details: {
    method_name: string;
    signature?: string;
    location: {
      file: string;
      line: number;
      column: number;
    };
    call_type: 'direct' | 'method' | 'constructor' | 'abstract' |
               'interface' | 'callback' | 'hook' | 'dynamic';
    resolution_type: 'static' | 'dynamic' | 'polymorphic' |
                    'external' | 'unresolved';
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
```

#### CASCallChain
Represents complete call paths from entry to exit:

```typescript
interface CASCallChain {
  id: string;
  chain_type: 'entry-to-exit' | 'circular' | 'recursive' |
              'dead-end' | 'hot-path' | 'critical-path';

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
  criticality?: 'critical' | 'high' | 'medium' | 'low';  // Added in v1.7.0
  criticality_factors?: string[];                         // Added in v1.7.0

  runtime_stats?: {                                       // Added in v1.7.0
    traffic_volume: 'very-high' | 'high' | 'medium' | 'low';
    avg_latency_ms?: number;
    error_rate_percent?: number;
    last_observed?: string;  // ISO 8601
  };

  test_coverage?: {                                       // Added in v1.7.0
    covered: boolean;
    coverage_percentage?: number;
    test_ids?: string[];      // Test entry point IDs
    gaps?: string[];          // Uncovered node IDs
  };

  metadata?: Record<string, any>;
}
```

#### CASDecorator
Framework-specific decorator/annotation semantics:

```typescript
interface CASDecorator {
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
    category: 'routing' | 'validation' | 'security' | 'lifecycle' |
              'injection' | 'configuration' | 'other';
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
```

### 4.5 Documentation Structures (v1.4.0)

#### CASDocumentation
Structured documentation extracted from code:

```typescript
interface CASDocumentation {
  type: 'jsdoc' | 'javadoc' | 'xmldoc' | 'docstring' | 'rustdoc' |
        'godoc' | 'phpdoc' | 'typedoc' | 'other';
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
    tag: string;  // @deprecated, @since, @author, @see, @link
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
```

#### CASComment
Inline and block comments with classification:

```typescript
interface CASComment {
  id: string;
  type: 'single-line' | 'multi-line' | 'inline' | 'block';
  style: '//' | '#' | '--' | '/* */' | '<!-- -->' | 'other';
  text: string;
  purpose?: 'explanation' | 'todo' | 'warning' | 'note' | 'hack' |
            'clarification' | 'disabled-code' | 'other';

  location: {
    file: string;
    line: number;
    column?: number;
    relative_to?: 'above' | 'inline' | 'below';
  };

  context?: {
    preceding_code?: string;
    following_code?: string;
    scope?: string;  // function, class, module, etc.
    scope_id?: string;  // Reference to CASNode
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
```

#### CASTodo
Technical debt and work item tracking:

```typescript
interface CASTodo {
  id: string;
  type: 'TODO' | 'FIXME' | 'HACK' | 'NOTE' | 'WARNING' |
        'XXX' | 'OPTIMIZE' | 'REFACTOR';
  text: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';

  assignee?: string;  // Extracted from TODO(username)
  created_date?: string;  // If specified in comment
  due_date?: string;  // If specified

  location: {
    file: string;
    line: number;
    node_id?: string;  // Associated CASNode
  };

  context?: {
    function_name?: string;
    class_name?: string;
    estimated_effort?: string;
    related_issue?: string;  // GitHub/JIRA issue reference
  };

  classification?: {
    category?: 'bug' | 'feature' | 'refactor' | 'performance' |
               'security' | 'documentation' | 'test';
    technical_debt?: boolean;
    blocking?: boolean;
  };
}
```

#### CASImplementationStatus
Tracks completion and maturity status:

```typescript
interface CASImplementationStatus {
  status: 'complete' | 'partial' | 'stub' | 'not-implemented' |
          'deprecated' | 'experimental';

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
```

### 4.6 Perspective Support (v1.2.0)

#### CASPerspective
Enables multiple architectural views:

```typescript
interface CASPerspective {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  description: string;           // What this perspective shows
  analyzer_id: string;           // Providing analyzer
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
```

### 4.7 Entry and Exit Points (v1.1.0)

#### EntryPoint
System entry points (API endpoints, CLI commands, etc.):

**Important Note on Entry Point Semantics by System Type:**
- **Web APIs/Services**: Entry points (HTTP, gRPC, GraphQL) typically map 1:1 with business capabilities. Each endpoint represents a distinct operation that can be grouped into capability domains.
- **CLI Tools**: Entry points are subcommands/invocation modes (e.g., `scan quick`, `scan deep`), NOT business capabilities. The actual capabilities (e.g., "port scanning", "web enumeration") are internal function clusters that get invoked by multiple subcommands. Capability detection for CLI tools must analyze call graphs and function clusters rather than entry points.
- **Frontend SPAs**: Entry points are routes/pages which represent user-facing views. Capabilities emerge from the services and state management the routes consume.

```typescript
interface EntryPoint {
  id: string;
  type: 'http' | 'grpc' | 'graphql' | 'websocket' | 'cli' |
        'event' | 'scheduled' | 'startup' | 'test' | 'other';  // v1.6.0: Added 'test'
  name: string;
  description?: string;

  trigger: {                    // v1.5.0: Enhanced trigger information
    method: string;             // GET, POST, etc.
    path: string;               // v1.5.0: MUST be full path (e.g., /workspaces/:id)
    base_path?: string;         // v1.5.0: Controller/router base path
    parameters?: Array<{
      name: string;
      type: string;
      required?: boolean;
      location?: 'query' | 'path' | 'body' | 'header';
    }>;
  };

  handler: {
    node_id: string;      // Reference to CASNode
    method_name?: string;
    file: string;
    line: number;
  };

  security: {                   // v1.5.0: Enhanced security information
    authenticated: boolean;     // v1.5.0: MUST merge class-level and method-level guards
    guards: string[];           // v1.5.0: ALL guards (class + method level)
    roles?: string[];
    permissions?: string[];
  };

  metadata?: Record<string, any>;
}
```

#### ExitPoint
External system interactions:

```typescript
interface ExitPoint {
  id: string;
  source_node: string;
  source_analyzer?: string;
  type: 'database' | 'api' | 'file' | 'message' | 'event' |
        'cache' | 'sdk' | 'webhook' | 'navigation' |
        'client_storage' | 'analytics';
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
```

#### ExternalService
Third-party service dependencies:

```typescript
interface ExternalService {
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
```

#### CrossRepositoryLink
Deterministic links between this analysis and another repository or system boundary:

```typescript
interface CrossRepositoryLink {
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
```

#### CASRuntime
Runtime and instrumentation readiness inferred from code and configuration:

```typescript
interface CASRuntime {
  deployment?: {
    type?: string;
    orchestration?: string;
  };
  performance?: {
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
```

#### CASRuntimeStaticLink
Bridge between a static CAS object and the runtime signal that would validate it:

```typescript
interface CASRuntimeStaticLink {
  id: string;
  kind: 'entry-point' | 'exit-point' | 'call-chain' | 'external-service' | 'telemetry-hook';
  static_id: string;
  runtime_signal: string;
  telemetry_status: 'observed' | 'instrumentable' | 'not-instrumented';
  confidence: number;
  instrumentation_points: string[];
  evidence: CASFactEvidence[];
}
```

#### CASAnalysisFact
Evidence-backed claims explaining why CAS contains a relationship, flow, or object:

```typescript
interface CASFactEvidence {
  kind: 'source-location' | 'analyzer' | 'configuration' | 'dependency' |
        'route' | 'runtime-signal' | 'naming' | 'graph';
  source: string;
  file?: string;
  line?: number;
  excerpt?: string;
  confidence: number;
}

interface CASAnalysisFact {
  id: string;
  subject_type: 'node' | 'edge' | 'entry_point' | 'exit_point' |
                'external_service' | 'workflow' | 'capability' |
                'runtime_link' | 'repository_link';
  subject_id: string;
  fact_type: 'definition' | 'relationship' | 'entry' | 'exit' |
             'workflow' | 'capability' | 'runtime-correlation' |
             'cross-repository';
  claim: string;
  confidence: number;
  produced_by: string;
  evidence: CASFactEvidence[];
}
```

### 4.8 Pattern Detection with Variations (v1.5.0)

#### CASPattern
Architectural and design patterns with variation tracking:

```typescript
interface CASPattern {
  id: string;
  type?: 'design-pattern' | 'architectural-pattern' | 'anti-pattern';
  name: string;
  description?: string;
  confidence: number;           // 0-1 confidence score
  instances: string[];          // Node IDs implementing this pattern

  variations?: CASPatternVariation[];  // v1.5.0: Different implementations
  deviations?: CASPatternDeviation[];  // v1.5.0: Pattern issues/inconsistencies
}

interface CASPatternVariation {
  id: string;
  implementation: string;       // e.g., 'nestjs-di', 'manual-instantiation'
  description: string;
  instances: string[];          // Node IDs using this variation
  percentage: number;           // Percentage of total pattern instances
  characteristics?: Record<string, any>;
}

interface CASPatternDeviation {
  type: 'inconsistent-adoption' | 'partial-implementation' |
        'anti-pattern' | 'obsolete-usage' | 'mixed-styles';
  severity: 'info' | 'warning' | 'error';
  description: string;
  affected_instances: string[];
  recommendation?: string;
}
```

**Semantic Rules:**

1. When same pattern has multiple implementation approaches, create variations
2. Calculate percentage as `(variation.instances.length / pattern.instances.length) * 100`
3. Flag deviations when variations suggest inconsistency (e.g., <90% adoption of preferred approach)

#### Standard Pattern Catalog

CAS defines these standard pattern IDs so analyzer output is comparable across repositories:

| Pattern ID | Type | Detection Criteria | Required Variations |
|------------|------|--------------------|---------------------|
| `repository-pattern` | design-pattern | Nodes typed/tagged as repositories, names ending in `Repository` or `Repo`, or files under repository/data-access directories | `dependency-injection`, `manual-instantiation` when both appear |
| `service-layer-pattern` | design-pattern | Nodes typed/tagged as services or names ending in `Service` that encapsulate business operations | `dependency-injection`, `standalone` when both appear |
| `controller-pattern` | design-pattern | Controller, resolver, route handler, page, or view nodes that receive external input | `rest-api`, `graphql-resolver`, `page-route`, or framework-specific route style |
| `dependency-injection-pattern` | design-pattern | Constructor/property injection, provider registration, injectable decorators, or DI container bindings | `constructor-injection`, `provider-module`, `property-injection` when detectable |
| `module-pattern` | architectural-pattern | Module/package/bounded-context nodes grouping related providers, routes, components, or exports | `feature-module`, `core-module`, `shared-module` when detectable |
| `guard-pattern` | design-pattern | Guard, middleware, policy, interceptor, permission, or auth enforcement nodes | `authentication-guard`, `role-based-guard`, `custom-guard` |
| `layered-architecture` | architectural-pattern | Consistent entry/business/data/infrastructure layering visible through node tags and edges | Layer names present in `flow_graph.layers` |
| `mvc` | architectural-pattern | Model, view/page/template, and controller/handler roles connected through routes or framework conventions | `server-rendered`, `api-plus-client`, or framework-specific style |
| `circular-dependency-anti-pattern` | anti-pattern | Cycle detected in imports, `depends_on`, or `uses` edges | Each cycle represented as a deviation |
| `god-object-anti-pattern` | anti-pattern | Node exceeds configured size, complexity, or member-count thresholds | Each oversized node represented as a deviation |

Deviation severity SHOULD be assigned consistently:

- `error` when the pattern can break correctness or block analysis, such as circular dependencies.
- `warning` when the pattern creates maintainability risk, such as oversized objects or mixed repository styles.
- `info` when the analyzer finds a weaker consistency issue that does not imply immediate risk.

Analyzers MAY emit additional framework- or language-specific pattern IDs, but SHOULD map common concepts back to the catalog above when possible.

### 4.9 Test Structures (v1.6.0)

#### TestMetadata
Test-specific metadata for categorization and analysis:

```typescript
interface TestMetadata {
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance' |
             'performance' | 'visual' | 'smoke' | 'bdd';
  test_style: 'procedural' | 'bdd' | 'property-based' |
              'snapshot' | 'parameterized';
  priority: 'critical' | 'high' | 'medium' | 'low';
  tags: string[];
  uses_mocks: boolean;
  is_async: boolean;
  timeout_ms?: number;
  framework: string;  // 'jest', 'pytest', 'rust-test', 'mocha', 'cypress', etc.

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
```

#### CASTestSuite
Groups of related tests:

```typescript
interface CASTestSuite {
  id: string;
  name: string;
  file_path: string;
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance';
  framework: string;

  tests: CASTestCase[];
  hooks: CASTestHook[];
  fixtures: string[];  // Node IDs of fixture/factory nodes
  mocks: string[];     // Node IDs of mock nodes

  coverage?: {
    nodes_tested: string[];  // Node IDs this suite tests
    coverage_percentage?: number;
  };

  metadata?: {
    parallel: boolean;
    timeout_ms?: number;
    retries?: number;
    skip_reason?: string;
  };
}

interface CASTestCase {
  id: string;
  name: string;
  description?: string;
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance' | 'bdd';

  assertions: CASAssertion[];
  mocks_used: string[];  // Node IDs
  targets: string[];     // Node IDs of code being tested

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
}

interface CASTestHook {
  id: string;
  type: 'before_all' | 'before_each' | 'after_each' | 'after_all';
  name?: string;
  node_id: string;
}

interface CASAssertion {
  id: string;
  type: 'equality' | 'truthiness' | 'exception' | 'mock_call' |
        'snapshot' | 'property' | 'custom';
  expression: string;
  target_node?: string;
  location: {
    line: number;
    column?: number;
  };
}
```

#### CASMock
Mock/stub/spy tracking:

```typescript
interface CASMock {
  id: string;
  name: string;
  type: 'mock' | 'stub' | 'spy' | 'fake';
  target_node?: string;  // Node ID of what this replaces
  framework: string;     // 'jest.fn', 'sinon', 'mockall', etc.

  implementation?: {
    return_value?: string;
    implementation_fn?: string;
    call_tracking: boolean;
  };

  used_by: string[];  // Test node IDs
}
```

#### CASFixture
Test fixtures and factories:

```typescript
interface CASFixture {
  id: string;
  name: string;
  type: 'factory' | 'fixture' | 'builder' | 'seed-data';
  file_path: string;

  generates?: string;  // Type/entity it creates
  dependencies: string[];
  used_by: string[];  // Test node IDs
}
```

#### CASTestCoverage
Per-node coverage information:

```typescript
interface CASTestCoverage {
  covered: boolean;
  coverage_percentage: number;
  tested_by: string[];  // Test node IDs
  untested_branches?: Array<{
    line: number;
    condition: string;
  }>;
}
```

#### CASTestSummary
Aggregated test statistics:

```typescript
interface CASTestSummary {
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
    overall_percentage: number;
    by_layer: Record<string, number>;
  };
  mocks: {
    total: number;
    by_target_type: Record<string, number>;
  };
  fixtures: {
    total: number;
    factories: number;
    seed_data: number;
  };
}
```

**Semantic Rules:**

1. Tests MUST use `type: 'test'` for entry points, NOT `type: 'event'`
2. Test type SHOULD be inferred from file path when not explicit:
   - `/tests/` or `/integration/` -> `'integration'`
   - `/e2e/` or `/cypress/` -> `'e2e'`
   - Same directory as source with `.spec.` or `.test.` -> `'unit'`
3. BDD steps MUST be extracted from tests using Given/When/Then patterns
4. Mock nodes MUST have `target_node` pointing to what they replace
5. Test-to-code edges (`tests`, `covers`) MUST link tests to tested code

### 4.10 Inference-Based Intelligence Structures (v1.7.0)

#### CASIntent
Inferred purpose and architectural intent:

```typescript
interface CASIntent {
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

interface IntentEvidence {
  type: 'commit_message' | 'pr_description' | 'code_comment' |
        'pattern_deviation' | 'naming_convention';
  source: string;
  excerpt: string;
  confidence_contribution: number;
}
```

#### CASFlowSummary
Summary of critical flows:

```typescript
interface CASFlowSummary {
  total_critical_flows: number;
  by_criticality: Record<string, number>;
  untested_critical_flows: string[];
  high_error_rate_flows: string[];
}
```

#### CASChangeRisk
Per-node change impact assessment:

```typescript
interface CASChangeRisk {
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

interface ChangeRiskFactor {
  factor: 'many-callers' | 'critical-path' | 'high-traffic' |
          'no-tests' | 'recent-bugs' | 'complex-logic' |
          'external-dependency' | 'security-sensitive';
  severity: 'high' | 'medium' | 'low';
  details: string;
}

interface CASChangeRiskSummary {
  high_risk_nodes: string[];
  untested_critical_paths: string[];
  recent_hotspots: string[];
}
```

#### CASDataEntity
Entity-centric data lifecycle:

```typescript
interface CASDataEntity {
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
    transformation_type: 'map' | 'filter' | 'aggregate' |
                         'enrich' | 'validate' | 'sanitize';
  }>;

  invariants?: Array<{
    description: string;
    enforced_by: string[];
    source: 'validation' | 'constraint' | 'test' | 'assertion';
  }>;
}

interface CASDataSummary {
  entities: CASDataEntity[];
  sensitive_data_nodes: string[];
  validation_gaps: Array<{
    entity_id: string;
    missing_validation: string;
  }>;
}
```

#### CASSecurityBoundary
Trust boundaries and security enforcement:

```typescript
interface CASSecurityBoundary {
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

interface CASSecurityContext {
  node_id: string;
  trust_level: 'untrusted' | 'partially-trusted' | 'trusted';
  security_relevant: boolean;
  security_relevance_reason?: string;
  required_protections: string[];
  actual_protections: string[];
  protection_gaps?: string[];
}

interface CASSecuritySummary {
  boundaries: CASSecurityBoundary[];
  unprotected_sensitive_ops: string[];
  assumed_vs_enforced: {
    enforced: number;
    assumed: number;
    missing: number;
  };
}
```

#### CASFlowCoverage
Flow-level test coverage:

```typescript
interface CASFlowCoverage {
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

interface CASTestGap {
  gap_type: 'untested-flow' | 'untested-branch' | 'mock-only' | 'no-assertions';
  location: {
    node_id?: string;
    call_chain_id?: string;
    line?: number;
  };
  severity: 'critical' | 'high' | 'medium' | 'low';
  recommendation: string;
}
```

#### CASTemporalStability
Git-based code stability metrics:

```typescript
interface CASTemporalStability {
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

interface CASStabilitySummary {
  by_stability_class: Record<string, number>;
  hotspots: Array<{
    node_id: string;
    reason: string;
  }>;
  legacy_areas: string[];
}
```

### 4.11 Summary and Health Structures (v1.4.0)

#### CASDocumentationSummary
System-wide documentation metrics:

```typescript
interface CASDocumentationSummary {
  total_documented_nodes: number;
  documentation_coverage: number;  // percentage

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
```

#### CASTodoSummary
Technical debt overview:

```typescript
interface CASTodoSummary {
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
```

#### CASImplementationHealth
Overall system maturity assessment:

```typescript
interface CASImplementationHealth {
  complete_implementations: number;
  partial_implementations: number;
  stubs: number;
  not_implemented: number;
  deprecated: number;
  experimental: number;

  health_score: number;  // 0-100

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
```

### 4.12 Incremental Analysis Structures (v1.8.0)

#### ChangeReport
Semantic and structural summary of an incremental analysis run:

```typescript
interface ChangeReport {
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

interface ChangeSemanticImpact {
  affected_workflows: Array<{ id: string; name: string; reason: string }>;
  affected_capabilities: Array<{ id: string; name: string; reason: string }>;
  affected_data_entities: Array<{ id: string; name: string; reason: string }>;
  affected_runtime_links: Array<{ id: string; runtime_signal: string; reason: string }>;
  changed_contracts: Array<{ id: string; type: 'entry-point' | 'exit-point' | 'repository-link'; name: string }>;
  risk_reasons: string[];
}
```

### 4.13 Core Supporting Types

#### SourceLocation
File location information:

```typescript
interface SourceLocation {
  file: string;           // Relative path from root
  line: number;           // Starting line number
  column?: number;        // Starting column
  end_line?: number;      // Ending line number
  end_column?: number;    // Ending column
}
```

#### AnalyzerContribution
Tracks which analyzers contributed to the analysis:

```typescript
interface AnalyzerContribution {
  analyzer_id: string;
  analyzer_name: string;
  version: string;
  timestamp: string;      // ISO 8601
  nodes_contributed: number;
  edges_contributed: number;
  perspectives_provided?: string[];
  metadata?: Record<string, any>;
}
```

#### SystemMetadata
Additional system-level information:

```typescript
interface SystemMetadata {
  total_files: number;
  total_lines: number;
  primary_language?: string;
  languages?: Record<string, number>;  // Language: line count
  frameworks?: string[];
  build_tools?: string[];
  test_coverage?: number;
  last_modified?: string;  // ISO 8601
  [key: string]: any;
}
```

#### CASValidation
Completeness and graph integrity signals for consumers deciding how much to trust an analysis:

```typescript
interface CASValidation {
  schema_version?: string;
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
    connected_nodes: number;
    orphaned_nodes: number;
    entry_points_with_handlers: number;
    exit_points_with_sources: number;
    runtime_links_with_instrumentation: number;
    facts_with_evidence: number;
    relationship_coverage_score: number;
  };
}
```

## 5. Semantic Rules

### 5.1 Node Identity

- Node IDs MUST be unique within an analysis result
- Node IDs SHOULD be deterministic across analyses
- Node IDs MUST NOT contain personal or sensitive information
- Node type MUST be specified (v1.0.0)

### 5.2 Tag System (v1.1.0+)

- Tags are additive and non-hierarchical
- Tags MUST be lowercase with hyphens for word separation
- Tags accumulate from all analyzers
- No single analyzer owns a tag
- Tags enable cross-cutting concerns identification

### 5.3 Perspective System (v1.2.0+)

- Each analyzer MAY provide one or more perspectives
- Perspectives are independent views of the same system
- A node MAY appear in multiple perspectives
- Perspective IDs MUST be unique
- Perspectives enable visualization switching

### 5.4 Call Graph Rules (v1.3.0+)

- Method calls MUST reference valid node IDs
- Call chains MUST have valid entry points
- External calls SHOULD link to exit points
- Recursive calls MUST be flagged
- Call depth tracking enables performance analysis

### 5.5 Documentation Rules (v1.4.0+)

- Documentation type MUST match language conventions
- Comments MUST preserve original formatting
- TODOs MUST be classified by type
- Implementation status MUST reflect actual code state
- Documentation coverage SHOULD be calculated

### 5.6 Analyzer Collaboration

1. **Language analyzers** create base nodes and extract documentation
2. **Framework analyzers** enhance with perspectives and decorators
3. **Library analyzers** add specialized metadata and exit points
4. **Pattern analyzers** identify cross-cutting concerns and call chains

### 5.7 External Services (v1.1.0+)

- Services MUST be classified by type
- Direction MUST be specified (consumption/production/bidirectional)
- Connection node MUST exist in the node list
- Critical services SHOULD be marked

### 5.8 Data Integrity

- All node references MUST be valid
- Circular references in edges are allowed but MUST be detectable
- Timestamps MUST use ISO 8601 format
- File paths MUST be relative to system root
- Version fields MUST use semantic versioning

### 5.9 Class Relationships (v1.5.0+)

- Class members (methods, properties, constructors) MUST have `parent` set to containing class ID
- When method in ClassA calls method in ClassB, a `uses` edge MUST exist from ClassA to ClassB
- When ClassA receives ClassB via constructor injection, a `depends_on` edge MUST be created
- When `new ClassName()` is encountered, an `instantiates` edge MUST be created
- Class-level edges SHOULD include `aggregated_from` referencing method-level call IDs

### 5.10 Entry Point Paths (v1.5.0+)

- HTTP entry points MUST have full paths including controller/router base paths
- `trigger.path` MUST be complete (e.g., `/workspaces/:id` NOT just `:id`)
- `security.guards` MUST include ALL guards (class-level AND method-level)
- `security.authenticated` MUST be true if ANY guard is an auth guard

### 5.11 Pattern Variations (v1.5.0+)

- When multiple implementations of same pattern exist, variations MUST be tracked
- Variation percentages MUST sum to 100%
- Deviations SHOULD be flagged when variation usage is inconsistent

### 5.12 External Services Filtering (v1.5.0+)

- JS built-ins (Object, Array, Promise, etc.) MUST be excluded from `external_services`
- Standard library modules (fs, path, crypto) MUST be excluded from `external_services`
- Services MAY include `is_builtin` and `is_standard_library` flags for filtering

### 5.13 Test Entry Points (v1.6.0+)

- Tests MUST use `type: 'test'` entry points, NOT `type: 'event'`
- Test type categorization SHOULD be inferred from file paths:
  - `/tests/` or `/integration/` directory -> `test_type: 'integration'`
  - `/e2e/` or `/cypress/` directory -> `test_type: 'e2e'`
  - Same directory as source code -> `test_type: 'unit'`
  - Rust `#[cfg(test)]` module -> `test_type: 'unit'`
  - Rust `/tests/` directory -> `test_type: 'integration'`
- BDD tests SHOULD have `bdd_context` with Given/When/Then steps extracted
- Mock usage MUST be tracked via `uses_mocks: true` in test metadata

### 5.14 Test-to-Code Relationships (v1.6.0+)

- When a test calls production code, a `tests` edge MUST be created from test to called node
- When a test uses a mock, a `mocks` edge MUST be created from test to mock node
- Mock nodes MUST have `target_node` pointing to the node they replace
- Coverage data SHOULD be integrated into nodes via `test_coverage` field
- Test suites SHOULD track which nodes they test via `coverage.nodes_tested`

### 5.15 Intent Inference (v1.7.0+)

- Intent SHOULD be inferred from commit history, comments, and pattern deviations
- Workaround indicators MUST include `confidence` level
- Evidence MUST include `source` references (file path, commit SHA, or PR number)
- When multiple evidence sources agree, confidence SHOULD be `'high'`
- When evidence is from comments only, confidence SHOULD be `'medium'`
- When inferred from naming alone, confidence SHOULD be `'low'`

### 5.16 Flow Criticality (v1.7.0+)

- Call chains SHOULD have `criticality` set based on traffic, error rate, and business impact
- `criticality: 'critical'` MUST be assigned when ANY of:
  - `runtime_stats.traffic_volume` is `'very-high'`
  - `runtime_stats.error_rate_percent` > 5 AND traffic is high
  - `business_context.business_process` contains "payment", "auth", or "checkout"
- `runtime_stats` SHOULD be populated when SDK telemetry is available
- `test_coverage.test_ids` MUST reference existing test entry point IDs
- `test_coverage.gaps` SHOULD list node IDs of untested segments

### 5.17 Change Risk (v1.7.0+)

- Risk level MUST consider: caller count, critical path membership, test coverage, stability
- `risk_level: 'critical'` MUST be assigned when 2+ high-severity factors present
- `downstream_impact.affected_call_chains` MUST reference existing `CASCallChain` IDs
- `stability_context.bug_fix_density` SHOULD be calculated as: (bug fix commits / total commits)
- Bug fix commits SHOULD be identified by commit message patterns: "fix", "bug", "issue", "patch"

### 5.18 Data Entity (v1.7.0+)

- Entities SHOULD be inferred from schema files, ORM models, and type definitions
- Sensitive fields MUST be flagged based on naming conventions (password, token, email, etc.)
- `lifecycle` operations MUST map to node IDs that perform CRUD
- `validation_gaps` SHOULD flag entities with `created_by` but no `validation` rules

### 5.19 Security Boundary (v1.7.0+)

- Boundaries SHOULD be inferred from guards, middleware, and decorators
- Trust levels MUST propagate through the call graph based on boundary crossings
- `confidence: 'enforced'` SHOULD be set when guard/middleware explicitly present
- `confidence: 'assumed'` SHOULD be set when trust is implied but not enforced
- `confidence: 'missing'` MUST be set when sensitive operation lacks protection
- `protection_gaps` MUST be flagged when `required_protections` differs from `actual_protections`

### 5.20 Flow Coverage (v1.7.0+)

- Flow coverage MUST extend existing per-node coverage to `CASCallChain` level
- `coverage_percentage` SHOULD be calculated as: (tested_nodes / total_nodes_in_chain) * 100
- Test gaps MUST be categorized by severity based on `CASCallChain.criticality`
- `gap_type: 'mock-only'` SHOULD be flagged when all tests use mocks for critical dependencies
- `untested_segments[].importance` SHOULD align with the flow's criticality

### 5.21 Temporal Stability (v1.7.0+)

- Stability MUST be calculated from git history (commits, blame)
- `stability_score` SHOULD be 0-100, where 100 is most stable
- Bug fix rate SHOULD be inferred from commit messages containing: "fix", "bug", "patch", "issue"
- `is_legacy` SHOULD be detected from comments containing "legacy", "deprecated", "old"
- `hotspots` MUST be flagged when `stability_class` is `'volatile'` or `'fragile'`
- `risk_correlation.high_churn_high_bugs` MUST be true when commits_30d > 5 AND bug_fix_rate > 0.3

### 5.22 Capability Detection by System Type (v1.7.0+)

Capability detection strategies MUST vary based on the detected system type:

**Web APIs/Backend Services:**
- Entry points (HTTP endpoints) map directly to capabilities
- Group entry points by resource domain (e.g., `/users/*` -> "User Management")
- Each endpoint's HTTP method indicates the operation type (GET=read, POST=create, etc.)
- Capabilities are discoverable from entry point paths and methods

**CLI Tools:**
- Entry points are subcommands (e.g., `scan`, `analyze`, `export`)
- Subcommands represent **invocation modes**, NOT business capabilities
- The same capability may be invoked by multiple subcommands with different parameters
- Capabilities MUST be detected by analyzing:
  - Function clusters that perform related operations
  - Call graph patterns from entry points
  - Semantic analysis of function names and purposes
  - Shared dependencies between functions
- Example: A security scanner with `quick`, `standard`, `deep` subcommands has capabilities like "port scanning", "web enumeration", "vulnerability detection" that are internal function clusters called by all modes

**Frontend Applications:**
- Entry points are routes/pages
- Capabilities emerge from services, hooks, and state management consumed by routes
- Multiple routes may share the same underlying capabilities
- Analyze component dependencies and service calls to determine capabilities

**Libraries:**
- Entry points are exported functions/classes
- Capabilities are the functionality domains the exports provide
- Group related exports into capability domains

### 5.23 Runtime-to-Static Correlation (v1.8.0+)

- `runtime_static_links` MUST reference existing entry points, exit points, call chains, external services, or telemetry hooks.
- `runtime_signal` MUST name the runtime metric, route, operation, service, or event stream that validates the static object.
- `telemetry_status` MUST be `observed` only when runtime evidence is present.
- Static-only candidates MUST use `instrumentable` or `not-instrumented` and SHOULD list concrete `instrumentation_points`.
- Runtime correlation MUST be emitted by CAS, not reconstructed by UI consumers.

### 5.24 Evidence and Confidence (v1.8.0+)

- `analysis_facts` SHOULD explain important CAS objects and relationships with evidence.
- Each fact MUST include at least one evidence item.
- Evidence SHOULD point to source locations, analyzer output, configuration, dependencies, routes, runtime signals, naming conventions, or graph structure.
- Confidence MUST be expressed as a number from 0 to 1.
- Cross-repository links SHOULD include `metadata.confidence` and evidence when the link is inferred rather than explicitly configured.

### 5.25 Graph Integrity (v1.8.0+)

- `validation.graph_integrity` SHOULD report dangling edges, orphaned nodes, entry point handler coverage, exit point source coverage, runtime instrumentation coverage, fact evidence coverage, and an aggregate relationship coverage score.
- `dangling_edges` MUST count every source or target reference that does not resolve to a node.
- `relationship_coverage_score` SHOULD be 0-100 and SHOULD combine source location, edge validity, entry/exit coverage, runtime link instrumentation, and analysis fact evidence.
- UI and MCP consumers SHOULD expose low integrity scores as trust warnings rather than silently rendering incomplete analysis.

### 5.26 Semantic Change Impact (v1.8.0+)

- Incremental `ChangeReport` objects SHOULD include `semantic_impact`.
- A changed node SHOULD be mapped to affected workflows, capabilities, data entities, and runtime links when those CAS objects reference the node directly or through a call chain.
- Added, modified, or deleted entry points, exit points, and repository links SHOULD be listed as changed contracts.
- `risk_reasons` SHOULD explain why the change matters beyond raw node or file counts.

## 6. Query Interface

### 6.1 Tag-Based Queries

Implementations SHOULD support:
- Union: Nodes with any specified tags
- Intersection: Nodes with all specified tags
- Exclusion: Nodes without specified tags

### 6.2 Perspective Queries

Implementations SHOULD support:
- Filtering by perspective presence
- Level-based queries within perspectives
- Hierarchy path matching

### 6.3 Progressive Disclosure

Implementations SHOULD support:
- Level-based retrieval
- Incremental detail loading
- Context preservation

### 6.4 Evidence, Runtime, and Change Queries

Implementations SHOULD support:
- Retrieving runtime-static links by kind, telemetry status, and static object ID
- Retrieving analysis facts by subject type, subject ID, and fact type
- Retrieving change history by time range, file, node, entry point, grouping, and hot spots
- Retrieving historical analysis snapshots by timestamp or snapshot ID
- Returning semantic impact for incremental changes when workflow, capability, data, or runtime context is available

## 7. Extensions

### 7.1 Extension Mechanism

Implementations MAY extend the specification by:
- Adding fields prefixed with underscore (_)
- Creating new analyzer perspectives
- Defining additional tag vocabularies
- Adding metadata to existing structures

### 7.2 Reserved Names

The following are reserved for future versions:
- Field names: version, schema, constraints, policies, workflows
- Tag prefixes: cas-, spec-, system-
- Perspective IDs: cas-*, spec-*

## 8. Security Considerations

### 8.1 Sensitive Information

- Source file paths MAY contain sensitive information
- Implementations SHOULD provide path sanitization options
- API keys and secrets MUST NOT appear in analysis results

### 8.2 Access Control

- The security context provides access level information
- Implementations SHOULD respect security classifications
- Query interfaces SHOULD enforce access controls

## 9. IANA Considerations

This document has no IANA actions.

## 10. Examples

### 10.1 Minimal Valid Output

```json
{
  "cas_version": "1.4.0",
  "analysis_timestamp": "2025-09-20T00:00:00Z",
  "analysis_id": "analysis_123",
  "system": {
    "id": "system_example",
    "name": "Example System",
    "root_path": "/path/to/system"
  },
  "nodes": [],
  "edges": [],
  "entry_points": [],
  "exit_points": [],
  "external_services": [],
  "analyzer_contributions": []
}
```

### 10.2 Complete Node with All v1.4.0 Features

```json
{
  "id": "function_user_service_create_user",
  "name": "createUser",
  "type": "function",
  "tags": ["async", "service", "user-management", "database-access"],

  "perspectives": {
    "nestjs-flow": {
      "hierarchy": ["UserModule", "UserService", "createUser"],
      "level": 2,
      "priority": 85,
      "metadata": {
        "injectable": true,
        "scope": "singleton"
      }
    }
  },

  "analyzers": ["typescript-analyzer", "nestjs-analyzer"],
  "primaryAnalyzer": "typescript-analyzer",

  "source": {
    "file": "src/user/user.service.ts",
    "line": 42,
    "column": 3,
    "end_line": 78,
    "end_column": 4
  },

  "documentation": {
    "type": "jsdoc",
    "raw": "/**\n * Creates a new user in the system\n * @param {CreateUserDto} userData - User creation data\n * @returns {Promise<User>} Created user entity\n * @throws {ConflictException} If email already exists\n * @since 1.2.0\n * @deprecated Use createUserV2 instead\n */",
    "summary": "Creates a new user in the system",
    "parameters": [
      {
        "name": "userData",
        "type": "CreateUserDto",
        "description": "User creation data"
      }
    ],
    "returns": {
      "type": "Promise<User>",
      "description": "Created user entity"
    },
    "throws": [
      {
        "type": "ConflictException",
        "description": "If email already exists"
      }
    ],
    "tags": [
      { "tag": "@since", "value": "1.2.0" },
      { "tag": "@deprecated", "value": "Use createUserV2 instead" }
    ]
  },

  "comments": [
    {
      "id": "comment_1",
      "type": "single-line",
      "style": "//",
      "text": "TODO: Add rate limiting to prevent spam",
      "purpose": "todo",
      "location": { "file": "src/user/user.service.ts", "line": 45 },
      "markers": { "is_todo": true }
    }
  ],

  "todos": [
    {
      "id": "todo_1",
      "type": "TODO",
      "text": "Add rate limiting to prevent spam",
      "priority": "medium",
      "location": {
        "file": "src/user/user.service.ts",
        "line": 45,
        "node_id": "function_user_service_create_user"
      },
      "classification": {
        "category": "security",
        "technical_debt": true
      }
    }
  ],

  "implementation_status": {
    "status": "partial",
    "indicators": {
      "has_todo_markers": true,
      "has_not_implemented_exceptions": false,
      "has_stub_returns": false,
      "has_placeholder_code": false,
      "has_hardcoded_values": false,
      "has_commented_out_code": false
    },
    "deprecation": {
      "is_deprecated": true,
      "deprecated_since": "1.2.0",
      "alternative": "createUserV2"
    }
  }
}
```

### 10.3 Method Call with Call Chain

```json
{
  "method_calls": [
    {
      "id": "call_1",
      "caller_node": "function_user_controller_register",
      "target_node": "function_user_service_create_user",

      "call_details": {
        "method_name": "createUser",
        "signature": "createUser(userData: CreateUserDto): Promise<User>",
        "location": {
          "file": "src/user/user.controller.ts",
          "line": 25,
          "column": 12
        },
        "call_type": "method",
        "resolution_type": "static"
      },

      "execution_context": {
        "is_async": true,
        "is_conditional": false,
        "is_in_loop": false,
        "is_recursive": false,
        "call_depth": 1,
        "conditional_depth": 0,
        "loop_depth": 0,
        "enclosing_function": "register",
        "enclosing_class": "UserController"
      },

      "framework_semantics": {
        "framework": "nestjs",
        "decorator_type": "@Post",
        "semantic_meaning": "HTTP POST handler",
        "route_info": {
          "method": "POST",
          "path": "/users/register",
          "parameters": ["userData"]
        }
      },

      "performance_hints": {
        "is_hot_path": true,
        "is_potential_bottleneck": false,
        "estimated_frequency": 1000,
        "is_critical_path": true
      }
    }
  ],

  "call_chains": [
    {
      "id": "chain_1",
      "chain_type": "entry-to-exit",

      "entry_point": {
        "node_id": "function_user_controller_register",
        "method_name": "register",
        "entry_point_id": "entry_post_users_register"
      },

      "exit_point": {
        "node_id": "function_user_repository_save",
        "method_name": "save",
        "exit_point_id": "exit_database_users"
      },

      "call_path": [
        {
          "call_id": "call_1",
          "node_id": "function_user_controller_register",
          "method_name": "register",
          "depth": 0
        },
        {
          "call_id": "call_2",
          "node_id": "function_user_service_create_user",
          "method_name": "createUser",
          "depth": 1
        },
        {
          "call_id": "call_3",
          "node_id": "function_user_repository_save",
          "method_name": "save",
          "depth": 2
        }
      ],

      "characteristics": {
        "total_calls": 3,
        "max_depth": 2,
        "has_external_calls": true,
        "has_database_calls": true,
        "has_async_calls": true,
        "is_circular": false,
        "is_recursive": false,
        "complexity_score": 12
      },

      "business_context": {
        "user_action": "User Registration",
        "business_process": "Onboarding",
        "feature_area": "Authentication"
      },

      "risk_analysis": {
        "risk_level": "medium",
        "risk_factors": ["database-dependency", "no-rate-limiting"],
        "bottlenecks": [
          {
            "node_id": "function_user_repository_save",
            "method_name": "save",
            "reason": "Database write operation",
            "impact": "medium"
          }
        ]
      }
    }
  ]
}
```

### 10.4 Framework Decorator Example

```json
{
  "decorators": [
    {
      "id": "decorator_1",
      "target_node": "function_user_controller_register",

      "decorator_info": {
        "name": "@Post",
        "type": "method",
        "framework": "nestjs",
        "source_location": {
          "file": "src/user/user.controller.ts",
          "line": 23,
          "column": 3
        }
      },

      "semantic_meaning": {
        "category": "routing",
        "behavior": "Registers HTTP POST endpoint",
        "affects_runtime": true
      },

      "parameters": [
        {
          "name": "path",
          "value": "register",
          "type": "string"
        }
      ],

      "routing_info": {
        "method": "POST",
        "path": "/users/register",
        "parameters": ["userData"],
        "guards": ["AuthGuard"],
        "middleware": ["ValidationPipe"]
      },

      "security_info": {
        "authentication_required": false,
        "roles": [],
        "permissions": []
      }
    }
  ]
}
```

## 11. Migration Guide

### 11.1 Upgrading from v1.0.0 to v1.1.0

**Required changes:**
- Add `entry_points`, `exit_points`, and `external_services` arrays (can be empty)
- Add `analyzer_contributions` array

**Optional enhancements:**
- Populate entry/exit points for system boundaries
- Add `analyzers` and `primaryAnalyzer` to nodes
- Include `disclosure` hints for progressive rendering

### 11.2 Upgrading from v1.1.0 to v1.2.0

**Required changes:**
- Update `cas_version` to "1.2.0"

**Optional enhancements:**
- Add `perspectives` array for multi-view support
- Add `perspectives` object to nodes for hierarchical organization
- Include perspective-specific metadata

### 11.3 Upgrading from v1.2.0 to v1.3.0

**Required changes:**
- Update `cas_version` to "1.3.0"

**Optional enhancements:**
- Add `method_calls` array for call graph tracking
- Add `call_chains` array for execution flow analysis
- Add `decorators` array for framework semantics
- Use new call graph edge types (`calls`, `invokes`, etc.)

### 11.4 Upgrading from v1.3.0 to v1.4.0

**Required changes:**
- Update `cas_version` to "1.4.0"

**Optional enhancements:**
- Add `documentation` to nodes for extracted docs
- Add `comments` array to nodes
- Add `todos` array for technical debt tracking
- Add `implementation_status` for maturity assessment
- Include summary structures (`documentation_summary`, `todos_summary`, `implementation_health`)

### 11.5 Upgrading from v1.4.0 to v1.5.0

**Required changes:**
- Update `cas_version` to "1.5.0"
- Set `parent` field for all class members (methods, properties, constructors)
- Use full paths in entry points (e.g., `/workspaces/:id` not just `:id`)
- Merge class-level and method-level guards in entry point security

**Optional enhancements:**
- Add `uses`, `depends_on`, `injects` edges for class-to-class relationships
- Add `variations` and `deviations` to patterns
- Include `aggregated_from` in class-level edges
- Filter out JS builtins from external services

### 11.6 Upgrading from v1.5.0 to v1.6.0

**Required changes:**
- Update `cas_version` to "1.6.0"
- Migrate test entry points from `type: 'event'` to `type: 'test'`
- Tests previously marked as `type: 'event'` with `metadata.event === 'test'` MUST use `type: 'test'`

**Optional enhancements:**
- Add `test_suites` array with `CASTestSuite` objects
- Add `mocks` array with `CASMock` objects tracking mock/stub/spy usage
- Add `fixtures` array with `CASFixture` objects
- Add `test_summary` with aggregated test statistics
- Add `test_coverage` to nodes to show which tests cover each function/class
- Add `tests`, `mocks`, `covers` edges for test-to-code relationships
- Extract BDD steps (Given/When/Then) into `bdd_steps` arrays
- Categorize tests by type (unit, integration, e2e, acceptance)

**Breaking changes:**
- Tests previously discoverable via `entry_points.filter(e => e.type === 'event' && e.metadata.event === 'test')` must now use `entry_points.filter(e => e.type === 'test')`

### 11.7 Upgrading from v1.6.0 to v1.7.0

**Required changes:**
- Update `cas_version` to "1.7.0"

**Optional enhancements:**
- Add `criticality`, `criticality_factors` to `CASCallChain` for flow importance
- Add `runtime_stats` to `CASCallChain` for SDK telemetry data
- Add `test_coverage` to `CASCallChain` for flow-level coverage
- Add `intents` array with `CASIntent` objects for inferred purpose
- Add `flow_summary` with critical flow statistics
- Add `change_risks` array with `CASChangeRisk` per-node risk assessment
- Add `change_risk_summary` with high-risk node aggregation
- Add `data_entities` array with `CASDataEntity` for entity lifecycle tracking
- Add `data_summary` with sensitive data and validation gap analysis
- Add `security_boundaries` array with `CASSecurityBoundary` trust model
- Add `security_contexts` array with per-node trust levels
- Add `security_summary` with protection gap analysis
- Add `flow_coverage` array with `CASFlowCoverage` flow-level test coverage
- Add `test_gaps` array with `CASTestGap` coverage gaps
- Add `temporal_stability` array with `CASTemporalStability` churn metrics
- Add `stability_summary` with hotspot and legacy area analysis

**Implementation requirements:**
- Git integration required for intent inference and temporal stability
- SDK telemetry integration required for runtime_stats
- Call graph traversal required for downstream impact analysis

**Breaking changes:**
- None. All new fields are optional.

### 11.8 Upgrading from v1.7.0 to v1.8.0

**Required changes:**
- Update `cas_version` to "1.8.0"

**Optional enhancements:**
- Implement `analyzeFileSingle()` in language analyzers for incremental analysis
- Track `IncrementalState` between analysis runs
- Generate `ChangeReport` for each incremental analysis
- Store `ChangeHistoryEntry` records for change queries
- Implement change detection using mtime, git, or content hash
- Emit `runtime`, `runtime_static_links`, and instrumentation readiness so static analysis can be validated by telemetry
- Emit `analysis_facts` with confidence and evidence for nodes, edges, flows, capabilities, runtime links, and repository links
- Include `semantic_impact` in change reports for affected workflows, capabilities, data entities, contracts, and runtime links
- Include confidence and evidence on cross-repository links inferred from APIs, shared packages, message contracts, schemas, or database usage

**New analyzer interface:**
```typescript
interface BaseAnalyzer {
  // Existing methods...

  // New in v1.8.0
  supportsIncrementalAnalysis(): boolean;
  analyzeFileSingle?(context: FileAnalysisContext): Promise<FileAnalysisResult>;
  getRelevantFiles?(projectPath: string): Promise<string[]>;
}
```

**Breaking changes:**
- None. All new fields and features are optional.

### 11.9 Backward Compatibility

All versions maintain backward compatibility:
- New fields are optional
- Existing fields retain their semantics
- Older outputs remain valid in newer versions
- Analyzers can progressively adopt new features

## Appendices

### Appendix A: Version History

- **v1.0.0** (2024-01-01): Initial release
  - Core node and edge structures
  - Basic metadata support
  - System information

- **v1.1.0** (2024-06-01): Boundaries and Enrichment
  - Entry and exit points
  - External services
  - Analyzer contributions
  - Progressive disclosure hints

- **v1.2.0** (2024-09-19): Multi-Perspective Analysis
  - Perspective support for multiple views
  - Enhanced node organization
  - Perspective-aware edges

- **v1.3.0** (2025-01-01): Call Graph Tracking
  - Method call analysis
  - Call chain reconstruction
  - Decorator/annotation semantics
  - Performance hints

- **v1.4.0** (2025-09-20): Documentation Extraction
  - Structured documentation parsing
  - Comment classification
  - TODO/FIXME tracking
  - Implementation status assessment
  - System health metrics

- **v1.5.0** (2026-01-09): Class Relationships & Pattern Analysis
  - Class-to-class relationship edges (uses, depends_on, injects)
  - Pattern variation and deviation tracking
  - Enhanced entry points with full paths
  - Merged class/method-level guards
  - Required parent field for class members
  - External services filtering (no builtins)

- **v1.6.0** (2026-01-23): Test Architecture & Visualization
  - New `'test'` entry point type (replaces event-based test detection)
  - Test categorization (unit, integration, e2e, acceptance, bdd)
  - Test suite and test case structures
  - BDD step extraction (Given/When/Then)
  - Mock and fixture node tracking
  - Test-to-code edge types (tests, mocks, covers, validates)
  - Per-node test coverage integration
  - Aggregated test summary statistics

- **v1.7.0** (2026-01-25): Inference-Based Intelligence
  - Intent inference from commits, comments, and pattern deviations
  - Critical flow enhancement to CASCallChain (criticality, runtime_stats, test_coverage)
  - Flow summary for critical path statistics
  - Per-node change risk assessment with downstream impact analysis
  - Entity-centric data lifecycle tracking
  - Security boundary and trust level modeling
  - Flow-level test coverage with gap analysis
  - Git-based temporal stability metrics (churn, bug fix rate, legacy detection)

- **v1.8.0** (2026-02-05): Incremental Analysis
  - Multi-tier change detection (mtime, git, content hash)
  - File-level analysis with import/export tracking
  - Incremental state management between analysis runs
  - Change set detection with dependency propagation
  - Rich change reporting with node/edge diffs
  - Change history storage and querying
  - Impact analysis for changes
  - Full rebuild triggers for major changes
  - Runtime-static correlation and instrumentation readiness
  - Evidence-backed analysis facts with confidence
  - Semantic impact reporting for workflows, capabilities, data entities, and contracts
  - Cross-repository link confidence and evidence

### Appendix B: Language Support

Documentation patterns supported by language:

| Language | Doc Format | Comment Styles | TODO Markers |
|----------|------------|----------------|--------------|
| TypeScript/JavaScript | JSDoc, TypeDoc | //, /* */ | TODO, FIXME, HACK, NOTE |
| Python | Docstring (Google, NumPy, Sphinx) | # | TODO, FIXME, HACK, NOTE |
| Java | JavaDoc | //, /* */ | TODO, FIXME, XXX |
| C# | XML Doc | //, /* */, /// | TODO, FIXME, HACK |
| Go | GoDoc | //, /* */ | TODO, BUG, FIXME |
| Rust | RustDoc | //, /* */, ///, //! | todo!(), unimplemented!() |
| PHP | PHPDoc | //, /* */, # | TODO, FIXME, HACK |

### Appendix C: Framework Support

Framework-specific features supported:

| Framework | Decorators | Entry Points | Documentation |
|-----------|------------|--------------|---------------|
| NestJS | @Controller, @Get, @Post, @Injectable | HTTP endpoints | Swagger integration |
| Spring Boot | @RestController, @GetMapping | REST endpoints | JavaDoc + Swagger |
| Express | N/A | Route handlers | JSDoc |
| Django | N/A | URL patterns | Docstrings |
| React | N/A | Component exports | JSDoc + PropTypes |
| Angular | @Component, @Injectable | Components | TypeDoc |
| FastAPI | N/A | Route decorators | Docstrings + OpenAPI |

### Appendix D: Implementations

Known implementations of this specification:

- **Unravl Analyzer Framework** (Reference Implementation)
  - Full v1.4.0 support
  - Multi-language analyzers
  - Framework-specific analyzers

- **Community Implementations**
  - [Contributions welcome]

### Appendix E: References

- [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt) - Key words for use in RFCs
- [JSON Schema](https://json-schema.org/) - Schema validation
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) - Code analysis concepts
- [SARIF](https://www.oasis-open.org/committees/sarif/) - Static analysis format inspiration

## Copyright Notice

Copyright (c) 2024-2025 Unravl Team. This specification is released under the MIT License.

## Contact

- Specification repository: https://github.com/unravl/cas-specification
- Issue tracker: https://github.com/unravl/cas-specification/issues
- Discussion forum: https://github.com/unravl/cas-specification/discussions
