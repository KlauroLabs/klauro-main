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

For the full default-use doctor, including freshness, test discovery evidence, runtime SDK proof, and saved golden snapshot status:

```
Use get_agent_doctor with path="/repo"
```

Or read:

```
unravl://{project_name}/agent-doctor
```

To install default-use instructions into the repository for future agents:

```
Use install_agent_default_config with path="/repo"
```

This writes `.unravl/agent-defaults.json` and `.unravl/agent-defaults.md`. Agents can read those files to know the required first MCP calls before broad file reads.

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
- **Check freshness and test discovery**: `get_analysis_freshness`, `get_test_discovery_evidence`
- **Prove answerability**: `run_answer_pack` with `pack="mastery"`
- **Connect repos**: `get_cross_repo_links` with related analyzed paths
- **Persist workspace graphs**: `save_workspace_graph`, `get_workspace_graph`, `verify_workspace_link`
- **Validate CAS completeness**: `validate_cas_contract`, `save_cas_golden_snapshot`, `compare_cas_golden_snapshot`
- **Check integration analyzer depth**: `get_integration_depth_report`
- **Inspect behavior-level rules**: `get_behavioral_invariants` for tenant scope, auth, DB constraints, migrations, and test coverage
- **Inspect MCP storage**: `get_storage_health`
- **Map runtime back to code**: `get_runtime_event_contract`, `get_runtime_sdk_package`, `correlate_runtime_event`, `record_runtime_event`, `get_runtime_observations`, `get_runtime_trace`

---

## Common Scenarios

### Starting a coding session

Use `get_agent_bootstrap` first, or use the `agent_coding_session` prompt when your MCP client supports prompts:

```
Use get_agent_bootstrap with path="/absolute/path/to/your/project"
```

Then use `get_agent_work_packet` with the user's task, including the user's exact `instructions` and `success_criteria` when the request is behaviorally specific. Use source files after MCP identifies the relevant nodes, files, tests, validation commands, or gaps.

You can also use the `architectural_context` prompt to inject full system awareness:

```
Use the architectural_context prompt with path="/absolute/path/to/your/project"
```

This gives the AI assistant knowledge of system type, tech stack, architecture layers, API routes, database schema, capabilities, security posture, and design patterns -- all in a single context injection.

### Before modifying code

1. Call `get_agent_tool_plan` with `task_type="modify"` and the target.
2. Call `get_agent_work_packet` with the same task.
3. Read the packet's file read plan first.
4. Use the packet's risk, callers, callees, tests, and validation plan to decide the edit and verification path.

The validation plan is part of the product surface, not a benchmark-only artifact. It gives agents focused test/typecheck/build commands when CAS can infer them, lists tests to inspect first, and tells agents to report an environment blocker instead of installing dependencies or doing broad setup unless the task explicitly asks for that. The packet also includes behavioral invariants so agents preserve tenant/org scope, auth boundaries, DB constraints, migration contracts, and test coverage while editing.

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

For the strongest agent default-use signal:

```
Use get_agent_doctor with path="/absolute/path/to/project"
```

The doctor combines CAS contract validation, source freshness, test discovery evidence, runtime SDK proof, and golden snapshot status into one report.

To make this default path reusable by agents:

```
npm run agent-install -- /absolute/path/to/project
```

or:

```
Use install_agent_default_config with path="/absolute/path/to/project"
```

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

For deeper integrations such as jobs, brokers, auth, payments, AI SDKs, infrastructure, observability, cache, and persistence:

```
Use get_integration_depth_report with path="/repo"
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

To persist the multi-repository graph and preserve link review decisions:

```
Use save_workspace_graph with name="customer-stack" and paths=["/repo/a", "/repo/b", "/repo/c"]
```

Then load it later:

```
Use get_workspace_graph with workspace_id_or_name="customer-stack"
```

When a detected link is verified or rejected:

```
Use verify_workspace_link with workspace_id_or_name="customer-stack", link_id="<link-id>", decision="verified"
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
2. Use `get_runtime_sdk_package` to generate the deterministic TypeScript SDK package from the same event contract.
3. Use `get_runtime_static_links` to see which entry points, exit points, call chains, and external services have runtime signals or instrumentation candidates.
4. Filter by `telemetry_status=instrumentable` to find the next best instrumentation points.
5. Use `get_analysis_facts` for source-backed claims behind nodes, edges, workflows, capabilities, runtime links, and repository links.
6. Use `subject_id` when you need evidence for one concrete CAS object.

### Reviewing test quality

Use the `test_coverage_analysis` prompt, or individually:

1. `get_test_summary` for overall metrics
2. `get_flow_coverage` to see which execution paths are tested
3. `find_tests` for specific nodes or files
4. `get_test_discovery_evidence` to distinguish repositories with no source tests from analysis misses

### Checking analysis freshness

Use this when an agent needs to know whether the stored CAS still reflects the current checkout:

```
Use get_analysis_freshness with path="/absolute/path/to/project"
```

Fresh analyses can be used as the first source of context. Stale analyses should be refreshed with `analyze_codebase` before default-use agent work.

### Maintaining golden CAS snapshots

After a repository reaches a trusted CAS shape, save its snapshot:

```
Use save_cas_golden_snapshot with path="/absolute/path/to/project"
```

Later, compare the current analysis against that saved shape:

```
Use compare_cas_golden_snapshot with path="/absolute/path/to/project"
```

The command-line equivalents from `mcp-server/` are:

```
npm run save-golden -- /absolute/path/to/project
npm run doctor -- /absolute/path/to/project
```

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

For the with-Unravl vs without-Unravl benchmark:

```
npm run agentic-benchmark -- --repo unravl=/absolute/path/to/repo --task-type modify --target auth
```

or through MCP:

```
Use run_agentic_benchmark with paths=["/absolute/path/to/repo"] and task={ "task_type": "modify", "target": "auth" }
```

The JSON and Markdown reports include estimated file counts, estimated context tokens, estimated work time, speedup ratios, and a two-agent run sheet. The run sheet is designed for live trials where Agent A receives the task without Unravl and Agent B receives the same task with Unravl, then records wall time, provider-reported input/output tokens, tool calls, files read, tests, and task result.

For a larger proof suite across discovered real repositories:

```
npm run agentic-benchmark-suite
```

This runs up to six discovered repositories by default and generates up to eight task cards per repository. Task cards include orientation, modification, debugging, tracing, runtime correlation, data-flow, external-boundary, and test-focused work when the CAS contains those surfaces. The report includes per-task success gates, projected baseline success, cached with-Unravl solution time, first-run with-Unravl solution time including amortized analysis, targeted-search solution time without Unravl, token deltas, and file-read deltas.

To tune the suite:

```
npm run agentic-benchmark -- --suite --real-repos --no-fixtures --max-targets 10 --max-tasks-per-repo 8
```

Through MCP:

```
Use run_agentic_benchmark with paths=["/repo/a", "/repo/b"], suite=true, max_tasks_per_repo=8
```

To measure work-quality improvement, not only speed and context size:

```
npm run agent-quality-benchmark
```

This runs the same generated task suite and adds quality metrics: context completeness, target resolution, projected patch success, projected baseline quality, quality-score delta, file-read precision, token reduction, and time reduction. It also has optional live A/B execution hooks with copied repositories:

```
npm run agent-live-benchmark -- --repo app=/repo --task-type modify --target auth --agent-with-cmd "agent-with --workspace {workspace} --prompt-file {prompt_file}" --agent-without-cmd "agent-without --workspace {workspace} --prompt-file {prompt_file}" --test-command "npm test" --max-live-tasks 1
```

When live commands are supplied, the harness creates paired repository copies under `.unravl-agent-live-trials/`, writes separate with-Unravl and without-Unravl prompts, initializes each copy as a clean git baseline, runs each command, records duration, changed files, added/deleted lines, test status, provider token metrics when reported, and writes binary diffs. The with-Unravl arm also receives a real CAS-derived work-packet artifact for the copied repo; if MCP tools are unavailable in the trial runtime, the agent reads that artifact instead of generating analysis inside its own turn. A deterministic orchestrator compares both diffs and reports patch quality, hidden-validation pass/fail, command completion, changed-file precision, time reduction, token reduction, and confidence as separate signals.

For fair live proof, write tasks in behavioral terms and keep implementation paths out of the agent prompt. Hidden validation can still assert exact files, strings, tests, or diffs through `--test-command`; the no-Unravl arm should not receive the path that Unravl is supposed to discover.

Patch quality answers whether the resulting diff solved the requested behavior. Completion score answers whether the agent process ended cleanly without timeout or environment churn. Keep those separate: a correct patch that passes hidden validation but times out while trying to run a broken broad test environment should show high patch quality and lower completion, not a failed fix.

Agent command templates may use:

- `{workspace}` - copied repo path for that arm
- `{prompt_file}` - prompt file path
- `{metrics_file}` - optional JSON metrics file the agent can write
- `{result_file}` - optional JSON result file the agent can write
- `{arm}` - `with-unravl` or `without-unravl`
- `{task_id}` - benchmark task id

Agents should write JSON to `{result_file}` or `{metrics_file}` when their runtime exposes provider usage:

```
{
  "task_success": true,
  "quality_score": 94,
  "files_read": 7,
  "tests_run": 1,
  "provider_input_tokens": 18422,
  "provider_output_tokens": 2110,
  "provider_total_tokens": 20532
}
```

To add an external evaluator agent, pass an orchestrator command:

```
npm run agent-live-benchmark -- --repo app=/repo --agent-with-cmd "agent-with --workspace {workspace} --prompt-file {prompt_file}" --agent-without-cmd "agent-without --workspace {workspace} --prompt-file {prompt_file}" --orchestrator-cmd "judge-agent --input {evaluation_input} --output {evaluation_file}" --test-command "npm test"
```

The orchestrator command receives `{evaluation_input}`, `{evaluation_file}`, `{with_workspace}`, `{without_workspace}`, `{with_diff}`, and `{without_diff}`. If it writes JSON with `with_unravl_quality_score`, `without_unravl_quality_score`, `with_unravl_success`, `without_unravl_success`, `confidence`, and `reasons`, those scores override the deterministic evaluator while preserving all raw artifacts.

Through MCP:

```
Use run_agent_quality_benchmark with paths=["/repo/a", "/repo/b"], max_tasks_per_repo=8, agent_with_command="agent-with --workspace {workspace} --prompt-file {prompt_file}", agent_without_command="agent-without --workspace {workspace} --prompt-file {prompt_file}", orchestrator_command="judge-agent --input {evaluation_input} --output {evaluation_file}", test_command="npm test", max_live_tasks=4
```

### Running the vision gauntlet

From `mcp-server/`:

```
npm run vision-gauntlet
```

This runs the full technical proof across discovered real repos: CAS contract validation, answer-pack readiness, agent default-use readiness, runtime event contract coverage, runtime SDK generation, test discovery evidence, and cross-repo links. Default discovery includes Unravl, Kadra, Money, Zerac, Soon, and SoundSyft when those repos exist under `~/dev`. Use `--repo name=/path/to/repo` to add or override targets. The report is written to `.unravl-vision-gauntlet/latest-report.json` unless `--output` is provided.

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
- Saved CAS golden snapshots are stored as `cas-golden-snapshot.json`.
- Runtime observations are stored as `runtime-observations.json`.
- Persisted workspace graphs are stored under `workspace-graphs/`.
- Agentic benchmark reports are stored under `agentic-benchmarks/`, with `latest.json` pointing to the latest report.

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
