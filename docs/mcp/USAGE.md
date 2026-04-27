# Unravl MCP Server - Usage Guide

The MCP server is the agent-facing surface over CAS. It gives AI coding assistants the same source-of-truth graph the UI uses for human inspection.

## Typical Workflow

### 1. Analyze a Codebase

Before querying, analyze the target project:

```
Use the analyze_codebase tool with path="/absolute/path/to/your/project"
```

This runs the CAS pipeline: language detection, framework detection, library detection, AST parsing, relationship extraction, flow analysis, and intelligence generation. When prior incremental state exists, the analyzer reuses it; set `force_full=true` to force a full rebuild.

Results and analysis support files are stored under `~/.unravl/analyses/` unless `UNRAVL_STORAGE_PATH` is configured.

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
- **Understand recent changes**: `get_changes_since`, `get_change_summary`, `get_hot_spots`, `get_analysis_snapshots`
- **Prove answerability**: `run_answer_pack` with `pack="mastery"`
- **Connect repos**: `get_cross_repo_links` with related analyzed paths
- **Map runtime back to code**: `correlate_runtime_event`, `record_runtime_event`, `get_runtime_observations`

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

### Proving a repo is understandable

Run the mastery answer pack:

```
Use the run_answer_pack tool with path="/absolute/path/to/project" and pack="mastery"
```

This returns deterministic answers for overview, entry points, representative flow, change impact, data, tests, external boundaries, security, and runtime readiness. Each answer includes CAS evidence and follow-up tools for deeper work.

For an agent-facing demo sequence:

```
Use the get_mcp_demo_flow tool with path="/absolute/path/to/project"
```

This returns the exact MCP script to analyze, explain, trace, assess impact, connect repos, and inspect runtime correlation.

### Linking multiple repositories

Analyze each repository first, then call:

```
Use the get_cross_repo_links tool with paths=["/repo/a", "/repo/b", "/repo/c"]
```

When `paths` is omitted, the tool considers all stored analyses. It detects API links, shared databases, message contracts, and shared internal libraries with confidence and evidence.

### Correlating runtime signals

To check where a runtime request or error belongs in CAS without storing it:

```
Use correlate_runtime_event with path="/repo" and event={ "type": "request", "method": "GET", "route": "/api/users/:id" }
```

To store the observation:

```
Use record_runtime_event with path="/repo" and the same event payload
```

Then query observations:

```
Use get_runtime_observations with path="/repo", type="error", or static_id="<cas-id>"
```

Runtime events can include `signal`, `static_id`, `node_id`, `entry_point_id`, `exit_point_id`, `call_chain_id`, route details, status, duration, error message, stack trace, and arbitrary attributes.

### Checking runtime readiness and evidence

1. Use `get_runtime_static_links` to see which entry points, exit points, call chains, and external services have runtime signals or instrumentation candidates.
2. Filter by `telemetry_status=instrumentable` to find the next best instrumentation points.
3. Use `get_analysis_facts` for source-backed claims behind nodes, edges, workflows, capabilities, runtime links, and repository links.
4. Use `subject_id` when you need evidence for one concrete CAS object.

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

### Understanding recent work

1. `get_analysis_snapshots` to see available analysis snapshots
2. `get_changes_since` for raw change history after a timestamp
3. `get_change_summary` grouped by `file`, `module`, `author`, `intent`, `day`, or `week`
4. `get_hot_spots` to find high-change or bug-prone files
5. `get_changes_for_node`, `get_changes_for_file`, or `get_changes_for_entry_point` for targeted impact history

---

## Re-analyzing

Run `analyze_codebase` again on the same path to refresh the analysis.

Storage behavior:

- The main `{slugified-project-name}.json` analysis file is replaced with the latest CAS output.
- `index.json` continues to map project paths to the latest analysis file.
- Per-project incremental state is stored under a project directory inside `~/.unravl/analyses/`.
- File-level cache entries are stored under that project directory's `file-cache/`.
- Change history is stored as `change-history.json`.
- Analysis snapshots are stored under `snapshots/` and capped by the MCP storage layer.
- Runtime observations are stored as `runtime-observations.json`.

Use `force_full=true` when the incremental state is suspect or when you need a clean rebuild.

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
