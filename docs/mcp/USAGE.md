# Unravl MCP Server - Usage Guide

## Typical Workflow

### 1. Analyze a Codebase

Before querying, analyze the target project:

```
Use the analyze_codebase tool with path="/absolute/path/to/your/project"
```

This runs the full CAS pipeline: language detection, framework detection, library detection, AST parsing, relationship extraction, flow analysis, and intelligence generation. Results are stored as JSON at `~/.unravl/analyses/`.

### 2. Orient with get_summary

After analysis, call `get_summary` to understand the system at a high level:

```
Use the get_summary tool with path="/absolute/path/to/your/project"
```

This returns the condensed intelligence view: what the system does, its tech stack, architecture layers, key capabilities, and scale metrics.

### 3. Navigate Progressively

Use `get_level` to explore the codebase top-down:

1. `get_level` with `level=0` -- system-wide view (root modules, packages)
2. `get_level` with `level=1` -- major subsystems (controllers, services, core modules)
3. `get_level` with `level=2` -- individual components (classes, functions, handlers)
4. Continue deeper as needed

Each call returns the available levels with node counts, so you always know what's above and below. Cross-level edges show how the current level connects to others.

### 4. Drill Into Specifics

From there, drill into targeted areas:

- **Understand the API surface**: `get_entry_points`, `get_route_table` (paginated, use `limit`/`offset`)
- **Explore data model**: `get_database_schema`, `get_data_entities` (paginated)
- **Find specific code**: `search_nodes` with query text
- **Trace execution**: `get_callers` / `get_callees` / `get_call_chain` (use `chain_id` for full detail)
- **Assess safety**: `assess_change_risk` before modifying code
- **Check test coverage**: `find_tests`, `get_test_summary`, `get_flow_coverage` (use `chain_id` for per-flow detail)
- **Review security**: `get_security_overview`
- **Discover patterns**: `get_patterns` (summaries), `get_pattern_instances` (drill into specific pattern)
- **Explore concepts**: `get_domain_concepts` (filterable, paginated)

---

## Common Scenarios

### Starting a coding session

Use the `architectural_context` prompt to inject full system awareness:

```
Use the architectural_context prompt with path="/absolute/path/to/your/project"
```

This gives the AI assistant knowledge of system type, tech stack, architecture layers, API routes, database schema, capabilities, security posture, and design patterns -- all in a single context injection.

### Before modifying code

1. Find the node: `search_nodes` with the function/class name
2. Get full context: `get_node` with the node_id
3. Check risk: `assess_change_risk` with the node_id
4. Review callers: `get_callers` to understand who depends on it
5. Find tests: `find_tests` for the node_id

Or use the `safe_modification_guide` prompt which composes all of these into a single output.

### Understanding a feature

1. Search for relevant nodes: `search_nodes`
2. Get the node details: `get_node`
3. Trace the call chain: `get_call_chain` from the entry point
4. Check what it calls: `get_callees`
5. See the workflow: `get_workflows`

### Reviewing test quality

Use the `test_coverage_analysis` prompt, or individually:

1. `get_test_summary` for overall metrics
2. `get_flow_coverage` to see which execution paths are tested
3. `find_tests` for specific nodes or files

### Investigating security

1. `get_security_overview` for boundaries and enforcement status
2. `get_entry_points` to see all system inputs
3. `get_exit_points` to see all external interactions
4. `assess_change_risk` for nodes in security-sensitive areas

---

## Re-analyzing

Run `analyze_codebase` again on the same path to refresh the analysis. The previous result is overwritten. The stored JSON file at `~/.unravl/analyses/` is replaced with the new output.

## Multiple Projects

Each analyzed project is stored separately. Use `list_analyses` to see all analyzed codebases. Tools accept the `path` parameter to specify which project to query.

## Supported Languages and Frameworks

### Languages
- TypeScript/JavaScript
- Python
- Java
- C#
- Go
- Rust
- PHP

### Frameworks
- NestJS
- Spring Boot
- Django
- Flask
- FastAPI
- Laravel
- Symfony
- Express.js
- React
- Angular
- Vue.js
- Next.js
- Jest
- Cypress
- WPF
- ASP.NET Core

### Libraries
- Prisma ORM
- Socket.io
