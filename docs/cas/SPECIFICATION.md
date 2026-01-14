# Code Analysis Specification (CAS)

**Version:** 1.5.0
**Status:** Active
**Last Updated:** 2026-01-09

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

This document specifies version 1.5.0 of the Code Analysis Specification. The evolution of CAS includes:

- **[Version 1.0.0](./v1.0.0.md)** (2024-01-01) - Initial release with core nodes, edges, and basic metadata
- **[Version 1.1.0](./v1.1.0.md)** (2024-06-01) - Added progressive levels, entry/exit points, and extended metadata
- **[Version 1.2.0](./v1.2.0.md)** (2024-09-19) - Added multi-perspective support and enhanced patterns
- **[Version 1.3.0](./v1.3.0-rfp.md)** (2025-01-01) - Added comprehensive call graph tracking and method invocation analysis
- **[Version 1.4.0](./v1.4.0-rfp.md)** (2025-09-20) - Added documentation and comment extraction
- **[Version 1.5.0](./v1.5.0-rfp.md)** (2026-01-09) - Current version - Added class-level relationships, pattern variations, and enhanced entry points

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
  cas_version: "1.5.0";
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

  repository_links?: RepositoryLink[];
  dependencies?: Dependencies;
  disclosure?: DisclosureHints;     // Added in v1.1.0
  analyzer_contributions: AnalyzerContribution[];

  perspectives?: CASPerspective[];  // Added in v1.2.0

  method_calls?: CASMethodCall[];   // Added in v1.3.0
  call_chains?: CASCallChain[];     // Added in v1.3.0
  decorators?: CASDecorator[];      // Added in v1.3.0

  documentation_summary?: CASDocumentationSummary;  // Added in v1.4.0
  todos_summary?: CASTodoSummary;                   // Added in v1.4.0
  implementation_health?: CASImplementationHealth;  // Added in v1.4.0

  patterns?: CASPattern[];          // Enhanced in v1.5.0 with variations

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

```typescript
interface EntryPoint {
  id: string;
  type: 'http' | 'grpc' | 'graphql' | 'websocket' | 'cli' |
        'event' | 'scheduled' | 'startup' | 'other';
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
  type: 'database' | 'api' | 'file' | 'cache' | 'queue' |
        'email' | 'storage' | 'other';
  name: string;
  description?: string;

  target: {
    system?: string;      // External system name
    endpoint?: string;    // API endpoint, table name, etc.
    protocol?: string;    // HTTP, AMQP, etc.
  };

  operations?: Array<{
    type: string;         // SELECT, INSERT, GET, POST, etc.
    frequency?: 'high' | 'medium' | 'low';
  }>;

  calling_nodes: string[]; // Node IDs that use this exit

  authentication?: {
    method?: string;
    config_location?: string;
  };

  metadata?: Record<string, any>;
}
```

#### ExternalService
Third-party service dependencies:

```typescript
interface ExternalService {
  id: string;
  name: string;
  type: 'api' | 'database' | 'cache' | 'queue' | 'storage' |
        'auth' | 'payment' | 'notification' | 'analytics' | 'other';
  provider?: string;
  version?: string;

  connection: {
    protocol: string;
    host?: string;
    port?: number;
    path?: string;
  };

  usage: {
    nodes: string[];      // Node IDs using this service
    operations: string[];
    frequency?: 'high' | 'medium' | 'low';
  };

  configuration?: {
    source?: 'environment' | 'file' | 'hardcoded';
    location?: string;
  };

  criticality?: 'critical' | 'important' | 'optional';

  is_builtin?: boolean;          // v1.5.0: true for Object, Array, Promise, etc.
  is_standard_library?: boolean; // v1.5.0: true for fs, path, crypto, etc.

  metadata?: Record<string, any>;
}
```

### 4.8 Pattern Detection with Variations (v1.5.0)

#### CASPattern
Architectural and design patterns with variation tracking:

```typescript
interface CASPattern {
  id: string;
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

### 4.9 Summary and Health Structures (v1.4.0)

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

### 4.9 Core Supporting Types

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

### 11.6 Backward Compatibility

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