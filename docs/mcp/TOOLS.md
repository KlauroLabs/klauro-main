# Unravl MCP Server - Tools Reference

All tools that query analysis data require a `path` parameter - the absolute filesystem path of a previously analyzed project. Run `analyze_codebase` first to generate the analysis, then query it with any other tool.

Many tools support **pagination** via `limit` and `offset` parameters. When a tool returns paginated data, the response includes `total`, `offset`, and `limit` fields so you know how many items exist and can request more.

---

## Analysis Management

### `analyze_codebase`

Run CAS analysis on a local directory. Uses incremental analysis by default when a previous state exists, or a full rebuild when required. Detects languages, frameworks, and libraries automatically. Stores results as JSON for subsequent querying.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |
| `force_full` | boolean | no | Force full rebuild even if incremental analysis is possible |

**Returns:** `{ status, analysis_type, path, name, nodes, edges, entry_points, analyzers_run, errors }`. Incremental runs also include `change_summary` with files changed, node changes, and risk level.

### `list_analyses`

List all previously analyzed codebases with metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Returns:** Array of `{ name, path, file, analyzed_at, system_type, frameworks, node_count, edge_count }`.

### `validate_cas_contract`

Run executable CAS completeness checks for graph integrity, entry/exit references, runtime links, evidence facts, method calls, call chains, and optional stored runtime observations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `include_runtime_observations` | boolean | no | Include stored runtime observations in correlation gates |

**Returns:** `{ status, score, gates, summary, snapshot }`, where `snapshot` is a stable golden-shape summary of the CAS graph.

### `get_analysis_freshness`

Compare the stored analysis timestamp and incremental state against source file modification times.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Fresh/stale/no-analysis status, source file counts, tracked file counts, modified sample files, latest source change time, analyzed-at time, and a recommendation.

### `save_cas_golden_snapshot`

Save the current CAS golden-shape snapshot for later regression comparison.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Snapshot save metadata with file path, saved timestamp, and snapshot summary.

### `compare_cas_golden_snapshot`

Compare the current CAS shape against the saved golden snapshot for the same repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Pass/warn/fail status and CAS contract gates comparing current structure to the saved snapshot.

### `get_storage_health`

Inspect MCP analysis storage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | no | Optional project path filter |

**Returns:** Storage path, index version, analysis count, workspace graph count, agentic benchmark report count, and per-project snapshot, golden-snapshot, change-history, runtime-observation, and file-cache totals.

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
- `flow_graph` summary - Capabilities count, dependencies count, primary flow (core capability, value chain), system insights (detected patterns, entry type, data flow type), layers (name, type, count per layer), topology (root/leaf counts, critical path, max depth), top 15 capabilities sorted by score with operations
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

**Returns:** `system`, `architecture_summary`, `system_purpose`, `enhanced_system_purpose`, `system_capabilities`, `progressive_levels`, `analyzer_contributions`, `analysis_errors`, `configuration`, `runtime`, `repository_links`, `runtime_static_links_count`, `analysis_facts_count`, `disclosure`, `validation`.

---

## Product Understanding

### `list_answer_packs`

List deterministic MCP answer packs. Answer packs are curated question sets that prove a codebase can be explained from CAS with evidence.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Returns:** Array of answer packs with `id`, `name`, `description`, and questions. The default pack is `mastery`.

### `run_answer_pack`

Run a curated answer pack against an analyzed codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `pack` | string | no | Answer pack ID, default `mastery` |

**Returns:** Structured answers for overview, entry points, representative flow, change impact, data, tests, external boundaries, security, and runtime readiness. Each answer includes evidence references and follow-up MCP tools.

### `get_mcp_demo_flow`

Return an agent-facing product demo flow without requiring the UI.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `related_paths` | string[] | no | Related analyzed repositories to include in the cross-repo step |

**Returns:** A sequenced MCP script plus representative entry point, target node, and answer-pack readiness summary.

### `get_cross_repo_links`

Discover deterministic links across analyzed repositories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | no | Project paths to link. Omit to use all analyzed repositories. |

**Returns:** Cross-repository links for API calls, external services, env/configured base URLs, GraphQL/OpenAPI/protobuf/gRPC shared schemas, shared databases, message contracts, webhooks, and shared internal libraries, with evidence, confidence, certainty counts, and conflict reports.

### `save_workspace_graph`

Build and persist a multi-repository workspace graph.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | no | Workspace graph name, default `analyzed-workspace` |
| `paths` | string[] | no | Project paths to include. Omit to use all analyzed repositories |

**Returns:** Save metadata, workspace graph summary, repositories, cross-repository links, confidence, conflicts, and per-link review decisions.

### `get_workspace_graph`

Load a persisted workspace graph by id or name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace_id_or_name` | string | yes | Workspace graph id or name |

**Returns:** Workspace graph summary and full persisted graph.

### `list_workspace_graphs`

List persisted workspace graphs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Returns:** Array of workspace graph metadata with id, name, timestamps, repository count, link count, and storage file.

### `verify_workspace_link`

Record a human or agent review decision for a persisted cross-repository link.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace_id_or_name` | string | yes | Workspace graph id or name |
| `link_id` | string | yes | Link id from the workspace graph |
| `decision` | string | yes | `verified`, `rejected`, or `unreviewed` |
| `reason` | string | no | Review reason or supporting evidence |
| `actor` | string | no | Person or agent recording the decision |

**Returns:** Save metadata, updated summary, and updated graph.

### `get_agent_bootstrap`

Default first payload for Codex, Claude, Cursor, and other coding agents when an analysis exists.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context with `task_type`, `target`, `related_paths`, or `runtime_event` |

**Returns:** Default-use rule, agent readiness, start context, task-specific tool plan, work packet, source file read plan, and a ready-to-use prompt. This is the highest-level agent bootstrap surface.

### `get_agent_start_context`

Default first call for Codex, Claude, Cursor, and other coding agents when an analysis exists. Returns the CAS-backed orientation an agent needs before broad file reads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context with `task_type`, `target`, `related_paths`, or `runtime_event` |

**Returns:** Default-use rule, agent readiness status, system summary, scale metrics, top entry/exit points, connected nodes, runtime links, answer-pack status, recommended first MCP tools, and guidance for when source file reads are still required.

### `get_agent_tool_plan`

Task-specific MCP call plan for agents. Use this before choosing source files so CAS narrows the work area first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context. `task_type` supports `orient`, `modify`, `debug`, `review`, `trace`, `cross-repo`, and `runtime`; `instructions` and `success_criteria` preserve the user's exact behavioral ask |

**Returns:** Ordered MCP steps with tool names, arguments, purpose, required/optional status, and fallback behavior if CAS/MCP is missing or stale.

### `get_agent_work_packet`

One-call task packet for agents. Use this after `get_agent_start_context` when an agent needs to begin real work without manually orchestrating every query.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context with `task_type`, `target`, `related_paths`, `runtime_event`, `instructions`, or `success_criteria` |

**Returns:** Target resolution, selected node, coding context, change risk, callers, callees, tests, error contracts for debug tasks, representative entry/call-chain context, recommended MCP follow-ups, adoption gaps, a file read plan with concrete source files and reasons, and a validation plan with focused test/typecheck/build commands, tests to inspect, manual checks, environment rules, and validation gaps.

### `evaluate_agent_readiness`

Score whether this repository's CAS/MCP surface is good enough for agents to use by default.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Pass/warn/fail status, score, `default_use` boolean, graph and answerability gates, adoption gaps, and the required agent behavior contract.

### `get_agent_doctor`

Run the default-use readiness doctor for Codex, Claude, and other coding agents. This combines CAS contract validation, analysis freshness, test discovery evidence, runtime SDK proof, and golden snapshot status into one payload.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Pass/warn/fail status, `default_use` boolean, readiness report, freshness report, test discovery evidence, runtime event contract, runtime SDK package proof, golden snapshot comparison, and recommended first MCP tools.

### `get_agent_default_config`

Return install-ready default-use instructions for an agent without writing files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context |

**Returns:** Required agent rule, MCP server command, first calls, prompt text, doctor output, and bootstrap output.

### `install_agent_default_config`

Write `.unravl/agent-defaults.json` and `.unravl/agent-defaults.md` into a repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context |

**Returns:** The installed config and file paths. Agents can read these files to use Unravl as the default first context path.

### `evaluate_analysis_truth`

Compare CAS against explicit ground-truth expectations. Use this for fixture repos, customer validation repos, and regression tests where the expected architecture is known.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `expectation` | object | no | Expected frameworks, languages, routes, nodes, data entities, relationships, and runtime signals. If omitted, MCP looks for repo-local analysis expectation files |

**Returns:** Pass/warn/fail status, score, per-expectation checks, and misses.

### `get_semantic_map`

Return a CAS-derived source-level map for a target area.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | no | Optional target query |
| `limit` | number | no | Max matching nodes |

**Returns:** Files, nodes, imports, exports, data entities, entry/exit ownership, relationships, and method calls.

### `get_framework_depth_report`

Score detected frameworks and important libraries by analyzer depth.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Per-framework scores for analyzer presence, tagged nodes, entry points, evidence, runtime links, and expected framework-specific surfaces.

### `get_integration_depth_report`

Detect deeper library and platform integrations that need richer analyzer coverage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Scores and evidence for jobs, brokers, auth, payments, AI SDKs, infrastructure, observability, cache, and persistence, including found surfaces, missing surfaces, and recommended analyzers.

### `get_cross_repo_contracts`

Build a contract-level view across analyzed repositories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | no | Repositories to include. Omit to use all stored analyses |

**Returns:** Provided HTTP/message/database contracts, consumed APIs/messages/databases, deterministic cross-repo links, and contract gaps.

### `get_runtime_instrumentation_plan`

Turn CAS runtime links into concrete event contracts and instrumentation points.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `limit` | number | no | Max instrumentation points |

**Returns:** Runtime link totals, required/recommended event fields, instrumentation points, suggested runtime event payloads, and gaps.

### `get_runtime_event_contract`

Return the canonical runtime event schema plus CAS-specific event payloads that SDKs should emit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `limit` | number | no | Max runtime link contracts |

**Returns:** Contract version, transport details, event types, field definitions, correlation order, per-runtime-link minimum and recommended event payloads, SDK method contract, totals, and gaps.

### `get_runtime_sdk_package`

Generate a deterministic TypeScript runtime SDK package from the CAS runtime contract.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Package manifest, transport target, generated file list with hashes, quick-start commands, and proof metadata tying the SDK to CAS runtime links.

### `evaluate_agent_task_proof`

Run agent work packets for representative tasks and score whether CAS gives enough target, risk, test, MCP, and file-read context to begin work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `tasks` | object[] | no | Agent tasks to evaluate |

**Returns:** Per-task scores, selected nodes, file read plans, and gaps.

### `run_agentic_benchmark`

Benchmark the same task with Unravl vs without Unravl.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | no | Project paths to benchmark. Omit to use all analyzed repositories |
| `task` | object | no | Task to hand to both agents. Supports `task_type`, `target`, `instructions`, `success_criteria`, `related_paths`, and `runtime_event` |
| `suite` | boolean | no | Generate several CAS-derived task cards per repository |
| `max_tasks_per_repo` | number | no | Maximum generated suite tasks per repository |

**Returns:** Persisted report metadata, JSON report, Markdown report, per-task success gates, estimated token counts, estimated cached and first-run solution time, estimated speedups, projected baseline success, and a two-agent live-run protocol for provider-reported token measurement.

### `get_agentic_benchmark_report`

Load persisted agentic benchmark reports.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | no | Report id, default `latest` |
| `list` | boolean | no | List reports instead of loading one |

**Returns:** Report list or one report with Markdown rendering.

### `run_agent_quality_benchmark`

Run the work-quality benchmark layer on top of the agentic benchmark suite.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | no | Project paths to benchmark. Omit to use all analyzed repositories |
| `task` | object | no | Single task to hand to both agents. Supports `task_type`, `target`, `instructions`, `success_criteria`, `related_paths`, and `runtime_event`; omit to generate a task suite |
| `max_tasks_per_repo` | number | no | Maximum generated suite tasks per repository |
| `agent_with_command` | string | no | Live with-Unravl command template. Supports `{workspace}`, `{prompt_file}`, `{metrics_file}`, `{result_file}`, `{arm}`, and `{task_id}` |
| `agent_without_command` | string | no | Live without-Unravl command template. Supports the same arm placeholders |
| `orchestrator_command` | string | no | Optional evaluator command template. Supports `{evaluation_input}`, `{evaluation_file}`, `{with_workspace}`, `{without_workspace}`, `{with_diff}`, and `{without_diff}` |
| `test_command` | string | no | Optional command to run inside each copied repo after the agent attempt |
| `work_root` | string | no | Directory for copied repos, prompts, diffs, metrics, and evaluator artifacts |
| `max_live_tasks` | number | no | Maximum task pairs to run through live agents |
| `timeout_ms` | number | no | Per-agent command timeout in milliseconds |
| `test_timeout_ms` | number | no | Per-test command timeout in milliseconds |
| `orchestrator_timeout_ms` | number | no | Evaluator command timeout in milliseconds |

**Returns:** Persisted report metadata, JSON report, Markdown report, success gates, context completeness, projected baseline quality, quality-score delta, token/time/file deltas, and optional live A/B execution results. Live results include copied repo paths, prompt/result/metric files, the with-Unravl work-packet artifact, binary diff paths, changed files, lines added/deleted, wall-clock duration, test status, provider token metrics when reported, deterministic orchestrator scores, optional external-orchestrator scores, and separated patch-quality, hidden-validation, command-completion, and timeout signals.

### `get_patterns`

Design patterns and anti-patterns detected in the codebase. Returns **summaries only** -- instance counts and variation breakdowns without listing every instance ID. Use `get_pattern_instances` to drill into specific patterns.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `patterns` (each with `id`, `name`, `description`, `type`, `confidence`, `instance_count`, and `variations` with `id`, `implementation`, `description`, `instance_count`, `percentage`), `categories`, `behaviors`.

### `get_pattern_instances`

Get the node IDs that are instances of a specific pattern. Paginated.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `pattern_id` | string | yes | Pattern ID from `get_patterns` results |
| `variation_id` | string | no | Filter to a specific variation |
| `limit` | number | no | Max results (default 50) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `pattern_id`, `pattern_name`, `total_instances`, `offset`, `limit`, `instances` (array of node IDs). When `variation_id` is specified, also includes `variation_id` and `variation_description`.

### `get_perspectives`

Multi-view analysis perspectives with connection rules and layout hints.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Array of perspectives with connection rules and layout configuration.

---

## Navigation and Search

### `search_nodes`

Find code elements by name, qualified name, or description. Supports filtering by type, category, and hierarchy level. Multi-word queries use camelCase-aware matching -- searching "react analyzer" will match `ReactAnalyzer`, `react-analyzer`, etc. Results are ranked by type relevance: classes, services, and controllers appear first; imports are deprioritized.

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

**Returns:** Full node with `signature`, `metadata`, `documentation`, `call_graph`, `implementation_status`, `todos`, `children`, plus enrichments: `incoming_edges`, `outgoing_edges` (trimmed -- id, source, target, type, key metadata only), `entry_points`, `exit_points`, `decorators`, `intent`, `change_risk`, `stability`, `resolved_children`.

### `get_file_nodes`

All code elements defined in a specific file with their internal relationships.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `file_path` | string | yes | Relative file path within the project |

**Returns:** `nodes` (array with id, name, type, category, level, line, end_line, description, parent, children) and `edges` (trimmed internal edges between nodes in the file -- id, source, target, type, key metadata only).

### `get_level`

Progressive disclosure. Get nodes, edges, entry points, and exit points at a specific hierarchy level. Optimized for token efficiency with configurable limits. Cross-level edges use `node_refs` deduplication instead of embedding full objects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `level` | number | yes | Hierarchy level (0 = system, 1 = subsystems, deeper = more detail) |
| `limit` | number | no | Max nodes to return (default 50) |
| `offset` | number | no | Skip first N nodes (default 0) |
| `edge_limit` | number | no | Max edges to return (default 200) |
| `include_edges` | boolean | no | Include edges in response (default true) |
| `include_entry_exit` | boolean | no | Include entry/exit points (default true) |

**Returns:**
- `level` - The requested level number
- `definition` - Level metadata (name, description)
- `pagination` - `{ total_nodes, offset, limit, has_more }` for navigating results
- `edges_summary` - `{ internal_count, cross_level_count, internal_returned, cross_level_returned }` showing truncation
- `entry_exit_summary` - `{ entry_count, exit_count, entry_returned, exit_returned }` showing truncation
- `available_levels` - All levels with name and node count (for navigation)
- `nodes` - Paginated nodes (id, name, type, qualified_name, category, file, line, parent, children_count)
- `internal_edges` - Trimmed edges between nodes at this level (id, source, target, type)
- `cross_level_edges` - Edges to other levels with `external_id` reference (not embedded objects)
- `node_refs` - Map of external node IDs to `{ name, type, level }` for deduplication
- `entry_points` - Limited entry points (id, type, name, source_node)
- `exit_points` - Limited exit points (id, type, name, source_node)

---

## Agentic Coding Tools

Tools designed specifically for AI coding assistants to understand, navigate, and safely modify code.

### `get_coding_context`

**THE essential tool for AI coding.** Returns everything needed to start coding in a specific area with a single call. Replaces 5-10 separate tool calls.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | yes | Node ID, file path, or search query to find the target |
| `task_type` | string | no | Type of change: `add`, `modify`, `delete`, `refactor` (default: modify) |
| `include` | string[] | no | Sections to include: `conventions`, `patterns`, `constraints`, `tests` (default: all) |

**Returns:**
- `target_node` - Node details with layer (entry/business/data/infrastructure) and framework_role (e.g., "NestJS Controller", "React Hook")
- `conventions` - Naming patterns, import style, error handling, async patterns
- `related_patterns` - Patterns that apply to this code with relevance level
- `layer_boundaries` - What this code can/should not call
- `modification_checklist` - Verification steps, tests to run, tests to add
- `connected_code` - Callers, callees, shared types with risk assessment

### `get_conventions`

Codebase coding standards extracted from actual code patterns. Use to ensure new code matches existing style.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `scope` | string | no | Scope: `global`, `layer`, `module` (default: global) |
| `layer` | string | no | Layer name if scope=layer |
| `module_id` | string | no | Module node ID if scope=module |

**Returns:**
- `naming` - Patterns for functions, classes, files, variables, constants with examples
- `file_organization` - Structure pattern (feature-based/layer-based), index files, barrel exports
- `imports` - Style (named/default/mixed), order
- `error_handling` - Pattern type, custom error classes, example node ID
- `async_patterns` - Preferred style (async-await/promises), error handling

### `get_modification_guide`

Complete safety checklist before modifying specific code.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to modify |
| `change_type` | string | yes | Type: `signature`, `behavior`, `delete`, `add_parameter`, `rename` |

**Returns:**
- `risk_level` - low/medium/high/critical
- `change_summary` - What changes, blast radius, critical path affected
- `must_update` - Files/nodes that must be updated with suggested changes
- `should_verify` - Verification checks with how to verify and automation status
- `tests` - Existing tests, tests to add, run command
- `rollback_considerations` - How to undo if needed

### `get_pattern_examples`

Get actual working code examples for detected patterns. Use to learn how patterns are implemented before writing similar code.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `pattern_id` | string | yes | Pattern ID from `get_patterns` |
| `variation_id` | string | no | Specific variation ID |
| `limit` | number | no | Max examples (default 3) |

**Returns:**
- `pattern` - Pattern id, name, description
- `examples` - Array of `{ node_id, name, file, line, code_snippet, annotations, why_exemplary }`

### `find_similar_code`

Find code similar to a given node for consistency and potential reuse.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | no | Node ID to find similar code for |
| `code_snippet` | string | no | Code snippet to find similar code for |
| `similarity_type` | string | no | Type: `structural`, `semantic`, `both` (default: both) |
| `limit` | number | no | Max results (default 10) |

**Returns:**
- `query` - Query details (node_id or snippet_hash)
- `similar` - Array of `{ node_id, name, file, line, similarity_score, similarity_reasons, differences, reuse_recommendation }` where `reuse_recommendation` is `extract_shared`, `copy_pattern`, or `reference_only`

### `get_comments`

Surface TODO/FIXME/HACK/NOTE/WARNING comments affecting a code area.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `scope` | string | yes | Scope: `node`, `file`, `module`, `all` |
| `node_id` | string | no | Node ID (required if scope=node or scope=module) |
| `file_path` | string | no | File path (required if scope=file) |
| `types` | string[] | no | Comment types: `todo`, `fixme`, `hack`, `note`, `warning` (default: all) |
| `limit` | number | no | Max results (default 50) |

**Returns:**
- `total` - Total comments found
- `by_type` - Count by comment type
- `by_purpose` - Count by purpose
- `comments` - Array of `{ type, text, purpose, file, line, node_id, node_name }`

### `get_error_contracts`

What errors can a function throw/return and how callers handle them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to analyze |
| `direction` | string | no | Direction: `throws`, `catches`, `both` (default: both) |

**Returns:**
- `node` - Node id and name
- `throws` - Array of `{ error_type, conditions, documented }`
- `caught_by` - Array of `{ caller_id, caller_name, handling }` where handling is `caught`, `propagated`, or `ignored`
- `uncaught_paths` - Array of `{ entry_point_id, entry_point_name, path_description }`

### `get_framework_guidance`

Framework-specific best practices for the detected stack.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `framework` | string | no | Framework name (auto-detect if not specified) |
| `topic` | string | no | Topic: `routing`, `state`, `data-fetching`, `testing`, `security` |

**Returns:**
- `framework` - Framework name and version
- `detected_patterns` - Array of `{ pattern, usage_count, is_recommended }`
- `recommendations` - Array of `{ topic, current_approach, recommended_approach, example_node_id, migration_effort }`
- `anti_patterns_found` - Array of `{ pattern, locations, suggested_fix }`

### `get_usage_examples`

How is this function/class/type actually used throughout the codebase?

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to find usages for |
| `limit` | number | no | Max results (default 10) |
| `include_tests` | boolean | no | Include test file usages (default: false) |

**Returns:**
- `node` - Node id, name, type
- `usage_count` - Total usage count
- `usage_patterns` - Array of `{ pattern_description, frequency, example_locations }`
- `common_mistakes` - Array of common usage mistakes

### `get_configuration`

Surface configuration that affects code behavior.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `scope` | string | no | Scope: `all`, `runtime`, `build`, `test` (default: all) |
| `affecting_node_id` | string | no | Find config affecting this specific node |

**Returns:**
- `scope` - Applied scope
- `config_files` - List of config file paths
- `config_nodes` - Array of `{ id, name, type, file, line }`
- `environment_variables` - List of environment variables
- `feature_flags` - List of feature flags

---

## Entry/Exit Points and Routes

### `get_entry_points`

All system entry points. Entry points are where external requests or events enter the system. Paginated (default 50).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `type` | string | no | Filter: http, websocket, cli, event, schedule, page, route, message, file, test |
| `limit` | number | no | Max results (default 50) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `{ total, offset, limit, entry_points }` -- entry points with handler, security, trigger, input/output schemas, connected nodes.

### `get_exit_points`

All external interactions where the system reaches out to external services or resources. Paginated (default 50).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `type` | string | no | Filter: database, api, file, message, cache, sdk, webhook |
| `limit` | number | no | Max results (default 50) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `{ total, offset, limit, exit_points }` -- exit points with target, operation, reliability config, connected nodes.

### `get_route_table`

HTTP route table extracted from framework analysis. Paginated (default 50).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `method` | string | no | Filter by HTTP method (GET, POST, PUT, DELETE, etc.) |
| `limit` | number | no | Max results (default 50) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `{ total, offset, limit, routes }` -- each route with `method`, `path`, `controller`, `handler`, `auth`, `guards`, `middleware`.

### `get_external_services`

All external service integrations detected in the codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Array of services with purpose, endpoint, usage pattern, monitoring, cost info.

---

## Call Graph and Flow Tracing

### `get_callers`

Find code elements that call or reference a given node. Traverses edges and method calls. Limited to prevent token explosion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to find callers for |
| `depth` | number | no | Max traversal depth (default 2) |
| `limit` | number | no | Max results to return (default 50) |

**Returns:** `{ total, limit, truncated, callers }` where `callers` is an array of `{ node_id, name, type, depth, via }`. The `via` field indicates the relationship type (e.g., `edge:calls`, `method_call:findAll`). `truncated` is true if more callers exist.

### `get_callees`

Find code elements that a given node calls or references. Limited to prevent token explosion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to find callees for |
| `depth` | number | no | Max traversal depth (default 2) |
| `limit` | number | no | Max results to return (default 50) |

**Returns:** `{ total, limit, truncated, callees }` - same format as `get_callers` but with `callees` array.

### `get_call_chain`

Complete call chains from entry to exit. Behavior depends on parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `chain_id` | string | no | Specific call chain ID for full detail |
| `entry_point_id` | string | no | Entry point ID to find chains for |
| `limit` | number | no | Max results when listing all chains (default 25) |
| `offset` | number | no | Skip first N results (default 0) |

- **With `chain_id`:** Returns the full chain with all steps, characteristics, risk analysis, business context, criticality, runtime stats, test coverage.
- **With `entry_point_id`:** Returns all chains for that entry point (full detail).
- **Without filters:** Returns paginated **chain summaries** (`id`, `chain_type`, `entry_point`, `exit_point`, `call_path_length`, `characteristics`, `criticality`, `risk_level`) -- not full chain data.

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

Data entity lifecycle analysis - how data flows through the system. Paginated (default 25).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `entity_name` | string | no | Filter by entity name |
| `limit` | number | no | Max results (default 25) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `{ total, offset, limit, entities, data_summary }` -- entities with fields, CRUD lifecycle (created_by/read_by/updated_by/deleted_by), transformations, invariants. `data_summary` includes sensitive data nodes and validation gaps.

### `get_security_overview`

Security posture of the analyzed system.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `security_boundaries` (trust transitions, enforcement points, bypass risks), `security_summary` (unprotected ops, enforced vs assumed vs missing), `security_contexts` (per-node trust levels, protection gaps).

### `get_behavioral_invariants`

Behavior-level invariants inferred from CAS. Use this when a task depends on tenant/org scope, auth boundaries, authorization, database uniqueness/nullability, migrations, or test coverage.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `invariant_type` | string | no | Filter by `tenant-scope`, `auth-boundary`, `authorization`, `db-constraint`, `migration-contract`, `test-coverage`, `data-lifecycle`, or `business-rule` |
| `target` | string | no | Node id, file path, entity, field, or text target |
| `limit` | number | no | Max results (default 25) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** Summary counts and invariants with scope, enforcement points, evidence, related tests, related boundaries/entities, confidence, and gaps.

### `get_stability`

Code stability and churn analysis. Behavior depends on parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | no | Specific node (omit for summary) |

- **With `node_id`:** Returns detailed stability for that node -- stability score, stability class, commit metrics (30d/90d), bug fix rate, refactor frequency.
- **Without `node_id`:** Returns `stability_summary` (hotspots, legacy areas), `total_nodes_tracked`, and `by_class` (count of nodes per stability class) -- not individual node data.

### `assess_change_risk`

Risk assessment for modifying a specific code element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to assess |

**Returns:** `risk` (risk_level, risk_factors like many-callers/critical-path/no-tests, downstream_impact with direct/transitive callers and affected chains/entry points, test_protection, stability_context, recommendations) and `change_risk_summary`.

### `get_flow_coverage`

Per-flow test coverage analysis. Behavior depends on parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `chain_id` | string | no | Specific call chain ID |

- **With `chain_id`:** Returns full `coverage` (coverage_status, tested/untested segments with importance, test quality) and related `test_gaps`.
- **Without `chain_id`:** Returns `flow_summary`, `total_flows`, `by_coverage_status` (counts per status), `total_test_gaps`, `test_gaps_by_severity` (counts per severity) -- not individual flow data.

---

## Workflows and Capabilities

### `get_workflows`

Business workflows detected from analyzing entry-to-exit paths. Behavior depends on parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `workflow_id` | string | no | Specific workflow ID |

- **With `workflow_id`:** Returns full workflow detail (entry points, call chains, entities touched, services used, classification, criticality, dependencies).
- **Without `workflow_id`:** Returns `total`, workflow **summaries** (`id`, `name`, `workflow_type`, `classification`, `criticality`, `entry_point_count`, `chain_count`, `entity_count`, `service_count`), and `workflow_graph`.

### `get_flow_graph`

Capability-level architecture view.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `flow_graph` with capabilities (scored), dependencies, topology (root/leaf/critical path nodes), primary flow (value chain), layers (entry/business/data/infrastructure), system insights (detected patterns, entry type, data flow type).

### `get_runtime_static_links`

Runtime-to-static correlation for entry points, exit points, call chains, and external services.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `telemetry_status` | string | no | Filter: observed, instrumentable, not-instrumented |
| `kind` | string | no | Filter: entry-point, exit-point, call-chain, external-service, telemetry-hook |
| `limit` | number | no | Max results (default 50) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `runtime`, status counts, and links with `runtime_signal`, `telemetry_status`, `instrumentation_points`, confidence, and evidence.

### `correlate_runtime_event`

Map a runtime request, error, exit, log, or custom event back to CAS without storing it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `event` | object | yes | Runtime event payload |

The event object may include `type`, `timestamp`, `signal`, `static_id`, `node_id`, `entry_point_id`, `exit_point_id`, `call_chain_id`, `method`, `route`, `path`, `status_code`, `duration_ms`, `error_message`, `stack`, and `attributes`.

**Returns:** Correlation status, best match, matched CAS evidence, runtime links, and suggested instrumentation when unmatched.

### `record_runtime_event`

Store a runtime event after correlating it to CAS.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `event` | object | yes | Runtime event payload |

**Returns:** Stored runtime observation with generated ID, original event, and correlation result.

### `get_runtime_observations`

Query stored runtime observations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `type` | string | no | Filter by request, error, exit, log, or custom |
| `since` | string | no | ISO timestamp lower bound |
| `static_id` | string | no | CAS node, entry point, exit point, call chain, or runtime link ID |
| `trace_id` | string | no | Runtime trace ID |
| `span_id` | string | no | Runtime span ID or parent span ID |
| `limit` | number | no | Max results |

**Returns:** Stored observations with runtime payloads and CAS correlations.

### `get_runtime_trace`

Replay stored runtime observations for a trace ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `trace_id` | string | yes | Runtime trace ID |

**Returns:** Ordered observations for the trace, matched/unmatched counts, and CAS static IDs touched by the trace.

### `get_analysis_facts`

Evidence-backed facts behind CAS objects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `subject_type` | string | no | Filter by subject type, such as node, edge, entry_point, workflow, capability, runtime_link, repository_link |
| `subject_id` | string | no | Filter by concrete CAS object ID |
| `fact_type` | string | no | Filter by fact type, such as definition, relationship, workflow, runtime-correlation, cross-repository |
| `limit` | number | no | Max results (default 50) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `{ total, offset, limit, facts }` with claim, producer, confidence, and source evidence.

### `get_domain_concepts`

Core domain terminology extracted from the codebase. Sorted by frequency. Paginated (default 25).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `classification` | string | no | Filter: core, supporting, infrastructure |
| `limit` | number | no | Max results (default 25) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `{ total, offset, limit, concepts }` -- domain concepts with frequency, where they appear (entry points, entities, nodes), classification.

---

## Behaviors and Lifecycle

### `get_behaviors`

System behaviors - what the system does, not just what it is. Behaviors include participating nodes and execution flows showing how nodes interact to implement a capability.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `behavior_id` | string | no | Specific behavior ID for full detail |
| `limit` | number | no | Max results (default 50) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:**
- **Without `behavior_id`:** `{ total, offset, limit, behaviors }` with summaries including id, name, description, node_count, flow_steps, nodes (resolved with name and type), and flow.
- **With `behavior_id`:** Full behavior with resolved_nodes (including file and line info) and complete flow details.

### `get_lifecycle_hooks`

Framework lifecycle hooks - initialization, mounting, updates, destruction. Detects hooks from decorators and entry points.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `phase` | string | no | Filter: init, mount, update, destroy |
| `framework` | string | no | Filter by framework |
| `limit` | number | no | Max results (default 50) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `{ total, by_phase, offset, limit, hooks }` where each hook has:
- `id` - Unique identifier
- `name` - Hook name (e.g., ngOnInit, useEffect, mounted)
- `phase` - Lifecycle phase: init, mount, update, destroy, or other
- `framework` - Detected framework
- `node_id`, `node_name` - Associated code element
- `file`, `line` - Source location
- `source` - Where detected: decorator or entry_point

Detected hooks include Angular (ngOnInit, ngAfterViewInit, ngOnDestroy), React (useEffect mount/cleanup), Vue (mounted, beforeDestroy), NestJS (OnModuleInit, OnModuleDestroy), and more.

---

## Testing

### `find_tests`

Find test suites and test cases covering a specific node or file. Behavior depends on parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | no | Node ID to find tests for |
| `file_path` | string | no | File path to find tests for |
| `limit` | number | no | Max results when listing all (default 25) |
| `offset` | number | no | Skip first N results (default 0) |

- **With `node_id` or `file_path`:** Returns matching `suites` (with test cases, assertions, coverage info), `mocks`, `fixtures`, and `resolution` metadata. Resolution combines explicit CAS coverage with related test-file inference, such as co-located `.spec`/`.test` files and matching test filenames.
- **Without filters:** Returns paginated lists with `total_suites`, `total_mocks`, `total_fixtures`, `offset`, `limit`.

### `get_test_summary`

Full test overview across the entire codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** `test_summary` (counts by type/status, coverage percentage, mocks total, fixtures total) and `test_gaps` (untested flows, branches, mock-only coverage, no-assertion tests, with severity and recommendations).

### `get_test_discovery_evidence`

Compare source test files and test configuration files against the CAS test surface. Use this to tell the difference between repositories that have no tests and repositories where tests exist but analysis missed them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Status, CAS suite count, discovered source test file count, potential uncovered test files, test config files, sample source test files, and a summary.

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

Library usage analysis with optimization insights. Paginated (default 25).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `query` | string | no | Filter by library name or category |
| `limit` | number | no | Max results (default 25) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** `{ total, offset, limit, libraries }` -- libraries with usage patterns, bundle size, security info, usage stats, optimization opportunities, replacement feasibility, alternatives.

---

## Change History and Incremental Analysis

Tools for querying how a codebase changed across incremental analyses. These tools read the change history and snapshots stored alongside each analyzed project.

### `get_changes_since`

Query changes after a specific timestamp.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `since` | string | yes | ISO timestamp to query changes from |
| `limit` | number | no | Max results (default 50) |

**Returns:** Array of change history entries with file changes, node changes, edge changes, impact analysis, and semantic summaries.

### `get_changes_between`

Query changes between two timestamps.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `from` | string | yes | Start ISO timestamp |
| `to` | string | yes | End ISO timestamp |
| `limit` | number | no | Max results (default 50) |

**Returns:** Array of change history entries in the requested time range.

### `get_changes_for_node`

Query changes affecting a specific node. Optionally includes caller/callee ripple effects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID to find changes for |
| `since` | string | no | ISO timestamp to query changes from |
| `include_callers` | boolean | no | Include changes to callers |
| `include_callees` | boolean | no | Include changes to callees |
| `depth` | number | no | Caller/callee traversal depth (default 1) |
| `limit` | number | no | Max results (default 25) |

**Returns:** Array of relevant change history entries.

### `get_changes_for_file`

Query changes affecting a file. Optionally includes import neighbors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `file_path` | string | yes | Relative file path |
| `since` | string | no | ISO timestamp to query changes from |
| `include_importers` | boolean | no | Include changes to files that import this file |
| `include_imported` | boolean | no | Include changes to files imported by this file |
| `limit` | number | no | Max results (default 25) |

**Returns:** Array of relevant change history entries.

### `get_changes_for_entry_point`

Query changes affecting an entry point such as an HTTP route, CLI command, scheduled job, or event handler.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `entry_point_id` | string | yes | Entry point ID |
| `since` | string | no | ISO timestamp to query changes from |
| `include_full_chain` | boolean | no | Include changes to all nodes in the call chain |
| `limit` | number | no | Max results (default 25) |

**Returns:** Array of relevant change history entries.

### `get_change_summary`

Aggregate change statistics by file, module, author, intent, day, or week.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `group_by` | string | yes | One of `file`, `module`, `author`, `intent`, `day`, `week` |
| `since` | string | no | ISO timestamp to query changes from |
| `until` | string | no | ISO timestamp to query changes until |

**Returns:** Array of aggregates with counts, files changed, node changes, lines changed, risk summary, and velocity.

### `get_hot_spots`

Find frequently changed or bug-prone areas of the codebase.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `metric` | string | yes | One of `change-count`, `churn-lines`, `bug-fix-rate` |
| `since` | string | no | ISO timestamp to query changes from |
| `limit` | number | no | Max results (default 20) |

**Returns:** Heat map data with normalized intensity values, scale information, and top hot spots.

### `get_analysis_at`

Retrieve the analysis state at a specific timestamp.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `timestamp` | string | yes | ISO timestamp to retrieve analysis for |

**Returns:** Condensed summary for the nearest analysis snapshot at or before the timestamp, or `{ error }` when no snapshot exists.

### `get_analysis_snapshots`

List available analysis snapshots for time travel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Array of `{ id, timestamp }`.

---

## Component Hierarchy (React/Frontend)

Tools for understanding React component composition - which components render which, usage metrics, and shared component identification.

### `get_component_parents`

Find components that render a given component via JSX. Shows which parent components use this component in their render output.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Component node ID to find parents for |
| `limit` | number | no | Max results (default 50) |

**Returns:** `{ total, limit, truncated, parents }` where `parents` is an array of `{ node_id, name, type, file, props_passed, jsx_line }`. `props_passed` shows which props the parent passes to this component.

### `get_component_children`

Find components that a given component renders via JSX. Shows which child components are used in this component's render output.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Component node ID to find children for |
| `limit` | number | no | Max results (default 50) |

**Returns:** `{ total, limit, truncated, children }` where `children` is an array of `{ node_id, name, type, file, props_passed, jsx_line }`.

### `get_component_metrics`

Full metrics for a React component including usage statistics, composition data, and prop/state/hook counts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Component node ID |

**Returns:**
- `node_id`, `name`, `type`, `file` - Component identification
- `metrics`:
  - `usage_count` - How many components render this one
  - `usage_locations` - Names of parent components
  - `rendered_components_count` - How many child components
  - `is_leaf` - True if no child components
  - `is_shared` - True if usage_count >= 2
  - `is_highly_shared` - True if usage_count >= 5
  - `props` - Array of `{ name, type, required }`
  - `state_count`, `hooks_count` - State and hook usage
- `parents` - Array of `{ node_id, name }` for parent components
- `children` - Array of `{ node_id, name }` for child components

### `get_shared_components`

Find components that are used in multiple places. Useful for identifying high-impact components where changes need careful consideration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `min_usage` | number | no | Minimum usage count to include (default 2) |
| `limit` | number | no | Max results (default 50) |

**Returns:** Array of `{ node_id, name, file, usage_count, usage_locations }` sorted by usage_count descending.

---

## Watch Mode (Real-time Analysis)

Tools for monitoring file changes and running incremental analysis automatically. Watch mode uses Node's `fs.watch` with recursive watching, debounces changes (500ms), and filters to only source files.

### `start_watch`

Begin watching a project for file changes. Automatically runs incremental analysis when files change.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |

**Returns:** `{ watch_id, status }` where status is `started`, `already_watching`, or `error`.

### `stop_watch`

Stop watching a project for file changes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `watch_id` | string | yes | Watch session ID from `start_watch` |

**Returns:** `{ success, message }`.

### `get_watch_status`

Get the current status of a watch session including pending changes, recent analyses, and statistics.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `watch_id` | string | yes | Watch session ID from `start_watch` |

**Returns:**
- `watch_id`, `project_path`, `status` (`active`, `paused`, `stopped`, `error`)
- `started_at`, `last_analysis`
- `pending_changes` - Count of files waiting to be analyzed
- `pending_files` - List of pending file paths (max 20)
- `analysis_in_progress` - Boolean
- `error` - Error message if status is `error`
- `stats`:
  - `total_changes_detected`
  - `total_analyses_run`
  - `average_analysis_time_ms`
- `recent_changes` - Array of recent analysis results with `timestamp`, `files_changed`, `nodes_added`, `nodes_modified`, `nodes_deleted`, `risk_level`

### `list_watches`

List all active and recent watch sessions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Returns:** Array of watch status objects (same format as `get_watch_status`).

### `poll_watch_changes`

Poll for recent changes from a watch session. Use this to check if new analyses have completed since the last poll.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `watch_id` | string | yes | Watch session ID from `start_watch` |
| `since` | string | no | ISO timestamp to filter changes newer than this |

**Returns:**
- `has_changes` - Boolean, true if there are changes or pending files
- `changes` - Array of analysis results since the timestamp
- `pending_files` - Files waiting to be analyzed (max 20)
- `analysis_in_progress` - Boolean
