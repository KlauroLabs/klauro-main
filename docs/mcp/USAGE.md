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

### 2. Start with Agent Context

For Codex, Claude, Cursor, and other coding agents, the default first call after analysis is:

```
Use get_agent_bootstrap with path="/absolute/path/to/your/project"
```

MCP clients that start from prompts can use:

```
Use the agent_coding_session prompt with path="/absolute/path/to/your/project"
```

MCP clients that prefer resources can read:

```
unravl://{project_name}/agent-bootstrap
```

For a specific task, include task context:

```
Use get_agent_bootstrap with path="/repo" and task={ "task_type": "modify", "target": "auth" }
```

This returns readiness, the system summary, graph anchors, answer-pack status, the recommended first MCP calls, a work packet, and a source file read plan. Agents should use it before broad file reads whenever an analysis exists.

### 3. Plan MCP Tool Use

Before deciding which files to inspect, ask CAS for a task-specific tool sequence:

```
Use get_agent_tool_plan with path="/repo" and task={ "task_type": "debug", "target": "billing webhook" }
```

Supported task types are `orient`, `modify`, `debug`, `review`, `trace`, `cross-repo`, and `runtime`. The plan tells the agent which MCP tools to call, why, and when file reads are appropriate.

### 4. Get the Work Packet

When the agent is ready to act, request the task packet:

```
Use get_agent_work_packet with path="/repo" and task={ "task_type": "modify", "target": "auth" }
```

The work packet resolves the target, includes coding context, risk, callers, callees, tests, entry/call-chain context, and returns a concrete file read plan. Agents should inspect those files first before expanding to broader source reads.

### 5. Check Default-Use Readiness

Use this when deciding whether an agent should rely on MCP by default:

```
Use evaluate_agent_readiness with path="/repo"
```

Or read:

```
unravl://{project_name}/agent-readiness
```

This checks analysis errors, graph integrity, entry and exit coverage, call chains, method calls, answer-pack gaps, evidence, tests, security surfaces, runtime links, and flow coverage. `default_use=true` means CAS/MCP is strong enough to be the first path for the repository.

### 6. Orient with get_summary

After analysis, call `get_summary` to understand the system at a high level:

```
Use the get_summary tool with path="/absolute/path/to/your/project"
```

This returns the condensed intelligence view: what the system does, its tech stack, architecture layers, key capabilities, and scale metrics.

### 7. Navigate Progressively

Use `get_level` to explore the codebase top-down:

1. `get_level` with `level=0` -- system-wide view (root modules, packages)
2. `get_level` with `level=1` -- major subsystems (controllers, services, core modules)
3. `get_level` with `level=2` -- individual components (classes, functions, handlers)
4. Continue deeper as needed

Each call returns the available levels with node counts, so you always know what's above and below. Cross-level edges show how the current level connects to others.

### 8. Drill Into Specifics

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
- **Validate CAS completeness**: `validate_cas_contract`
- **Inspect MCP storage**: `get_storage_health`
- **Map runtime back to code**: `get_runtime_event_contract`, `correlate_runtime_event`, `record_runtime_event`, `get_runtime_observations`, `get_runtime_trace`

---

## Common Scenarios

### Starting a coding session

Use `get_agent_bootstrap` first, or use the `agent_coding_session` prompt when your MCP client supports prompts:

```
Use get_agent_bootstrap with path="/absolute/path/to/your/project"
```

Then use `get_agent_work_packet` with the user's task. Use source files after MCP identifies the relevant nodes, files, tests, or gaps.

You can also use the `architectural_context` prompt to inject full system awareness:

```
Use the architectural_context prompt with path="/absolute/path/to/your/project"
```

This gives the AI assistant knowledge of system type, tech stack, architecture layers, API routes, database schema, capabilities, security posture, and design patterns -- all in a single context injection.

### Before modifying code

1. Call `get_agent_tool_plan` with `task_type="modify"` and the target.
2. Call `get_agent_work_packet` with the same task.
3. Read the packet's file read plan first.
4. Use the packet's risk, callers, callees, and tests to decide the edit and verification path.

Or use the `safe_modification_guide` prompt which composes all of these into a single output.

### Understanding a feature

1. Search for relevant nodes: `search_nodes`
2. Get the node details: `get_node`
3. Trace the call chain: `get_call_chain` from the entry point
4. Check what it calls: `get_callees`
5. See the workflow: `get_workflows`

### Proving a repo is understandable

First check agent readiness:

```
Use evaluate_agent_readiness with path="/absolute/path/to/project"
```

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

### Proving analysis accuracy

Use explicit expectations when you know what the analyzer should find:

```
Use evaluate_analysis_truth with path="/repo" and expectation={ "frameworks": ["NestJS"], "routes": [{ "method": "GET", "path": "/users/:id" }] }
```

Repos can also provide `.unravl/analysis-expectations.json`, `unravl.analysis.json`, or `analysis-expectations.json`; then call `evaluate_analysis_truth` without an inline expectation.

For source-level semantics before reading files:

```
Use get_semantic_map with path="/repo" and target="auth"
```

For framework depth:

```
Use get_framework_depth_report with path="/repo"
```

For task-level agent proof:

```
Use evaluate_agent_task_proof with path="/repo" and tasks=[{ "task_type": "debug", "target": "auth" }]
```

### Linking multiple repositories

Analyze each repository first, then call:

```
Use the get_cross_repo_links tool with paths=["/repo/a", "/repo/b", "/repo/c"]
```

When `paths` is omitted, the tool considers all stored analyses. It detects API links, shared databases, message contracts, and shared internal libraries with confidence, certainty bands, and conflict reports.

For contract-level details:

```
Use get_cross_repo_contracts with paths=["/repo/a", "/repo/b", "/repo/c"]
```

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
Use get_runtime_observations with path="/repo", type="error", static_id="<cas-id>", or trace_id="<trace-id>"
```

To replay one trace:

```
Use get_runtime_trace with path="/repo" and trace_id="<trace-id>"
```

Runtime events can include `signal`, `static_id`, `node_id`, `entry_point_id`, `exit_point_id`, `call_chain_id`, route details, status, duration, error message, stack trace, and arbitrary attributes.

To generate instrumentation payloads from CAS:

```
Use get_runtime_instrumentation_plan with path="/repo"
```

To generate the SDK-facing event schema:

```
Use get_runtime_event_contract with path="/repo"
```

### Checking runtime readiness and evidence

1. Use `get_runtime_event_contract` to see the event payloads SDKs should emit.
2. Use `get_runtime_static_links` to see which entry points, exit points, call chains, and external services have runtime signals or instrumentation candidates.
3. Filter by `telemetry_status=instrumentable` to find the next best instrumentation points.
4. Use `get_analysis_facts` for source-backed claims behind nodes, edges, workflows, capabilities, runtime links, and repository links.
5. Use `subject_id` when you need evidence for one concrete CAS object.

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

### Running the agent adoption gauntlet

From `mcp-server/`:

```
npm run agent-gauntlet
```

This analyzes the configured repositories and runs `evaluate_agent_readiness` against each one. The report is written to `.unravl-agent-gauntlet/latest-report.json` unless `--output` is provided. A passing target has `default_use=true`, meaning agents should use MCP as the first path for that repo.

### Running the agent usefulness benchmark

From `mcp-server/`:

```
npm run agent-benchmark
```

This checks whether task work packets resolve targets, produce a focused file read plan, include the selected target file, return follow-up MCP calls, and beat a cold repo read. The report includes file-reduction percentages so agent adoption is measured against the baseline of reading broad source files.

### Running the vision gauntlet

From `mcp-server/`:

```
npm run vision-gauntlet
```

This runs the full technical proof across discovered real repos: CAS contract validation, answer-pack readiness, agent default-use readiness, runtime event contract coverage, and cross-repo links. Default discovery includes Unravl, Kadra, Money, Zerac, Soon, and SoundSync when those repos exist under `~/dev`. Use `--repo name=/path/to/repo` to add or override targets. The report is written to `.unravl-vision-gauntlet/latest-report.json` unless `--output` is provided.

### Running the cross-repo contract gauntlet

From `mcp-server/`:

```
npm run contract-gauntlet
```

This analyzes paired fixture repositories and verifies that CAS-derived consumed contracts link to provided contracts with expected confidence and no unexpected conflicts.

### Running the analysis mastery gauntlet

From `mcp-server/`:

```
npm run analysis-gauntlet
```

This runs the built-in ground-truth fixture and any repos passed with `--repo`. It checks truth expectations, framework depth, runtime instrumentation readiness, semantic map availability, and agent task proof. The report is written to `.unravl-analysis-gauntlet/latest-report.json` unless `--output` is provided.

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
