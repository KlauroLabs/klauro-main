# Unravl MCP Server - Tools Reference

All tools that query analysis data require a `path` parameter - the absolute filesystem path of a previously analyzed project. Run `analyze_codebase` first to generate the analysis, then query it with any other tool.

---

## Analysis Management

### `analyze_codebase`

Run full CAS analysis on a local directory. Detects languages, frameworks, and libraries automatically. Stores results as JSON for subsequent querying.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |

**Returns:** Condensed summary (same format as `get_summary`).

### `list_analyses`

List all previously analyzed codebases with metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Returns:** Array of `{ name, path, file, analyzed_at, system_type, frameworks, node_count, edge_count }`.

---

## System-Level Understanding

### `get_summary`

The first tool to call when orienting on a codebase. Returns a condensed intelligence summary covering all major dimensions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path (must be previously analyzed) |

**Returns:**
- `cas_version` - CAS specification version
- `analysis_timestamp`, `analysis_id`
- `system_purpose` - Primary type, confidence, evidence, secondary types
- `enhanced_system_purpose` - Primary domain, core concepts, inferred description
- `flow_graph` summary - Capabilities count, dependencies count, primary flow (core capability, value chain), system insights (detected patterns, entry type, data flow type), top 15 capabilities sorted by score with operations
- `architecture_summary` - System type, total files, layers breakdown, API surface, external dependencies, security
- `database_entities` - Entity names from schema
- `entry_point_count` and breakdown by type
- `node_counts` - Total + by type
- `edge_counts` - Total + by type
- `analyzer_contributions` - Which analyzers ran: `analyzer_id`, `analyzer_name`, `analyzer_type`, nodes/edges contributed, execution time, `analysis_scope` (files analyzed, files skipped, patterns detected)
- `analysis_errors` - Count and severity breakdown

### `get_system_overview`

Full system metadata without condensation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `system`, `architecture_summary`, `system_purpose`, `enhanced_system_purpose`, `system_capabilities`, `progressive_levels`, `analyzer_contributions`, `analysis_errors`, `configuration`, `runtime`, `repository_links`, `disclosure`, `validation`.

### `get_patterns`

Design patterns and anti-patterns detected in the codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `patterns` (with variations, deviations, instances), `categories`, `behaviors`.

### `get_perspectives`

Multi-view analysis perspectives with connection rules and layout hints.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Array of perspectives with connection rules and layout configuration.

---

## Navigation and Search

### `search_nodes`

Find code elements by name, qualified name, or description. Supports filtering by type, category, and hierarchy level. Multi-word queries use camelCase-aware matching -- searching "react analyzer" will match `ReactAnalyzer`, `react-analyzer`, etc.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `query` | string | yes | Search text (matches name, qualified_name, description). Multi-word queries also match across camelCase/kebab-case/snake_case boundaries |
| `type` | string | no | Filter by node type (class, function, module, service, controller, etc.) |
| `category` | string | no | Filter by category |
| `level` | number | no | Filter by hierarchy level |
| `limit` | number | no | Max results (default 25) |

**Returns:** Array of `{ id, name, type, qualified_name, category, level, level_name, file, line, description, tags }`.

### `get_node`

Full details for a single code element including all connected data.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID (from search results or other tools) |

**Returns:** Full node with `signature`, `metadata`, `documentation`, `call_graph`, `implementation_status`, `todos`, `children`, plus enrichments: `incoming_edges`, `outgoing_edges`, `entry_points`, `exit_points`, `decorators`, `intent`, `change_risk`, `stability`, `resolved_children`.

### `get_file_nodes`

All code elements defined in a specific file with their internal relationships.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `file_path` | string | yes | Relative file path within the project |

**Returns:** `nodes` (array with id, name, type, category, level, line, end_line, description, parent, children) and `edges` (internal edges between nodes in the file).

### `get_level`

Progressive disclosure. Get everything at a specific hierarchy level -- the level definition, all nodes at that level, internal edges between them, cross-level edges connecting to other levels, and entry/exit points. Use this to navigate the codebase top-down: start at level 0 (system), drill to level 1 (subsystems), then deeper for more detail.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `level` | number | yes | Hierarchy level (0 = system, 1 = subsystems, deeper = more detail) |

**Returns:**
- `level` - The requested level number
- `definition` - Level metadata (name, description, node_count, recommended_for, example_nodes, contains)
- `total_levels` - Total number of levels in the analysis
- `available_levels` - All levels with name and node count (for navigation)
- `nodes` - All nodes at this level (id, name, type, qualified_name, category, file, line, description, parent, children, tags)
- `internal_edges` - Edges between nodes at this level
- `cross_level_edges` - Edges connecting to nodes at other levels, with the external node's id, name, type, and level
- `entry_points` - Entry points associated with nodes at this level
- `exit_points` - Exit points associated with nodes at this level

---

## Entry/Exit Points and Routes

### `get_entry_points`

All system entry points. Entry points are where external requests or events enter the system.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `type` | string | no | Filter: http, websocket, cli, event, schedule, page, route, message, file, test |

**Returns:** Array of entry points with handler, security, trigger, input/output schemas, connected nodes.

### `get_exit_points`

All external interactions where the system reaches out to external services or resources.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `type` | string | no | Filter: database, api, file, message, cache, sdk, webhook |

**Returns:** Array of exit points with target, operation, reliability config, connected nodes.

### `get_route_table`

HTTP route table extracted from framework analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Array of `{ method, path, controller, handler, auth, guards, middleware }`.

### `get_external_services`

All external service integrations detected in the codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Array of services with purpose, endpoint, usage pattern, monitoring, cost info.

---

## Call Graph and Flow Tracing

### `get_callers`

Find all code elements that call or reference a given node. Traverses both edges and method calls.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to find callers for |
| `depth` | number | no | Max traversal depth (default 2) |

**Returns:** Array of `{ node_id, name, type, depth, via }`. The `via` field indicates the relationship type (e.g., `edge:calls`, `method_call:findAll`).

### `get_callees`

Find all code elements that a given node calls or references.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to find callees for |
| `depth` | number | no | Max traversal depth (default 2) |

**Returns:** Same format as `get_callers`.

### `get_call_chain`

Complete call chains from entry to exit. A call chain represents a full request path through the system.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `chain_id` | string | no | Specific call chain ID |
| `entry_point_id` | string | no | Entry point ID to find chains for |

If neither optional param is given, returns all chains.

**Returns:** Call chain(s) with all steps, characteristics, risk analysis, business context, criticality, runtime stats, test coverage.

### `get_method_calls`

All method calls involving a specific node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID |

**Returns:** `{ made_by, received_by }` - arrays of method calls with execution context (async, conditional, loop depth), arguments, external details, framework semantics, performance hints.

---

## Intelligence (CAS v1.7.0)

### `get_intent`

Why code exists - inferred purpose and architectural reasoning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID |

**Returns:** Inferred purpose, constraints, architectural decisions with evidence, workaround indicators.

### `get_data_entities`

Data entity lifecycle analysis - how data flows through the system.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `entity_name` | string | no | Filter by entity name |

**Returns:** `entities` (fields, CRUD lifecycle with created_by/read_by/updated_by/deleted_by, transformations, invariants) and `data_summary` (sensitive data nodes, validation gaps).

### `get_security_overview`

Security posture of the analyzed system.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `security_boundaries` (trust transitions, enforcement points, bypass risks), `security_summary` (unprotected ops, enforced vs assumed vs missing), `security_contexts` (per-node trust levels, protection gaps).

### `get_stability`

Code stability and churn analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | no | Specific node (omit for full summary) |

**Per-node returns:** Stability score, stability class, commit metrics (30d/90d), bug fix rate, refactor frequency.

**Summary returns:** `stability_summary` (hotspots, legacy areas, by-class breakdown) and `temporal_stability` (all nodes).

### `assess_change_risk`

Risk assessment for modifying a specific code element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to assess |

**Returns:** `risk` (risk_level, risk_factors like many-callers/critical-path/no-tests, downstream_impact with direct/transitive callers and affected chains/entry points, test_protection, stability_context, recommendations) and `change_risk_summary`.

### `get_flow_coverage`

Per-flow test coverage analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `chain_id` | string | no | Specific call chain ID (omit for all flows) |

**Per-chain returns:** `coverage` (coverage_status, tested/untested segments with importance, test quality) and related `test_gaps`.

**Summary returns:** `flow_summary`, all `coverage` entries, all `test_gaps` with severity and recommendations.

---

## Workflows and Capabilities

### `get_workflows`

Business workflows detected from analyzing entry-to-exit paths.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `workflow_id` | string | no | Specific workflow ID (omit for all) |

**Returns:** Workflows (CRUD/process/query/command/composite) with entry points, call chains, entities touched, services used, classification, criticality, dependencies. Plus `workflow_graph` with dependency links and critical shared nodes.

### `get_flow_graph`

Capability-level architecture view.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `flow_graph` with capabilities (scored), dependencies, topology (root/leaf/critical path nodes), primary flow (value chain), layers (entry/business/data/infrastructure), system insights (detected patterns, entry type, data flow type).

### `get_domain_concepts`

Core domain terminology extracted from the codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Domain concepts with frequency, where they appear (entry points, entities, nodes), classification (core/supporting/infrastructure).

---

## Testing

### `find_tests`

Find test suites and test cases covering a specific node or file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | no | Node ID to find tests for |
| `file_path` | string | no | File path to find tests for |

If neither optional param is given, returns all tests.

**Returns:** `suites` (test suites with test cases, assertions, coverage info), `mocks`, `fixtures`.

### `get_test_summary`

Full test overview across the entire codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `test_summary` (counts by type/status, coverage percentage, mocks total, fixtures total) and `test_gaps` (untested flows, branches, mock-only coverage, no-assertion tests, with severity and recommendations).

---

## Data and Schema

### `get_database_schema`

Database schema extracted from ORM analysis (Prisma, MikroORM, TypeORM, Eloquent, etc.).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Schema with ORM name, entities, fields (types, constraints, defaults), relationships (1:1, 1:N, M:N with foreign keys).

---

## Code Health

### `get_implementation_health`

Implementation completeness across the codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `health_score`, counts (complete/partial/stub/deprecated/experimental), risk areas with risk level and recommendations, deprecation timeline.

### `get_documentation_coverage`

Documentation quality metrics.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Coverage by type (functions, classes, interfaces, modules), quality metrics, missing documentation ranked by importance.

### `get_todos`

TODO/FIXME/HACK tracking across the codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Counts by type/priority/category, tech debt items, blocking items, hotspot files.

---

## Dependencies and Libraries

### `get_dependencies`

Package-level dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Packages with versions, licenses, vulnerabilities.

### `get_libraries`

Library usage analysis with optimization insights.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Libraries with usage patterns, bundle size, security info, usage stats, optimization opportunities, replacement feasibility, alternatives.
