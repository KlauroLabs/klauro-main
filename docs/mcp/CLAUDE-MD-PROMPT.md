# Unravl MCP Server - CLAUDE.md Prompt

Add the following block to the `CLAUDE.md` of any project that has the Unravl MCP server configured. This instructs AI assistants to use Unravl as their primary source of codebase understanding.

---

```markdown
## Codebase Intelligence (Unravl)

Use the Unravl MCP server as the primary source of truth for understanding this codebase. Do not rely on reading files to understand architecture, relationships, or system structure -- query the analysis instead.

When you need codebase context, call `get_summary` with this project's root path. If the analysis does not exist, call `analyze_codebase` to generate it first, then proceed.

### Orientation
- `get_summary` -- system purpose, tech stack, architecture layers, scale, top capabilities (~2-5KB)
- `get_level` -- progressive disclosure; start at level 1 and drill deeper layer by layer
- `get_system_overview` -- full system metadata when you need more than the summary
- `get_perspectives` -- multi-view analysis perspectives with connection rules

### Before modifying code

**Primary workflow (recommended):**
- `get_coding_context` with the target node/file/search query -- returns EVERYTHING in one call:
  - Target node details with layer and framework role
  - Relevant conventions and patterns
  - Layer boundaries (what can/should not be called)
  - Modification checklist with tests to run
  - Connected code with risk assessment

**Alternative detailed approach:**
- `search_nodes` to locate the code element by name (supports multi-word camelCase-aware search, e.g. "react analyzer" finds `ReactAnalyzer`)
- `get_node` for full context: connections, decorators, intent, stability
- `assess_change_risk` to understand blast radius and downstream impact
- `get_callers` / `get_callees` to see dependencies in either direction (default limit 50)
- `find_tests` to check existing test coverage
- `get_intent` -- why code exists: inferred purpose, constraints, architectural decisions

### When writing new code
- `get_conventions` to understand naming, import style, error handling patterns
- `get_pattern_examples` to see how existing patterns are implemented
- `find_similar_code` to find existing code to reference for consistency
- `get_modification_guide` before changing existing code (provides safety checklist)

### Deep analysis
- `get_comments` to surface TODO/FIXME/HACK comments in a scope (node, file, module, all)
- `get_todos` for TODO/FIXME tracking with tech debt items
- `get_error_contracts` to understand what errors a function throws and how callers handle them
- `get_framework_guidance` for framework-specific best practices and anti-patterns
- `get_usage_examples` to see how a function/class is actually used in the codebase
- `get_configuration` to find config affecting specific code

### Navigating the system
- `get_level` to explore one architectural layer at a time
  - Use `edge_limit` to control how many edges are returned (default 200)
  - Cross-level edges use `node_refs` for deduplication -- look up external nodes by ID
  - `pagination.has_more` tells you if more nodes exist
- `get_entry_points` for system entry points (HTTP, WebSocket, CLI, events, schedules)
- `get_exit_points` for external interactions (database, API, file, message, cache)
- `get_route_table` for HTTP routes with controllers, handlers, auth, guards, middleware
- `get_external_services` for external service integrations
- `get_call_chain` to trace full execution paths from entry to exit (summaries by default; use `chain_id` for detail)
- `get_callers` / `get_callees` to traverse call graph (default limit 50; `truncated` field indicates more exist)
- `get_method_calls` for method calls with execution context (async, conditional, loop depth)
- `get_file_nodes` to understand everything in a specific file

### Data and security
- `get_database_schema` for schema from ORM analysis (entities, fields, relationships)
- `get_data_entities` for data lifecycle (CRUD operations, transformations, validation gaps)
- `get_security_overview` for trust boundaries, enforcement points, protection gaps

### Testing and quality
- `get_test_summary` for test overview (counts, coverage, gaps)
- `get_flow_coverage` for per-flow test coverage (use `chain_id` for per-flow detail)
- `find_tests` to find tests covering a specific node or file
- `get_implementation_health` for completeness (stubs, partials, deprecations)
- `get_stability` for churn hotspots (use `node_id` for per-node detail)
- `get_documentation_coverage` for doc quality metrics

### Patterns and concepts
- `get_patterns` for detected design patterns (summaries with counts, not instances)
- `get_pattern_instances` to drill into a specific pattern's node IDs
- `get_pattern_examples` for actual working code examples of a pattern
- `get_domain_concepts` for core terminology (filterable by classification, paginated)
- `find_similar_code` for code similarity and reuse recommendations

### Behaviors and lifecycle
- `get_behaviors` for system behaviors with execution flows (use `behavior_id` for full detail)
- `get_lifecycle_hooks` for framework lifecycle hooks -- init, mount, update, destroy (filterable by `phase` and `framework`)

### Workflows and capabilities
- `get_workflows` for business workflows (use `workflow_id` for full detail)
- `get_flow_graph` for capability-level architecture with scores, dependencies, topology

### Dependencies
- `get_dependencies` for package dependencies with versions, licenses, vulnerabilities
- `get_libraries` for library usage analysis with optimization opportunities

### Management
- `list_analyses` to see all previously analyzed codebases
- `analyze_codebase` to run analysis on a new codebase

### Token efficiency

**Default limits (tune with parameters):**
- `get_level`: 50 nodes, 200 edges, 25 entry/exit points
- `get_callers` / `get_callees`: 50 results
- `get_coding_context`: ~5-10KB comprehensive response
- Most list tools: 25-50 items

**Strategies:**
- Start with `get_summary` (~2-5KB) to orient
- Use `get_coding_context` instead of multiple separate calls when coding
- Use `get_level` with default limits to explore architecture
- Check `pagination.has_more` / `truncated` / `edges_summary` to know if data was truncated
- Pass specific IDs to tools like `get_call_chain`, `get_workflows`, `get_stability`, `get_behaviors` for full detail
- Use filters (`type`, `method`, `classification`, `query`, `phase`, `framework`) to narrow results before paginating
- Set `include_edges: false` or `include_entry_exit: false` on `get_level` if you only need nodes
- Use `include` parameter on `get_coding_context` to request only needed sections

**Response structure:**
- Cross-level edges return `external_id` references, not embedded objects
- Look up external nodes in the `node_refs` map for deduplication

Do not guess at how the system is structured. Query the analysis.
```
